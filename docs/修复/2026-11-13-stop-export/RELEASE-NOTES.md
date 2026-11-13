# v0.3.1 停止／导出修复

## 修复

- 修复普通大页面Stop后，9秒末次采集预算造成的已知producer缺口被混成通信未知/录制中断。已完成用户停止且封存成功时保留ready和completed_with_gaps，显示已停止需核验；不抹除captureIncomplete、needsVerification及coverage缺口。
- 保留真正存储、确定事件失败、提交未知、准备取消、早期未说明故障与清理未确认的interrupted，不靠改标签掩盖。
- 只读存储request、cursor、count、abort与15秒无回应均结算；45秒真实无进展结束归档等候，保留本地数据可再试。
- 预扫、原始事件、字段、附件及封存校验的实际计数/原数据量/用时可见，分块原生异步deflate-raw；旧浏览器fallback64KiB/level1且8ms协作让步，保持XML派生和所有原值。
- 深层数据库图派生路径预算明确partial，原始图及节点/直接字段全保留。新browserObservations派生标签3，旧producer版本不补改。

## 不删除旧记录的更新

停止后，覆盖原加载目录并在chrome://extensions刷新原扩展；不要卸载、不要清除数据，也不要用新目录加载第二份来代替原安装。数据库仍v3，不清库。旧interrupted批次继续按其原始状态导出，不擅改seal或状态。详见[恢复指南](<UPDATE-RECOVERY.md>)。

## 验证与范围

本机Windows Chrome157、全合成数据。正常2500行大页/10iframe/6tab/繁忙IDB五组停止与40秒内真实导出通过；旧中断+封存批次的故障count→abort/按钮释放→恢复重试全原值及存储不变验证通过；真正停止故障组仍通过。完整JS/Python/50场景结果以[报告](<REPORT.md>)和[VERIFICATION](<VERIFICATION.json>)为准。

此次浏览器桥未连接，未读取用户真实页面/录制，不宣称你当前那批数据已实际恢复；更新后可重试原批次。如仍出错，请提供当前阶段、计数、用时及固定错误文字，不必发凭据或录制正文。已发布v0.3.0字节和标签不变，本版仅本地修复交付，不自动公开新Release。
