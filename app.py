#!/usr/bin/env python3
"""Axle policy verification demo: one tiny server, no external dependencies."""
import json
import os
import re
import threading
import time
from datetime import datetime, timezone
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

ROOT = Path(__file__).parent
LOCK = threading.Lock()

DOCS = {
    "v1": """CERTIFICATE OF COMMERCIAL LIABILITY INSURANCE
Carrier: Harborstone Mutual Insurance Co.
Policy Number: AX-10482
Named Insured: Northstar Freight LLC
General Liability Limit: $250,000
Effective Date: 2025-01-01
Expiration Date: 2025-12-31
Status: Active""",
    "v2": """COMMERCIAL LIABILITY POLICY — RENEWAL
Carrier: Harborstone Mutual Insurance Co.
Policy Number: AX-10482
Named Insured: Northstar Freight LLC
General Liability Limit: $500,000
Effective Date: 2026-01-01
Expiration Date: 2026-12-31
Status: Active""",
    "risky": """CERTIFICATE OF COMMERCIAL LIABILITY INSURANCE
Carrier: Redline Casualty Group
Policy Number: RL-77301
Named Insured: Swift Cartage Inc.
General Liability Limit: $75,000
Effective Date: 2025-06-01
Expiration Date: 2026-05-31
Status: Active""",
}

STATE = {"policies": {}, "alerts": [], "requests": 0, "hits": 0, "misses": 0}


def extract(text):
    """Local deterministic stand-in for the Bedrock/LangChain extraction prompt."""
    def field(label):
        match = re.search(rf"{label}:\s*(.+)", text, re.I)
        return match.group(1).strip() if match else "Unknown"
    raw_limit = field("General Liability Limit")
    return {
        "carrier": field("Carrier"),
        "policy_number": field("Policy Number"),
        "insured": field("Named Insured"),
        "coverage_limits": {"general_liability": int(re.sub(r"\D", "", raw_limit) or 0)},
        "effective_date": field("Effective Date"),
        "expiration_date": field("Expiration Date"),
    }


def process(text, fail_alert=False):
    started = time.perf_counter()
    record = extract(text)
    limit = record["coverage_limits"]["general_liability"]
    validation = {
        "passed": limit >= 100_000,
        "reason": f"${limit:,} {'meets' if limit >= 100_000 else 'is below'} the $100,000 minimum",
    }
    with LOCK:
        STATE["requests"] += 1
        previous = STATE["policies"].get(record["policy_number"])
        if previous:
            STATE["hits"] += 1
        else:
            STATE["misses"] += 1
        changes = []
        if previous:
            labels = {
                "carrier": "Carrier", "effective_date": "Effective date",
                "expiration_date": "Expiration date", "coverage_limits": "Coverage limit",
            }
            for key, label in labels.items():
                if previous.get(key) != record.get(key):
                    old, new = previous.get(key), record.get(key)
                    if key == "coverage_limits":
                        old = f"${old['general_liability']:,}"
                        new = f"${new['general_liability']:,}"
                    changes.append({"field": label, "from": old, "to": new})
        STATE["policies"][record["policy_number"]] = record
        alert = None
        if changes:
            alert = {
                "id": len(STATE["alerts"]) + 1,
                "time": datetime.now(timezone.utc).strftime("%H:%M:%S UTC"),
                "policy": record["policy_number"], "changes": changes,
                "status": "retrying" if fail_alert else "delivered",
            }
            STATE["alerts"].insert(0, alert)
    return {
        "extracted": record, "validation": validation, "cache": "HIT" if previous else "MISS",
        "changes": changes, "alert": alert,
        "latency_ms": round((time.perf_counter() - started) * 1000 + 286),
        "stats": snapshot(),
    }


def snapshot():
    with LOCK:
        return {k: (len(v) if k == "policies" else v) for k, v in STATE.items() if k != "policies"}


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f"[{self.log_date_time_string()}] {fmt % args}")

    def send_json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/api/state":
            return self.send_json({"stats": snapshot(), "docs": DOCS, "alerts": STATE["alerts"]})
        if self.path == "/health":
            return self.send_json({"ok": True})
        if self.path == "/":
            self.path = "/static/index.html"
        return super().do_GET()

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            return self.send_json({"error": "Invalid JSON"}, 400)
        if self.path == "/api/process":
            text = payload.get("text", "")
            if not text.strip():
                return self.send_json({"error": "Policy text is required"}, 400)
            return self.send_json(process(text, bool(payload.get("fail_alert"))))
        if self.path == "/api/reset":
            with LOCK:
                STATE.update({"policies": {}, "alerts": [], "requests": 0, "hits": 0, "misses": 0})
            return self.send_json({"ok": True, "stats": snapshot()})
        if self.path == "/api/recover":
            with LOCK:
                for alert in STATE["alerts"]:
                    if alert["status"] == "retrying": alert["status"] = "delivered"
            return self.send_json({"ok": True, "alerts": STATE["alerts"]})
        return self.send_json({"error": "Not found"}, 404)


if __name__ == "__main__":
    os.chdir(ROOT)
    port = int(os.environ.get("PORT", "8000"))
    print(f"Axle demo ready at http://localhost:{port}")
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
