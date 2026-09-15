import os
import urllib.request
import json
import time
import re
from pathlib import Path
from datetime import datetime

def alive(pid):
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 1:
        raise ValueError('Invalid process ID')
    os.kill(pid, 0)  # Linux container only, never execute this check on Windows.


def check_relay_health(root='/data'):
    root = Path(root)
    portable = (root / 'node.json').exists()
    config_file = root / ('node.json' if portable else 'experts.json')
    if not config_file.exists():
        return True  # Fresh Desktop before board provisioning.
    if not (root / 'board.env').is_file():
        return False
    try:
        config = json.loads(config_file.read_text())
        agents = config['agents'] if portable else [c for c in config['experts'] if c.get('board')]
        if not agents:
            return False
        files = []
        expected_children = {'board'}
        for agent in agents:
            name = agent['id']
            if not isinstance(name, str) or not re.fullmatch(r'[a-z][a-z0-9_-]{0,63}', name):
                return False
            files.append(root / 'experts' / name / 'heartbeat')
            if agent.get('backend') == ('chatgpt-desktop' if portable else 'desktop-chat'):
                files.append(root / 'pro-gateway' / name / 'heartbeat.json' if portable else root / 'pro-gateway/heartbeat.json')
                expected_children.add('pro-' + name if portable else 'pro')
        health = json.loads((root / 'relay-health.json').read_text())
        now = time.time()
        if health['status'] != 'running' or now - datetime.fromisoformat(health['updatedAt'].replace('Z', '+00:00')).timestamp() > 90:
            return False
        if {child['name'] for child in health['children']} != expected_children:
            return False
        alive(health['pid'])
        for child in health['children']:
            alive(child['pid'])
        return all(now - file.stat().st_mtime <= 90 for file in files)
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return False


def main():
    if os.name != 'posix' or not os.path.exists('/tmp/.X11-unix/X99'):
        return 1
    try:
        alive(int(Path('/tmp/chatgpt-desktop.pid').read_text()))
        with urllib.request.urlopen('http://127.0.0.1:6080/vnc.html', timeout=3) as response:
            if response.status != 200:
                return 1
        return 0 if check_relay_health() else 1
    except (OSError, ValueError):
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
