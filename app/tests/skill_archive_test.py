import hashlib
from contextlib import closing
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
import warnings
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "skills" / "extension-logic-clone" / "scripts" / "index_archive.py"


class ArchiveIndexTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="test-skill-", dir=ROOT)
        self.folder = Path(self.temp.name)
        self.archive = self.folder / "fixture.zip"
        self.index = self.folder / "index.sqlite3"

    def tearDown(self):
        self.temp.cleanup()

    def write_archive(self, version=2, *, bad_hash=False, extra_path=None, count=2, duplicate_id=False):
        chunk = "timeline/events.jsonl" if version == 1 else "timeline/events-00001.jsonl"
        events = [
            {"id": "e1", "seq": 1, "time": 10, "kind": "page.snapshot", "tabId": 1,
             "payload": {"url": "https://example.test/#token=fixture", "sourceHtml": "<script>fixture</script>"}},
            {"id": "e1" if duplicate_id else "e2", "seq": 2, "time": 11, "kind": "network.request",
             "payload": {"requestId": "req-1", "url": "https://example.test/api?token=fixture-secret", "text": "\ud800"}},
        ]
        manifest = {"format": "logic-recorder", "version": version, "session": {"id": "fixture"}, "eventCount": count}
        if version == 2:
            manifest["eventChunks"] = [chunk]
        files = {
            "manifest.json": json.dumps(manifest).encode(),
            chunk: ("\n".join(json.dumps(event) for event in events) + "\n").encode(),
            "resources/index.json": b"[]",
        }
        if extra_path:
            files[extra_path] = b"fixture"
        integrity = [{"path": name, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
                     for name, data in files.items()]
        if bad_hash:
            integrity[1]["sha256"] = "0" * 64
        with zipfile.ZipFile(self.archive, "w", zipfile.ZIP_DEFLATED) as zf:
            for name, data in files.items():
                zf.writestr(name, data)
            zf.writestr("integrity.json", json.dumps(integrity))

    def run_index(self, *extra):
        return subprocess.run([sys.executable, str(SCRIPT), str(self.archive), "--output", str(self.index), *extra],
                              capture_output=True, text=True, encoding="utf-8", env={**os.environ, "PYTHONUTF8": "1"})

    def test_versions_preserve_events_and_evidence(self):
        for version in (1, 2):
            with self.subTest(version=version):
                self.write_archive(version)
                result = self.run_index()
                self.assertEqual(result.returncode, 0, result.stderr)
                summary = json.loads(result.stdout)
                self.assertEqual(summary["events"], 2)
                self.assertNotIn("fixture-secret", result.stdout)
                with closing(sqlite3.connect(self.index)) as db:
                    row = db.execute("SELECT request_id, chunk, line, event_json FROM events WHERE id='e2'").fetchone()
                    self.assertEqual(row[:1], ("req-1",))
                    self.assertEqual(row[2], 2)
                    self.assertEqual(json.loads(row[3])["payload"]["text"], "\ud800")
                    self.assertIn("fixture-secret", json.loads(row[3])["payload"]["url"])
                self.index.unlink()

    def test_corrupt_or_unsafe_archives_are_rejected(self):
        for kwargs in ({"bad_hash": True}, {"extra_path": "../escape"}, {"count": 3}, {"duplicate_id": True}):
            with self.subTest(kwargs=kwargs):
                self.write_archive(**kwargs)
                result = self.run_index()
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(self.index.exists())
                self.assertFalse((self.folder.parent / "escape").exists())

    def test_existing_index_is_never_overwritten(self):
        self.write_archive()
        self.index.write_bytes(b"existing")
        result = self.run_index()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.index.read_bytes(), b"existing")

    def test_duplicate_zip_path_is_rejected(self):
        self.write_archive()
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            with zipfile.ZipFile(self.archive, "a") as zf:
                zf.writestr("manifest.json", "{}")
        result = self.run_index()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.index.exists())

    def test_size_limit_is_enforced(self):
        self.write_archive()
        self.assertNotEqual(self.run_index("--max-entry-mb", "0").returncode, 0)
        self.assertFalse(self.index.exists())


if __name__ == "__main__":
    unittest.main()
