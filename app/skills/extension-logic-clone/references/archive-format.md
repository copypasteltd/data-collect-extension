# 记录格式、校验与查询

先检查包内清单。`version:3, profile:business-flow-v1` 对应插件v0.4.0轻量业务格式；v1/v2走[历史格式](legacy-v1-v2.md)。Chrome扩展安装包／完整release的manifest不是记录manifest，不能拿它建立记录索引。

## v3目录与引用

```text
manifest.json                  批次、范围、策略、容量、封存及内容列表
integrity.json                 除自身外所有文件的展开大小和SHA256
timeline/events-00001.jsonl     按清单顺序读取的原始观察事件
contents/<sha256>.bin           同会话相同字节只保存一次
```

清单核心：`format:"logic-recorder"`、`version:3`、`profile:"business-flow-v1"`、`derivations:"none"`、`session`、`eventCount`、`contentCount`、有序连续`eventChunks`、`contents`、`capturePolicy`和`budget`。当前插件还写`partial`、`byteAccounting`与`capabilities`。格式版本不是producerVersion；producer版本在`session.producerVersion`，缺失不从文件名补造。

`contents`项为`{contentId,path,size,sha256,mime,category}`，ID为`session.id + ":" + sha256`，路径精确为`contents/<64位小写hash>.bin`。原值按字段顶层引用：

```json
{
  "kind": "page.snapshot",
  "payload": {
    "sourceHtml": {
      "contentId": "<session-id>:<sha256>",
      "sha256": "<sha256>",
      "size": 123,
      "mime": "text/html;charset=utf-8",
      "category": "dom",
      "status": "captured"
    }
  }
}
```

只将这个完整schema的payload顶层对象解释为内容引用；普通业务对象或正文嵌套`contentId`不递归猜作引用。类别为body/dom/resource/screenshot/meta。同hash可在不同用途记录不同MIME和类别，清单是首次内容的元信息；实际用途以该事件引用为准。零字节captured是有效空内容，不能等同未采；反之policy/unavailable/缺引用不能当空值。

## 索引器保证和限界

```text
python <skill>/scripts/index_archive.py <recording.zip> --output <new.sqlite3>
```

- 标准库执行；只读ZIP，不解压所有文件、不执行内容。索引路径必须不存在。
- 拒绝重复/越界/穿越/加密条目、缺清单、重复JSON键、非有限值、配置资源限额；校验integrity覆盖、实际展开size/SHA256、v3内容清单及全部明确引用。
- v3事件必须匹配session、唯一ID、有效顺序/时间，按原分块保留证据路径和从1起行号。JSON数值不能用bool冒充计数。`seq`是接纳顺序，`time`是各端采样时间，不是跨页严格因果时钟。
- 当前包有`byteAccounting`时，核对实际JSONL字节（含换行）＋唯一内容字节与账本；有seal时核计数/水位和唯一末尾stop。缺少这些可选字段的早期最小v3包不补造验证结果。读取器核对声明内部一致，不能据此认证采集器实际执行或所有网页都已采到。
- 新索引`metadata.archive_identity`绑定整个ZIP字节的SHA256/size。后续提取仍重核身份、源事件和内容；`mode=ro`本身不证明任意SQLite可信。
- 标准输出仅verification/计数/范围状态摘要，不输出正文；通过只证明随包一致，不证明签名、真实性、全覆盖或业务验收。

索引CLI大小参数为十进制MB：`--max-archive-mb 2048`、`--max-entry-mb 512`、`--max-expanded-mb 8192`；这是兼容旧包的读取资源上限，不是当前插件64MiB的采集预算。超限先核格式/大小/任务价值，不自动放宽为无界。

## SQLite：先读轻索引，再按需取内容

| 表 | 内容 |
| --- | --- |
| metadata | 原manifest、源ZIP身份；不从当前浏览器补信息 |
| events | id/seq/time/kind/tab_id/frame_id/document_id/url/request_id/chunk/line/event_json |
| files | 每个integrity验证文件的path/size/sha256（不含integrity自身） |
| contents | content_id/path/size/sha256/mime/category，字节仍在ZIP |
| content_refs | event_id/field/content_id/mime/category，保留多次观察的实际用途 |

用Python标准库和参数化查询，无需安装sqlite CLI；数据连接只读：

```python
from contextlib import closing
from pathlib import Path
import json, sqlite3
with closing(sqlite3.connect(Path("recording.sqlite3").resolve().as_uri()+"?mode=ro", uri=True)) as db:
    manifest = json.loads(db.execute(
        "SELECT value_json FROM metadata WHERE key=?", ("manifest",)).fetchone()[0])
    rows = db.execute(
        "SELECT id,seq,time,kind,tab_id,frame_id,document_id,chunk,line "
        "FROM events WHERE kind IN (?,?,?,?,?) ORDER BY seq LIMIT 100",
        ("ui.input","ui.change","page.snapshot","recorder.notice","network.response"))
    for row in rows:
        pass  # 只展示本任务需要的统计/证据，不整库打印原值。
    refs = db.execute(
        "SELECT r.field,c.path,c.size,c.sha256,r.mime,r.category FROM content_refs r "
        "JOIN contents c ON c.content_id=r.content_id WHERE r.event_id=?", ("<event-id>",)).fetchall()
```

## 取v3内容

```text
python <skill>/scripts/read_content.py <recording.zip> <recording.sqlite3> --event-id <id> --field sourceHtml --output <new.html>
python <skill>/scripts/read_content.py <recording.zip> <recording.sqlite3> --event-id <id> --field image --output <new.png>
python <skill>/scripts/read_content.py <recording.zip> <recording.sqlite3> --content-id <session:sha256> --output <new.bin>
```

`--field`是payload字面顶层key，不是JSON Pointer：`formValue2`正确，`/payload/formValue2`不是这个工具的语法。字段含`/`或`~`时传原字段名；普通嵌套对象不提取。长forms值先读同事件forms[].value.field，转到payload该字段。通过content-id读取只证明该内容存在，不自动证明它属于某步骤；步骤关联优先按event-id+field读取。

工具默认最多读取128MiB ZIP、72MiB展开、64MiB单次输出（参数以字节计）；再核ZIP身份/manifest、源分块位置/event及文件hash，只写新输出。不会自动Base64解码、猜文本编码、执行HTML或打开网络。二进制和空内容保持原字节；若需解码文本，先确认该引用MIME/表示，严格UTF-8失败则保字节及未知编码。

## 能力与缺口分开判断

先读`session.scope`、`capturePolicy.notCollected`、`capabilities`，再读`session.coverage`、`session.stopOutcome`、`budget.policyStopped/reason`、`partial`及逐事件bodyStatus/policies。默认不采全计算样式、Cookie快照、全库/缓存/Storage、全页PNG/Canvas独立像素、所有上传与实时帧正文，不产生派生字典；不能以文件缺少推断损坏或要求补扫。

64MiB总、48MiB警告、63MiB普通接纳＋1MiB收尾；body24/DOM16/resource8/screenshot12/meta4MiB，单body2MiB，是插件声明的保存策略，不是ZIP或内存上限。类别复用的计费与物理去重不同。预算拒绝、已知不可读、未知ACK、实际I/O失败、未访问分支应分别说明。`partial:false`不覆盖coverage或事件明确缺口，`ready`不等业务完整。

事件字段和正确关联见[新版事件](business-flow-v3.md)；只有用户要构建时才读[复建](reconstruction.md)。
