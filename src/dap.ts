// A minimal Debug Adapter Protocol client over a child process on stdio.
// Content-Length framing, request/response correlation, events, and reverse
// requests (adapter → client) surfaced to the host. Every message in both
// directions is appended to a raw log: that log is the evidence surface of a
// debug session, as a screenshot is for a page.
import { spawn, type ChildProcess } from 'node:child_process';
import { connect, type Socket } from 'node:net';
import type { Writable } from 'node:stream';

export interface DapMessage { seq: number; type: 'request' | 'response' | 'event'; [k: string]: unknown }
export interface DapEvent extends DapMessage { type: 'event'; event: string; body?: Record<string, unknown> }
export interface DapRequest extends DapMessage { type: 'request'; command: string; arguments?: Record<string, unknown> }
export interface DapResponse extends DapMessage { type: 'response'; request_seq: number; success: boolean; command: string; message?: string; body?: Record<string, unknown> }

export class DapError extends Error {
  constructor(public readonly command: string, message: string, public readonly body?: Record<string, unknown>) { super(message); }
}
export class DapClosed extends Error {}

type Pending = { resolve: (r: DapResponse) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout };

export class DapClient {
  private seq = 0;
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<number, Pending>();
  private readonly eventListeners = new Set<(event: DapEvent) => void>();
  private readonly reverseListeners = new Set<(request: DapRequest) => void>();
  readonly log: Array<{ at: string; direction: 'in' | 'out'; message: DapMessage }> = [];
  closed = false;
  exitCode: number | null = null;
  private constructor(private readonly stream: Writable, private readonly child?: ChildProcess) {}

  /** An adapter that speaks DAP on its own stdio. */
  static spawn(command: string, args: string[], cwd?: string): DapClient {
    const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const client = new DapClient(child.stdin!, child);
    child.stdout!.on('data', (chunk: Buffer) => client.feed(chunk));
    child.stderr!.on('data', () => {});
    child.on('exit', code => { client.exitCode = code; client.close(); });
    child.on('error', () => client.close());
    return client;
  }
  /** An adapter that listens on TCP (Delve's `dlv dap`); `child` is the server process to reap on close. */
  static async connect(host: string, port: number, child?: ChildProcess): Promise<DapClient> {
    const socket: Socket = await new Promise((resolve, reject) => { const s = connect({ host, port }, () => resolve(s)); s.once('error', reject); });
    const client = new DapClient(socket, child);
    socket.on('data', (chunk: Buffer) => client.feed(chunk));
    socket.on('close', () => client.close());
    socket.on('error', () => client.close());
    child?.on('exit', code => { client.exitCode = code; client.close(); });
    return client;
  }

  onEvent(fn: (event: DapEvent) => void) { this.eventListeners.add(fn); return () => this.eventListeners.delete(fn); }
  onReverseRequest(fn: (request: DapRequest) => void) { this.reverseListeners.add(fn); return () => this.reverseListeners.delete(fn); }

  private feed(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString('ascii');
      const length = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1] ?? NaN);
      if (!Number.isFinite(length)) { this.buffer = this.buffer.subarray(headerEnd + 4); continue; }
      const start = headerEnd + 4;
      if (this.buffer.length < start + length) return;
      const body = this.buffer.subarray(start, start + length).toString('utf8');
      this.buffer = this.buffer.subarray(start + length);
      let message: DapMessage;
      try { message = JSON.parse(body) as DapMessage; } catch { continue; }
      this.log.push({ at: new Date().toISOString(), direction: 'in', message });
      this.dispatch(message);
    }
  }
  private dispatch(message: DapMessage) {
    if (message.type === 'response') {
      const response = message as DapResponse;
      const pending = this.pending.get(response.request_seq);
      if (!pending) return;
      this.pending.delete(response.request_seq); if (pending.timer) clearTimeout(pending.timer);
      if (response.success) pending.resolve(response);
      else pending.reject(new DapError(response.command, String(response.message ?? (response.body as { error?: { format?: string } } | undefined)?.error?.format ?? 'request failed'), response.body));
    } else if (message.type === 'event') {
      for (const fn of this.eventListeners) fn(message as DapEvent);
    } else if (message.type === 'request') {
      for (const fn of this.reverseListeners) fn(message as DapRequest);
    }
  }
  private write(message: DapMessage) {
    if (this.closed) throw new DapClosed('adapter process is gone');
    this.log.push({ at: new Date().toISOString(), direction: 'out', message });
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    this.stream.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]));
  }

  /** Send a request; resolves with the response body. `timeoutMs` rejects with DapTimeout — the request may still complete on the adapter. */
  request(command: string, args: Record<string, unknown> = {}, timeoutMs = 30000): Promise<Record<string, unknown>> {
    const seq = ++this.seq;
    return new Promise((resolve, reject) => {
      const pending: Pending = { resolve: r => resolve(r.body ?? {}), reject };
      pending.timer = setTimeout(() => { this.pending.delete(seq); reject(new DapTimeout(command, timeoutMs)); }, timeoutMs);
      this.pending.set(seq, pending);
      try { this.write({ seq, type: 'request', command, arguments: args }); } catch (error) { this.pending.delete(seq); clearTimeout(pending.timer); reject(error as Error); }
    });
  }
  /** Answer a reverse request. */
  respond(request: DapRequest, success: boolean, body?: Record<string, unknown>, message?: string) {
    this.write({ seq: ++this.seq, type: 'response', request_seq: request.seq, success, command: request.command, ...(body ? { body } : {}), ...(message ? { message } : {}) } as DapResponse);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) { if (p.timer) clearTimeout(p.timer); p.reject(new DapClosed('adapter process is gone')); }
    this.pending.clear();
    try { this.stream.end(); } catch { /* gone */ }
    setTimeout(() => { try { this.child?.kill(); } catch { /* gone */ } }, 500).unref();
  }
  ndjson(): Buffer { return Buffer.from(this.log.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8'); }
}
export class DapTimeout extends Error { constructor(public readonly command: string, ms: number) { super(`${command} exceeded ${ms}ms`); } }
