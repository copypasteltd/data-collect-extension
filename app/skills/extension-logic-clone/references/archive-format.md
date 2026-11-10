# 逻辑记录包：格式和证据

## 目录与版本

- `manifest.json`：`format: "logic-recorder"`、`version`（1 或 2）、`session`、事件及资源计数、`partial`、能力限制。`partial` 为真表示录制异常中断；非中断也不证明没有缺口。`session.coverage`、`session.gaps` 和事件中的失败状态应一并检查。
- `integrity.json`：除自身外每个 ZIP 文件的 `path`、展开字节数 `size` 和 SHA-256 `sha256`。校验不证明来源真实性。
- v1 事件为 `timeline/events.jsonl`；v2 由 `manifest.eventChunks` 指定有序的 `timeline/events-NNNNN.jsonl`。每行一个 JSON 事件。
- `resources/index.json` 列出资源 `id`、`type`、`mime`。截图位于 `screenshots/<assetId>.jpg`，其他资源位于 `resources/<assetId>.bin`。只读取清单内已验证的条目；`.bin` 类型须看索引而不是猜扩展名。

## 事件

事件字段包括 `id`、`sessionId`、`seq`、`time`、`kind`、`payload`，并可能包含 `tabId`、`frameId`、`documentId`。时间是 Unix 毫秒；按 `time, seq` 查看，并保留 `seq` 作为采集序号。它们不是跨页面或网络的严格因果时钟。

- `page.snapshot`：`payload.url`、`title`、`sourceHtml`、`sourceStatus`、`sourceLength`、`html`、`status`、`viewport`、样式/画布/组件覆盖信息。`sourceHtml` 不保证存在、不包含 Shadow DOM、动态属性外的表单值或原始 HTTP 字节；旧版无此字段。`html` 为受限快照，不是可直接运行的原站页面。
- `page.mutation`：节点增删、属性及文本变化；`status` 非 `captured` 或找不到对应基线时，不能假设状态完整。`interaction.*` 保存操作目标、值、坐标、选项及可能的操作前值；采样、截断、脚本操作或浏览器关闭可能导致缺口。
- `screenshot`：`payload.eventIds` 关联一个或多个事件；`assetId` 指向截图。`captureStartedAt`、`capturedAt`、`viewport`、`contextChanged` 和 `status` 用于判断时序与页面是否匹配。截图可能共用、缺失或发生在页面变化之后。
- `network.request`、`network.requestBody`、`network.response`、`network.finished`、`network.failed`、`network.incomplete` 以 `payload.requestId` 关联。请求体可能后补，响应体通常在结束事件的 `payload.body`；`redirectFrom` 关联重定向。缺少结束状态、`network.incomplete` 或未取得 HTTP 状态不等于成功。请求来源线索包括 `documentUrl`、`sourceFrame` 和 `protocolSessionId`。
- 响应或 WebSocket 二进制可能以 `encoding: "base64"` 保存；`textStatus` 可能标识文本无法解码或超限。检查内容类型、状态及原始事件；不能将 Base64 字符串当作已解析文本。
- `cookie.initial`、`cookie.change`、`storage.snapshot`、`database.snapshot`、`cache.snapshot`、`state.capture` 反映可观察状态，不代表所有时刻或所有存储内容；Cookie 变化可能仅能确认同域范围。
- `resource.initial` 及带 `assetId` 的 `network.finished` 关联资源；同地址可能在不同页面实例、标签或时间返回不同内容。结合来源、导航及时间选择，无法确认时标明歧义。
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
