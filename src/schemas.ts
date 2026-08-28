// Validation against the pinned hostproto-semantics bundles. Nothing here
// restates a schema: every validator is compiled from the fetched bundle,
// and the tool definitions hand the same bundle objects to MCP verbatim.
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import AjvModule, { type ValidateFunction } from 'ajv/dist/2020.js';
import FormatsModule from 'ajv-formats';

// CJS packages under NodeNext: the class is module.exports or .default.
const Ajv2020 = ((AjvModule as unknown as { default?: unknown }).default ?? AjvModule) as new (opts: object) => import('ajv/dist/2020.js').default;
const addFormats = ((FormatsModule as unknown as { default?: unknown }).default ?? FormatsModule) as (ajv: unknown) => void;

const SCHEMA_DIR = fileURLToPath(new URL('../schemas/', import.meta.url));
const LOCK = JSON.parse(readFileSync(fileURLToPath(new URL('../hostproto-semantics.lock.json', import.meta.url)), 'utf8')) as {
  commit: string; sha256: Record<string, string>;
};

export type SchemaName = keyof typeof LOCK.sha256 & string;
export type JsonSchema = Record<string, unknown>;

const loaded = new Map<string, JsonSchema>();
export function bundle(name: string): JsonSchema {
  const cached = loaded.get(name);
  if (cached) return cached;
  const path = `${SCHEMA_DIR}${name}.json`;
  if (!existsSync(path)) throw new Error(`schema bundle missing: run \`npm run schemas\` (${name})`);
  const text = readFileSync(path, 'utf8');
  const digest = createHash('sha256').update(text).digest('hex');
  if (digest !== LOCK.sha256[name]) throw new Error(`schema bundle ${name} does not match the pinned digest`);
  const parsed = JSON.parse(text) as JsonSchema;
  loaded.set(name, parsed);
  return parsed;
}
export const pinnedCommit = LOCK.commit;

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const compiled = new Map<string, ValidateFunction>();
export function validator(name: string): ValidateFunction {
  const existing = compiled.get(name);
  if (existing) return existing;
  const fn = ajv.compile(bundle(name));
  compiled.set(name, fn);
  return fn;
}

/** Throw if `value` does not satisfy the named bundle. Used on every emitted object. */
export function assertValid(name: string, value: unknown): void {
  const fn = validator(name);
  if (!fn(value)) {
    const detail = (fn.errors ?? []).map(e => `${e.instancePath || '$'} ${e.message}`).join('; ');
    throw new Error(`emitted ${name} violates its schema: ${detail}`);
  }
}

/** `anyOf` of several bundles, `$defs` merged, for tool outputSchema. */
export function anyOf(...names: string[]): JsonSchema {
  const defs: Record<string, unknown> = {};
  const options = names.map(name => {
    const { $schema, $id, $defs, ...rest } = bundle(name);
    Object.assign(defs, $defs as object | undefined);
    return rest;
  });
  return { anyOf: options, ...(Object.keys(defs).length ? { $defs: defs } : {}) };
}

/** A bundle stripped of `$schema`/`$id` for embedding as an MCP tool schema. */
export function toolSchema(name: string): JsonSchema {
  const { $schema, $id, ...rest } = bundle(name);
  return rest;
}
