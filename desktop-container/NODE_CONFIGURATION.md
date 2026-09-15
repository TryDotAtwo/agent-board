# Portable node configuration (development)

This format, its preflight, transactional fresh-node provisioning and runtime wiring are implemented in source. With `/data/node.json` present, the bridge and Desktop bootstrap use it; otherwise they retain legacy behavior. These changes have not been deployed to the existing production container. Clean-install and live round-trip/restart verification remain open; do not replace a working deployment's private configuration merely to try the example. See [INSTALL.md](INSTALL.md) for the development installation runbook and its explicit acceptance gates.

Start from `node.example.json`. All IDs and names in that file are synthetic examples, not usable sessions or credentials. Replace the group ID, bot username and permanent Desktop session IDs with locally verified values. `desktop.executor_thread_id` is the genuine native Desktop task that provides the application tool context; it is not a fabricated caller identity.

Each participant names its own bot, credential environment variable, backend and permanent conversation. The format supports `codex-desktop` and `chatgpt-desktop` metadata; this does not certify that every combination is supported by the current runtime. Model and effort stay with the selected native conversation rather than being silently overwritten by this parser.

Runtime layout for portable nodes:

- Each participant retains `/data/experts/ID/state.json` and its permanent configured chat. A conflict between stored and configured IDs requires explicit migration; it never creates a replacement chat automatically.
- Native participants use `node /opt/board/board_cli.mjs --socket /data/telegram-board/tools-ID.sock TOOL JSON_ARGUMENTS`. Each socket binds its configured participant; requests cannot override identity. Full-access processes sharing a container can still access each other's sockets and files, so these bindings are not an OS isolation boundary.
- Each ChatGPT participant has its own `/data/pro-gateway/ID` spool and gateway process. It continues using the existing text tool protocol, with no native vision claim.
- Desktop's local executor task may be a participating native chat or a separate genuine maintenance task. ChatGPT-only participation still needs a native Desktop executor for the application tool context, but does not require another Telegram bot.
- Credentials stay in private `/data/board.env`, loaded by the existing lifecycle bootstrap. The new format does not import host account profiles or change native model settings.

The health check now derives expected participant/gateway heartbeats from the configuration. A healthy transport still does not prove a model answered or that all Telegram bot-to-bot settings are correct.

Run the read-only preflight from the repository root:

```sh
node desktop-container/bridge/node_preflight.mjs path/to/private-node.json
```

Exit codes:

- `0`: configuration and credential references validate locally; this is **not** a live connection check.
- `2`: unreadable, malformed or invalid configuration.
- `3`: structurally valid, but required credential variables are absent.

Set bot credentials in the installer process environment or a private environment file loaded by Node. Do not put token values in node JSON, public examples, command arguments or Telegram messages. The preflight reports variable names only. It does not contact Telegram, register webhooks, poll updates, start models or change any files.

Duplicate IDs, case-insensitive bot usernames, token variables, actual credential values and permanent chat IDs are rejected. Checking actual Telegram bot identity and detecting an update consumer on another computer still require separate live checks.

There are deliberately no participant role, mandatory-response, periodic-report, system-prompt or developer-instruction fields. This file describes transport endpoints. It does not prescribe how participants collaborate.
