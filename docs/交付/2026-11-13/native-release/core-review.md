# 核心交叉独立静态 Review

- **结论：pass（限定静态范围）**。未发现需要阻断本次本机 release 的真实最近缺陷；无必需源码修复项。不是全量安全审计、构建成功证明或浏览器验收签字。
- 日期：2026-11-13（UTC+08）；基线 HEAD：`a07b15f6e72524cf696e0fa51d7533aed977d994`；审阅当前共享 dirty，非原子工作树。核心源码 SHA-256 见[core-review.json](<E:/dev/copypaste/美容ERP/逻辑记录插件/docs/交付/2026-11-13/native-release/core-review.json>)。
- 已读[AGENTS.md](<E:/dev/copypaste/美容ERP/逻辑记录插件/AGENTS.md>)、当前状态和核心 diff；保留全部既有 dirty。只新增本文与对应 JSON，不抢写源码。

## 证据及判断

### E1 · 事务写门与封存

证据和session权威同一readwrite事务；owner、active、closed/sealed门限制新写；正常seal要求closed和finalStopEventId，expectedRevision核对后同事务统计eventCount/assetCount/lastSeq。旧终态不覆盖、不补造seal。

证据：[db.js:128–221](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/src/db.js#L128-L221>)；[db.js:260–341](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/src/db.js#L260-L341>)；[session-lifecycle.js:22–33](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/src/session-lifecycle.js#L22-L33>)。

### E2 · 停止顺序及迟到owner

FLUSH/STOP_CAPTURE收尾准入结束后closeAdmission；已接受任务与writeChain收尾，再closeWrites、IDB close fence、唯一session.stop、coverage、seal。per-session任务/写链及observedOwner防止A迟到任务转挂B；超时不视为取消。

证据：[background.js:70–94](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/src/background.js#L70-L94>)；[background.js:452–463](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/src/background.js#L452-L463>)；[background.js:1269–1437](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/src/background.js#L1269-L1437>)；[background.js:1569–1574](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/src/background.js#L1569-L1574>)；[session-tasks.js:1–40](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/src/session-tasks.js#L1-L40>)。

### E3 · false/unknown与producer sticky

明确value:false计rejected，裸ok:false/坏确认/耗尽计unknown，多attempt拒绝不能否定旧commit；每enqueue有自身不可变结果。迟到ACK仅调诊断，captureIncomplete/needsVerification独立sticky，FLUSH及background保留中断事实，不伪造内容Failure。

证据：[delivery.js:26–89](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/src/delivery.js#L26-L89>)；[delivery.js:105–149](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/src/delivery.js#L105-L149>)；[batch-outcome.js:22–38](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/src/batch-outcome.js#L22-L38>)；[content.js:128–191](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/src/content.js#L128-L191>)；[content.js:2074–2093](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/src/content.js#L2074-L2093>)；[content.js:2245–2280](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/src/content.js#L2245-L2280>)；[background.js:1323–1345](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/src/background.js#L1323-L1345>)。

### E4 · 导出同revision及分段终态

新seal导出核对revision/count/lastSeq，终态全流预扫后再核seal，主流与最终再次对账；late part/Failure/重复End不能先派生成功字段。资源来自读取的assets，provenance区分原producer与本次exporter。不是整个ZIP字节恒等承诺。

证据：[archive.js:67–130](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/src/archive.js#L67-L130>)；[archive.js:269–294](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/src/archive.js#L269-L294>)；[archive.js:300–334](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/src/archive.js#L300-L334>)；[archive.js:342–397](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/src/archive.js#L342-L397>)；[fragment-terminals.js:8–43](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/src/fragment-terminals.js#L8-L43>)；[archive-provenance.js:28–35](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/src/archive-provenance.js#L28-L35>)。

### E5 · reading resources与归属

已加载资源读Page.getResourceContent并复核frame/loader；DOM图片canvas预览复核documentId；网络正文读既有Network.getResponseBody。唯一fetch(data)用于浏览器截图data URL转Blob，不是远程补抓站点。资源保存须过原session的putAsset写门。

证据：[background.js:803–873](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/src/background.js#L803-L873>)；[background.js:876–1001](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/src/background.js#L876-L1001>)；[background.js:1049–1087](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/src/background.js#L1049-L1087>)；[background.js:2239–2302](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/src/background.js#L2239-L2302>)。

## 特别核实：databaseGaps 疑点不成立于当前 producer

[background.js:1480–1486](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/src/background.js#L1480-L1486>) 的 `payload.status || payload.database?.status !== "captured"` 看起来可把根 `status:"captured"` 当真，但当前成功 producer 并非该形状：[content.js:1955–1981](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/src/content.js#L1955-L1981>) 输出 `{database: result, graphCaptureId, graphStatus:"pending"}`，成功状态在 `database.status`，无根 `status`。根状态仅用于 [content.js:1831](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/src/content.js#L1831>)、[content.js:1848](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/src/content.js#L1848>) 和 [content.js:2063–2071](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/src/content.js#L2063-L2071>) 的 unavailable/failed。因此**没有证据表明真实成功快照被该表达式误计**；不把构造旧/非当前形状列为 finding。无需为此改代码；若父选择可读性 helper，属于可选整理。

## 测试事实与归因

- **父报告：294 pass**（由本次委派指令提供）。本代理没有复跑，也没有独立检查其运行日志，不标成自己的测试结果。
- 只静态读已有回归：[seal-session.test.js](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/tests/seal-session.test.js>)；[seal-background.test.js](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/tests/seal-background.test.js>)；[archive-seal.test.js](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/tests/archive-seal.test.js>)；[delivery-outcomes.test.js](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/tests/delivery-outcomes.test.js>)；[db-abort.test.js](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/tests/db-abort.test.js>)；[browser-archive.test.js](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/tests/browser-archive.test.js>)，对应事务/重复ACK/中断、late owner、同seal、sticky unknown、全流分段终态及abort结算。接受已明确的helper测试层与实现取舍，不重复 npm test。
- 本代理执行的命令仅目录/Git状态/diff/HEAD/hash等只读操作；**未运行测试、浏览器、构建**，未读取profile、凭据或真实记录包，未再委派/使用AgentTeams/提交/推送。

## 明确限制与交付边界

- 仅当前dirty核心修复交叉的产品正确性静态review；不是full security audit，也不宣称20族架构问题全部关闭。
- 旧无seal终态采用原计数核对，不被补造不可变revision；新seal提供扩展正常写入口下的证据集合一致性，不防外部直接篡改IDB，也不保证两次ZIP字节一致。
- 资源有现存时间/数量/字节预算，canvas为预览且可能跨域不可读；数据库图采样为batched_non_atomic。ready不是零缺口或全量网站还原承诺。
- 本代理不执行浏览器测试、构建、npm test或纯helper测试；浏览器、构建、发行包身份/校验及实际业务验收由父/另一代理负责，本文不代签。
- 用户已明确不建隔离环境并授权本机修复编译release；旧OS隔离前置不作为本次review阻塞理由。保留历史文档，不复用其中not-run作为当前测试事实。
- 保留浏览器提供的原值及开始、停止、批次选择、导出四项主要操作；未新增脱敏、删除、自动清理、微服务或范围扩张。

**交给父：**源码核心静态门可继续，保留已在运行的验证/构建结果，不因本报告启动重复任务；最终release结论以父实际同候选产物和运行证据为准。
