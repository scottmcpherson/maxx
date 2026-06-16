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
    ./client.py action <session_id> --action submit --input "run tests"
    ./client.py action <session_id> --action interrupt --signal SIGTERM
    ./client.py cancel <session_id>

    # Lifecycle control (the maxxctl half):
    ./client.py wait <session_id> --state tests:passed --timeout 300000
    ./client.py wait <session_id> --event pr.merged --timeout 30000
    ./client.py watch <session_id>
    ./client.py archive <session_id> --reason "run complete"
    ./client.py restart <session_id> --command "zig build test"
    ./client.py events <session_id> --since 0

    # Agent declarations (the maxx-agent-hook half):
    ./client.py declare-state <session_id> --state tests:passed --message ok
    ./client.py emit-event <session_id> --event pr.opened --payload-json '{"pr":123}'
    ./client.py set-metadata <session_id> --key reviewer --value alice

    # Structured event stream (MAX-7 — cross-resource, cursor-addressed):
    ./client.py set-group <session_id> --group release   # (omit --group to leave)
    ./client.py stream-watch --group release --since 0
    ./client.py stream-wait --group release --event deploy.done --timeout 1800000
    ./client.py stream-wait --group release --all exited --timeout 3600000
    ./client.py event-emit --session <session_id> --type declared.status --json '{"step":3}'

Timeouts here are milliseconds (the wire field is `timeout_ms`).
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


def call(method: str, params: dict, half_close: bool = True) -> dict:
    request = json.dumps({"token": read_token(), "method": method, "params": params})
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        sock.connect(os.path.join(control_dir(), "control.sock"))
        sock.sendall(request.encode("utf-8") + b"\n")
        # `wait` must keep the write side open so the server can notice if we
        # disconnect while it blocks; single-shot calls may half-close.
        if half_close:
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


def stream(method: str, params: dict) -> int:
    """Stream newline-delimited messages (used by `watch`) until the session
    ends or the server closes the connection."""
    request = json.dumps({"token": read_token(), "method": method, "params": params})
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        sock.connect(os.path.join(control_dir(), "control.sock"))
        # Do NOT half-close: the server streams until the session ends or we go
        # away by closing the socket.
        sock.sendall(request.encode("utf-8") + b"\n")
        buffer = b""
        while True:
            chunk = sock.recv(4096)
            if not chunk:
                break
            buffer += chunk
            while b"\n" in buffer:
                line, _, buffer = buffer.partition(b"\n")
                if line.strip():
                    print(json.dumps(json.loads(line.decode("utf-8"))))
    finally:
        sock.close()
    return 0


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
    create.add_argument("--group")
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
    action.add_argument("--signal")

    cancel = sub.add_parser("cancel")
    cancel.add_argument("id")

    wait = sub.add_parser("wait")
    wait.add_argument("id")
    wait.add_argument("--state")
    wait.add_argument("--event")
    wait.add_argument("--lifecycle")
    wait.add_argument("--timeout", type=int, help="timeout in milliseconds")
    wait.add_argument("--since", type=int)

    watch = sub.add_parser("watch")
    watch.add_argument("id")
    watch.add_argument("--since", type=int)
    watch.add_argument("--timeout", type=int, help="timeout in milliseconds")

    archive = sub.add_parser("archive")
    archive.add_argument("id")
    archive.add_argument("--reason")

    restart = sub.add_parser("restart")
    restart.add_argument("id")
    restart.add_argument("--command")

    events = sub.add_parser("events")
    events.add_argument("id")
    events.add_argument("--since", type=int)

    declare_state = sub.add_parser("declare-state")
    declare_state.add_argument("id")
    declare_state.add_argument("--state", required=True)
    declare_state.add_argument("--message")
    declare_state.add_argument("--source")

    emit_event = sub.add_parser("emit-event")
    emit_event.add_argument("id")
    emit_event.add_argument("--event", required=True)
    emit_event.add_argument("--payload-json", dest="payload_json")
    emit_event.add_argument("--source")

    set_metadata = sub.add_parser("set-metadata")
    set_metadata.add_argument("id")
    set_metadata.add_argument("--key", required=True)
    set_metadata.add_argument("--value", default="")

    # Structured event stream (MAX-7).
    set_group = sub.add_parser("set-group")
    set_group.add_argument("id")
    set_group.add_argument("--group", help="omit to leave the current group")

    stream_watch = sub.add_parser("stream-watch")
    stream_watch.add_argument("--session")
    stream_watch.add_argument("--tab")
    stream_watch.add_argument("--group")
    stream_watch.add_argument("--since", type=int, help="resume after this cursor")
    stream_watch.add_argument("--timeout", type=int, help="timeout in milliseconds")

    stream_wait = sub.add_parser("stream-wait")
    stream_wait.add_argument("--session")
    stream_wait.add_argument("--tab")
    stream_wait.add_argument("--group")
    stream_wait.add_argument("--event")
    stream_wait.add_argument("--all", help="group condition: idle | exited | declared:<state>")
    stream_wait.add_argument("--since", type=int)
    stream_wait.add_argument("--timeout", type=int, help="timeout in milliseconds")

    event_emit = sub.add_parser("event-emit")
    event_emit.add_argument("--session", required=True)
    event_emit.add_argument("--type", dest="type", required=True)
    event_emit.add_argument("--json", dest="json", help="structured JSON payload")
    event_emit.add_argument("--source")

    args = parser.parse_args()

    if args.verb == "create":
        params = {"metadata": kv(args.metadata), "env": args.env}
        for field in ("title", "cwd", "command", "status", "location", "group"):
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
        if args.signal is not None:
            params["signal"] = args.signal
        response = call("sessions.action", params)
    elif args.verb == "cancel":
        response = call("sessions.action", {"id": args.id, "action": "cancel"})
    elif args.verb == "wait":
        params = {"id": args.id}
        for field in ("state", "event", "lifecycle", "since"):
            value = getattr(args, field)
            if value is not None:
                params[field] = value
        if args.timeout is not None:
            params["timeout_ms"] = args.timeout
        # Keep the write side open so the server can detect us disconnecting.
        response = call("sessions.wait", params, half_close=False)
    elif args.verb == "watch":
        params = {"id": args.id}
        if args.since is not None:
            params["since"] = args.since
        if args.timeout is not None:
            params["timeout_ms"] = args.timeout
        return stream("sessions.watch", params)
    elif args.verb == "archive":
        params = {"id": args.id}
        if args.reason is not None:
            params["reason"] = args.reason
        response = call("sessions.archive", params)
    elif args.verb == "restart":
        params = {"id": args.id}
        if args.command is not None:
            params["command"] = args.command
        response = call("sessions.restart", params)
    elif args.verb == "events":
        params = {"id": args.id}
        if args.since is not None:
            params["since"] = args.since
        response = call("sessions.events", params)
    elif args.verb == "declare-state":
        params = {"id": args.id, "state": args.state}
        for field in ("message", "source"):
            value = getattr(args, field)
            if value is not None:
                params[field] = value
        response = call("sessions.declare-state", params)
    elif args.verb == "emit-event":
        params = {"id": args.id, "event": args.event}
        if args.payload_json is not None:
            params["payload_json"] = args.payload_json
        if args.source is not None:
            params["source"] = args.source
        response = call("sessions.emit-event", params)
    elif args.verb == "set-metadata":
        response = call(
            "sessions.set-metadata",
            {"id": args.id, "key": args.key, "value": args.value},
        )
    elif args.verb == "set-group":
        params = {"id": args.id}
        # An omitted/empty --group means "leave the current group".
        if args.group is not None:
            params["group"] = args.group
        response = call("sessions.set-group", params)
    elif args.verb == "stream-watch":
        params = {}
        if args.session is not None:
            params["id"] = args.session
        if args.tab is not None:
            params["tab"] = args.tab
        if args.group is not None:
            params["group"] = args.group
        if args.since is not None:
            params["since"] = args.since
        if args.timeout is not None:
            params["timeout_ms"] = args.timeout
        return stream("stream.watch", params)
    elif args.verb == "stream-wait":
        params = {}
        if args.session is not None:
            params["id"] = args.session
        if args.tab is not None:
            params["tab"] = args.tab
        if args.group is not None:
            params["group"] = args.group
        if args.event is not None:
            params["event"] = args.event
        if args.all is not None:
            params["all"] = args.all
        if args.since is not None:
            params["since"] = args.since
        if args.timeout is not None:
            params["timeout_ms"] = args.timeout
        # Keep the write side open so the server can detect us disconnecting.
        response = call("stream.wait", params, half_close=False)
    elif args.verb == "event-emit":
        params = {"id": args.session, "event": args.type}
        if args.json is not None:
            params["payload_json"] = args.json
        if args.source is not None:
            params["source"] = args.source
        response = call("sessions.emit-event", params)
    else:
        parser.error("unknown verb")

    print(json.dumps(response, indent=2))
    return 0 if response.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
