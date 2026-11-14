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
MIB = 1024 * 1024
LEGACY_FLOW_SETTINGS = {"schemaVersion": 1, "budgetMultiplier": 1, "queueMultiplier": 1, "samplingMultiplier": 1}


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


def validate_flow_settings(value):
    if (not isinstance(value, dict) or set(value) != set(LEGACY_FLOW_SETTINGS)
            or type(value.get("schemaVersion")) is not int or value["schemaVersion"] != 1
            or any(not safe_integer(value[key], 1) or value[key] > 20
                   for key in ("budgetMultiplier", "queueMultiplier", "samplingMultiplier"))):
        fail("invalid flow settings; multipliers must be integers from 1 to 20")
    return value


def derive_flow_limits(settings):
    # Mirrors app/src/flow-config.js; a record cannot authorize arbitrary limits.
    validate_flow_settings(settings)
    b, q, s = (settings[key] for key in ("budgetMultiplier", "queueMultiplier", "samplingMultiplier"))
    budget = {"totalBytes": 64 * MIB * b, "warningBytes": 48 * MIB * b, "reserveBytes": MIB * b,
              "normalBytes": 63 * MIB * b, "eventBytes": 32 * 1024 * b, "singleBodyBytes": 2 * MIB * b,
              "maxBodyBytes": 2 * MIB * b, "normalMetaBytes": 3 * MIB * b,
              "categoryBytes": {key: value * MIB * b for key, value in
                                (("body", 24), ("dom", 16), ("resource", 8), ("screenshot", 12), ("meta", 4))}}
    background = {"body": 2 * MIB * b, "resource": 8 * MIB * b, "screenshot": 4 * MIB * b,
                  "metadata": 32 * 1024 * b, "batchBytes": 4 * MIB * q, "queuedBytes": 8 * MIB * q,
                  "queue": 64 * q, "requests": 128 * q, "frames": 32 * s, "batch": 64 * q,
                  "streams": 32 * s, "resourceObservations": 128 * s, "notices": 24 * s, "batchHistory": 256 * q,
                  "screenshotInterval": 1000, "flushMs": 3000, "stopMs": 300, "detachMs": 2000, "commandMs": 2000}
    content = {"maxBytes": 2 * MIB * b, "metadataBytes": 30 * 1024 * b, "queueEvents": 32 * q,
               "queueBytes": 6 * MIB * q, "batchEvents": 8 * q, "pendingInputs": 32 * q,
               "domNodes": 12000 * s, "shadowHosts": 16 * s, "shadowNodes": 2000 * s, "formCount": 128 * s,
               "formMetadataBytes": 16000 * b, "formMetadataSoftBytes": 14000 * b, "maxContents": 16 * s,
               "stylesheetCount": 32 * s, "stylesheetRulesPerSheet": 2000 * s, "stylesheetRules": 8000 * s,
               "stylesheetHashes": 256 * s, "resourceUrls": 128 * s, "resourceHashes": 256 * s,
               "resourceMetadataBytes": 14000 * b, "stylesheetMetadataBytes": 6000 * b, "transientNodes": 8 * s,
               "transientBytes": 8192 * b, "transientTextBytes": 7000 * b, "transientTextNodes": 128 * s,
               "mutationRecords": 64 * s, "mutationChildren": 8 * s, "domDepth": 64, "transientDepth": 8,
               "ancestorDepth": 5, "attributeCount": 64}
    return {"settings": settings, "budget": budget, "background": background, "content": content}


def matches_limits(value, expected):
    if isinstance(expected, dict):
        return (isinstance(value, dict) and set(value) == set(expected)
                and all(matches_limits(value[key], item) for key, item in expected.items()))
    return safe_integer(value) and value == expected


def validate_flow_policy(manifest):
    policy, budget, session = manifest["capturePolicy"], manifest["budget"], manifest["session"]
    settings = validate_flow_settings(policy["settings"]) if "settings" in policy else LEGACY_FLOW_SETTINGS
    derived = derive_flow_limits(settings)
    if "settings" in budget and validate_flow_settings(budget["settings"]) != settings:
        fail("budget settings do not match capture policy")
    if "capturePolicy" in session and (not isinstance(session["capturePolicy"], dict)
            or json.dumps(session["capturePolicy"], sort_keys=True) != json.dumps(policy, sort_keys=True)):
        fail("session capture policy does not match manifest")
    for key, expected in (("limits", derived["budget"]),
                          ("runtimeLimits", {key: derived[key] for key in ("background", "content")})):
        if key in policy and not matches_limits(policy[key], expected):
            fail("capture policy limits do not match settings")
    limits = derived["budget"]
    for key, expected in (("limitBytes", limits["totalBytes"]), ("reserveBytes", limits["reserveBytes"])):
        if key in budget and budget[key] != expected:
            fail("budget limits do not match settings")
    if budget.get("usedBytes", 0) > limits["totalBytes"]:
        fail("budget exceeds configured total")
    for key, value in budget.get("byCategory", {}).items():
        if key not in limits["categoryBytes"] or value > limits["categoryBytes"][key]:
            fail("category budget exceeds configured limit")
    return derived


def validate_flow_manifest(manifest, chunks, checked):
    session = manifest["session"]
    if (manifest.get("profile") != "business-flow-v1" or manifest.get("derivations") != "none"
            or not session["id"] or any(key in session or key in manifest for key in ("ownerToken", "captureKey"))
            or not isinstance(manifest.get("capturePolicy"), dict) or not isinstance(manifest.get("budget"), dict)):
        fail("invalid business flow profile, policy, budget, or session metadata")
    for key, maximum in (("eventCount", MAX_EVENTS), ("contentCount", MAX_FILES)):
        if not safe_integer(manifest.get(key)) or manifest[key] > maximum:
            fail("invalid business flow manifest count")
        if key in session and (not safe_integer(session[key]) or session[key] != manifest[key]):
            fail("session count does not match manifest")
    if "partial" in manifest and type(manifest["partial"]) is not bool:
        fail("invalid partial declaration")
    if "lastSeq" in session and not safe_integer(session["lastSeq"]):
        fail("invalid session sequence watermark")
    if "seal" in session:
        seal = session["seal"]
        if not isinstance(seal, dict):
            fail("invalid session seal")
        for key in ("lastSeq", "eventCount", "contentCount"):
            expected = manifest["eventCount"] if key == "lastSeq" else manifest[key]
            if not safe_integer(seal.get(key)) or seal[key] != expected:
                fail("session seal count or watermark mismatch")
        for key in ("sealedAt", "revision"):
            if key in seal and not safe_integer(seal[key]):
                fail("invalid session seal number")
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
    if "budget" in session and (not isinstance(session["budget"], dict)
            or json.dumps(session["budget"], sort_keys=True) != json.dumps(budget, sort_keys=True)):
        fail("session budget does not match manifest budget")
    if "byteAccounting" in manifest:
        ledger = manifest["byteAccounting"]
        if (not isinstance(ledger, dict) or any(not safe_integer(ledger.get(key)) for key in
                ("eventJsonlBytes", "uniqueContentBytes", "storedLogicalBytes"))):
            fail("invalid byte accounting")
    derived = validate_flow_policy(manifest)
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
        if size > derived["budget"]["categoryBytes"][category] or (category == "body" and size > derived["budget"]["singleBodyBytes"]):
            fail("content exceeds configured category or single body limit")
        if path not in checked or checked[path] != (size, sha256):
            fail("manifest content does not match verified ZIP entry")
        content_ids.add(content_id)
        paths.add(path)
    if {name for name in checked if name.startswith("contents/")} != paths:
        fail("unlisted or missing content entry")
    event_bytes = sum(checked[name][0] for name in chunks)
    if event_bytes + sum(content["size"] for content in contents) > derived["budget"]["totalBytes"]:
        fail("verified raw bytes exceed configured total")
    verify_byte_accounting(manifest, event_bytes)


def verify_byte_accounting(manifest, event_bytes):
    if "byteAccounting" not in manifest:
        return
    content_bytes = sum(content["size"] for content in manifest["contents"])
    actual = {"eventJsonlBytes": event_bytes, "uniqueContentBytes": content_bytes,
              "storedLogicalBytes": event_bytes + content_bytes}
    if any(manifest["byteAccounting"][key] != value for key, value in actual.items()):
        fail("byte accounting does not match verified raw bytes")
    budget = manifest["budget"]
    if "usedBytes" in budget and budget["usedBytes"] != actual["storedLogicalBytes"]:
        fail("budget usedBytes does not match byte accounting")


def content_references(payload, contents, limits=None):
    # Only store-assigned top-level captured references are schema markers.
    # Do not recurse into arbitrary business objects or infer references from an id alone.
    count = 0
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
        count += 1
        if limits is not None:
            budget = limits["budget"]
            if count > limits["content"]["maxContents"]:
                fail("event content reference count exceeds configured limit")
            if (value["size"] > budget["categoryBytes"][value["category"]]
                    or (value["category"] == "body" and value["size"] > budget["singleBodyBytes"])):
                fail("content reference exceeds configured category or single body limit")
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


def build_index(zf, manifest, chunks, checked, target, archive_identity=None):
    flow = manifest["version"] == 3
    contents = {entry["contentId"]: entry for entry in manifest["contents"]} if flow else {}
    limits = validate_flow_policy(manifest) if flow else None
    max_event_bytes = limits["budget"]["eventBytes"] if flow else MAX_EVENT_BYTES
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
        if archive_identity is not None:
            if (not isinstance(archive_identity, dict) or type(archive_identity.get("schemaVersion")) is not int
                    or archive_identity["schemaVersion"] != 1 or not safe_integer(archive_identity.get("size"))
                    or not isinstance(archive_identity.get("sha256"), str)
                    or not re.fullmatch(r"[0-9a-f]{64}", archive_identity["sha256"])):
                fail("invalid archive identity")
            db.execute("INSERT INTO metadata VALUES (?, ?)", ("archive_identity", json.dumps(archive_identity)))
        db.executemany("INSERT INTO files VALUES (?, ?, ?)", ((name, *info) for name, info in checked.items()))
        db.executemany("INSERT INTO contents VALUES (?,?,?,?,?,?)", (
            tuple(entry[key] for key in ("contentId", "path", "size", "sha256", "mime", "category"))
            for entry in contents.values()))
        count, last_seq, event_bytes = 0, 0, 0
        last_kind, last_id = None, None
        kinds = collections.Counter()
        for name in chunks:
            chunk_digest = hashlib.sha256()
            chunk_size = 0
            with zf.open(name) as stream:
                line_number = 0
                while True:
                    line = stream.readline(max_event_bytes + 1)
                    if not line:
                        break
                    chunk_digest.update(line)
                    chunk_size += len(line)
                    line_number += 1
                    if len(line) > max_event_bytes:
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
                                or not safe_integer(seq, 1) or seq != last_seq + 1
                                or any(key in event for key in ("ownerToken", "captureKey"))
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
                            for field, content_id, mime, category in content_references(payload, contents, limits)))
                    kinds[kind] += 1
                    last_kind, last_id = kind, event_id
            event_bytes += chunk_size
            if chunk_size != checked[name][0] or not hmac.compare_digest(chunk_digest.hexdigest(), checked[name][1]):
                fail(f"event chunk changed during indexing: {name}")
        if manifest["version"] in (2, 3) and (not safe_integer(manifest.get("eventCount")) or manifest["eventCount"] != count):
            fail("event count does not match manifest")
        if flow and "lastSeq" in manifest["session"] and manifest["session"]["lastSeq"] != last_seq:
            fail("session sequence watermark does not match events")
        if flow:
            verify_byte_accounting(manifest, event_bytes)
            session = manifest["session"]
            if "seal" in session:
                if (session["seal"]["lastSeq"] != last_seq or kinds["session.stop"] != 1
                        or last_kind != "session.stop"):
                    fail("session seal requires one final session.stop at its watermark")
                for key, expected in (("stopEventCount", 1), ("stopSeq", last_seq)):
                    if key in session and (not safe_integer(session[key]) or session[key] != expected):
                        fail("session stop watermark does not match events")
                if "stopEventId" in session and session["stopEventId"] != last_id:
                    fail("session stop identity does not match events")
        db.commit()
        success = True
        coverage = manifest["session"].get("coverage")
        recorded_coverage = {"declared": isinstance(coverage, dict)}
        if isinstance(coverage, dict):
            for key in ("version", "policyGaps", "recoveryGaps"):
                if safe_integer(coverage.get(key)):
                    recorded_coverage[key] = coverage[key]
            if type(coverage.get("physicalCdpStreamLimit")) is bool:
                recorded_coverage["physicalCdpStreamLimit"] = coverage["physicalCdpStreamLimit"]
        return {"verification": "passed", "version": manifest["version"], "events": count,
                "files": len(checked), "contentCount": len(contents), "event_types": dict(sorted(kinds.items())),
                "profile": "business-flow-v1" if flow else None, "partial": manifest.get("partial") if flow else None,
                "settings": dict(manifest["capturePolicy"].get("settings", LEGACY_FLOW_SETTINGS)) if flow else None,
                "recordedCoverage": recorded_coverage,
                "policyStopped": manifest["budget"].get("policyStopped") if flow else None,
                "byteAccountingVerification": "performed" if flow and "byteAccounting" in manifest else "not_performed",
                "coverageCaveat": "partial=false, ready status, and hashes do not prove full capture or authenticity"}
    finally:
        if db is not None:
            db.close()
        if not success:
            Path(target).unlink(missing_ok=True)


def archive_snapshot(stream):
    """Hash the already-open ZIP, preserving its position for ZipFile callers."""
    before = os.fstat(stream.fileno())
    position = stream.tell()
    digest, size = hashlib.sha256(), 0
    try:
        stream.seek(0)
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
            size += len(chunk)
    finally:
        stream.seek(position)
    after = os.fstat(stream.fileno())
    stamp = lambda stat: (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)
    if stamp(before) != stamp(after) or size != after.st_size:
        fail("archive changed while computing identity")
    return {"schemaVersion": 1, "sha256": digest.hexdigest(), "size": size}, stamp(after)


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
    if not args.output.parent.is_dir():
        fail("output parent directory does not exist")
    built = False
    try:
        with args.archive.open("rb") as stream:
            if os.fstat(stream.fileno()).st_size > args.max_archive_mb * 1000000:
                fail("ZIP exceeds the configured archive size limit")
            identity, stamp = archive_snapshot(stream)
            with zipfile.ZipFile(stream) as zf:
                manifest, chunks, checked = validate(zf, args.max_entry_mb * 1000000, args.max_expanded_mb * 1000000)
                summary = build_index(zf, manifest, chunks, checked, args.output, archive_identity=identity)
                built = True
            final_identity, final_stamp = archive_snapshot(stream)
            if final_identity != identity or final_stamp != stamp:
                fail("archive changed during indexing")
    except BaseException:
        if built:
            args.output.unlink(missing_ok=True)
        raise
    print(json.dumps(summary, ensure_ascii=True))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, UnicodeError, json.JSONDecodeError, sqlite3.Error, zipfile.BadZipFile, RuntimeError, OverflowError) as error:
        print(f"Indexing failed: {error}", file=sys.stderr)
        sys.exit(1)
