# F02：下载确认有界恢复修复

## 状态

- **源码稳定**：指定 Node 测试实际通过后已立即通知父协调者可开始 final build / matrix；本子任务不运行发布构建。
- 原工作区 dirty 已保全；只修改下载实现并新增 synthetic 恢复测试，以及本报告。现有下载测试的 4 项断言完全未改。
- 无新依赖、无 UI 按钮、无 Chrome 启动、无用户下载访问、无 secrets 读取、无 AgentTeams / 再委派 / 提交 / 推送。

## 改动范围

```text
app/src/downloads.js
app/tests/download-recovery.test.js
docs/交付/2026-11-13/native-release/download-repair.md
docs/交付/2026-11-13/native-release/download-repair.json
```

原下载测试只执行，未编辑；sidepanel / archive / package / build 未触及。根 README、CHANGELOG 与发布构建由父协调处理。

## 行为与边界

保持原两参 API，第三参仅可选：

```js
downloadBlob(blob, filename, options = {})
// options:
// launchTimeoutMs = 15000
// completionTimeoutMs = 180000
// pollMs = 1000
// searchTimeoutMs = 15000
// cancelTimeoutMs = 1000
// signal, setTimeout, clearTimeout (optional injection)
```

这些计时只约束 **Blob 已生成后的下载启动 / 确认**，不是 ZIP 生成、录制或压力测试 SLO。计时依赖 JS 调度，浏览器挂起期间并非严格墙钟保证。

1. **启动有界**：download promise 超出 15 秒即报告启动结果未知并释放 URL；仍观察其 eventual settlement。若稍后取得有效旧 id，仅对该旧 id 作 best-effort cancel，不能改写重试操作结果。未知 id 时无法保证取消已发生。
2. **确认有界**：先装 onChanged / onErased 监听，再首次 search 保留早终态 / 事件查询竞态保护；随后串行轮询，每次 search 独立 15 秒 deadline，整体确认 180 秒 deadline。状态只接受 complete / interrupted；paused / in_progress 不会误判成功。
3. **清理真实发生**：所有终态、超时、abort 均移除本次监听、清理本次 timers。没有用 Promise.race 单独假装底层 Chrome 工作已取消；无法实际 abort 的 Chrome promise 仍挂有迟到结果 / rejection 观察器。
4. **URL 使用边界**：正常成功等 complete 后才 revoke；已知 id 的错误先请求 cancel 并至多等 1 秒 acknowledgement，再 release，避免无限持有 URL。若 cancel 不响应或拒绝，不把请求等同于完成。未知启动超时没有 id，只能有界释放并明确未知。
5. **重试保留**：不删本地批次，不修改或消费调用方 Blob；新操作独立闭包，旧 search、旧事件、旧启动 id 不会 settle 新操作。可选 signal 不新增任何 UI。

未确认时的文案明确：**“下载最终状态未知，请检查浏览器下载列表后重试；取消不代表文件已删除”**。本修复不声称已经删除任何文件，也不保证未知 launch 的系统侧工作已经停止。

## 实际执行验证

原生 Windows 主机，Node **v24.22.1**，cwd 为 app：

```text
node --test tests/downloads.test.js tests/download-recovery.test.js
exitCode: 0
tests: 11
pass: 11
fail: 0
cancelled: 0
skipped: 0
duration_ms: 131.4738
```

另执行 scoped git diff --check，exitCode **0**，无 whitespace 错误；Git 仅提示下次触碰时可能 LF→CRLF。恢复测试为新文件，直接由上述 Node 命令真实执行，未添加依赖。

### 覆盖

- 原 4 项保留：完成前不 revoke / 忽略其他 id、中断清理、监听前已结束、erase / query 失败 / event-query 竞态。
- 新 7 项：漏终态事件的轮询完成；in_progress + paused 的整体超时及原 Blob 重试；第二次 search 独立 deadline 及旧结果隔离；launch timeout 后 late id 仅取消旧操作；cancel promise 不响应的资源上界与迟到拒绝观察；signal abort 与预先 abort 清理；精确默认 15s / 180s / 1s 确认。

所有下载 API / URL 和数据为 synthetic mocks。未启动真实浏览器、未触及用户下载；真实 release 编译与 full matrix 归父协调者执行，因此本报告不代替其结果。
