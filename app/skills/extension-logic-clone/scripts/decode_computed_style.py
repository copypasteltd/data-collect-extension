#!/usr/bin/env python3
"""Decode one recorded computed-style batch from a validated SQLite index."""
import argparse
import base64
import binascii
from contextlib import closing
import gzip
import io
import json
from pathlib import Path
import sqlite3
import sys
import zlib

MAX_BYTES = 8000000


def decode(payload):
    encoding = payload.get("entriesEncoding")
    if not encoding:
        entries = payload.get("entries")
        if not isinstance(entries, list):
            raise ValueError("computed-style entries are missing")
        return entries
    length, count, data = payload.get("entriesBytes"), payload.get("entryCount"), payload.get("entriesData")
    if (encoding != "gzip-base64-json-v1" or type(length) is not int or not 0 <= length <= MAX_BYTES
            or type(count) is not int or count < 0 or not isinstance(data, str) or len(data) > 16000000):
        raise ValueError("invalid computed-style metadata")
    compressed = base64.b64decode(data, validate=True)
    if len(compressed) < 18 or int.from_bytes(compressed[-4:], "little") != length:
        raise ValueError("invalid computed-style gzip length")
    with gzip.GzipFile(fileobj=io.BytesIO(compressed)) as stream:
        raw = stream.read(MAX_BYTES + 1)
    if len(raw) != length:
        raise ValueError("computed-style decoded length does not match")
    entries = json.loads(raw.decode("utf-8"))
    if not isinstance(entries, list) or len(entries) != count:
        raise ValueError("computed-style entry count does not match")
    return entries


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("index", type=Path)
    parser.add_argument("--event-id", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    try:
        if not args.index.is_file():
            raise ValueError("index does not exist")
        with closing(sqlite3.connect(f"{args.index.resolve().as_uri()}?mode=ro", uri=True)) as db:
            row = db.execute("SELECT event_json FROM events WHERE id = ?", (args.event_id,)).fetchone()
        if not row:
            raise ValueError("event not found")
        event = json.loads(row[0])
        if event.get("kind") != "page.computedStyle" or not isinstance(event.get("payload"), dict):
            raise ValueError("event is not a computed-style batch")
        entries = decode(event["payload"])
        data = json.dumps(entries, ensure_ascii=True, separators=(",", ":")).encode("utf-8")
        with args.output.open("xb") as output:
            output.write(data)
        print(json.dumps({"status": "complete", "entries": len(entries), "bytes": len(data)}))
    except (OSError, ValueError, TypeError, EOFError, binascii.Error, sqlite3.Error, zlib.error) as error:
        print(f"computed-style decoding failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
