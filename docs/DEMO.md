# 演示素材 / Demo Media

## 内容 / Contents

- `media/01-ready.png`、`02-recording.png`、`03-history.png`、`04-timeline.png`、`05-flow.png`、`06-replay.png`、`07-canvas.png`：扩展侧边栏真实界面截图。 / Screenshots of the actual extension side-panel interface.
- `media/sample-site.png`：本地示例业务页面。 / The local example business page.
- `media/workflow.webm`：Playwright 对侧边栏界面的实际录制。 / Actual Playwright recording of the side-panel interface.
- `media/workflow.mp4`：由 WebM 转码的 H.264 版本。 / H.264 transcode of the WebM.
- `media/workflow.gif`：由同一录制转换的循环演示。 / Looping GIF generated from the same recording.

示例站点由 `app/scripts/capture-readme.mjs` 在本机临时启动，只包含虚构数据；脚本使用独立临时浏览器配置，并在测试扩展的临时副本中预授予示例站点权限以便自动化。截图展示真实扩展界面，但不是对 Chrome 原生权限弹窗接受/拒绝行为的验证。脚本结束会关闭浏览器和临时服务，并清理本次创建的临时目录。<br>
The script starts a local fixture containing fictional data, uses an isolated temporary browser profile, and pre-grants host permission in a temporary extension copy for automation. The images show the real extension UI, but do not verify acceptance or denial of Chrome's native permission dialog. The script closes its browser and server and removes its own temporary directory.

演示站点包含虚构的画布图表；录制末尾展示侧边栏中的静态画布快照。画布采样和重放另由 `npm run test:canvas-snapshot` 验证。<br>
The demo site includes a fictional canvas chart; the recording ends with its static snapshot in the side panel. Canvas capture and replay are also verified by `npm run test:canvas-snapshot`.

## 重新生成 / Regenerate

在 `app/` 目录执行。以下示例使用 Bash；PowerShell 设置环境变量的写法见两个根目录 README。FFmpeg 命令需要 `ffmpeg` 在 PATH 中，MP4 转码还需要支持 `libx264`。<br>
Run from `app/`. The example uses Bash; see the root READMEs for PowerShell environment variables. The FFmpeg commands require `ffmpeg` on PATH and `libx264` for MP4.

```bash
npm ci
npm run build
export PLAYWRIGHT_BROWSERS_PATH="$PWD/.playwright-browsers"
npx playwright install chromium ffmpeg
npm run docs:capture
ffmpeg -y -i ../docs/media/workflow.webm -filter_complex '[0:v]fps=8,scale=420:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle' -loop 0 ../docs/media/workflow.gif
ffmpeg -y -i ../docs/media/workflow.webm -c:v libx264 -pix_fmt yuv420p -crf 23 -movflags +faststart ../docs/media/workflow.mp4
```

可以设置 `CHROME_BIN` 使用已安装的兼容浏览器；录制 WebM 仍需要 Playwright 的 FFmpeg 组件。命令会更新 `docs/media/` 中对应素材；重新生成后请检查图像、视频时长、UI 文字和隐私内容，再同步中英文 README 和更新说明。<br>
Set `CHROME_BIN` to use a compatible installed browser; WebM capture still requires Playwright's FFmpeg component. The commands update the corresponding files in `docs/media/`. Review images, video duration, UI text, and privacy contents, then update both READMEs and the changelog as needed.
