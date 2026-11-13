# v0.3.1 导出恢复回归（原生 Chrome）

## 范围与隔离

仅新增 [恢复 E2E](<../../../app/tests/export-recovery.e2e.mjs>)；没有修改生产代码、依赖、构建脚本或产物。测试复制父构建的 v0.3.1 扩展到临时目录，使用现有原生 Chrome harness 创建独有 profile；不读取或改动真实用户数据、不复用用户标签页、不访问外网服务、不读取秘密。Chrome cleanup 仅限本次创建的 PID/profile，复用已有 guard。

固定合成 fixture：一个 v0.3.0 terminal legacy interrupted 批次（没有 seal），一个 v0.3.1 ready sealed 批次（合法 revision/seal）。每批 181 events（180 × 10,000 UTF-16 字符输入值 + 一个 depth 1500 graph）、2 个附件，所有事件含 id/sessionId/seq/time/kind/payload，序号 1–181。直接在本次 profile 的扩展 IDB 写入，原始 payload、附件字节与 seal 是后续比较基线。

## 关键断言（不可通过放宽获得通过）

1. 在真实 sidepanel 页面点击“导出记录包”；不伪造 runtime messages 结果或下载结果。
2. 仅在该 panel 世界包装 events/session index 的 count，返回没有 success/error 的 pending request `{}`；只把 `setTimeout` 的 15000 → 150ms、45000 → 1000ms。其它 delay 原样。包装 abort 仅观测后调用原方法。
3. 必须观察“读取记录数量超时”/对应事务中断错误、read guard 调用 storage abort、导出按钮释放且没有下载。
4. 故障前后比较所有 sessions（含 seal）、events 整体 SHA-256、assets 元数据和逐 Blob SHA-256，必须完全相同。
5. 还原 count/timeout/abort 后同一批次可真实导出 Blob/ZIP；逐原始事件深比较（含所有 UI 原值、graph 字段）、逐附件字节比较。legacy 保持 interrupted/partial，不制造 seal。
6. graph 的每个 node/direct field 都保留，派生深 path 必须有 `field-path-coverage/status=partial`，不能静默宣称全量。
7. MutationObserver 记录真实 progress，至少多个变化且包括分段/字段/附件/校验阶段；100ms heartbeat 固定 max gap < 1000ms，失败时不移除此断言。
8. 解包后校验 integrity 条目集合覆盖除 integrity 自身外每个文件，逐个比 size/SHA-256；另记录包括 integrity 自身在内 every `fileSha256`。

## 执行

```bash
cd app
CHROME_BIN="C:/Program Files/Google/Chrome/Application/chrome.exe" node tests/export-recovery.e2e.mjs
```

父通知 buildready 后执行；测试禁止自行 rebuild。该文件 177 行，syntax 检查通过后冻结。运行与首失败、真实浏览器 UA、完整 dist 文件 identity、ZIP every-file hash 记录在 [机器报告](<export-recovery.json>)，runs 追加保留，不覆盖首失败。

## 实际结果

原生首轮执行 **PASS，exit 0**。Chrome UA 为 `HeadlessChrome/157.0.0.0`（Windows 原生可执行文件，不是另装环境）。

| 批次 | 故障 UI 回收 | 还原后真实导出 | heartbeat max gap | ZIP bytes | 结论 |
|---|---:|---:|---:|---:|---|
| v0.3.0 legacy interrupted | 255ms | 902ms | 108.5ms | 96,464 | PASS，保持 partial=true/无 seal |
| v0.3.1 ready sealed | 220ms | 1,816ms | 114ms | 96,445 | PASS，原 seal 不变/partial=false |

两批故障均实际显示“读取记录数量超时”，`countCalls=1`、`abortCalls=1`；15s read guard 和45s idle timer 的指定映射均被观察到。注意原生事务可能在没有真实 request 的 `{}` 注入后自动完成，因此此处准确结论是 **guard 调用原生 abort 的尝试**，并不谎称浏览器产生了实际 onabort 事件。没有下载、按钮恢复可重试，四次只读存储快照比较（两批故障及两次成功导出后）均一致。

两次成功导出总共仅两个真实 download。ZIP 每批181原始 events 逐对象深比较通过，所有附件逐字节一致；每包14 files，其中13个 integrity 条目逐个 size/SHA-256匹配，14个文件（包括 integrity 自身）的 SHA-256 已保存于机器报告。原始1501 graph nodes 及1501 direct fields 都保留；派生路径记录 `status=partial/reason=depth_limit/observed=257/pending=1`，原始 graph 仍完整。该 partial 是派生路径覆盖度，不应被误读为 sealed 批次生命周期 interrupted。

Progress 实测包括：分段预扫 `0→20→…→181/181`、操作阶段计数递增、原数据打包 MB 递增、字段/索引、附件、封存与校验、下载确认；sealed case 还观察到 elapsed `0→1 秒`。未伪造 progress，未删 heartbeat 或存储不变断言。

## 首失败与身份

原生测试首轮无失败。执行前第一次静态 `node --check` 曾报 `SyntaxError: Invalid regular expression flags`（Chrome UA 正则的跨工具字符串转义损失）；只把判断改为等价 `.includes("Chrome/157.")`，并用 `fileURLToPath` 纠正同类 Windows URL path 转义风险，再次 syntax check exit0。此修正发生在首次 native run/sourcefreeze 之前，未改变任何产品行为或核心断言。读取808行 JSON 证据时曾因只取700行导致本地 JSON.parse 失败，随后完整 read 后解析通过；这不是产品或回归失败。

冻结测试177行 SHA-256：`756b9120eaf0a768b18243d73da8bcbdbb00096efa8234bd21c4d9b36edbc6b6`。基线 commit `f45535f8b5136c1269eb7982e10cbf6dd4c3f7d4`（其上有父所有的 dirty 修改，不声称 clean commit）。复制扩展全部11 files hashes 记录在机器报告，主要产物身份：background `7c1721910ce9172265efcd5c53506c8e1ebec00f0a6aca10674b63d78cccff65`，content `7d0a8c01caae822ab0ce4eb63efca43149a671b04accf821d77d4219dd7ede44`，sidepanel JS `69c7cd2cce100120f8e90f486f9033d280d23de6a8deda16c6fb5153bace0ba9`。未做临时 manifest pregrant；所有复制 bytes 与 dist 原样相同。

本次自有 Chrome cleanup `confirmed`，root/browser/child 已关闭，profile cleanup `removed`；合成 ZIP/扩展副本仅留在被忽略的测试运行临时目录，不提交浏览器 profile、ZIP、真实用户数据或产物。未执行 push/publish。

## 当前 final dist 再验（追加，不覆盖首轮）

父要求8ms cooperative yield / before-stop guard / provenance3 修订后的 final dist 再执行完全相同的冻结测试。于 `2026-11-13T13:26:38.801Z` 开始，`13:26:48.570Z` 完成，**PASS，exit 0**；没有改动177行测试文件或任何生产源码。机器报告现保留两个完整 runs。

| final dist 批次 | 故障 UI 回收 | 真实重试导出 | heartbeat max gap | ZIP bytes |
|---|---:|---:|---:|---:|
| legacy interrupted | 281ms | 998ms | 114.2ms | 96,467 |
| sealed ready | 248ms | 650ms | 116.4ms | 96,445 |

两批仍均显示“读取记录数量超时”，count/abort调用各1次；无失败下载、原事件/UI值/graph/asset字节全相同，sessions/events/assets/seal四次只读不变比较全部通过。深path partial、真实progress、固定1000ms heartbeat gate 与每包14文件/13 integrity逐文件校验全部继续通过。原生第二轮无失败；只在读取增大的JSON证据时遇到一次输出预算截断后本地JSON.parse失败，改用450行分段read完成，没有修改任何测试断言。

最终产物身份（全部11 hashes见第二run）：background `39185b4db3ecb7cbd0f8aaa27f0ec1f766f16500542a79767a0b49261e183ead`，sidepanel JS `5bd65339615e3d6b28aebe774404e690359da830d01564ae5c7c69db681bee94`，content `7d0a8c01caae822ab0ce4eb63efca43149a671b04accf821d77d4219dd7ede44`。测试源码 SHA-256仍为 `756b9120eaf0a768b18243d73da8bcbdbb00096efa8234bd21c4d9b36edbc6b6`。第二轮独有Chrome清理再次confirmed，profile removed；只保留忽略目录内合成ZIP，未接触其它会话/用户profile。
