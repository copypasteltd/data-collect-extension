# 逻辑记录 v0.3.0 — 从这里开始

此包已经过本机Windows原生编译、310项JS回归、12项Python回归、50采集场景、9生命周期命令和合成ERP工作流验证；未建设隔离环境。没有自动公开GitHub Release/商店发布。

## 安装

1. 解压本完整交付包。
2. 再解压[扩展ZIP](<logic-recorder-chrome-v0.3.0.zip>)到固定目录。
3. 打开Chrome的chrome://extensions，启用开发者模式→加载已解压的扩展程序→选择直接包含manifest.json的目录。
4. 点击/固定扩展图标，使用开始、停止、选择批次、导出。更新前先停止并导出，覆盖原目录后刷新，不优先卸载。

录制端不需Node/Python。[独立解析工具](<extension-logic-clone-v0.3.0.zip>)只用于插件外校验/索引，需Python3.9+；解压后的extension-logic-clone含完整说明。

## 文档

- [安装/更新/数据处理说明](<INSTALL.md>)
- [更新说明](<RELEASE-NOTES.md>)
- [真实验收报告](<RELEASE-REPORT.md>)
- [机器验证记录](<VERIFICATION.json>)
- [精确安装包实际加载与包内CLI验证](<package-smoke.json>)
- [本版需求](<REQUIREMENTS-v0.3.0.md>)
- [01–26项证据与限制](<ACCEPTANCE-01-26.md>)
- [问题收口与架构取舍](<FIX-CLOSURE.md>)
- [文件校验清单](<SHA256SUMS.txt>)

## 重要边界

当前默认同profile所有已授权普通HTTP(S)网页/窗口/新标签，关闭侧边栏不会停止录制；建议只放业务页。原值可能含密码/Cookie/个人业务数据，ZIP未加密，不主动上传。无自动到期/删除或内容查看/导入/回放界面。只记录已观察证据，截图/浏览器存储/Canvas可有缺口，不能保证任意网站/时长/服务器源码。macOS、最低Chrome125、原生授权弹窗及真实客户ERP未自动验证。
