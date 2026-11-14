# v0.5.0 设置 focused native 验收

状态：**PASS**。实际执行后生成；不替代父级发布门。

候选 dist SHA256：dc6535813fa7b29eadbdd9cee6c02342d6362089938d72844ffa5614c544a984。完整文件身份、版本、首失败和统计见 [JSON](<settings-acceptance.json>)。

原生 Windows Chrome，独立己有临时 profile、合成 localhost 页面。仅临时扩展副本预授 localhost hosts；不是原生可选权限弹窗验证。

- default three20 and1.25GiB preview;21/fraction/empty inline errors with no SAVE
- UI saves1 and new panel reloads persisted1
- save20 during1x recording keeps active1x/64MiB snapshot
- owned-profile invalid stored schema shows real GET error while Stop remains enabled;restored20
- two native business batches;1x body policy skip;20x exact3MiB body;longUnicode before/after+forms+3MiB DOM;small parts
- root-only with3existing+1new unrelated pages
- UI ZIP downloads;standard zipfile+skill index;ledger and settings snapshot;OPFS cleanup
- actual extension page at320px has no horizontal overflow;full-page settings screenshot

| 倍率 | 状态 | 实存字节 | 预算字节 | ZIP字节 | Stop毫秒 | 导出毫秒 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | pass | 41981 | 67108864 | 56831 | 1985 | 2125 |
| 20 | pass | 12954181 | 1342177280 | 12970969 | 1389 | 1497 |

局限：1.25GiB full payload not exercised；>64MiB real export is parent-owned separate acceptance；optional-host permission prompt not exercised；Stop settings loading/save I/O failure covered separately by UI source-VM owner。最大设置1280MiB=1.25GiB（约1.2GB）仅验证实际配置与较小录制；未宣称实际录满1.25GiB。

清理：owned-browser-closed; profile=removed。录制ZIP和SQLite仅保留在临时测试目录，不提交。
