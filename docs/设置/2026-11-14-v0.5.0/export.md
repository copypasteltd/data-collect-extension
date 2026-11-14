# v0.5.0 流式记录导出

本次最终设置为三组整数倍率1–20，默认与最大为20。最大单批逻辑容量为1280MiB（1.25GiB）；导出读取批次创建时固化的设置，不使用当前界面设置替换旧批次。缺少设置的历史批次继续采用1倍64MiB限额。

## 文件与接口

- [导出器](../../../app/src/flow-archive.js)：按事件与内容游标分页，校验封存、设置、引用与账本，产出一个v3记录ZIP。
- [ZIP写入器](../../../app/src/flow-zip64.js)：顺序STORE写入、CRC32、ZIP64头、OPFS输出与有限内存回退。
- [哈希模块](../../../app/src/flow-hash.js)：增量SHA256与最多1MiB的Blob流块，无新增NPM依赖。

公开哈希API：export class Sha256 { update(Uint8Array): this; digestHex(): string }；export async function sha256Blob(blob, { signal } = {})；export async function sha256Bytes(bytes)。digestHex()可重复调用，finalize后不能再update。

导出入口继续为createFlowArchive(store)(sessionId, onProgress, options)，返回{ blob, cleanup, importIssues, metrics }。正常Chrome125的OPFS路径返回磁盘文件getFile()的原始File对象；metrics.storageMode（以及outputStorage）为opfs或memory。测试可用options.storage注入存储适配器。cleanup()可重复调用，由侧栏在下载确认完成或失败、撤销下载对象URL后调用，不能提前删去正在下载的文件。

## 分页、内存与磁盘生命周期

事件读取flowEventPage(id, afterSeq, { limit:500, maxBytes:8MiB, signal })，严格递增seq并验证nextSeq/done；只持有当前页和最多约1MiB的JSONL分段。内容读取flowContentPage(id, afterId, { limit:50, signal })：首轮仅保留contentId/hash/size/MIME/category索引元数据，次轮重新分页取得懒Blob并流式写入，不保留所有Blob句柄。兼容旧纯测试源的readEvents/readContents接口，但实际store优先使用分页接口。

每个Blob通过stream()读取，单次哈希、CRC及输出写入块均不超过1MiB；不会对完整正文调用arrayBuffer()。写入器等前一write完成后才继续读取源，形成背压。STORE不做压缩，因此ZIP大小接近逻辑原文加清单和目录开销；它保留原文，不派生样式字典或全库镜像。

正常路径在OPFS根创建唯一的logic-recorder-export-<随机UUID>.zip临时文件。按块write并续报进度，先close完成落盘，再getFile取得输出。封存复核通过后才返回blob与cleanup。读取、写入、flush、SHA核验、取消或最终封存核验失败时调用abort并移除本次拥有的临时文件；不会删除本地录制。

45秒仍是无进展超时，不是整个导出的总时限；分页、每个写入块、任务yield持续更新进度。超时及外部取消共用AbortSignal，所有流读取会取消并释放reader锁。

没有OPFS时，只允许最终输出不超过128MiB的内存回退。已知逻辑容量超过128MiB会在读取内容前明确拒绝；ZIP目录或清单使输出超过此限时也会明确拒绝，不无限堆积Blob块。支持OPFS不代表磁盘空间或浏览器额度必然足够，真实文件系统错误会使导出失败。

## 封存与格式校验

ZIP内格式仍为logic-recorder/version3/business-flow-v1，一个ZIP包含manifest.json、integrity.json、timeline/events-*.jsonl和contents/<sha256>.bin。每份原始内容按hash只写一次。小包使用普通ZIP头与数据描述符；size/offset达到0xffffffff、目录尺寸或数量达到经典ZIP保留值时，写入对应ZIP64扩展与结束记录。尺寸和偏移运算使用BigInt，不对4GiB高位做32位截断。本次1.25GiB设置本身不需要ZIP64，边界支持作为写入器能力保留。

导出同时验证：

- 封存计数、连续1..N事件、唯一事件ID、唯一且最后的session.stop、导出开始/结束的完整公开批次水位一致。
- 新设置、预算settings、capturePolicy.limits与runtimeLimits均与唯一配置源派生值一致；旧批不继承默认20倍。
- contentId为sessionId:sha256、哈希/大小/MIME/category有效，源Blob尺寸一致，无重复索引或未引用内容；空内容仍需要真实引用。
- 只把同时具有status=captured与contentId的一级payload对象视为记录器内容引用，避免把普通业务字段误识别。引用必须匹配hash与size；同hash跨类别、不同MIME的观察引用合法，原payload不变。
- 原始事件JSONL实际UTF8字节数加唯一内容字节数恰好等于budget.usedBytes；分类账按每hash在每类别的首次引用计费，meta另含所有事件原文。
- 每个附件写入时增量SHA256与索引比对；ZIP CRC32随块计算；integrity.json列出所有其他成员的原始字节数和SHA256。
- ownerToken/captureKey不会出现在公开session或原始事件顶层；内部字段存在于事件/内容索引时拒绝打包。

## 验证证据与边界

定向测试入口为node --test tests/flow-hash.test.js tests/flow-zip64.test.js tests/flow-archive.test.js（在app目录），最终17项全部通过。覆盖SHA256已知向量、一百万个a、多分块padding边界、CRC32的123456789向量、Blob仅stream读取与取消、1005个事件跨页连续性、20倍/旧1倍限额、跨类别MIME、孤立引用与账本失败、OPFS块背压、先flush后getFile、延迟cleanup、写失败/flush失败/封存变化清理、128MiB回退拒绝和普通业务标记原样保留。

ZIP64高位用虚拟size/offset/count标量验证，不分配4GiB或12GiB正文；Python标准zipfile独立读取实际小型普通ZIP和实际小型强制ZIP64结构，验证CRC与SHA。

父任务的真实Chrome125集成已导出72MiB合成原始内容（另含事件元数据），OPFS输出为磁盘File并完成下载，ZIP大小75511309字节；Python读取5事件、4附件通过。此证据覆盖实际超过64MiB旧限额的录制导出。1.25GiB最大全负载尚未实际运行，虚拟ZIP64测试不等于该负载已经实测通过。
