"""Validate the actual synthetic v0.4.0 bundle through each skill installation."""
import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import zipfile


def run(command):
    result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", timeout=45,
                            env={**os.environ, "PYTHONUTF8": "1", "PYTHONDONTWRITEBYTECODE": "1"})
    if result.returncode:
        raise RuntimeError("Skill command failed: " + result.stderr)
    return json.loads(result.stdout)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skill", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    app = Path(__file__).resolve().parents[1]
    archive = app / "test-flow-acceptance-su6olB/round-1.zip"
    expected = "9556192481b808f65de0d4ef103ff297c7985e7b8cf6e40af663451ef03e2220"
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    if digest != expected:
        raise ValueError("Expected the approved synthetic final recording, not a user recording")
    task = Path(tempfile.mkdtemp(prefix="test-reading-skill-", dir=app))
    index = task / "recording.sqlite3"
    summary = run([sys.executable, str(args.skill / "scripts/index_archive.py"), str(archive), "--output", str(index)])
    if summary["version"] != 3 or summary["events"] != 96 or summary["contentCount"] != 52 or summary["byteAccountingVerification"] != "performed":
        raise ValueError("Actual v3 indexing count/ledger mismatch")
    selected = {}
    with closing(sqlite3.connect(index)) as db, zipfile.ZipFile(archive) as zf:
        rows = db.execute("SELECT id,kind,event_json FROM events ORDER BY seq").fetchall()
        for event_id, kind, raw in rows:
            event = json.loads(raw)
            for field, value in event["payload"].items():
                if not isinstance(value, dict) or value.get("status") != "captured" or not value.get("contentId"):
                    continue
                label = {("page.snapshot", "sourceHtml"): "DOM", ("page.stylesheet", "text"): "CSS",
                         ("screenshot", "image"): "PNG", ("network.request", "bodyText"): "request-body",
                         ("network.response", "body"): "response-body"}.get((kind, field))
                if label and label not in selected:
                    path, = db.execute("SELECT path FROM contents WHERE content_id=?", (value["contentId"],)).fetchone()
                    output = task / (label + ".bin")
                    result = run([sys.executable, str(args.skill / "scripts/read_content.py"), str(archive), str(index),
                                  "--event-id", event_id, "--field", field, "--output", str(output)])
                    actual = output.read_bytes()
                    if actual != zf.read(path) or result["size"] != len(actual) or result["sha256"] != hashlib.sha256(actual).hexdigest():
                        raise ValueError("Extracted raw content mismatch")
                    selected[label] = {"eventId": event_id, "field": field, "size": len(actual), "sha256": result["sha256"],
                                       "path": result["path"], "contentExecuted": result["contentExecuted"]}
        if set(selected) != {"DOM", "CSS", "PNG", "request-body", "response-body"}:
            raise ValueError("Missing expected actual content category")
    result = {"status": "passed", "skill": str(args.skill.resolve()), "archiveSha256": digest,
              "syntheticOnly": True, "indexSummary": summary, "verifiedContents": selected,
              "recordingOrIndexUploaded": False, "contentExecuted": False, "temporaryArtifacts": str(task)}
    args.report.parent.mkdir(parents=True, exist_ok=True)
    with args.report.open("x", encoding="utf-8") as handle:
        json.dump(result, handle, ensure_ascii=True, indent=2)
        handle.write("\n")
    print(json.dumps({"status": result["status"], "skill": result["skill"], "version": 3,
                      "events": summary["events"], "contents": summary["contentCount"], "rawKindsVerified": list(selected)}))


if __name__ == "__main__":
    main()
