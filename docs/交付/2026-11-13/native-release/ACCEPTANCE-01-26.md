# v0.3.0 的01–26项证据映射

本表把原采集目标收口为当前原生release下可验证的行为，不将浏览器无法观察的范围扩大成无条件保证。全部样本实际结果与候选输入一致性以[验证报告](<RELEASE-REPORT.md>)和[VERIFICATION](<VERIFICATION.json>)为准。

| 原项 | 本版验收证据 | 保留边界 |
| --- | --- | --- |
| 01 原始DOM | combined / skill-reconstruction / fragments shared golden，原文与引用长度、逐UTF16重组 | 序列化非服务器源码，页面销毁/无法读明确失败 |
| 02 DOM变化 | mutations / raw mutation、节点拓扑与原值引用 | 观察回调时刻非业务全局原子时刻 |
| 03 表单原值 | dynamic-form-ime / long-input-and-clicks / ERP old-new contact-note | 可信beforeinput匹配才有前值，派生快照限制不等原值 |
| 04 iframe | frames-and-navigation / restricted/dynamic/failure / page-instances | 外域限制明确，tab/frame/document不能靠URL混同 |
| 05 Shadow | shadow-style / delayed-final-shadow | 可枚举窗口与深度/忙状态，closed不可得不造数据 |
| 06 滚动/懒加载 | scroll-containers / virtual-list-and-lazy / fixed-and-nested-scroll | 不由录制器额外滚动业务页，不保证未渲染记录 |
| 07 CSS来源 | combined style / large styles / shadow-style | 跨域无法读保状态，派生不是原网络字节 |
| 08 计算样式/布局 | computed-style-stress / pseudo-style / interaction-descendant-limit | 忙/时间/后代截断与未验证完整性保留 |
| 09 主题/颜色 | theme-switch-and-hover、theme observation unit | 观察值不是自动设计体系或主题因果推断 |
| 10 字体 | font / initial-resources，实际字体fixture | 可访问字节及字体签名，不保证所有系统字体可导出 |
| 11 图片/SVG/背景 | visual-resources / initial-resources / style resource unit | 已加载资源读取不主动重放HTTP |
| 12 Canvas/WebGL | combined / tainted / webgl / no-buffer / delayed-final-canvas | no-buffer PNG可能透明但截图有像素，保screenEquivalence unverified |
| 13 无损视口 | full-page-dpr2 png pixel / screenshot MIME unit / ERP PNG | 时序/活动标签/异步，可共用或缺失 |
| 14 整页分片 | full-page-tiles与6/6像素核对 / fixed nested | 分片非原子，重复/缺片/变化明确缺口 |
| 15 逐操作截图结果 | long-input-and-clicks / screenshot identities / ERP click refs | 不是每click独立图，unavailable必须保留 |
| 16 请求元数据 | redirect/concurrent / extraInfo/iframe / ERP5HTTP | protocol_id_only不升级确定重定向段或业务因果 |
| 17 请求体/上传 | combined large request/file / network-binary / file-drop/readfailure | 浏览器可省multipart文件，不能靠请求body证明文件完整 |
| 18 响应/实时 | binary18MB / text/XML / realtime-large / response charset unit | WebGL/worker/stream深度按已观察能力，不保证所有中间响应字节 |
| 19 字段观察 | form/text/query/XML+limit / field unit | raw词元与offset/位置保留，不强转数值或推必填 |
| 20 关联 | page-instances / frame tree / ERP request-click evidence | recorded/candidate分开，相邻时间非因果 |
| 21 Cookie/键值 | partitioned-cookie / large storage / database browser unit | 域/分区与周期采样，sameorigin不等全局同实例 |
| 22 IndexedDB | combined graph/large DB / database catalogs | 短事务batched_non_atomic，count同不证明值集不变 |
| 23 文件/复杂类型 | file-drop/failure / graph/complex types / base64 shared corpus | 原可读字节/图引用，无法读/安全整数错误明确拒完整 |
| 24 Cache | opaque/removal/large catalogs / cache metadata | opaque不读正文，每cache时间budget，中间变化未知 |
| 25 全证据索引 | sidepanel two batches / archive-index/relationship/page units / ERP Python321 | 索引hash过不代表来源真实性/业务完整 |
| 26 可追溯字典 | browser source namespaces / fields/theme summaries / ERP原值回查 | unknown来源保守隔离，统计不推schema完整或必填 |

## 发布判定

以上覆盖的必选自动验证必须在本版同候选上实际通过；未测的平台/GPU/真实站点不在报告中写成已验。合理取舍与后续规模优化见[问题收口](<FIX-CLOSURE.md>)。原草案/历史not-run和阻塞记录保留作过程，不覆盖用户最新原生交付指令与本版真实结果。
