#!/usr/bin/env python3
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone

kind = os.environ["FAKE_NATIVE_KIND"]
path = os.environ["FAKE_NATIVE_PATH"]
session_id = os.environ["FAKE_SESSION_ID"]

print("\x1b[36mFAKE_NATIVE_READY\x1b[0m", flush=True)
for line in sys.stdin:
    prompt = line.rstrip("\r\n")
    if not prompt:
        continue
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    with open(path, "a", encoding="utf-8") as stream:
        if kind == "pi":
            stream.write(json.dumps({
                "type": "message",
                "id": "terminal-user",
                "parentId": "baseline-assistant",
                "timestamp": now,
                "message": {"role": "user", "content": [{"type": "text", "text": prompt}]},
            }) + "\n")
            stream.write(json.dumps({
                "type": "message",
                "id": "terminal-assistant",
                "parentId": "terminal-user",
                "timestamp": now,
                "message": {"role": "assistant", "content": [{"type": "text", "text": "native answer"}]},
            }) + "\n")
        elif kind == "grok":
            stream.write(json.dumps({
                "timestamp": 1786203719,
                "method": "session/update",
                "params": {
                    "sessionId": session_id,
                    "update": {"sessionUpdate": "user_message_chunk", "content": {"type": "text", "text": prompt}},
                    "_meta": {"eventId": "terminal-user", "agentTimestampMs": 1786203719000},
                },
            }) + "\n")
            stream.write(json.dumps({
                "timestamp": 1786203720,
                "method": "session/update",
                "params": {
                    "sessionId": session_id,
                    "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "native answer"}},
                    "_meta": {"eventId": "terminal-assistant", "promptId": "terminal-prompt"},
                },
            }) + "\n")
            stream.write(json.dumps({
                "timestamp": 1786203721,
                "method": "_x.ai/session/update",
                "params": {
                    "sessionId": session_id,
                    "update": {"sessionUpdate": "turn_completed"},
                    "_meta": {"eventId": "terminal-complete"},
                },
            }) + "\n")
        elif kind == "cursor":
            stream.write(json.dumps({
                "role": "user",
                "timestamp": now,
                "message": {"content": [{"type": "text", "text": prompt}]},
            }) + "\n")
            stream.write(json.dumps({
                "role": "assistant",
                "timestamp": now,
                "message": {"content": [{"type": "text", "text": "native answer"}]},
            }) + "\n")
        stream.flush()
        os.fsync(stream.fileno())
    if kind == "hermes":
        with sqlite3.connect(path) as database:
            next_id = database.execute("SELECT COALESCE(MAX(id), 0) + 1 FROM messages").fetchone()[0]
            database.execute(
                "INSERT INTO messages (id, session_id, role, content, timestamp, active) VALUES (?, ?, 'user', ?, strftime('%s','now'), 1)",
                (next_id, session_id, prompt),
            )
            database.execute(
                "INSERT INTO messages (id, session_id, role, content, timestamp, active) VALUES (?, ?, 'assistant', 'native answer', strftime('%s','now'), 1)",
                (next_id + 1, session_id),
            )
            database.commit()
    print(f"FAKE_NATIVE_RECORDED:{prompt}", flush=True)
