# 更新说明 / Changelog

所有日期采用 `YYYY-MM-DD`。行为变更应同时更新中英文 README、相关文档及可能受影响的演示素材。<br>
Dates use `YYYY-MM-DD`. Update both READMEs, relevant documentation, and affected demo media whenever behavior changes.

## Unreleased / 未发布

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
- 某些 Windows 环境中，长端到端测试重启浏览器可能超时；可同时运行独立恢复测试并检查日志。 / The long end-to-end test can time out restarting Chrome on some Windows setups; also run the dedicated recovery test and inspect its output.
