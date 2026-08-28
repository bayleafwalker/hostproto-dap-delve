// Record one real debugger session (Delve) as an NDJSON envelope log for an EvidenceSet consumer.
// Usage: npx tsx scripts/record-session.mts <out.ndjson>
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const out = process.argv[2]; if (!out) throw new Error('usage: record-session <out.ndjson>');
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = 'main.go';
const transport = new StdioClientTransport({ command: 'npx', args: ['tsx', 'src/stdio.ts'], cwd: ROOT, stderr: 'pipe' });
const client = new Client({ name: 'vuoro-evidence-recorder', version: '0.0.1' });
client.setVersionNegotiation({ mode: { pin: '2026-07-28' } });
await client.connect(transport);

const lines: string[] = []; let seq = 0;
const call = async (tool: string, args: Record<string, unknown> = {}) => {
  const r = await client.callTool({ name: tool, arguments: args });
  const sc = r.structuredContent as any;
  lines.push(JSON.stringify({ seq: seq++, at: new Date().toISOString(), tool, args, is_error: !!r.isError, structured: sc }));
  return sc;
};
const intent = (surface: string, action_id: string, kind: string, extra: Record<string, unknown> = {}) =>
  ({ schema_version: 'hostproto.intent/v1', action_id, surface, kind, ...extra });

// Lane A: a breakpoint session on program.py — completed effects, a stale target, a precondition refusal.
const p = await call('hostproto_context_create', { program: '.', cwd: ROOT + 'fixtures/program', client: { id: 'vuoro-evidence-recorder' } });
const s1 = p.surface.id;
await call('hostproto_surface_act', intent(s1, 'a-bp', 'set_breakpoints', { params: { source: SRC, lines: [21] }, declared_effects: ['breakpoints_replaced_for_source'] }));
await call('hostproto_surface_act', intent(s1, 'a-continue', 'continue', { preconditions: { schema_version: 'hostproto.precondition/v1', surface: s1, assertions: [{ field: 'stopped', equals: true }] }, declared_effects: ['revision_advance', 'stopped:breakpoint'] }));
const f = await call('hostproto_surface_observe', { surface: s1, projections: ['state', 'frames'] });
const frame = f.data.frames[0];
await call('hostproto_surface_act', intent(s1, 'a-step', 'step_over', { declared_effects: ['revision_advance', 'stopped:step'] }));
await call('hostproto_surface_act', intent(s1, 'a-eval-stale', 'evaluate', { target: frame, params: { expression: '1' } }));
await call('hostproto_surface_act', intent(s1, 'a-precondition', 'step_in', { preconditions: { schema_version: 'hostproto.precondition/v1', surface: s1, assertions: [{ field: 'stopped', equals: false }] } }));
await call('hostproto_context_close', { context: p.context.id });

// Lane B: spin.py — a continue that never stops within its deadline is outcome=unknown; pause reconciles it.
const h = await call('hostproto_context_create', { program: '.', cwd: ROOT + 'fixtures/spin', client: { id: 'vuoro-evidence-recorder' } });
const s2 = h.surface.id;
await call('hostproto_surface_act', intent(s2, 'a-continue-unknown', 'continue', { params: { deadline_ms: 300 }, declared_effects: ['revision_advance'] }));
await call('hostproto_surface_observe', { surface: s2, projections: ['state', 'frames'] });
await call('hostproto_surface_act', intent(s2, 'a-pause', 'pause'));
await call('hostproto_surface_observe', { surface: s2, projections: ['state'] });
await call('hostproto_context_close', { context: h.context.id });
await client.close();
await writeFile(out, lines.join('\n') + '\n');
console.log(`${lines.length} calls -> ${out}`);
