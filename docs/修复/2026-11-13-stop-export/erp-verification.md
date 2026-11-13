# Native ERP release verification

- Actual result: **passed**; code=0.
- Executed: 2026-11-13T13:28:12.402Z → 2026-11-13T13:28:34.317Z.
- Browser: 157.0.8103.40; Node v24.22.1; win32/x64.
- Native host, headless Chrome. Separate test-* profile is interference prevention only, **not an OS sandbox**. No Docker/WSL/VM.
- Only local synthetic HTTP page; temporary dist copy pre-grants host permissions: **not a native permission-prompt test**. Sidepanel HTML is opened as an extension tab; native drawer appearance is not validated.
- UI: Start → query → trusted contact/emoji input → one PUT save → POST 12800 cents/201 → POST 999999 cents/409 → final GET → normal Stop (existing 90000 ms UI budget) → export button / real Blob download.
- Oracle successful writes=2, attempted writes=3; final balance=87200 cents. 409 must leave state unchanged.
- Stop elapsed: 1911 ms.
- Evidence: [local retained synthetic evidence directory](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/test-native-erp-evidence-eV8mbV>); ZIP/SQLite/profiles are not commit deliverables.
- Raw assertions precede JS/Python consumer checks. No reconstructed DOM is used as business acceptance; PNGs may be coalesced/temporally offset, not one-per-click.
- Evidence: [machine-readable report and event/ZIP-path references](<E:/dev/copypaste/美容ERP/逻辑记录插件/docs/交付/2026-11-13/native-release/erp-verification.json>).
- Identity: source=80a54a83a6536cfee1db8c7c3ac0625527a36f78264adb5fb2004dd88b3589c4; dist=adb893f3f8b8210b0d298910c019a6b587fad25e63fc0748a5d949fb04811236. Non-atomic hash snapshot, not source→dist attestation or a cryptographic signature.

## Acceptance and limits

- raw original before/after input, DOM, 5 trusted business clicks, request/response bytes/status/balances, no duplicate writes, PNG, seal/counters, provenance, timeline identity passed
- external packaged Python index validated every file SHA-256 and event count; read-only SQLite hash/count readback passed
- This is **one workflow with hash-checked synthetic evidence**, not proof for all real ERPs or native authorization. No trusted digital signature is claimed.
- Recorded session coverage/gaps/warnings are retained verbatim in JSON. ready/sealed does not imply every capability is gap-free.
- Cleanup: only this test's owned Chrome handle, local server, testextension and guarded test profile; user Chrome is never closed. Full cleanup results are retained in JSON.
