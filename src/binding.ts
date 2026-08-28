// The Delve binding: process and protocol facts only. Semantics live in
// hostproto-dap-core (docs/PROMISE.md there).
import { spawn, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { DapClient, HostProtoError, type EngineBinding, type StdioSink } from 'hostproto-dap-core';

export const DEFAULT_DLV = process.env.HOSTPROTO_DLV ?? path.join(homedir(), 'go', 'bin', 'dlv');

/** `dlv dap --listen 127.0.0.1:0` announces its port on stdout; everything after that on stdout/stderr is the debuggee's. */
async function startDlv(dlv: string, cwd: string): Promise<{ client: DapClient; stdio: (sink: StdioSink) => void }> {
  const child: ChildProcess = spawn(dlv, ['dap', '--listen', '127.0.0.1:0'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let sink: StdioSink = () => {}; let announced = false;
  const port = await new Promise<number>((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error('dlv dap did not announce its port')), 15000);
    child.stdout!.on('data', (chunk: Buffer) => {
      if (announced) { sink('stdout', chunk.toString()); return; }
      text += chunk.toString(); const m = /listening at: [^:\s]+:(\d+)\n/.exec(text);
      if (m) { clearTimeout(timer); announced = true; const rest = text.slice(m.index + m[0].length); if (rest) sink('stdout', rest); resolve(Number(m[1])); }
    });
    child.stderr!.on('data', (chunk: Buffer) => { if (announced) sink('stderr', chunk.toString()); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`dlv exited with ${code} before listening`)); });
    child.once('error', e => { clearTimeout(timer); reject(e); });
  });
  const client = await DapClient.connect('127.0.0.1', port, child);
  return { client, stdio: s => { sink = s; } };
}

export function delveBinding(dlv = DEFAULT_DLV): EngineBinding {
  return {
    kind: 'delve', variant: 'go', serverName: 'hostproto-dap-delve',
    launchDescription: 'mode=debug builds and launches in cwd (default; cwd must be the module directory), exec runs a binary, test runs the package tests.',
    launchSchema: { mode: { enum: ['debug', 'exec', 'test'] } },
    validate(p) { const mode = String(p.mode ?? 'debug'); if (!['debug', 'exec', 'test'].includes(mode)) throw new HostProtoError('capability_unsupported', 'mode must be debug, exec or test', false, { mode }); },
    start: cwd => startDlv(dlv, cwd),
    initializeArguments: () => ({ adapterID: 'go' }),
    // Delve builds inside `launch` (mode: debug); the response can take seconds on a cold cache.
    launchArguments: (p, program, cwd) => ({ request: 'launch', mode: String(p.mode ?? 'debug'), program, args: p.args ?? [], cwd, stopOnEntry: p.stop_on_entry ?? true }),
    identity: () => ({ dap: 'dlv dap', dlv }),
    // dlv dap issues no reverse requests.
    unsupported: ['act.host_request.resolve', 'observe.host_requests'],
    entryDeadlineMs: 30000,
  };
}
