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

The server uses the calling thread's full-access permission and working directory. Each thread can start, list, read and cancel its own jobs. Finishing jobs wake the originating thread through the app-server. Keep the service running while jobs execute. For a supervised deployment, run the service in its own systemd unit with the default control-group kill mode.
