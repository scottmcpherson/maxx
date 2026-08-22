#!/usr/bin/env python3
import os
import sys

print(
    f"FAKE_TUI_ENV:NO_COLOR={os.environ.get('NO_COLOR', '<unset>')};"
    f"TERM={os.environ.get('TERM', '<unset>')};"
    f"COLORTERM={os.environ.get('COLORTERM', '<unset>')}",
    flush=True,
)
print("\x1b[32mFAKE_TUI_READY\x1b[0m", flush=True)
for line in sys.stdin:
    value = line.rstrip("\r\n")
    print(f"FAKE_TUI_ECHO:{value}", flush=True)
    if value == "/exit":
        break
