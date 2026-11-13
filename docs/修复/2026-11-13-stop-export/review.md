# Stop/导出限定 review

**结论：限定 pass；无未关闭 critical。** 仅本轮源码/pure，不代表真实现场或 Chrome 大包验收。[机器报告](<review.json>)。

## R1（P2，已父修并复核）
[旧判断](<../../../app/src/stop-outcome.js#L25-L27>)使先前 unexplained incomplete 被 later producer gap 免责：调试连接外层超时/注入未就绪先设 incomplete；末次 FLUSH 再加 captureIncomplete→错误 ready。父已在[Stop入口](<../../../app/src/background.js#L1276-L1278>)快照原故障并传[终态判定](<../../../app/src/background.js#L1582>)；原生 Node 同状态复核保持 interrupted。不是删原缺口，也未声称 Chrome 复现此组合。

## 已核验
- 62 targeted tests 全过；调度更新后 10 项复跑全过。[独立探针](<../../../app/test-stop-review-pure/review.mjs>)额核 450123B 多块、中文名、空项：ZIP 中央目录/descriptor CRC32、size 与原字节一致；reader 先 pump、原 push 保 CRC。native abort 不产 final ZIP。
- 真正 createArchive→readArchive 合成 legacy interrupted（无 seal）可导出、零写入、源记录不变；integrity 不含自身，全部路径 exact SHA256。
- 已读 signal/WebLock、45s idle、15s readonly guards、进展及终态连线；失败不造 completed。producer-only 保缺口并 ready；store/failed/unknown/finalization/coverageUnavailable 保 interrupted。

## 边界
64KiB/level1 fallback 与约8ms让步均为 cooperative；timer 非硬 CPU 截止。先读 [AGENTS](<../../../AGENTS.md>) 并记录 dirty；仅写报告与 ignored 合成探针，未改 production/用户 Chrome/profile/data、未委派/Team、未 build/重跑全套/发布。现场桥未接，未读真实 site；父负责新 Chrome 大包 timeout/error，未因此泛放行。并行 graph owner 不在本审范围。
