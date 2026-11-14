#!/usr/bin/env python3
"""Verify a v3 archive/index pair and copy one referenced content as raw bytes."""
import argparse
from contextlib import closing
import hashlib
import hmac
import json
import os
from pathlib import Path
import sqlite3
import sys
import time
import zipfile
import index_archive as reader


def archive_identity(handle):
    handle.seek(0)
    digest = hashlib.sha256()
    size = 0
    while True:
        chunk = handle.read(1024 * 1024)
        if not chunk:
            break
        digest.update(chunk)
        size += len(chunk)
    handle.seek(0)
    return {"schemaVersion": 1, "sha256": digest.hexdigest(), "size": size}


def query_manifest(db):
    row = db.execute("SELECT value_json FROM metadata WHERE key=?", ("manifest",)).fetchone()
    if row is None:
        raise ValueError("Index manifest is missing; rebuild with index_archive.py")
    return reader.decode_json(row[0].encode("utf-8"))


def recorded_event(zf, db, event_id, chunks, checked, limits=None):
    row = db.execute("SELECT chunk,line,event_json FROM events WHERE id=?", (event_id,)).fetchone()
    if row is None:
        raise ValueError("Requested event is absent")
    chunk, number, cached = row
    if chunk not in chunks or chunk not in checked or not reader.safe_integer(number, 1):
        raise ValueError("Invalid indexed event location")
    selected = None
    max_event_bytes = limits["budget"]["eventBytes"] if limits is not None else reader.MAX_EVENT_BYTES
    digest = hashlib.sha256()
    size = 0
    with zf.open(chunk) as stream:
        line_number = 0
        while True:
            line = stream.readline(max_event_bytes + 1)
            if not line:
                break
            if len(line) > max_event_bytes:
                raise ValueError("Event line exceeds reader limit")
            line_number += 1
            digest.update(line)
            size += len(line)
            if line_number == number:
                selected = reader.decode_json(line)
    if (size, digest.hexdigest()) != checked[chunk]:
        raise ValueError("Source event chunk changed")
    if (not isinstance(selected, dict) or selected.get("id") != event_id
            or selected != reader.decode_json(cached.encode("utf-8"))):
        raise ValueError("Indexed event does not match source archive")
    return selected, chunk, number


def extract(args):
    if min(args.max_bytes, args.max_expanded_bytes, args.max_archive_bytes) <= 0:
        raise ValueError("Size limits must be positive")
    if not args.index.is_file() or not args.output.parent.is_dir():
        raise ValueError("Index or output parent directory is missing")
    if args.event_id and args.field is None:
        raise ValueError("--event-id requires a literal top-level --field")
    if args.content_id and args.field is not None:
        raise ValueError("--field belongs to --event-id, not --content-id")
    if args.output.exists() or args.output.is_symlink():
        raise FileExistsError("Output already exists; choose a new file")
    created = False
    success = False
    try:
        with closing(sqlite3.connect(args.index.resolve().as_uri() + "?mode=ro", uri=True)) as db, args.archive.open("rb") as handle:
            db.execute("PRAGMA query_only=ON")
            db.execute("PRAGMA trusted_schema=OFF")
            deadline = time.monotonic() + 5
            db.set_progress_handler(lambda: int(time.monotonic() > deadline), 10000)
            stat = os.fstat(handle.fileno())
            if stat.st_size > args.max_archive_bytes:
                raise ValueError("Archive exceeds reader byte limit")
            row = db.execute("SELECT value_json FROM metadata WHERE key=?", ("archive_identity",)).fetchone()
            if row is None:
                raise ValueError("Index lacks archive identity; rebuild with this skill's index_archive.py")
            pinned = reader.decode_json(row[0].encode("utf-8"))
            identity = archive_identity(handle)
            if (not isinstance(pinned, dict) or pinned.get("schemaVersion") != 1
                    or type(pinned.get("size")) is not int or pinned["size"] != identity["size"]
                    or pinned.get("sha256") != identity["sha256"]):
                raise ValueError("Index and source ZIP identities differ")
            with zipfile.ZipFile(handle) as zf:
                manifest, chunks, checked = reader.validate(zf, args.max_expanded_bytes, args.max_expanded_bytes)
                if manifest["version"] != 3:
                    raise ValueError("read_content.py requires v3; use the documented legacy route for v1/v2")
                if query_manifest(db) != manifest:
                    raise ValueError("Indexed manifest differs from source ZIP")
                limits = reader.validate_flow_policy(manifest)
                contents = {item["contentId"]: item for item in manifest["contents"]}
                event = chunk = line = field = None
                reference = None
                if args.event_id:
                    event, chunk, line = recorded_event(zf, db, args.event_id, chunks, checked, limits)
                    field = args.field
                    refs = {name: (cid, mime, category) for name, cid, mime, category
                            in reader.content_references(event["payload"], contents, limits)}
                    if field not in refs:
                        raise ValueError("Field is not a captured top-level content reference")
                    content_id, mime, category = refs[field]
                    indexed = db.execute("SELECT content_id,mime,category FROM content_refs WHERE event_id=? AND field=?",
                                         (args.event_id, field)).fetchone()
                    if indexed != refs[field]:
                        raise ValueError("Indexed reference differs from source event")
                    reference = {"mime": mime, "category": category}
                else:
                    content_id = args.content_id
                item = contents.get(content_id)
                if item is None:
                    raise ValueError("Content ID is not listed in the source manifest")
                stored = db.execute("SELECT path,size,sha256,mime,category FROM contents WHERE content_id=?", (content_id,)).fetchone()
                expected = tuple(item[key] for key in ("path", "size", "sha256", "mime", "category"))
                file_row = db.execute("SELECT size,sha256 FROM files WHERE path=?", (item["path"],)).fetchone()
                if stored != expected or file_row != checked[item["path"]]:
                    raise ValueError("Indexed content differs from source manifest")
                if item["size"] > args.max_bytes:
                    raise ValueError("Content exceeds output byte limit")
                digest = hashlib.sha256()
                size = 0
                fd = os.open(args.output, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                created = True
                with os.fdopen(fd, "wb") as output, zf.open(item["path"]) as source:
                    while True:
                        block = source.read(1024 * 1024)
                        if not block:
                            break
                        size += len(block)
                        if size > item["size"] or size > args.max_bytes:
                            raise ValueError("Content expanded beyond declared byte count")
                        digest.update(block)
                        output.write(block)
                if size != item["size"] or not hmac.compare_digest(digest.hexdigest(), item["sha256"]):
                    raise ValueError("Content checksum or size mismatch")
            after = os.fstat(handle.fileno())
            if ((stat.st_size, stat.st_mtime_ns) != (after.st_size, after.st_mtime_ns)
                    or archive_identity(handle) != identity):
                raise ValueError("Source ZIP changed during content extraction")
            success = True
            use = reference or item
            return {"verification": "passed", "version": 3, "archiveSha256": identity["sha256"],
                    "contentId": content_id, "path": item["path"], "size": size, "sha256": item["sha256"],
                    "mime": use["mime"], "category": use["category"], "eventId": args.event_id,
                    "field": field, "evidence": {"path": chunk, "line": line} if event else None,
                    "contentExecuted": False}
    finally:
        if created and not success:
            args.output.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("index", type=Path)
    selection = parser.add_mutually_exclusive_group(required=True)
    selection.add_argument("--event-id")
    selection.add_argument("--content-id")
    parser.add_argument("--field", help="literal payload key, not JSON Pointer; for example sourceHtml or formValue2")
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--max-bytes", type=int, default=1280 * 1024 * 1024)
    parser.add_argument("--max-expanded-bytes", type=int, default=1400 * 1024 * 1024)
    parser.add_argument("--max-archive-bytes", type=int, default=1400 * 1024 * 1024)
    result = extract(parser.parse_args())
    print(json.dumps(result, ensure_ascii=True))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, UnicodeError, sqlite3.Error, zipfile.BadZipFile,
            RuntimeError, OverflowError, TypeError, AttributeError) as error:
        print(f"Content reading failed: {error}", file=sys.stderr)
        sys.exit(1)
