#!/usr/bin/env python3
"""Fake Claude CLI speaking the stream-json control protocol.

Port of the spirit of `script/fixtures/fake_provider.py`: exercises the real
process transport, control-channel handshake, streaming normalization and the
terminal guarantee without a provider account or network access.
"""
import json
import sys


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main():
    session_id = "fake-claude-session-1"
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        message = json.loads(line)
        kind = message.get("type")
        if kind == "control_request":
            emit({
                "type": "control_response",
                "response": {
                    "subtype": "success",
                    "request_id": message.get("request_id"),
                    "response": {},
                },
            })
            continue
        if kind == "user":
            emit({"type": "system", "subtype": "init", "session_id": session_id})
            for chunk in ("Hello", " from", " the fake provider"):
                emit({
                    "type": "stream_event",
                    "session_id": session_id,
                    "event": {
                        "type": "content_block_delta",
                        "index": 0,
                        "delta": {"type": "text_delta", "text": chunk},
                    },
                })
            emit({
                "type": "result",
                "subtype": "success",
                "session_id": session_id,
                "usage": {"input_tokens": 7, "output_tokens": 5},
            })
            return


if __name__ == "__main__":
    main()
