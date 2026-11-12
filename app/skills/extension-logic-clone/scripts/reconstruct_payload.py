#!/usr/bin/env python3
"""Reconstruct one validated recording reference from an existing SQLite index."""
import argparse
import base64
from contextlib import closing
import json
import re
import sqlite3
import sys
from pathlib import Path

FRAGMENT_LENGTH = 100000


def utf16_length(value):
    return len(value.encode("utf-16-le", "surrogatepass")) // 2


def pointer_value(value, pointer):
    if not pointer.startswith("/"):
        raise ValueError("reference must be an absolute JSON pointer")
    for encoded in pointer[1:].split("/"):
        if re.search(r"~(?![01])", encoded):
            raise ValueError("invalid JSON pointer escape")
        key = encoded.replace("~1", "/").replace("~0", "~")
        if isinstance(value, list):
            if not key.isdigit() or (len(key) > 1 and key.startswith("0")):
                raise ValueError("invalid array index")
            value = value[int(key)]
        elif isinstance(value, dict):
            value = value[key]
        else:
            raise ValueError("reference path is not an object or array")
    return value


def reconstruct(reference, events):
    if not isinstance(reference, dict):
        raise ValueError("invalid fragment reference")
    capture_id, field = reference.get("captureId"), reference.get("field")
    length, count = reference.get("length"), reference.get("parts")
    if (not isinstance(capture_id, str) or not isinstance(field, str)
            or type(length) is not int or length <= 0 or type(count) is not int
            or count != (length + FRAGMENT_LENGTH - 1) // FRAGMENT_LENGTH):
        raise ValueError("invalid fragment reference")
    parts = {}
    confirmed = False
    for event in events:
        if not isinstance(event, dict):
            raise ValueError("invalid event")
        item = event.get("payload") or {}
        if not isinstance(item, dict):
            raise ValueError("invalid event payload")
        if item.get("captureId") != capture_id or item.get("field") != field:
            continue
        if event.get("kind") == "capture.fragmentFailure":
            raise ValueError("fragment transfer reported failure")
        if event.get("kind") == "capture.fragment":
            index, data = item.get("index"), item.get("data")
            if (confirmed or type(index) is not int or index < 0 or index >= count or index in parts
                    or item.get("parts") != count or item.get("length") != length or not isinstance(data, str)
                    or utf16_length(data) != min(FRAGMENT_LENGTH, length - index * FRAGMENT_LENGTH)):
                raise ValueError("invalid or duplicate fragment")
            parts[index] = data
        elif event.get("kind") == "capture.fragmentEnd":
            if (confirmed or item.get("status") != "confirmed" or item.get("parts") != count
                    or item.get("length") != length or len(parts) != count):
                raise ValueError("fragment transfer is incomplete")
            confirmed = True
    if not confirmed or len(parts) != count:
        raise ValueError("fragment transfer is incomplete")
    # Joining UTF-16 bytes also repairs a surrogate pair split across two events.
    return b"".join(parts[index].encode("utf-16-le", "surrogatepass") for index in range(count)).decode("utf-16-le", "surrogatepass")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("index", type=Path)
    parser.add_argument("--event-id", required=True)
    parser.add_argument("--reference", required=True, help="JSON pointer to the fragment reference")
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--base64", action="store_true", help="decode the reconstructed Base64 to bytes")
    parser.add_argument("--expected-bytes", type=int)
    args = parser.parse_args()
    try:
        if not args.index.is_file():
            raise ValueError("index does not exist")
        with closing(sqlite3.connect(f"{args.index.resolve().as_uri()}?mode=ro", uri=True)) as db:
            result = db.execute("SELECT event_json FROM events WHERE id = ?", (args.event_id,)).fetchone()
            if not result:
                raise ValueError("event not found")
            reference = pointer_value(json.loads(result[0]), args.reference)
            rows = db.execute("SELECT event_json FROM events WHERE kind IN (?, ?, ?) ORDER BY seq",
                              ("capture.fragment", "capture.fragmentEnd", "capture.fragmentFailure"))
            text = reconstruct(reference, (json.loads(row[0]) for row in rows))
        data = base64.b64decode(text, validate=True) if args.base64 else text.encode("utf-8", "surrogatepass")
        if args.expected_bytes is not None and (args.expected_bytes < 0 or len(data) != args.expected_bytes):
            raise ValueError("reconstructed byte size does not match")
        with args.output.open("xb") as output:
            output.write(data)
        print(json.dumps({"status": "complete", "bytes": len(data)}, ensure_ascii=False))
    except (OSError, ValueError, KeyError, IndexError, sqlite3.Error) as error:
        print(f"reconstruction failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
