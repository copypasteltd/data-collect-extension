# 逻辑记录 | Logic Recorder

**v0.4.0 轻量业务记录版**：记录指定业务流程的关键操作、页面状态和接口样本，按批次本地导出。不是全浏览器备份工具，也不自动生成巨型主题/字段分析包。

[English](<README.en.md>) · [安装与使用](<docs/精简/2026-11-14-v0.4.0/INSTALL.md>) · [实际验收](<docs/精简/2026-11-14-v0.4.0/REPORT.md>) · [需求合同](<docs/精简/2026-11-14-v0.4.0/CONTRACT.md>) · [更新说明](<docs/CHANGELOG.md>)

## 本版交付

- **[完整v0.4.0交付包](<app/release/logic-recorder-release-v0.4.0.zip>)**：扩展、解析技能、安装/更新说明、真实验证与校验值。
- [仅Chrome扩展](<app/release/v0.4.0/logic-recorder-chrome-v0.4.0.zip>)：解压后加载，录制不需要Node.js/Python。
- [当前读取skill 0.4.0.1](<app/release/skill-v0.4.0.1/extension-logic-clone-v0.4.0.1.zip>)：适配v3及历史v1/v2，校验账本/封存并按事件提取原字节；[本地安装与验证](<docs/技能更新/2026-11-14-v3/REPORT.md>)。原release内v0.4.0工具字节保持历史不覆盖。
- [校验清单](<app/release/v0.4.0/SHA256SUMS.txt>)。本次是本地release和同路径程序更新，不自动发布新GitHub Release；[旧v0.3.0](<https://github.com/copypasteltd/data-collect-extension/releases/tag/v0.3.0>)保持历史字节和标签，不代表本版。

## 从“尽量全采”收口为八项核心义务

1. 开始时绑定一个根业务标签；必要授权框架及一个有可信操作/opener/时间证据的业务子页共享范围。切到其他标签不会自动采它。
2. 关键点击/提交、字段稳定值和可知前值、勾选/选择/关键键、滚动终点。
3. 一个规范结构DOM表示，初始/业务关键状态及必要组件结构；弹窗、下拉、短命校验提示有轻量原文状态。
4. 必要CSS、已展示视觉资源按SHA256一次保存，重复观察用引用。
5. 关键视口PNG，不默认整页分片、视频或Canvas另存像素。
6. 业务XHR/Fetch请求响应样本，保不同业务结果，相同内容复用；不主动重放业务请求。
7. 范围/页面/事件/内容身份、时间、hash、预算和采集缺口可追溯。
8. 只打包已落盘数据与轻清单；不在主导出自动展开主题/字段字典/接口规范。

**不再默认采集**：全profile、全元素计算样式/伪元素属性、Cookie全域快照、Storage轮询、IndexedDB全库、Cache镜像、所有静态JS/媒体/上传文件字节、所有WebSocket/SSE消息正文。必要框架权限不足或无法归因的新页明确缺口；不是假装它们不存在。

## 容量是接纳规则，不是最后提示

| 项目 | 上限 |
| --- | ---: |
| 单批内容+原始事件元数据 | 64MiB；48MiB提醒，普通接纳63MiB，1MiB收尾保留 |
| 正文集合 / 单个正文 | 24MiB / 2MiB |
| DOM / 必要资源 / 视口截图 / 元数据 | 16 / 8 / 12 / 4MiB |

内容hash在同批复用；跨类别引用仍分别受子预算约束。达到预算受控停止，不干预用户业务、不删除记录，状态明确“按容量停止/部分可导出”。64MiB不是Chrome内存峰值硬保证；未知长度CDP正文物理流式限界的不足会记录，不伪称全量。

## 实际样本

当前Windows原生Chrome157固定合成场景：20无关页、5000个CSS变量/动画、根页+授权框架+可信业务子页，查询/资料修改/校验/下拉/保存/扣款成功和拒绝、iframe导航后继续输入、200ms提示均验。

- 60秒业务样本：ZIP **562491B**，停止 **1837ms**，导出 **2366ms**。
- 20轮同业务短循环：全部通过，Stop P95 **2436ms** / Export P95 **2703ms**，ZIP最大 **329596B**。20短轮不是20次60秒。
- 完整JavaScript回归445项通过（含72项新flow合同回归）；Python旧12项+v3新16项通过；实际64MiB预算/封存及独立接收者重建另见[报告](<docs/精简/2026-11-14-v0.4.0/REPORT.md>)。

这些是固定样本结果，不保证任意站点/时长都同样大小；不把旧50重型采集场景通过当新版范围验收。

## 安装与更新

在chrome://extensions启用开发者模式，加载扩展ZIP解压后直接含manifest.json的目录。更新当前安装时先停止，备份程序文件，再覆盖**原加载路径**并刷新原扩展；不要先卸载、不要清Chrome数据或加载成另一份。目录名可以仍含旧版本号。

v0.4.0新批次使用独立数据库logic-recorder-flow-v1；旧logic-recorder库不打开、不迁移、不删除，旧批次不在新列表中显示。用户明确本次不考虑旧数据，不代表自动清理旧数据。

开始前切到业务页，原生授权只请求当前来源；已有安装原先授予的权限可能仍保留，内部scope仍只纳根流程。关闭侧栏不会停止录制。ready/导出hash通过不等采集完整，应检查partial/coverage/policy状态。

## 当前界面

| 准备 | 批次选择 |
| :---: | :---: |
| ![v0.4.0准备](<docs/media/v0.4.0-01-ready.png>) | ![v0.4.0批次](<docs/media/v0.4.0-03-history.png>) |

真实己有测试Chrome与合成页面，权限预授不证明原生授权弹窗通过，侧栏HTML测试标签不等原生drawer外观验收。[素材说明](<docs/DEMO.md>)。

## 包与解析

```text
manifest.json                  v3业务范围/预算/封存/缺口/内容列表
integrity.json                 每文件size/SHA256（除自身）
timeline/events-NNNNN.jsonl     原始观察事件及轻内容引用
contents/<SHA256>.bin           去重后的原始HTML/CSS/PNG/正文等字节
```

独立技能目录中执行：

```powershell
python scripts/index_archive.py recording.zip --output new-index.sqlite3
```

输出必须不存在。SQLite保存原始events、files、contents和content_refs，不自动派生主题字典；[格式](<app/skills/extension-logic-clone/references/archive-format.md>)。v1/v2文件读取器兼容不等新扩展迁移旧数据库。

## 数据风险与限制

已采样本可能含密码、认证头、个人/业务资料和未遮挡截图。ZIP/SQLite未加密；不主动上传但本机/备份/人工分享由持有人保护。hash是字节一致性，不是可信来源或数字签名。

只覆盖观察到的业务路径；不恢复原网站源码、服务端内部逻辑、登录态、全库、未访问分支或绝对像素画面。权限不足/超额/不可读取必须标记。原生权限弹窗、最低Chrome125真机/macOS/真实客户ERP未自动验证。测试原生Windows、不用Docker/WSL、不关闭用户浏览器。

## 开发

```powershell
cd app
npm ci
npm run build
npm test
npm run test:flow
npm run test:skill
npm run test:flow-skill
$env:CHROME_BIN='C:/Program Files/Google/Chrome/Application/chrome.exe'
npm run test:flow-native-store
npm run test:flow-acceptance
npm run test:flow-performance
```

生产入口为flow-background/flow-content和flow-archive。旧重型源码保留历史，不进入新构建；历史查看器/旧全量E2E不属于新版发布门。
