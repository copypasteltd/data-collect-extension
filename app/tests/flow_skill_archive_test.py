"""Standard-library v3 reader tests; every archive is synthetic and temporary."""
import copy
import hashlib
import json
import os
import random
import sqlite3
import subprocess
import sys
import tempfile
import unittest
import warnings
import zipfile
from contextlib import closing
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "skills" / "extension-logic-clone" / "scripts" / "index_archive.py"
SESSION = "synthetic-flow"
CHUNKS = ["timeline/events-00001.jsonl", "timeline/events-00002.jsonl"]


def encoded(value):
    return json.dumps(value, ensure_ascii=True, separators=(",", ":")).encode("utf-8")


class FlowArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="test-flow-skill-")
        self.folder = Path(self.temp.name)
        self.archive = self.folder / "synthetic.zip"
        self.index = self.folder / "index.sqlite3"

    def tearDown(self):
        self.temp.cleanup()

    def fixture(self, raw=None):
        if raw is None:
            raw = [b'<main><script>throw "never execute"</script>synthetic</main>',
                   encoded({"value": "synthetic", "contentId": "ordinary-business-value", "size": True})]
        contents, bins = [], {}
        for index, data in enumerate(raw):
            digest = hashlib.sha256(data).hexdigest()
            entry = {"contentId": f"{SESSION}:{digest}", "path": f"contents/{digest}.bin",
                     "sha256": digest, "size": len(data), "mime": "text/html" if index == 0 else "application/json",
                     "category": "dom" if index == 0 else "body"}
            contents.append(entry)
            bins[entry["path"]] = data
        refs = [{key: entry[key] for key in ("contentId", "sha256", "size", "mime", "category")}
                | {"status": "captured"} for entry in contents]
        events = [
            {"id": "e1", "sessionId": SESSION, "seq": 1, "time": 10, "kind": "page.snapshot",
             "tabId": 1, "frameId": 0, "documentId": "synthetic-document",
             "payload": {"url": "https://example.test/", "dom/标题~": refs[0],
                         "business": {"contentId": "not-a-reference", "size": True},
                         "nested": {"object": {"status": "captured", "contentId": "not-a-reference"}}}},
            {"id": "e2", "sessionId": SESSION, "seq": 2, "time": 11.25, "kind": "network.finished",
             "payload": {"requestId": "synthetic-request", "body": refs[1],
                         "sameBytes": refs[0] | {"mime": "application/octet-stream", "category": "resource"},
                         "notCollected": {"status": "not_collected", "reason": "capture_policy"}}},
        ]
        manifest = {"format": "logic-recorder", "version": 3, "profile": "business-flow-v1",
                    "session": {"id": SESSION, "eventCount": 2, "contentCount": 2, "lastSeq": 2},
                    "eventCount": 2, "contentCount": 2, "eventChunks": CHUNKS.copy(), "contents": contents,
                    "capturePolicy": {"schemaVersion": 1, "profile": "business-flow-v1",
                                      "notCollected": ["cookies", "storage", "indexedDB", "cache", "computedStyle"]},
                    "budget": {"usedBytes": sum(map(len, raw)), "limitBytes": 67108864, "reserveBytes": 1048576,
                               "byCategory": {}, "warning": False, "policyStopped": False}, "derivations": "none"}
        return manifest, events, bins

    def write_archive(self, manifest=None, events=None, bins=None, *, files_edit=None, integrity_edit=None, event_encode=encoded):
        if manifest is None:
            manifest, events, bins = self.fixture()
        files = {"manifest.json": encoded(manifest), **bins}
        for index, event in enumerate(events):
            files[f"timeline/events-{index + 1:05d}.jsonl"] = event_encode(event) + b"\n"
        if files_edit:
            files_edit(files)
        integrity = [{"path": name, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
                     for name, data in files.items()]
        if integrity_edit:
            integrity_edit(integrity)
        with zipfile.ZipFile(self.archive, "w", zipfile.ZIP_DEFLATED) as zf:
            for name, data in files.items():
                zf.writestr(name, data)
            zf.writestr("integrity.json", encoded(integrity))

    def run_index(self, *extra):
        return subprocess.run([sys.executable, str(SCRIPT), str(self.archive), "--output", str(self.index), *extra],
                              capture_output=True, text=True, encoding="utf-8", timeout=30,
                              env={**os.environ, "PYTHONUTF8": "1"})

    def assert_rejected(self, *args):
        result = self.run_index(*args)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertFalse(self.index.exists())
        self.assertFalse(list(self.folder.glob("index.sqlite3*")))
        self.assertNotIn("Traceback", result.stderr)
        return result

    def test_v3_preserves_raw_bytes_events_and_light_indexes(self):
        manifest, events, bins = self.fixture()
        self.write_archive(manifest, events, bins)
        result = self.run_index()
        self.assertEqual(result.returncode, 0, result.stderr)
        summary = json.loads(result.stdout)
        self.assertEqual((summary["verification"], summary["version"], summary["events"], summary["contentCount"]),
                         ("passed", 3, 2, 2))
        self.assertEqual(summary["files"], 5)
        self.assertNotIn("ordinary-business-value", result.stdout)
        with closing(sqlite3.connect(self.index)) as db, zipfile.ZipFile(self.archive) as zf:
            self.assertEqual(json.loads(db.execute("SELECT value_json FROM metadata WHERE key='manifest'").fetchone()[0]), manifest)
            identity = json.loads(db.execute("SELECT value_json FROM metadata WHERE key='archive_identity'").fetchone()[0])
            raw_zip = self.archive.read_bytes()
            self.assertEqual(identity, {"schemaVersion": 1, "sha256": hashlib.sha256(raw_zip).hexdigest(), "size": len(raw_zip)})
            rows = db.execute("SELECT chunk,line,event_json FROM events ORDER BY seq").fetchall()
            self.assertEqual([(row[0], row[1]) for row in rows], [(CHUNKS[0], 1), (CHUNKS[1], 1)])
            self.assertEqual([json.loads(row[2]) for row in rows], events)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM content_refs").fetchone()[0], 3)
            refs = db.execute("SELECT field,content_id FROM content_refs WHERE event_id='e1'").fetchall()
            self.assertEqual(refs, [("dom/标题~", manifest["contents"][0]["contentId"])])
            for path, size, sha256 in db.execute("SELECT path,size,sha256 FROM contents"):
                self.assertEqual(zf.read(path), bins[path])
                self.assertEqual((size, sha256), (len(bins[path]), hashlib.sha256(bins[path]).hexdigest()))
            self.assertFalse(db.execute("PRAGMA foreign_key_check").fetchall())
            tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            self.assertEqual(tables, {"metadata", "events", "files", "contents", "content_refs"})

    def test_generated_binary_and_empty_content_roundtrip(self):
        rng = random.Random(404)
        for size in (0, 1, 255, 4096):
            with self.subTest(size=size):
                raw = [bytes(rng.randrange(256) for _ in range(size)), bytes(range(256)) + b"synthetic"]
                manifest, events, bins = self.fixture(raw)
                self.write_archive(manifest, events, bins)
                result = self.run_index()
                self.assertEqual(result.returncode, 0, result.stderr)
                with zipfile.ZipFile(self.archive) as zf, closing(sqlite3.connect(self.index)) as db:
                    for path, digest in db.execute("SELECT path,sha256 FROM contents"):
                        self.assertIn(zf.read(path), raw)
                        self.assertEqual(hashlib.sha256(zf.read(path)).hexdigest(), digest)
                self.index.unlink()

    def test_empty_flow_is_valid(self):
        manifest, _, _ = self.fixture()
        manifest.update(eventCount=0, contentCount=0, eventChunks=[], contents=[])
        manifest["session"].update(eventCount=0, contentCount=0, lastSeq=0)
        self.write_archive(manifest, [], {})
        result = self.run_index()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["contentCount"], 0)

    def test_manifest_schema_profile_and_counts_rejected(self):
        cases = [("format", "other"), ("version", True), ("version", 3.0), ("version", 4),
                 ("profile", "heavy"), ("derivations", {}), ("capturePolicy", []), ("budget", []),
                 ("eventCount", True), ("eventCount", 2.0), ("eventCount", -1), ("eventCount", 9007199254740992),
                 ("eventCount", 3), ("contentCount", True), ("contentCount", 1), ("contents", {})]
        for key, value in cases:
            with self.subTest(key=key, value=value):
                manifest, events, bins = self.fixture()
                manifest[key] = value
                self.write_archive(manifest, events, bins)
                self.assert_rejected()
        for key in ("capturePolicy", "budget", "eventChunks", "contents", "contentCount"):
            with self.subTest(missing=key):
                manifest, events, bins = self.fixture()
                del manifest[key]
                self.write_archive(manifest, events, bins)
                self.assert_rejected()

    def test_session_identity_and_owner_token_rejected(self):
        for patch in ({"id": ""}, {"ownerToken": "synthetic-private-token"}, {"eventCount": True},
                      {"contentCount": 3}, {"lastSeq": True}, {"lastSeq": 4}):
            with self.subTest(patch=patch):
                manifest, events, bins = self.fixture()
                manifest["session"].update(patch)
                self.write_archive(manifest, events, bins)
                result = self.assert_rejected()
                self.assertNotIn("synthetic-private-token", result.stderr)

    def test_event_chunk_lists_and_unlisted_chunks_rejected(self):
        for chunks in ([CHUNKS[0], CHUNKS[0]], list(reversed(CHUNKS)), [CHUNKS[0]],
                       ["timeline/events-00003.jsonl"], ["timeline/events-00000.jsonl"],
                       ["../events.jsonl"], [True]):
            with self.subTest(chunks=chunks):
                manifest, events, bins = self.fixture()
                manifest["eventChunks"] = chunks
                self.write_archive(manifest, events, bins)
                self.assert_rejected()

    def test_manifest_content_metadata_and_duplicates_rejected(self):
        patches = [{"contentId": "unknown"}, {"contentId": []}, {"sha256": "0" * 64},
                   {"sha256": "A" * 64}, {"size": True}, {"size": 1.0}, {"size": -1},
                   {"size": 9007199254740992}, {"size": 123}, {"mime": None}, {"mime": "text/plain\n"},
                   {"mime": "text/plain\ud800"}, {"category": ""}, {"category": "unknown"},
                   {"path": "contents/../escape.bin"}, {"path": "resources/raw.bin"}]
        for patch in patches:
            with self.subTest(patch=patch):
                manifest, events, bins = self.fixture()
                manifest["contents"][0].update(patch)
                self.write_archive(manifest, events, bins)
                self.assert_rejected()
        manifest, events, bins = self.fixture()
        manifest["contents"][1] = copy.deepcopy(manifest["contents"][0])
        self.write_archive(manifest, events, bins)
        self.assert_rejected()

    def test_manifest_content_and_zip_must_agree(self):
        for mode in ("missing", "unlisted", "different-bytes"):
            with self.subTest(mode=mode):
                manifest, events, bins = self.fixture()
                path = manifest["contents"][0]["path"]
                if mode == "missing":
                    del bins[path]
                elif mode == "unlisted":
                    bins["contents/" + "0" * 64 + ".bin"] = b"extra"
                else:
                    bins[path] = b"changed; integrity is recomputed but manifest content hash is not"
                self.write_archive(manifest, events, bins)
                self.assert_rejected()

    def test_captured_reference_schema_hash_size_and_unknown_id_rejected(self):
        for patch in ({"contentId": "unknown"}, {"contentId": []}, {"sha256": "0" * 64},
                      {"sha256": True}, {"size": True}, {"size": 1.0}, {"size": -1},
                      {"size": 9007199254740992}, {"size": 123}, {"mime": []}, {"mime": "text/plain\n"},
                      {"category": ""}, {"category": "unknown"},
                      {"extra": "not-schema"}):
            with self.subTest(patch=patch):
                manifest, events, bins = self.fixture()
                events[0]["payload"]["dom/标题~"].update(patch)
                self.write_archive(manifest, events, bins)
                self.assert_rejected()
        manifest, events, bins = self.fixture()
        del events[0]["payload"]["dom/标题~"]["sha256"]
        self.write_archive(manifest, events, bins)
        self.assert_rejected()

    def test_non_reference_objects_are_not_guessed_or_recursively_walked(self):
        manifest, events, bins = self.fixture()
        events[0]["payload"]["notCaptured"] = {"contentId": "business-id", "status": "unavailable"}
        events[0]["payload"]["nestedList"] = [{"contentId": "business-id", "status": "captured"}]
        self.write_archive(manifest, events, bins)
        result = self.run_index()
        self.assertEqual(result.returncode, 0, result.stderr)
        with closing(sqlite3.connect(self.index)) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM content_refs").fetchone()[0], 3)

    def test_event_identity_sequence_and_safe_numeric_types_rejected(self):
        for patch in ({"id": "e1"}, {"sessionId": "another-flow"}, {"sessionId": None}, {"seq": True},
                      {"seq": 1}, {"seq": 0}, {"seq": -1}, {"seq": 2.0}, {"seq": 9007199254740992},
                      {"time": True}, {"time": float("nan")}, {"time": float("inf")},
                      {"time": -1}, {"time": 9007199254740992}, {"tabId": True}, {"frameId": -1},
                      {"kind": ""}, {"payload": []}):
            with self.subTest(patch=patch):
                manifest, events, bins = self.fixture()
                events[1].update(patch)
                self.write_archive(manifest, events, bins)
                self.assert_rejected()

    def test_budget_numbers_do_not_coerce_bool_or_unsafe_integers(self):
        for patch in ({"usedBytes": True}, {"limitBytes": 9007199254740992}, {"reserveBytes": -1},
                      {"warning": 1}, {"policyStopped": 0}, {"byCategory": {"body": True}}):
            with self.subTest(patch=patch):
                manifest, events, bins = self.fixture()
                manifest["budget"].update(patch)
                self.write_archive(manifest, events, bins)
                self.assert_rejected()

    def test_integrity_coverage_duplicates_self_and_checksums_rejected(self):
        edits = [lambda entries: entries.pop(), lambda entries: entries.append(copy.deepcopy(entries[0])),
                 lambda entries: entries.append({"path": "integrity.json", "size": 0, "sha256": "0" * 64}),
                 lambda entries: entries[0].update(sha256="0" * 64),
                 lambda entries: entries[0].update(size=True)]
        for index, edit in enumerate(edits):
            with self.subTest(edit=index):
                self.write_archive(integrity_edit=edit)
                self.assert_rejected()

    def test_duplicate_json_keys_and_nonfinite_json_rejected(self):
        edits = [lambda files: files.update({"manifest.json": files["manifest.json"][:-1] + b',"version":3}'}),
                 lambda files: files.update({CHUNKS[0]: files[CHUNKS[0]].rstrip()[:-1] + b',"id":"duplicate"}\n'}),
                 lambda files: files.update({CHUNKS[0]: b'{"payload":{"x":NaN}}\n'}),
                 lambda files: files.update({CHUNKS[0]: files[CHUNKS[0]].replace(b'"size":true', b'"size":1e999')})]
        for index, edit in enumerate(edits):
            with self.subTest(edit=index):
                self.write_archive(files_edit=edit)
                self.assert_rejected()

    def test_traversal_duplicate_zip_and_size_bombs_rejected(self):
        for path in ("../escape", "/absolute", "C:/escape", "contents\\escape", "contents//escape"):
            with self.subTest(path=path):
                self.write_archive(files_edit=lambda files: files.update({path: b"synthetic"}))
                self.assert_rejected()
        self.write_archive()
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            with zipfile.ZipFile(self.archive, "a") as zf:
                zf.writestr("manifest.json", b"{}")
        self.assert_rejected()
        self.write_archive(files_edit=lambda files: files.update({"padding.bin": b"x" * 1200000}))
        self.assert_rejected("--max-entry-mb", "1")
        self.assert_rejected("--max-expanded-mb", "1")

    def test_existing_output_is_never_overwritten(self):
        self.write_archive()
        self.index.write_bytes(b"synthetic-existing-output")
        result = self.run_index()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.index.read_bytes(), b"synthetic-existing-output")

    def current_fixture(self, event_encode=encoded):
        manifest, events, bins = self.fixture()
        events[-1]["kind"] = "session.stop"
        event_bytes = sum(len(event_encode(event)) + 1 for event in events)
        content_bytes = sum(map(len, bins.values()))
        manifest["byteAccounting"] = {"eventJsonlBytes": event_bytes, "uniqueContentBytes": content_bytes,
                                      "storedLogicalBytes": event_bytes + content_bytes}
        manifest["budget"]["usedBytes"] = event_bytes + content_bytes
        manifest["partial"] = False
        manifest["session"].update(status="ready", stopEventCount=1, stopSeq=2, stopEventId="e2",
                                   seal={"eventCount": 2, "contentCount": 2, "lastSeq": 2, "revision": 4, "sealedAt": 12},
                                   budget=copy.deepcopy(manifest["budget"]))
        return manifest, events, bins

    def test_current_writer_ledger_uses_raw_unicode_jsonl_including_lf(self):
        def utf8(event):
            event = copy.deepcopy(event)
            event["payload"]["text"] = "合成标题😀"
            return json.dumps(event, ensure_ascii=False, indent=2).replace("\n", " ").encode("utf-8")
        manifest, events, bins = self.current_fixture(utf8)
        manifest["session"]["coverage"] = {"version": 1, "policyGaps": 3, "reasons": {"synthetic-private": 3}}
        self.write_archive(manifest, events, bins, event_encode=utf8)
        result = self.run_index()
        self.assertEqual(result.returncode, 0, result.stderr)
        summary = json.loads(result.stdout)
        self.assertEqual(summary["byteAccountingVerification"], "performed")
        self.assertEqual(summary["profile"], "business-flow-v1")
        self.assertIs(summary["partial"], False)
        self.assertIs(summary["policyStopped"], False)
        self.assertEqual(summary["recordedCoverage"], {"declared": True, "version": 1, "policyGaps": 3})
        self.assertNotIn("synthetic-private", result.stdout)
        self.assertIn("do not prove full capture", summary["coverageCaveat"])

    def test_byte_accounting_schema_and_each_ledger_guard_rejected(self):
        for key in ("eventJsonlBytes", "uniqueContentBytes", "storedLogicalBytes"):
            for value in (None, True, -1, 1.0, 9007199254740992, 0):
                with self.subTest(key=key, value=value):
                    manifest, events, bins = self.current_fixture()
                    manifest["byteAccounting"][key] = value
                    self.write_archive(manifest, events, bins)
                    self.assert_rejected()
        for value in (None, [], True):
            manifest, events, bins = self.current_fixture()
            manifest["byteAccounting"] = value
            self.write_archive(manifest, events, bins)
            self.assert_rejected()
        manifest, events, bins = self.current_fixture()
        del manifest["byteAccounting"]["eventJsonlBytes"]
        self.write_archive(manifest, events, bins)
        self.assert_rejected()

    def test_budget_and_session_budget_must_match_when_declared(self):
        for mode in ("ledger", "session", "session-type", "session-boolean"):
            with self.subTest(mode=mode):
                manifest, events, bins = self.current_fixture()
                if mode == "ledger":
                    manifest["budget"]["usedBytes"] += 1
                    manifest["session"]["budget"] = copy.deepcopy(manifest["budget"])
                elif mode == "session":
                    manifest["session"]["budget"]["usedBytes"] += 1
                elif mode == "session-type":
                    manifest["session"]["budget"] = []
                else:
                    manifest["session"]["budget"]["warning"] = 0
                self.write_archive(manifest, events, bins)
                self.assert_rejected()

    def test_seal_requires_unique_final_stop_and_matching_counts(self):
        for kinds in (("page.snapshot", "network.finished"), ("session.stop", "session.stop"),
                      ("session.stop", "network.finished")):
            with self.subTest(kinds=kinds):
                manifest, events, bins = self.current_fixture()
                del manifest["byteAccounting"]
                for event, kind in zip(events, kinds):
                    event["kind"] = kind
                self.write_archive(manifest, events, bins)
                self.assert_rejected()
        for key in ("eventCount", "contentCount", "lastSeq", "revision", "sealedAt"):
            for value in (True, -1, 1.0, 9007199254740992):
                manifest, events, bins = self.current_fixture()
                manifest["session"]["seal"][key] = value
                self.write_archive(manifest, events, bins)
                self.assert_rejected()
        for key in ("eventCount", "contentCount", "lastSeq"):
            manifest, events, bins = self.current_fixture()
            manifest["session"]["seal"][key] = 1
            self.write_archive(manifest, events, bins)
            self.assert_rejected()

    def test_optional_fields_and_raw_internal_markers_are_guarded(self):
        for location in ("manifest", "session", "event"):
            for key in ("ownerToken", "captureKey"):
                manifest, events, bins = self.fixture()
                target = manifest if location == "manifest" else manifest["session"] if location == "session" else events[0]
                target[key] = "synthetic-private-marker"
                self.write_archive(manifest, events, bins)
                result = self.assert_rejected()
                self.assertNotIn("synthetic-private-marker", result.stderr)
        for value in (None, 0, "false", []):
            manifest, events, bins = self.fixture()
            manifest["partial"] = value
            self.write_archive(manifest, events, bins)
            self.assert_rejected()
        manifest, events, bins = self.fixture()
        events[-1]["seq"] = 3
        manifest["session"]["lastSeq"] = 3
        self.write_archive(manifest, events, bins)
        self.assert_rejected()

    def test_minimal_flow_without_seal_or_ledger_remains_valid(self):
        manifest, events, bins = self.fixture()
        events[0]["kind"] = "future.event-kind"
        events[0]["payload"]["ownerToken"] = "ordinary-synthetic-business-value"
        self.write_archive(manifest, events, bins)
        result = self.run_index()
        self.assertEqual(result.returncode, 0, result.stderr)
        summary = json.loads(result.stdout)
        self.assertEqual(summary["byteAccountingVerification"], "not_performed")
        self.assertIsNone(summary["partial"])

    def test_cli_detects_archive_change_after_build_and_removes_index(self):
        import importlib.util
        from unittest import mock
        spec = importlib.util.spec_from_file_location("indexer_consistency", SCRIPT)
        indexer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(indexer)
        self.write_archive()
        original_build = indexer.build_index
        def changing_build(*args, **kwargs):
            result = original_build(*args, **kwargs)
            with self.archive.open("ab") as stream:
                stream.write(b"synthetic-archive-replacement")
            return result
        with mock.patch.object(indexer, "build_index", changing_build), mock.patch.object(sys, "argv",
                [str(SCRIPT), str(self.archive), "--output", str(self.index)]):
            with self.assertRaisesRegex(ValueError, "archive changed"):
                indexer.main()
        self.assertFalse(self.index.exists())


if __name__ == "__main__":
    unittest.main()
