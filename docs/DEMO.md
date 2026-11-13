# 界面与演示素材

## v0.3.1 停止／导出修复

[准备](<media/v0.3.1-01-ready.png>) · [录制](<media/v0.3.1-02-recording.png>) · [批次](<media/v0.3.1-03-history.png>)。真实本机Chrome合成页截图，保留v0.3.0历史图片不覆盖。由[修复版截图脚本](<../app/scripts/capture-hotfix-ui.mjs>)生成；进度行为通过[故障恢复测试](<修复/2026-11-13-stop-export/export-recovery.md>)实际观察，截图本身不是所有业务完整证明。

## v0.3.0 当前截图

- [准备录制](<media/v0.3.0-01-ready.png>)
- [录制中](<media/v0.3.0-02-recording.png>)
- [多批次选择](<media/v0.3.0-03-history.png>)
- [本地合成业务页面](<media/v0.3.0-sample-site.png>)

这些图片由真实编译的扩展和本机正式版Chrome生成，页面和会员均为本地虚构数据；显示四项操作、范围/原值/保留披露及核验状态。临时扩展副本预授站点权限以自动化，因此不证明原生权限弹窗接受/拒绝。本次按用户要求未建设OS隔离环境，测试专用profile只防干扰，不是隔离安全声明。

重新生成命令（app目录）：

```powershell
$env:CHROME_BIN='C:/Program Files/Google/Chrome/Application/chrome.exe'
npm run docs:capture
```

[capture脚本](<../app/scripts/capture-readme.mjs>)只启动本地HTTP样本及其自己的Chrome，结束后清理己有资源；不会关闭用户已有浏览器。不使用Docker/WSL。

## 历史0.2.0素材

原media/01-ready.png、02-recording.png、03-history.png及workflow.gif/webm/mp4保留作历史资料，不是当前v0.3.0界面或验收证据。当前README使用带版本的新图，避免旧演示误导。
