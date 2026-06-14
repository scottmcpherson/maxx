#!/usr/bin/env python3
"""Reference client for the Maxx Control API.

A self-contained example of an external automation / webhook-runner that starts
*outside* a Maxx tab and manages a session end to end over the local Unix-domain
control socket. It speaks the newline-delimited JSON protocol directly — no Maxx
CLI required — so it doubles as documentation of the wire format.

Usage:
    ./client.py create --title "demo" --command "echo hi; sleep 30"
    ./client.py get <session_id>
    ./client.py list
    ./client.py update <session_id> --status waiting_for_review
    ./client.py action <session_id> --action focus
    ./client.py cancel <session_id>
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import sys


def control_dir() -> str:
    override = os.environ.get("MAXX_CONTROL_DIR")
    if override:
        return override
    return f"/tmp/maxx-control-{os.getuid()}"


def read_token() -> str:
    with open(os.path.join(control_dir(), "token"), "r", encoding="utf-8") as handle:
        return handle.read().strip()


def call(method: str, params: dict) -> dict:
    request = json.dumps({"token": read_token(), "method": method, "params": params})
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        sock.connect(os.path.join(control_dir(), "control.sock"))
        sock.sendall(request.encode("utf-8") + b"\n")
        sock.shutdown(socket.SHUT_WR)
        chunks = []
        while True:
            chunk = sock.recv(4096)
            if not chunk:
                break
            chunks.append(chunk)
    finally:
        sock.close()
    return json.loads(b"".join(chunks).decode("utf-8"))


def kv(values: list[str]) -> dict:
    out = {}
    for item in values or []:
        key, _, value = item.partition("=")
        out[key] = value
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description="Maxx Control API reference client")
    sub = parser.add_subparsers(dest="verb", required=True)

    create = sub.add_parser("create")
    create.add_argument("--title")
    create.add_argument("--cwd")
    create.add_argument("--command")
    create.add_argument("--status")
    create.add_argument("--location", choices=["tab", "window"])
    create.add_argument("--metadata", action="append", default=[])
    create.add_argument("--env", action="append", default=[])

    get = sub.add_parser("get")
    get.add_argument("id")

    sub.add_parser("list")

    update = sub.add_parser("update")
    update.add_argument("id")
    update.add_argument("--status")
    update.add_argument("--metadata", action="append", default=[])

    action = sub.add_parser("action")
    action.add_argument("id")
    action.add_argument("--action", required=True)
    action.add_argument("--input")

    cancel = sub.add_parser("cancel")
    cancel.add_argument("id")

    args = parser.parse_args()

    if args.verb == "create":
        params = {"metadata": kv(args.metadata), "env": args.env}
        for field in ("title", "cwd", "command", "status", "location"):
            value = getattr(args, field)
            if value is not None:
                params[field] = value
        response = call("sessions.create", params)
    elif args.verb == "get":
        response = call("sessions.get", {"id": args.id})
    elif args.verb == "list":
        response = call("sessions.list", {})
    elif args.verb == "update":
        params = {"id": args.id}
        if args.status is not None:
            params["status"] = args.status
        if args.metadata:
            params["metadata"] = kv(args.metadata)
        response = call("sessions.update", params)
    elif args.verb == "action":
        params = {"id": args.id, "action": args.action}
        if args.input is not None:
            params["input"] = args.input
        response = call("sessions.action", params)
    elif args.verb == "cancel":
        response = call("sessions.action", {"id": args.id, "action": "cancel"})
    else:
        parser.error("unknown verb")

    print(json.dumps(response, indent=2))
    return 0 if response.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
