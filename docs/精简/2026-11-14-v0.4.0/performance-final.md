# v0.4.0 performance 实测

- 状态：**PASS**（执行后生成，不代替父级发布门）
- 原生 Chrome、独立己有 profile；仅临时扩展副本预授 hosts，**不是 native permission test**。
- 候选 SHA256：3636e8658f9cb1f18c2534650b585af44ae485603339d2a5953511cf1399532f
- 工作负载：20轮 × 5000ms、相同10组交互，20既有无关页与1个无 opener 新页。
- P95：Stop 2436ms / Export 2703ms。短轮P95不冒充20次60秒。
- 结果：[JSON](<performance-final.json>)；含每轮首失败、HTTP oracle、8核心门、账本与候选哈希。
- 实时表单 property 与 sourceHtml 节点标记关联，不伪装初始 attribute 为实时值。
- 未覆盖：预算边界（父级）、盲重建（consumer）、原生可选权限弹窗。
