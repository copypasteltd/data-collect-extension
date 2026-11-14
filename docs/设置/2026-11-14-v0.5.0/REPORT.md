# v0.5.0 可配置20倍限额：交付报告

**已实现用户页面设置，并以用户最终20倍指令替代先前200倍讨论。默认和可设最大均20；单批1280MiB=1.25GiB（约1.2GB）。** 这是本地交付和同路径更新，不自动公开新GitHub Release。

## 使用

在侧栏展开“录制限额设置”，分别修改容量、待处理队列、页面采样倍率，取1–20整数，点击保存。重开仍保留；录制中也可保存，但仅下一批生效。当前批次固化启动设置，旧无settings批次仍按原1倍，不重写旧数据。未保存/非法草稿不能开始新批次，停止保持可用。

## 默认20倍

| 项目 | 数值 |
| --- | ---: |
| 总预算 / 提醒 | 1280 / 960MiB |
| 普通接纳 / 收尾预留 | 1260 / 20MiB |
| 单正文 | 40MiB |
| 正文 / DOM / 资源 / 截图 / 元数据 | 480 / 320 / 160 / 240 / 80MiB |
| 后台队列 | 1280项 / 160MiB |
| 页面队列 | 640项 / 120MiB |

总额与各子预算独立受控；不是ZIP大小或内存保证。权限、根流程范围、协议标识、递归深度与时间等待不放宽，没有新增时长自动停止。

## 完整链路

flow-config唯一派生配置，设置持久本地；START读取一次固化至capturePolicy/budget/runtimeLimits。采集、后台、存储、分页导出和读取skill都按本批快照，不以当前设置重新解释旧批。

长输入/页面走有确认的小片消息，不单次发送巨型JSON；SHA256/CRC按块计算，存储原子接纳，导出游标分页、OPFS临时磁盘写入。下载结束/失败清理本次输出，不清录制。ZIP采用STORE流式写入，可能比旧deflate ZIP大；无OPFS仅允许128MiB内存回退。

## 最终实际验证

| 验证 | 结果 |
| --- | --- |
| 完整JS回归 | 500/500，0失败/取消/跳过 |
| Flow专项 | 127/127 |
| Python读取器 | 58/58，最终实跑39.790秒 |
| 原生设置页 | 默认20、非法21/小数/空、保存1重开、录中保存20保持本批1、下一批20、真实坏存储schema错误且Stop可用、dirty Stop均通过 |
| 原生1倍业务批 | 18events/7contents，3MiB正文按旧策略不采；ZIP56831B |
| 原生20倍业务批 | 18events/9contents，3MiB正文/页面、长Unicode前后值与forms按原hash精确；ZIP12970969B |
| 长内容运输 | 130片，最大完整消息327997B，value/beforeValue/forms/DOM均取回，无代理字符跨片断开 |
| 旧64MiB边界以上实测 | 原生保存75499309B、唯一内容72MiB，OPFS磁盘File导出75511309B，约4909ms；Python核验通过 |
| 320px界面 | 无横向溢出，真实扩展页面截图保存；不是原生侧栏drawer外观认证 |
| 精确交付ZIP | 扩展11文件、skill10文件hash一致，原manifest解压加载通过，包内reader读取实际20倍记录通过 |
| 本地skill | DSH/Codex各10文件与项目一致，两个安装内脚本五类原字节读取通过；当前DSH重载确认v0.5.0 |

两批Stop约1985/1389ms、Export约2125/1497ms为本机固定样本，不是任意规模性能保证。所有自建测试浏览器/profile关闭清理确认；未访问用户真实录制。

## 验收中关闭的问题

独立限定审查两项：长文本发送/接收片字符上限不一致导致合法ASCII被拒；reader未落实每条事件/引用的派生限额。均先以实际handle/CLI复现，再修正并验证反例翻转。最终审查scoped_pass_source，无未关闭finding；独立源码复验不冒充原生或最大满载验证。测试自身早期读设置未等待、巨值fill耗时、worker旁听无效均如实保留在阶段记录，最后以真实发送端透传观察和原字节证据复验。

## 当前本机安装

原[插件目录](<C:/Users/carzy/Downloads/logic-recorder-chrome-v0.3.0/>)已备份15原文件/遗留资源，并更新为0.5.0（11新文件核验）；[备份](<../../../app/release/install-backups/logic-recorder-v0.4.0-before-v0.5.0-yLuGvg/>)。没有刷新/开启Chrome原扩展、没有启动录制、重启或清数据。请在chrome://extensions对原“逻辑记录”重新加载，确认0.5.0后使用。目录不用改名。

[程序安装回执](<INSTALLATION.json>) · [skill安装回执](<skill-installation.json>)

## 边界

- **最大1.25GiB整批未做实际满载压测**；72MiB实测与虚拟大数/ZIP64边界不能冒称最大规模通过。
- 大值输入使用合成beforeinput/input/change构造，普通1倍输入及业务按钮为真实浏览器操作；不把程序事件称可信真人逐键录入。
- 尚未自动验证原生授权弹窗、最低Chrome125/macOS/任意真实客户站点。
- STORE导出可能更大，OPFS需实际磁盘，浏览器配额/连接/保存异常仍明确报错。
- ready/partialfalse/hash并非全覆盖或来源认证，已知policy/coverage/未采继续保留。
- 不恢复重型全profile、计算样式、主题/字段派生、全库/Cache/Storage镜像。

[安装使用](<INSTALL.md>) · [更新说明](<RELEASE-NOTES.md>) · [设置验收](<settings-acceptance.json>) · [大包验证](<large-export.json>) · [独立审查](<review.md>) · [机器验证](<VERIFICATION.json>) · [精确包检查](<package-smoke.json>)
