#!/usr/bin/env python3
"""Fake Claude CLI that streams back the prompt it received.

Same stream-json control protocol as `fake_claude.py`, but the assistant text is
the received prompt verbatim. This lets a test assert what actually crossed the
process boundary — used to prove the cross-provider context handoff preamble
reaches the provider rather than only being assembled in memory.
"""
import json
import sys


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def prompt_text(message):
    content = message.get("message", {}).get("content")
    if isinstance(content, str):
        return content
    # Content-block form: concatenate the text parts.
    if isinstance(content, list):
        return "".join(
            part.get("text", "") for part in content if isinstance(part, dict)
        )
    return ""


def main():
    session_id = "fake-claude-echo-1"
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
            emit({
                "type": "stream_event",
                "session_id": session_id,
                "event": {
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": {"type": "text_delta", "text": prompt_text(message)},
                },
            })
            emit({
                "type": "result",
                "subtype": "success",
                "session_id": session_id,
                "usage": {"input_tokens": 1, "output_tokens": 1},
            })
            return


if __name__ == "__main__":
    main()
