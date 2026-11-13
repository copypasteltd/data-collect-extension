# 数据库只读 deadline 修复记录

记录时间：2026-11-13T13:15:20.652Z。状态：**限定范围实现已完成，指定原生 Windows Node 回归真实通过；源码冻结交父整合**。

## 范围与证据边界

- 开工先读取 [AGENTS.md](<AGENTS.md>) 并查看工作区状态；既有未跟踪交付/检查资料及其他代理改动均保留，没有 reset、clean、提交、push 或发布。
- 本次仅修改 [数据库 helpers](<app/src/db.js>) 并新增 [只读超时回归](<app/tests/db-read-timeout.test.js>)；本记录及 [机器可读证据](<docs/修复/2026-11-13-stop-export/db-read-repair.json>) 为限定文档输出。
- 原生 Windows / Node v24.22.1，**无 OS 隔离**。测试全部使用内存中的合成 IDB 请求和事务通知，没有读取真 profile、真录制、用户数据库或导出 ZIP。不是实际 Chrome 操作验收。
- 父负责 archive/UI/codec 及全量 unit/build，另一代理负责 background；本子任务未越界更改其文件，也未再次委派。

## 问题

原单请求读取只依赖 request success/error，counts/get/all 没有 transaction abort/error 结算；事务被中止而没有 request 错误时可能永久 pending。事件分页已有 transaction abort，但没有 deadline；分页或任意请求无通知也会卡住。外层仅 Promise.race 超时不会取消底层事务。失败不能冒充零记录或空数组。

## 最小实现

[数据库 helpers](<app/src/db.js>) 增加统一只读 guard，默认 READ_TIMEOUT_MS = 15000：

1. 超时、取消先以对应操作名拒绝 Promise，再尝试 tx.abort()；即使 abort 抛错或不发通知也会结算。只 abort readonly transaction，不删除批次、不写入数据、不关闭共享连接。
2. settled 单次结算，清理 timeout 与 signal 监听；迟到 request/cursor/transaction 通知不能再推进游标或改变结果。
3. transaction onerror/onabort 与 request error 均拒绝；现有浏览器原错误对象保留。新生成的超时/取消信息只含固定中文操作名，不包含 sessionId、键、记录值或 signal.reason。
4. countEvents/countAssets/get/all 保持 request.onsuccess 直接返回，以兼容既有无 tx.complete 的 fake 请求；eventPage 仍必须等 tx.complete，超时/错误/abort 不返回已经收到的部分页。
5. eventPage 捕获请求、结果读取、cursor.continue 及建请求同步异常；limit 仅允许 1..1000 的整数，到 limit 立刻停止 continue。

兼容签名（新增参数均在末位）：

```js
countEvents(sessionId, options?)
countAssets(sessionId, options?)
get(store, key, options?)
all(store, sessionId, options?)
eventPage(sessionId, after = 0, limit = 20, options?)
// options = { timeoutMs = 15000, signal }
```

操作名分别是“读取记录数量”“读取附件数量”“读取单条记录”“读取记录列表”“读取记录”。

### 不变的契约

- openDB 继续共享连接、DB version 3、5000ms 打开超时及失败重试/迟到连接关闭机制。read options 在共享 open 完成后才生效，不会取消其他 writer/read 的共享 opening。
- writer 权限、水位、5000ms 写超时、seal/interrupt、removeSession/saveImport 均未修改。
- 不增依赖、不改 writer 档位、不把超时/未知当成空库，超时仅拒绝这次读取/导出并保留原批次。

## 已运行结果

工作目录 app，命令：

```sh
node --test tests/db*.test.js tests/browser-archive.test.js tests/seal-session.test.js
```

真实后台作业 bash-01da8cbcb70b42f1 已完成并通过 job_output 收集：exit 0；**61 tests / 61 pass / 0 fail / 0 cancelled / 0 skipped**，duration 10183.9341ms。

| 范围 | 通过数 |
|---|---:|
| [新增只读 deadline/cancel 回归](<app/tests/db-read-timeout.test.js>) | 43 |
| [原数据库打开/写入回归](<app/tests/db.test.js>) | 3 |
| [原 abort 回归](<app/tests/db-abort.test.js>) | 4 |
| [浏览器 archive 合成回归](<app/tests/browser-archive.test.js>) | 4 |
| [seal/session 回归](<app/tests/seal-session.test.js>) | 7 |

新增测试使用真实 5ms options 验证 pending 读超时，默认 15000ms 用 Node fake timers 验证，没有等待 15 秒。覆盖五种读的无通知/abort-only/tx error/request error/cancel/pre-cancel/success 清理，及部分页、迟到 cursor、continue 异常、分页边界、all 旧调用、同步异常与共享连接。指定回归的约 10 秒主要是原数据库测试的两项真实 5000ms 超时。旧 abort fake 无需修改。

git diff --check exit 0（只有现有 Git LF/CRLF 提示，无空白错误）。

## 父整合提醒 / 限制

- [包配置](<app/package.json>) 的 npm test 是显式枚举，新测试不会自动加入。本子任务范围内不改包配置，已通知父在全 unit 使用 tests/*.test.js 或显式补入新测试。
- 根 README 与 CHANGELOG 更新、archive 传递 signal/错误展示、background stop 根因修复以及全量 unit/build 由父协调。
- 这些结果证明只读等待路径有界并保留原数据，不代表真实录制 stop/export 已整体验收。
