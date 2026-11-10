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


def fail(message):
    raise ValueError(message)


def read_json(zf, name, maximum=32000000):
    info = zf.getinfo(name)
    if info.file_size > maximum:
        fail(f"{name} exceeds the metadata size limit")
    with zf.open(info) as stream:
        data = stream.read(maximum + 1)
    if len(data) > maximum:
        fail(f"{name} exceeds the metadata size limit")
    return json.loads(data.decode("utf-8"))


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
            or type(manifest.get("version")) is not int or manifest.get("version") not in (1, 2)):
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
                or type(size) is not int or size < 0 or not isinstance(expected, str)
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
    return manifest, chunks, checked


def scalar(value):
    if isinstance(value, str):
        return value.encode("utf-8", "backslashreplace").decode("utf-8")
    if type(value) is int and -(2**63) <= value < 2**63:
        return value
    if type(value) is float and math.isfinite(value):
        return value
    return None


def build_index(zf, manifest, chunks, checked, target):
    fd = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(fd)
    db = None
    success = False
    try:
        db = sqlite3.connect(target)
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
        """)
        db.execute("INSERT INTO metadata VALUES (?, ?)", ("manifest", json.dumps(manifest, ensure_ascii=True)))
        db.executemany("INSERT INTO files VALUES (?, ?, ?)", ((name, *info) for name, info in checked.items()))
        count = 0
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
                    event = json.loads(line.decode("utf-8"))
                    if not isinstance(event, dict):
                        fail(f"invalid event: {name}:{line_number}")
                    event_id, kind, seq, timestamp, payload = (event.get(key) for key in ("id", "kind", "seq", "time", "payload"))
                    if (not isinstance(event_id, str) or not event_id or len(event_id) > 128
                            or not isinstance(kind, str) or len(kind) > 128
                            or type(seq) is not int or abs(seq) > 9007199254740991
                            or type(timestamp) not in (int, float) or not math.isfinite(timestamp)
                            or not isinstance(payload, dict)):
                        fail(f"invalid event: {name}:{line_number}")
                    db.execute("INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", (
                        event_id, seq, timestamp, kind, scalar(event.get("tabId")), scalar(event.get("frameId")),
                        scalar(event.get("documentId")), scalar(payload.get("url")), scalar(payload.get("requestId")),
                        name, line_number, json.dumps(event, ensure_ascii=True, separators=(",", ":"))))
                    kinds[kind] += 1
            if chunk_size != checked[name][0] or not hmac.compare_digest(chunk_digest.hexdigest(), checked[name][1]):
                fail(f"event chunk changed during indexing: {name}")
        if manifest["version"] == 2 and (type(manifest.get("eventCount")) is not int or manifest["eventCount"] != count):
            fail("event count does not match manifest")
        db.commit()
        success = True
        return {"verification": "passed", "version": manifest["version"], "events": count,
                "files": len(checked), "event_types": dict(sorted(kinds.items()))}
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
    except (OSError, ValueError, KeyError, UnicodeError, json.JSONDecodeError, sqlite3.Error, zipfile.BadZipFile, RuntimeError) as error:
        print(f"Indexing failed: {error}", file=sys.stderr)
        sys.exit(1)
