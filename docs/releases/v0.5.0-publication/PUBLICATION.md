# v0.5.0 正式发布回执

**已按用户明确授权发布并设为GitHub最新稳定版（Latest）。**

- [v0.5.0 — 可配置20倍限额正式版](<https://github.com/copypasteltd/data-collect-extension/releases/tag/v0.5.0>)，插件/读取skill均0.5.0。
- 发布时间：2026-11-14 21:40:49（Asia/Taipei）。
- draft=false、prerelease=false；正式标签指向原已验证源码d7467f37f8615c27eda53435db913b34fff07982。
- 10个附件上传完成，并使用无Authorization的公开附件API（Accept: application/octet-stream）跳转下载，逐一核对size/SHA256，与准备发布文件一致。
- 旧v0.4.0发布ID/时间、标签和全部附件size/hash保持不变。未重新编译两个组件ZIP。

## 下载

| 文件 | 大小 | 链接 |
| --- | ---: | --- |
| 完整正式交付包（插件+skill+公开说明） | 152077B | [下载](<https://github.com/copypasteltd/data-collect-extension/releases/download/v0.5.0/logic-recorder-release-v0.5.0.zip>) |
| Chrome插件0.5.0 | 100955B | [下载](<https://github.com/copypasteltd/data-collect-extension/releases/download/v0.5.0/logic-recorder-chrome-v0.5.0.zip>) |
| 读取skill0.5.0 | 41998B | [下载](<https://github.com/copypasteltd/data-collect-extension/releases/download/v0.5.0/extension-logic-clone-v0.5.0.zip>) |
| 全附件校验清单 | 821B | [SHA256SUMS](<https://github.com/copypasteltd/data-collect-extension/releases/download/v0.5.0/SHA256SUMS.txt>) |

完整正式包SHA256：0d231cdce81f4b0a7ebd5f7fcacd2f3e5e72e32c1a1edd8a8ba6b641d44e78a7。

正式完整包将原验证组件ZIP与可公开说明/统计重新组织，不等于早期包含本机安装回执的本地完整包。两个独立组件字节不变；本包不含录制、profile、索引、凭据或本机回执。

## 验证边界

500项JS/58项Python、原生设置/批次隔离/长Unicode/3MiB正文和DOM/130片运输、72MiB磁盘导出均按原实际报告，发布前精确代码ZIP再次核hash并用未修改manifest在己有Chrome加载、包内reader读取真实合成20倍记录。测试浏览器/profile关闭清理确认；不用Docker/WSL，不操作用户浏览器。

**最大1.25GiB满载未实测**，ZIP64大数是编码边界/小包验证，不冒称大于4GiB真实导出。政策限额不等于内存/磁盘保证，STORE可能比旧deflate大。正式发布不扩大这些验证结论，也不代表所有网站/最低Chrome/macOS已认证。

[机器发布回执](<GITHUB-RELEASE.json>) · [精确包验证](<package-verification.json>) · [发布计划及hash](<publication-plan.json>) · [公开安装说明](<INSTALL.md>) · [发布说明](<RELEASE-NOTES.md>)

后续README/回执提交只同步main，不移动已固定的v0.5.0源码标签。
