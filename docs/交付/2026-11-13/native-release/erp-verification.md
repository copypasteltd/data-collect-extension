# Native ERP release verification

- Actual result: **passed**; code=0.
- Executed: 2026-11-13T11:05:21.030Z → 2026-11-13T11:05:35.324Z.
- Browser: 157.0.8103.40; Node v24.22.1; win32/x64.
- Native host, headless Chrome. Separate test-* profile is interference prevention only, **not an OS sandbox**. No Docker/WSL/VM.
- Only local synthetic HTTP page; temporary dist copy pre-grants host permissions: **not a native permission-prompt test**. Sidepanel HTML is opened as an extension tab; native drawer appearance is not validated.
- UI: Start → query → trusted contact/emoji input → one PUT save → POST 12800 cents/201 → POST 999999 cents/409 → final GET → normal Stop (existing 90000 ms UI budget) → export button / real Blob download.
- Oracle successful writes=2, attempted writes=3; final balance=87200 cents. 409 must leave state unchanged.
- Stop elapsed: 1850 ms.
- Evidence: [local retained synthetic evidence directory](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/test-native-erp-evidence-nOGSjp>); ZIP/SQLite/profiles are not commit deliverables.
- Raw assertions precede JS/Python consumer checks. No reconstructed DOM is used as business acceptance; PNGs may be coalesced/temporally offset, not one-per-click.
- Evidence: [machine-readable report and event/ZIP-path references](<E:/dev/copypaste/美容ERP/逻辑记录插件/docs/交付/2026-11-13/native-release/erp-verification.json>).
- Identity: source=4b54effd0ca645c857c5aee8ae46861e96a2bc910a428fa10458902676978c18; dist=86b0892571eaacae36e6249e775b97d39f733be1f624f7c554246d644363dbd8. Non-atomic hash snapshot, not source→dist attestation or a cryptographic signature.

## Acceptance and limits

- raw original before/after input, DOM, 5 trusted business clicks, request/response bytes/status/balances, no duplicate writes, PNG, seal/counters, provenance, timeline identity passed
- external packaged Python index validated every file SHA-256 and event count; read-only SQLite hash/count readback passed
- This is **one workflow with hash-checked synthetic evidence**, not proof for all real ERPs or native authorization. No trusted digital signature is claimed.
- Recorded session coverage/gaps/warnings are retained verbatim in JSON. ready/sealed does not imply every capability is gap-free.
- Cleanup: only this test's owned Chrome handle, local server, testextension and guarded test profile; user Chrome is never closed. Full cleanup results are retained in JSON.

## Execution history and retained limitation

- The first native run exited 1 because the new test expected an input `trusted` property absent from the collector schema. The raw old/new values and trusted business-button clicks were present. Only that schema check and the bounded actual-snapshot wait were corrected; no production file or key raw assertion was changed/deleted. The first synthetic ZIP remains retained locally.
- The final frozen test ran against the parent's final 0.3.0 build and exited **0**. Both run logs remain in [native ERP log](<E:/dev/copypaste/美容ERP/逻辑记录插件/app/test-native-erp.log>).
- Final seal: revision **170**, **321** raw events, **15** assets, lastSeq **321**. Python indexed **321** events and verified **36** file hashes; read-only SQLite readback agreed.
- Recorded coverage preserves **screenshotsUnavailable=1**. Nevertheless **5** valid recorded PNGs explicitly link to business clicks; this is not a claim of complete per-click screenshot coverage. All other reported coverage counters were 0 in this workflow.
- The test source is frozen; only these documentation notes were added after execution. The input identity snapshots are exact execution-time hashes, not a claim that the parent package/test scripts cannot change later.
