# Native lifecycle release 验证记录

## 结论

**最终候选 v0.3.0：九个指定命令的最新结果为 9 PASS / 0 FAIL，退出码均为 0。** 共执行 **21 次**，历史 **6 次失败全部保留**；不是将失败隐藏后声称“一次全绿”。最终八项使用 final 标签，event-ack 在保留中间失败后以 final-ready 通过。所有后台 job 均已 collect，测试源码已冻结。

本报告仅负责本组原生生命周期验证，不代替父任务的默认单元、Python、全量 capture matrix、打包或发布结论。完整 before/after 指纹、每个文件 SHA-256、命令、job id、UTC 时间、log SHA-256、实际终端输出片段见 [机器可读结果](<E:/dev/copypaste/美容ERP/逻辑记录插件/docs/交付/2026-11-13/native-release/lifecycle-verification.json>)。

## 执行环境与边界

- Windows 本机直接执行：Node **v24.22.1**，npm **10.9.2**，Chrome **157.0.8103.40**。
- 每次设置 `CHROME_BIN=C:/Program Files/Google/Chrome/Application/chrome.exe`，cwd 为项目 app 目录；测试只用自己创建的临时 profile、扩展副本和 127.0.0.1 合成 fixture。本机测试 profile 不等于容器/虚拟机等隔离操作系统。
- 未使用 Docker/WSL/虚拟化，未访问真实 ERP、用户 Chrome/profile 或旧凭据；未重启 Chrome、关闭用户浏览器或按进程名终止浏览器。
- 每次本组仅一个 Chrome；finally 通过已有 owned-observable harness 关闭自己创建的句柄，再由 profile guard 删除自己的 profile。命令失败也执行 finally。最终仅扫描本组 profile 路径，残留文件 **0**；不宣称全系统浏览器进程普查。
- 本 worker 未自行 build、npm ci、安装依赖、修改 production、提交、推送或部署。production 修复和候选 build 由父任务完成。

## 最终候选指纹

- 时间范围：**2026-11-13 19:04:39.577 +08:00 至 2026-11-13 19:14:57.338 +08:00**。
- dist tree SHA-256：`cbd773c1213fbfaeeb9cfe31165077a75d2b0b6f72d98c263b86205b5d23ca4c`
- source tree SHA-256：`9e1c4c27f79e5f1d2e74e7f60bd1ae989e7f5d551769e33da83bbc67e734f090`
- 九个最新通过命令的 dist/source before 与 after 完全一致。source 仅 app/src；测试及 harness 另列独立指纹。
- 树摘要算法：对按路径 localeCompare 排序的 `{path,sha256}` 数组做 `SHA256(JSON.stringify(files))`，路径以 app cwd 为基准、正斜杠。此算法不同于父任务 matrix 源码身份算法，勿混同。
- 历史中父任务曾编辑 source、随后才 build；sourceChanged 标记保留。实际加载的 dist 均独立记录，不以当时 source 摘要冒充构建来源证明。首次旧 loader 失败时 npm package 已为 0.3.0、dist manifest 仍为 0.2.0，也按实际记录。

## 九命令最新实际结果

| 命令 | 结果 / code | 秒 | 标签 | 覆盖 | 证据 |
| --- | --- | ---: | --- | --- | --- |
| `npm run test:attach-stop` | **PASS / 0** | 14.335 | final | 迟到 attach 关闭；新批次等待旧连接再重新 attach | [日志](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/test-native-lifecycle-attach-stop.final.log#L3>) |
| `npm run test:status-isolation` | **PASS / 0** | 22.159 | final | 批次读超时不妨碍停止；读恢复可导出；准备错误保留中断批次 | [日志](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/test-native-lifecycle-status-isolation.final.log#L3>) |
| `npm run test:concurrent-stop` | **PASS / 0** | 4.338 | final | 拒绝重复 STOP；正常收尾；真正存储失败标为中断 | [日志](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/test-native-lifecycle-concurrent-stop.final.log#L3>) |
| `npm run test:recovery-stop` | **PASS / 0** | 33.874 | final | 恢复读失败/过期 STOP/并发 STOP/写入清理双错误及恢复归档 | [日志](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/test-native-lifecycle-recovery-stop.final.log#L3>) |
| `npm run test:stop-lifecycle` | **PASS / 0** | 117.992 | final | 多页并行；迟到注入/注册/FLUSH/STOP/detach/状态写；sealed 操作锁 | [日志](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/test-native-lifecycle-stop-lifecycle.final.log#L3>) |
| `npm run test:stop-review-regressions` | **PASS / 0** | 67.782 | final | 状态读超时/过期 STOP/iframe 接管/框架广播/中断写重试与导出 | [日志](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/test-native-lifecycle-stop-review-regressions.final.log#L3>) |
| `npm run test:event-ack` | **PASS / 0** | 5.357 | final-ready | 确认 2/1、回滚 0/3、失败/未知分层、20 条单事务、跨批拒绝、挂设置时关闭 | [日志](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/test-native-lifecycle-event-ack.final-ready.log#L3>) |
| `npm run test:event-retry` | **PASS / 0** | 5.541 | final | 确认丢失/worker 重启/去重/并发/标识冲突/截图缺口 | [日志](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/test-native-lifecycle-event-retry.final.log#L3>) |
| `npm run test:event-timeout` | **PASS / 0** | 21.476 | final | 单次/持续超时、三次同 ID 重试、通信恢复、有界停止 | [日志](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/test-native-lifecycle-event-timeout.final.log#L3>) |

原生复核形式（app cwd，其他项替换 npm script）：

```bash
CHROME_BIN="C:/Program Files/Google/Chrome/Application/chrome.exe" npm run test:attach-stop
```

本次用本地 runner 仅记录时间/指纹/日志，不改变 child npm 的退出码或测试断言。

## 失败定位与受控修复

1. **LIFE-001：原生载入兼容。** 旧 load-extension flags 在本机 Chrome 157 未启动 serviceworker，15s 超时。[失败证据](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/test-native-lifecycle-attach-stop.initial.log#L10-L16>)。九测试仅统一 import/launch/id/cleanup 到现有 [harness](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/tests/chrome-harness.mjs>) 的 Extensions.loadUnpacked 与 owned cleanup；原业务 fixture/断言未随 loader 迁移变弱。
2. **LIFE-002：封存终态与操作锁两层。** 证据已 sealed、状态清理仍挂起，active.status 为 ready，旧断言误要求 stopping。[原值失败](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/test-native-lifecycle-stop-lifecycle.native.log#L14-L25>)。加强为同批 id、ready/sealed、相同 seal、UI disabled、直接 START 被拒、release 后 active null，见 [加强断言](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/tests/stop-lifecycle.e2e.mjs#L261-L278>)。完整 suite 最终通过，不回退生产终态。
3. **LIFE-003：真实 production 无界读。** 永久挂起 readonly sessions.get 的恢复 fixture，在第二批 STOP 命中新封存水位裸 await，30s 仍不能开始。[旧失败](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/test-native-lifecycle-stop-review-regressions.native.log#L12-L22>)。父任务将 [封存水位读取](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/src/background.js#L1437>) 包在 5000ms deadline 内；未改故障 prelude、未延长等待。最终五个 review 场景全部通过。
4. **LIFE-004：故障注入旧 put。** append-only writer 已用 add；旧测试拦 put，期望 2/1 却实际 3/0。[原值证据](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/test-native-lifecycle-event-ack.native.log#L10-L25>)。故障/事务跟踪改为 add，重复键调用保存的原 add 避免递归。2/1、0/3、good/bad 持久化、20 条单事务和跨批断言全部保留。
5. **LIFE-005：确定失败不等于通信未知。** 合法 accepted/failed 确认是 failed1/unknown0，旧文案要求未确认1。[旧文案失败](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/test-native-lifecycle-event-ack.final.log#L10-L20>)。现在同时核 warning“失败 1 条，未确认 0 条”、collectorFailedEvents=1、unknownEvents=0，而不是删除警告断言。
6. **LIFE-006：挂设置 fixture 旧握手顺序。** 故意悬置 CANVAS_OPTIONS 却 await 普通 START，5s 后 collector 按超时契约自关，STOP_CAPTURE 无接收器。[失败证据](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/test-native-lifecycle-event-ack.final-contract.log#L10-L13>)。仅第三 START acknowledgeEarly；host 2s 内确认隔离 world collector 和 hook 已存在，立即 STOP_CAPTURE 并核 reply.ok=true，再释放设置；原无 snapshot/最终 STOP 断言保留。[最终测试](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/tests/event-ack.e2e.mjs#L146-L183>)、[最终通过](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/test-native-lifecycle-event-ack.final-ready.log#L3-L8>)。之后无更多测试改动。

## 全部 21 次真实运行（时间 +08:00）

| 开始 | 命令 | 标签 | 结果 / code | 秒 | dist 版本 / SHA 前缀 | 日志 |
| --- | --- | --- | --- | ---: | --- | --- |
| 18:55:07.073 | `test:attach-stop` | initial | FAIL / 1 | 16.863 | 0.2.0 / `69c5d090c09c` | [日志](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/test-native-lifecycle-attach-stop.initial.log#L3>) |
| 18:56:50.755 | `test:attach-stop` | native | PASS / 0 | 14.263 | 0.3.0 / `da9ffaf80946` | [日志](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/test-native-lifecycle-attach-stop.native.log#L3>) |
| 18:57:12.338 | `test:status-isolation` | native | PASS / 0 | 26.867 | 0.3.0 / `da9ffaf80946` | [日志](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/test-native-lifecycle-status-isolation.native.log#L3>) |
| 18:57:50.793 | `test:concurrent-stop` | native | PASS / 0 | 3.614 | 0.3.0 / `da9ffaf80946` | [日志](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/test-native-lifecycle-concurrent-stop.native.log#L3>) |
| 18:58:20.936 | `test:recovery-stop` | native | PASS / 0 | 37.157 | 0.3.0 / `da9ffaf80946` | [日志](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/test-native-lifecycle-recovery-stop.native.log#L3>) |
| 18:59:09.467 | `test:stop-lifecycle` | native | FAIL / 1 | 70.042 | 0.3.0 / `da9ffaf80946` | [日志](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/test-native-lifecycle-stop-lifecycle.native.log#L3>) |
| 19:00:25.669 | `test:stop-review-regressions` | native | FAIL / 1 | 76.660 | 0.3.0 / `da9ffaf80946` | [日志](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/test-native-lifecycle-stop-review-regressions.native.log#L3>) |
| 19:01:48.710 | `test:event-ack` | native | FAIL / 1 | 4.417 | 0.3.0 / `da9ffaf80946` | [日志](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/test-native-lifecycle-event-ack.native.log#L3>) |
| 19:02:14.570 | `test:event-retry` | native | PASS / 0 | 4.189 | 0.3.0 / `da9ffaf80946` | [日志](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/test-native-lifecycle-event-retry.native.log#L3>) |
| 19:02:36.304 | `test:event-timeout` | native | PASS / 0 | 20.998 | 0.3.0 / `da9ffaf80946` | [日志](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/test-native-lifecycle-event-timeout.native.log#L3>) |
| 19:04:39.577 | `test:attach-stop` | final | PASS / 0 | 14.335 | 0.3.0 / `cbd773c1213f` | [日志](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/test-native-lifecycle-attach-stop.final.log#L3>) |
| 19:05:15.836 | `test:status-isolation` | final | PASS / 0 | 22.159 | 0.3.0 / `cbd773c1213f` | [日志](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/test-native-lifecycle-status-isolation.final.log#L3>) |
| 19:05:55.910 | `test:concurrent-stop` | final | PASS / 0 | 4.338 | 0.3.0 / `cbd773c1213f` | [日志](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/test-native-lifecycle-concurrent-stop.final.log#L3>) |
| 19:06:25.292 | `test:recovery-stop` | final | PASS / 0 | 33.874 | 0.3.0 / `cbd773c1213f` | [日志](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/test-native-lifecycle-recovery-stop.final.log#L3>) |
| 19:07:05.959 | `test:stop-lifecycle` | final | PASS / 0 | 117.992 | 0.3.0 / `cbd773c1213f` | [日志](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/test-native-lifecycle-stop-lifecycle.final.log#L3>) |
| 19:09:38.567 | `test:stop-review-regressions` | final | PASS / 0 | 67.782 | 0.3.0 / `cbd773c1213f` | [日志](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/test-native-lifecycle-stop-review-regressions.final.log#L3>) |
| 19:10:55.096 | `test:event-ack` | final | FAIL / 1 | 4.475 | 0.3.0 / `cbd773c1213f` | [日志](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/test-native-lifecycle-event-ack.final.log#L3>) |
| 19:11:13.915 | `test:event-retry` | final | PASS / 0 | 5.541 | 0.3.0 / `cbd773c1213f` | [日志](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/test-native-lifecycle-event-retry.final.log#L3>) |
| 19:11:37.812 | `test:event-timeout` | final | PASS / 0 | 21.476 | 0.3.0 / `cbd773c1213f` | [日志](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/test-native-lifecycle-event-timeout.final.log#L3>) |
| 19:12:41.072 | `test:event-ack` | final-contract | FAIL / 1 | 10.888 | 0.3.0 / `cbd773c1213f` | [日志](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/test-native-lifecycle-event-ack.final-contract.log#L3>) |
| 19:14:51.981 | `test:event-ack` | final-ready | PASS / 0 | 5.357 | 0.3.0 / `cbd773c1213f` | [日志](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/test-native-lifecycle-event-ack.final-ready.log#L3>) |

## 可复核性与限制

- 日志是本机保留、Git 忽略的合成测试输出；JSON 包含完整日志 SHA-256 以及实际输出片段。未加入真实 ERP 数据或用户凭据。
- 九个测试最终 node --check 均退出 0；仅这九个文件 git diff --check 退出 0（只有未来 LF→CRLF 提示）。
- **9/9 表示相同候选 dist/source 上各命令的最新通过结果，不是声称最后修改后重跑过全部九份 test 源码版本。** event-ack 最后 fixture 独立复验，其余八项无再改；全量 matrix 的最终稳定 tests 身份由父任务另验。
- 本机合成生命周期 E2E 不等于真实 ERP 全业务覆盖，也不保证所有 Windows/Chrome 版本或全系统进程/网络隔离。
