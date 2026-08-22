#!/usr/bin/env python3
"""Fake OMP ACP server validating model/thinking config before prompting."""

import json
import sys


def send(value):
    print(json.dumps(value), flush=True)


def config_options(model, thinking):
    return [
        {
            "id": "model",
            "category": "model",
            "type": "select",
            "currentValue": model,
            "options": [
                {"value": "default/model", "name": "Default Model"},
                {"value": "sparky/qwen", "name": "Sparky Qwen"},
            ],
        },
        {
            "id": "thinking",
            "category": "thought_level",
            "type": "select",
            "currentValue": thinking,
            "options": [
                {"value": "off", "name": "Off"},
                {"value": "low", "name": "Low"},
            ],
        },
    ]


if sys.argv[1:] != ["acp"]:
    raise SystemExit(f"expected only the acp subcommand, got {sys.argv[1:]}")

model = "default/model"
thinking = "low"
for line in sys.stdin:
    message = json.loads(line)
    method = message.get("method")
    request_id = message.get("id")
    params = message.get("params", {})

    if method == "initialize":
        send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "protocolVersion": 1,
                    "agentCapabilities": {
                        "loadSession": True,
                        "mcpCapabilities": {"http": True},
                    },
                },
            }
        )
    elif method == "session/new":
        send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "sessionId": "fake-omp-session-1",
                    "configOptions": config_options(model, thinking),
                },
            }
        )
    elif method == "session/set_config_option":
        config_id = params.get("configId")
        value = params.get("value")
        if config_id == "model" and value == "sparky/qwen":
            model = value
        elif config_id == "thinking" and value == "off" and model == "sparky/qwen":
            thinking = value
        else:
            send(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "error": {"code": -32602, "message": "unexpected OMP config update"},
                }
            )
            continue
        send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {"configOptions": config_options(model, thinking)},
            }
        )
    elif method == "session/prompt":
        if model != "sparky/qwen" or thinking != "off":
            send(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "error": {"code": -32602, "message": "prompt arrived before OMP config"},
                }
            )
            continue
        send(
            {
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": "fake-omp-session-1",
                    "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "content": {"type": "text", "text": "OMP configured"},
                    },
                },
            }
        )
        send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {"stopReason": "end_turn"},
            }
        )
    elif method == "session/cancel":
        continue
    else:
        send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {"code": -32601, "message": f"unsupported method {method}"},
            }
        )
