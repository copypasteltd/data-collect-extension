# 后台与内容采集：可配置限额（v0.5.0）

按用户最终更正，本轮采用新默认和最大 **20 倍**。三组倍率均为 1–20 整数，schemaVersion 为 1。唯一业务限额来源是 [flow-config.js](../../../app/src/flow-config.js)；新批次最大预算 1280 MiB（1.25 GiB），单正文 40 MiB。此前讨论的 200 倍不构成本轮实现或验收承诺。

## 后台设置与批次固定

[flow-background.js](../../../app/src/flow-background.js) 新增控制消息：

- `GET_LIMIT_SETTINGS`：读取本地设置。
- `SAVE_LIMIT_SETTINGS { settings }`：完整验证后写入本地。
- `RESET_LIMIT_SETTINGS`：保存当前默认设置。

三者成功返回 `{ settings, defaults, maximumMultiplier: 20, limits }`，使用与 `START` 相同的扩展控制页权限检查。普通业务页面、跨扩展发送者无法保存或重置。非法 schema、多余字段、非整数、越界值均不会写入；真实 Chrome 存储读写异常返回错误，不伪装成默认或保存成功。工厂可注入 `settingsStorage`；仅没有整个 storage 接口的纯测试替身允许默认值。

`START` 读取一次当前设置并验证，传入 `store.createSession({ ...session, settings })`。后台立即保留该次派生的限额；如 store 返回持久化策略，使用返回策略。后续容量检查读取该运行对象自己的限额，迟到任务不会读取下一批配置。录制中 GET、SAVE、RESET 不修改本批；下一批才使用新设置。没有设置快照的旧批次仍由会话策略助手／store 按历史 1 倍处理。没有通过 `updateSession` 修改设置、capturePolicy 或 budget。

`FLOW_SETTINGS` 与 `FLOW_READY` 保留 sessionId、ownerToken、profile，同时附带固定的 `captureLimits`。CDP 正文、分类预检、队列、帧数、请求数、资源观察与批次历史等容量跟随限额；时间、权限和标识符规则保持固定。工厂的 `limits` 覆盖仅用于内部定向测试。

## 独立内容脚本

[flow-content.js](../../../app/src/flow-content.js) 仍是无需 import 的独立 IIFE。启动时一次验证并复制后台提供的 content 限额；仅旧控制器没有 captureLimits 时采用原版 1 倍值，提供了损坏策略时不启动。

正文、元数据、事件队列、待处理输入、DOM 节点、shadow、表单、CSS 规则与哈希、资源 URL、瞬态文本与 mutation 采样数量都消费提供的值。DOM／瞬态递归深度、属性数量、标识符、来源权限、消息期限和 500ms 检查点节流不随倍率放大。录制范围保持根页和一个有可信手势关联的子页；没有重新启用全浏览器、全计算样式、主题派生或原始实时帧载荷。

同一所有者重注入保留正在发送和排队的内容；关闭后重新启动使用新 nonce。逐文档只注入一次，以及短暂添加后移除的提示／原输入值记录都保留。

## Chrome 消息分片

大 DOM 或长输入采用 `FLOW_CONTENT_PART`，小内容保留直接字符串路径。传输协议是固定保护，不是新的倍率设置。

1. 内容脚本将大字符串切为最多 131072 个 UTF-16 字符的片；若片尾为 high surrogate，把它移至下一片。逐片的完整 JSON 消息不得超过 1 MiB。不会先把整份大内容再序列化为 JSON 来判断是否分片。
2. 每片携带会话所有权、transferId、field、mime、category、index、parts、byteLength、text。后台按发送者标签／帧／文档授权，验证顺序、总长度、分类单项上限、片字符数、序列化消息容量及片数上限。片数保护为 `ceil(byteLength / 131071) + 1`，足以容纳合法 ASCII 片和 surrogate 边界，拒绝无限微片。
3. 后台保存独立的不可变小 Blob，并返回 `{ transferId, index, receivedBytes, complete }`；内容脚本逐字段核对真实 ACK 后再发送下一片。相同 index 仅允许完全相同的重复片，不重复记账。
4. 最终 `FLOW_EVENTS` 只携带 `{ field, mime, category, transferId }`。后台确认所有片完整且属于当前文档后，用 Blob 组合为 store 输入；不会把大正文再放进最终消息，也不在最终事件写入前创建原始 store 内容。最终批次重试保留原幂等路径。
5. 总传输声明容量与已排队写入共同受本批 queuedBytes 限制；传输数量也有界。每个事件将自己的传输预留同步转交 append 队列，未提交的其他正文继续保留预留。导航与 Stop 清除未完成传输并记录 coverage gap，超出队列上限停止接纳，不假报已采集。

CDP 网络正文直接到后台，不经过内容脚本消息；CDP 返回完整字符串的物理内存行为仍没有流式硬限额承诺。

## 验证与边界

从 `app/` 执行：

```sh
node --test tests/flow-background.test.js tests/flow-content.test.js
```

最终 **51 / 51 通过**。对应 [后台测试](../../../app/tests/flow-background.test.js) 与 [内容测试](../../../app/tests/flow-content.test.js) 覆盖：

- 1 倍既有断言与新默认 20 倍；非法 0／21／小数／字符串／错误 schema／额外字段，以及存储失败与权限拒绝。
- 录制中保存不改变本批，下一后台实例从同一存储读取新的设置；后台不修改固化预算字段。
- 3 MiB CDP 响应在 20 倍可接受，1 倍在已知长度预检时跳过。
- ASCII 3 MiB（24 片）与跨片 emoji，实际调用后台 handle 拼装 Blob，比较原文与 SHA-256；测试片数从内容脚本源码读取，覆盖两端协议常量不一致的回归。
- 大 DOM／输入实际输出的小片消息、真实逐片 ACK、最终消息仅引用、不完整或错误 ACK 不假报成功。
- 20 倍扩大节点、CSS、内容数和队列，深度和检查点节流保持固定。
- 重复片／批次、乱序、旧所有者、未完成引用、导航和 Stop 清理，以及声明 40 MiB 但不实际分配的预留超限边界。
- 原 R1（所有者／nonce）、R2（逐文档注入）、R3（瞬态原文）和根流程范围回归。

四个源码／测试文件的 `git diff --check` 通过。这里只记录纯测试；声明 40 MiB 的虚拟预留测试不能证明实际 40 MiB 或满 1.25 GiB 采集性能。本任务未操作真实 Chrome。父任务负责重建后真实侧栏保存／重开、录制、停止、导出及大于 64 MiB 批次验证，其证据需另记。
