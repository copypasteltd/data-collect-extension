# v0.4.0 轻量业务记录：release 验证报告

**结论：批准的需求减量方案已实现，并完成当前Windows原生候选的编译、功能、容量和性能验证。** 本次本地release及原路径更新，不自动公开新GitHub Release。

## 实际结果

| 项目 | 结果 |
| --- | --- |
| 生产编译 | v0.4.0通过，新flow入口，不含旧重型采集依赖 |
| JavaScript | 445/445，含72项新flow合同测试，0失败/取消/跳过 |
| Python消费者 | 旧12项+新v3 16项通过 |
| 真正Chrome IDB | 去重/原值/owner/captureKey/2MiB/24MiB/48警告/63普通接纳/64总/最终seal通过 |
| 60秒业务样本 | 20无关页+5000CSS变量+动画+框架+可信子页，8门全部通过 |
| 20轮同业务短循环 | 20/20、160/160门通过；不是20次60秒 |
| 独立接收者 | 只包读取，本地重建13/13 UI检查通过；原未知与补全区别保留 |
| 独立源码审查 | 3项确认问题均最小修后源级关闭，非代替native验证 |
| 精确release解压包 | 实际通过：扩展11文件与技能7文件hash一致，未修改manifest解压加载，包内Python对96events/52contents/54files校验通过 |

### 体积和耗时

- 60秒业务：实际60012ms；事件96、唯一内容52；已保存逻辑759222B，展开795058B，ZIP562491B。
- Stop1837ms、Export2366ms。
- 20短轮Stop P952436ms / Export P952703ms；ZIP247276–329596B。
- 候选hash：3636e8658f9cb1f18c2534650b585af44ae485603339d2a5953511cf1399532f，20轮与60秒前后候选相同。

### 保住的关键证据

表单稳定值/已知前值（含emoji）、必填失败、下拉/弹窗、PUT资料保存、POST扣款201和拒绝409、余额100000→87200、iframe导航后root二次输入、200ms瞬时提示均有原值证据；无额外业务写。20无关页/无opener/先开页后点击不纳入。内容hash相同复用，但不同业务结果/多次观察不抹掉。

## 真正减量，不只是压缩算法

不再全profile、全计算样式/伪元素/继承变量、Storage轮询、Cookie快照、全IDB/Cache、全页PNG/Canvas像素及全JS/流正文镜像；只采必要流程证据。新v3主包不生成theme/field/dictionary解析文件，展开开销符合已保存字节+轻清单预算。

## 容量门

64MiB总、48MiB警告、63MiB普通接纳、1MiB收尾；body24/DOM16/resource8/screenshot12/meta4MiB及单body2MiB。native测试普通接纳停于66040346B，最终stop后66040497B，不超过总额。存储单事务保证事件/新内容/预算同时提交；sealed后拒raw，重复captureKey仅ACK不增账。

## 独立复建的诚实范围

独立接收者未读原fixture/产品源码/原站，仅凭包重建关键DOM、forms property、CSS及样本服务，13项真实Chrome UI通过、无外网。handler/state是为运行补全，不声称恢复服务器源码。旧focused包有child缺口，新最终包验证内容引用/HTTP样本兼容、二次输入与短命提示；不是把新包完整UI另跑一次。

## 已修复失败历史

- Native opener child initially missed blank-to-HTTP lifecycle; fixed by bounded candidate plus document admission
- Future gesture could claim a previously-created unrelated child; fixed eventTime<=createdTime
- Repeated allFrames injection could reset batchNo/queue and silently dedup new events; fixed same-owner collector reuse/generation nonce and per-document injection
- Unknown or unauthorized frame WebSocket URL could enter metadata; fixed explicit frame authorization
- Short-lived alert could disappear before a snapshot; fixed immediate bounded text evidence
- A mock test raced real WebCrypto and a native test raced controller recovery; fixtures now wait actual predicates
- Initial acceptance worker observer/helper failures were retained separately; final20+60s reports are passing immutable-candidate runs

## 局限与更新

- Saved-byte cap is not a hard process-memory or physically streamed CDP limit
- No arbitrary real-site size/duration, complete source/server logic, login restoration or pixel-identical reconstruction guarantee
- Native optional-permission dialog, macOS and physical minimumChrome125 not automatically tested
- Twenty short cycles are not twenty60-second recordings
- Independent receiver UI used an earlier focused bundle; final bundle was verified for evidence compatibility, not a second full UI reconstruction
- Known policy gaps remain explicit; integrity pass and ready do not mean full capture

新数据库logic-recorder-flow-v1不读取/迁移/删除旧库；旧批不在新列表。更新只替换原程序文件，备份后同路径写入，当前原目录已备份13个原程序/遗留资源并更新11个v0.4.0文件、hash全部一致；未刷新/开启Chrome运行时，未清旧数据，详见INSTALLATION.json。不卸载、不重启、不清真实记录。

[安装说明](<INSTALL.md>) · [需求合同](<CONTRACT.md>) · [机器验证](<VERIFICATION.json>) · [最终60秒](<acceptance-final.md>) · [20轮性能](<performance-final.md>) · [独立复建](<reconstruction.md>) · [审查](<review.md>)
