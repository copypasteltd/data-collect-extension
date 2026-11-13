import hashlib
import base64
import gzip
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
RECONSTRUCT = ROOT / "skills" / "extension-logic-clone" / "scripts" / "reconstruct_payload.py"
DECODE_STYLE = ROOT / "skills" / "extension-logic-clone" / "scripts" / "decode_computed_style.py"


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

    def test_fragment_reconstruction_validates_order_and_utf16(self):
        text = "x" * 99999 + "😀" + "z"
        encoded = text.encode("utf-16-le")
        parts = [encoded[:200000].decode("utf-16-le", "surrogatepass"),
                 encoded[200000:].decode("utf-16-le", "surrogatepass")]
        reference = {"captureId": "capture", "field": "sourceHtml", "length": len(encoded) // 2, "parts": 2}
        events = [
            {"id": "owner", "seq": 1, "kind": "page.snapshot", "payload": {"sourceReference": reference}},
            *[{"id": f"part-{index}", "seq": index + 2, "kind": "capture.fragment",
               "payload": {**reference, "index": index, "data": part}} for index, part in enumerate(parts)],
            {"id": "end", "seq": 4, "kind": "capture.fragmentEnd", "payload": {**reference, "status": "confirmed"}},
        ]
        with closing(sqlite3.connect(self.index)) as db:
            db.execute("CREATE TABLE events (id TEXT, seq INTEGER, kind TEXT, event_json TEXT)")
            db.executemany("INSERT INTO events VALUES (?, ?, ?, ?)",
                           [(event["id"], event["seq"], event["kind"], json.dumps(event)) for event in events])
            db.commit()
        output = self.folder / "reconstructed.html"
        args = [sys.executable, str(RECONSTRUCT), str(self.index), "--event-id", "owner",
                "--reference", "/payload/sourceReference", "--output", str(output)]
        result = subprocess.run(args, capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(output.read_text(encoding="utf-8"), text)
        self.assertNotEqual(subprocess.run(args, capture_output=True).returncode, 0)
        output.unlink()
        with closing(sqlite3.connect(self.index)) as db:
            db.execute("DELETE FROM events WHERE id='part-1'")
            db.commit()
        self.assertNotEqual(subprocess.run(args, capture_output=True).returncode, 0)
        self.assertFalse(output.exists())

    def test_fragment_reconstruction_decodes_and_checks_bytes(self):
        data = bytes(range(256)) * 600
        text = base64.b64encode(data).decode("ascii")
        parts = [text[index:index + 100000] for index in range(0, len(text), 100000)]
        reference = {"captureId": "file", "field": "fileBytesBase64", "length": len(text), "parts": len(parts)}
        events = [
            {"id": "owner", "seq": 1, "kind": "interaction.change", "payload": {"files": [{"contentReference": reference}]}},
            *[{"id": f"part-{index}", "seq": index + 2, "kind": "capture.fragment",
               "payload": {**reference, "index": index, "data": part}} for index, part in enumerate(parts)],
            {"id": "end", "seq": len(parts) + 2, "kind": "capture.fragmentEnd", "payload": {**reference, "status": "confirmed"}},
        ]
        with closing(sqlite3.connect(self.index)) as db:
            db.execute("CREATE TABLE events (id TEXT, seq INTEGER, kind TEXT, event_json TEXT)")
            db.executemany("INSERT INTO events VALUES (?, ?, ?, ?)",
                           [(event["id"], event["seq"], event["kind"], json.dumps(event)) for event in events])
            db.commit()
        output = self.folder / "reconstructed.bin"
        args = [sys.executable, str(RECONSTRUCT), str(self.index), "--event-id", "owner", "--base64",
                "--reference", "/payload/files/0/contentReference", "--output", str(output), "--expected-bytes"]
        self.assertNotEqual(subprocess.run([*args, "1"], capture_output=True).returncode, 0)
        self.assertFalse(output.exists())
        result = subprocess.run([*args, str(len(data))], capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(output.read_bytes(), data)

    def test_computed_style_decoding_and_integrity(self):
        entries = [{"nodeId": "1", "properties": [["color", "rgb(1, 2, 3)"], ["--text", "\ud800"]]}]
        raw = json.dumps(entries).encode("utf-8")
        compressed = gzip.compress(raw)
        payload = {"entriesEncoding": "gzip-base64-json-v1", "entriesData": base64.b64encode(compressed).decode(),
                   "entriesBytes": len(raw), "entryCount": 1}
        event = {"id": "style", "kind": "page.computedStyle", "payload": payload}
        with closing(sqlite3.connect(self.index)) as db:
            db.execute("CREATE TABLE events (id TEXT, event_json TEXT)")
            db.execute("INSERT INTO events VALUES (?, ?)", ("style", json.dumps(event)))
            db.commit()
        output = self.folder / "styles.json"
        args = [sys.executable, str(DECODE_STYLE), str(self.index), "--event-id", "style", "--output", str(output)]
        result = subprocess.run(args, capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(output.read_text(encoding="utf-8")), entries)
        self.assertNotEqual(subprocess.run(args, capture_output=True).returncode, 0)
        output.unlink()
        corrupted = bytearray(compressed)
        corrupted[-8] ^= 1
        event["payload"]["entriesData"] = base64.b64encode(corrupted).decode()
        with closing(sqlite3.connect(self.index)) as db:
            db.execute("UPDATE events SET event_json = ? WHERE id = ?", (json.dumps(event), "style"))
            db.commit()
        self.assertNotEqual(subprocess.run(args, capture_output=True).returncode, 0)
        self.assertFalse(output.exists())


class FragmentContractTests(unittest.TestCase):
    """Synthetic in-memory fragment checks; authored but not executed for ARCH06."""

    @classmethod
    def setUpClass(cls):
        import importlib.util
        spec = importlib.util.spec_from_file_location("fragment_reconstruction", RECONSTRUCT)
        cls.fragments = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.fragments)
        cls.fixture = json.loads((Path(__file__).parent / "fixtures" / "fragment-conformance.json").read_text(encoding="utf-8"))

    @staticmethod
    def expand_fixture_text(value):
        if isinstance(value, list):
            return "".join(part if isinstance(part, str) else part["text"] * part["repeat"] for part in value)
        return value

    def fixture_events(self, entry):
        kinds = {"part": "capture.fragment", "end": "capture.fragmentEnd", "failure": "capture.fragmentFailure"}
        events = []
        for offset, recipe in enumerate(entry["events"]):
            payload = dict(entry["reference"])
            if recipe["type"] == "part":
                payload.update(index=recipe["index"], data=self.expand_fixture_text(recipe["data"]))
            if recipe["type"] == "end":
                payload["status"] = "confirmed"
            if recipe["type"] == "failure":
                payload["status"] = "failed"
            payload.update(recipe.get("payload", {}))
            for key in recipe.get("omit", []):
                payload.pop(key, None)
            events.append({"kind": kinds.get(recipe["type"], recipe.get("kind")), "seq": offset + 1, "payload": payload})
        return events

    def test_shared_fragment_conformance_fixture(self):
        self.assertEqual(self.fixture["format"], "fragment-conformance-v1")
        errors = {"reference": "invalid fragment reference", "failure": "reported failure",
                  "incomplete": "transfer is incomplete"}
        for entry in self.fixture["cases"]:
            with self.subTest(case=entry["name"]):
                events = self.fixture_events(entry)
                if entry["complete"]:
                    actual = self.fragments.reconstruct(entry["reference"], events)
                    expected = self.expand_fixture_text(entry["expected"])
                    # Compare UTF-16 units, not Python scalar-count or normalized replacement text.
                    self.assertEqual(actual.encode("utf-16-le", "surrogatepass"),
                                     expected.encode("utf-16-le", "surrogatepass"))
                    self.assertEqual(self.fragments.utf16_length(actual), entry["reference"]["length"])
                else:
                    with self.assertRaisesRegex(ValueError, errors.get(entry.get("error"), ".")):
                        self.fragments.reconstruct(entry["reference"], events)

    def test_shared_numeric_oracle_for_every_fragment_metadata_position(self):
        targets = (("reference", "length"), ("reference", "parts"), (0, "length"), (0, "parts"),
                   (1, "length"), (1, "parts"), (0, "index"))
        for numeric in self.fixture["safeIntegerCases"]:
            value = json.loads(numeric["valueJson"])
            self.assertEqual(self.fragments.is_safe_integer(value), numeric["safe"], numeric["name"])
            for target, key in targets:
                with self.subTest(numeric=numeric["name"], target=target, key=key):
                    reference = {"captureId": "numeric", "field": "sourceHtml", "length": 1, "parts": 1}
                    events = [
                        {"kind": "capture.fragment", "payload": {**reference, "index": 0, "data": "x"}},
                        {"kind": "capture.fragmentEnd", "payload": {**reference, "status": "confirmed"}},
                    ]
                    if target == "reference":
                        reference[key] = value
                    else:
                        events[target]["payload"][key] = value
                    expected = numeric["safe"] and value == (0 if key == "index" else 1)
                    if expected:
                        self.assertEqual(self.fragments.reconstruct(reference, events), "x")
                    else:
                        with self.assertRaises(ValueError):
                            self.fragments.reconstruct(reference, events)

    def test_failure_overrides_confirmation_at_every_position(self):
        reference = {"captureId": "failure", "field": "sourceHtml", "length": 1, "parts": 1}
        part = {"kind": "capture.fragment", "payload": {**reference, "index": 0, "data": "x"}}
        end = {"kind": "capture.fragmentEnd", "payload": {**reference, "status": "confirmed"}}
        for metadata in ({}, {"length": "invalid", "parts": 0, "status": "confirmed"}):
            failure = {"kind": "capture.fragmentFailure", "payload": {
                "captureId": reference["captureId"], "field": reference["field"], **metadata}}
            for position in range(3):
                with self.subTest(metadata=metadata, position=position):
                    events = [part, end]
                    events.insert(position, failure)
                    with self.assertRaisesRegex(ValueError, "reported failure"):
                        self.fragments.reconstruct(reference, events)

    def test_numeric_metadata_uses_safe_integer_values_not_python_equality(self):
        reference = {"captureId": "numeric", "field": "sourceHtml", "length": 1, "parts": 1}
        part = {"kind": "capture.fragment", "payload": {**reference, "index": 0, "data": "x"}}
        end = {"kind": "capture.fragmentEnd", "payload": {**reference, "status": "confirmed"}}
        invalid = (True, False, None, "1", 0.5, float("inf"), float("-inf"), float("nan"),
                   9007199254740992, -9007199254740992)
        for key in ("length", "parts"):
            for value in invalid:
                with self.subTest(target="reference", key=key, value=value):
                    with self.assertRaises(ValueError):
                        self.fragments.reconstruct({**reference, key: value}, [part, end])
                for target in range(2):
                    with self.subTest(target=target, key=key, value=value):
                        events = [{**event, "payload": dict(event["payload"])} for event in (part, end)]
                        events[target]["payload"][key] = value
                        with self.assertRaises(ValueError):
                            self.fragments.reconstruct(reference, events)
        for value in invalid:
            with self.subTest(key="index", value=value):
                bad_part = {**part, "payload": {**part["payload"], "index": value}}
                with self.assertRaises(ValueError):
                    self.fragments.reconstruct(reference, [bad_part, end])


if __name__ == "__main__":
    unittest.main()
