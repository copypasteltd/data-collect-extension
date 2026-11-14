# Exact release package smoke verification

Result: **passed**.

- release files/checksums/entry sizes and hashes match current dist and skill source
- exact unmodified extension ZIP extracts and loads in actual Chrome with JS/CSS/icons and expected idle controls
- extracted packaged Python indexer verifies synthetic ERP recording integrity and event count

See package-smoke.json for hashes, browser/consumer and cleanup results. Native permission dialog, macOS and Chrome125 are not tested.
