# Logic Recorder

**v0.5.0 configurable-limit business-flow recorder.** Capture an explicitly selected workflow's key actions, page states and API samples, then export locally. Not a browser-wide backup or an automatic theme/schema analysis engine.

[中文](<README.md>) · [Install/use](<docs/设置/2026-11-14-v0.5.0/INSTALL.md>) · [Actual verification](<docs/设置/2026-11-14-v0.5.0/REPORT.md>) · [Contract](<docs/设置/2026-11-14-v0.5.0/CONTRACT.md>)

## Latest stable release v0.5.0

Official [GitHub Release v0.5.0](<https://github.com/copypasteltd/data-collect-extension/releases/tag/v0.5.0>) is the latest stable release. **[Complete official bundle](<https://github.com/copypasteltd/data-collect-extension/releases/download/v0.5.0/logic-recorder-release-v0.5.0.zip>)** · [Extension](<https://github.com/copypasteltd/data-collect-extension/releases/download/v0.5.0/logic-recorder-chrome-v0.5.0.zip>) · [Reader0.5.0](<https://github.com/copypasteltd/data-collect-extension/releases/download/v0.5.0/extension-logic-clone-v0.5.0.zip>). The panel now saves capacity, queue and sampling multipliers1–20, default/max20. Saved changes affect the next batch; active/old batch policies stay immutable. Default1280MiB/1.25GiB total,960MiB warning and40MiB single body. [Install](<docs/设置/2026-11-14-v0.5.0/INSTALL.md>) · [Actual verification](<docs/设置/2026-11-14-v0.5.0/REPORT.md>). The original installation files are backed up and updated; reload that extension to activate. All ten public attachment downloads match their expected sizes and SHA256. [Checksums](<https://github.com/copypasteltd/data-collect-extension/releases/download/v0.5.0/SHA256SUMS.txt>) · [Publication receipt](<docs/releases/v0.5.0-publication/GITHUB-RELEASE.json>). Tag points to verified source d7467f37f8615c27eda53435db913b34fff07982; prior v0.4.0 is unchanged.

500 JS /58 Python tests pass. Native1x/20x batches, settings persistence and snapshot, invalid values, Stop availability, long Unicode values and3MiB DOM/body are verified;130 transport parts max327997B. Actual72MiB storage exported as75511309B OPFS-backed ZIP in about4.9s. Full1.25GiB payload was not stress tested. Streaming STORE may produce a larger ZIP than prior deflate.

![v0.5.0 settings](<docs/media/v0.5.0-01-settings.png>)

## Published stable v0.4.0 (historical)

Official stable [GitHub Release v0.4.0](<https://github.com/copypasteltd/data-collect-extension/releases/tag/v0.4.0>) is published with Chrome extension0.4.0 and reading skill0.4.0.1.

- **[Complete official bundle](<https://github.com/copypasteltd/data-collect-extension/releases/download/v0.4.0/logic-recorder-release-v0.4.0.zip>)** — extension, latest reader, instructions, verification and checksums.
- [Chrome extension](<https://github.com/copypasteltd/data-collect-extension/releases/download/v0.4.0/logic-recorder-chrome-v0.4.0.zip>) — no Node/Python required to record.
- [Reading skill0.4.0.1](<https://github.com/copypasteltd/data-collect-extension/releases/download/v0.4.0/extension-logic-clone-v0.4.0.1.zip>) — v3 and legacyv1/v2, ledger/seal checks and exact content extraction.
- [Checksums](<https://github.com/copypasteltd/data-collect-extension/releases/download/v0.4.0/SHA256SUMS.txt>) · [Publication receipt](<docs/releases/v0.4.0-publication/GITHUB-RELEASE.json>).

The official complete bundle includes the latest reader while retaining the verified component ZIP bytes. Earlier local bundles and published [v0.3.0](<https://github.com/copypasteltd/data-collect-extension/releases/tag/v0.3.0>) remain unchanged.

## Reduced contract

The four operations remain **Start, Stop, select a batch, Export**. A batch binds one root business tab, authorized required frames and at most one attributed opener child. Activation changes, unrelated existing tabs, unknown openers or later gestures cannot expand scope. Navigation into an ungranted origin is a recorded gap.

Retained: stable input/known before-values, meaningful actions, canonical structural DOM, form properties, important states including brief validation alerts, necessary CSS/resources, viewport PNG and business XHR/Fetch request/response samples. Identical bytes are stored once by session-local SHA256 while observations retain references.

Removed from the default product: browser-wide capture, full computed-style/pseudo-element enumeration, theme/field derivation, Cookie snapshots, Storage polling, full IndexedDB/Cache mirroring, full-page tiles, separate Canvas pixels, all JS/media/upload-file bytes and WS/SSE message payloads. This deliberately gives up full-site/offline-database/precise replay guarantees rather than hiding data loss.

## Enforced budgets

Capacity/queue/sampling multipliers are saved as integers1–20. Default20x accepts1280MiB logical saved content/metadata, warns at960MiB, ends normal intake by1260MiB and reserves20MiB for finalization. Categories share the cap: body480MiB, DOM320MiB, resources160MiB, screenshots240MiB, metadata80MiB. Single body40MiB. Changing settings affects only subsequent batches; old sessions without settings remain1x. Cross-category reuse still charges each relevant category. Policy stop retains the saved partial batch; it does not delete or circularly overwrite data. These are saved-byte limits, not hard Chrome memory bounds.

Export only packages persisted events, content and compact manifests/hashes. No per-element theme/field expansion occurs during primary export. Unknown-length CDP reads have explicitly disclosed physical streaming limitations; rejected content is never marked captured.

## Historical v0.4.0 reference workload

Windows native Chrome157, synthetic workflow with20 unrelated tabs,5000 CSS variables/animation, authorized frame/attributed child, form before/after, required validation, modal/select, PUT save, POST debit201 and rejected409, frame navigation followed by new root input, and a200ms alert.

- One60s business workload: ZIP **562491B**, Stop **1837ms**, Export **2366ms**.
- Twenty short identical business cycles: all pass; P95 Stop **2436ms**, Export **2703ms**; max ZIP **329596B**. This is not20×60s.
-445 JavaScript regressions (72 new flow contracts),12 legacy +16 v3 Python tests; native storage/budget and independent package-only reconstruction evidence in the [report](<docs/精简/2026-11-14-v0.4.0/REPORT.md>).

These are fixed-fixture results, not universal size/performance promises. Old heavy50-scenario matrices are not counted as new scope acceptance.

## Install/update/use

Extract the extension, open chrome://extensions, enable Developer mode, and load the directory directly containing manifest.json. For an existing installation, stop first, back up program files, replace files **in the same loaded directory**, then reload that same extension. Do not uninstall, clear browser data or install a second path. A directory bearing an old version name need not be renamed.

New batches use the independent logic-recorder-flow-v1 database. The legacy database is not opened, migrated or deleted; old batches do not appear in the new list. Current-origin permission requests replace asking for all sites; previously granted permissions may remain, but internal scope stays restricted. Closing the panel does not stop recording.

| Ready | Batch selection |
| :---: | :---: |
| ![v0.4.0 ready](<docs/media/v0.4.0-01-ready.png>) | ![v0.4.0 batches](<docs/media/v0.4.0-03-history.png>) |

Real extension UI with synthetic data; pre-granted automation is not proof of native permission-dialog behavior.

## Format and risks

V3/business-flow-v1 archives contain manifest.json, integrity.json, timeline/events-NNNNN.jsonl and contents/<SHA256>.bin. Payload top-level content references identify exact bytes. The standalone indexer verifies integrity, events and references and stores raw events/files/contents/content_refs in a new SQLite file:

```powershell
python scripts/index_archive.py recording.zip --output new-index.sqlite3
```

[Format reference](<app/skills/extension-logic-clone/references/archive-format.md>). Legacy v1/v2 file-reader support is not legacy browser-database migration.

Samples may include passwords, authorization headers, personal/business data and unmasked screenshots. ZIP/SQLite are not encrypted. The extension does not upload them; protect local files, backups and sharing. Hashes establish consistency, not authenticity. No source/server-code, login restoration, complete database, unvisited branches or pixel-identical website reconstruction is guaranteed. Read policy/gap states; ready/integrity pass is not full capture. Native permission dialogs, physical Chrome125/macOS and real customer ERPs are not automatically certified.

## Development

```powershell
cd app
npm ci
npm run build
npm test
npm run test:flow
npm run test:settings
npm run test:large-export
npm run test:skill
npm run test:flow-skill
$env:CHROME_BIN='C:/Program Files/Google/Chrome/Application/chrome.exe'
npm run test:flow-native-store
npm run test:flow-acceptance
npm run test:flow-performance
```

Production uses flow-background/flow-content/flow-archive. Historical heavy/viewer sources remain out of the build. Native Windows, no Docker/WSL; only task-owned test browsers are closed.
