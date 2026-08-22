#!/usr/bin/env python3
"""Fake Grok ACP agent speaking JSON-RPC lines over stdio.

Exercises the ACP engine against the behavior that corrupted real Grok turns:
`session/load` replays the entire prior conversation as `session/update`
notifications before the load response arrives. The engine must drop that
replay instead of streaming it into the live turn.
"""
import json
import sys


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def update(session_id, payload):
    emit({
        "jsonrpc": "2.0",
        "method": "session/update",
        "params": {"sessionId": session_id, "update": payload},
    })


def text_chunk(kind, text):
    return {"sessionUpdate": kind, "content": {"type": "text", "text": text}}


def main():
    session_id = "fake-acp-session-1"
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        message = json.loads(line)
        method = message.get("method")
        message_id = message.get("id")
        if method == "initialize":
            emit({
                "jsonrpc": "2.0",
                "id": message_id,
                "result": {
                    "protocolVersion": 1,
                    "agentCapabilities": {"loadSession": True},
                },
            })
        elif method == "session/new":
            emit({
                "jsonrpc": "2.0",
                "id": message_id,
                "result": {"sessionId": session_id},
            })
        elif method == "session/load":
            loaded = message["params"]["sessionId"]
            update(loaded, text_chunk("user_message_chunk", "Hi"))
            update(loaded, text_chunk("agent_thought_chunk", "replayed thought"))
            update(loaded, text_chunk("agent_message_chunk", "Hi - how can I help you today?"))
            emit({"jsonrpc": "2.0", "id": message_id, "result": {}})
        elif method == "session/prompt":
            prompted = message["params"]["sessionId"]
            update(prompted, text_chunk("agent_message_chunk", "Checking."))
            update(prompted, {
                "sessionUpdate": "tool_call",
                "toolCallId": "tool-1",
                "title": "read_file",
                "status": "in_progress",
            })
            update(prompted, {
                "sessionUpdate": "tool_call_update",
                "toolCallId": "tool-1",
                "title": "Read file",
                "status": "completed",
            })
            update(prompted, text_chunk("agent_message_chunk", "Done."))
            emit({
                "jsonrpc": "2.0",
                "id": message_id,
                "result": {"stopReason": "end_turn"},
            })
            return


if __name__ == "__main__":
    main()
