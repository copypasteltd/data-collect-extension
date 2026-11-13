# GitHub Release v0.3.0 发布核验

- 结果：**已正式发布，10个公开附件下载后SHA-256与本地交付一致**。
- [发布页面](<https://github.com/copypasteltd/data-collect-extension/releases/tag/v0.3.0>)
- 发布UTC时间：2026-11-13T12:17:51Z（Asia/Taipei 2026-11-13 20:17:51）
- 标签：v0.3.0；目标提交：9abce787e6ecc777ec4c9c8934012dd4832d605b
- 状态：draft=false、prerelease=false；创建时make_latest=true。
- 未重新编译或修改已交付ZIP；未上传profile、业务记录、依赖、凭据或本地认证文件。

## 附件

| 文件 | 大小（字节） | SHA-256 |
| --- | ---: | --- |
| [logic-recorder-release-v0.3.0.zip](<https://github.com/copypasteltd/data-collect-extension/releases/download/v0.3.0/logic-recorder-release-v0.3.0.zip>) | 202877 | f9862c8a2803f9725af0b2cf1a4b17978444102f3c34c6ecd983091a96ae7fcc |
| [logic-recorder-chrome-v0.3.0.zip](<https://github.com/copypasteltd/data-collect-extension/releases/download/v0.3.0/logic-recorder-chrome-v0.3.0.zip>) | 136557 | fbcd9f444c3a80a54685733bc89daa69a3808a49563297bf2f91c0b9387552bc |
| [extension-logic-clone-v0.3.0.zip](<https://github.com/copypasteltd/data-collect-extension/releases/download/v0.3.0/extension-logic-clone-v0.3.0.zip>) | 22580 | e2d1d5bf1c9f64c9196ae5294bdfe4b3c56d5236455ab448c7fbf3877d144182 |
| [SHA256SUMS.txt](<https://github.com/copypasteltd/data-collect-extension/releases/download/v0.3.0/SHA256SUMS.txt>) | 1115 | d6826901ea3e5e18458d944e073a9b1472f19572f41bd50cf4adf85bdf446c7e |
| [logic-recorder-release-v0.3.0.zip.sha256](<https://github.com/copypasteltd/data-collect-extension/releases/download/v0.3.0/logic-recorder-release-v0.3.0.zip.sha256>) | 100 | fc90cb7dfb943c45e47fa19c87a4fbcea2494f7cce021777708f1496d1ae5db9 |
| [INSTALL.md](<https://github.com/copypasteltd/data-collect-extension/releases/download/v0.3.0/INSTALL.md>) | 7343 | b239d5c3aa481cabe175217164e0ac7594cf5e20e1745b952eb383a31ee10286 |
| [RELEASE-REPORT.md](<https://github.com/copypasteltd/data-collect-extension/releases/download/v0.3.0/RELEASE-REPORT.md>) | 4212 | 1b5441e56c843b7528a8650d2dcdd66c580b37fe0785d941ba95b4ca61f99c34 |
| [VERIFICATION.json](<https://github.com/copypasteltd/data-collect-extension/releases/download/v0.3.0/VERIFICATION.json>) | 68864 | d324a0ae2e00cb0418cb11f84fe420cb8cc1d83e4de6cd834864b756b4816d6e |
| [release-manifest.json](<https://github.com/copypasteltd/data-collect-extension/releases/download/v0.3.0/release-manifest.json>) | 8823 | 8206f4fa034fde4d4d78c19d48d615a4b8bb540bcab8a2cfaac2d87c1b41f142 |
| [package-smoke.json](<https://github.com/copypasteltd/data-collect-extension/releases/download/v0.3.0/package-smoke.json>) | 3347 | d487c1227e90c3c49ec9daa5217e0b9f7e9f46f6343a7364b504abef7531ed9a |

## 过程与范围

使用本项目既有Windows加密发布凭据在内存中解密认证；未在命令参数、脚本、日志或发布附件写入明文token。首先只读查询仓库/写权限/目标commit/同名tag及release，再创建草稿、逐个上传核对服务端digest，最后转正式发布并从公开URL逐个重新下载校验。

[机器回执](<GITHUB-RELEASE.json>)保存release id、tag、commit、发布时间和各附件URL/hash。后续文档同步不移动v0.3.0标签，也不替换已发布字节。
