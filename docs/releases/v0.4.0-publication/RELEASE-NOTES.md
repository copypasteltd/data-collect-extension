# v0.4.0 — 轻量业务记录正式版

正式发布已验证Chrome扩展 **0.4.0**，搭配最新读取skill **0.4.0.1**；记录格式为v3/business-flow-v1。扩展和skill嵌套ZIP保留原验证字节，没有为发布重新编译。

## 下载

- **[完整交付包](https://github.com/copypasteltd/data-collect-extension/releases/download/v0.4.0/logic-recorder-release-v0.4.0.zip)**：扩展、最新skill、安装说明、验证摘要及包内校验。
- [仅Chrome扩展](https://github.com/copypasteltd/data-collect-extension/releases/download/v0.4.0/logic-recorder-chrome-v0.4.0.zip)。
- [读取skill0.4.0.1](https://github.com/copypasteltd/data-collect-extension/releases/download/v0.4.0/extension-logic-clone-v0.4.0.1.zip)。
- [全部附件SHA256](https://github.com/copypasteltd/data-collect-extension/releases/download/v0.4.0/SHA256SUMS.txt) · [完整包SHA256](https://github.com/copypasteltd/data-collect-extension/releases/download/v0.4.0/logic-recorder-release-v0.4.0.zip.sha256)。

## 收口后的行为

- 根业务标签、必要授权框架及一个明确归属子页；无关标签不采。保留开始、停止、选批次、导出四项主要操作。
- 保关键操作/表单前后、DOM/短暂状态、必要CSS资源、视口PNG和API样本；取消全样式/全库/Cache/Storage/Cookie快照及实时流正文镜像。
- 64MiB总、48MiB警告、63MiB普通接纳+1MiB收尾、单正文2MiB；相同内容一次保存，多次观察留引用。
- v3只打包落盘内容，不在导出时展开数千万行主题/字段分析。读取skill绑定ZIP身份、核账本/封存及引用，按需提取原字节，保v1/v2离线兼容。

## 实际验证

| 项目 | 结果 |
| --- | --- |
| 扩展JS回归 | 445通过，含72新flow测试 |
| 读取skill最终回归 | 46通过（12历史+23 v3+11内容读取） |
| 60秒固定业务样本 | ZIP562491B，停止1837ms，导出2366ms |
| 20轮短业务 | 全部通过；停止P95 2436ms、导出P95 2703ms，最大ZIP329596B |
| 原生存储/容量 | 去重、owner/幂等、正文/类别预算、48MiB警告、63MiB与64MiB收尾/封存通过 |
| 独立接收者 | 仅凭包本地复建13项真实UI通过；最终包另核内容兼容 |
| 精确代码包 | 扩展11文件、最新skill10文件hash核对，解压包与实际v3读取已测 |

20短轮不是20次60秒。场景含20无关标签、5000CSS变量、动画、框架/业务子页、输入/保存/拒绝、iframe导航后新输入及200ms提示。这是本机固定样本结果，不保证任意站点规模。

## 更新与限制

更新前停止并备份，覆盖原加载路径后刷新原扩展，不卸载、不清数据。新库不迁移/删除旧库，旧批次不在新列表。策略未采/权限缺口与真实通信/存储失败分别说明，ready/hash不是全采证明。

原值可能含敏感数据，ZIP/SQLite未加密；只在授权本地使用。默认不连原站、不重放业务写；不恢复原站源码、服务端、登录态、未访问分支或绝对像素。macOS、最低Chrome125、原生权限弹窗未自动验证。哈希用于一致性，不是发布者数字签名。

旧v0.3.0 Release保持不变。此正式完整包包含最新skill，取代早期本地完整包中的旧skill副本；单独扩展ZIP字节不变。

Source commit: 3b5626a5ba88370d521756737a9d35b5340d52a2
