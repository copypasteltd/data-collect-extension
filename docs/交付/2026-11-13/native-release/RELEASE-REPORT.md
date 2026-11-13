# 逻辑记录 v0.3.0 原生 release 验证报告

**结论：本版原生Windows本地release的规定验证已通过，两个安装/工具包已生成并完成实际解压加载和包内CLI检查。** 不等于macOS、原生权限弹窗或任意业务站点/无限规模已验证。

本版按用户要求直接在当前Windows原生环境修复、编译并测试，不建设或切换隔离环境。只用本地合成数据和测试自己的浏览器目录。

## 实际结果

| 验证 | 结果 |
| --- | --- |
| v0.3.0生产构建 | 通过 |
| JavaScript完整回归 | 310/310通过，0失败/取消/跳过 |
| Python消费者 | 12/12通过 |
| 完整采集矩阵 | 50/50通过，0失败/跳过，source/dist前后身份一致 |
| Chrome生命周期重点组 | 最新9/9命令通过，21次执行与6次失败历史保留 |
| 合成ERP业务闭环 | 5HTTP、原值/余额/DOM/PNG/seal/索引通过 |
| 下载确认恢复/打包工具 | 11项与8项通过，包含在JS总数中 |
| 精确ZIP解压加载与包内技能CLI | 实际通过：扩展11文件/技能7文件hash一致，原包加载、Python321事件/36文件校验通过 |

## 环境与候选

Windows x64 / Chrome157.0.8103.40 / Node24.22.1 / npm10.9.2。

sourceDigest：903dc44df10cf673cc39fbceccd0b51a9d7b53dab2f1ff71d482c93f1eea1e2c

distDigest：86b0892571eaacae36e6249e775b97d39f733be1f624f7c554246d644363dbd8

全部输入文件与证据hash见[VERIFICATION](<VERIFICATION.json>)，不是数字签名或可复现构建attestation。

## 合成ERP实证

会员查询、资料PUT保存、扣12800分成功201、扣999999分拒绝409、最终GET。成功写2次/尝试3次，余额100000→87200，拒绝不改变余额。321events、15assets、5有效PNG显式关联业务click；保留screenshotsUnavailable=1，不声称每click独立图。外部Python验证36文件hash与321事件，SQLite只读回查一致。Stop1850ms。

## 最终持续录制样本

60秒、额外300节点、每次120000字节响应、1500ms间隔，35次输入/请求逐条核对。停止15755ms；导出30105ms；ZIP22815318字节；外部索引5192ms。

Chrome工作集抽样903716864–1036910592字节，包含浏览器自身、不是精确峰值或插件独占内存，不外推任意站点。

## 首次失败与修复

- Legacy test load-extension flags replaced by the existing current-Chrome harness while retaining behavior assertions.
- Native fault testing found an actual unbounded seal-watermark read; production now uses a 5000ms deadline and the original permanent-read fault passes.
- Seal cleanup phase and failed/unknown wording assertions were updated and strengthened; append-only fault injection hooks add, not put.
- New ERP test removed an unsupported input.trusted assertion but retained before/after raw values and trusted business clicks, and waits for actual recorded checkpoints rather than async predicate truthiness.
- Native matrix Known Folder redirection prevented remote debugging; native-host environment projection fixed it without production behavior changes.
- A prior matrix was invalidated by intervening test/doc changes; another stopped after a test-owned Chrome exit exceeded a one-second cleanup wait. The final full run uses a bounded five-second exit wait and unchanged identities.
- One workload attempt returned nonzero during a transient PowerShell PID census despite numeric output. The unchanged final workload subsequently passed; the failed log is retained.

## 支持边界

- No macOS, physical minimum Chrome125 or real customer ERP execution
- No native permission-dialog acceptance/denial automation
- No arbitrary duration/size guarantee or zero-overhead claim
- Canvas/tiled/state captures are not a global atomic snapshot and recorded gaps remain
- Hashes prove byte consistency, not publisher authenticity or source-to-build attestation
- Full resumable ExportJob, automatic deletion and unlimited scaling optimizations are not claimed as delivered guarantees

[本版需求](<REQUIREMENTS-v0.3.0.md>) · [01–26证据映射](<ACCEPTANCE-01-26.md>) · [问题闭环](<FIX-CLOSURE.md>) · [生命周期](<lifecycle-verification.md>) · [ERP](<erp-verification.md>) · [下载](<download-repair.md>)
