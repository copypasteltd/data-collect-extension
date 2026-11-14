"""Execute the v3 raw-content CLI with synthetic archives and tampered indexes."""
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import unittest
import zipfile
import flow_skill_archive_test as fixtures

ROOT = Path(__file__).resolve().parents[1]
READ = ROOT / "skills/extension-logic-clone/scripts/read_content.py"


class ContentReaderTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.FlowArchiveTests()
        self.fixture.setUp()
        self.output = self.fixture.folder / "raw-output.bin"

    def tearDown(self):
        self.fixture.tearDown()

    def prepare(self, raw=None):
        manifest, events, bins = self.fixture.fixture(raw)
        self.fixture.write_archive(manifest, events, bins)
        result = self.fixture.run_index()
        self.assertEqual(result.returncode, 0, result.stderr)
        return manifest, events, bins

    def run_read(self, *args):
        return subprocess.run([sys.executable, str(READ), str(self.fixture.archive), str(self.fixture.index),
                               *args, "--output", str(self.output)], capture_output=True, text=True,
                              encoding="utf-8", timeout=30, env={**os.environ, "PYTHONUTF8": "1"})

    def rejected(self, *args):
        result = self.run_read(*args)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertNotIn("Traceback", result.stderr)
        self.assertFalse(self.output.exists())
        return result

    def patch_db(self, command, values=()):
        with closing(sqlite3.connect(self.fixture.index)) as db:
            db.execute(command, values)
            db.commit()

    def test_literal_field_with_unicode_slash_and_tilde_preserves_exact_bytes(self):
        manifest, _, bins = self.prepare()
        result = self.run_read("--event-id", "e1", "--field", "dom/标题~")
        self.assertEqual(result.returncode, 0, result.stderr)
        info = json.loads(result.stdout)
        self.assertEqual(self.output.read_bytes(), bins[manifest["contents"][0]["path"]])
        self.assertEqual(info["evidence"], {"path": "timeline/events-00001.jsonl", "line": 1})
        self.assertEqual(info["sha256"], hashlib.sha256(self.output.read_bytes()).hexdigest())
        self.assertIs(info["contentExecuted"], False)
        self.assertNotIn("never execute", result.stdout)

    def test_content_id_binary_empty_and_unicode_roundtrip(self):
        for raw in (b"", bytes(range(256)), "汉字💆\u0000end".encode("utf-8")):
            with self.subTest(size=len(raw)):
                manifest, _, _ = self.prepare([raw, b"other"])
                result = self.run_read("--content-id", manifest["contents"][0]["contentId"])
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(self.output.read_bytes(), raw)
                self.output.unlink()
                self.fixture.index.unlink()

    def test_cross_category_reference_reports_observation_mime(self):
        self.prepare()
        result = self.run_read("--event-id", "e2", "--field", "sameBytes")
        self.assertEqual(result.returncode, 0, result.stderr)
        info = json.loads(result.stdout)
        self.assertEqual((info["mime"], info["category"]), ("application/octet-stream", "resource"))

    def test_missing_identity_requires_reindex(self):
        self.prepare()
        self.patch_db("DELETE FROM metadata WHERE key=?", ("archive_identity",))
        result = self.rejected("--event-id", "e1", "--field", "dom/标题~")
        self.assertIn("rebuild", result.stderr)

    def test_replaced_source_even_with_valid_recomputed_integrity_is_rejected(self):
        self.prepare()
        manifest, events, bins = self.fixture.fixture()
        events[0]["payload"]["url"] = "https://changed.test/"
        self.fixture.write_archive(manifest, events, bins)
        result = self.rejected("--event-id", "e1", "--field", "dom/标题~")
        self.assertIn("identities differ", result.stderr)

    def test_tampered_event_reference_content_manifest_or_file_index_is_rejected(self):
        commands = [
            ("UPDATE events SET line=2 WHERE id=?", ("e1",)),
            ("UPDATE events SET event_json=? WHERE id=?", ("{}", "e1")),
            ("UPDATE content_refs SET mime=? WHERE event_id=?", ("text/changed", "e1")),
            ("UPDATE contents SET size=size+1", ()),
            ("UPDATE files SET sha256=? WHERE path LIKE ?", ("0" * 64, "contents/%")),
            ("UPDATE metadata SET value_json=? WHERE key=?", ("{}", "manifest")),
        ]
        for command, values in commands:
            with self.subTest(command=command):
                self.prepare()
                self.patch_db(command, values)
                self.rejected("--event-id", "e1", "--field", "dom/标题~")
                self.fixture.index.unlink()

    def test_content_attachment_cannot_impersonate_timeline_event(self):
        raw = b"WRONG"
        digest = hashlib.sha256(raw).hexdigest()
        ref = {"contentId": fixtures.SESSION + ":" + digest, "sha256": digest, "size": len(raw),
               "mime": "application/json", "category": "body", "status": "captured"}
        fake = {"id": "e1", "sessionId": fixtures.SESSION, "seq": 1, "time": 10,
                "kind": "page.snapshot", "payload": {"dom/标题~": ref}}
        fake_bytes = json.dumps(fake, ensure_ascii=True, separators=(",", ":")).encode("utf-8") + b"\n"
        manifest, _, _ = self.prepare([fake_bytes, raw])
        self.patch_db("UPDATE events SET chunk=?,line=?,event_json=? WHERE id=?",
                      (manifest["contents"][0]["path"], 1, json.dumps(fake), "e1"))
        self.patch_db("UPDATE content_refs SET content_id=?,mime=?,category=? WHERE event_id=? AND field=?",
                      (ref["contentId"], ref["mime"], ref["category"], "e1", "dom/标题~"))
        result = self.rejected("--event-id", "e1", "--field", "dom/标题~")
        self.assertIn("event location", result.stderr)

    def test_arbitrary_object_nested_reference_and_pointer_are_not_captured_fields(self):
        self.prepare()
        for field in ("business", "nested", "/payload/dom~1标题~0", "unknown"):
            with self.subTest(field=field):
                self.rejected("--event-id", "e1", "--field", field)
        self.rejected("--event-id", "missing", "--field", "body")
        self.rejected("--content-id", "unknown")

    def test_no_overwrite_or_output_parent_creation(self):
        self.prepare()
        self.output.write_bytes(b"keep")
        result = self.run_read("--event-id", "e1", "--field", "dom/标题~")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.output.read_bytes(), b"keep")
        self.output.unlink()
        self.output = self.output.parent / "missing-parent" / "out.bin"
        self.rejected("--event-id", "e1", "--field", "dom/标题~")
        self.assertFalse(self.output.parent.exists())

    def test_modified_archive_bytes_fail_and_resource_limits_do_not_write(self):
        self.prepare()
        self.rejected("--event-id", "e1", "--field", "dom/标题~", "--max-bytes", "1")
        self.rejected("--content-id", "unknown", "--max-archive-bytes", "1")
        self.rejected("--event-id", "e1", "--field", "dom/标题~", "--max-expanded-bytes", "1")
        with self.fixture.archive.open("ab") as handle:
            handle.write(b"changed")
        self.rejected("--event-id", "e1", "--field", "dom/标题~")

    def test_read_does_not_write_index_or_mutate_source(self):
        self.prepare()
        before = {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in (self.fixture.index, self.fixture.archive)}
        result = self.run_read("--event-id", "e2", "--field", "body")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(before, {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in before})

    def test_configured_body_above_legacy_limit_streams_exact_bytes(self):
        raw = b"synthetic-body-" * 230000
        manifest, events, bins = self.fixture.fixture([b"synthetic-dom", raw])
        fixtures.configured(manifest)
        self.fixture.write_archive(manifest, events, bins)
        result = self.fixture.run_index()
        self.assertEqual(result.returncode, 0, result.stderr)
        result = self.run_read("--event-id", "e2", "--field", "body")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.output.stat().st_size, len(raw))
        self.assertEqual(hashlib.sha256(self.output.read_bytes()).digest(), hashlib.sha256(raw).digest())
        self.fixture.index.unlink()
        manifest, events, bins = self.fixture.fixture([b"synthetic-dom", raw])
        self.fixture.write_archive(manifest, events, bins)
        self.fixture.assert_rejected()

    def test_reader_default_limits_allow_maximum_batch_without_allocating_it(self):
        import importlib.util
        from unittest import mock
        spec = importlib.util.spec_from_file_location("flow_content_reader", READ)
        module = importlib.util.module_from_spec(spec)
        with mock.patch.dict(sys.modules, {"index_archive": fixtures.READER}):
            spec.loader.exec_module(module)
        captured = []
        with (mock.patch.object(module, "extract", side_effect=lambda args: captured.append(args) or {}),
              mock.patch.object(sys, "argv", [str(READ), "synthetic.zip", "synthetic.sqlite3",
                                             "--content-id", "synthetic", "--output", "synthetic.bin"]),
              mock.patch("builtins.print")):
            module.main()
        args = captured[0]
        self.assertEqual(args.max_bytes, 1280 * 1024 * 1024)
        self.assertEqual((args.max_expanded_bytes, args.max_archive_bytes), (1400 * 1024 * 1024,) * 2)

    def test_previously_accepted_oversized_event_index_cannot_bypass_read_policy(self):
        from unittest import mock
        def oversized(event):
            value = dict(event)
            if value["seq"] == 1:
                value["payload"] = dict(value["payload"], padding="A" * 660000)
            return fixtures.encoded(value)
        manifest, events, bins = self.fixture.current_fixture(oversized)
        fixtures.configured(manifest)
        self.fixture.write_archive(manifest, events, bins, event_encode=oversized)
        raw_zip = self.fixture.archive.read_bytes()
        identity = {"schemaVersion": 1, "sha256": hashlib.sha256(raw_zip).hexdigest(), "size": len(raw_zip)}
        old_limits = fixtures.READER.derive_flow_limits(manifest["capturePolicy"]["settings"])
        old_limits["budget"]["eventBytes"] = fixtures.READER.MAX_EVENT_BYTES
        with zipfile.ZipFile(self.fixture.archive) as zf:
            checked_manifest, chunks, checked = fixtures.READER.validate(zf, 512000000, 8192000000)
            with mock.patch.object(fixtures.READER, "validate_flow_policy", return_value=old_limits):
                fixtures.READER.build_index(zf, checked_manifest, chunks, checked, self.fixture.index, archive_identity=identity)
        result = self.rejected("--event-id", "e1", "--field", "dom/标题~")
        self.assertIn("Event line exceeds reader limit", result.stderr)


if __name__ == "__main__":
    unittest.main()
