# v0.4.0 轻量业务记录：批准方案的实施合同

来源：用户已明确批准[需求减量评估](<../../2026-11-14-需求减量评估.md>)并要求新release及同路径更新。只做一个轻量默认版；旧数据不迁移、不救援，也不清除。新批次使用独立数据库logic-recorder-flow-v1，避免加载新版本时修改旧库。

## 组件与唯一写入契约

- 构建入口改为flow-background.js、flow-content.js（输出仍background.js/content.js）；现有四操作侧栏对新消息和flow-archive.js工作。旧重型入口保留历史源码，不进入新产物。
- flow-store.js独占IDB/预算/内容去重：createSession(session)、getSession(id)、listSessions()、appendCapture(id,ownerToken,event,contents=[],{final=false}={})、updateSession(id,ownerToken,patch)、sealSession(id,ownerToken,{status,stopOutcome,coverage})、readEvents(id)、readContents(id)、closeSessionWrites(id,ownerToken)。
- event={kind,time?,payload?,tabId?,frameId?,documentId?}；store分配id/seq/sessionId/time，不能由页面改变归属。contents=[{field,category,mime,bytes}]，field是payload顶层字段名，bytes为string/Uint8Array/ArrayBuffer/Blob；store取SHA256字节，在payload[field]写{contentId,sha256,size,mime,category,status:'captured'}。整个event+新content+session预算为单个事务；相同session内hash内容复用，观察事件保留，category按首次内容计费但后来类别仍须受其局部预算，不能借dedup绕过。
- appendCapture结果{accepted:0|1,failed:0|1,policyStopped:boolean,reason?,event?}；预期容量超限为accepted0/failed0/policyStoppedtrue，不是transportfalse成功。失败要抛错/failed，不能称数据已保存。先拒未知kind/过大metadata，不大体积遍历后才发现无预算。
- session计数eventCount/contentCount,lastSeq,revision，budget={usedBytes,byCategory,warning,limitBytes:67108864,reserveBytes:1048576,policyStopped,reason?}；普通接纳总63MiB、warning48MiB，meta普通3MiB、收尾1MiB；body24/DOM16/resource8/screenshot12/meta4MiB，单body2MiB。final路径只准固定轻量session/notice/stop且总不超64MiB。
- writeGate open/closing/sealed，closeSessionWrites使普通接纳拒绝，seal在唯一finalstop后同事务核对计数/水位；后续不可改raw。只可必要statuserror元数据补录不伪造seal。

## 采集消息

START{tab,acknowledgeEarly?}→{ok,value:session}；STOP{sessionId}→{ok,value:session}；GET_STATUS→{ok,value:{active}}；GET_STATE→{ok,value:{active,sessions}}。

FLOW_SETTINGS（仅获准tab/frame sender）→{ok,value:{sessionId,ownerToken,profile:'business-flow-v1',maxBodyBytes:2097152}}。FLOW_EVENTS{sessionId,ownerToken,batchId,events:[{kind,time,payload,contents?}]}→{ok:true,value:{accepted,failed,policyStopped,reason?}}；后台按sender tab/frame/document补归属，仅已纳入tab以及HTTP(S)/授权可读frame；旧sessiontoken不接。FLOW_CHECKPOINT请求可选由后台发页面消息，FLOW_FLUSH/STOP_CAPTURE需要最终队列确认但不做全站存储扫描。

## 明确产品范围

根tabId绑定不随激活漂移；普通已有/无关新tab排除。scope最多根+一个由已录可信操作近时间且openerId属当前流程的HTTP(S)子页；无opener/不可归因/超范围只固定reason元数据。不额外业务fetch/POST，不采Cookies/Storage/IDB/Cache/全计算样式/字体清单/Canvas原像素/全页PNG/所有流正文。

内容：一个结构DOM表示（真实表单property/组件宿主结构可另轻量表）、关键操作/表单稳定值和可知beforeValue、弹窗/下拉/校验等状态、CSS规则内容hash一次、已展示必要视觉资源、视口PNG、XHR/Fetch/Document文本样本。任何body已知>2MiB不调用CDP读取，未知body CDP无法硬内存限须有明确预算/预检查及后验拒绝，不声称流式CDP物理硬限。页面巨大DOM也需扫描有节点/字符预算，不能无限outerHTML clone。

导出format logic-recorder/version3/profile business-flow-v1，manifest+integrity+timeline/events-NNNNN.jsonl+contents/hash.bin，只有轻关系/内容列表不做字段主题派生。oldversion批次在新列表不出现，新工具离线可读v1/v2/v3；不运行旧数据迁移。总展开≤已存内容及事件JSON加max(5%,1MiB)清单开销。

## 发布门

新模块单测、正常开始停止/双批/旧token隔离/后台恢复、20无关标签范围、5000CSS变量和动画不膨胀、内容重复和不同API结果、2MiB单body/64MiB及子预算/metadata收尾边界、关键业务成功/校验/拒绝/子页/框架证据、60秒10步骤<=20MB基准、20轮P95Stop5s/export10s候选验证，以及未看原站接收者本地重建关键页面/分支。所有实测失败必须修复或明确未过，不能沿用旧50重型场景全过。

当前Windows原生执行，不建隔离环境、不替换DSH服务。仅新建己有Chrome测试profile/本地样本；不读取真实批次，不清真实Chrome数据。同路径更新仅在核对备份后替换程序文件；Chrome刷新生效与磁盘更新区别记录。未授权发布新GitHub Release，代码按AGENTS同步origin。
