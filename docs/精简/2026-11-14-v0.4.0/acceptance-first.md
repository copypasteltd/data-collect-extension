# v0.4.0 acceptance 实测

- 状态：**FAIL**（执行后生成，不代替父级发布门）
- 原生 Chrome、独立己有 profile；仅临时扩展副本预授 hosts，**不是 native permission test**。
- 候选 SHA256：52b3929cbba1054fcba967154b655e60dfa2a659c386e76c23ca92cd296882ba
- 工作负载：1轮 × 5000ms、相同10组交互，20既有无关页与1个无 opener 新页。
- P95：Stop 未完成ms / Export 未完成ms。短轮P95不冒充20次60秒。
- 结果：[JSON](<acceptance-first.json>)；含每轮首失败、HTTP oracle、8核心门、账本与候选哈希。
- 实时表单 property 与 sourceHtml 节点标记关联，不伪装初始 attribute 为实时值。
- 未覆盖：预算边界（父级）、盲重建（consumer）、原生可选权限弹窗。

## 首失败

Expected values to be strictly deep-equal:
+ actual - expected

  [
    1659475657,
-   1659475659
  ]

