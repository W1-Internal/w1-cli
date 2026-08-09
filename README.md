# W1 CLI

W1 in your terminal: the same one-actor product runtime used by W1 desktop and the VS Code
extension, without an Electron renderer or editor extension host in the way.

This repository is the terminal product and an operational rescue surface. `w1 login` opens the
hosted W1 sign-in/sign-up page in an external browser and stores the resulting session in
`~/.w1/auth.json`, the same protected location W1 desktop uses. The CLI owns this flow itself;
desktop does not need to be installed or running, and users never paste credentials into a terminal.

## Current commands

```bash
w1 [project]                 start an interactive W1 session
w1 --prompt "inspect this"   run one turn and exit
w1 --image screenshot.png   attach an image to the first turn
w1 --session THREAD_ID      resume a durable W1 thread
w1 --yolo                   allow all tools without permission prompts
w1 login                    sign in or create an account in the external browser
w1 auth status              show the shared W1 session status
w1 logout                   revoke and remove the shared W1 session
w1 doctor [project]         inspect filesystem, Git, session, runtime, backend and TTY health
w1 engine status            inspect the one per-user W1 Engine without starting it
w1 engine stop --when-idle  stop the Engine safely after active tasks finish
```

## npm distribution status

The npm release path is intentionally gated while it is being prepared. The public package name is
`w1-cli`, while the installed command remains `w1`. Each release uses a small JavaScript launcher
plus exact-version, OS/architecture-specific native packages; the native package keeps `w1` and its
adjacent `w1-runtime` together. It does not download executable code during installation and does not
depend on lifecycle scripts.

Each native package contains adjacent Engine, Engine-client and actor-worker bundles plus skills,
plugins, PDF fonts and native canvas dependencies. `w1-runtime-manifest.json` pins the CLI and harness
commits, package/protocol versions, entrypoints, sizes and SHA-256 hashes. Both the npm launcher and
the compiled CLI fail closed when the manifest is missing, incomplete or tampered.

Native image dependencies are selected per artifact, never inherited from the build host: each
package contains exactly one canvas binary matching its OS, architecture and Linux libc. Depot also
builds temporary Linux glibc and musl packages so it can execute the compiled install and validate
both libc contracts. Those probes are removed before the final Mac-first dogfood artifact is staged.

The shared Engine converges by protocol and release version: an older idle daemon is replaced by the
new package, an active daemon refuses automatic replacement, and an older CLI can keep using a newer
compatible daemon. A different build claiming the same package version is treated as an integrity
failure. This keeps Desktop, VS Code and terminal clients on one daemon rather than creating parallel
per-surface runtimes.

Before replacing an installed npm release, use `w1 engine stop --when-idle` and wait for
`w1 engine status` to report that it is not running. npm replaces the native package directory in
place, so updating files underneath an active daemon is intentionally unsupported.

The bundled runtime is currently a readable JavaScript artifact. Public npm staging therefore fails
unless the release operator explicitly sets `W1_NPM_ALLOW_PUBLIC_RUNTIME=1`; the release workflow
also requires its `allow_public_runtime` confirmation. This is a disclosure decision, not a routine
build switch. Dogfood releases use npm's `next` tag until the package is ready to become `latest`.

Interactive commands:

```text
/image PATH   attach an image to the next turn
/clear        start a new thread
/help         show commands
/exit         quit
```

By default W1 keeps its normal approval boundary. `--full-access` is explicit and affects only the
current invocation. `--yolo` is the memorable alias for the same full-access runtime and also
auto-accepts any defensive approval request that reaches the terminal surface.

Every turn displays an activity state immediately. `Thinking…` means W1 is waiting on the model;
`Working…` means a tool is running. The state clears before narration, answers, approval prompts,
and user questions. Reasoning text remains hidden unless `--verbose` is explicitly selected.

## Architecture

- OpenCode supplies the MIT-licensed terminal chassis and cross-platform build foundation.
- W1's bundled `run-stream.mjs` remains the only actor/tool/runtime implementation.
- The CLI connects to the one per-user W1 Engine; the Engine launches the version-pinned worker with
  an explicit executable and argv contract through the compiled CLI's internal `__runtime` dispatch.
- The actor runtime needs no localhost HTTP server; sign-in uses only a short-lived loopback callback.
- Tokens are never copied into argv, logs, traces or ordinary CLI configuration. They live only in
  the permission-protected shared W1 session store.

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
W1_CLI_VERSION=0.1.3 bun run build --single --skip-install --skip-embed-web-ui
```

Set `W1_RUNTIME_BUNDLE_DIR` when the harness bundle is not in the default sibling location.

## Upstream

This is a fork of [OpenCode](https://github.com/anomalyco/opencode), pinned initially to stable
`v1.18.15`. The original MIT license and copyright notice remain in [LICENSE](LICENSE). See
[UPSTREAM.md](UPSTREAM.md) for the fork policy.
