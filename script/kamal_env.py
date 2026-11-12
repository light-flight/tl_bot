#!/usr/bin/env python3
import pathlib
import sys

key = sys.argv[1]
for line in pathlib.Path(".env").read_text().splitlines():
    if not line.startswith(f"{key}="):
        continue
    value = line.split("=", 1)[1]
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        value = value[1:-1]
    sys.stdout.write(value)
    break
