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
4. A breakpoint inside a called function pre-empts `next`, exactly as on
   debugpy; `hitBreakpointIds` is populated on `stopped`.
5. `pause` produces `stopped { reason: pause, allThreadsStopped: true }` for
   a runtime goroutine, not the main one; the surface the client holds is
   stamped from the same event, with the stopping thread recorded.
6. `setVariable` is acknowledged, reads back through `evaluate`, and the
   debuggee honours it. `variables` for an already-served reference keeps
   returning the values it served at that stop; a fresh read goes through
   `evaluate` or a re-observation.
7. `continued` events are sent after resume responses, as on debugpy; the
   grace-period synthesis in `act` was never exercised.

## ADR-0003: a retracted finding — the fixture's line comments were off by one

The first version of this repository claimed two Delve facts: that `next`
is not pre-empted by a nested breakpoint, and that a `setVariable` Delve
acknowledged and read back was never seen by the debuggee. Both were false.
`fixtures/program/main.go` carried line comments one higher than the real
lines, so the "breakpoint inside the call" sat on a closing brace (Delve
said so: `could not find statement`, `verified: false` — and the receipt
recorded it, unread), and the "stop before the call" was the `Println`
after it, where `result` was already computed. Re-checked on both the
development toolchain (go1.27 nodwarf5) and release Go 1.25.1 before
retracting: identical.

What survives: `verified` on `set_variable` is now earned by an
independent read in both adapters, which is right regardless; and it was
the program's own output, kept as evidence, that exposed the mistake. The
lesson is aimed at the author, not the adapter: **read the deviations on
every receipt, including the ones in your own test setup.** The semantics
repository's ADR-0011 carries the same retraction.
