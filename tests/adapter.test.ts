// Wire-level: a real MCP 2026-07-28 client over stdio to the real server
// process, driving a real `dlv dap` and a real Go debuggee (built by Delve).
// Nothing is mocked between the client and the process.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { validator } from '../src/schemas.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
let client: Client; let transport: StdioClientTransport;
const updated: string[] = [];
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const result = await client.callTool({ name, arguments: args });
  return { ...result, sc: result.structuredContent as Record<string, any> };
};
const intent = (surface: string, kind: string, extra: Record<string, unknown> = {}) => ({ schema_version: 'hostproto.intent/v1', action_id: `a-${Math.random().toString(36).slice(2, 8)}`, surface, kind, ...extra });
const sha = (b: Buffer | string) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const SRC = 'main.go';
const PROGRAM = ROOT + 'fixtures/program'; const SPIN = ROOT + 'fixtures/spin';

beforeAll(async () => {
  transport = new StdioClientTransport({ command: 'npx', args: ['tsx', 'src/stdio.ts'], cwd: ROOT, stderr: 'pipe' });
  client = new Client({ name: 'hostproto-conformance', version: '0.0.1' });
  client.setVersionNegotiation({ mode: { pin: '2026-07-28' } });
  client.setNotificationHandler('notifications/resources/updated', n => { updated.push(n.params.uri); });
  await client.connect(transport);
});
afterAll(async () => { await client?.close().catch(() => {}); });

describe('wire behaviour on 2026-07-28', () => {
  it('negotiates the pinned revision and publishes the bundles as tool schemas', async () => {
    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    expect(client.getServerVersion()?.name).toBe('hostproto-dap-delve');
    const act = (await client.listTools()).tools.find(t => t.name === 'hostproto_surface_act')!;
    expect(act.inputSchema.properties).toHaveProperty('kind');
    expect(JSON.stringify(act)).not.toMatch(/hostproto\.invalid/);
  });
});

describe('HostProto semantics on a real Go debugger', () => {
  let surface: string; let context: string; let frames: any[]; let variables: any[]; let revisionAtVariables: number;

  it('builds, launches, stops on entry, mints handles', async () => {
    const { sc, isError } = await call('hostproto_context_create', { program: '.', cwd: PROGRAM, client: { id: 'conformance' } });
    expect(isError, JSON.stringify(sc)).toBe(false);
    expect(validator('handles')(sc)).toBe(true);
    expect(sc.adapter_profile).toBe('dap/v1');
    surface = sc.surface.id; context = sc.context.id;
    const state = (await call('hostproto_surface_observe', { surface, projections: ['state'] })).sc;
    expect(state.data.state.stopped).toBe(true);
    expect(state.data.state.reason).toBe('entry');
  }, 120000);

  it('sets breakpoints and records what the adapter did with them', async () => {
    const { sc } = await call('hostproto_surface_act', intent(surface, 'set_breakpoints', { params: { source: SRC, lines: [21, 999] }, declared_effects: ['breakpoints_replaced_for_source'] }));
    expect(validator('receipt')(sc)).toBe(true);
    expect(sc.outcome).toBe('completed');
    expect(sc.revision_after).toBe(sc.revision_before);
    const bps = sc.effects[0].breakpoints;
    expect(bps.find((b: any) => b.requested_line === 21)).toMatchObject({ line: 21, verified: true });
    const far = bps.find((b: any) => b.requested_line === 999);
    // Delve reports an unbindable line honestly: verified=false with a message. The spike's case is reachable here.
    expect(far.verified).toBe(false); expect(typeof far.message).toBe('string');
    expect(sc.verified).toBe(true);
    expect(sc.deviations.find((d: any) => /did not bind/.test(d.reason)).object_ids).toHaveLength(1);
    const again = await call('hostproto_surface_act', intent(surface, 'set_breakpoints', { params: { source: SRC, lines: [21] } }));
    expect(again.sc.deviations).toEqual([]);
  });

  it('continue: the revision advances, the stop carries the breakpoint, and the subscribed state resource notified', async () => {
    const listening = await client.listen({ resourceSubscriptions: [`hostproto://surface/${surface}/state`] });
    const { sc } = await call('hostproto_surface_act', intent(surface, 'continue', { preconditions: { schema_version: 'hostproto.precondition/v1', surface, assertions: [{ field: 'stopped', equals: true }] }, declared_effects: ['revision_advance', 'stopped:breakpoint'] }));
    expect(sc.outcome).toBe('completed'); expect(sc.verified).toBe(true);
    expect(sc.revision_after).toBeGreaterThan(sc.revision_before);
    expect(sc.effects.map((e: any) => e.kind)).toEqual(['continued', 'stopped']);
    expect(sc.effects[1]).toMatchObject({ reason: 'breakpoint', line: 21, source: SRC, hit_breakpoint_ids: [1] });
    await new Promise(r => setTimeout(r, 100));
    expect(updated).toContain(`hostproto://surface/${surface}/state`);
    await listening.close();
  });

  it('observes frames, scopes and variables as revision-scoped targets; output rode the cursor', async () => {
    const f = (await call('hostproto_surface_observe', { surface, projections: ['state', 'frames', 'output'] })).sc;
    expect(validator('observation')(f)).toBe(true);
    frames = f.data.frames; expect(frames[0].role).toBe('frame'); expect(frames[0].name).toMatch(/^main\.main  main\.go:21/);
    expect(f.data.output.map((e: any) => e.payload.output).join('')).toContain('ledger: 17 capabilities');
    const s = (await call('hostproto_surface_observe', { surface, projections: ['scopes'], target: frames[0] })).sc;
    const locals = s.data.scopes.find((t: any) => t.name === 'Locals'); expect(locals.actions).toContain('expand');
    const v = (await call('hostproto_surface_observe', { surface, projections: ['variables'], target: locals })).sc;
    variables = v.data.variables; revisionAtVariables = v.revision;
    expect(variables.find((t: any) => t.name.startsWith('count = 17'))).toBeDefined();
    expect(variables.find((t: any) => t.name.startsWith('ledger')).actions).toContain('expand');
  });

  it('evaluates in a frame and sets a variable', async () => {
    const ev = await call('hostproto_surface_act', intent(surface, 'evaluate', { target: frames[0], params: { expression: 'len(ledger)', context: 'watch' } }));
    expect(ev.sc.effects[0]).toMatchObject({ kind: 'evaluated', result: '2' });
    const count = variables.find((t: any) => t.name.startsWith('count'));
    const set = await call('hostproto_surface_act', intent(surface, 'set_variable', { target: count, params: { value: '5' } }));
    expect(set.sc.effects[0]).toMatchObject({ kind: 'variable.set', name: 'count', value: '5', read_back: '5' });
    expect(set.sc.verified).toBe(true);
    expect(set.sc.revision_after).toBe(set.sc.revision_before);
  });

  it('step_over is pre-empted by a breakpoint inside the call: effects differ from declared, outcome stays completed', async () => {
    await call('hostproto_surface_act', intent(surface, 'set_breakpoints', { params: { source: SRC, lines: [12] } }));
    const { sc } = await call('hostproto_surface_act', intent(surface, 'step_over', { declared_effects: ['revision_advance', 'stopped:step'] }));
    expect(sc.outcome).toBe('completed'); expect(sc.executed).toBe(true);
    expect(sc.effects[1]).toMatchObject({ kind: 'stopped', reason: 'breakpoint', line: 12, source: SRC });
    expect(sc.deviations.some((d: any) => d.kind === 'divergence' && /pre-empted/.test(d.reason))).toBe(true);
  });

  it('refuses a variablesReference from before the resume, before anything is sent', async () => {
    const stale = variables.find((t: any) => t.name.startsWith('ledger'));
    const obs = await call('hostproto_surface_observe', { surface, projections: ['variables'], target: stale });
    expect(obs.isError).toBe(true);
    expect(obs.sc.code).toBe('target_invalidated'); expect(obs.sc.host_invoked).toBe(false);
    expect(obs.sc.data.target_revision).toBe(revisionAtVariables);
    const act = await call('hostproto_surface_act', intent(surface, 'evaluate', { target: frames[0], params: { expression: '1' } }));
    expect(act.sc.code).toBe('target_invalidated'); expect(act.sc.host_invoked).toBe(false);
  });

  it('rejects a failed precondition before touching the host', async () => {
    const { sc, isError } = await call('hostproto_surface_act', intent(surface, 'step_in', { preconditions: { schema_version: 'hostproto.precondition/v1', surface, assertions: [{ field: 'stopped', equals: false }] } }));
    expect(isError).toBe(true); expect(sc.code).toBe('precondition_failed'); expect(sc.host_invoked).toBe(false);
  });

  it('lossy when bounded, with a raw copy', async () => {
    const bounded = (await call('hostproto_surface_observe', { surface, projections: ['state', 'output', 'frames'], max_bytes: 512 })).sc;
    expect(bounded.bounded.lossy).toBe(true); expect(bounded.bounded.raw_ref).toMatch(/^sha256:/);
  });

  it('runs to exit: the surface terminates, handles expire, recovery names host_terminated with the message log as evidence', async () => {
    await call('hostproto_surface_act', intent(surface, 'set_breakpoints', { params: { source: SRC, lines: [] } }));
    const { sc } = await call('hostproto_surface_act', intent(surface, 'continue', { params: { deadline_ms: 15000 } }));
    expect(sc.outcome).toBe('completed');
    expect(sc.effects.map((e: any) => e.kind)).toEqual(['continued', 'terminated']);
    await call('hostproto_surface_await', { surface, conditions: [{ kind: 'lifecycle', equals: 'terminated' }], deadline_ms: 5000 });
    // `exited` is the last thing the adapter says about the process; output and the thread record precede it.
    await call('hostproto_surface_await', { surface, conditions: [{ kind: 'event_kind', equals: 'process.exited' }], deadline_ms: 5000 });
    const state = (await call('hostproto_surface_observe', { surface, projections: ['state', 'output'] })).sc;
    expect(state.data.state.lifecycle).toBe('terminated');
    expect(state.data.output.map((e: any) => e.payload.output).join('')).toContain('result: 10'); // count was set to 5 → helper(5) = 10
    const expired = await call('hostproto_surface_act', intent(surface, 'continue'));
    expect(expired.sc.code).toBe('handle_expired'); expect(expired.sc.host_invoked).toBe(false);
    const rec = await call('hostproto_context_recovery', { context });
    expect(validator('recovery')(rec.sc)).toBe(true);
    expect(rec.sc).toMatchObject({ outcome: 'unrecoverable', cause: 'host_terminated' });
    const evidence = rec.sc.evidence[0]; expect(evidence.media_type).toBe('application/x-ndjson');
    const link = rec.content.find(c => c.type === 'resource_link') as { uri: string };
    const text = ((await client.readResource({ uri: link.uri })).contents[0] as { text: string }).text;
    expect(sha(text)).toBe(evidence.ref);
    const messages = text.split('\n').filter(Boolean).map(l => JSON.parse(l));
    expect(messages.some((m: any) => m.direction === 'out' && m.message.command === 'launch')).toBe(true);
    await call('hostproto_context_close', { context });
  });
});

describe('unknown outcomes and the profile', () => {
  it('continue that never stops within its deadline is outcome=unknown; pause reconciles it', async () => {
    const { sc: h } = await call('hostproto_context_create', { program: '.', cwd: SPIN });
    const s = h.surface.id;
    const { sc } = await call('hostproto_surface_act', intent(s, 'continue', { params: { deadline_ms: 300 } }));
    expect(validator('receipt')(sc)).toBe(true);
    expect(sc).toMatchObject({ outcome: 'unknown', executed: false, verified: false, attempted: true, accepted: true });
    const running = (await call('hostproto_surface_observe', { surface: s, projections: ['state', 'frames'] })).sc;
    expect(running.data.state.stopped).toBe(false);
    expect(running.bounded.omitted).toEqual({ frames: 1 }); expect(running.bounded.lossy).toBe(false);
    const paused = await call('hostproto_surface_act', intent(s, 'pause'));
    expect(paused.sc.outcome).toBe('completed'); expect(paused.sc.effects[0]).toMatchObject({ kind: 'stopped', reason: 'pause' });
    await call('hostproto_context_close', { context: h.context.id });
  }, 120000);

  it('earns runtime verification only for what ran; reverse requests are declared unsupported', async () => {
    const { sc } = await call('hostproto_capabilities');
    expect(validator('capability-profile')(sc)).toBe(true);
    expect(sc.adapter).toMatchObject({ kind: 'delve', variant: 'go' });
    expect(sc.capabilities['act.continue'].verification).toBe('runtime');
    expect(sc.capabilities['act.step_out'].verification).toBe('source-audit');
    expect(sc.capabilities['act.host_request.resolve'].availability).toBe('unsupported');
  });
});
