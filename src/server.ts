// The MCP surface for dap/v1. Tool input and output schemas are the pinned
// bundles verbatim; results are `structuredContent`; the raw DAP message log
// and lossy observations are resources; surface state is subscribable.
import { McpServer, ResourceTemplate, fromJsonSchema, type CallToolResult } from '@modelcontextprotocol/server';
import { DelveHost, HostProtoError, PROJECTIONS, type Artifact } from './host.js';
import { anyOf, toolSchema, pinnedCommit, assertValid } from './schemas.js';

export const SERVER_INFO = { name: 'hostproto-dap-delve', version: '0.0.1' };
export const PROTOCOL_REVISION = '2026-07-28';
const stateUri = (surface: string) => `hostproto://surface/${surface}/state`;

export function createServer(host: DelveHost): McpServer {
  const server = new McpServer(SERVER_INFO, {
    capabilities: { tools: {}, resources: { subscribe: true, listChanged: true } },
    instructions: `HostProto dap/v1 adapter on Delve (Go). Schemas pinned to hostproto-semantics@${pinnedCommit.slice(0, 12)}. Launch a program (stops on entry), then observe/act/await on the thread surface. Frame, scope and variable targets are valid for one revision only; every stop or resume moves it.`,
  });
  const artifacts = new Map<string, Artifact>();
  host.onSurfaceChanged(surface => { void server.server.sendResourceUpdated({ uri: stateUri(surface) }).catch(() => {}); });

  const ok = (structuredContent: Record<string, unknown>, extra: CallToolResult['content'] = []): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(structuredContent) }, ...extra], structuredContent, isError: false });
  const fail = (error: unknown): CallToolResult => {
    const object = error instanceof HostProtoError ? error.toObject()
      : { schema_version: 'hostproto.error/v1', code: 'host_failed', message: String((error as Error).message ?? error).slice(0, 1024), host_invoked: true, data: {} };
    assertValid('error', object);
    return { content: [{ type: 'text', text: JSON.stringify(object) }], structuredContent: object, isError: true };
  };
  const run = async (fn: () => Promise<CallToolResult>) => { try { return await fn(); } catch (error) { return fail(error); } };
  const str = { type: 'string', minLength: 1 };

  server.registerTool('hostproto_context_create', {
    title: 'Launch a Go program under Delve',
    description: 'Mint host, context and surface handles for a Go program. mode=debug builds and launches (default), exec runs a binary, test runs the package tests. Stops on entry by default. Returns hostproto.handles/v1.',
    inputSchema: fromJsonSchema({ type: 'object', required: ['program'], additionalProperties: false, properties: {
      program: str, args: { type: 'array', items: { type: 'string' } }, cwd: { type: 'string' }, mode: { enum: ['debug', 'exec', 'test'] }, stop_on_entry: { type: 'boolean' },
      client: { type: 'object', properties: { id: { type: 'string' } } } } }),
    outputSchema: fromJsonSchema(anyOf('handles', 'error')),
  }, async (args) => run(async () => ok(await host.createContext(args as never))));

  server.registerTool('hostproto_context_close', {
    title: 'End a debug session', description: 'Disconnects, terminating the debuggee. Handles expire.',
    inputSchema: fromJsonSchema({ type: 'object', required: ['context'], additionalProperties: false, properties: { context: str } }),
  }, async (args) => run(async () => ok(await host.closeContext((args as { context: string }).context))));

  server.registerTool('hostproto_surface_observe', {
    title: 'Observe a thread',
    description: `Returns hostproto.observation/v1 with a revision and cursor. Projections: ${PROJECTIONS.join(', ')}. scopes needs a frame target; variables needs a scope or expandable variable target. frames/scopes/variables while running are omitted with a deviation, not lost.`,
    inputSchema: fromJsonSchema({ type: 'object', required: ['surface'], additionalProperties: false, properties: {
      surface: str, projections: { type: 'array', items: { enum: [...PROJECTIONS] }, minItems: 1 }, since: { type: 'integer', minimum: 0 }, max_bytes: { type: 'integer', minimum: 512 },
      target: toolSchema('target-ref') } }),
    outputSchema: fromJsonSchema(anyOf('observation', 'error')),
  }, async (args) => run(async () => {
    const { observation, artifacts: produced } = await host.observe(args as never);
    for (const a of produced) artifacts.set(a.uri, a);
    return ok(observation, produced.map(a => ({ type: 'resource_link' as const, uri: a.uri, name: a.uri.split('/').pop()!, mimeType: a.mediaType })));
  }));

  server.registerTool('hostproto_surface_act', {
    title: 'Act on a thread',
    description: 'Execute one hostproto.intent/v1 exactly once and return hostproto.receipt/v1. Kinds: set_breakpoints{source,lines}, step_over/step_in/step_out/continue/pause{deadline_ms}, evaluate{expression,context}+frame target, set_variable{value}+variable target, host_request.resolve{decision}+decision_token. A target from an earlier revision is rejected (target_invalidated) before anything is sent; declared preconditions likewise. A resume whose deadline elapses is outcome=unknown.',
    inputSchema: fromJsonSchema(toolSchema('intent')),
    outputSchema: fromJsonSchema(anyOf('receipt', 'error')),
  }, async (args) => run(async () => ok(await host.act(args as Record<string, unknown>))));

  server.registerTool('hostproto_surface_await', {
    title: 'Wait for a thread condition',
    description: 'Host-side wait over the recorded event stream. Conditions: stopped (bool), lifecycle, revision, event_kind, host_request (bool: a pending host request exists). deadline_exceeded reports the unsatisfied conditions.',
    inputSchema: fromJsonSchema({ type: 'object', required: ['surface', 'conditions'], additionalProperties: false, properties: {
      surface: str, deadline_ms: { type: 'integer', minimum: 1, maximum: 300000 },
      conditions: { type: 'array', minItems: 1, items: { type: 'object', required: ['kind', 'equals'], properties: { kind: { enum: ['stopped', 'lifecycle', 'revision', 'event_kind', 'host_request'] }, equals: {} } } } } }),
  }, async (args) => run(async () => ok(await host.await(args as never))));

  server.registerTool('hostproto_context_recovery', {
    title: 'Recovery state of a session', description: 'hostproto.recovery/v1 for the context, with the raw DAP message log as evidence. unrecoverable/host_terminated once the debuggee has exited.',
    inputSchema: fromJsonSchema({ type: 'object', required: ['context'], additionalProperties: false, properties: { context: str } }),
    outputSchema: fromJsonSchema(anyOf('recovery', 'error')),
  }, async (args) => run(async () => {
    const context = (args as { context: string }).context;
    const recovery = host.recovery(context);
    const log = host.messageLog(context)!; artifacts.set(log.uri, log);
    return ok(recovery, [{ type: 'resource_link', uri: log.uri, name: 'dap-messages.ndjson', mimeType: log.mediaType }]);
  }));

  server.registerTool('hostproto_capabilities', {
    title: 'Capability profile', description: 'hostproto.capability-profile/v1 for dap/v1. Availability comes from the adapter\'s initialize response; verification is runtime only for what this process executed.',
    inputSchema: fromJsonSchema({ type: 'object', additionalProperties: false }),
    outputSchema: fromJsonSchema(toolSchema('capability-profile')),
  }, async () => run(async () => ok(host.capabilityProfile())));

  server.registerResource('surface-state', new ResourceTemplate('hostproto://surface/{surface}/state', {
    list: async () => ({ resources: host.listSurfaces().map(id => ({ uri: stateUri(id), name: `thread ${id} state`, mimeType: 'application/json' })) }),
  }), { title: 'Thread state', description: 'Live stopped/reason/line/lifecycle/revision/cursor of a thread. Subscribe for change notifications.', mimeType: 'application/json' },
  async (uri, variables) => {
    const state = await host.readSurfaceState(String(variables.surface));
    if (!state) throw new HostProtoError('handle_expired', 'unknown surface', false);
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(state) }] };
  });
  server.registerResource('dap-messages', new ResourceTemplate('hostproto://context/{context}/dap-messages', { list: undefined }),
    { title: 'DAP message log', description: 'Every DAP message in both directions, newline-delimited JSON. The raw evidence surface of a session; content-addressed from recovery.', mimeType: 'application/x-ndjson' },
    async (uri, variables) => {
      const log = host.messageLog(String(variables.context));
      if (!log) throw new HostProtoError('handle_expired', 'unknown context', false);
      return { contents: [{ uri: uri.href, mimeType: log.mediaType, text: log.bytes.toString('utf8') }] };
    });
  server.registerResource('artifact', new ResourceTemplate('hostproto://surface/{surface}/{kind}/{name}', { list: undefined }),
    { title: 'Evidence artifact', description: 'Raw copies of lossy observations, content-addressed in the observation that produced them.' },
    async (uri) => {
      const artifact = artifacts.get(uri.href);
      if (!artifact) throw new HostProtoError('handle_expired', 'unknown artifact', false);
      return { contents: [{ uri: uri.href, mimeType: artifact.mediaType, text: artifact.bytes.toString('utf8') }] };
    });
  return server;
}
