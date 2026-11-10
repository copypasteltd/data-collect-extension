# 逻辑记录 | Logic Recorder

**在 Chrome 侧边栏记录已授权的网页操作，并把观察到的页面、请求和状态整理为可分享的本地档案。**

[English](README.en.md) · [安装与使用说明](docs/插件安装与使用说明.md) · [技术开发文档](docs/Chrome扩展技术开发文档.md) · [需求文档](docs/Chrome扩展需求梳理.md) · [更新说明](docs/CHANGELOG.md)

> 当前版本为 **0.1.0 开发验证版**。它记录用户实际走过的路径，不能保证采集所有浏览器行为、还原未访问的分支，或自动重建原站的源码和服务端逻辑。请先阅读[能力边界](#能力边界)与[数据安全](#数据安全)。

## 演示

![从录制到侧边栏复现的演示](docs/media/workflow.gif)

[观看 MP4](docs/media/workflow.mp4) · [观看 WebM](docs/media/workflow.webm) · [素材与生成方式](docs/DEMO.md)

演示使用本地虚构客户数据和隔离的测试浏览器；测试环境预先授予了示例站点权限。实际使用时 Chrome 会请求相应授权。扩展的录制、查看、导入、流程、接口和复现界面均在**侧边栏**内，不需要独立应用页面。

| 准备录制 | 操作与候选请求 | 页面复现 |
| :---: | :---: | :---: |
| <img src="docs/media/01-ready.png" width="220" alt="侧边栏录制设置"> | <img src="docs/media/05-flow.png" width="220" alt="侧边栏中的操作流程和候选请求"> | <img src="docs/media/06-replay.png" width="220" alt="侧边栏中的隔离页面复现"> |

[录制中](docs/media/02-recording.png) · [记录列表](docs/media/03-history.png) · [时间线](docs/media/04-timeline.png) · [示例站点](docs/media/sample-site.png)

## 适用场景

- 留存已授权业务流程的操作路径、页面状态和请求证据，方便交接、排查或分析。
- 在另一台机器导入 ZIP，按时间查看已观察到的页面、操作、网络信息和采集提示。
- 在侧边栏按步骤查看截图，或在隔离页面快照中尝试点击、输入和选择已记录的目标。
- 从观察到的接口样本导出 OpenAPI 草稿，作为进一步核对请求规范的起点。

## 快速开始

**环境：** Chrome 125 或更高版本；构建需要 Node.js 20 或更高版本和 npm。浏览器自动化测试需要 Playwright Chromium 或 `CHROME_BIN` 指向的兼容 Chrome/Chromium。当前主要在 Windows 环境验证；其他桌面平台应自行验证扩展加载及截图行为。

```bash
git clone git@github.com:copypasteltd/data-collect-extension.git
cd data-collect-extension/app
npm ci
npm run build
```

1. 在 Chrome 打开 `chrome://extensions`，开启右上角的“开发者模式”。
2. 选择“加载已解压的扩展程序”，选择本仓库的 **`app/dist`** 目录。`dist` 由构建生成，不在 Git 中提交。
3. 打开需要记录的 HTTP 或 HTTPS 页面，点击扩展图标，打开侧边栏。
4. 选择录制范围，按需开启截图或非认证 Cookie 值，确认授权说明并点击“开始录制”；在 Chrome 权限提示中授权。
5. 等待“录制中”，执行业务流程。需要初始加载请求时，在开始后刷新或重新进入页面。
6. 点击“停止录制”，等待整理完成；在“录制记录”中查看，或点击下载图标导出 ZIP。
7. 接收方加载相同扩展后，在侧边栏选择“导入记录包”。查看、复现和导出均在侧边栏完成。

导出时请保持侧边栏打开，直至浏览器下载完成；下载中断会显示错误，可重新下载。

源码修改并重新构建后，在 `chrome://extensions` 中刷新扩展。完整说明及异常恢复见[安装与使用说明](docs/插件安装与使用说明.md)。

## 工作方式

```text
已授权网页与框架
  ├─ 内容脚本：操作、页面快照 / DOM 变化、滚动、站点存储
  ├─ Chrome Debugger：请求 / 响应、重定向、WebSocket、EventSource
  └─ Cookies / 截图 API：可选 Cookie 值、带敏感区域遮挡的截图
                 ↓
后台任务协调、限制与脱敏 → 扩展本机 IndexedDB → 分段 ZIP + SHA-256 清单
                 ↓
侧边栏导入 / 时间线 / 页面 / 流程 / 接口 / 报告 / 逐步复现
```

### 采集范围

| 模块 | 当前实现 |
| --- | --- |
| 录制范围 | 当前站点及其新标签，或经授权的所有 HTTP/HTTPS 页面；受限页面不会被记录。 |
| 页面与操作 | 点击、输入、选择、提交、键盘、指针、焦点、滚动、拖放及部分剪贴板事件；页面快照和 DOM 变化尽力记录，支持部分开放及关闭式 Shadow DOM。剪贴板内容不保证保存。 |
| 截图 | 按操作尝试截图并遮挡可识别的敏感区域；记录捕获时序、共享或失败状态。连续操作可能共用截图。 |
| 网络 | 记录可观察的请求、响应、重定向和部分请求/响应体；WebSocket 文本和 EventSource 消息尽力采集，二进制与超限内容可能不保存。 |
| 站点状态 | 记录 Cookie 元数据和变化；非认证 Cookie 值需显式开启。`localStorage` / `sessionStorage` 按秒轮询，并在停止或页面离开时补采；站点 IndexedDB 仅做有限的开始/结束快照，Cache Storage 仅记录名称。 |
| 资源 | 尝试保存录制中收到的图片、WOFF/WOFF2 字体和可取得的样式；录制开始前已加载图片仅尝试生成受跨域限制的静态 PNG 预览。 |
| 复现与分析 | 截图或隔离页面逐步复现；流程中的候选请求按页面范围和时间推测，可打开证据；OpenAPI 为基于样本的草稿。 |

“当前站点”按协议、主机和端口限定；新标签跨越该来源后不属于这一录制范围。
网络请求按发起页面的来源判断范围：当前页面发出的跨域接口请求仍会尝试记录，范围外嵌入页面发出的请求不会记录；来源无法确认时会跳过并提示。WebSocket 使用握手中的页面来源核验；录制前已建立且来源无法确认的连接可能被跳过。
Cookie 由浏览器按域共享，不区分端口；Cookie 变更事件无法可靠确认发起页面，可能包含同域其他端口产生的变化。旧版记录可能包含范围外嵌入页面的数据，分享前请检查。
对浏览器以 Base64 返回的可识别文本响应，插件尝试按声明字符集解码（未声明时使用 UTF-8）后脱敏；无法解码、超限或响应长度与返回内容明显不一致时，会在报告中提示。
页面持续变化时，快照采集会尽力在约 2 秒内执行一次，避免持续更新使快照长期推迟；页面离开时也会尝试保存待处理快照。浏览器节流、页面繁忙或页面销毁仍可能导致状态延迟或遗漏。
普通文本输入及其操作前值最多记录 10,000 个 UTF-16 代码单元；超限时保存前缀并在报告和复现中提示。早期记录可能已在 4,000 个代码单元处截断且没有标记。
每种网页存储最多读取 200 个键，非敏感值超过 4,000 个 UTF-16 代码单元时不保存原值；超限或不可读会在报告中提示。轮询间的短暂变化仍可能遗漏，旧版记录中被隐藏的会话存储无法恢复。
截图仍可作为参考查看；只有页面实例、网址、标签页、时序和视口等条件能够确认时，复现界面才会标示近似操作位置。旧记录缺少页面实例或截图开始时间时可能无法标示。

### 记录包

导出 ZIP 的主要结构如下，具体条目取决于录制结果：

```text
manifest.json                    格式版本、会话、数量及限制
timeline/events-00001.jsonl      按顺序分段的事件
timeline/events-00002.jsonl      更多事件（如有）
resources/index.json             资源索引
resources/<id>.bin               采集到的资源
screenshots/<id>.jpg             采集到的截图
integrity.json                   文件大小与 SHA-256 校验信息
```

导出为版本 2；查看器兼容版本 1 和版本 2。校验可发现文件变化，**不证明来源真实，也不提供加密**。当前侧边栏导入限制为 ZIP 300 MB、单文件展开 50 MB、展开总量 1 GB；较长流程建议分段录制。合法记录即使压缩率很高也可以导入，仍会核对实际展开大小。

## 权限

| 权限 | 用途 |
| --- | --- |
| `sidePanel` | 在浏览器侧边栏提供全部操作界面。 |
| `scripting` | 向获授权页面及框架注入采集脚本。 |
| `tabs`、`activeTab`、`webNavigation` | 确定当前标签、页面导航及框架上下文。 |
| `debugger` | 通过 Chrome DevTools Protocol 采集可用网络证据及部分截图；Chrome 可能显示调试提示。 |
| `cookies` | 读取获授权站点的 Cookie 元数据与变化；值默认受限制。 |
| `storage`、`unlimitedStorage` | 保存任务状态及本机扩展档案。 |
| `downloads` | 下载用户主动导出的 ZIP 或接口草稿。 |
| 可选 HTTP/HTTPS 站点权限 | 开始录制时按所选范围请求；仅在获得授权后注入与采集。 |

## 数据安全

只记录你有权访问和分享的内容。档案保存在本机扩展数据中，插件没有自动上传服务；导出或分享 ZIP 由用户主动操作。卸载扩展可能删除本机档案，请事先导出需要保留的数据。

密码、常见认证字段和部分敏感内容会尝试隐藏，截图也会尝试遮挡可识别区域；这些规则**不能保证覆盖所有个人信息、凭据、页面文本、图片或业务数据**。非认证 Cookie 值默认关闭，开启后仍可能包含敏感信息。ZIP 默认不加密，任何拿到文件的人都可能读取；分享前请检查内容并采用适当的保存和传输方式。

## 能力边界

- 只覆盖授权范围内、录制期间实际观察到的路径；浏览器限制、跨域框架、权限拒绝、后台休眠、站点脚本及调试连接中断都可能造成缺失。
- 请求与操作的关联是基于时间和可用页面上下文的候选，不证明因果关系；接口草稿不代表完整契约。
- 页面复现使用隔离快照和已记录的变化，不运行原站脚本，也不会向原站提交复现操作。它不等同于重新运行原站、恢复服务端逻辑或生成完整可部署网站。
- 截图可能共享或失败；图片、字体、样式、富文本、框架和页面变化可能因权限、时序或大小限制不完整。请查看侧边栏“报告”和每条记录的状态。
- 自动填充、文件内容、未知二进制、WebSocket 二进制、数据库中间变化和缓存条目内容可能不可得或不保存。所有大小和数量限制详见[使用说明](docs/插件安装与使用说明.md)。
- 浏览器意外退出时可导出已写入的部分记录，但退出前缓冲数据可能丢失。

## 开发与验证

```bash
cd app
npm ci
npm run build
npm test
export PLAYWRIGHT_BROWSERS_PATH="$PWD/.playwright-browsers"
unset CHROME_BIN
npx playwright install chromium
npm run test:replay
npm run test:page-replay
npm run test:screenshot-timing
npm run test:scroll
npm run test:recovery
npm run test:browser-restart
npm run test:archive-roundtrip
npm run test:input-length
npm run test:storage-capture
npm run test:snapshot-scheduling
npm run test:screenshot-identity
npm run test:network-origin
npm run test:response-encoding
npm run test:permissions
npm run test:e2e
```

以上环境变量示例适用于 Bash；PowerShell 可使用 `$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path (Get-Location) '.playwright-browsers'` 和 `Remove-Item Env:CHROME_BIN -ErrorAction SilentlyContinue`。安装及运行测试时应保持相同的 `PLAYWRIGHT_BROWSERS_PATH`；更新 Playwright 依赖后重新执行浏览器安装命令，以使用匹配版本。`CHROME_BIN` 会覆盖该浏览器，若需要指定本机 Chrome/Chromium，应自行验证兼容性；版本不匹配可能影响测试稳定性。部分测试在临时浏览器配置中预授权站点；`test:permissions` 也检查权限请求等待及模拟结果，但不代表已自动接受或拒绝真实系统授权弹窗。完整端到端测试在部分 Windows 环境的浏览器重启阶段可能超时；应查看日志并运行独立重启恢复测试。

演示素材的生成依赖 Playwright 视频组件和 FFmpeg，步骤见 [docs/DEMO.md](docs/DEMO.md)。开发时不需要 Docker 或 WSL。

## 目录

```text
app/src/          扩展后台、页面采集、侧边栏、归档与复现
app/public/       Manifest V3 配置和图标
app/tests/        单元与浏览器端到端测试
app/scripts/      图标及文档演示素材生成脚本
docs/             使用、需求、技术文档、更新说明与演示素材
```

行为变化时请同步维护中英文 README、相关文档、演示素材及 [docs/CHANGELOG.md](docs/CHANGELOG.md)。
