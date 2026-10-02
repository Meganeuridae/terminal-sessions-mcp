# next/ — the 2.0 tree

The design is [`docs/redesign/DESIGN.md`](../docs/redesign/DESIGN.md); the user-facing
README is the repository's root [`README.md`](../README.md). ESM, strict TypeScript, Node ≥
20, compiled to `next/dist/`.

```
next/src/core/       Session (state machine, Runs on both targets, cancel contracts, seat,
                     cursors), Journal + stores, marks parser, Screen, transcript projection,
                     services and probes, watches, segmenter, search, env, keys
next/src/backends/   node-pty (shells, pipe-spawned processes); scripted (deterministic tests)
next/src/shell/      bash, zsh and fish integration (keyed OSC 133 / 633 marks)
next/src/api/        the application API, tool table, compat pack, presence, registry,
                     principals, validation, usage
next/src/transport/  the one WebSocket endpoint (MCP, MCPL lane, native family, GUI, /health)
next/gui/            the browser GUI (a native client)
next/spec/           the guarantee suite: scripted, real shells, end to end, MCPL hosts
next/acceptance/     the milestone sentence against real hosts (agent-framework, the bridge)
```

```bash
npm run test:next             # build + every suite (real bash, zsh, sh, fish when installed)
npm run acceptance:af         # against ../archipelago-design/agent-framework (built)
npm run acceptance:bridge     # against ../mcpl-cc-bridge (needs bun)
```
