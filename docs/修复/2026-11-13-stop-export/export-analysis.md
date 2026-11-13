# export 独立分析与获授权修复

2026-11-13；只用合成数据、原生Node/Chrome158，未读真实记录/既有profile，未build、重跑310unit或发布。[测量JSON](<docs/修复/2026-11-13-stop-export/export-analysis.json>)保留修前/修后；[探针](<app/tests/archive-scale.probe.mjs>)可复现。实际normalStop中断原因未经真实数据验证，不把风险当故障归因。

## 关键结论

- **先排等待，再治CPU。** 修前[归档](<app/src/archive.js>)全量payload预扫后才首次progress，事件读两遍；[只读IDB](<app/src/db.js>)和[WebLock](<app/src/session-lock.js>)无等待界限。最小fix是signal/read deadline、阶段/字节进展、无进展超时后保留数据重试；不能伪造complete。
- **排除错误热点。** pendingBrowserFragments仅End/Failure时合并一次，16/64/128片=0.65/2.63/6.28ms近线性。SHA256按约2MB文件而非每事件，2MB=1.9ms；ZipDeflate level6同步66.5ms且timer延迟66.8ms。
- **确证平方成本。** [图观察器](<app/src/browser-observations.js>)复制祖先/location，[摘要](<app/src/browser-field-summary.js>)保留各前缀；2048深单链产生45.19MB观察+43.80MB摘要、约546ms。父随后授权仅路径派生限depth256/locationCells1e6/pending100k，原100k路径限制保留。超限显式field-path-coverage partial+reason/observed/pending；rawgraph、所有graph-node/direct-field完整且不变。复测2.92MB+0.888MB、33.87ms（约16倍），不是静默丢派生。
- **别盲换AsyncZipDeflate。** fflate0.8.3用blob Worker，同项目HTTP CSP下被worker-src阻止且1.5s仍不reject。同源module Worker(new URL)roundtrip成功（非Vite/MV3打包验收）。原生CompressionStream(deflate-raw)支持、2MB=37.9ms；只迁压缩，别丢主线程DOMParser/XML。CS先pump后write，CRC/size必须喂原始bytes，abort同时清理pump/writer/zip；fallback小块宏任务让步。
- **内存仍非有界。** IDB600×20k字符，20条页189.7ms、200条页176.8ms，单纯增页收益小。pending片、summary maps、assets、ZIP chunks仍累积；导出后才查300MB/展开1GB太晚。应预算字节并明确失败保留证据，不能删字段保成功。

## 已验证与范围

父授权生产改动仅[观察器](<app/src/browser-observations.js>)；另改[观察测试](<app/tests/browser-observations.test.js>)、[摘要测试](<app/tests/browser-field-summary.test.js>)，5个新增边界案例。obs+summary+browser-archive+archive+archive-seal定向测试37/37、exit0；不是修复后全量/真实用户包验收。生产源码已向父freeze。

复现：在app目录执行 `node tests/archive-scale.probe.mjs --browser`。独立HTTP服务/Chrome上下文均finally关闭；首轮静态依赖映射失败，补齐后exit0。
