# v0.4.0 原生合成验收结果

## 最终结论与候选

**最终 60 秒业务样本通过；最终 20 轮短业务样本全部通过。** 本页只总结本 owner 的 8 项核心原生门，不代替父级预算边界、权限和独立接收者发布门。

- 最终候选：`3636e8658f9cb1f18c2534650b585af44ae485603339d2a5953511cf1399532f`。两份最终报告与末尾重新读取的 dist、package 身份一致，运行过程中没有重建。
- [60 秒完整原始报告](<acceptance-final.json>)；[20 轮完整原始报告](<performance-final.json>)。报告记录逐文件 SHA256、package 版本/哈希、导出 ZIP 哈希、各轮完整 oracle 与逐门结果。
- Windows 原生 Chrome：C:/Program Files/Google/Chrome/Application/chrome.exe；现有 launchExtension harness；全新己有 profile。**仅临时 dist 副本预授 hosts，不是原生可选权限弹窗测试。** 未访问 user profile 或真实旧批次。
- 最终两份测试均 exit 0；己有浏览器关闭确认、profile 删除、两台本地合成 server 关闭。生成 ZIP 仅留本地忽略的测试目录，未提交、推送或发布。

## 数值：不同工作负载分别报告

| 工作负载 | 结果 | Stop | Export | ZIP |
| --- | --- | --- | --- | --- |
| 60 秒、10 组业务交互，单样本 | 8/8 门通过；实际业务 60,012ms | 1,837ms（单次） | 2,366ms（单次） | 562,491B |
| 20 轮相同 10 组业务交互，目标每轮 5 秒 | 20/20 轮、160/160 门通过 | nearest-rank P95 **2,436ms**；最大 2,766ms | nearest-rank P95 **2,703ms**；最大 2,780ms | 247,276–329,596B |

短轮实际业务耗时 5,000–13,991ms，包含实际导航/采集就绪等待；5 秒是目标最短配速，不声称硬性每轮 5 秒。**20 轮短样本 P95 不是 20 次 60 秒样本 P95**。P95 按排序第 ceil(20×0.95)=19 项计算，满足 Stop≤5 秒、Export≤10 秒。并行执行的独立 60 秒样本不是 P95 数据的一部分。

60 秒样本：raw JSONL + unique content 逻辑字节 **759,222B**，ZIP 展开 **795,058B**，清单开销 35,836B；账本 usedBytes 与逻辑字节逐字节一致，展开满足 logical+max(5%,1MiB)，ZIP 远低于 20MiB。

## 每轮合成业务及 8 门

每轮初始 GET 查询两次同响应 → contact 与 emoji note 修改 → 必填校验和 200ms 临时 alert → dialog/dropdown → PUT 保存 → POST 扣款 201（100000→87200）→ 超额 POST 409（余额不变）→ 授权 iframe 查询与真实导航 → 根 contact 再改第二值 → 可信 window.open 子页查询 → 返回根 GET 复查。按 10 组交互配速；没有为采集器增加任何业务写入。

1. **raw v3**：所有 payload 内容引用解析为 manifest.contents 路径字节，hash/size/integrity 全核对；仅 manifest、integrity、timeline 和 contents，无旧 assetId/inline HTML 假设。
2. **范围**：20 个既有无关页 + 真实 Chrome openerTabId=null 新页 + 先创建、后手势的有 opener 无关页均排除；scope 仅 root+1 个可信 child，授权 iframe 有独立证据，无关 origin/marker 不进入事件。
3. **真实 DOM/值**：page.snapshot.sourceHtml 含关键表单 DOM，forms property 通过节点标记关联；原始输入与 emoji note 的 before/after 持久。iframe 导航后根第二次输入 13900001234→13700005678 及对应 forms 值也必须持久，防止重复注入后 batch key 冲突吞事件。
4. **分支状态/截图**：必填校验、打开的 dialog、dropdown 值、仅出现 200ms 的 alert 原文均有证据；临时状态按 recorder.notice transient_state/string 或内容引用核对；截图通过 v3 引用读取有效 viewport PNG。
5. **server oracle**：每轮恰好 8 个真实业务 HTTP、writes=2、attempts=3；成功/拒绝状态码与 87200 最终余额匹配，未增加或重复请求。
6. **去重**：同 CSS（含 5000 CSS variables）、同响应 body 共用 SHA；不同响应/余额不混同，manifest 内容 hash 唯一。
7. **轻量采集**：无 computedStyle/theme/dictionary/database/cache/cookie 事件或派生文件；合成 IDB/Cache seed 不进入内容，原始 script buffer 不进入 snapshot；隔离 world trap 与 CDP 方法观察辅助检查，未冒充全站内存扫描证明。
8. **最终封存与字节**：单个 session.stop 最后出现，顺序/身份/计数一致，status ready、writeGate sealed、partial=false；原始 JSONL+唯一 content 精确等于 budget.usedBytes；展开和 ZIP 大小都过门。

## 历史首失败：保留，不回填为成功

- [首次](<acceptance-first.json>)、[旧 focused](<acceptance-focused.json>)：旧候选缺归属子页，另有 collector_flush_unconfirmed。原 gate 未弱化，由背景 owner 修复。
- [worker 初始化失败](<acceptance-childfix.json>)：测试启动过早访问尚未就绪的 debugger API；改为精确扩展 background worker 与 bounded readiness，非生产权限失败。
- [旧候选性能首失败](<performance.json>)：第 2 轮无关页被后来的 query 手势错误认领，进入 scope；父/background owner 修复创建时间因果判定，新增真实 Chrome opener 前提和严格排除回归。
- [测试 helper 首失败](<acceptance-last-focused.json>)：增强测试时 tabId helper 缺失；只恢复测试 helper，未修改生产或削弱断言。
- [最终 focused](<acceptance-last-focused2.json>)：8 门通过后才启动最终 60 秒和 20 轮。最终使用不同输出文件，所有历史报告未覆盖。

## 边界

预算 2MiB/63MiB/64MiB、子预算及 final reserve 边界属于父级专门单测/native；本 owner 未重复旧 373 单测或 50 场景矩阵。Python v3 index/独立盲重建由 consumer owner/父级执行，本报告不冒认其结果。原生可选 host 授权交互未测试；无 push、public release 或安装到真实用户 profile。

测试入口：[focused/60s](<../../../app/tests/flow-acceptance.e2e.mjs>)、[20 轮](<../../../app/tests/flow-performance.e2e.mjs>)。两文件最终 node --check 通过。
