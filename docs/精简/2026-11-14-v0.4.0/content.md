# v0.4.0 content：单业务流有界采集

实现：[flow-content.js](<../../../app/src/flow-content.js>)；定向测试：[flow-content.test.js](<../../../app/tests/flow-content.test.js>)。本组件无 import/export，独立 IIFE；旧重型 content 入口未修改。入口切换/构建由父协调统一执行。

## 消息契约

- 初始化只发 FLOW_SETTINGS，5 秒 deadline；仅接受 profile=business-flow-v1 和非空 sessionId/ownerToken；不取 profile/真实库。随后 FLOW_READY{sessionId,ownerToken} 成功才装 listeners 和 initial checkpoint。
- FLOW_EVENTS{sessionId,ownerToken,batchId,events}；每项为 {kind,time,payload,contents?}，contents 在事件顶层，{field,category,mime,bytes} 的 bytes 是原始 UTF-8 字符串，不是字节数或 base64。归属/序号由后台和 store 补。
- FLOW_CHECKPOINT、FLOW_FLUSH、STOP_CAPTURE 均须带相同 sessionId/ownerToken；旧 token 拒绝。重注入先用 5 秒有界 FLOW_SETTINGS 核验：同 document/session/owner 且未关闭的 collector 原样复用，保留在途 ACK、pending queue、计数及 listeners；只有确认换 owner 或旧 collector 已关闭才 dispose 并新建。并发 settings/启动使用同一 bootstrap promise，不产生双套 listener。新 collector 的 batchId 含独立 crypto.randomUUID nonce 与递增序号，已关闭 collector 同 token 重启也不会复用 durable captureKey。未知/超时探测不会销毁正在采集的队列。
- FLOW_FLUSH 是 stop 语义：提交未稳定 input/scroll，立即冻结 DOM listeners/observer，再排入 reason=stop 最终 checkpoint，并等 capture chain 和 queue 实际确认，整个操作最多 3 秒。返回 {ok,value:{sessionId,accepted,failed,policyStopped,reason?,pending,confirmed}}，计数为本 collector 累计；只有所有待发项 confirmed 且无 failed/policy 才 ok=true。接受数不完整、后台拒绝、transport 错误/deadline 都不是成功；不盲重发 unknown batch。
- STOP_CAPTURE 仅同步移 listener/observer、阻断新采集并回复 {ok:true}，不在后台 close gate 之后补采。
- 后台事件响应 policyStopped 或页面 queue/metadata 达上限，立即停采，单次 FLOW_POLICY_STOPPED{sessionId,ownerToken,reason} 通知后台；policy 不冒充 failed=0 的保存成功。

## 证据内容

### 单一 DOM 来源

page.snapshot：payload 包含 reason/url/title/viewport/forms/nodes/shadowNodes/policies/stylesheets，contents.field=sourceHtml、category=dom、mime=text/html;charset=utf-8。只一份手工有界 sourceHtml，保原标签、属性、关键文本；不调用 outerHTML、cloneNode，不再生成另份派生 HTML 或把 CSS 再内联一份。保留的属性/文本仅作为惰性证据字符串保存，不写回 live DOM、不执行、不自动脱敏；阅读/重建方必须在隔离且无执行权限的环境处理，不能当可信 HTML 直接执行。

sourceHtml 额外 data-flow-node 标记供 forms.selector 定位；原页面若已有同名属性，记录 generated-node-marker-collision policy。script 标签/属性保留，script 文本明确不采；style 文本由独立 CSS 内容替代，source 内标 policy 注释。iframe 文档由获准 sender 各自采，当前 frame 不跨域递归读取。canvas 像素不采。

forms 保真实 property 的 value/checked/disabled/selected/selectedIndex 和必要 validity/validationMessage。短 value 原值直接存在 forms；大于 2048 UTF-8 字节的值放本事件顶层 formValueN content，并在 forms.value 置 {field:"formValueN"}。sourceHtml+长 form contents 合计小于 2 MiB，每事件最多 sourceHtml+15 个长值 content；其余值明确 {status:"policy",reason:"value-size-limit"}，不伪称完整、不无标记裁剪。contenteditable 不扁平复制大段文字，value 明确 policy，文本保在单 source 结构中。forms 总 metadata 16 KiB，上限/截断均进 policies。

采集上限：每 snapshot 2 MiB、最多 12000 节点、深度 64、每元素 64 属性、128 项 form；open shadow 最多 16 host/合计 2000 节点，表示为 template shadowrootmode=open，可读 root 装必要事件 listener。关闭/不可访问 shadow 不探测或截获 attachShadow；仅记录无法访问 policy。扫描和序列化同时检查节点/字符/UTF-8 预算，不先无限生成 outerHTML 后截短。超限样本是带 policy 的 partial，不承诺所有巨大节点可还原。

### CSS 与视觉 URL

page.stylesheet：payload{href,sha256,source:"cssom-rules"}；contents.field=text、category=resource、mime=text/css;charset=utf-8，保可读 CSSOM 规则文本（非 computed styles/全 CSS 变量展开）。每 checkpoint 读有界可读 CSS，SHA-256 相同本地不再发；hash 内容引用可供其他 snapshot 重用。每次最多 32 sheets、每 sheet 2000 rules、总 8000 rules；单样本/一次扫描 CSS 文本预算 2 MiB；超过预算或跨域 cssRules 拒绝明确 access=policy/unavailable 及 reason，不发伪完整空 CSS。最多记 256 本地 stylesheet hash；累计 resource 8 MiB、DOM 16 MiB 和整个 session 预算仍由 store 唯一裁决。

page.resources payload{urls:[{url,type:"image"|"font"|"stylesheet"}]}；来源为已加载可用 img/currentSrc、stylesheet/link 和有界 CSS url(...) 引用，只发送 HTTP(S) URL 元信息。每 snapshot 最多 128 引用，单批 metadata 限 14 KiB，本地最多 256 已报告 URL；不发起 fetch、不读所有网络资源或浏览器资产库，必要资源由后台受预算只读 CDP 获取。CSS 引用表示需要，不声称资源一定已读取成功。

### 操作与检查点

- ui.click/ui.change/ui.input/ui.submit/ui.key（只 Enter/Escape）；可信属性保留于 payload.trusted，用于后台子页归因；不伪造可信点击。ui.scroll 仅稳定 250ms 终点。
- input 250ms 稳定后记录，change 立即稳定；250ms 内 blur/change 会把 pending input 合并成一个 ui.change（不重复 ui.input），同样保已知 beforeValue 和当前原值。payload.value 和已知 beforeValue 原样；已知来源是 initial form property、beforeinput 或上次稳定值，没有前值不造值。大字符串变同事件顶层 contents.field=value/beforeValue，category dom，保原值；超 2 MiB 明确 value-size-limit policy。不自动脱敏。
- popstate/hashchange 记 page.navigation；关键操作和 invalid 校验、业务 dialog/menu/listbox/combobox/alert/dropdown mutation 触发 checkpoint。MutationObserver 不存 raw 记录，只在每次 delivery 前 64 target/最多 5 祖先及前 8 新增/移除节点做有界相关性检查。无关 class 动画不触发；不监听 style 属性。
- 为防 500ms checkpoint 前已消失的业务提示漏证据，相关状态另即时发 recorder.notice payload{reason:"transient_state",role,action:"added"|"changed"|"removed",target,state,text}；只读有界节点文本，不 outerHTML、不全页复制、不推断 closed shadow。text >2048 UTF-8 字节使用同事件顶层 content field=text/category=dom；原值不脱敏。每 callback 最多 8 个相关节点、累计 8 KiB，文本最多扫描 128 节点/深度 8，无法在限内完整采到则明确 transient-text-scan-limit policy，不把裁剪前缀冒充原文。相同节点/状态重复 callback 不重复发；不同状态的相同长文交由 store hash 复用。added/removed 在 checkpoint 前即可留下原文，即使后续 DOM 已无提示。
- initial/stop/关键状态统一至少 500ms checkpoint 间隔，短时间触发合并；每次 DOM 观测仍保留，重复内容最终由 store hash 复用。CSS 本地 hash 不变不再发重复 stylesheet 行。
- 不采 pointermove/hover/focus 全样式、全 computed、Cookies/Storage/IDB/Cache、canvas 原像素、gzip 派生；不加额外业务 fetch/POST。

## 小队列与验证

队列最多 32 事件或 6 MiB（含在途），单 batch 最多 8 事件且约 2 MiB 内容；payload 限 30 KiB，低于后台 32 KiB 入口。背压过大明确 policy stop，不无限积累。消息发送 2.5 秒 deadline；不把队列清空等同已落库。样本限不能限制浏览器已存在 DOM 或 CSSOM 单条 cssText 属性内部物化的内存，不能宣称流式物理硬限。

2026-11-14 原生 Node 实跑：


default workdir app：

~~~sh
node --check src/flow-content.js
node --test tests/flow-content.test.js
~~~

结果：syntax exit 0，15 tests/15 passed/0 failed，约 247ms（sourceVM fake DOM/clock，非 Chrome 实测）。覆盖单 DOM、原值/长值/beforeValue、CSS once hash 和视觉 URL、关键键/校验/navigation/scroll、相关 mutation 合并、500ms 节流、真实 ACK 等待、policy/partial/malformed ACK、settings 5 秒及发送 deadline、node/size/content-count 边界、可读 shadow/不可读 CSS、重复注入和旧 token 隔离；另有真实 sourceVM 回归断言 STOP 发生在 checkpoint throttle sleep 期间仍结算，以及连续 shadow checkpoint 不重复加 listener/observer。R2 回归验证同 owner 重注入不清在途及第二个 pending change，pending settings 共享 bootstrap，换 owner 拒旧 token，closed 同 token 重启 nonce 不重复；R3 回归验证 20ms 出现、200ms 移除的 alert 原文在 500ms checkpoint 前已有 added/removed notice，以及长文 content 与 8 节点/8KiB callback 限制。首轮测试发现 fake DOM Object.assign 提前触发故障 getter 已修复；最终实际结果如上。

并发回归：首次父执行全 flow 单测时，真实 WebCrypto digest 尚未完成，fixture 仅推进虚拟时钟，导致首例 snapshot 未到就断言失败。已只改测试，新增有界 snapshot/全部 FLOW_EVENTS 实际 ACK predicate 等待（performance deadline 3 秒，逐次让出事件循环，无 sleep、无生产改动、不删断言）。随后在 app 连续执行两次 node --test tests/flow-*.test.js，均真实通过（当时每轮 64 tests，组合命令 exit 0）。最终 R2/R3 修复再连续执行两轮全部 flow 测试，均 72/72 passed、0 failed，959ms/972ms，组合命令 exit 0；本组件生产源码最终冻结。

本组件未 build、未启动或操作 Chrome、未读取真实 profile/rawdata、未推送/发布、未改旧 content/background/store/sidepanel/package/vite；原 worktree dirty 未重置。父统一执行构建和 Chrome 集成/发布门验收，源 VM 通过不代表 native acceptance 全过。
