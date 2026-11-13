# v0.4.0 一轮限定独立 review

## 结论与边界

**当前：scoped_pass_source_only。同一轮仅核最小修后，R1/R2/R3 原具体触发已源级闭合，未开放新一轮广审。** 初次结论为 needs_revision，下方保留当时 finding 历史；最终闭合证据见末节。源级通过不等于 Chrome/native 验收或发布批准。 仅本轮、仅新 flow 存储/预算/后台/content/archive 与侧栏生产入口；不扩大旧架构审计。机器记录、exact SHA-256 见 [review.json](<./review.json>)；合同见 [CONTRACT.md](<./CONTRACT.md>)。

基线 commit 为 `3bfa7ae45c9350d3766e6dbb85a5b7547eb48682`，原 worktree dirty 全保留。未改生产、未接触真实 profile/raw、未 build/安装/推送/发布/真实 recording，未重跑旧373/50 target，未并行跑父负责的 native/perf。没有把源阅读/hash当作Chrome验收。未执行 target-controlled 代码：此 reviewer 未获满足审计 skill 的 OS-enforced 执行沙箱，父另有独立原生验收授权及证据。

## 具体 finding（均已早报父，父已接受3项）

### R1 · High · 已修源码，未做 Chrome 复验

**无归属/无权 iframe 的 WebSocket URL 曾被根页权限替代采入。** 触发：获准root嵌入另一未获准origin iframe，iframe发起带私有query的WS。原分支仅查根URL权限，即使initiator无可验证frame mapping仍存完整URL。现 [flow-background.js:382–386](<../../../../app/src/flow-background.js#L382-L386>) 要求allowed HTTP(S) frame，再查permission与当前frame identity；未知只固定gap。已读修复hash `62a8de47ca75def5e94173cb1fd1b607dcbf82ac306757522dd7f6dd01d36460`。只关闭原source finding，不证明native行为。

### R2 · High · 待本轮最小修与定向证据

**同document重注入重置batchNo，durable captureKey把新值当旧重试，成功ACK却无新raw。**

1. root已持久几个batch。
2. iframe committed或tab complete经 [后台inject](<../../../../app/src/flow-background.js#L140-L164>) 重注allFrames。
3. [content初始化](<../../../../app/src/flow-content.js#L3-L10>) dispose root collector、batchNo归零；[dispose](<../../../../app/src/flow-content.js#L32-L35>) 还清未发队列。
4. [batchId](<../../../../app/src/flow-content.js#L70-L71>) 为同ownerToken+序号；[后台key](<../../../../app/src/flow-background.js#L230-L238>) 为同tab/frame/documentId/batchId/index。
5. 新root值遇到旧key，内存/[store幂等命中](<../../../../app/src/flow-store.js#L343-L352>) 返回accepted duplicate，实际新值静默丢失。

父正最小修：同ownership/document collector幂等保留，真正换代有nonce；后台只注目标frame/document，不能dispose清未确认队列。定向需保留「root旧值→iframe导航→root新值」两次原值并核新key；旧fake reinjection每次新token未覆盖真实同session情况。

### R3 · Medium · 具体source coverage gap（不是Chrome fail）

**200ms内出现又移除的业务alert/dialog可在两个snapshot间完全消失。** [observer](<../../../../app/src/flow-content.js#L158-L177>) 仅schedule，未保留被观察状态；[capture](<../../../../app/src/flow-content.js#L298-L305>) 和 [schedule](<../../../../app/src/flow-content.js#L322-L328>) 保至少500ms间隔。初始后点击出现role=alert校验文本、200ms内移除；点击只存target，之后snapshot已无文本，任何raw无该中间态且无omitted/gap。父正补最小即时轻量state/text引用；不是扩成全mutation日志，不继续广审。

## 已追到分支的限定检查

| 关注面 | 源级结论与限制 |
|---|---|
| 64MiB/category dedup | [budget](<../../../../app/src/flow-budget.js#L91-L124>) + [store事务](<../../../../app/src/flow-store.js#L391-L430>)：JSONL精确事件字节+unique content，各category首次hash仍收费，普通63/final64、meta3/4MiB；未另发现绕过。|
| single body2MiB读前 | [store准备](<../../../../app/src/flow-store.js#L336-L377>) 在Blob读取前核size；[CDP响应](<../../../../app/src/flow-background.js#L331-L361>) 读前headers/encoded/budget预留，未知后验拒，不称物理流式硬限。|
| seal/writer | [gate](<../../../../app/src/flow-store.js#L269-L278>) / [seal](<../../../../app/src/flow-store.js#L474-L505>) 同事务核唯一末stop/计数；raw不可再写，仅必要error元信息补录。captureKey换代缺口R2。|
| recovery隔离 | [新DB](<../../../../app/src/flow-store.js#L109-L151>) 与 [recover/ready](<../../../../app/src/flow-background.js#L497-L512>)：控制入口先await ready、只新库。故意造active native fixture若未先等recovery，会被合理恢复，不算prod写入bug。|
| root/child/frame scope | root exact tabs.get、permission/近期已存trusted/opener/one child；blank pending不提前采。R1源级闭合，R2待修；非native全通过。|
| DOM/forms/CSS/资源 | [有界source/forms](<../../../../app/src/flow-content.js#L180-L254>) / [CSSOM哈希](<../../../../app/src/flow-content.js#L255-L297>)；无computed/cache/cookie扫描。R3为短寿命状态缺口。|
| Stop false/policy/busy | [Stop](<../../../../app/src/flow-background.js#L446-L495>) 分policy/failed，flush/detach/drain/gate/seal；[UI finally](<../../../../app/src/sidepanel.jsx#L141-L164>) 释放operation。未另发现无界busy路径；未代父实测P95。|
| purearchive | [archive](<../../../../app/src/flow-archive.js#L24-L124>) 核计数/ref SHA/size/blob SHA/前后水位/精确raw账本/开销≤raw+max(5%,1MiB)，无derive。|
| token/生产entry | [projection](<../../../../app/src/flow-store.js#L98-L107>) / [publicSession](<../../../../app/src/flow-archive.js#L9-L12>) 去ownerToken/captureKey；[Vite](<../../../../app/vite.config.js#L27-L30>) 仅新background/content，侧栏import新archive，不入旧重型入口。|

## Hash与验收分开

报告hash是读取到的exact dirty源，不代表dist/Chrome安装字节。之后修复须记录final hash，父需重build/reload及定向验收；原hash测试不会自动覆盖新hash。父nativeCAS/smoke/focusedAE与20轮perf/60秒基准不在本reviewer执行范围，旧50-target不算新版验收。初次结论保留needs_revision，待只核这3项最小修追加closure，不开启第二轮广审。

## 同一轮修复闭合追加（2026-11-14 03:13 +08:00）

**最终限定结论：scoped_pass_source_only；原3项均 resolved_source_only，无本轮未闭finding。** 只读最小修路径及新增target断言，没有重新hunt。前述待修描述与旧行号为发现时历史；[review.json](<./review.json>) 保留 initialReview 完整原结论/证据，并单列 finalSourceHashes 与各项 closure。

| Finding | 最小修已核 | 新增定向断言（只读，未由 reviewer 执行） |
|---|---|---|
| R1 | [后台400–404](<../../../../app/src/flow-background.js#L400-L404>) 继续要求allowed HTTP(S) frame、当前permission、frame identity后才存URL；未知/无权只gap。 | [WS scope回归](<../../../../app/tests/flow-background.test.js#L257-L276>) 对unknown/denied/revoked frame不存URL/query，mapped root可录。 |
| R2 | [content bootstrap](<../../../../app/src/flow-content.js#L3-L29>) 单holder.boot、同document/active ownership直接return保queue/in-flight ACK；[batchId](<../../../../app/src/flow-content.js#L84-L85>) 加collector nonce；[后台inject](<../../../../app/src/flow-background.js#L140-L181>) 每allowed document只注一次，非allFrames，不重置root。 | [content队列/nonce回归](<../../../../app/tests/flow-content.test.js#L225-L261>) hold ACK并重复注入，保两个原值/beforeValue、单listener/initial及unique batchId；closed同token重启不同nonce。[后台回归](<../../../../app/tests/flow-background.test.js#L176-L192>) iframe导航/complete不重注根、before/after根值都保留。 |
| R3 | [即时轻量state](<../../../../app/src/flow-content.js#L153-L185>) + [observer](<../../../../app/src/flow-content.js#L205-L225>) 当次delivery即发added/removed/changed原文与state，不等500ms snapshot；单delivery≤8项/8192bytes，文本walk≤128nodes/depth8，超限显式policy。 | [短寿命/原文/边界回归](<../../../../app/tests/flow-content.test.js#L264-L292>) 文本在500ms前出现消失，末snapshot无文本但added/removed notice保原值；长文top-level content、8KiB上限、巨大文本policy。 |

### 闭合源码精确 SHA-256

| 文件 | final hash |
|---|---|
| [flow-background.js](<../../../../app/src/flow-background.js>) | `93fbf1b31cca41157127e7ce20f609af2a5453344e115ee65c07b41017d66b82` |
| [flow-content.js](<../../../../app/src/flow-content.js>) | `6893e6570fee914e563459820b63a9add86318f909653c3235b3b7ceb058bcdb` |
| [flow-background.test.js](<../../../../app/tests/flow-background.test.js>) | `9730d8d39a6d6a2c9b87a5913bc588a1f372c80507ffcac29df1dd1c5c42ead8` |
| [flow-content.test.js](<../../../../app/tests/flow-content.test.js>) | `eecf3037953162e8a0d437e68654ceef4267e322d293c8a424c33269297f9795` |

其余已审生产源/直接依赖hash复核与初次相同。父报告content15/background24目标通过；reviewer只读其assertions，**没有把父报结果称独立执行结果**。未来gesture先后约束已见 [候选绑定](<../../../../app/src/flow-background.js#L439-L457>)，同样不代父真实scope验收。

本closure只关闭已报可触发缺陷，不保证任意DOM状态都完整。没有Chrome真实录制/20round/60秒验收，也未核installed/dist bundle、未授权发布；这些仍由父在同final source及build上分别给actual证据。
