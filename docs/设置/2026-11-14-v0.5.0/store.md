# v0.5.0 预算与存储实施记录

本次最终上限为20倍。三组设置沿用统一schemaVersion1、整数1–20；新会话默认20倍。所有数值从[flow-config.js](../../../app/src/flow-config.js)派生，预算和存储未另写第二套schema。

## 固定会话策略

[flow-budget.js](../../../app/src/flow-budget.js)保留历史纯函数入口：FLOW_LIMITS始终是1倍基准，createBudget()默认1倍。createBudget(settings)校验、复制并冻结settings；getBudgetLimits(budget)仅按budget.settings派生，无settings时按LEGACY_FLOW_SETTINGS解释。validateBudget严格检查limitBytes/reserveBytes与派生策略一致、五类safeinteger非负计数和类别上限、boolean标记，不接受任意declaredlimit放宽预算。preflightContent/evaluateBudget/stopBudget使用该快照，结果继续携带不可变settings。

[flow-store.js](../../../app/src/flow-store.js)的createSession({settings,...})默认使用DEFAULT_FLOW_SETTINGS；默认producerVersion为0.5.0。忽略调用方capturePolicy，固定保存：

- capturePolicy.settings：已校验设置。
- capturePolicy.limits：deriveFlowLimits(settings).budget。
- capturePolicy.runtimeLimits：{background,content}运行时快照。
- budget.settings：与capturePolicy.settings相同的预算快照。

updateSession不接受settings/capturePolicy/budget/runtimeLimits等protected字段。后续配置保存只影响下一次createSession。旧记录缺settings仍按1倍解析，get/list/read/page不会补写或用当前默认改写旧记录。原有owner校验、captureKey去重、逐事务权威预算和序列、原子事件/内容/账本写入、final reserve及seal校验保留。

20倍预算总1280MiB、提醒960MiB、普通1260MiB、保留20MiB；正文480MiB、DOM320MiB、资源160MiB、截图240MiB、元数据80MiB（普通60MiB），单正文40MiB，单事件640KiB。物理内容按session-local SHA256计一次，各类别首次引用分别计入该类别；原始事件JSONL字节仍完整计入meta与总预算。

元数据先经有界JSON writer再解析，字节限制使用会话eventBytes，结构节点上限8192×samplingMultiplier；每事件内容数为16×samplingMultiplier。递归深度32、ID/field/MIME长度等协议约束保持原界限，不随容量倍率放宽。

内容先生成不可变Blob，再await sha256Blob(blob,{signal})，通过[flow-hash.js](../../../app/src/flow-hash.js)逐块读取。存储不再对整个Blob调用arrayBuffer；所有哈希完成后才开启readwrite事务。

## 分页API

导出调用以下只读接口；每次调用都创建独立readonly事务，读取该会话策略，沿用timeoutMs（最多15秒）与AbortSignal取消规则。请求失败、事务abort或deadline拒绝整个页面，不返回部分成功值。

~~~js
flowEventPage(id, afterSeq = 0, {
  limit = 500,          // 整数1..500
  maxBytes = 8 * MiB,   // 整数1..8MiB
  signal, timeoutMs,
}) // -> { events, nextSeq, done }

flowContentPage(id, afterId = '', {
  limit = 50,           // 整数1..50
  signal, timeoutMs,
}) // -> { contents, nextId, done }
~~~

事件按sessionSeq索引递增，nextSeq为本页最后seq（空页保留afterSeq）。首条合法事件大于maxBytes仍返回该一条；后续事件受页字节目标限制。只有真实游标耗尽时done=true，因此可按nextSeq继续直至完成。私有captureKey不出现在返回事件。

内容按sessionId:sha256主键范围续读，nextId为最后返回的id（空页保留afterId）。每条仅返回懒Blob句柄和元数据，不转换所有Blob为ArrayBuffer，也不重扫已导出的页面。带冒号的其他sessionId若共享主键前缀会跳过，不混入当前会话。

readEvents/readContents保留兼容调用，整次读取上限按会话budget总额，不再固定64MiB；大包归档应使用分页接口。readContents仍只返回懒Blob句柄。

## 验证

执行：

~~~text
cd app
node --test tests/flow-budget.test.js tests/flow-store.test.js
~~~

2026-11-14：43/43通过。

[预算测试](../../../app/tests/flow-budget.test.js)保留512seed×160历史状态转换，并新增全1–20倍率×16seed×128转换的独立BigInt账本oracle、各倍率普通/final精确边界、20倍实际整数值、非法settings、任意declaredlimit及false-like标记拒绝。

[存储测试](../../../app/tests/flow-store.test.js)用显式LEGACY1 fixture保留原64MiB断言；新增默认20、配置保存只影响下批、重新载入、旧sealed缺settings只读不回写、protectedpatch和快照不一致拒绝。实际3MiB+7正文对比20倍成功/1倍拒绝，600KiB元数据与2560field结构、320descriptor去重、深度/IDguard、分页顺序/页字节/首条超页/跨会话隔离/懒Blob，以及abort/error/deadline均有覆盖。另合成超过64MiB元数据、80MiB正文句柄验证兼容读取策略。

此范围未启动Chrome、未接触真实profile、未执行native配额/完整1280MiB负载/导出测试。上述事务VM和虚拟账本不等同于真实磁盘满载证据；native录制和归档验证由父任务统一执行。
