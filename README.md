# hostproto-dap-delve

The second HostProto DAP adapter: a **Delve** (`dlv dap`, Go) session
exposed through **MCP 2026-07-28**, pinned to the same eleven
[hostproto-semantics](https://github.com/bayleafwalker/hostproto-semantics)
bundles as [hostproto-dap-debugpy](https://github.com/bayleafwalker/hostproto-dap-debugpy)
and [hostproto-mcp-playwright](https://github.com/bayleafwalker/hostproto-mcp-playwright).
It exists to test kill gate 1 late: does a second, unrelated debugger need a
different envelope? It did not. The diff against the debugpy adapter was the
measurement (`docs/DECISIONS.md` ADR-0001), and that diff is now
`src/binding.ts`: since hostproto-semantics ADR-0012 both adapters are
bindings on [hostproto-dap-core](https://github.com/bayleafwalker/hostproto-dap-core).

## What differs from debugpy, and where it went

| Delve fact | Where it landed |
| --- | --- |
| `dlv dap` listens on TCP; the client connects | the core's `DapClient.connect()`; `start()` in the binding |
| `launch` **builds** the program (`mode: debug`), in the adapter's cwd | `context_create` takes `cwd` = module dir; a build error is `host_failed`, not a hang |
| debuggee stdio rides `dlv`'s own stdio, not DAP `output` events | normalized into the same `output` events, `channel: adapter-stdio`; `observe.output` is `provider: host, semantics: normalized` in the profile |
| goroutines are threads; `pause` stops a runtime goroutine with `allThreadsStopped` | every surface is stamped with the event's reason and the thread that caused it |
| `setBreakpoints` says `verified: false` with a message for an unbindable line | the spike's "verified only the bound one" case is reachable here (debugpy relocates instead) |
| no reverse requests | `act.host_request.resolve` and `observe.host_requests` are `unsupported` in the profile |
| `setVariable` — acknowledged, read back, and honoured by the debuggee | `verified` is earned by an independent read in **both** adapters (added here; see ADR-0003 for the retracted claim that motivated it) |

Everything else — handles, revision per thread, host-assigned cursor,
revision-scoped targets refused before send, preconditions, receipts with
`unknown`, omitted-not-lost, recovery with the DAP log as evidence, the
earned capability profile — is the debugpy adapter's code, unchanged.

## Run

```sh
npm ci
go install github.com/go-delve/delve/cmd/dlv@v1.27.1   # or HOSTPROTO_DLV=/path/to/dlv
npm test          # real client ↔ real server over stdio ↔ real dlv dap ↔ real Go program
npm start
```
