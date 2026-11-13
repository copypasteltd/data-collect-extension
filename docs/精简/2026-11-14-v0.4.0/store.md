# v0.4.0 Flow Store：API 与验证记录

## 范围与隔离

- 实现：[flow-store.js](<../../../../app/src/flow-store.js>) 与 [flow-budget.js](<../../../../app/src/flow-budget.js>)。仅新库 `logic-recorder-flow-v1`、版本1；未导入旧存储模块，不打开、升级、迁移或删除旧 `logic-recorder` 库。
- `sessions` 主键 `id`；`events` 主键 `id`，索引 `session(sessionId)`、唯一 `sessionSeq([sessionId,seq])` 与唯一 `sessionCaptureKey([sessionId,captureKey])`；`contents` 主键 `id`，索引 `session(sessionId)`。
- 原生 Node 执行，不建 Docker/WSL/VM，不安装依赖，不读取真实用户数据或 Chrome profile。下述“事务 VM”是单元测试中的内存 IDB 语义模型，不是操作系统虚拟化，更不冒充真实 Chrome 验收。

## 稳定入口

| 入口 | 语义 |
|---|---|
| `createSession(session)` | 必需 `ownerToken`；可传 `id`；固定 `profile=business-flow-v1`，初始化 open、计数0和预算。默认附不可改的capturePolicy和producerVersion（默认0.4.0，可create传Chrome数字版本）。返回完整内部行。 |
| `getSession(id,{projection?,timeoutMs?,signal?}={})` | 默认完整内部行（后台恢复需 token）；projection=true 去 ownerToken；缺失返回 undefined。 |
| `listSessions({projection?,timeoutMs?,signal?}={})` | 只扫描会话元数据，不扫描 events/contents；按 startedAt 降序。默认完整行。 |
| `projectSession(row)` | 去 ownerToken 的会话投影，UI/archive必须使用；不改变内部行。 |
| `appendCapture(id,ownerToken,event,contents=[],options={})` | options 为 `{final=false,captureKey?,timeoutMs?,signal?}`；captureKey 也可放 event.captureKey，options优先。 |
| `updateSession(id,ownerToken,patch)` | 仅明确轻元数据白名单；禁止改 owner/id/raw计数、seq、预算、revision、writer gate、seal或range。 |
| `closeSessionWrites(id,ownerToken)` | open→closing；普通采集停止，仅固定final路径可写。重复调用无害。 |
| `sealSession(id,ownerToken,{status,stopOutcome,coverage,expectedSeq?})` | 默认status stopped；支持ready。要求closing、唯一末尾stop、seq=eventCount、事务内实数匹配；expectedSeq显传可核对调用方水位。 |
| `readEvents(id,{timeoutMs?,signal?}={})` | 返回按seq有序数组；去掉内部captureKey，raw完整事件仍保留id/sessionId/seq/kind/time/payload及已提供归属字段。 |
| `readContents(id,{timeoutMs?,signal?}={})` | 返回Blob行数组；不为全部内容执行arrayBuffer。 |

轻元数据白名单：status/title/url/rootTabId/tabId/tabs/scope/coverage/stopOutcome/error/diagnostics/lastError/updatedAt/stoppedAt/endedAt/startedAt/profile/hasNotice/notice/storageError/needsVerification/incomplete/communicationUnknown。

创建时固定capturePolicy={schemaVersion:1,profile:business-flow-v1,scope:root-tab-and-attributed-child,limits:完整FLOW_LIMITS,notCollected:固定排除项}；不信任input自定义policy覆盖。producerVersion可从chrome.runtime.getManifest().version传入，trim后限2–4段0–65535数字版本；默认0.4.0。两字段保留于session projection与manifest，不允许update覆盖，也不计raw ledger；作为小型清单元数据占用导出清单开销。

终态或sealed之后禁止raw写入；仅error/lastError/diagnostics及上述固定notice/error标记可补录，不重写seal或raw水位。seal前不能先updateSession到ready/stopped等终态，否则后续raw写入会被拒绝。

## 内容、事件与原子性

- 事件允许种类严格使用[合同](<CONTRACT.md>)协调的明确白名单，不按前缀放行；final仅 `session.notice`/`session.stop`，禁止final content。普通 `session.stop` 拒绝。
- contents 单次至多16项，字段为payload顶层名、category为body/dom/resource/screenshot/meta、mime、bytes。bytes仅string/Uint8Array/ArrayBuffer/Blob；string按原UTF-8保存，不猜base64；二进制view尊重byteOffset/byteLength。
- content行：`{id:sessionId+':'+sha256,sessionId,sha256,size,mime,category,blob:Blob,categories,chargedCategories}`。sha256为原始字节SHA-256小写hex。
- 事件payload对应字段置为 `{contentId,sha256,size,mime,category,status:'captured'}`。不同语义mime的引用可以共享相同字节hash；行mime是首次记录的canonical值，不要求所有引用mime相同。
- raw event id 为 `sessionId+':event:'+seq`，seq从1安全正整数单调唯一。sessionId/id/seq由store生成，不信任页面值。
- 每次write transaction都先读取IDB中的session row，再在同一readwrite事务检查owner/gate/幂等/预算并写event、新Blob与session counters。不同module连接的竞争也由IDB事务序列化，不靠单个worker JS锁。
- Blob构造、arrayBuffer和SHA256 await全部在write transaction之前完成。事务内不await，不使transaction失活。
- accepted仅在transaction complete后返回。请求成功后事务仍可能abort；事务abort/请求错误/timeout一律抛错，不能ack保存，也不伪造空数组或部分读取成功。
- captureKey durable唯一索引防重复；已存key先于payload/hash预算检查返回accepted1+duplicate，不再加seq/内容/预算。sealed后同owner的既存key可仅ACK，不写raw。captureKey和ownerToken均不由readEvents导出。

## 预算与收尾

- 总64MiB，普通63MiB，warning48MiB，收尾保留1MiB；普通metadata3MiB，final连同既有metadata总≤4MiB；body24MiB/dom16MiB/resource8MiB/screenshot12MiB/meta4MiB。body单项≤2MiB；事件完整JSONL行≤32KiB（含换行）。
- `budget.usedBytes` = 原始唯一Blob bytes + 每条raw event的 `UTF8(JSON.stringify(event)+'\n')`。会话行/IDB索引/浏览器实现开销不混称为raw字节预算。
- 相同session hash只物理计费一次；首次用于每一个category时仍在对应category计完整size；同category再用只增加event metadata，避免跨category去重绕过局部预算。跨session不共享内容。
- event size/JSON深度/节点数有界检查在hash之前；大内容字段不inline遍历。已知body>2MiB在Blob读取前拒绝。预算helper对knownBytes即使dedup/stopped也强制验证非负safe整数；不是仅信任调用者声明。
- 普通达到恰好63MiB的已接纳事件，返回accepted1+policyStopped并持久total-limit；进一步超限或局部超限返回 `{accepted:0,failed:0,policyStopped:true,reason}`。原因固定枚举，rejectedCount饱和有界；不积累任意长日志，不silent truncate。
- close→必要final notice→唯一末尾final stop→seal。seal同事务检查实event/content计数及stop水位；sealed不会被普通patch伪造。容量拒绝不是传输failed；收尾保存失败仍抛错、不假称封存成功。
- 读取操作（含等待DB打开）deadline默认15秒且上限15秒，可取消；onabort结算。每次readEvents/readContents整批logical bytes≤64MiB；Blob lazy，不一次性materialize整个内容库。listSessions有10,000行及64MiB元数据防护。

## 本轮实际单元验证

命令（app目录）：

```sh
node --check src/flow-store.js
node --check src/flow-budget.js
node --test tests/flow-budget.test.js tests/flow-store.test.js
```

2026-11-14，Windows原生Node v24.22.1，最终 **30/30 pass，0 fail/skip**。预算测试8项；事务VM22项（含不可改capturePolicy/producerVersion创建元数据回归）。预算随机性质512seed×160=81,920转换，独立BigInt oracle核对总/分类计费、不可变性、warning/stop、normal/final上界；UTF-8另512seed含lone surrogate比对TextEncoder。

事务VM真实执行request queue/snapshot/rollback/unique索引/连接序列化，覆盖：72并发跨两个module连接、幂等重试及close/seal后重试、raw UTF-8/二进制/Blob hash、不同session隔离、相同hash跨category、event请求失败及全部request成功后abort回滚、owner拒绝、未知kind、knownbody预读拒绝、metadata不截断、63/64MiB和3/4MiB收尾边界、唯一stop/expectedSeq/实count核对、禁止rewind、读abort/deadline/cancel/Blob lazy及整batch上限。

局限：内存事务VM不是浏览器配额/磁盘耐久/worker崩溃/真实IDB生命周期证明。真实Chrome独立synthetic profile验证由父任务统一执行记录；此报告不冒领其结果。未push/publish、未改package/旧db或父代理负责的其他src。
