"""Validate resolved Copilot Compose settings without starting a node."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class ComposeConfigurationTests(unittest.TestCase):
    def resolve(self, suffix, restart="false"):
        env = {
            key: value for key, value in os.environ.items()
            if not key.startswith(("COPILOT_", "COMPOSE_"))
        }
        env.update(
            COPILOT_BOARD_PROJECT_NAME=f"copilot-test-{suffix}",
            COPILOT_BOARD_CONTAINER_NAME=f"copilot-test-{suffix}",
            COPILOT_BOARD_IMAGE=f"copilot-test-{suffix}:local",
            COPILOT_REACTIVATE_ON_RESTART=restart,
        )
        with tempfile.TemporaryDirectory(prefix="copilot-compose-") as directory:
            env_file = Path(directory) / "empty.env"
            env_file.write_text("")
            result = subprocess.run(
                [
                    "docker", "compose", "--env-file", str(env_file),
                    "-f", str(Path(__file__).with_name("compose.yaml")),
                    "config", "--format", "json",
                ],
                env=env, capture_output=True, text=True, timeout=30, check=True,
            )
        return json.loads(result.stdout)

    def test_independent_nodes_are_isolated_and_reactivation_is_opt_in(self):
        nodes = [self.resolve("a"), self.resolve("b", "true")]
        for node in nodes:
            service = node["services"]["researcher"]
            self.assertTrue(service["read_only"])
            self.assertEqual(service["cap_drop"], ["ALL"])
            self.assertIn("no-new-privileges:true", service["security_opt"])
            self.assertFalse(service.get("privileged", False))
            self.assertFalse(service.get("ports"))
            self.assertEqual(service["restart"], "unless-stopped")
            self.assertEqual(
                {v["target"] for v in service["volumes"]}, {"/home/node", "/workspace"}
            )
            self.assertTrue(all(v["type"] == "volume" for v in service["volumes"]))
        self.assertEqual(
            nodes[0]["services"]["researcher"]["environment"]["COPILOT_REACTIVATE_ON_RESTART"],
            "false",
        )
        self.assertEqual(
            nodes[1]["services"]["researcher"]["environment"]["COPILOT_REACTIVATE_ON_RESTART"],
            "true",
        )
        for key in ("container_name", "image"):
            self.assertNotEqual(
                nodes[0]["services"]["researcher"][key], nodes[1]["services"]["researcher"][key]
            )
        for key in ("copilot-home", "research-workspace"):
            self.assertNotEqual(nodes[0]["volumes"][key]["name"], nodes[1]["volumes"][key]["name"])
        self.assertNotEqual(nodes[0]["networks"]["research"]["name"], nodes[1]["networks"]["research"]["name"])


if __name__ == "__main__":
    unittest.main()
