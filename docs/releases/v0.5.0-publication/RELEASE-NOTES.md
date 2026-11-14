# v0.5.0 — 可配置20倍限额正式版

Chrome扩展 **0.5.0** 与读取skill **0.5.0**，记录格式v3/business-flow-v1。使用原已验证组件ZIP，不为发布重新编译。

## 下载

- **[完整交付包](https://github.com/copypasteltd/data-collect-extension/releases/download/v0.5.0/logic-recorder-release-v0.5.0.zip)**：插件、skill、安装/验证说明及校验清单。
- [仅Chrome插件](https://github.com/copypasteltd/data-collect-extension/releases/download/v0.5.0/logic-recorder-chrome-v0.5.0.zip) · [读取skill](https://github.com/copypasteltd/data-collect-extension/releases/download/v0.5.0/extension-logic-clone-v0.5.0.zip)。
- [附件SHA256](https://github.com/copypasteltd/data-collect-extension/releases/download/v0.5.0/SHA256SUMS.txt) · [完整包SHA256](https://github.com/copypasteltd/data-collect-extension/releases/download/v0.5.0/logic-recorder-release-v0.5.0.zip.sha256)。

## 新增设置

侧栏展开“录制限额设置”，分别设置容量、待处理队列、页面采样倍率，均为1–20整数，默认及最大20；保存到本机，重开保留。录制中保存只影响下一批，当前及旧批次限额不重写。无效草稿不保存、不允许开始新批，停止按钮保持可用。

| 默认20倍 | 数值 |
| --- | ---: |
| 单批总预算 | 1280MiB = 1.25GiB |
| 提醒 / 普通接纳 / 收尾预留 | 960 / 1260 / 20MiB |
| 单个接口正文 | 40MiB |
| 正文 / DOM / 资源 / 截图 / 元数据集合 | 480 / 320 / 160 / 240 / 80MiB |

子预算和队列限制独立受控，可能在总量未满前停止。时间等待、权限、根业务范围保持不变；倍率不是扩大浏览器范围或承诺内存/磁盘容量。

## 完整链路适配

- 每批固定settings/limits/runtimeLimits，采集、后台、存储、导出和读取器按相同快照，不被旧64MiB/2MiB常量错误阻断。旧批缺settings按原1倍。
- 长内容走真实确认的小片运输（完整消息不超过1MiB），保Unicode和原字节；最终内容与事件原子保存。
- 增量SHA256/CRC、游标分页、OPFS磁盘流式STORE导出；下载完成/失败后只清本次输出，不清录制。无OPFS环境仅有128MiB内存回退。STORE包可能比旧deflate ZIP大。
- 配套读取skill0.5.0校验1–20设置、预算/账本/封存、事件与引用实际限额，兼容旧v3及v1/v2；不执行采集HTML，不连接原后台重放业务写。

## 实际验证

500项JS（含127项Flow专项）、58项Python通过。Windows原生Chrome下验证默认/非法设置、保存重开、录中改设置的批次隔离、Stop独立、1倍与20倍两批业务、3MiB正文/DOM、长Unicode前后值和表单property；130片传输最大327997B，无代理字符断开。320px扩展页面无横向溢出。

实际72MiB唯一内容加元数据保存75499309B，OPFS磁盘导出ZIP75511309B，固定样本约4909ms并经Python校验。精确交付扩展11文件、skill10文件与原验证哈希一致。

**最大1.25GiB整批满载尚未实测。** ZIP64高位仅编码边界及小包真实读取，不声称实际大于4GiB导出。数值是固定本机样本，不外推任意网站/时长、内存或磁盘保证。原生权限弹窗、最低Chrome125、macOS与真实客户ERP未自动认证。

## 更新与风险

先停止，备份并覆盖原加载目录，再刷新原扩展；不要卸载、清数据或另加载第二份。已有flow-v1批次不重写，旧重型数据库不读取/迁移/删除。Chrome可能提示新增unlimitedStorage权限；它不能保证无限磁盘或内存。

已采原值可能含认证头、密码、个人与业务资料，ZIP/SQLite未加密。ready/partialfalse/hash不是全覆盖或来源签名，policy/coverage/缺正文必须检查。

旧v0.4.0 Release与附件保持不变。本正式包不包含本机安装回执、录制、profile、索引或凭据。

Source commit: d7467f37f8615c27eda53435db913b34fff07982
