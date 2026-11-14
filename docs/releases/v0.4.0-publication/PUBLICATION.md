# v0.4.0 正式发布回执

**已按用户明确授权正式发布，并设为GitHub最新稳定版。**

- Release：[v0.4.0 — 轻量业务记录正式版](<https://github.com/copypasteltd/data-collect-extension/releases/tag/v0.4.0>)。
- 组件：Chrome扩展0.4.0、读取skill0.4.0.1；记录格式v3/business-flow-v1。
- 正式标签指向原已验证源码提交3b5626a5ba88370d521756737a9d35b5340d52a2，draft=false、prerelease=false、Latest。
- 发布时间：2026-11-14 15:34:15（Asia/Taipei）。
- 10个附件全部上传，并从无授权头的公开API下载路径重新取回，逐一核size/SHA256与本地准备文件相同。
- 旧v0.3.0发布ID/标签/10附件size/hash保持不变。

## 下载

| 文件 | 大小 | 链接 |
| --- | ---: | --- |
| 完整正式交付包（含最新skill） | 142284B | [下载](<https://github.com/copypasteltd/data-collect-extension/releases/download/v0.4.0/logic-recorder-release-v0.4.0.zip>) |
| Chrome插件0.4.0 | 94163B | [下载](<https://github.com/copypasteltd/data-collect-extension/releases/download/v0.4.0/logic-recorder-chrome-v0.4.0.zip>) |
| 读取skill0.4.0.1 | 39301B | [下载](<https://github.com/copypasteltd/data-collect-extension/releases/download/v0.4.0/extension-logic-clone-v0.4.0.1.zip>) |
| 全附件校验 | 823B | [SHA256SUMS](<https://github.com/copypasteltd/data-collect-extension/releases/download/v0.4.0/SHA256SUMS.txt>) |

完整正式包SHA256：aa9a7088cc3618310ff7d3b86028854760e7fa53e19d0b5f868b6ea3df079903。

正式完整包重新组织了最新skill和适合公开分发的说明/验证摘要，区别于早期本地完整包；扩展和skill单独ZIP均保留原已验证字节，未重新编译。包内不含用户录制、profile、索引、凭据、本机路径或安装回执。

## 实际执行与连接情况

原发布脚本在10附件上传并公开后遇到Node ECONNRESET；先查询远端确认Release已公开，不重复创建、不覆盖。常规browser_download_url在本机Node/curl均连接重置；改走**无需Authorization的公开asset API，Accept: application/octet-stream**，跳转release-assets.githubusercontent.com下载，10文件全部字节验证通过。正常Release页面和Latest公开API确认成功。此限制是本机所用下载路由，不假称已从所有网络/客户端验证。

[机器发布回执](<GITHUB-RELEASE.json>) · [公开字节验证](<PUBLIC-DOWNLOADS.json>) · [上传计划](<publication-plan.json>) · [精确包加载验证](<package-verification.json>) · [公开说明](<RELEASE-NOTES.md>)

项目README和Changelog同步当前正式下载；发布源码标签固定在验证提交，后续文档回执提交不移动该标签。
