# v0.3.0 问题闭环与合理取舍

本版是用户要求的本机原生release，不声称所有研究型优化已经实现。依据[本版需求](<REQUIREMENTS-v0.3.0.md>)将问题分为已修正确性、已明确产品取舍与未承诺的扩展；真实结果见[验收报告](<RELEASE-REPORT.md>)。

| 原根因 | 本版处理 | 对应验证/边界 |
| --- | --- | --- |
| ARCH01 负载/价值门 | 收口当前Windows+合成本地ERP与实际负载，先证据闭环再承诺规模 | ERP5请求/余额及60s样本；不承诺任意网站和无限容量 |
| ARCH02 完成/质量混用 | 状态提示和sticky核验事实独立，ready非完整；说明保留缺口 | 控制/批次单测与真实ERP screenshotUnavailable保留 |
| ARCH03 全量重采 | 保留多表示独立证据和现有防抖/busy，按本次已测档位交付 | 不强行删通道或声称已实现全域dirty增量；性能成本已实测披露 |
| ARCH04 全会话资源预算 | 现有局部预算、超载/未确认标记与有界收尾保留，冻结实际支持样本 | 不把分段说成全包有界，也不扩大上限；无限负载非本版保证 |
| ARCH05 页面扰动 | 明确native合成负载与原值/服务端oracle对照，不声称零开销 | 性能只样本，精确峰值/真实ERP输入延迟不伪造 |
| ARCH06 批次/分段结果 | 独立Outcome、unknown与拒绝分层、sticky中止、JS/Python/归档统一End/Failure/latePart | 共享golden/下载及delivery单测、真实event确认/重试/超时、矩阵 |
| ARCH07 seal写门 | closeAdmission/IDB fence/唯一stop/seal同事务计数水位/导出revision核对 | 终态不新增证据、旧批无seal不补造；真实停止组及单测 |
| ARCH08 任务跨会话 | owner registry、每会话写链、显式owner派生、不重认active | late A frames到B反例及真实多批/恢复组 |
| ARCH09 附件/恢复提交 | 保留asset先成功后引用、writer gate和诊断合并；失败可中断保留 | 不宣称实现跨Chrome/IDB分布事务或全stage GC；缺引用/计数拒导出 |
| ARCH10 全日志控制面成本 | 有界读取/封存read deadline，故障后可停止重试 | metadata checkpoint/流式coverage为更大档位未来优化，不作完成承诺 |
| ARCH11 导出控制权 | export busy与Stop分离、录制不新历史导出；Blob下载确认poll/deadline | 完整持久ExportJob/跨面板续打包未作为本版保证；失败保原批次 |
| ARCH12 整包sink | 单包大小/事件/附件兼容上限和实际样本如实声明 | 不称任意包固定内存或使用Worker即解决；当前ZIP接口不擅变分卷 |
| ARCH13 版本/兼容 | producer创建时持久、exporter/派生可选来源字段，unknown旧版不改造 | 兼容v1/v2、跨端golden；无全事件schema/握手已完的假声明 |
| ARCH14 来源字典 | origin/session/document/显式storage身份保守namespace、fallback同投影 | 同名跨域/未知partition等unit及真实打包consumer |
| ARCH15 时钟/seq | 文档区分观察/接纳提交，幂等existing不动、missing可获新seq | 不把seq洞或时间相近当缺失/因果，原始protocol时间保留 |
| ARCH16 保留清理 | 保留既定四操作；明确无自动到期、更新前导出、卸载/副本责任 | 不自动删除原值，不擅增删除UI；用户本版要求优先可交付 |
| ARCH17 耦合测试 | 提取Outcome/task/lifecycle/diagnostics/identity/cleanup helper及针对性回归 | 渐进小模块，不全项目换语言/框架；核心交叉独立review |
| ARCH18 结果/构建绑定 | source/dist前后身份、版本一致、日志哈希、包manifest与验收报告绑定 | hash非签名/原子构建attest；实际source相同完整矩阵才算通过 |
| ARCH19 runner/cleanup | 有限场景/整轮/清理、合作ACK、仅己有句柄、profile逐attempt门 | 不建OS沙箱；其它资源硬限非本版承诺，先失败后修透明记录 |
| ARCH20 producer能力 | iframe递归/网络与stream观察保持，未知/不可得据事件披露 | 不宣称网站worker全覆盖、真实GPU/所有协议均已测 |

## 发布阻断与非阻断

本版阻断：编译/完整JS或Python/必选矩阵/业务闭环/包校验失败，或者包中出现敏感/非交付文件。必须修复并复验；不能删必要断言造绿。

非阻断但必须说明：浏览器客观不可观察范围、非原子采样、最低Chrome和macOS未真测、当前不提供额外产品入口、超过实测档位的性能/长期架构优化。它们不是用来掩盖已知必需功能失效，而是本版如实的支持边界。
