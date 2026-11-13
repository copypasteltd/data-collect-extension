#!/usr/bin/env python3
"""Validate a Logic Recorder archive and index its events without extracting it."""
import argparse
import collections
import hashlib
import hmac
import json
import math
import os
import re
import sqlite3
import sys
import zipfile
from pathlib import Path, PurePosixPath

MAX_FILES = 30000
MAX_EVENT_BYTES = 40000000
MAX_EVENTS = 1000000
MAX_SAFE_INTEGER = 9007199254740991
CONTENT_FIELDS = {"contentId", "sha256", "size", "mime", "category", "status"}
CONTENT_CATEGORIES = {"body", "dom", "resource", "screenshot", "meta"}


def fail(message):
    raise ValueError(message)


def safe_integer(value, minimum=0):
    return type(value) is int and minimum <= value <= MAX_SAFE_INTEGER


def safe_mime(value):
    return (isinstance(value, str) and 0 < len(value) <= 256
            and not re.search(r"[\x00-\x1f\x7f-\x9f\ud800-\udfff]", value))


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            fail("duplicate JSON object key")
        result[key] = value
    return result


def invalid_constant(_value):
    fail("non-finite JSON number")


def finite_float(value):
    number = float(value)
    if not math.isfinite(number):
        fail("non-finite JSON number")
    return number


def decode_json(data):
    return json.loads(data.decode("utf-8"), object_pairs_hook=unique_object,
                      parse_constant=invalid_constant, parse_float=finite_float)


def read_json(zf, name, maximum=32000000):
    info = zf.getinfo(name)
    if info.file_size > maximum:
        fail(f"{name} exceeds the metadata size limit")
    with zf.open(info) as stream:
        data = stream.read(maximum + 1)
    if len(data) > maximum:
        fail(f"{name} exceeds the metadata size limit")
    return decode_json(data)


def validate(zf, max_entry, max_total):
    entries = zf.infolist()
    if len(entries) > MAX_FILES:
        fail("too many ZIP entries")
    names = set()
    total = 0
    for item in entries:
        name = item.filename
        parts = name.split("/")
        if (item.orig_filename != name or not name or name.startswith("/") or "\\" in name or "\x00" in name
                or re.match(r"^[a-zA-Z]:", name) or any(part in ("", ".", "..") for part in parts)
                or PurePosixPath(name).is_absolute() or item.is_dir() or item.flag_bits & 1):
            fail("unsafe, encrypted, or unsupported ZIP entry")
        if name in names:
            fail("duplicate ZIP entry")
        names.add(name)
        if item.file_size > max_entry:
            fail("ZIP entry exceeds the configured size limit")
        total += item.file_size
        if total > max_total:
            fail("ZIP expanded size exceeds the configured limit")
    if not {"manifest.json", "integrity.json"}.issubset(names):
        fail("archive is missing a manifest or integrity list")
    manifest = read_json(zf, "manifest.json")
    if (not isinstance(manifest, dict) or manifest.get("format") != "logic-recorder"
            or type(manifest.get("version")) is not int or manifest.get("version") not in (1, 2, 3)):
        fail("unsupported recording format or version")
    session = manifest.get("session")
    if not isinstance(session, dict) or not isinstance(session.get("id"), str):
        fail("invalid session metadata")
    integrity = read_json(zf, "integrity.json")
    if not isinstance(integrity, list) or len(integrity) > MAX_FILES:
        fail("invalid integrity list")
    checked = {}
    for entry in integrity:
        if not isinstance(entry, dict):
            fail("invalid integrity entry")
        name, size, expected = entry.get("path"), entry.get("size"), entry.get("sha256")
        if (not isinstance(name, str) or name == "integrity.json" or name in checked or name not in names
                or not safe_integer(size) or not isinstance(expected, str)
                or not re.fullmatch(r"[0-9a-f]{64}", expected)):
            fail("invalid or duplicate integrity entry")
        info = zf.getinfo(name)
        if info.file_size != size:
            fail(f"integrity size mismatch: {name}")
        digest = hashlib.sha256()
        read_size = 0
        with zf.open(info) as stream:
            while True:
                chunk = stream.read(1024 * 1024)
                if not chunk:
                    break
                read_size += len(chunk)
                if read_size > size or read_size > max_entry:
                    fail(f"expanded entry exceeds declared size: {name}")
                digest.update(chunk)
        if read_size != size or not hmac.compare_digest(digest.hexdigest(), expected):
            fail(f"integrity checksum mismatch: {name}")
        checked[name] = (size, expected)
    if set(checked) != names - {"integrity.json"}:
        fail("integrity list does not cover every ZIP file")
    if manifest["version"] == 1:
        chunks = ["timeline/events.jsonl"]
    else:
        chunks = manifest.get("eventChunks")
        if (not isinstance(chunks, list) or len(chunks) > MAX_FILES
                or any(not isinstance(name, str) or not re.fullmatch(r"timeline/events-\d{5}\.jsonl", name) for name in chunks)
                or len(set(chunks)) != len(chunks)):
            fail("invalid event chunk list")
    if any(name not in checked for name in chunks):
        fail("missing event chunk")
    if manifest["version"] == 3:
        validate_flow_manifest(manifest, chunks, checked)
    return manifest, chunks, checked


def validate_flow_manifest(manifest, chunks, checked):
    session = manifest["session"]
    if (manifest.get("profile") != "business-flow-v1" or manifest.get("derivations") != "none"
            or not session["id"] or "ownerToken" in session
            or not isinstance(manifest.get("capturePolicy"), dict) or not isinstance(manifest.get("budget"), dict)):
        fail("invalid business flow profile, policy, budget, or session metadata")
    for key, maximum in (("eventCount", MAX_EVENTS), ("contentCount", MAX_FILES)):
        if not safe_integer(manifest.get(key)) or manifest[key] > maximum:
            fail("invalid business flow manifest count")
        if key in session and (not safe_integer(session[key]) or session[key] != manifest[key]):
            fail("session count does not match manifest")
    if "lastSeq" in session and not safe_integer(session["lastSeq"]):
        fail("invalid session sequence watermark")
    budget = manifest["budget"]
    for key in ("usedBytes", "limitBytes", "reserveBytes"):
        if key in budget and not safe_integer(budget[key]):
            fail("invalid budget byte count")
    for key in ("warning", "policyStopped"):
        if key in budget and type(budget[key]) is not bool:
            fail("invalid budget flag")
    if "byCategory" in budget and (not isinstance(budget["byCategory"], dict)
            or any(not safe_integer(value) for value in budget["byCategory"].values())):
        fail("invalid category budget")
    expected_chunks = [f"timeline/events-{index:05d}.jsonl" for index in range(1, len(chunks) + 1)]
    if chunks != expected_chunks or {name for name in checked if name.startswith("timeline/")} != set(chunks):
        fail("event chunks are unordered, nonconsecutive, or unlisted")
    contents = manifest.get("contents")
    if not isinstance(contents, list) or len(contents) != manifest["contentCount"]:
        fail("content count does not match manifest")
    content_ids, paths = set(), set()
    for content in contents:
        if not isinstance(content, dict):
            fail("invalid manifest content")
        content_id, path, size, sha256, mime, category = (
            content.get(key) for key in ("contentId", "path", "size", "sha256", "mime", "category"))
        if (not isinstance(content_id, str) or not content_id or len(content_id) > 128
                or not isinstance(sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", sha256)
                or not safe_integer(size) or not safe_mime(mime)
                or not isinstance(category, str) or category not in CONTENT_CATEGORIES
                or content_id != f"{session['id']}:{sha256}"
                or path != f"contents/{sha256}.bin" or content_id in content_ids or path in paths):
            fail("invalid or duplicate manifest content")
        if path not in checked or checked[path] != (size, sha256):
            fail("manifest content does not match verified ZIP entry")
        content_ids.add(content_id)
        paths.add(path)
    if {name for name in checked if name.startswith("contents/")} != paths:
        fail("unlisted or missing content entry")


def content_references(payload, contents):
    # Only store-assigned top-level captured references are schema markers.
    # Do not recurse into arbitrary business objects or infer references from an id alone.
    for field, value in payload.items():
        if not isinstance(value, dict) or value.get("status") != "captured" or "contentId" not in value:
            continue
        if set(value) != CONTENT_FIELDS:
            fail("invalid captured content reference schema")
        content_id = value["contentId"]
        if (not isinstance(content_id, str) or content_id not in contents
                or not safe_integer(value["size"])
                or not safe_mime(value["mime"])
                or not isinstance(value["category"], str) or value["category"] not in CONTENT_CATEGORIES):
            fail("invalid or unknown captured content reference")
        content = contents[content_id]
        if value["sha256"] != content["sha256"] or value["size"] != content["size"]:
            fail("captured content reference size or checksum mismatch")
        # A later observation may use a different MIME/category for the same stored bytes.
        yield field, content_id, value["mime"], value["category"]


def scalar(value):
    if isinstance(value, str):
        return value.encode("utf-8", "backslashreplace").decode("utf-8")
    if type(value) is int and -(2**63) <= value < 2**63:
        return value
    if type(value) is float and math.isfinite(value):
        return value
    return None


def build_index(zf, manifest, chunks, checked, target):
    flow = manifest["version"] == 3
    contents = {entry["contentId"]: entry for entry in manifest["contents"]} if flow else {}
    fd = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(fd)
    db = None
    success = False
    try:
        db = sqlite3.connect(target)
        db.execute("PRAGMA foreign_keys = ON")
        db.executescript("""
            CREATE TABLE metadata (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
            CREATE TABLE files (path TEXT PRIMARY KEY, size INTEGER NOT NULL, sha256 TEXT NOT NULL);
            CREATE TABLE events (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, time REAL NOT NULL,
                kind TEXT NOT NULL, tab_id, frame_id, document_id TEXT, url TEXT, request_id TEXT,
                chunk TEXT NOT NULL, line INTEGER NOT NULL, event_json TEXT NOT NULL);
            CREATE INDEX events_order ON events(time, seq);
            CREATE INDEX events_kind ON events(kind);
            CREATE INDEX events_request ON events(request_id, seq);
            CREATE INDEX events_page ON events(tab_id, frame_id, document_id, time);
            CREATE TABLE contents (content_id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE REFERENCES files(path),
                size INTEGER NOT NULL, sha256 TEXT NOT NULL, mime TEXT NOT NULL, category TEXT NOT NULL);
            CREATE TABLE content_refs (event_id TEXT NOT NULL REFERENCES events(id), field TEXT NOT NULL,
                content_id TEXT NOT NULL REFERENCES contents(content_id), mime TEXT NOT NULL, category TEXT NOT NULL,
                PRIMARY KEY (event_id, field));
            CREATE INDEX content_refs_content ON content_refs(content_id);
        """)
        db.execute("INSERT INTO metadata VALUES (?, ?)", ("manifest", json.dumps(manifest, ensure_ascii=True)))
        db.executemany("INSERT INTO files VALUES (?, ?, ?)", ((name, *info) for name, info in checked.items()))
        db.executemany("INSERT INTO contents VALUES (?,?,?,?,?,?)", (
            tuple(entry[key] for key in ("contentId", "path", "size", "sha256", "mime", "category"))
            for entry in contents.values()))
        count, last_seq = 0, 0
        kinds = collections.Counter()
        for name in chunks:
            chunk_digest = hashlib.sha256()
            chunk_size = 0
            with zf.open(name) as stream:
                line_number = 0
                while True:
                    line = stream.readline(MAX_EVENT_BYTES + 1)
                    if not line:
                        break
                    chunk_digest.update(line)
                    chunk_size += len(line)
                    line_number += 1
                    if len(line) > MAX_EVENT_BYTES:
                        fail(f"event line exceeds limit: {name}:{line_number}")
                    if not line.strip():
                        continue
                    count += 1
                    if count > MAX_EVENTS:
                        fail("event count exceeds the index limit")
                    event = decode_json(line)
                    if not isinstance(event, dict):
                        fail(f"invalid event: {name}:{line_number}")
                    event_id, kind, seq, timestamp, payload = (event.get(key) for key in ("id", "kind", "seq", "time", "payload"))
                    if (not isinstance(event_id, str) or not event_id or len(event_id) > 128
                            or not isinstance(kind, str) or len(kind) > 128
                            or type(seq) is not int or abs(seq) > MAX_SAFE_INTEGER
                            or type(timestamp) not in (int, float) or not math.isfinite(timestamp)
                            or not isinstance(payload, dict)):
                        fail(f"invalid event: {name}:{line_number}")
                    if flow:
                        if (event.get("sessionId") != manifest["session"]["id"] or not kind
                                or not safe_integer(seq, 1) or seq <= last_seq
                                or timestamp < 0 or timestamp > MAX_SAFE_INTEGER):
                            fail("invalid business flow event identity, sequence, or time")
                        for key in ("tabId", "frameId"):
                            if key in event and event[key] is not None and not safe_integer(event[key]):
                                fail("invalid business flow browser identifier")
                        last_seq = seq
                    db.execute("INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", (
                        event_id, seq, timestamp, kind, scalar(event.get("tabId")), scalar(event.get("frameId")),
                        scalar(event.get("documentId")), scalar(payload.get("url")), scalar(payload.get("requestId")),
                        name, line_number, json.dumps(event, ensure_ascii=True, separators=(",", ":"))))
                    if flow:
                        db.executemany("INSERT INTO content_refs VALUES (?,?,?,?,?)", (
                            (event_id, field, content_id, mime, category)
                            for field, content_id, mime, category in content_references(payload, contents)))
                    kinds[kind] += 1
            if chunk_size != checked[name][0] or not hmac.compare_digest(chunk_digest.hexdigest(), checked[name][1]):
                fail(f"event chunk changed during indexing: {name}")
        if manifest["version"] in (2, 3) and (not safe_integer(manifest.get("eventCount")) or manifest["eventCount"] != count):
            fail("event count does not match manifest")
        if flow and "lastSeq" in manifest["session"] and manifest["session"]["lastSeq"] != last_seq:
            fail("session sequence watermark does not match events")
        db.commit()
        success = True
        return {"verification": "passed", "version": manifest["version"], "events": count,
                "files": len(checked), "contentCount": len(contents), "event_types": dict(sorted(kinds.items()))}
    finally:
        if db is not None:
            db.close()
        if not success:
            Path(target).unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--output", required=True, type=Path, help="new SQLite index path; never overwritten")
    parser.add_argument("--max-archive-mb", type=int, default=2048)
    parser.add_argument("--max-entry-mb", type=int, default=512)
    parser.add_argument("--max-expanded-mb", type=int, default=8192)
    args = parser.parse_args()
    if min(args.max_archive_mb, args.max_entry_mb, args.max_expanded_mb) <= 0:
        fail("size limits must be positive")
    if args.archive.stat().st_size > args.max_archive_mb * 1000000:
        fail("ZIP exceeds the configured archive size limit")
    if not args.output.parent.is_dir():
        fail("output parent directory does not exist")
    with zipfile.ZipFile(args.archive) as zf:
        manifest, chunks, checked = validate(zf, args.max_entry_mb * 1000000, args.max_expanded_mb * 1000000)
        summary = build_index(zf, manifest, chunks, checked, args.output)
    print(json.dumps(summary, ensure_ascii=True))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, UnicodeError, json.JSONDecodeError, sqlite3.Error, zipfile.BadZipFile, RuntimeError, OverflowError) as error:
        print(f"Indexing failed: {error}", file=sys.stderr)
        sys.exit(1)
