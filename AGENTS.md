# Agent guidance

- Never copy a schema in. Change `hostproto-semantics.lock.json` (commit + digests) and run `npm run schemas`.
- Never hand-write a TypeScript interface for a HostProto type; validate against the bundle with `assertValid`.
- Host semantics (revision, cursor, target invalidation, preconditions, receipts, deviations, recovery) live in `src/host.ts`. `src/dap.ts` only frames, connects and correlates messages. `src/server.ts` is projection only.
- Every error leaving a tool is `error/v1` with an honest `host_invoked`.
- `fixtures/program/main.go` line numbers are load-bearing for the tests; keep the comments that say so.
- Tests are wire-level (`tests/adapter.test.ts`): real client, real stdio server, real dlv dap, real Go. Keep them that way.
- Record every wire fact learned about DAP, DAP, Delve or the SDK in `docs/DECISIONS.md` with the versions.
