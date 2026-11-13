# 逻辑记录 | Logic Recorder

在 Chrome 中记录获授权的网页操作、页面状态及网络证据，按批次导出本机 ZIP。当前修复版本：**v0.3.1**（本地修复包；v0.3.0 GitHub Release 保持不变）。

[English](<README.en.md>) · [安装与更新](<docs/插件安装与使用说明.md>) · [本版交付与验证](<docs/交付/2026-11-13/native-release/RELEASE-REPORT.md>) · [更新说明](<docs/CHANGELOG.md>)

## v0.3.1 停止／导出修复

修复大页面正常停止被误判为录制中断，以及导出阶段无进展等待/同步压缩卡顿。保留真实缺口和真正存储/通信中断，旧批次不重写。

[修复安装包](<app/release/v0.3.1/logic-recorder-chrome-v0.3.1.zip>) · [更新与旧记录恢复](<docs/修复/2026-11-13-stop-export/UPDATE-RECOVERY.md>) · [真实验证报告](<docs/修复/2026-11-13-stop-export/REPORT.md>)

**更新请覆盖原加载目录后刷新，不卸载扩展、不清浏览器数据。** 新导出显示真实阶段/数量/用时；超时保留本地批次可重试。本次没有自动发布新GitHub Release。

## 已发布的v0.3.0

已正式发布：[GitHub Release v0.3.0](<https://github.com/copypasteltd/data-collect-extension/releases/tag/v0.3.0>)。10个附件已从公开链接重新下载并核对SHA-256，与此前本地交付字节一致。

**推荐下载：[完整release交付包](<https://github.com/copypasteltd/data-collect-extension/releases/download/v0.3.0/logic-recorder-release-v0.3.0.zip>)**，内含扩展、解析工具、安装/更新说明、真实验证记录和校验清单。

- [Chrome 扩展安装包](<https://github.com/copypasteltd/data-collect-extension/releases/download/v0.3.0/logic-recorder-chrome-v0.3.0.zip>)：解压后加载，不需 Node.js/Python。
- [独立解析技能](<https://github.com/copypasteltd/data-collect-extension/releases/download/v0.3.0/extension-logic-clone-v0.3.0.zip>)：ZIP 校验、SQLite 索引、分段重组与样式解码，Python 3.9+ 标准库。
- [SHA-256 校验清单](<https://github.com/copypasteltd/data-collect-extension/releases/download/v0.3.0/SHA256SUMS.txt>) · [本版验收报告](<docs/交付/2026-11-13/native-release/RELEASE-REPORT.md>)

本版保留四项主要操作：**开始、停止、选择批次、导出**。修复批次确认、分段终态、跨来源字段汇总、会话封存、迟到任务归属和停止/导出控制；增加原值/范围披露、核验状态及版本来源。结果以本版实际报告为准，不沿用旧构建的通过数。

用户要求直接在当前 Windows 原生环境编译测试，本次未建设或切换 OS 隔离环境。测试仅使用本地合成页面和测试专用浏览器数据目录，不访问真实业务系统或用户既有 profile。此前评估和阻塞记录为历史过程，**不再作为本次发布前置**。

## 安装

1. 下载并解压扩展 ZIP 到固定目录。不要把 ZIP 文件本身选作扩展目录。
2. 打开 `chrome://extensions`，启用“开发者模式”，点击“加载已解压的扩展程序”。
3. 选择直接包含 `manifest.json` 的目录。
4. 点击或固定“逻辑记录”扩展图标，打开侧边栏。

Manifest 声明 Chrome 125+；本版实际验证环境与版本见验收报告。未实测的最低版本、macOS 或其他设备不等于已经验证。更新前停止并导出需保留的批次；优先覆盖原解压目录后在扩展管理页点击刷新，不卸载再装以免清除数据。

## 使用

1. 仅打开有权录制的 HTTP(S) 业务网页。建议使用专用业务 Chrome profile；**一个单独窗口不能隔离同 profile 的其他窗口**。
2. 点击“开始录制”，按 Chrome 原生提示授予网站访问权限。默认包含所有已授权普通网页：录制时已开、其他窗口及之后新开的页面。
3. 正常执行业务操作。完成后点击“停止录制”；准备期间也可停止。**关闭侧边栏不会停止后台录制。**
4. 等待批次出现，选择后点击“导出记录包”。录制中不新开历史导出；导出忙状态不占用停止控制。可切换批次分别导出。

“已停止，可导出”仅表示生命周期结束与可尝试导出，**不表示所有内容完整**。“需核验/录制中断”应结合记录包的缺口和状态检查；中断批次仍可导出已保存部分。下载确认超时会显示错误并保留本地批次，可检查浏览器下载后重试，不把未知下载状态说成成功。

批次和导出包留在本机；扩展不主动上传记录。当前不自动到期、不自动删除已导出批次，不提供内容查看、导入或回放。卸载扩展可能清除本地数据；导出文件和外部索引的保留/分享由持有人负责。

## 当前修复版界面（v0.3.1）

| 准备录制 | 选择批次 |
| :---: | :---: |
| ![v0.3.0 准备录制](<docs/media/v0.3.1-01-ready.png>) | ![v0.3.0 多批次选择](<docs/media/v0.3.1-03-history.png>) |

截图来自真实扩展和本地合成页面。自动化使用临时扩展副本预授网站权限，**不等于原生权限弹窗接受/拒绝已自动验证**；原图/演示说明见[素材说明](<docs/DEMO.md>)。

## 数据与证据边界

**记录可能包含密码、认证头、Cookie、令牌、输入、文件内容、个人资料、业务数据和未遮挡截图。ZIP 不加密。** 取得文件或索引的人可以读取原值；只录制获准页面，控制本机、备份和分享权限。

记录包含已观察的 DOM/表单/Mutation/Shadow/样式/画布/截图、请求响应、Cookie/存储/IDB/Cache 及可读取资源，按各自时间和表示保存。

```text
manifest.json                 批次、封存水位、来源版本和能力限制
integrity.json                各文件大小与SHA-256
timeline/events-*.jsonl        原始事件（大数据可能分段）
screenshots/                  截图
resources/                    已保存附件与资源索引
indexes/                      事件、页面和直接关系索引
data-dictionary/              字段观察与来源分组汇总
styles/                       主题/颜色观察
```

- 长 DOM/输入/文件/浏览器数据可能用引用和分段，必须核对全部片及唯一结束确认；同组 Failure 或 End 后额外片不能当完整内容。
- 原始 DOM 是序列化结果，不是服务器源码或 HTTP 原字节；派生快照与原始通道不互相替代。
- 截图可能共用、缺失或非原子整页分片；Canvas PNG 不保证等同屏幕合成画面。
- IDB/Cache 起止采样是短事务/尽力读取，不是全局一致快照，未观察到的中间变化不能恢复。Cookie 为域环境证据，不是每个操作的确定因果。
- 时间接近不等因果；缺失/未确认/未观察不是不存在。hash仅证明与随包清单一致，不证明来源真实性。
- 浏览器限制、调试器断开、受限框架、大规模/高频工作负载和页面关闭仍可能有缺口。不能保证任意时长/大小、未访问分支、服务端逻辑或完整可部署网站。

完整读取和容量规则见[归档格式](<app/skills/extension-logic-clone/references/archive-format.md>)。

## 解析工具

可将技能 ZIP 的 `extension-logic-clone` 文件夹复制到当前用户 Codex 技能目录，已有目标先备份检查；录制端不需要安装。也可直接调用：

```powershell
python ./app/skills/extension-logic-clone/scripts/index_archive.py recording.zip --output new-index.sqlite3
```

索引路径必须不存在，索引包含完整原值。按需要使用 `reconstruct_payload.py` 和 `decode_computed_style.py`；具体命令和可信读取边界见[技能说明](<docs/技能使用说明.md>)。

## 开发与验证

```powershell
cd app
npm ci
npm run build
npm test
npm run test:skill
$env:CHROME_BIN='C:/Program Files/Google/Chrome/Application/chrome.exe'
npm run test:e2e
npm run test:capture-matrix
```

实际命令、环境、成功与限制均见[release验证报告](<docs/交付/2026-11-13/native-release/RELEASE-REPORT.md>)。不使用Docker/WSL；只清理测试自己创建的资源，不关闭用户浏览器。历史查看器测试不属于当前四操作UI验收。
