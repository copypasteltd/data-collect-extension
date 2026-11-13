# v0.4.0 轻量后台实施记录

## 交付边界

实现：[flow-background.js](<../../../../app/src/flow-background.js>)；纯 mock 单测：[flow-background.test.js](<../../../../app/tests/flow-background.test.js>)。仅静态导入新 flow-store，不导入历史 background/content/db、旧全浏览器记录器或重型派生模块。后台约 560 行；没有修改 package、UI、vite 或旧入口。

实现依据：[实施合同](<./CONTRACT.md>)及父代理协调的明确事件 kind 清单。Document 网络正文只记元信息与 document_dom_canonical policy；页面 HTML 的唯一主表示由 content 的有界结构快照提供，避免重复 raw HTML。

## 控制和所有权

- START 的 tab.id 只通过 tabs.get 核实；不 query 全部标签，不因焦点切换改变 rootTabId。当前 root HTTP(S) 来源未授权即明确拒绝。
- scope 最多 root + 一个可归因 HTTP(S) child。child 必须有当前 scope openerTabId、最近 2 秒已持久保存的 trusted ui.click/ui.submit，且真实事件 time 不得晚于该 candidate 的 onCreated 时刻；持久 ACK 可以迟到，后发生的其他点击不能倒因果认领旧候选。为 tabs.onCreated 早于持久 ACK 的竞态，只保留一个候选，手势 ACK 最多等 250ms。初始空 URL/about:blank 仅记录 pending id/opener（不纳 scope），由该 id 的 onUpdated.url 或顶层 onCommitted 唤醒，等待不超过可信手势 2 秒因果窗；HTTP、授权、已存可信操作全部满足才加入。并发候选不能突破单 child，缺 opener 不加入。
- tab 更新、webNavigation 只处理当前 scope（及唯一未纳 scope 的 child 候选 URL 唤醒）。HTTP(S) frame 需来源 permissions.contains。仅 executeScript(content.js) 指向每个获准 documentIds（无 documentId 才退到单 frameIds），按 frame→document 身份映射只注入一次；iframe 导航/complete 不重新注入 root，不用 blanket allFrames，不注册持久全浏览器脚本。缺 documentId 的导航由 content 的同 owner/document 幂等保护及 batch nonce 兜底。
- FLOW_SETTINGS/FLOW_READY/FLOW_EVENTS/FLOW_POLICY_STOPPED 检查扩展 ID、scope tab、frame、origin、当前 document 与 ownerToken/sessionId。后台覆盖 sender tab/frame/document；页面不能伪造归属。
- batch captureKey = tabId:frameId:documentId:batchId:index，由 store durable 幂等；内存仅有界缓存 256 个 batch 的结果。真实 failed/accepted0 不包装为已保存。
- GET_STATUS、GET_STATE 都返回 {active,sessions}，active 移除 token，保留 preparing/stopping；budget 取真实 flow store 水位。关闭侧栏不触发 Stop。

## CDP 采集

- 只 attach scope root/child 并启用 Network/Page。初始只 Page.getFrameTree 映射 CDP frame id → Chrome frame id，不遍历资源树。
- Fetch/XHR 文本/JSON/XML/form response body 上限 2MiB；Document 元信息；观察到的必要 Image/Stylesheet/Font 资源单项至多 8MiB，受整个 resource 类别 8MiB 进一步约束。JS、媒体不读取正文。
- Request 保留原 URL/query/headers 并加本地敏感提示；CDP 已携带 postData 进 body 类 content 引用，不再次调用 getRequestPostData，不重放 HTTP/POST。
- response 读取前同时检查 Content-Length、encodedDataLength 和当前 store 类别/全局剩余额度，最多 2 个 reader 带预算预留；返回值做 base64 长度、解码与 UTF-8 上限后验拒绝。
- **能力限制**：CDP 返回完整字符串，不能承诺 Chrome/CDP 物理流式内存硬限；coverage 明确 physicalCdpStreamLimit:false。预检查和后验拒绝是接纳策略，不是流式传输。
- content 的 page.resources.urls 只可 Page.getResourceContent 从页面缓存读取；没有 HTTP 补 fetch。最多 128 个唯一资源 URL，不做初始全资源查询。
- WebSocket/SSE 仅连接、count、bytes 汇总；不持久帧正文/事件正文。WebSocket 连接必须能从 initiator.frameId 映射到当前 allowed HTTP(S) frame，并重新验证该 frame 来源权限；无 frameId/不可归因/未授权时只存固定 reason，不推定 root、不持久未知 URL/query。请求 ID 带 tabId+CDP requestId+redirect hop 避免 root/child 同名冲突。
- 无 Cookies API、Storage/IDB/Cache dump、全页截图、字体清单或浏览器级扫描。

## 视口截图

- 只 Page.captureScreenshot({format:'png',fromSurface:true,captureBeyondViewport:false})，保存到 screenshot 内容去重层。
- FLOW_READY 基线与 page.snapshot 的 initial/click/change/submit/navigation/validation 稳定快照触发；不响应 hover/pointermove。
- 全会话至少 1 秒间隔，一个 tab 一个合并待执行项；关联真实 frameId/documentId/associatedEventId/sourceTime。截图时间独立保存，不伪造成点击瞬间。

## 预算、Stop 与恢复

普通生产队列上限 64 项/8MiB；页面 batch 至多 64 events/4MiB，每项 metadata 32KiB、16 content descriptors。content 自身还有更小队列界限。过载、store policy budget、content policy 信号快速关闭新生产接纳并受控自动 Stop，持久 reason/notice；不操作业务标签或用户数据。

Stop 先关闭普通接纳 → 已授权 frame 并行 FLOW_FLUSH（各至多 3 秒，仅这阶段接纳现有页面队列）→ STOP_CAPTURE（短 ACK）→ scope debugger 并行 detach（各至多 2 秒）→ drain 已接纳写入 → closeSessionWrites → 唯一 session.stop final → seal。并发 Stop 复用同一个 promise。Store 写入/封存不能确认时返回失败，不能称 ready。

正常容量/范围 policy gap 封为 ready + coverage/reason；真实存储失败、断开、flush 无法确认等封 interrupted。worker 重启只读取新 flow store 中 preparing/recording/stopping 批次，关闭 gate、写固定 stop key 并封 interrupted；读取失败不会默认“新批次”，不访问旧库或旧 snapshot 元信息。

## 已执行验证

Windows 原生 Node 纯 mock：

~~~text
cd app
node --check src/flow-background.js
node --test tests/flow-background.test.js
24 passed / 0 failed
~~~

覆盖：20 无关标签、根来源权限、token/origin/document 隔离、child 与持久 ACK 竞态/并发上限、初始 blank→HTTP 更新/提交、无手势候选超时释放、候选先创建后点击不能归因、iframe 导航前后 root 事件连续且单 document 只注入一次、跨 origin root 不漂移、request 原字段与 content 类别、2MiB encoded/header 预检及未知正文后验拒绝、当前预算预检、cache-only CSS 资源、WS/SSE 无正文、WebSocket 未知/未授权/撤权 frame 不泄漏 URL/query、可见 PNG/节流/关联、双批和 retry 幂等、policy 自动停止、真实失败、并发 Stop 顺序、preparing 期间 Stop 与晚 attach 清理、新 worker 恢复/读失败，以及没有 legacy 导入/禁止命令。

**尚未由本 owner 验证**：真实 Chrome 的 scope/frame 权限行为、页面视觉恢复、60 秒 10 步体积、20 轮 Stop/Export P95，以及 build/同路径更新/发布；这些由父代理统一执行，本文件不冒称验收通过。
