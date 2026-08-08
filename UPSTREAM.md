# OpenCode upstream ledger

- Upstream repository: `https://github.com/anomalyco/opencode.git`
- License: MIT (retained in `LICENSE`)
- Initial W1 base: tag `v1.18.15`, commit `d7b115f623760e68a4749d16508a9eca350f246f`
- W1 default branch: `main`
- W1 development branch: `holy-grail`

W1 reuses terminal interaction and packaging work while keeping the W1 actor/runtime, auth,
permissions, tools, traces and product identity authoritative. Upstream merges must be explicit and
must rerun W1 protocol golden tests; OpenCode's agent engine or localhost control plane must not
silently become W1's execution path.
