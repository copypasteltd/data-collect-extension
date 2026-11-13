# 历史记录 v1/v2：仅离线兼容

本页只在 manifest.version 为1或2时读取。v0.4.0的新v3包不含这些重型通道；不能为v3缺少它们报错或自动访问原站补采。


## v0.3.0 读取契约

v0.3.0修复分段终态、派生来源与封存一致性；读取器支持记录格式v1/v2，完整发布验证结果随release另附。全部原始事件应保留；下述更严格校验不允许通过删掉Failure或重复片来“修好”原包。

- 分段引用的captureId/field必须非空字符串；length为正安全整数，parts为ceil(length/100000)，index为非负且小于parts的安全整数。长度单位是UTF-16代码单元，不是UTF-8字节。JSON整数值如1.0/1e0与1等价，bool不等价；索引-0按0，超过9007199254740991拒绝。
- 必须齐全的唯一分片、精确长度和唯一confirmed End；End后同组额外fragment、任何同captureId+field的显式fragmentFailure（无论其附带metadata是否缺失/错误）均使内容不完整。Failure不因End先到而被覆盖。
- 发送方unknown ACK表示提交事实未知，不是内容读取失败，不应制造相反Failure；已返回unknown的批次结果不会被改写，迟到确认只作协调诊断。停止后的captured/ready仍不能单独证明全部内容完整。
- 空文件继续以内联空Base64表示，不通过length=0引用冒充完整分片。单个重组调用需来自一个会话的完整有序证据；工具不主动跨会话查询补片。
- SQLite mode=ro只禁止该连接写入，不证明索引来源、不可变或原ZIP已验证；应由调用者先校验ZIP/索引的来源与文件hash，再在使用资源时复核。
- 新派生browser observation携带明确source identity，未知partition不跨document盲目并为同库；历史缺identity的汇总需按legacy规则解释，不补造浏览器实际未提供的storageKey。新封存revision为可选字段，旧终态无seal不凭空补造。

## 可选版本来源与存储诊断

新本地 v2 导出可带 `manifest.provenance`：`schemaVersion:1` 仅标此元数据结构；`producerVersion` 只来自批次创建时已持久化的 `session.producerVersion`，缺失或不合法为 `null`；`exporterVersion` 来自导出当下真实扩展 runtime 版本，API缺失/错误或版本无效同样为 `null`。不能用 exporter、当前包名或时间给旧录制补造 producer。导入原 Blob 早退保持不重包，旧 v1/v2 没有此字段仍按原规则读取。

`provenance.derivations` 当前只标实际派生规则：`browserObservations:3`（v0.3.1显式限制派生路径深度256、累计位置单元1000000、待访问100000；超限保留partial coverage与全部原始图；旧标签2无此预算）、`browserFieldSummary:2`、`fragmentValidation:1`、`fragmentTerminals:1`。这些不是完整事件schema、transport握手、平台支持或验证通过声明，未知标签需保持未知而不推断已采集能力。

会话可含固定大小的 `storageDiagnostic`，仅保存已报告错误的枚举分类、白名单name/code、phase、finalEvent和安全观察时间；不含原error.message/stack或业务内容。`quota_reported`、`abort_reported`等只说明信号，不证明实际根因。该字段不改变既有封存、原值和失败/未知语义，也不是业务质量判定；验证范围应以随release的实际报告为准，字段存在本身不表示测试或业务验收通过。

## 目录与版本

- `manifest.json`：`format: "logic-recorder"`、`version`（1 或 2）、`session`、事件及资源计数、`partial`、能力限制。`partial` 为真表示录制异常中断；非中断也不证明没有缺口。`session.coverage`、`session.gaps` 和事件中的失败状态应一并检查。
- `integrity.json`：除自身外每个 ZIP 文件的 `path`、展开字节数 `size` 和 SHA-256 `sha256`。校验不证明来源真实性。
- v1 事件为 `timeline/events.jsonl`；v2 由 `manifest.eventChunks` 指定有序的 `timeline/events-NNNNN.jsonl`。每行一个 JSON 事件。
- 部分较新的 v2 记录包还包含 `manifest.eventIndexChunks` 指定的 `indexes/events-NNNNN.jsonl`，每行索引一条原始事件，并以 `evidence.path` 和从 1 开始的 `evidence.line` 指向原始事件；索引中的关联仅为事件自身明确记录的标识。旧包可以没有这些文件，不能据此认定事件缺失。
- `manifest.relationshipChunks` 指向直接关系记录，例如截图到操作、资源引用、重定向和框架父子关系。`confidence: "recorded"` 表示关系来自事件字段，不表示操作与请求之间存在推断出的因果关系。
- `manifest.pageInstanceChunks` 按事件直接记录的标签、框架和文档标识汇总页面实例，包含观察到的网址、事件类别计数和可回查的事件位置；同网址不同文档不会合并。`pageInstanceUnassociatedCount` 是缺少完整身份而未归入实例的事件数量，其中可能包含网络和会话级事件，不能据此推断其所属页面。旧包可以没有此索引。
- `manifest.interfaceChunks` 按请求方法、来源和路径汇总实际观察到的接口，并保留浏览器记录的标签、协议框架、文档网址与样本证据；此上下文不是操作触发请求的因果证明。原始查询字符串和全部请求仍在原始事件与事件索引中，无法解析的地址计入 `interfaceUnindexableCount`。
- 部分较新的 v2 包在 `manifest.fieldObservationChunks` 中列出网络正文的字段观察文件。JSON 字段记录引用原始事件、正文位置、字段或数组位置及原始字符串的 UTF-16 偏移和长度；重复字段使用 `occurrence` 区分。`sample` 状态说明解析结果，不能把未解析正文或未观察字段当作不存在，也不能把观察类型当作完整接口契约。
- `parsed_form_urlencoded` 表示按请求的 `application/x-www-form-urlencoded` 内容类型以 UTF-8 表单规则解析；字段类型为 `string`，`formIndex` 是解码后的有序键值对下标，重复名称以 `occurrence` 区分。按事件或附件读取原始正文并解码后，通过下标核对值；该下标不是原始字节或字符偏移，不能据此推断数字等业务类型。非 UTF-8 字符集标记为 `unsupported_form_charset`，无效编码标记为 `invalid_form_encoding`，原始正文仍保留。
- `parsed_text` 表示声明为 UTF-8 或未声明字符集的 `text/plain` 正文，作为根路径的 `string` 整理；`offset` 和 `length` 是原始文本的 UTF-16 位置，不是附件字节偏移。声明的非 UTF-8 字符集标记为 `unsupported_text_charset`，保留原始正文并避免猜测字段。
- `parsed_query` 表示从原始请求 URL 整理的查询参数，`direction: "query"` 与请求体及响应体分开汇总；`queryIndex` 是解码后有序参数下标，重复名称以 `occurrence` 区分，类型为 `string`。按原始 URL 和下标核对参数值；该下标不是字符或字节偏移。无法按 UTF-8 解码时标记 `invalid_query_encoding`，原始 URL 仍保留。
- `parsed_xml` 表示以浏览器 XML 解析器整理的 UTF-8 或未声明字符集正文；`xml-element`、`xml-attribute` 和 `xml-text` 分别记录元素、属性和文本位置，带命名空间的名称以 `{命名空间}本地名称` 表示，同名项使用 `occurrence`。字段位置基于解析后的节点树，不是原文字节偏移；必须回查原始正文，不推断属性或文本的业务类型。`xml_field_limit`、`xml_depth_limit` 是整理缺口；`unsupported_xml_charset`、`xml_parser_unavailable`、`invalid_xml` 和 `xml_parser_error_or_ambiguous` 表示未能可靠整理。浏览器错误节点与合法同名节点可能有歧义，原文始终保留。
- 如果观察来源指定 `assetPath`，字段偏移基于该附件按 `decodedAs` 解码后的文本，而不是 ZIP 或附件字节偏移。附件必须经清单校验；无法按该编码解码时记录失败，不推测缺失字段。
- `manifest.fieldSummaryChunks` 汇总已关联接口的 JSON 与表单编码字段出现次数、出现过的样本数、类型和冲突；数组位置归并为 `arrayItem`，重复键按名称汇总，原始位置和每次出现仍以 `fieldObservationChunks` 为准。汇总包含可解析与总样本数，不表示必填性或完整契约。
- `manifest.browserObservationChunks` 整理 Cookie 属性、键值存储键以及 IndexedDB 图节点和字段类型。分段来源以 `fragmentCaptureId` 指向原事件的引用；重组失败会产生 `incomplete` 样本，不表示缺失字段不存在。数据库图的 `field-path` 在对象和数组字段上使用 JSON Pointer 转义规则；跨 Map 或 Set 的路径为 `null`，需按 `location` 中的 `key`、`mapEntry`/`part`、`setEntry` 逐步定位原始图。`cycle` 标记循环引用，`field-path-coverage` 表示路径整理不完整；`nodeId` 是图内标识。
- `manifest.browserFieldSummaryChunks` 按可证来源命名空间、数据库、仓库与路径汇总 IndexedDB 的观察记录数、类型和冲突，并给出部分原事件位置；完整逐条来源以 `browserObservationChunks` 为准。数组索引按实际位置保存；不能据此推断字段必填或未观察字段不存在。旧包可能不含此文件。
- `manifest.themeObservationChunks` 列出从计算样式整理的颜色属性、主题变量及部分背景相关属性，保留值、节点、采样时间和原始事件位置；复杂背景值是原始属性值，不代表已解析出的单个颜色或推断出的主题。
- `resources/index.json` 列出资源 `id`、`type`、`mime`。截图按 MIME 位于 `screenshots/<assetId>.png` 或旧记录的 `screenshots/<assetId>.jpg`，其他资源位于 `resources/<assetId>.bin`。只读取清单内已验证的条目；`.bin` 类型须看索引而不是猜扩展名。

## 事件

事件字段包括 `id`、`sessionId`、`seq`、`time`、`kind`、`payload`，并可能包含 `tabId`、`frameId`、`documentId`。时间是 Unix 毫秒；按 `time, seq` 查看，并保留 `seq` 作为后台接纳/提交顺序。幂等重试的既存事件不改序号，部分失败补写可在当前水位后获得新序号；空洞不单独证明丢失。它们不是跨页面或网络的严格因果时钟。

- `page.snapshot`：`payload.url`、`title`、`sourceHtml`、`sourceStatus`、`sourceLength`、`html`、`status`、`viewport`、样式/画布/组件覆盖信息。`sourceHtml` 不保证存在、不包含 Shadow DOM、动态属性外的表单值或原始 HTTP 字节；旧版无此字段。`html` 为受限快照，不是可直接运行的原站页面。
- `frame.tree` 记录浏览器枚举到的初始框架、父框架和文档标识；`navigation.committed` 记录后续框架导航与父子标识。`navigation.frameUnavailable` 表示录制期间观察到的范围外框架导航，`frameScopeGaps` 是初始范围外或出错框架及后续范围外导航的事件计数，同一框架多次导航可能被多次计数。框架列在树中不代表采集器一定注入成功，应结合对应 `frameId`、`documentId` 的页面事件和失败信息核对；授权范围外的框架不会提供页面内容。
- 较大的页面可通过 `sourceReference` 或 `htmlReference` 引用 `capture.fragment` 事件；按同一 `captureId`、`field` 和零起始 `index` 组合，并验证分段数、UTF-16 长度及最后的 `capture.fragmentEnd` 为 `confirmed`。缺段、重复、结束事件缺失或长度不符均表示不完整；不要把引用本身视作已经确认的页面。
- 较大的键值存储快照可以使用 `storageReference` 引用同样的分段协议；重组后的文本为包含 `stores`、`coverage` 和 `specialEntries` 的 JSON。采集采用轮询，不能证明两次采样之间没有短暂变化；`coverage` 为 `partial` 或 `unavailable` 时还存在其他缺口。
- 长输入的 `valueReference` 和可确认的 `beforeValueReference` 使用相同分段协议；事件中的 `value` 或 `beforeValue` 在此情况下只是前缀，完整性须核对分段和结束确认。
- 多选控件的 `formState` 或 `beforeFormState` 若标记 `fragmented`，其 `reference` 重组后为 JSON，包含选项、选中值和禁用状态；在确认所有分段前不要将其当作完整表单状态。
- 文件选择或拖入事件的 `files` 可包含 `contentReference`；将已确认分段拼接后按 Base64 解码，并核对文件大小与原始元信息。空文件以空 Base64 值记录；缺少结束确认或 `capture.fragmentFailure` 均表示文件内容不完整。
- `canvas.capture` 记录页面快照对应节点的 PNG 像素及尺寸，正文以 Base64 分段引用；须核对每项分段和 `canvas.captureEnd` 数量。`drawingContext: "unknown"` 和 `screenEquivalence: "unverified"` 表示无法确认绘制上下文或 PNG 与屏幕画面一致，尤其是 WebGL；`canvasContextUnknown` 统计此类结果。跨域污染、浏览器读取失败或缺少结束确认均是缺口；画布像素不提供绘图源码，也不能保证恢复 WebGL 绘制过程。
- `page.stylesheet` 以 `snapshotId` 与 `page.snapshot` 关联，`source` 和 `index` 表示文档、构造或导入样式表，导入样式表以 `parentIndex` 和 `parentRuleIndex` 指向父规则。`cssText` 是浏览器 CSSOM 返回的规则文本，保留其中的资源引用；`cssReference` 使用同一分段协议。CSSOM 文本可能经过浏览器规范化，不等于原始网络字节；不可读取的样式表标记为 `unavailable`。
- Shadow DOM 中的样式可通过 `source: "shadow"` 或 `"shadow-adopted"`、`shadowRootId` 和 `hostNodeId` 关联组件；浏览器不允许读取的根或样式仍可能缺失，须结合覆盖状态检查。
- `page.shadowRoot` 保存浏览器允许读取的 Shadow DOM 原始 `innerHTML`、根与宿主节点 ID、父 Shadow 根 ID、模式及采集时间；长内容使用 `reference` 分段。通过快照的 `shadowSourceCaptureId` 核对所有根和 `page.shadowRootEnd` 的数量、状态及分段确认。每个根在各自的 `observedAt` 读取，不能视作同一瞬间；分段原文可能包含脚本或外部地址，不能直接执行。
- `page.fonts` 记录浏览器字体集合中的家族、字重、样式和加载状态；`facesStatus: "fragmented"` 时需重组引用。FontFace 不直接提供源地址，系统字体也不会自动包含文件；需结合样式规则、网络事件和资源附件核对，不能凭名称断言字体文件已保存。
- `page.computedStyle` 按 `snapshotId` 和 `captureId` 分批记录节点、采样时间、矩形及元素和 `::before`、`::after` 的计算属性；`pseudos` 另包含适用的常见伪元素，`pseudoScope: "common_pseudos"` 不表示所有伪元素均已采样。需检查全部批次和对应的 `page.computedStyleEnd`。它们在各自的 `observedAt` 读取，不保证为快照产生时的同一瞬间；`skipped_busy`、缺批、未确认或节点不可读均是缺口。
- 若计算样式批次的 `entriesEncoding` 为 `gzip-base64-json-v1`，`entriesData` 需先 Base64 解码，再按 gzip 解压为 UTF-8 JSON 数组；检查 gzip 校验、`entriesBytes` 和 `entryCount`。可使用 `scripts/decode_computed_style.py` 从已校验的 SQLite 索引解码单批；旧记录可能直接包含 `entries`。
- `page.interactionStyle` 是指针进入、离开及焦点变化处理时读取的目标元素、`::before` 和 `::after` 计算样式；与对应操作通过 `interactionCaptureId`、节点和事件时间关联。采样时间代表实际读取时刻，不保证记录其他元素或交互结束后的状态；配对缺失、重复或读取失败计入 `interactionStyleGaps`。
- `page.interactionDescendantStyle` 为同一交互期间目标元素的普通 DOM 后代采样，按 `interactionCaptureId`、`rootNodeId` 和各自的 `observedAt` 关联；`page.interactionDescendantStyleEnd` 记录范围、采集数量、失败和截断。采集最多 25 个后代并受约 40 毫秒预算约束，不包含 Shadow DOM 后代或其他元素；`partial`、缺少结束记录、重复节点和读取失败计入 `interactionDescendantGaps`。不能据此推断未采样节点的样式。
- `page.mutation`：节点增删、属性及文本变化；`status` 非 `captured` 或找不到对应基线时，不能假设状态完整。`interaction.*` 保存操作目标、值、坐标、选项及可能的操作前值；采样、截断、脚本操作或浏览器关闭可能导致缺口。
- `page.mutation.rawChanges` 单独保留原始属性、文本及增删节点信息；长值或节点使用分段引用。节点序列化发生在 MutationObserver 回调时，可能已包含同批稍后变化，不能将其当作插入瞬间的精确快照。原始节点可能含脚本，不应直接执行。
- 页面和容器滚动记录包含位置、可见范围和 `eventCount`；大快照的 `scroll.reference` 需要按分段协议重组。`coverage: "rendered_only"` 表示只反映浏览器当时已渲染的内容，不能推断虚拟列表未加载的项目。
- `screenshot`：`payload.eventIds` 关联一个或多个事件；`assetId` 指向截图。`captureStartedAt`、`capturedAt`、`viewport`、`contextChanged` 和 `status` 用于判断时序与页面是否匹配。截图可能共用、缺失或发生在页面变化之后。
- `screenshot.fullPage` 是对顶层页面的一次整页截图尝试，关联 `snapshotEventId` 和 `snapshotId`；`capturePhase` 区分首次和停止时的尝试，旧记录可能没有该字段。截图只反映采集时浏览器已渲染内容。`captureMode: "tiles"` 时按 `captureId` 查找 `screenshot.fullPageTile`，核对每片序号、范围、像素尺寸、附件和 `capturedTiles`/`totalTiles`；各片具有各自的采集时间，不能假定为同一瞬间。`partial`、`unavailable`、缺片或缺少结束记录表示截图不完整。
- `network.request`、`network.requestBody`、`network.response`、`network.finished`、`network.failed`、`network.incomplete` 以 `payload.requestId` 关联。请求体可能后补，响应体通常在结束事件的 `payload.body`；`redirectFrom` 关联重定向。缺少结束状态、`network.incomplete` 或未取得 HTTP 状态不等于成功。请求来源线索包括 `documentUrl`、`sourceFrame` 和 `protocolSessionId`。
- 较新网络事件可包含 `protocolRequest`、完整 `initiator`、`protocolResponse`、协议时间及 `protocolDetails`。`postDataEntriesStatus: "pending"` 时须通过请求标识查找 `network.requestDataEntries`，按条目顺序读取和核验附件；这些条目仅是浏览器实际提供的部分，不能保证包含所有文件内容。
- `network.requestExtraInfo` 和 `network.responseExtraInfo` 保存浏览器提供的额外请求头、响应头及 Cookie 相关协议数据；以 `protocolRequestKey` 关联协议请求组。重定向可能复用该标识，`correlation: "protocol_id_only"` 不表示已经确认具体跳转段。范围无法确认时记录 `network.extraInfoGap`。
- 响应或 WebSocket 二进制可能以 `encoding: "base64"` 保存；`textStatus` 可能标识文本无法解码或超限。检查内容类型、状态及原始事件；不能将 Base64 字符串当作已解析文本。
- 长 WebSocket 帧和 EventSource 消息的 `data.status: "pending_asset"` 通过 `captureId` 关联 `network.realtimePayload`。只有存在唯一的 `captured_asset` 结果并通过完整性校验时，才能读取其 `assetId`；附件 `representation: "json-string-utf8"` 是 JSON 字符串，解析后得到浏览器提供的原始文本，若 `encoding: "base64"` 还需再解码为二进制。缺失结束记录、失败或重复记录须作为缺口。
- 大响应可能以 `captured_asset` 存在 `resources/<assetId>.bin`，以事件 `body.representation` 区分浏览器提供的字节和浏览器解码后重新编码的文本；后者不能当作原始网络字节。资产大小及哈希须按完整性清单核验。
- 大请求正文也可能由 `network.requestBody` 的 `body.assetId` 引用资源附件。浏览器可省略 multipart 中的文件内容；即使该正文附件存在，也应检查记录中的 `requestBodyLimitations` 或 `fileContent`，不能据此认定文件已完整保存。
- `cookie.initial`、`cookie.change`、`storage.snapshot`、`database.snapshot`、`cache.snapshot`、`state.capture` 反映可观察状态，不代表所有时刻或所有存储内容；Cookie 变化可能仅能确认同域范围。
- `cookie.partitionSnapshot` 记录浏览器提供的框架分区键及该分区可读取的 Cookie；浏览器不支持分区查询、框架变化或权限不足时状态为 `unavailable`。框架和分区之外的 Cookie 不能推断已采集。
- `cache.entry` 以 `snapshotId`、缓存名和序号关联缓存快照，包含浏览器可读的请求头、响应头和 Base64 正文字节；正文分段引用需要检查结束确认并按 Base64 解码，字节数须与 `body.size` 一致。`opaque`、`timeout`、`unavailable` 和 `cache.entryFailure` 表示内容可能缺失。
- `cache.catalog` 记录某次采样时浏览器返回的完整缓存名称列表，长列表通过 `reference` 分段；按 `catalogId` 核对 `cache.catalogEnd`、每个 `cache.snapshot` 的 `catalogIndex` 和数量。比较不同采样目录可判断两次观察到的缓存名称变化，不能推断两次采样之间的全部变化；未完成或不可读取的目录不能当作空列表。
- `database.catalog` 记录浏览器某次枚举返回的数据库名称和版本，长列表通过 `reference` 分段；按 `catalogId` 核对 `database.catalogEnd` 以及每个 `database.snapshot` 的 `catalogIndex`。空目录必须具有完成记录才能与枚举失败或采集中断区分；比较不同目录只能确认采样时观察到的变化。
- `database.snapshot` 可通过 `graphCaptureId` 关联 `database.record` 和 `database.recordsEnd`。记录的 `graph` 或经分段重组的 `graphReference` 使用图结构：`root` 和节点 `id`/`ref` 保留循环及共享引用，`array-buffer`、`blob` 和 `file` 的 Base64 数据可重组为字节，视图另记底层缓冲引用与偏移。先检查结束事件、数量、`issues` 和分段确认；`consistency: "batched_non_atomic"` 表示分批读取可能跨越数据库更改，不能当成同一时刻的原子快照。
- `database.storeScan` 对比初始事务的对象仓库记录数与分批扫描数量；数量一致也不能排除同数量的增删或值变更，不一致或无法读取时属于缺口。
- `resource.initial` 及带 `assetId` 的 `network.finished` 关联资源；同地址可能在不同页面实例、标签或时间返回不同内容。结合来源、导航及时间选择，无法确认时标明歧义。
- `resource.loaded` 是录制开始时从 Chrome 已加载资源目录读取的样式、字体或图片，包含协议框架 ID、加载器 ID 和读取状态；`resource.loadedSummary` 记录读取失败及预算内未完成的数量。`browser-provided-bytes` 表示浏览器提供的字节，`browser-decoded-text-utf8` 表示浏览器解码文本后保存的 UTF-8，不能将后者当作原始网络字节。目录中列出资源不保证浏览器仍允许读取，关联到具体扩展文档时应保留不确定性。
- `warning`、`navigation.out_of_scope`、各种 `unavailable`、`omitted_*`、`truncated`、超时及 `session.coverage` 表示潜在缺口。单条记录标记成功不代表整个会话完整。

## SQLite 索引

索引表 `events` 保留完整 `event_json`，并提供 `id`、`seq`、`time`、`kind`、`tab_id`、`frame_id`、`document_id`、`url`、`request_id`、`chunk`、`line`；`files` 包含经校验的 ZIP 路径、大小、哈希；`metadata` 保存原始清单。事件中无相应字段时索引值可能为 `NULL`。原 ZIP 未改动，`chunk` 和 `line` 可定位原始证据。

用 Python 标准库查询，避免依赖 SQLite 命令行：

```python
import json, sqlite3
db = sqlite3.connect("recording-index.sqlite3")
for event_id, kind, raw in db.execute(
    "SELECT id, kind, event_json FROM events "
    "WHERE kind IN ('page.snapshot','interaction.click','network.request') "
    "ORDER BY time, seq LIMIT 100"
):
    event = json.loads(raw)
    # 按需检查 event；输出和索引可能包含原始凭据。
```

查询请求链示例：

```python
for event_id, kind, raw in db.execute(
    "SELECT id, kind, event_json FROM events WHERE request_id = ? ORDER BY time, seq",
    ("<recorded-request-id>",),
):
    event = json.loads(raw)
```

通过截图事件的 `payload.eventIds` 回查操作。需要资源时使用 `zipfile.ZipFile.open` 读取索引中的确切路径，重新计算展开大小及 SHA-256 并与 `files` 表比较，核验完成后才能使用或保存；索引生成后 ZIP 可能已被替换。只按用户指定位置保存需要的条目，不要直接执行 HTML 或向原站发起请求。
