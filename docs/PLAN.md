# Plan and progress

The single place a fresh session reads to know where the project stands. Update it in the same commit that completes a task.

## Status

- **Milestone 1 (design):** done. Docs in `docs/design/`, signed off by Luiz on 2026-10-27. Engine edge cases from papo's maintainer: `docs/design/edge-cases.md`.
- **Milestone 2 (vertical slice, both shells):** in progress.

## Milestone 2 tasks

Each task is one fresh codex session, reviewed before the next starts.

1. [ ] Flake, Rust workspace (papo pinned by git rev), SolidJS app skeleton, `nix flake check`, GitHub Actions.
2. [ ] wasm engine in a SharedWorker (dedicated Worker fallback) talking to the UI through `EngineClient`; local Ergo for dev.
3. [ ] Engine connects through papo; network and buffer state; protocol types generated with ts-rs.
4. [ ] Desktop shell: sidebar buffer list, single pane, Lounge and Lounge Night themes following the system.
5. [ ] Message list (virtualised, one-line layout).
6. [ ] Composer with optimistic send (`Sent`-based confirmation).
7. [ ] Mobile shell: chats list and pushed chat screen.
8. [ ] End-to-end check against weblounge over `wss://`.

Next after milestone 2 (brought forward by Luiz): split view and the core keyboard shortcuts.

## External dependencies

- **papo:** pinned at `7d5e4bf`. Breaking changes approved for 0.1 are in flight (guarded `client.direct(nick)`, `Sent::Confirmed|Unconfirmed`, `name_rules()` unavailable before 005, per-conversation lag gaps). The engine wraps DM sending and name storage in its own small types so adopting them stays local. papo 0.1.0 is tagged after this milestone's slice works on it.
