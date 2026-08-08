# W1 CLI

W1 in your terminal: the same one-actor product runtime used by W1 desktop and the VS Code
extension, without an Electron renderer or editor extension host in the way.

This repository is the terminal product and an operational rescue surface. It uses the user's
existing W1 GUI/browser session from `~/.w1/auth.json`; it does not introduce a second login or ask
users to paste credentials into a terminal.

## Current commands

```bash
w1 [project]                 start an interactive W1 session
w1 --prompt "inspect this"   run one turn and exit
w1 --image screenshot.png   attach an image to the first turn
w1 --session THREAD_ID      resume a durable W1 thread
w1 doctor [project]         inspect filesystem, Git, session, runtime, backend and TTY health
```

Interactive commands:

```text
/image PATH   attach an image to the next turn
/clear        start a new thread
/help         show commands
/exit         quit
```

By default W1 keeps its normal approval boundary. `--full-access` is explicit and affects only the
current invocation.

## Architecture

- OpenCode supplies the MIT-licensed terminal chassis and cross-platform build foundation.
- W1's bundled `run-stream.mjs` remains the only actor/tool/runtime implementation.
- The CLI launches the versioned W1 NDJSON/`@@TAG@@` stdio protocol through its own Bun runtime.
- No localhost HTTP server is required for the W1 terminal path.
- Tokens are never copied into argv, logs, traces or CLI-owned configuration.

The CLI bypasses Electron IPC, renderer state, VS Code webviews, extension-host lifecycle and their
reconnect overlays. It cannot bypass W1 backend/provider outages, DNS/TLS failures or an expired
account session. `w1 doctor` separates those failure classes.

## Development

The W1 harness and CLI repos are expected as siblings:

```text
w1/
  harness/
  cli/
```

Build the current harness bundle first, then run the CLI:

```bash
cd ../harness/vscode-extension
npm run build

cd ../../cli/packages/opencode
bun install
bun src/index.ts doctor ../..
bun src/index.ts ../..
```

Build one native artifact:

```bash
cd packages/opencode
OPENCODE_VERSION=0.1.0 bun run build --single --skip-install --skip-embed-web-ui
```

Set `W1_RUNTIME_BUNDLE_DIR` when the harness bundle is not in the default sibling location.

## Upstream

This is a fork of [OpenCode](https://github.com/anomalyco/opencode), pinned initially to stable
`v1.18.15`. The original MIT license and copyright notice remain in [LICENSE](LICENSE). See
[UPSTREAM.md](UPSTREAM.md) for the fork policy.
