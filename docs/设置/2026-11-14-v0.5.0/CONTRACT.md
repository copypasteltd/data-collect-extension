# v0.5.0 用户限额设置与20倍上限：实施合同

用户授权：侧栏允许设置，当前上限数值调整20倍。保持根流程范围/真实缺口/去重，不恢复重型全采。新默认及最大倍率20；三组整数倍率budgetMultiplier/queueMultiplier/samplingMultiplier均1..20，schemaVersion1，原版为1。页面显示实际总量/提醒/正文/各类与队列/采样预览，保存本地；无效值不写，错误不假保存。录制中可保存但仅下一批生效。当前批次启动读取一次并固化。

flow-config.js是唯一配置源：validateFlowSettings、DEFAULT_FLOW_SETTINGS、LEGACY_FLOW_SETTINGS、deriveFlowLimits→{settings,budget,background,content}、limitsForSession/session、formatFlowBytes、loadFlowSettings/saveFlowSettings。控制消息GET_LIMIT_SETTINGS/SAVE_LIMIT_SETTINGS{settings}/RESET_LIMIT_SETTINGS，仅扩展控制页可用，→{settings,defaults,maximumMultiplier:20,limits}。FLOW_SETTINGS/FLOW_READY回应附captureLimits:deriveFlowLimits(session.capturePolicy.settings)及原sessionId/ownerToken/profile。后台按active batch固定limits，不随GET/SAVE变化；扩展请求不能由页面START/SAVE越权。

新batch createSession({settings:validatedsettings,...})→capturePolicy.settings+limits budget+runtimeLimits snapshot，budget.settings持久，所有预算函数按其snapshot派生；旧批无settings用LEGACY1而非当前默认20，不写旧批。更新settings/capturePolicy/budget禁止updateSession patch。纯createBudget()和FLOW_LIMITS保历史1倍率兼容；新createSession默认20。validateBudget派生快照及limit/reserve/bycategory一致，去重仍按实际物理内容+类别首次引用。

用户最新修正以20倍为准：总1280MiB（1.25GiB，约1.2GB）/提醒960/普通1260/预留20；正文480/DOM320/resource160/screenshot240/meta80（普通60）MiB；单正文40MiB，event metadata640KiB。队列/采样容量数量用flowconfig基准20，ID/URL格式、权限scope（根+1可信子页）、超时/节流时间、递归深度等协议安全限不乘。default20设置最大20均可选择1..20。不将整页/全库/主题派生重新开启。

store新增flowEventPage(id,afterSeq=0,{limit=500,maxBytes=8MiB,...readoptions}={})→{events,nextSeq,done}；flowContentPage(id,afterId='',{limit=50,...}={})→{contents,nextId,done}。events按sessionSeq游标，若首event>pagebytes仍返回一条合法event，后续bytecap页；contenthandle懒Blob不全arraybuffer。旧readEvents/Contents保但随sessioncap，不以64MiB旧全局误拒新批。元数据parser结构深度/idprotocol guard保，可使用budgetscaledbyte cap。content每eventcontentcount按16*samplingMultiplier。

1.25GiB导出采用分块读取与磁盘写入(OPFS)，已有ZIP64实现可保留前向兼容测试（不是本次容量要求），不持有整个ZIP的Uint8Array。sha256/CRC逐块，contentBlob.stream，eventpage分块，停止后验证seal不变及rawmeta+uniquecontent==budgetused；一个ZIP仍v3format，可reader标准zipfile验证。返回{blob,cleanup,metrics}，blob为磁盘File；侧栏下载确认/失败后cleanup，切勿下载尚未完成删除OPFS；失败移临时文件/明确不假成功。小包无OPFS可有限fallback，不假称所有环境支持1.25GiB；不接新server。

读取skill更新0.5.0，兼容v3旧64MiB和新settings快照；配置不是任意上限授权，数值和budget/ledger严格校验，CLI默认资源上限容纳1.25GiB保存+清单。不要读取所有大附件到内存，原bytes保持，不复原全主题。安装DSH/Codex采用此前备份+hash同步，测试实际新版包。

验证：三组1/20/非法值/存储失败/未授权页面SAVE、save在recording不改本批、restart persisted/旧批settings缺失保持1、>2MiBbody在20可接而1拒、>64MiB actualbatch/export成功、1.25GiB虚拟账本安全整数/边界及ZIP64offsetheaders≥4GiB不wrap、实际nativeUI保存重开/record/stop/export+Python校验。最大1.25GiB全负载不曾实测则如实写，不能用虚拟边界测试说实际全量通过。不得删除旧录制/擅自公开新release。
