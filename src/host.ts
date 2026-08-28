// The Delve host: the only place that speaks DAP. Structure kept file-for-file
// with hostproto-dap-debugpy; the diff between the two is the measurement of
// kill gate 1 on a second debugger. Everything it returns is
// a HostProto object validated against the pinned bundle before it leaves.
// Revision (per thread, on every stopped↔running transition), the
// host-assigned cursor over normalized events, revision-scoped targets that
// are refused before anything is sent, preconditions, receipts and
// deviations are computed here. `server.ts` is projection only.
import { spawn, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DapClient, DapClosed, DapError, DapTimeout, type DapEvent, type DapRequest } from './dap.js';
import { assertValid } from './schemas.js';

export class HostProtoError extends Error {
  constructor(public code: string, message: string, public hostInvoked: boolean, public data: Record<string, unknown> = {}) { super(message); }
  toObject() {
    const error = { schema_version: 'hostproto.error/v1', code: this.code, message: this.message.slice(0, 1024), host_invoked: this.hostInvoked, data: this.data };
    assertValid('error', error);
    return error;
  }
}
const sha = (data: string | Buffer) => `sha256:${createHash('sha256').update(data).digest('hex')}`;
const opaque = (prefix: string) => `${prefix}-${randomUUID().slice(0, 12)}`;
type J = Record<string, unknown>;

export const INTENT_FAMILY = ['set_breakpoints', 'step_over', 'step_in', 'step_out', 'continue', 'pause', 'evaluate', 'set_variable', 'host_request.resolve'] as const;
export const PROJECTIONS = ['state', 'frames', 'scopes', 'variables', 'output', 'breakpoints', 'host_requests'] as const;
export const ASSERTABLE = ['stopped', 'thread_id', 'revision'] as const;
const STEP_COMMANDS: Record<string, string> = { step_over: 'next', step_in: 'stepIn', step_out: 'stepOut', continue: 'continue', pause: 'pause' };
export const DEFAULT_DLV = process.env.HOSTPROTO_DLV ?? path.join(homedir(), 'go', 'bin', 'dlv');

interface Event { event_id: string; seq: number; kind: string; revision: number; payload: J }
interface Target { role: 'frame' | 'scope' | 'variable'; revision: number; name: string; actions: string[]; frameId?: number; variablesReference?: number; parentReference?: number; variableName?: string }
interface Stopped { stopped: boolean; reason?: string; hit_breakpoint_ids?: number[]; all_threads_stopped?: boolean; description?: string }
interface HostRequest { token: string; kind: 'host_request'; command: string; args: J; status: 'pending' | 'resolved'; default: 'deny'; decision?: string; request: DapRequest }
export interface Surface {
  id: string; contextId: string; threadId: number | null; revision: number; lifecycle: 'creating' | 'open' | 'closed' | 'terminated';
  events: Event[]; seq: number; state: Stopped; targets: Map<string, Target>; targetCounter: number; topFrame?: { line: number; source: string; name: string; revision: number };
}
interface Ctx {
  id: string; client: DapClient; cwd: string; program: string; surfaces: Set<string>; main: string; threads: Map<number, string>;
  writer: { fence_id: string; epoch: number; holder?: string }; breakpoints: Map<string, J[]>; hostRequests: Map<string, HostRequest>;
  terminated: boolean; exitCode: number | null; capabilities: J; lastContinued: number;
}
export interface Artifact { uri: string; mediaType: string; bytes: Buffer }
export type SurfaceListener = (surfaceId: string) => void;

export class DelveHost {
  readonly hostId = opaque('host');
  private contexts = new Map<string, Ctx>();
  private surfaces = new Map<string, Surface>();
  readonly ledger = new Map<string, number>();
  private listeners = new Set<SurfaceListener>();
  private counters = { receipt: 0 };
  private adapterIdentity: J = {};
  constructor(private readonly dlv = DEFAULT_DLV) {}

  onSurfaceChanged(listener: SurfaceListener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private exercised(name: string) { this.ledger.set(name, (this.ledger.get(name) ?? 0) + 1); }

  private surface(id: string, allow: Array<Surface['lifecycle']> = ['open']): Surface {
    const surface = this.surfaces.get(id);
    if (!surface) throw new HostProtoError('handle_expired', `unknown or expired surface ${id}`, false, { surface: id });
    if (!allow.includes(surface.lifecycle)) {
      if (surface.lifecycle === 'terminated') { const ctx = this.contexts.get(surface.contextId); throw new HostProtoError('handle_expired', 'debuggee exited; the surface is terminated', false, { surface: id, host: this.hostId, exit_code: ctx?.exitCode ?? null }); }
      throw new HostProtoError('host_rejected', `surface is ${surface.lifecycle}`, false, { surface: id, lifecycle: surface.lifecycle });
    }
    return surface;
  }
  private ctxOf(surface: Surface): Ctx { const ctx = this.contexts.get(surface.contextId); if (!ctx) throw new HostProtoError('handle_expired', 'context is gone', false, { context: surface.contextId }); return ctx; }
  private emit(surface: Surface, kind: string, payload: J = {}, raw?: number) {
    surface.seq += 1;
    surface.events.push({ event_id: `${surface.id}-evt-${String(surface.seq).padStart(6, '0')}`, seq: surface.seq, kind, revision: surface.revision, payload: raw !== undefined ? { ...payload, dap_seq: raw } : payload });
    for (const listener of this.listeners) listener(surface.id);
  }
  /** A running↔stopped transition: the revision moves and every target minted at the old one is gone. */
  private transition(surface: Surface, state: Stopped) {
    surface.revision += 1; surface.state = state; surface.targets.clear(); surface.topFrame = undefined;
  }

  // -- handles --------------------------------------------------------------
  /** Start `dlv dap` on a loopback port of its choosing and connect to it. */
  private async startAdapter(cwd: string): Promise<{ client: DapClient; sink: { stdout: (text: string) => void; stderr: (text: string) => void } }> {
    const child: ChildProcess = spawn(this.dlv, ['dap', '--listen', '127.0.0.1:0'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const sink = { stdout: (text: string) => {}, stderr: (text: string) => {} };
    let announced = false;
    const port = await new Promise<number>((resolve, reject) => {
      let text = '';
      const timer = setTimeout(() => reject(new Error('dlv dap did not announce its port')), 15000);
      child.stdout!.on('data', (chunk: Buffer) => {
        if (announced) { sink.stdout(chunk.toString()); return; }
        text += chunk.toString(); const m = /listening at: [^:\s]+:(\d+)\n/.exec(text);
        if (m) { clearTimeout(timer); announced = true; const rest = text.slice(m.index + m[0].length); if (rest) sink.stdout(rest); resolve(Number(m[1])); }
      });
      child.stderr!.on('data', (chunk: Buffer) => { if (announced) sink.stderr(chunk.toString()); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`dlv exited with ${code} before listening`)); });
      child.once('error', e => { clearTimeout(timer); reject(e); });
    });
    const client = await DapClient.connect('127.0.0.1', port, child);
    return { client, sink };
  }

  async createContext(params: { program: string; args?: string[]; cwd?: string; mode?: string; stop_on_entry?: boolean; client?: { id?: string } }) {
    if (!params.program) throw new HostProtoError('invalid_request', 'program is required', false);
    const cwd = path.resolve(params.cwd ?? process.cwd());
    const program = path.resolve(cwd, params.program);
    const mode = params.mode ?? 'debug';
    if (!['debug', 'exec', 'test'].includes(mode)) throw new HostProtoError('capability_unsupported', 'mode must be debug, exec or test', false, { mode });
    let client: DapClient; let sink: { stdout: (text: string) => void; stderr: (text: string) => void };
    try { ({ client, sink } = await this.startAdapter(cwd)); } catch (error) { throw new HostProtoError('host_failed', `dlv dap did not start: ${(error as Error).message}`, true, { dlv: this.dlv }); }
    const ctx: Ctx = { id: opaque('ctx'), client, cwd, program, surfaces: new Set(), main: '', threads: new Map(), writer: { fence_id: opaque('fence'), epoch: 1, holder: params.client?.id }, breakpoints: new Map(), hostRequests: new Map(), terminated: false, exitCode: null, capabilities: {}, lastContinued: 0 };
    this.contexts.set(ctx.id, ctx);
    const main = this.mint(ctx, null); ctx.main = main.id; main.lifecycle = 'creating';
    client.onEvent(event => this.onEvent(ctx, event));
    client.onReverseRequest(request => this.onReverseRequest(ctx, request));
    // dlv dap does not forward debuggee stdio as DAP `output` events; it inherits the adapter's own
    // stdio. It is normalized into the same `output` event stream, marked with its channel.
    sink.stdout = text => this.emit(main, 'output', { category: 'stdout', output: text, channel: 'adapter-stdio' });
    sink.stderr = text => this.emit(main, 'output', { category: 'stderr', output: text, channel: 'adapter-stdio' });
    try {
      ctx.capabilities = await client.request('initialize', { clientID: 'hostproto', clientName: 'hostproto-dap-delve', adapterID: 'go', pathFormat: 'path', linesStartAt1: true, columnsStartAt1: true, supportsRunInTerminalRequest: false, locale: 'en' }, 15000);
      this.adapterIdentity = { dap: 'dlv dap', dlv: this.dlv, supportsStepBack: ctx.capabilities.supportsStepBack ?? false, supportsRestartFrame: ctx.capabilities.supportsRestartFrame ?? false };
      const initialized = new Promise<void>(resolve => { const off = client.onEvent(e => { if (e.event === 'initialized') { off(); resolve(); } }); });
      // Delve builds the program inside `launch` (mode: debug); the response can take seconds on a cold cache.
      const launch = client.request('launch', { request: 'launch', mode, program, args: params.args ?? [], cwd, stopOnEntry: params.stop_on_entry ?? true }, 180000);
      launch.catch(() => {});
      // A launch that fails (a build error, say) never sends `initialized`: race it.
      await Promise.race([initialized, launch]);
      await client.request('configurationDone', {}, 15000);
      await launch;
      await this.until(() => main.lifecycle === 'open' && main.state.stopped, 30000, 'debuggee did not stop on entry');
    } catch (error) {
      client.close(); this.contexts.delete(ctx.id);
      throw new HostProtoError('host_failed', `launch failed: ${(error as Error).message}`, true, { program });
    }
    this.exercised('context.launch');
    return this.handles(ctx, main);
  }
  private mint(ctx: Ctx, threadId: number | null): Surface {
    const surface: Surface = { id: opaque('thread'), contextId: ctx.id, threadId, revision: 1, lifecycle: 'open', events: [], seq: 0, state: { stopped: false }, targets: new Map(), targetCounter: 0 };
    this.surfaces.set(surface.id, surface); ctx.surfaces.add(surface.id);
    if (threadId !== null) ctx.threads.set(threadId, surface.id);
    return surface;
  }
  private async until(pred: () => boolean, ms: number, what: string) {
    const end = Date.now() + ms;
    while (!pred()) { if (Date.now() > end) throw new Error(what); await new Promise(r => setTimeout(r, 20)); }
  }

  private onEvent(ctx: Ctx, event: DapEvent) {
    const body = (event.body ?? {}) as J;
    const main = this.surfaces.get(ctx.main)!;
    const byThread = (id: unknown) => { const sid = ctx.threads.get(Number(id)); return sid ? this.surfaces.get(sid) : undefined; };
    switch (event.event) {
      case 'thread': {
        const threadId = Number(body.threadId);
        if (body.reason === 'started') {
          let surface = byThread(threadId);
          if (!surface) {
            if (main.threadId === null) { surface = main; main.threadId = threadId; ctx.threads.set(threadId, main.id); main.lifecycle = 'open'; }
            else surface = this.mint(ctx, threadId);
          }
          this.emit(surface, 'thread.started', { thread_id: threadId }, event.seq);
        } else if (body.reason === 'exited') {
          const surface = byThread(threadId);
          if (surface && surface.lifecycle === 'open') { surface.lifecycle = 'terminated'; this.emit(surface, 'thread.exited', { thread_id: threadId }, event.seq); }
        }
        return;
      }
      case 'stopped': {
        let surface = byThread(body.threadId);
        if (!surface) { if (main.threadId === null) { main.threadId = Number(body.threadId); ctx.threads.set(main.threadId, main.id); main.lifecycle = 'open'; surface = main; } else surface = this.mint(ctx, Number(body.threadId)); }
        const state: Stopped = { stopped: true, reason: String(body.reason), hit_breakpoint_ids: (body.hitBreakpointIds as number[] | undefined) ?? [], all_threads_stopped: Boolean(body.allThreadsStopped), ...(body.description ? { description: String(body.description) } : {}) };
        this.transition(surface, state); this.emit(surface, 'stopped', { reason: state.reason, hit_breakpoint_ids: state.hit_breakpoint_ids }, event.seq);
        if (state.all_threads_stopped) for (const sid of ctx.surfaces) { const other = this.surfaces.get(sid)!; if (other !== surface && other.lifecycle === 'open' && !other.state.stopped) { this.transition(other, { ...state, hit_breakpoint_ids: [] }); this.emit(other, 'stopped', { reason: state.reason, stopped_thread: surface.id, all_threads_stopped: true }, event.seq); } }
        return;
      }
      case 'continued': {
        const surface = byThread(body.threadId) ?? main;
        ctx.lastContinued = event.seq;
        const apply = (s: Surface) => { if (s.state.stopped) { this.transition(s, { stopped: false }); this.emit(s, 'continued', { thread_id: s.threadId }, event.seq); } };
        apply(surface);
        if (body.allThreadsContinued) for (const sid of ctx.surfaces) { const o = this.surfaces.get(sid)!; if (o.lifecycle === 'open') apply(o); }
        return;
      }
      case 'output': {
        const target = ctx.terminated ? null : main;
        if (!target) { /* output after terminated is suppressed, with a rule id, on the next observation */ main.events.push({ event_id: `${main.id}-evt-suppressed-${event.seq}`, seq: main.seq, kind: 'suppressed.output', revision: main.revision, payload: { rule_id: 'norm.output.after_terminated', dap_seq: event.seq, raw_ref: sha(JSON.stringify(event)) } }); return; }
        this.emit(main, 'output', { category: body.category ?? 'console', output: String(body.output ?? '') }, event.seq); return;
      }
      case 'breakpoint': this.emit(main, 'breakpoint.changed', { reason: body.reason, breakpoint: body.breakpoint as J }, event.seq); return;
      case 'invalidated': { for (const sid of ctx.surfaces) { const s = this.surfaces.get(sid)!; if (s.lifecycle === 'open') { s.targets.clear(); s.revision += 1; this.emit(s, 'invalidated', { areas: body.areas ?? [] }, event.seq); } } return; }
      case 'exited': ctx.exitCode = Number(body.exitCode ?? 0); this.emit(main, 'process.exited', { exit_code: ctx.exitCode }, event.seq); return;
      case 'terminated': {
        ctx.terminated = true;
        for (const sid of ctx.surfaces) { const s = this.surfaces.get(sid)!; if (s.lifecycle === 'open' || s.lifecycle === 'creating') { s.lifecycle = 'terminated'; this.emit(s, 'surface.terminated', { reason: 'debuggee exited', exit_code: ctx.exitCode }, event.seq); } }
        return;
      }
      default: this.emit(main, `dap.${event.event}`, body, event.seq);
    }
  }
  private onReverseRequest(ctx: Ctx, request: DapRequest) {
    const main = this.surfaces.get(ctx.main)!;
    const token = opaque('hreq');
    ctx.hostRequests.set(token, { token, kind: 'host_request', command: request.command, args: (request.arguments ?? {}) as J, status: 'pending', default: 'deny', request });
    this.emit(main, 'host_request.opened', { token, command: request.command }, request.seq);
  }

  handles(ctx: Ctx, surface: Surface) {
    const handles = {
      schema_version: 'hostproto.handles/v1',
      host: { id: this.hostId, kind: 'host', expires: null },
      context: { id: ctx.id, kind: 'context', expires: null },
      surface: { id: surface.id, kind: 'surface', expires: null, lifecycle: surface.lifecycle },
      adapter_profile: 'dap/v1',
      writer: { fence_id: ctx.writer.fence_id, epoch: ctx.writer.epoch, ...(ctx.writer.holder ? { holder: ctx.writer.holder } : {}) },
    };
    assertValid('handles', handles);
    return handles;
  }
  async closeContext(id: string) {
    const ctx = this.contexts.get(id);
    if (!ctx) throw new HostProtoError('handle_expired', `unknown or expired context ${id}`, false, { context: id });
    if (!ctx.client.closed) await ctx.client.request('disconnect', { terminateDebuggee: true }, 3000).catch(() => {});
    ctx.client.close();
    for (const sid of ctx.surfaces) { const s = this.surfaces.get(sid); if (s && s.lifecycle !== 'terminated') s.lifecycle = 'closed'; }
    this.contexts.delete(id);
    this.exercised('context.close');
    return { context: id, closed: true, surfaces: [...ctx.surfaces], exit_code: ctx.exitCode };
  }

  // -- observation ----------------------------------------------------------
  private async topFrame(ctx: Ctx, surface: Surface) {
    if (!surface.state.stopped || surface.threadId === null) return undefined;
    if (surface.topFrame && surface.topFrame.revision === surface.revision) return surface.topFrame;
    const body = await ctx.client.request('stackTrace', { threadId: surface.threadId, startFrame: 0, levels: 1 }, 10000);
    const frame = ((body.stackFrames as J[] | undefined) ?? [])[0];
    if (!frame) return undefined;
    surface.topFrame = { line: Number(frame.line), source: this.rel(ctx, frame), name: String(frame.name), revision: surface.revision };
    return surface.topFrame;
  }
  private rel(ctx: Ctx, frame: J) { const p = (frame.source as J | undefined)?.path; return typeof p === 'string' ? path.relative(ctx.cwd, p) || p : String((frame.source as J | undefined)?.name ?? '?'); }
  private async state(ctx: Ctx, surface: Surface): Promise<J> {
    const top = await this.topFrame(ctx, surface).catch(() => undefined);
    return { stopped: surface.state.stopped, ...(surface.state.reason ? { reason: surface.state.reason } : {}), thread_id: surface.threadId, hit_breakpoint_ids: surface.state.hit_breakpoint_ids ?? [], all_threads_stopped: surface.state.all_threads_stopped ?? false,
      ...(top ? { line: top.line, source: top.source, function: top.name } : {}), lifecycle: surface.lifecycle, revision: surface.revision, ...(ctx.exitCode !== null ? { exit_code: ctx.exitCode } : {}) };
  }
  private target(surface: Surface, id: string, role: Target['role'], name: string, actions: string[], extra: Partial<Target>) {
    surface.targetCounter += 1;
    const targetId = `${id}-${surface.targetCounter}`;
    surface.targets.set(targetId, { role, revision: surface.revision, name, actions, ...extra });
    const ref = { schema_version: 'hostproto.target-ref/v1', surface: surface.id, target_id: targetId, revision: surface.revision, role, name, actions };
    assertValid('target-ref', ref); return ref;
  }
  /** The rule under test in step 5: a target from another revision is refused before anything is sent. */
  private checkTarget(surface: Surface, ref: J | undefined, roles: string[], action: string): Target {
    if (!ref) throw new HostProtoError('invalid_request', `${action} requires a target`, false);
    if (ref.surface !== surface.id) throw new HostProtoError('target_invalidated', 'target belongs to another surface', false, { target_id: ref.target_id });
    if (ref.revision !== surface.revision) throw new HostProtoError('target_invalidated', 'target belongs to an earlier revision', false, { target_id: ref.target_id, target_revision: ref.revision, surface_revision: surface.revision });
    const target = surface.targets.get(String(ref.target_id));
    if (!target || target.revision !== surface.revision) throw new HostProtoError('target_invalidated', 'target is not known at this revision', false, { target_id: ref.target_id });
    if (!roles.includes(target.role)) throw new HostProtoError('capability_unsupported', `${action} is not defined for role ${target.role}`, false, { target_id: ref.target_id, role: target.role });
    if (!target.actions.includes(action)) throw new HostProtoError('capability_unsupported', 'target does not declare this action', false, { target_id: ref.target_id, action });
    return target;
  }

  async observe(params: { surface: string; projections?: string[]; since?: number; max_bytes?: number; target?: J }) {
    const surface = this.surface(params.surface, ['open', 'creating', 'terminated']);
    const ctx = this.ctxOf(surface);
    const projections = params.projections?.length ? params.projections : ['state'];
    const since = params.since ?? 0; const maxBytes = params.max_bytes ?? 65536;
    if (maxBytes < 512) throw new HostProtoError('invalid_request', 'max_bytes must be at least 512', false);
    const unknown = projections.filter(p => !(PROJECTIONS as readonly string[]).includes(p));
    if (unknown.length) throw new HostProtoError('capability_unsupported', 'unsupported projection', false, { projections: unknown });
    const data: J = {}; const omitted: Record<string, number> = {}; const deviations: J[] = []; const artifacts: Artifact[] = [];
    const needsStopped = (p: string) => { if (surface.state.stopped && surface.lifecycle === 'open') return true; omitted[p] = 1; deviations.push({ kind: 'divergence', reason: `${p} projection requires a stopped thread; omitted, not lost`, object_ids: [surface.id] }); return false; };
    // Suppressed raw records are surfaced here as suppression deviations, with rule id and raw ref, and then dropped from the stream.
    for (const e of surface.events.filter(e => e.kind === 'suppressed.output')) deviations.push({ kind: 'suppression', reason: 'output after terminated', rule_id: String(e.payload.rule_id), raw_ref: String(e.payload.raw_ref), object_ids: [surface.id] });
    surface.events = surface.events.filter(e => e.kind !== 'suppressed.output');
    for (const projection of projections) {
      if (projection === 'state') data.state = await this.state(ctx, surface);
      else if (projection === 'output') data.output = surface.events.filter(e => e.seq > since && e.kind === 'output');
      else if (projection === 'breakpoints') data.breakpoints = Object.fromEntries(ctx.breakpoints);
      else if (projection === 'host_requests') data.host_requests = [...ctx.hostRequests.values()].map(({ request, ...rest }) => rest);
      else if (projection === 'frames') { if (!needsStopped(projection)) continue;
        const body = await ctx.client.request('stackTrace', { threadId: surface.threadId, startFrame: 0, levels: 20 }, 10000);
        data.frames = ((body.stackFrames as J[]) ?? []).map(f => this.target(surface, 'frame', 'frame', `${f.name}  ${this.rel(ctx, f)}:${f.line}`, ['scopes', 'evaluate'], { frameId: Number(f.id) }));
      } else if (projection === 'scopes') { if (!needsStopped(projection)) continue;
        const frame = this.checkTarget(surface, params.target, ['frame'], 'scopes');
        const body = await ctx.client.request('scopes', { frameId: frame.frameId }, 10000);
        data.scopes = ((body.scopes as J[]) ?? []).map(s => this.target(surface, 'scope', 'scope', String(s.name), ['expand'], { variablesReference: Number(s.variablesReference) }));
      } else if (projection === 'variables') { if (!needsStopped(projection)) continue;
        const container = this.checkTarget(surface, params.target, ['scope', 'variable'], 'expand');
        const body = await ctx.client.request('variables', { variablesReference: container.variablesReference }, 10000);
        data.variables = ((body.variables as J[]) ?? []).map(v => { const ref = Number(v.variablesReference ?? 0);
          return this.target(surface, 'var', 'variable', `${v.name} = ${String(v.value).slice(0, 200)}`, ref > 0 ? ['expand', 'set'] : ['set'], { variablesReference: ref, parentReference: container.variablesReference, variableName: String(v.name) }); });
      }
    }
    const observation: J = { schema_version: 'hostproto.observation/v1', surface: surface.id, revision: surface.revision, cursor: { since, next: surface.seq }, projections, data,
      bounded: { max_bytes: maxBytes, lossy: false, omitted, raw_ref: null }, provider: 'engine', deviations };
    if (Buffer.byteLength(JSON.stringify(observation)) > maxBytes) {
      const full = JSON.stringify(observation);
      const rawUri = `hostproto://surface/${surface.id}/observation/${sha(full).slice(7, 19)}`;
      artifacts.push({ uri: rawUri, mediaType: 'application/json', bytes: Buffer.from(full) });
      const compact: J = {};
      for (const [k, v] of Object.entries(data)) { if (k === 'state') compact[k] = v; else if (Array.isArray(v)) { compact[k] = v.slice(0, 1); omitted[k] = Math.max(0, v.length - 1); } else { compact[k] = { omitted: true }; omitted[k] = 1; } }
      observation.data = compact; observation.bounded = { max_bytes: maxBytes, lossy: true, omitted, raw_ref: sha(full) };
    }
    assertValid('observation', observation);
    for (const p of projections) if (!(p in omitted)) this.exercised(`observe.${p}`);
    return { observation, artifacts };
  }

  // -- action ---------------------------------------------------------------
  private async checkPreconditions(ctx: Ctx, surface: Surface, pre: J | undefined) {
    if (!pre) return;
    assertValid('precondition', pre);
    if (pre.surface !== surface.id) throw new HostProtoError('precondition_failed', 'precondition names another surface', false);
    if (pre.revision !== undefined && pre.revision !== surface.revision) throw new HostProtoError('precondition_failed', 'surface revision does not match', false, { expected: pre.revision, observed: surface.revision });
    const state = { stopped: surface.state.stopped, thread_id: surface.threadId, revision: surface.revision } as J;
    for (const { field, equals } of pre.assertions as Array<{ field: string; equals: unknown }>) {
      if (!(ASSERTABLE as readonly string[]).includes(field)) throw new HostProtoError('invalid_request', `field is not assertable in dap/v1: ${field}`, false);
      if (state[field] !== equals) throw new HostProtoError('precondition_failed', `surface ${field} does not match`, false, { field, expected: equals, observed: state[field] });
    }
    void ctx;
  }
  private stateDigest(surface: Surface) { return sha(JSON.stringify({ stopped: surface.state.stopped, reason: surface.state.reason, revision: surface.revision, lifecycle: surface.lifecycle })); }

  async act(intent: J) {
    assertValid('intent', intent);
    const kind = intent.kind as string;
    if (!(INTENT_FAMILY as readonly string[]).includes(kind)) throw new HostProtoError('capability_unsupported', 'intent kind is outside dap/v1', false, { kind, family: INTENT_FAMILY });
    const surface = this.surface(intent.surface as string, kind === 'host_request.resolve' ? ['open', 'creating'] : ['open']);
    const ctx = this.ctxOf(surface);
    await this.checkPreconditions(ctx, surface, intent.preconditions as J | undefined);
    const params = (intent.params ?? {}) as J;
    const declared = (intent.declared_effects as string[] | undefined) ?? [];
    const revisionBefore = surface.revision, stateBefore = this.stateDigest(surface), cursor = surface.seq;
    let effects: J[] = []; const deviations: J[] = []; let hostInvoked = false;
    let outcome: 'completed' | 'unknown' = 'completed'; let verified = false;
    try {
      if (kind === 'set_breakpoints') {
        const source = String(params.source ?? ''); const lines = (params.lines as number[] | undefined) ?? [];
        if (!source || !lines.every(l => Number.isInteger(l) && l > 0)) throw new HostProtoError('invalid_request', 'set_breakpoints needs source and positive integer lines', false);
        hostInvoked = true;
        const body = await ctx.client.request('setBreakpoints', { source: { path: path.resolve(ctx.cwd, source) }, breakpoints: lines.map(line => ({ line })), lines }, 15000);
        const bps = ((body.breakpoints as J[]) ?? []).map((b, i) => ({ id: b.id ?? null, line: b.line ?? lines[i], requested_line: lines[i], verified: Boolean(b.verified), ...(b.message ? { message: b.message } : {}) }));
        ctx.breakpoints.set(source, bps);
        this.emit(surface, 'breakpoints.set', { source, count: bps.length });
        effects = [{ kind: 'breakpoints', source, breakpoints: bps }];
        const unbound = bps.filter(b => !b.verified);
        verified = bps.some(b => b.verified);
        const moved = bps.filter(b => b.verified && b.line !== b.requested_line);
        if (moved.length) deviations.push({ kind: 'divergence', reason: `${moved.length} breakpoint(s) bound at a different line than requested; the adapter relocated them and the receipt says so`, object_ids: moved.map(b => `breakpoint-${b.id}`), data: { moved: moved.map(b => ({ requested_line: b.requested_line, line: b.line })) } });
        if (unbound.length) deviations.push({ kind: 'divergence', reason: `${unbound.length} of ${bps.length} requested breakpoints did not bind; the adapter reports verified=false, so this receipt verified only the bound ones`, object_ids: unbound.map(b => `breakpoint-${b.id ?? b.requested_line}`) });
      } else if (kind in STEP_COMMANDS) {
        if (surface.threadId === null) throw new HostProtoError('precondition_failed', 'surface has no thread yet', false);
        const wantsStopped = kind !== 'pause' ? surface.state.stopped : !surface.state.stopped;
        if (!wantsStopped) throw new HostProtoError('precondition_failed', kind === 'pause' ? 'thread is already stopped' : 'thread is not stopped', false, { stopped: surface.state.stopped });
        const deadline = Number(params.deadline_ms ?? 10000);
        hostInvoked = true;
        const seqAtSend = surface.seq;
        await ctx.client.request(STEP_COMMANDS[kind], { threadId: surface.threadId, ...(kind === 'continue' ? {} : { granularity: 'statement' }) }, Math.max(deadline, 1000));
        const end = Date.now() + deadline;
        const stoppedSince = () => surface.events.some(e => e.seq > seqAtSend && e.kind === 'stopped');
        const continuedSince = () => surface.events.some(e => e.seq > seqAtSend && e.kind === 'continued');
        if (kind !== 'pause') {
          const grace = Date.now() + 150;
          while (!continuedSince() && !stoppedSince() && surface.lifecycle === 'open' && Date.now() < grace) await new Promise(r => setTimeout(r, 10));
          if (!continuedSince() && !stoppedSince() && surface.lifecycle === 'open') {
            // The adapter acknowledged the resume but sent no `continued`: the running transition is applied from the response, and the receipt says so.
            this.transition(surface, { stopped: false }); this.emit(surface, 'continued', { thread_id: surface.threadId, from: 'response' });
            deviations.push({ kind: 'unmapped_event', reason: 'adapter sent no continued event within the grace period; running state applied from the resume response', object_ids: [surface.id] });
          }
        }
        while (!(surface.state.stopped && stoppedSince()) && surface.lifecycle === 'open' && Date.now() < end) await new Promise(r => setTimeout(r, 15));
        if (surface.lifecycle === 'terminated') { effects = [{ kind: 'continued', thread_id: surface.threadId }, { kind: 'terminated', exit_code: ctx.exitCode }]; verified = true; }
        else if (surface.state.stopped && stoppedSince()) {
          const top = await this.topFrame(ctx, surface).catch(() => undefined);
          effects = [...(kind === 'pause' ? [] : [{ kind: 'continued', thread_id: surface.threadId }]), { kind: 'stopped', reason: surface.state.reason, ...(top ? { line: top.line, source: top.source } : {}), hit_breakpoint_ids: surface.state.hit_breakpoint_ids ?? [] }];
          verified = true;
          const declaredStop = declared.find(d => d.startsWith('stopped:'))?.slice(8);
          if (declaredStop && declaredStop !== surface.state.reason) deviations.push({ kind: 'divergence', reason: `declared effect stopped:${declaredStop}, observed stopped:${surface.state.reason}; a ${surface.state.reason} pre-empted the ${kind} and the receipt says so`, object_ids: [surface.id] });
        } else {
          outcome = 'unknown';
          deviations.push({ kind: 'divergence', reason: `${kind} request was accepted and the deadline elapsed without a stop; the program may be running; reconcile from the next observation`, object_ids: [surface.id] });
        }
      } else if (kind === 'evaluate') {
        const expression = String(params.expression ?? ''); if (!expression) throw new HostProtoError('invalid_request', 'evaluate needs an expression', false);
        const frame = intent.target ? this.checkTarget(surface, intent.target as J, ['frame'], 'evaluate') : undefined;
        if (!surface.state.stopped) throw new HostProtoError('precondition_failed', 'thread is not stopped', false);
        hostInvoked = true;
        const body = await ctx.client.request('evaluate', { expression, context: String(params.context ?? 'watch'), ...(frame ? { frameId: frame.frameId } : {}) }, 15000);
        effects = [{ kind: 'evaluated', expression, result: String(body.result ?? ''), type: body.type ?? null }];
        verified = true; this.emit(surface, 'evaluated', { expression });
      } else if (kind === 'set_variable') {
        const variable = this.checkTarget(surface, intent.target as J, ['variable'], 'set');
        hostInvoked = true;
        const body = await ctx.client.request('setVariable', { variablesReference: variable.parentReference, name: variable.variableName, value: String(params.value ?? '') }, 15000);
        // `verified` is earned by an independent read, not taken from the response.
        const frameId = [...surface.targets.values()].find(t => t.role === 'frame')?.frameId;
        const readBack = await ctx.client.request('evaluate', { expression: String(variable.variableName), context: 'watch', ...(frameId !== undefined ? { frameId } : {}) }, 15000).then(b => String(b.result ?? ''), () => null);
        effects = [{ kind: 'variable.set', name: variable.variableName, value: String(body.value ?? ''), type: body.type ?? null, read_back: readBack }];
        verified = readBack !== null && readBack === String(body.value ?? '');
        if (!verified) deviations.push({ kind: 'divergence', reason: 'the adapter acknowledged the write but an independent read did not return the new value', object_ids: [String(variable.variableName)], data: { acknowledged: String(body.value ?? ''), read_back: readBack } });
        this.emit(surface, 'variable.set', { name: variable.variableName });
      } else if (kind === 'host_request.resolve') {
        const record = ctx.hostRequests.get(String(intent.decision_token));
        if (!record || record.status !== 'pending') throw new HostProtoError('precondition_failed', 'decision token is unknown or already resolved', false, { decision_token: intent.decision_token });
        const decision = String(params.decision ?? (record.default === 'deny' ? 'deny' : 'allow'));
        if (!['allow', 'deny'].includes(decision)) throw new HostProtoError('invalid_request', 'decision must be allow or deny', false, { decision });
        hostInvoked = true;
        if (decision === 'allow' && record.command === 'runInTerminal') {
          const args = (record.args.args as string[]) ?? []; const cwd = String(record.args.cwd ?? ctx.cwd);
          const child = spawn(args[0], args.slice(1), { cwd, env: { ...process.env, ...((record.args.env as Record<string, string>) ?? {}) }, stdio: 'ignore', detached: false });
          child.on('error', () => {}); child.unref();
          ctx.client.respond(record.request, true, { processId: child.pid });
          effects = [{ kind: 'host_request.decision', decision, token: record.token, process_id: child.pid ?? null }];
        } else {
          ctx.client.respond(record.request, decision === 'allow', undefined, decision === 'deny' ? 'denied by the HostProto client' : undefined);
          effects = [{ kind: 'host_request.decision', decision, token: record.token }];
        }
        record.status = 'resolved'; record.decision = decision; verified = true;
        this.emit(surface, 'host_request.resolved', { token: record.token, decision });
      }
    } catch (error) {
      if (error instanceof HostProtoError) throw error;
      if (error instanceof DapTimeout) { outcome = 'unknown'; deviations.push({ kind: 'divergence', reason: `${error.command} exceeded its deadline after the adapter was invoked; reconcile from the next observation` }); }
      else if (error instanceof DapClosed) throw new HostProtoError('handle_expired', 'adapter process is gone', hostInvoked, { host: this.hostId, exit_code: ctx.exitCode });
      else if (error instanceof DapError) throw new HostProtoError('host_rejected', `${error.command}: ${error.message}`, true, { command: error.command });
      else throw new HostProtoError('host_failed', String((error as Error).message ?? error), hostInvoked);
    }
    const caused = surface.events.filter(e => e.seq > cursor).map(e => e.event_id);
    this.counters.receipt += 1;
    const receipt = {
      schema_version: 'hostproto.receipt/v1', receipt_id: `receipt-${String(this.counters.receipt).padStart(4, '0')}`,
      action_id: intent.action_id, surface: surface.id, attempted: true, accepted: true, executed: outcome === 'completed', verified: outcome === 'completed' && verified,
      outcome, provider: kind === 'host_request.resolve' ? 'host' : 'engine', caused_events: caused, effects,
      revision_before: revisionBefore, revision_after: surface.revision, state_before: stateBefore, state_after: this.stateDigest(surface), evidence: [], deviations,
    };
    assertValid('receipt', receipt);
    if (outcome === 'completed') this.exercised(`act.${kind}`);
    return receipt;
  }

  // -- wait -----------------------------------------------------------------
  async await(params: { surface: string; conditions: Array<{ kind: string; equals: unknown }>; deadline_ms?: number }) {
    const surface = this.surface(params.surface, ['open', 'creating', 'terminated']);
    const conditions = params.conditions ?? [];
    if (!conditions.length) throw new HostProtoError('invalid_request', 'await requires at least one condition', false);
    const holds = (c: { kind: string; equals: unknown }) => {
      if (c.kind === 'stopped') return surface.state.stopped === c.equals;
      if (c.kind === 'lifecycle') return surface.lifecycle === c.equals;
      if (c.kind === 'revision') return surface.revision === c.equals;
      if (c.kind === 'event_kind') return surface.events.some(e => e.kind === c.equals);
      if (c.kind === 'host_request') return [...this.ctxOf(surface).hostRequests.values()].some(r => r.status === 'pending') === c.equals;
      throw new HostProtoError('invalid_request', `unknown await condition: ${c.kind}`, false);
    };
    const until = Date.now() + Number(params.deadline_ms ?? 30000);
    for (;;) {
      const results = conditions.map(holds);
      if (results.every(Boolean)) break;
      if (Date.now() >= until) throw new HostProtoError('deadline_exceeded', 'await deadline elapsed', true, { unsatisfied: conditions.filter((_, i) => !results[i]), cursor: surface.seq });
      await new Promise(r => setTimeout(r, 20));
    }
    this.exercised('await');
    return { satisfied: true, surface: surface.id, revision: surface.revision, cursor: { since: 0, next: surface.seq } };
  }

  // -- recovery and evidence -----------------------------------------------
  messageLog(contextId: string): Artifact | undefined {
    const ctx = this.contexts.get(contextId); if (!ctx) return undefined;
    return { uri: `hostproto://context/${ctx.id}/dap-messages`, mediaType: 'application/x-ndjson', bytes: ctx.client.ndjson() };
  }
  recovery(contextId: string) {
    const ctx = this.contexts.get(contextId);
    if (!ctx) throw new HostProtoError('handle_expired', `unknown or expired context ${contextId}`, false, { context: contextId });
    const log = this.messageLog(contextId)!;
    const evidence = { schema_version: 'hostproto.evidence-ref/v1', ref: sha(log.bytes), surface_class: 'raw', media_type: log.mediaType, size_bytes: log.bytes.length, path: log.uri };
    const stale = [...ctx.surfaces].some(sid => { const s = this.surfaces.get(sid)!; return s.lifecycle === 'open' && !s.state.stopped; });
    // The debuggee is gone once any of: `terminated` seen, `exited` seen, the adapter process closed, or every thread exited.
    const gone = ctx.terminated || ctx.client.closed || ctx.exitCode !== null || [...ctx.surfaces].every(sid => this.surfaces.get(sid)!.lifecycle === 'terminated');
    const recovery = gone
      ? { schema_version: 'hostproto.recovery/v1', outcome: 'unrecoverable', cause: 'host_terminated', context: ctx.id, checkpoint: null, writer_epoch: ctx.writer.epoch, approval: null, evidence: [evidence] }
      : { schema_version: 'hostproto.recovery/v1', outcome: stale ? 'reobserve_required' : 'resumed', cause: stale ? 'stale_observation' : 'client_interrupted', context: ctx.id, checkpoint: null, writer_epoch: ctx.writer.epoch, approval: null, evidence: [evidence] };
    assertValid('recovery', recovery); this.exercised('recovery');
    return recovery;
  }
  async readSurfaceState(id: string) { const s = this.surfaces.get(id); if (!s) return undefined; const ctx = this.contexts.get(s.contextId); return ctx ? { ...(await this.state(ctx, s)), cursor: s.seq } : { lifecycle: s.lifecycle, revision: s.revision, cursor: s.seq }; }
  listSurfaces() { return [...this.surfaces.values()].filter(s => s.lifecycle === 'open').map(s => s.id); }

  capabilityProfile() {
    const cap = (name: string, availability: string, provider: string, semantics: string) => {
      const runs = this.ledger.get(name) ?? 0;
      return [name, { availability, provider, semantics, verification: runs > 0 ? 'runtime' : 'source-audit', ...(runs > 0 ? { runtime_executions: runs } : {}) }] as const;
    };
    const profile = {
      schema_version: 'hostproto.capability-profile/v1', profile: 'dap/v1',
      adapter: { kind: 'delve', variant: 'go', identity: this.adapterIdentity }, immutable_per_run: true,
      capabilities: Object.fromEntries([
        cap('context.launch', 'supported', 'host', 'normalized'), cap('context.close', 'supported', 'host', 'normalized'), cap('await', 'supported', 'host', 'normalized'), cap('recovery', 'supported', 'host', 'normalized'),
        ...PROJECTIONS.map(p => cap(`observe.${p}`, p === 'host_requests' ? 'unsupported' : 'supported', p === 'host_requests' || p === 'breakpoints' || p === 'output' ? 'host' : 'engine', p === 'state' || p === 'output' ? 'normalized' : 'exact')), // output: debuggee stdio rides the adapter's stdio, normalized here
        ...INTENT_FAMILY.map(k => cap(`act.${k}`, k === 'host_request.resolve' ? 'unsupported' : 'supported', k === 'host_request.resolve' ? 'host' : 'engine', k === 'host_request.resolve' ? 'none' : 'exact')), // dlv dap issues no reverse requests
        cap('act.step_back', this.adapterIdentity.supportsStepBack ? 'supported' : 'unsupported', 'engine', this.adapterIdentity.supportsStepBack ? 'exact' : 'none'),
        cap('act.restart_frame', this.adapterIdentity.supportsRestartFrame ? 'supported' : 'unsupported', 'engine', this.adapterIdentity.supportsRestartFrame ? 'exact' : 'none'),
      ]),
      intent_family: [...INTENT_FAMILY], projections: [...PROJECTIONS], assertable_fields: [...ASSERTABLE],
    };
    assertValid('capability-profile', profile);
    return profile;
  }
  async close() { for (const id of [...this.contexts.keys()]) await this.closeContext(id).catch(() => {}); }
}
