# Logic Recorder

Record authorized browser workflows and observable page/network evidence in Chrome, then export a selected batch locally. Current delivery: **v0.3.0**.

[中文](<README.md>) · [Installation](<docs/插件安装与使用说明.md>) · [Release verification](<docs/交付/2026-11-13/native-release/RELEASE-REPORT.md>) · [Changelog](<docs/CHANGELOG.md>)

## Deliverables

**Recommended: [complete release bundle](<app/release/logic-recorder-release-v0.3.0.zip>)**, including both archives, installation/release notes, actual verification and checksums.

- [Chrome extension ZIP](<app/release/v0.3.0/logic-recorder-chrome-v0.3.0.zip>) — extract and load unpacked; Node.js/Python are not required to record.
- [Analysis skill ZIP](<app/release/v0.3.0/extension-logic-clone-v0.3.0.zip>) — integrity validation, SQLite indexing, fragment reconstruction and style decoding; Python 3.9+ standard library.
- [SHA-256 checksums](<app/release/v0.3.0/SHA256SUMS.txt>) · [Actual verification report](<docs/交付/2026-11-13/native-release/RELEASE-REPORT.md>)

Four primary operations remain: **Start, Stop, select a batch, Export**. This version repairs per-batch acknowledgement, fragment terminal handling, source-scoped dictionaries, immutable sealing, late-task ownership and Stop/export control; it adds clear operational warnings and provenance. Historical results are not counted as passing this build.

At the user's request, development verification runs directly on the current Windows installation without building an OS isolation environment. Only synthetic local sites and test-owned browser data directories are used, not real business data or the user's existing profile. Earlier blocked/isolation documents are historical and are not prerequisites of this release.

## Install and update

1. Extract the extension ZIP to a stable directory.
2. Open `chrome://extensions`, enable Developer mode, and choose **Load unpacked**.
3. Select the directory directly containing `manifest.json`.
4. Pin/click Logic Recorder to open its side panel.

The manifest declares Chrome 125+. See the release report for the browser/OS actually tested; the minimum version and other platforms are not implicitly verified. Before updating, stop recording and export needed batches. Replace files in the existing extension directory and reload it; uninstalling may remove local data.

## Use

1. Open only HTTP(S) sites you are authorized to record. A dedicated business profile is recommended; a separate window does not isolate other windows in the same profile.
2. Click **开始录制**, and grant Chrome's native site-access request. The default scope includes all authorized ordinary pages, including other windows and pages opened later.
3. Work normally, then click **停止录制**. Stop also works during preparation. Closing the side panel does not stop recording.
4. Wait for the batch, select it, and click **导出记录包**. No new historical export starts during recording; export state does not own Stop.

“Stopped, exportable” is not a guarantee of complete evidence. “Verification needed” or “interrupted” requires checking gaps in the archive. Saved portions remain exportable. A download confirmation timeout is reported as an error/unknown outcome, not success; the local batch remains available for retry.

Recordings stay local and are not uploaded by the extension. There is no automatic expiry/deletion, in-extension content viewer, import or replay. Exported files and external indexes remain the holder's responsibility.

## Current interface

| Ready | Batch selection |
| :---: | :---: |
| ![v0.3.0 ready](<docs/media/v0.3.0-01-ready.png>) | ![v0.3.0 batch selection](<docs/media/v0.3.0-03-history.png>) |

These are real extension screenshots using synthetic local data. Automation pre-grants host access in a temporary extension copy; it does not prove native permission-dialog acceptance/denial. See [media notes](<docs/DEMO.md>).

## Data handling and limitations

**Archives may contain passwords, authorization headers, cookies, tokens, input, file contents, personal/business data and unmasked screenshots. ZIP files are not encrypted.** Record only authorized pages and control local/backup/sharing access. Indexes also retain raw values.

Archives contain a manifest, integrity hashes, raw event chunks, screenshots/resources, event/page/relationship indexes, source-scoped field observations and theme data.

- Large payloads may use fragments. Verify all parts and a unique confirmed End; matching Failure or data after End invalidates completeness.
- Serialized DOM is not server source or original HTTP bytes. Raw and derived views differ.
- Screenshots can be shared/missing; tiled full-page images are not atomic. Canvas PNGs are not guaranteed to match the composited screen.
- IDB/Cache start/end sampling is best effort, not a global transaction or a complete history. Cookie evidence is domain-scoped, not proof of action causality.
- Nearby times do not prove causality; missing/unknown/unobserved does not mean absent. Hashes establish consistency with the included list, not authenticity.
- Browser restrictions, navigation, debugger detachment and resource pressure can leave gaps. Arbitrary duration/size, unvisited branches, server logic or a deployable whole-site clone are not guaranteed.

See the [archive reference](<app/skills/extension-logic-clone/references/archive-format.md>) and [analysis guide](<docs/技能使用说明.md>).

## Analysis and development

Extract the skill's `extension-logic-clone` folder into the user's Codex skills directory, inspecting existing files before updating. Or invoke the standard-library indexer directly with a new output path:

```powershell
python ./app/skills/extension-logic-clone/scripts/index_archive.py recording.zip --output new-index.sqlite3
```

```powershell
cd app
npm ci
npm run build
npm test
npm run test:skill
$env:CHROME_BIN='C:/Program Files/Google/Chrome/Application/chrome.exe'
npm run test:e2e
npm run test:capture-matrix
```

The [release report](<docs/交付/2026-11-13/native-release/RELEASE-REPORT.md>) distinguishes actual results from limitations. No Docker/WSL or replacement user browser is used; tests only clean resources they create. Historical viewer tests do not define the current UI.
