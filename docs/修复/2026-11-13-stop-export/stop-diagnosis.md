# 正常 Stop 被标成「录制中断」：原生 Windows 合成诊断

日期：2026-11-13。基线：`f45535f` / 已发布 v0.3.0。结论：**已复现，且不需要断网、杀后台、伪造 FLUSH、耗尽磁盘或改生产源码。**

机器可核对的明细见 [诊断 JSON](<docs/修复/2026-11-13-stop-export/stop-diagnosis.json>)。测试为新增的 [stop-export-regression.e2e.mjs](<app/tests/stop-export-regression.e2e.mjs>)；没有修改原有测试、构建配置或生产源码，没有发布版本。

## 1. 精确故障链

1. [content.js:2245–2280](<app/src/content.js#L2245-L2280>) 在 FLUSH 时先请求最终快照，再等初始/最终 database、cache 和 fragmentTransfers。9000ms 到期后将 sticky captureIncomplete 设为 true，随后 stopped=true 停止仍在采样的 producer。
2. [batch-outcome.js:23–35](<app/src/batch-outcome.js#L23-L35>) 的 summary.ok 同时表示 producer/transport 完整性。已知 producer gap 也会得到 ok=false，即使 failedEvents=0、unknownEvents=0。
3. [background.js:1323–1344](<app/src/background.js#L1323-L1344>) 先保留 captureIncomplete/needsVerification，再因 !result.ok 抛异常；catch 无条件写 communicationUnknown=true，并提示「失败 0 条，未确认 0 条」。这是**已知采集缺口误归类为通信未知**。
4. [background.js:1569–1573](<app/src/background.js#L1569-L1573>) 将任何 incomplete 映射为 interrupted，尽管本次用户 Stop 的 session.stop、write fence、seal、关闭 collector、解除 debugger 和清除 active 都正常完成。

普通大页每 5 个元素一批、逐批读 computed style + 伪元素 + 压缩 + ACK，见 [content.js:794–859](<app/src/content.js#L794-L859>)。最终采样可能等待前一轮采样，见 [content.js:669–673](<app/src/content.js#L669-L673>)。2500 行静态 article（约 10012 元素）已足以跨越 FLUSH 的 producer 截止，不需要异常页面。

### 关键原生响应

a) 正常点击 Stop 后，FLUSH 实际耗时 **9224ms**：

~~~json
{"ok":false,"failedEvents":0,"unknownEvents":0,"captureIncomplete":true,"needsVerification":true}
~~~

b) STOP_CAPTURE 耗时 **1ms**，返回 {"ok":true}。

c) 停止前 incomplete=false；停止后 status=interrupted、communicationUnknown=true、captureIncomplete=true、storageError=false。唯一 warning 是「结束时无法取得页面最终状态 / 页面采集收尾：失败 0 条，未确认 0 条」。

**不应将此反例解释成「完全采集成功」**：其 computed-style producer 的确被时间预算截断。应该修复生命周期与分类，但保留原始缺口、警告和覆盖率证据。

## 2. 合成原生 Chrome 矩阵

使用 C:/Program Files/Google/Chrome/Application/chrome.exe，经原有 [chrome-harness.mjs](<app/tests/chrome-harness.mjs>) 的 launchExtension 启动独立新 profile、仅访问 127.0.0.1 临时 HTTP 站点。浏览器报告 Windows HeadlessChrome/157.0.0.0；这是原生 Windows headless Chrome，不是 WSL/Docker/隔离容器，也不是用户现有 Chrome。测试仅透明记录 FLUSH/STOP_CAPTURE 响应与耗时，不修改响应、不注入延迟、不缩短截止时间。

| 场景 | Stop ms | 最终状态 | 原始缺口 | 导出下载事件 ms | 保存/导出事件数 |
|---|---:|---|---|---:|---:|
| 10 行普通小页面 | 853 | ready | 无 | 883 | 84 / 84 |
| 2500 行普通大页面 | 9410 | **interrupted（错误分类）** | captureIncomplete；styleGaps=3；initialResourceGaps=1 | 8676 | 698 / 698 |
| 主页面 + 10 同源 iframe | 5484 | ready | styleGaps=1 | 7043 | 810 / 810 |
| 6 tab × 250 行 | 15773 | ready | fullPageScreenshotGaps=10；styleGaps=1 | 31574 | 2645 / 2645 |
| 单个网页 IDB 真正繁忙 | 2901 | ready | databaseGaps=1（stop snapshot timeout） | 2074 | 120 / 120 |

「导出下载事件 ms」只量到 Playwright download 事件；之后还等待读取完整 ZIP 并核对事件数，**不是所有导出处理的精确完成耗时**。所有 ZIP 均实际读取和解压。此次没有复现无限卡整理：6-tab 导出到下载事件较慢，约 31.6s；不能据此断言用户的卡整理已经修好。

繁忙 IDB 为网页自建 synthetic-busy 数据库的真实 14 秒 readwrite transaction，不是 recorder 数据库失败或 patched API。采样在约 2.5s 将对应 snapshot 记为 timeout 后正常返回，保留 databaseGaps=1；这和 recorder 写入失败必须分开。只有数值 coverage gaps 不会直接设 interrupted；本反例的关键是 FLUSH producer summary 被混类。

## 3. 大页面的封存与可用证据

- seal 存在；writeState=sealed；eventCount=lastSeq=698；序列 1..698 连续；active=null。
- session.stop 恰好一条且 finalStopEventId 存在；正常输入 synthetic-normal-stop-large 仍保留。
- 4 个 database/cache 的 initial/stop state.capture 均 completed，不是它们故障。
- 645 条 page.computedStyle 全属于 initial snapshot，batchIndex=0..644 / batchCount=2002。唯一 1 条 page.computedStyleEnd 属于 input snapshot，status=skipped_busy；stop snapshot 的样式采样还在排队，未开始。styleGaps=3 必须保留。
- 资产 4 个 / 6,015,042B；事件约 10.68M JSON 字符；实际 ZIP 13,637,789B；全部 698 个事件可导出。
- 无 storageError、collectorFailedEvents、unknownEvents、droppedEvents、断链或后台重启证据。

原始 [大页面日志](<app/test-stop-export-bIS8qg/large.json>)、[完整运行日志](<app/test-stop-export-baseline.log>)、[矩阵原始结果](<app/test-stop-export-bIS8qg/result.json>) 均保存在 ignored 合成证据目录中。复制的 baseline background SHA-256 为 761c0c223864f94432069d4ce2134f9e298fdd6d46167283076255f82cdc64fa，保证父后续 build 不会改变本次基线证据。

## 4. 冻结回归契约

[专属回归脚本](<app/tests/stop-export-regression.e2e.mjs>) 默认 regression 模式。observe 只是诊断采集，不是产品通过；这次基线观察任务 exit=0 不代表 v0.3.0 通过。

预期修复后，同一原始输入：

- 正常用户 Stop 完成 write fence、final stop event、seal 和 cleanup 后 status=ready。
- durable stopOutcome.requestedBy=user，result=completed 或 completed_with_gaps；不能把 capture gap 擦除后假装 completed。
- failed/unknown 必须仍为零，known producer gap 不得制造 communicationUnknown。
- 保留 captureIncomplete、needsVerification、全部 coverage 和原始 warning，ZIP 与 sealed 事件计数对齐。
- 真正 failed/unknown/store failure、后台异常终止等仍须用 interrupted 分支；本正例脚本遇到实际 storage/failed/unknown 会失败，不会把它们洗成 ready。

执行（workdir 为 app）：

~~~bash
CHROME_BIN="C:/Program Files/Google/Chrome/Application/chrome.exe" STOP_MODE=observe node tests/stop-export-regression.e2e.mjs
CHROME_BIN="C:/Program Files/Google/Chrome/Application/chrome.exe" STOP_MODE=regression node tests/stop-export-regression.e2e.mjs
~~~

当前修复后验证状态：**等待父代理提供新 build 后，用相同 5 case 对照；未对未构建候选宣称通过。**

## 5. 资源与范围边界

基线后台 job bash-42db70c10faf4414 已通过 job_output collect，exit=0。5 个 owned Chrome 均 cleanup confirmed，rootClosed=true、browserClosed=true、setupSettled=true；测试 profile 均 removed。仅清理本任务自己创建的浏览器/页面/profile，没有连接、关闭或复制用户 Chrome，也没有查看真实录制。

原有 dirty 的 validation-probes 和历史交付/评估文档保持不动；无 git commit/push、无版本发布。生产 background、UI、archive、db 修复由父代理拥有；本子任务只提交独立停止复现与证据。

## 6. 修复候选第一次复验：Stop 分类通过，导出截止失败（保留失败）

父代理提供的第一份 0.3.1 build，使用冻结的同 5 case、同 40 秒下载事件截止重新跑 regression，未更改 case、schema 或断言。原始 [fixed 日志](<app/test-stop-export-fixed.log>)、[fixed 结果](<app/test-stop-export-6Km5oP/result.json>) 保留；job bash-b3b47ba3d1bf49b3 已 collect，**exit=1，不是通过**。

| 场景 | Stop ms | Stop 结果 | 下载事件 ms | 导出观察 |
|---|---:|---|---:|---|
| small | 838 | ready / completed | 3471 | 下载成功 |
| large | 9440 | ready / completed_with_gaps | 40011 | 截止失败：600 / 661 项、132.4 MB、UI 用时 38 秒 |
| multi-frame | 6450 | ready / completed_with_gaps | 40008 | 截止失败：780 / 810 项、128.4 MB、UI 用时 38 秒 |
| multi-tab | 14353 | ready / completed_with_gaps | 40011 | 截止失败：560 / 2198 项、126.1 MB、UI 用时 39 秒 |
| busy-idb | 2888 | ready / completed_with_gaps | 4762 | 下载成功，databaseGaps=1 保留 |

所有例子的 storageError / communicationUnknown 均 false；大页 captureIncomplete=true、styleGaps=3 保留，正常封存且 session.stop 唯一。此轮透明 observer 的 trace 为空，故不声称采到了 fixed 的逐次 FLUSH 回包；判断基于持久化 session/seal、原始事件和实际 UI。

失败时 UI 仍显示递增处理项/打包字节且无 panelError，因此只能判为**导出没有满足冻结的 40 秒截止**，不能将其说成无进展死锁，更没有扩大预算来求绿。父代理随后修正 native 压缩的 cooperative yield 调度；相同 5 case 的优化 build 正在另一个 owned run 复验，原失败不会被覆盖。

## 7. 优化版最终同 5 case 复验：通过（未放宽截止/断言）

最终 0.3.1 优化 build 复制到新的 owned 目录后，使用**相同 5 case、相同输入、相同默认 40 秒下载事件截止、相同已冻结 regression 断言**运行。job bash-68e5c70d70824f92 已 collect，**exit=0，五例全部通过**。原始 [optimized 日志](<app/test-stop-export-optimized.log>)、[optimized 结果](<app/test-stop-export-tFZiLS/result.json>) 保留；本节更新前文的「等待 build」状态，不抹除基线或第一次失败。

| 场景 | Stop ms | durable outcome（均 requestedBy=user） | 下载事件 ms | 本地/导出事件 | ZIP bytes |
|---|---:|---|---:|---:|---:|
| small | 854 | ready / completed | 1287 | 84 / 84 | 440574 |
| large | 11079 | ready / completed_with_gaps | 16205 | 491 / 491 | 10856809 |
| multi-frame | 12178 | ready / completed_with_gaps | 17960 | 805 / 805 | 5255611 |
| multi-tab | 10718 | ready / completed_with_gaps | 12319 | 618 / 618 | 5382520 |
| busy-idb | 2889 | ready / completed_with_gaps | 1787 | 120 / 120 | 465428 |

- 五例均 storageError=false、communicationUnknown=false，持久化 seal 存在、序列 1..N 连续、唯一 session.stop、全部合成输入保留，所有 ZIP 均实际读取解压且事件数与各自封存批次一致。
- large 仍有 captureIncomplete=true、needsVerification=true、styleGaps=3、initialResourceGaps=1，警告明确改为「录制已正常停止，部分末次采集未完成；已保存内容仍可导出核验」。不是把缺口删除后求绿。
- multi-tab 6 个 FLUSH 原生回包全部捕到 failedEvents=0、unknownEvents=0、captureIncomplete=true；最终 ready / completed_with_gaps，直接证明已知 producer gap 不再误归类成通信未知。large/busy-idb 本轮 observer trace 为空，故不虚构其具体回包。
- coverage 数字缺口保留：multi-frame 的 screenshotsUnavailable=1、shadowSourceGaps=1、styleGaps=3；multi-tab fullPageScreenshotGaps=10、styleGaps=13；busy-idb databaseGaps=1。其生命周期完成不等于证据全面完整。
- 基线 large 698 事件与最终 491 事件不是跨批次丢写对比：不同机器并发负载与既有 producer 时间预算会改变 best-effort style 采样批数。每一批次内部的序列/封存/导出均对齐，缺口始终保留；不能宣称捕获量提升或「全量采集」。

### 原始 DOM 行与导出证据哈希

离线核对全部 5 个实际 ZIP 的完整序列、唯一事件 ID、唯一 stop，记录全事件按 seq 排序的 kind+payload SHA-256，明细见 [诊断 JSON](<docs/修复/2026-11-13-stop-export/stop-diagnosis.json>) 中 fixedValidation.optimizedOriginalRowsAndPayloadVerification。哈希覆盖实际 ZIP 的所有原始事件；不是已删除 profile 后伪称做了 DB-to-ZIP 逐字节 digest 比对。

large 的 initial/input/stop 三份原始 sourceHtml 和 replay html 都有 **2500 行完整 article**，其规范化原始行 SHA-256 均为：

~~~text
dbbf1052156f2cdb854456ddbee46874c7d1ded30001d9cd4534f1331fc55c48
~~~

该值与独立生成的 fixture 2500 行及基线三份 snapshot 全部一致。large 优化版 ZIP SHA-256 为 4506b69c65ef93c057cdd5a4e78ff328fba81ca95a7e7e743ef6eb35079cce4c；全事件 kind+payload SHA-256 为 86b8ff9939e302417f27fcfbd17ff89b236bf07abd49e9501f34aafac2efb0b6。其他场景对应原始行也全部匹配各自 fixture。

最终 copied background SHA-256 为 39185b4db3ecb7cbd0f8aaa27f0ec1f766f16500542a79767a0b49261e183ead；content SHA-256 为 7d0a8c01caae822ab0ce4eb63efca43149a671b04accf821d77d4219dd7ede44。

所有 5 个 owned Chrome cleanup confirmed、profile removed。本次未更改任何冻结测试/生产源码，也未发布版本。**这些结论只适用于匹配故障的原生 Windows 合成反例；没有浏览/核查用户真实站点、真实录制或未连接的 browser bridge。**真正 storage/unknown/finalization 中断的故障回归由父代理独立负责，不拿本正例替代。
