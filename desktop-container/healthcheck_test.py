import importlib
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from datetime import datetime, timezone


@unittest.skipUnless(os.name == 'posix', 'Linux container process checks')
class RelayHealthTests(unittest.TestCase):
    def setUp(self):
        try:
            self.module = importlib.import_module('healthcheck')
        except SystemExit:
            self.module = None
        self.assertTrue(callable(getattr(self.module, 'check_relay_health', None)), 'config-aware relay health check required')
        self.temp = tempfile.TemporaryDirectory(prefix='board-health-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def put(self, name, value=''):
        target = self.root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(value) if isinstance(value, dict) else value)
        return target

    def configure(self, pro=False):
        agents = [{'id': 'alice', 'backend': 'codex-desktop'}]
        children = ['board']
        if pro:
            agents.append({'id': 'bob', 'backend': 'chatgpt-desktop'})
            children.append('pro-bob')
            self.put('pro-gateway/bob/heartbeat.json', {})
        self.put('node.json', {'agents': agents})
        self.put('board.env')
        for agent in agents:
            self.put(f'experts/{agent["id"]}/heartbeat')
        self.put('relay-health.json', {'status': 'running', 'pid': os.getpid(),
            'updatedAt': datetime.now(timezone.utc).isoformat(),
            'children': [{'name': name, 'pid': os.getpid()} for name in children]})

    def test_standalone_native_needs_no_pro_heartbeat(self):
        self.configure()
        self.assertTrue(self.module.check_relay_health(self.root))

    def test_each_configured_pro_requires_its_own_heartbeat(self):
        self.configure(pro=True)
        self.assertTrue(self.module.check_relay_health(self.root))
        (self.root / 'pro-gateway/bob/heartbeat.json').unlink()
        self.assertFalse(self.module.check_relay_health(self.root))

    def test_stale_participant_is_not_healthy(self):
        self.configure()
        os.utime(self.root / 'experts/alice/heartbeat', (time.time()-1000, time.time()-1000))
        self.assertFalse(self.module.check_relay_health(self.root))

    def test_missing_configuration_credentials_is_not_a_ready_board(self):
        self.configure()
        (self.root / 'board.env').unlink()
        self.assertFalse(self.module.check_relay_health(self.root))

    def test_unconfigured_fresh_desktop_has_no_relays_to_check(self):
        self.assertTrue(self.module.check_relay_health(self.root))


if __name__ == '__main__':
    unittest.main()
