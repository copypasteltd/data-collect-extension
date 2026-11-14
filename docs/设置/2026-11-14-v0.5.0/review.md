# v0.5.0 settings 独立定点 review

最终：**scoped_pass_source**，无开放 finding。初判 needs_revision 的两项问题已由对应 owner 修复，并经独立源码 closure。只按[实施合同](CONTRACT.md)审本次设置变更；不扩为广安全/旧重型审计。完整源码SHA-256、open finding和closure状态见[机器可读报告](review.json)。源码未全冻结，发现与修复状态分开记。

## S050-R1 · high · closed_source

[发送端](../../../app/src/flow-content.js#L39)按131072字符切片，[接收端](../../../app/src/flow-background.js#L262)原先按262144字符估计允许片数。20/20/20下，3MiB ASCII形成24片但后台只允许14片。首片整JSON131281B，未超1MiB，实际handle仍返回`{ok:false,error:"无效内容传输分片"}`。采集端因无效确认detach，预算内ASCII DOM/输入值无法保存。

发现证据：`node app/scripts/validation-probes/settings-v050-independent-review-proof.mjs` exit0，确认旧状态拒绝。该probe由本review新增，不改生产代码；它断言旧错误，不应冒充修复后closure测试。发现时background SHA-256为`e25958e0ea2426d84f79bcfe95d1c4610cb338160d2b64414def0ceafcc89787`。owner现已将接收端改131072，SHA-256 `d3415a987ca96d00a0c8c5471fd05c779d695e11a6290eb3514e2b518dd12807`。

修复归采集owner：统一两端契约，保留每消息<=1MiB、序号、总UTF-8字节、emoji边界及重复片一致检查。父已有72MiB store/directBlob证据未覆盖content JSON传输。

独立 source closure：`node app/scripts/validation-probes/settings-v050-independent-transport-closure.mjs` exit0。实际handle接纳ASCII3MiB/24片（每消息最高131280B）及跨片emoji2228227B/18片（最高131293B），最终Blob大小和SHA-256均与原始值一致。重复首片确认稳定，冲突duplicate和乱序index2仍拒绝。修后hash如上；此项只关闭source根因，native由父owner验证。

## S050-R2 · medium · closed_source

[reader](../../../app/skills/extension-logic-clone/scripts/index_archive.py#L389)验证settings和limits字典后，实际事件仍按通用40000000B读取/检查，未用本批eventBytes。合法20x快照、精确总量/分类账本、最终session.stop及seal一致的3事件合成v3：首事件含LF660578B>655360B（640KiB），实际CLI仍exit0和`verification:passed`。合成ZIP仅4151B，总逻辑数据661526B。

发现证据：`python app/scripts/validation-probes/settings-v050-independent-reader-proof.py` exit0确认读端接受超限。reader发现SHA-256为`7ea79bd752c311903e1803fccc96561be5df765abf9c52ac323d83419b7f7610`。修复归reader owner：按派生eventBytes核真实含LF字节，同根maxContents/引用body cap漏接一并修，不另增finding。保留v1/v2与旧v3无settings的1x。

独立 source closure：`python app/scripts/validation-probes/settings-v050-independent-reader-closure.py` exit0。同一个含LF660578B的反例现在由实际CLI返回exit1：`Indexing failed: event line exceeds limit: timeline/events-00001.jsonl:1`；失败SQLite索引已清理。修后index_archive SHA-256为`01b0ab0a95548b6a4fe4fd9d7c8f137e058856981156a6ae197a2d5bbbf4193c`，read_content为`87b54a93c30cf26ef68210d980f1f51b7344d0224ddf07b2a53253dea513ddf4`。源码调用链已确认build_index按本批派生上限读真实JSONL含LF，并将同一limits传入内容引用数和实际引用category/body检查；read_content使用同一派生上限。v1/v2仍走通用旧格式上限，旧v3缺settings从LEGACY1派生。完整suite由父owner收取，本轮仅复原反例，不重复全矩阵。

## 其余核对范围

- 设置GET/SAVE/RESET入口和storage失败传播、START一次读取快照、旧批LEGACY1、updateSession禁止改settings/capturePolicy/budget。
- 三组1..20及20x预算；时间、权限、根+1可信子页限制未见本次扩大。
- store分页与lazyBlob，流式SHA/CRC及OPFS，seal与raw+uniquecontent账本复核，失败abort清理、128MiB memory fallback，下载终态await后cleanup。
- UI settings busy/dirty不锁Stop，无效draft不能SAVE。以上源代码追踪未新增确认finding。

## 限制

未实测1.25GiB全负载；不以边界算术或父72MiB证据声称最大容量实测。nativeUI由另一owner执行。本轮未操作浏览器/realprofile/installed、不改生产源码、不分派/Team/发布。校验和不提供真实性或完整捕获担保。本轮后只做两项根因closure。
