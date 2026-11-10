# 更新说明 / Changelog

所有日期采用 `YYYY-MM-DD`。行为变更应同时更新中英文 README、相关文档及可能受影响的演示素材。<br>
Dates use `YYYY-MM-DD`. Update both READMEs, relevant documentation, and affected demo media whenever behavior changes.

## Unreleased / 未发布

- 操作记录新增文档内元素标识，页面还原及逐步复现核对目标与选项身份，避免将旧状态套用到替换或不唯一的控件；旧记录无法确认时给出提示。 / Record document-local element IDs and validate target and option identity during page restoration and step replay, reporting cases that cannot be confirmed in older recordings.
- 接口规范草稿保留每次请求的完成、失败或未完成状态，区分未取得状态码的占位响应；修正字面花括号路径及规范化后相同接口的样本合并。 / Preserve finished, failed, incomplete, and unrecorded request outcomes in API draft evidence, label missing-status placeholders, and merge samples for equivalent normalized paths with literal braces.
- 收到截图期间的标签切换通知时，即使切回原标签也放弃截图并记录原因；修复截图测试使用旧数据库版本的问题。 / Discard screenshots when a tab switch is observed during capture even if the original tab is restored, and fix screenshot tests opening the old database version.
- 校验后的导入包自动保存到本机记录，可在浏览器重启后查看、原样下载或删除；保存失败仍可临时查看并提示。 / Persist validated imported archives locally for viewing, unchanged download, or deletion after restart; preserve the current view and report local storage failures.
- 逐步复现结束时检查已记录的标签关闭事件，避免将已关闭标签的旧快照展示为最终页面。 / Check recorded tab closures at the end of step replay instead of presenting a closed tab's old snapshot as the final page.
- 下载记录包时检查当前导入器的体积、目录和事件限制，对无法导入的包明确提示原因，同时保留下载备份。 / Check archive size, directory, and event limits on export, explaining when the current importer cannot read a package while retaining backup downloads.
- 查看或导入记录时，在采集报告中指出缺少结束事件的已保存请求并链接到原始记录；实际请求结果未知。 / Report saved requests without an outcome when viewing or importing recordings, with links to their original events; their actual network result remains unknown.
- 停止录制时逐条标记尚在进行的请求，并区分请求已完成但响应采集未完成；侧边栏报告和记录包保留提示。 / Mark each request still in progress at recording stop, distinguish completed requests with unfinished response capture, and retain these notices in the side-panel report and archive.
- 后台重启后，尝试恢复页面实例及来源仍可确认的跨进程框架 WebSocket；已导航、失效或范围外的连接继续跳过。 / Resume cross-process frame WebSockets after worker restart when the document and origin can be verified; continue skipping navigated, invalid, or out-of-scope connections.
- 后台重启时重新核验已授权的跨进程框架连接和当前网址，继续采集可确认框架的后续网络请求；无效或范围外连接不会恢复。 / Revalidate previously authorized cross-process frame connections and current URLs after a worker restart, resuming eligible network capture while rejecting invalid or out-of-scope connections.
- 录制后台重启后，尝试恢复此前已授权且页面实例仍可确认的顶层调试会话 WebSocket 消息采集；无法确认来源或页面身份的连接继续跳过。 / Resume WebSocket capture after worker restart for previously authorized root-session connections with a confirmed current document; continue skipping unverified origins or documents.
- 录制后台重启后尝试恢复已保存的进行中网络请求及响应关联；未完成的请求体读取标记为不可用，并提示重启期间可能缺失的事件。 / Restore saved in-flight network request context after a recording worker restart, mark unfinished request-body reads unavailable, and report potential gaps during the restart.
- 按请求发起时的页面和导航上下文关联接口事件，避免跳转、刷新后把旧页面或延迟响应误关联到其他页面；无法确认时显示提示。 / Associate network events with the page and navigation context at request initiation, avoiding stale-page or delayed-response mismatches and reporting unknown context.
- 扩展缓存开始和结束快照，记录有限的缓存请求地址、方法和模式，并提示超限、超时及不可读取；不采集缓存响应正文。 / Capture bounded cached-request URLs, methods, and modes in start/end snapshots, reporting limits, timeouts, and read failures without collecting response bodies.
- 数据库快照现在能够以类型标记保存大整数、映射、集合等复杂值；二进制、循环引用和超限数据标记缺口，并在录制列表及报告中提示。 / Database snapshots now encode complex values such as big integers, maps, and sets with type tags; binary, circular, and over-limit data are flagged in the recording list and report.
- 修复较长页面及组件正文被替换为占位文字的问题；单个文本节点超限时保留前缀，并在录制列表标记快照截断或缺失。 / Preserve longer page and component text in snapshots, keep a truncated prefix when a text node exceeds its limit, and flag incomplete snapshots in the recording list.
- 改进网址片段中常见敏感名称的识别，覆盖一次百分号编码，并处理页面快照中视频封面地址；命中时隐藏整个片段。 / Improve detection of common sensitive names in URL fragments, including percent-encoded forms and video poster URLs in snapshots; matching fragments are hidden in full.
- 修复多个停止请求并发时，后来的请求可能错误中断正在整理的录制；真正的收尾失败仍标记异常中断。 / Prevent concurrent stop requests from interrupting an ongoing finalization; genuine finalization failures remain marked as interrupted.
- 修复页面和组件中较大的可读取样式被替换为占位内容、导致侧边栏回看丢失样式的问题；超过单个样式上限时标记截断。 / Preserve larger readable page and component styles in snapshots instead of replacing them with a placeholder; flag styles that exceed the per-style limit.
- 补充匹配 Playwright 浏览器版本的安装和测试说明，避免 `CHROME_BIN` 意外覆盖；完整端到端流程已在匹配版本上通过一次。 / Document installation and testing with the matching Playwright browser and how to avoid an unintended `CHROME_BIN` override; the full end-to-end flow passed once with the matched version.
- 支持对浏览器以 Base64 返回的可识别文本响应按声明字符集解码后脱敏；对于编码或内容无效、超限或声明非空但返回为空的响应显示采集提示。 / Decode and redact recognized Base64 text responses using the declared charset; report invalid encodings or content, oversized responses, and inconsistent empty responses.
- 修复当前站点模式可能记录同主机其他端口嵌入页面的请求、WebSocket 消息和对话框的问题；对来源不明的连接给出采集提示，并标明 Cookie 变更的来源不可确认。 / Restrict same-host cross-port embedded-page requests, WebSocket messages, and dialogs in current-site mode; report unconfirmed connection origins and label cookie changes with unconfirmed sources.
- 避免将同一毫秒的截图误判为操作前画面；页面实例、网址或截图时序无法确认时不再标示近似操作位置，并提供相应提示。 / Avoid treating same-millisecond captures as pre-action images; hide approximate target markers when document identity, URL, or timing is unconfirmed, and explain why.
- 页面持续变化时，为合并快照设置约 2 秒的最长等待时间；页面离开时尝试保存待处理快照，减少页面状态遗漏。 / Bound snapshot debouncing to about two seconds during continuous page changes and attempt pending snapshots when leaving a page.
- 修复 `sessionStorage` 整体被隐藏及停止前短暂存储变更可能遗漏的问题；分别报告存储不可读、键数量和单值超限，并保留特殊键。 / Preserve non-sensitive `sessionStorage`, sample storage when stopping or leaving a page, report inaccessible and oversized storage, and retain special keys.
- 普通文本输入及操作前值的上限由 4,000 提升至 10,000 个 UTF-16 代码单元；超限时在采集报告、页面还原和逐步复现中提示，并在录制列表中标记采集提示。 / Increase the ordinary input and prior-value limit from 4,000 to 10,000 UTF-16 code units; report truncation in capture reports, page restoration, step replay, and the recording list.
- 修复逐步复现在缺少页面快照时无法输入多行文本的问题。 / Fix multiline input during step replay when a page snapshot is unavailable.
- 修复高度重复的合法页面记录包因压缩比过高而无法导入的问题；仍限制单文件与累计展开大小并校验实际解压量。 / Allow highly compressible legitimate recordings to be imported while retaining per-file and total expanded-size limits and checks on actual output.
- 下载记录包、页面清单或接口草稿时等待浏览器的最终结果；下载中断或状态不可确认时显示错误，并清理下载资源。 / Archive, catalog and API draft exports now wait for the browser's final download state, report interruption or an unknown status, and release download resources.

## 0.1.0 - 2026-11-10

### 新增 / Added

- Chrome Manifest V3 侧边栏录制、停止、本机记录管理、ZIP 导出和导入。 / Manifest V3 side-panel recording, stopping, local record management, ZIP export, and import.
- 已授权页面的操作、快照、页面变化、网络证据、截图及部分站点状态采集；提供采集缺失和异常中断提示。 / Best-effort capture of authorized actions, snapshots, DOM changes, network evidence, screenshots, and limited site state, with gap and interruption reporting.
- 侧边栏时间线、页面、流程、接口、报告及逐步复现；支持隔离页面操作和基于样本的 OpenAPI 草稿。 / Side-panel timeline, pages, flows, APIs, reports, step replay, isolated page interaction, and sample-derived OpenAPI drafts.
- 页面对资源、页面实例及截图时间的谨慎关联；尝试隐藏常见敏感字段并遮挡可识别的敏感截图区域。 / Conservative resource, page-instance, and screenshot timing association, with best-effort redaction and masking.
- 中英文 README、安装说明、需求与技术文档、可复现的模拟数据演示、截图、GIF 和视频。 / Chinese and English READMEs, usage, requirements and technical documents, and reproducible synthetic-data demo screenshots, GIF, and video.

### 已知限制 / Known Limits

- 这是开发验证版；不能保证完整采集、还原未访问分支、执行原站脚本或重建服务端逻辑。 / Development preview: complete capture, unvisited branches, original scripts, and server-side reconstruction are not guaranteed.
- 自动脱敏并不完整，ZIP 默认不加密；分享前必须检查。 / Redaction is incomplete and ZIP files are not encrypted by default; inspect them before sharing.
- 当前 Windows 测试环境曾出现扩展后台启动或长端到端测试重启浏览器超时，原因未完全确定；可同时运行相关独立恢复测试并检查日志。 / Extension-worker startup or browser restart during the long end-to-end test has occasionally timed out in the current Windows environment; the cause remains unclear. Run the relevant recovery tests and inspect the output.
