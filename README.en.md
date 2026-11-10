# Logic Recorder

Record authorized browser workflows from the Chrome side panel and export a selected recording as a ZIP archive.

[中文](README.md) · [Installation and usage (Chinese)](docs/插件安装与使用说明.md) · [Technical design (Chinese)](docs/Chrome扩展技术开发文档.md) · [Requirements (Chinese)](docs/Chrome扩展需求梳理.md) · [2026-11-11 Update Specification (Chinese)](docs/20261111内容更新细则文档.md) · [Changelog](docs/CHANGELOG.md)

> This is a **0.1.6 development preview**. It records only visited and observable activity. Browser restrictions, permissions, timing, and size limits can cause gaps; it cannot guarantee reconstruction of a whole website or its server source.

## Demo

![Recording, choosing a batch, and exporting in the side panel](docs/media/workflow.gif)

[Watch MP4](docs/media/workflow.mp4) · [Watch WebM](docs/media/workflow.webm) · [Demo media](docs/DEMO.md)

| Ready | Recording | Select a batch |
| :---: | :---: | :---: |
| <img src="docs/media/01-ready.png" width="220" alt="Ready to record"> | <img src="docs/media/02-recording.png" width="220" alt="Recording"> | <img src="docs/media/03-history.png" width="220" alt="Select a recording"> |

The demo uses fictional local data in an isolated test browser. The side panel only starts and stops recording, selects a batch, and exports it; it does not display recorded content or provide in-extension viewing, importing, or replay.

## Install

Chrome 125 or later is required. Download `logic-recorder-chrome-v0.1.6.zip` from [GitHub Releases](https://github.com/copypasteltd/data-collect-extension/releases), extract it, open `chrome://extensions`, enable Developer mode, select “Load unpacked,” and choose the extracted directory containing `manifest.json`.

To build from source instead, you also need Node.js 20 or later and npm:

```powershell
cd app
npm ci
npm run build
```

Open `chrome://extensions`, enable Developer mode, choose “Load unpacked,” and select `app/dist` in this project. Click the extension icon to open its side panel. After changing source files, rebuild and reload the extension.

## Use

1. Open an HTTP or HTTPS page you are authorized to record and click the extension icon.
2. Click “开始录制” and grant Chrome's website access request. The extension attempts to record all authorized ordinary pages, including pages already open and those opened later.
3. Work normally and click “停止录制” when finished. You can also stop during preparation; saved data is kept as an interrupted batch. Recording or finalization continues in the background if the side panel closes; exiting the browser may interrupt the batch.
4. Select a completed or interrupted batch under “录制批次” and click “导出记录包”. Select other batches to export them separately. Interrupted batches contain only data saved before interruption.

Batches and ZIP files stay local; the extension does not upload recordings. Uninstalling the extension may remove its local data, so export batches you need first.

With many or slow pages, preparation continues in the background while the side panel shows “准备中”; Stop remains available. A temporary batch-list read failure does not block status updates or Stop, and its message clears when reading recovers.

If the worker cannot restore an active recording after a restart, Stop attempts to close collectors and mark the batch interrupted. If local storage cannot be written, the side panel reports the archival failure; batches can be read again after storage recovers, and completed batches are not overwritten.

If session state cannot be read, the extension attempts to stop using saved batch information. When another unfinished batch exists or ownership cannot be confirmed, it asks the user to wait for state recovery to avoid stopping the wrong batch. Unconfirmed collector readiness or shutdown is recorded or reported; interrupted recordings contain only saved data.

## Recorded Data

The extension attempts to capture in-scope pages, actions, screenshots, requests and responses, cookies, site storage, and accessible resources. New recordings retain browser-provided values without masking passwords, authentication fields, or screenshots. Each page snapshot separately stores a serialized DOM, which is not the original HTTP byte stream and excludes Shadow DOM and live form values not reflected in attributes.

Archives may contain passwords, credentials, personal information, and business data. **ZIP files are not encrypted and anyone with a copy can read them.** Record only authorized pages and handle archives accordingly. Values hidden in older recordings cannot be recovered.

### ZIP Layout

```text
manifest.json                 Batch metadata, status, event chunks, and limits
integrity.json                File sizes and SHA-256 checksums
timeline/events-00001.jsonl   Chunked actions, pages, network, and state events
screenshots/                  Captured screenshots
resources/index.json          Resource index
resources/                    Captured images, fonts, and other resources
```

`page.snapshot.payload.sourceHtml` holds the serialized DOM; `html` is a separate sanitized snapshot, and `sourceStatus` describes whether the DOM was captured. Network events use `requestId` to associate requests, responses, and outcomes. When text decoding fails, browser-provided bytes may be retained with `encoding: "base64"` and a `textStatus`. Checksums detect changes but do not establish authenticity or provide encryption.

## Recording Analysis Skill

The repository includes [`$extension-logic-clone`](app/skills/extension-logic-clone/SKILL.md) to validate archives, trace page and request evidence, and rebuild observed workflows when requested. It runs outside the extension and does not change the side-panel interface. Its indexing tool requires Python 3.9 or later and uses only the standard library.

Alternatively, download `extension-logic-clone-v0.1.6.zip` from [GitHub Releases](https://github.com/copypasteltd/data-collect-extension/releases), extract its `extension-logic-clone` folder into the current user's `.codex/skills/` directory, and start a new Codex session.

From the repository root in Windows PowerShell, install it into the current user's Codex skills directory:

```powershell
$skillRoot = Join-Path $env:USERPROFILE '.codex\skills'
New-Item -ItemType Directory -Force -Path $skillRoot | Out-Null
$skillTarget = Join-Path $skillRoot 'extension-logic-clone'
if (Test-Path -LiteralPath $skillTarget) { throw 'Skill directory already exists; inspect it before updating' }
Copy-Item -LiteralPath '.\app\skills\extension-logic-clone' -Destination $skillTarget -Recurse
```

Start a new Codex session and provide the ZIP and output location, for example:

```text
$extension-logic-clone Analyze D:\recordings\session.zip, document the observed pages, actions, and requests, and rebuild the observed workflow in D:\work\reconstruction.
```

To build a queryable index directly, choose an output file that does not already exist:

```powershell
python .\app\skills\extension-logic-clone\scripts\index_archive.py D:\recordings\session.zip --output D:\work\recording-index.sqlite3
```

The index contains complete raw events and may include passwords and credentials; do not commit it to a repository. See the [skill guide](docs/技能使用说明.md) for reading rules, queries, and limits.

## Limitations

- Activity before recording starts cannot be recovered. Restricted pages, cross-origin frames, debugger interruptions, and data unavailable to Chrome can create gaps.
- Screenshot frequency, active-tab state, and timing can cause shared or missing screenshots. Canvas capture is static and best effort.
- Snapshots, DOM, input, request and response bodies, databases, and resources have size or count limits. Gaps are recorded in events and batch metadata. File contents, cached responses, and intermediate database changes are not guaranteed.
- A recording can support analysis of observed paths; it cannot guarantee recovery of unvisited branches, original source, server logic, or a deployable copy of a complete site.

See the [usage guide](docs/插件安装与使用说明.md) and [technical design](docs/Chrome扩展技术开发文档.md) for details.

## Development

```powershell
cd app
npm ci
npm run build
npm test
npm run test:e2e
npm run test:startup-tabs
npm run test:startup-many-tabs
npm run test:status-isolation
npm run test:attach-stop
npm run test:stop-lifecycle
npm run test:recovery-stop
npm run test:stop-review-regressions
npm run test:stop-timeout
npm run test:query-parameters
npm run test:response-encoding
npm run test:skill
```

Browser tests need Playwright Chromium. Run `npx playwright install chromium`. To check HTTP recording and the extension error list in official Chrome, set `CHROME_BIN` to the Chrome executable and run `npm run test:chrome-errors`. The skill test needs Python 3.9+. Tests use fictional local data and close their own browsers and temporary services. Docker and WSL are not used. Earlier viewer-related files in `app/tests/` remain as historical references and are not current side-panel test entry points.
