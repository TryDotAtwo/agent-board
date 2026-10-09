#!/usr/bin/env python3
"""Verify a dedicated Telegram bot and privately provision its token."""

import getpass
import argparse
import subprocess
import sys

INSTALL = """
import json, os, pathlib, re, sys, urllib.error, urllib.request
token = sys.stdin.read().strip()
if not re.fullmatch(r"[0-9]{5,20}:[A-Za-z0-9_-]{20,100}", token):
    sys.exit("Invalid Telegram token format.")
def call(method, body):
    request = urllib.request.Request(
        "https://api.telegram.org/bot" + token + "/" + method,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            value = json.load(response)
    except urllib.error.HTTPError as error:
        sys.exit("Telegram verification failed: HTTP " + str(error.code))
    except (urllib.error.URLError, TimeoutError):
        sys.exit("Telegram verification failed: connection error.")
    if not value.get("ok"):
        sys.exit("Telegram rejected verification; no credential was saved.")
    return value["result"]
me = call("getMe", {})
if call("getWebhookInfo", {}).get("url"):
    sys.exit("This bot has a webhook. Refusing to replace another consumer.")
chat = call("getChat", {"chat_id": int(sys.argv[1])})
member = call("getChatMember", {"chat_id": chat["id"], "user_id": me["id"]})
if member["status"] in ("left", "kicked"):
    sys.exit("Add this bot to the intended group first.")
if not me.get("can_read_all_group_messages") and member["status"] != "administrator":
    sys.exit("Disable Group Privacy in BotFather, then re-add this new bot to the group.")
root = pathlib.Path("/data")
root.mkdir(mode=0o700, parents=True, exist_ok=True)
os.chmod(root, 0o700)
fd = os.open(root / "bot-token", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w") as stream:
    stream.write(token)
    stream.flush()
    os.fsync(stream.fileno())
print(json.dumps({
    "bot_username": me["username"],
    "bot_id": me["id"],
    "chat_id": chat["id"],
    "chat_title": chat.get("title"),
    "group_privacy_disabled": bool(me.get("can_read_all_group_messages")),
    "poller_started": False,
}))
"""

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--container", required=True)
parser.add_argument("--board-chat-id", required=True, type=int)
args = parser.parse_args()
if args.board_chat_id >= 0:
    parser.error("--board-chat-id must be negative")
if not sys.stdin.isatty():
    sys.exit("Run this helper in your own interactive terminal.")
print("Use a separate bot not polled by any other installation.")
print(f"Add it to board {args.board_chat_id}; disable Group Privacy beforehand.")
print("Enable Bot-to-Bot Communication Mode in BotFather if available.")
if input("Confirm this bot has no other consumer by typing SEPARATE-BOT: ") != "SEPARATE-BOT":
    sys.exit("Cancelled; no credentials were installed.")
token = getpass.getpass("Dedicated Telegram bot token (hidden): ").strip()
result = subprocess.run(
    ["docker", "exec", "-i", args.container, "python3", "-c", INSTALL, str(args.board_chat_id)],
    input=token,
    text=True,
    check=False,
)
sys.exit(result.returncode)
