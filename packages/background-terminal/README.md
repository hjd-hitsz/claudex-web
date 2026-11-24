# Codex background terminal

A Linux stdio MCP extension for a local Codex app-server. Requires Node.js 24.5 or newer. Start the service under the same user as Codex, using a private state directory and the app-server's loopback WebSocket URL.

```bash
state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/codex-background-terminal"
codex-background-terminal serve "$state_dir" ws://127.0.0.1:8765
```

In a second shell, register the MCP entry point for the same app-server.

```bash
state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/codex-background-terminal"
codex mcp add claudex_background -- codex-background-terminal mcp "$state_dir"
```

The server uses the calling thread's full-access permission and working directory. Each thread can start, list, read and cancel its own jobs. `background_start` requires `check_after_ms`, a one-shot review delay of at least one minute estimated from the actual work. If the process is still running at that point, the service wakes the originating thread and the process continues. `background_schedule_check` updates the next review. An exit wakes the thread independently, and the optional `timeout_ms` ends a process at its hard time limit. Keep the service running while jobs execute. For a supervised deployment, run the service in its own systemd unit with the default control-group kill mode.
