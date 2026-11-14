# 逻辑记录 v0.4.0：安装与使用

本正式发布包含Chrome扩展0.4.0和读取skill0.4.0.1。扩展无需Node/Python；读取工具只需Python3.9+标准库。

## Chrome扩展

解压logic-recorder-chrome-v0.4.0.zip到固定目录。打开chrome://extensions，启用开发者模式，加载直接含manifest.json的目录。更新已安装版本时先停止录制，备份程序文件，再覆盖原加载目录并刷新原扩展；不要卸载、清Chrome数据或另加载第二份。目录名可保留旧版名称。

先切到获准的业务页面，打开侧栏开始，等待就绪后操作；完成后停止、选择批次、导出。关闭侧栏不会停止后台录制。默认只跟踪绑定根业务标签、必要授权框架及一个有可信opener/操作/时间证据的业务子页，不自动包含其他标签。未授权来源/无法归因子页明确为缺口。

## 范围、容量与旧数据

保留关键操作/稳定表单前后、一个结构DOM、关键状态/短暂提示、必要CSS资源、视口PNG和业务接口样本。默认不采全profile、全计算样式/主题派生、Cookie/Storage/全IDB/Cache镜像、全页截图、Canvas另存像素、全JS/上传/实时消息正文。

单批总64MiB，48MiB提醒，普通63MiB+1MiB收尾；类别子预算body24/DOM16/resource8/screenshot12/meta4MiB，单正文2MiB。达到限额受控停止，已存内容保留且标部分；保存预算不是Chrome内存峰值保证。v3主导出不自动生成主题/字段分析。

新批次使用独立flow-v1库，旧库不打开、不迁移、不删除，旧批次不在新版列表显示。ready/hash通过不证明采集完整，应检查coverage/partial/policy/bodyStatus。

## 读取skill0.4.0.1

解压extension-logic-clone-v0.4.0.1.zip，把extension-logic-clone整个目录备份后放入实际skill安装目录；已有目录先比较，不覆盖其它skill。DSH使用其技能管理目录，Codex通常使用用户目录下.codex/skills。开启新会话或重新加载技能以发现更新。

```text
$extension-logic-clone 读取 <recording.zip>，先说明范围和缺口，再整理关键页面、输入前后和接口结果；本次只分析。
```

也可在skill目录手动运行：

```text
python scripts/index_archive.py recording.zip --output new-index.sqlite3
python scripts/read_content.py recording.zip new-index.sqlite3 --event-id <id> --field sourceHtml --output new-page.html
```

输出路径必须不存在。新工具核对ZIP身份、时间线事件与原字节，不执行HTML。v3使用bodyText/body/image/text/formValueN；v1/v2走历史参考，不给v3补造旧分段或全量字典。只有明确要求构建才复建本地样本流程，不对真实后台重放业务写。

## 文件与风险

完整交付包内SHA256SUMS.txt核包内文件；GitHub独立SHA256SUMS.txt还包含完整ZIP校验。哈希证明字节一致，不是来源签名。ZIP/SQLite可能含输入、认证头、个人与业务资料且未加密；不主动上传，须控制本机/备份和分享。

只覆盖已观察路径，不恢复服务端源码、登录态、全库、所有分支或绝对像素。Windows原生固定合成样本已测；最低Chrome125、macOS、原生授权弹窗和真实客户站点未自动验证。详见RELEASE-REPORT.md与VERIFICATION.json。
