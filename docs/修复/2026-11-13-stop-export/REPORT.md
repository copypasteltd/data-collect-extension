# v0.3.1 停止／导出检查与修复报告

## 结论

已用真实Chrome本地合成页复现并修复两个问题路径，完成当前修复候选编译和回归。没有接入用户当前浏览器或读取真实业务记录，因此不声称用户现场批次已实际恢复。

## 根因

1. 2500行普通页末次采集超过9秒producer预算，FLUSH返回failed0/unknown0且captureIncomplete；原后台误置communicationUnknown并将正常完成封存标为interrupted。现在保留所有gap，正常userStop为ready/completed_with_gaps，UI已停止需核验；真实存储/传输/清理/既有未说明故障仍中断。
2. 导出原流程读事务可无限pending、预扫缺进度、同步压缩卡主线程，深图路径复制成本平方增长。现在15秒只读guard、45秒无进展退出、原生异步压缩与8ms协作调度、准确阶段/数量/原数据量/用时；深路径显式partial但原始图不删。

## 实际验证

| 项目 | 结果 |
| --- | --- |
| v0.3.1生产构建 | 通过 |
| JS完整回归 | 373/373，0失败/取消/跳过 |
| Python消费者 | 12/12 |
| 完整采集矩阵 | 50/50，0跳过，前后source/dist身份一致 |
| 停止与导出五组真实页 | 全通过，未放宽40秒下载截止 |
| 旧中断/封存批次存储故障→重试 | 同冻结测试两次执行、两批均过，原值/附件/seal不改 |
| 真正中断/恢复故障 | 原五场景通过 |
| 侧栏双批录制导出 / ERP | 均通过 |
| 独立CRC/取消/legacy只读审查 | 限定通过，发现的先前故障掩盖问题已修 |

### 同五组修复结果

| 场景 | Stop ms | 导出ms | 原始事件 | 状态 |
| --- | ---: | ---: | ---: | --- |
| small | 854 | 1287 | 84 | completed |
| large | 11079 | 16205 | 491 | completed_with_gaps |
| multi-frame | 12178 | 17960 | 805 | completed_with_gaps |
| multi-tab | 10718 | 12319 | 618 | completed_with_gaps |
| busy-idb | 2889 | 1787 | 120 | completed_with_gaps |

2500行原始DOM规范行hash与修复前/独立fixture一致；事件数量随producer预算变化，不把样本计数变化说成采集全量提升。large仍保留captureIncomplete/styleGaps3等。首次候选64KiB逐块timer导致40秒导出失败，证据保留，最终改8ms调度且不增等待预算。

### 故障恢复

模拟count不返回，guard触发abort，释放按钮，不下载、不修改本地批次。恢复后legacy/sealed实际ZIP重试998/650ms，100ms心跳最大114.2/116.4ms；181events+2assets及seal前后不变，1501图节点/直接字段原样，深path明确partial。

## 安全更新

[UPDATE-RECOVERY](<UPDATE-RECOVERY.md>)：停止后覆盖原加载目录并刷新原扩展；不要卸载、不要清Chrome数据。旧interrupted批次不改状态，但可用修复导出逻辑重试。当前浏览器桥未接，用户真实批次成功仍待实际尝试。

## 候选与边界

sourceDigest：80a54a83a6536cfee1db8c7c3ac0625527a36f78264adb5fb2004dd88b3589c4

distDigest：adb893f3f8b8210b0d298910c019a6b587fad25e63fc0748a5d949fb04811236

[完整机器证据](<VERIFICATION.json>) · [停止反例](<stop-diagnosis.md>) · [导出恢复](<export-recovery.md>) · [独立审查](<review.md>) · [更新说明](<RELEASE-NOTES.md>)

15秒/45秒均为浏览器调度中的协作边界，不是大包总时长或挂起时硬时钟保证。旧v0.3.0已发布字节不变，本次不自动新建GitHub Release。最终安装包解压加载已实际通过：扩展11文件、技能7文件与当前候选hash一致，原manifest解压加载无页面错误，包内Python对本次ERP312事件/34文件完整性校验通过；详见[包检查](<package-smoke.json>)。
