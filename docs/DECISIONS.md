# Decisions

## ADR-0001: the diff against hostproto-dap-debugpy is the gate-1 measurement

Started as a copy of the debugpy adapter, file for file. What changed:
`dap.ts` gained a TCP `connect()` beside `spawn()`; `createContext` starts
`dlv dap`, connects, and passes a Go launch config; the adapter's stdio is
normalized into `output` events; the profile identity and two
availabilities. `observe`, `act`, `await`, `recovery`, target invalidation,
preconditions, receipts and the capability ledger are untouched. Gate 1 did
not fire on a second debugger. Two improvements found here were folded back
into debugpy (launch-failure race, `allThreadsStopped` stamping, read-back
on `set_variable`), which is the shape a shared `hostproto-dap-core` would
take if a third adapter appears.

## ADR-0002: wire facts about DAP as Delve speaks it (1.27.1, Go 1.27 X:nodwarf5)

1. `dlv dap --listen 127.0.0.1:0` announces `DAP server listening at:
   host:port` on stdout; everything after that line on stdout/stderr is the
   debuggee's, because Delve does not emit `output` events for it.
2. `launch { mode: debug }` runs `go build` in the adapter's cwd, so cwd must
   be the module directory; a build error fails the launch with an `error`
   body and never sends `initialized`. The host races `initialized` against
   the launch response.
3. `setBreakpoints` reports `verified: false` with a message for a line that
   cannot bind (debugpy relocates and verifies instead).
4. `next` steps over a call even when a breakpoint sits inside it; Delve
   does not let a nested breakpoint pre-empt the step.
5. `pause` produces `stopped { reason: pause, allThreadsStopped: true }` for
   a runtime goroutine, not the main one; the surface the client holds is
   stamped from the same event, with the stopping thread recorded.
6. **`setVariable` is acknowledged and reads back through `evaluate`, but
   `variables` for the same reference still shows the old value and the
   debuggee runs with the old value.** The receipt's `verified` is earned by
   the read-back, which agrees with the adapter — and is still wrong about
   the program. The discrepancy is only visible in the program's own output
   afterwards. This is recorded as a toolchain-level fact (experimental
   `nodwarf5` Go), not a HostProto defect: HostProto promised an observed
   effect, delivered one, and the later observation is what catches the
   lie. Re-check on a release Go toolchain.
7. `continued` events are sent after resume responses, as on debugpy; the
   grace-period synthesis in `act` was never exercised.
