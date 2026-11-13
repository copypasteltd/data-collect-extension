# Windows 原生本地 release 打包

## 范围与状态

本轮只新增[打包脚本](<../../../../app/scripts/package-release.mjs>)与[合成项目回归测试](<../../../../app/tests/package-release.test.js>)，使用已存在的 `fflate`，不新增依赖、不联网、不调用外部 provider 或 token、不创建任何隔离环境、不提交/推送、不发布远程 Release。版本变更、真实构建及插件验收由父任务负责；脚本不修改版本、不执行构建或测试。

**已执行的仅为打包工具测试**：2026-11-13，当前 Windows 原生环境，在 `app` 执行：

```powershell
node --test tests/package-release.test.js
```

结果：**8 passed / 0 failed / 0 skipped**，本次用时约 3.816 秒。测试只在 `app/test-package-release-*` 临时合成项目内写文件和运行 CLI，随后删除本次 fixture；未改动真实 dist、未生成真实 release。该结果不是扩展全功能、浏览器场景或性能验收结论。

## 父任务收尾命令

在父任务完成最终版本、真实构建、测试，以及当前安装说明、release notes、验收报告后，从 `app` 执行：

```powershell
node scripts/package-release.mjs --include-install-doc --release-notes --verification-report "docs/交付/2026-11-13/native-release/VERIFICATION.json"
```

验收报告参数从**仓库根目录**解析，仅接受当前 `docs/交付/2026-11-13/native-release/` 下的普通 `.json`、`.md` 或 `.txt` 文件；不接受绝对路径、向上跳转、其他日期/历史报告。脚本记录该文件的真实字节大小与 SHA-256，**不解析或猜测通过的 gates，不把 hash 当作验收通过证明，也不复制报告正文**。独立验收报告由父任务连同本地交付一起提供。

可选项只有：

- `--include-install-doc`：读取[当前安装说明](<../../../插件安装与使用说明.md>)，作为 release 根目录独立 `INSTALL.md`。
- `--release-notes`：读取本目录由父任务准备的当前 release notes，作为 release 根目录独立 `RELEASE-NOTES.md`；不读取历史 CHANGELOG 或其他旧交付报告。
- `--verification-report <项目相对路径>`：仅记录上面说明的报告 size/hash；没有报告时仍记录明确打包输入的聚合 hash，但不宣称通过测试。
- `--help`：打印帮助，不打包。

输出固定为 `app/release/v<package.version>/`，v0.3.0 时包含：

```text
logic-recorder-chrome-v0.3.0.zip
extension-logic-clone-v0.3.0.zip
SHA256SUMS.txt
release-manifest.json
INSTALL.md          # 仅 --include-install-doc
RELEASE-NOTES.md    # 仅 --release-notes
```

**版本目录必须不存在**。脚本使用独占目录创建，不支持 `--force`，不会删除或覆盖已存在的任何 release（包括旧版本）。如需重打同一版本，应先由父任务核对并取得对那个确切输出目录的处理授权。脚本只在本次新建目录写入失败时清理自己新建的目录。

## 允许输入与安全边界

- 扩展 ZIP 根目录就是可加载目录，不额外包一层文件夹；仅允许 manifest、三入口（background/content/sidepanel）、4 个约定尺寸图标及构建生成的 JS/CSS assets。缺任一入口/图标/sidepanel JS 或存在未知普通文件即拒绝。核对 public 与 dist 的 manifest version 均严格等于 package version，不自动修正或重贴版本。
- 技能 ZIP 仅有独立 `extension-logic-clone/` 文件夹：技能说明、agents YAML、references Markdown、scripts Python。忽略 Python 编译缓存，不装入插件构建产物或安装说明/报告。
- 路径是受检相对 POSIX 路径：禁止绝对路径、盘符、反斜线、空路径段、`.`/`..`、控制字符、Windows 保留设备名、尾随点/空格和大小写冲突。拒绝输入根及读取路径中的 symlink/junction 和特殊节点；不沿 symlink 打包。
- 固定 roots 不遍历仓库根；排除 profile、tests、node_modules、录制/导出、用户数据、凭据、隐藏文件和 `.env`。未知普通代码文件 fail closed，不用“把 app 整树压缩”的方式兜底。
- 使用同步 `fflate.zipSync` 仅处理小型代码包：单文件最多 16 MiB，输入清单最多 512 项、合计最多 64 MiB；不用于大录制包。ZIP 文件排序和条目时间固定，相同字节输入生成确定结果。
- 这是打包输入及命名范围控制，不是任意文本内容的秘密扫描器；父任务仍应确认运行文件与两份选入说明没有真实用户数据、凭据或本机路径。报告只记录 hash，正文不会意外混入 ZIP。

## 校验清单含义

`release-manifest.json` 记录版本、两 ZIP 的大小/SHA-256、每个 ZIP 条目的相对路径/大小/SHA-256、可选独立说明的大小/SHA-256，以及打包输入的有序路径/大小/SHA-256 聚合值 `provenance.sourceInputHash`。聚合使用 UTF-8、两空格缩进 JSON 加尾随 LF；输入包括 package、lock、public manifest、实际装包的 dist/skill 文件和显式选入的说明，不代表所有源码或整个 dirty 工作树已被扫描。若提供父任务验收报告，还绑定该报告大小及 SHA-256，但不重写其结论。

`SHA256SUMS.txt` 覆盖两 ZIP、release manifest 和可选独立说明，不自我校验。校验发现字节变化，不证明发布者身份、来源可信或全功能验收。CLI 标准输出只包含固定项目相对输出位置、生成文件名、大小和 SHA-256，不写本机绝对路径。

## 可导入 API

全部导出在[打包脚本](<../../../../app/scripts/package-release.mjs>)；import 不执行 CLI、不读工程文件、不写包：

```js
import {
  sha256, validateArchivePath, createArchive, createReleaseArtifacts,
  collectReleaseInputs, packageRelease, runCli,
} from "./scripts/package-release.mjs";
```

- `validateArchivePath(path)`：纯路径校验，成功原样返回，否则抛错，不对危险输入先规范化。
- `createArchive([{path, bytes}])`：纯内存确定性 ZIP；bytes 为非空 Uint8Array/Buffer。
- `createReleaseArtifacts(inputs)`：纯内存生成 `{version, manifest, files}`；files 为 `{path, bytes}` 列表。输入包括 version、extensionFiles、skillFiles、sourceFiles、可选 documentation（仅两个固定说明名）、可选 verificationReport（size/sha256）。
- `collectReleaseInputs({appRoot?, includeInstallDoc?, releaseNotes?, verificationReport?})`：只读固定输入，返回上述纯函数需要的数据；appRoot 仅用于程序调用/合成测试，不是 CLI 任意输入目录开关。
- `packageRelease(options)`：显式写固定版本目录，返回纯结果及相对 `outputPath`；不覆盖。
- `runCli(argv?)`：显式 CLI 入口；脚本只有直接执行时进入此入口。

8 个回归覆盖：路径攻击和凭据命名、40 组字节压缩/解压 roundtrip 与顺序确定性、产物与条目 hash、排除非交付数据、版本/入口/图标/provenance 拒绝、真实 Windows junction 拒绝、独立说明与既有版本保护，以及 import/help 无写入和 synthetic CLI。
