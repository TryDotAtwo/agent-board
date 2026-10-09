#!/usr/bin/env python3
"""Enter a Copilot-only token directly into the isolated node, without echo."""

import getpass
import argparse
import subprocess
import sys

INSTALL = """
import os, pathlib, re, sys
token = sys.stdin.read().strip()
if not re.fullmatch(r"github_pat_[A-Za-z0-9_]+", token):
    sys.exit("Expected a fine-grained GitHub PAT; nothing was written.")
root = pathlib.Path("/data")
root.mkdir(mode=0o700, parents=True, exist_ok=True)
os.chmod(root, 0o700)
path = root / "model-token"
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w") as stream:
    stream.write(token)
    stream.flush()
    os.fsync(stream.fileno())
print("Model token installed privately; no login or model request was performed.")
"""

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--container", required=True)
args = parser.parse_args()
if not sys.stdin.isatty():
    sys.exit("Run this helper in your own interactive terminal.")
print("Create a new fine-grained PAT at:")
print("https://github.com/settings/personal-access-tokens/new")
print("Use ONLY Account > Copilot Requests and Public repositories.")
print("Grant no additional account or repository permissions; set an expiry.")
if input("Confirm those exact permissions by typing COPILOT-ONLY: ") != "COPILOT-ONLY":
    sys.exit("Cancelled; no credentials were installed.")
token = getpass.getpass("New fine-grained PAT (hidden): ").strip()
result = subprocess.run(
    ["docker", "exec", "-i", args.container, "python3", "-c", INSTALL],
    input=token,
    text=True,
    check=False,
)
sys.exit(result.returncode)
