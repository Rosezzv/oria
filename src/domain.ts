import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { basename } from 'node:path';
import { parseDocument, stringify, type Document } from 'yaml';
import { z } from 'zod';

const require = createRequire(import.meta.url);
export const appVersion: string = (require('../package.json') as { version: string }).version;

export class OriaError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export const limits = {
  note: 2 * 1024 * 1024,
  file: 32 * 1024 * 1024,
  total: 256 * 1024 * 1024,
  manifest: 8 * 1024 * 1024,
  entries: 10_000,
};

export const manifestName = 'oria-manifest.json';
export const agentSchema = z.enum(['claude-code', 'codex', 'antigravity', 'grok-bot', 'unknown']);
export type Agent = z.infer<typeof agentSchema>;

export function agentFromConfig(value?: string): Agent {
  const parsed = agentSchema.safeParse(value);
  return parsed.success ? parsed.data : 'unknown';
}

export function digest(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const idSchema = z.uuid();
// enforce control/surrogate checks at runtime via refine()
// so MCP JSON Schema avoids emitting RE2-incompatible \p{Cs} regex patterns.
const label = (max: number) => z.string().trim().min(1).max(max)
  .refine(value => !/[\p{Cc}\p{Cs}\u2028\u2029]/u.test(value), 'Contains unsupported control or surrogate characters');
const title = label(240);
const project = label(240);
const type = label(64);
const sourceReference = label(2048);
const tags = z.array(label(64)).max(32).transform(values => [...new Set(values)]);
const body = z.string().max(limits.note).refine(value => !/[\0\p{Cs}]/u.test(value), 'Expected Markdown text');
const nonemptyBody = body.refine(value => value.trim().length > 0, 'Markdown body is empty');
const time = z.iso.datetime({ offset: true });
const limit = z.int().min(1).max(100).optional();

export const saveSchema = z.strictObject({
  title,
  body: nonemptyBody,
  project: project.optional(),
  project_hint: project.optional(),
  type: type.optional(),
  tags: tags.optional(),
  source_reference: sourceReference.optional(),
});

const revisionCheck = {
  id: idSchema,
  expected_revision: hashSchema.optional(),
  version: hashSchema.optional(),
};

const updateFields = {
  ...revisionCheck,
  title: title.optional(),
  body: body.optional(),
  append: nonemptyBody.optional(),
  patch: z.strictObject({ find: body.min(1), replace: body }).optional(),
  project: project.optional(),
  type: type.optional(),
  tags: tags.optional(),
  clear_source_reference: z.boolean().optional(),
};

export const updateSchema = z.strictObject({
  ...updateFields,
  source_reference: sourceReference.nullable().optional(),
});

// avoid nullable() -> anyOf:[string,null] in MCP tool JSON Schema.
export const mcpUpdateSchema = z.strictObject({
  ...updateFields,
  source_reference: sourceReference.optional(),
});

export const readSchema = z.strictObject({ id: idSchema, revision: hashSchema.optional() });
export const archiveSchema = z.strictObject(revisionCheck);
export const restoreSchema = z.strictObject({ ...revisionCheck, revision: hashSchema });
export const historySchema = z.strictObject({ id: idSchema, limit });
export const listSchema = z.strictObject({ project: project.optional(), limit });
export const searchSchema = z.strictObject({ query: label(240), project: project.optional(), limit });
export const updatesSchema = z.strictObject({
  action: z.enum(['status', 'check', 'enable', 'disable', 'snooze', 'ignore', 'guide']),
  channel: z.enum(['stable', 'preview']).optional(),
  days: z.int().min(1).max(90).optional(),
  version: label(64).optional(),
});

const metadataSchema = z.object({
  oria_format: z.literal(1).optional(),
  id: idSchema,
  title,
  project,
  type,
  created_at: time,
  updated_at: time,
  created_by: agentSchema,
  updated_by: agentSchema,
  tags,
  // accept explicit YAML null (e.g. source_reference: null) when parsing notes.
  source_reference: sourceReference.nullable().transform(value => value ?? undefined).optional(),
  archived_at: time.nullable().transform(value => value ?? undefined).optional(),
});

export type Metadata = z.infer<typeof metadataSchema>;
export type SaveInput = z.input<typeof saveSchema>;
export type UpdateInput = z.input<typeof updateSchema>;
export type ArchiveInput = z.input<typeof archiveSchema>;
export type RestoreInput = z.input<typeof restoreSchema>;

export function validate<S extends z.ZodType>(schema: S, value: unknown, label: string): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const field = result.error.issues[0]?.path.join('.');
    throw new OriaError('INVALID_INPUT', field ? 'Invalid ' + label + ' field ' + field : 'Invalid ' + label);
  }
  return result.data;
}

export function expectedRevision(input: { expected_revision?: string; version?: string }): string {
  const revision = input.expected_revision ?? input.version;
  if (!revision || (input.version !== undefined && input.version !== revision)) {
    throw new OriaError('INVALID_INPUT', 'Supply expected_revision with the current document hash');
  }
  return revision;
}

export function reviseBody(current: string, changes: Pick<UpdateInput, 'body' | 'append' | 'patch'>): string {
  const { body, append, patch } = changes;
  if ([body, append, patch].filter(value => value !== undefined).length > 1) {
    throw new OriaError('INVALID_INPUT', 'Choose one of body, append, or patch');
  }
  if (patch) {
    const first = current.indexOf(patch.find);
    if (first < 0 || current.indexOf(patch.find, first + 1) !== -1) {
      throw new OriaError('PATCH_CONFLICT', 'Patch source must match exactly once. Read the note and use a more specific passage.');
    }
    return current.slice(0, first) + patch.replace + current.slice(first + patch.find.length);
  }
  if (append === undefined) return body ?? current;
  if (!current) return append;
  const newline = current.includes('\r\n') ? '\r\n' : '\n';
  const existing = (current.match(/(?:\r?\n){1,2}$/)?.[0].match(/\n/g)?.length ?? 0) +
    (append.match(/^(?:\r?\n){1,2}/)?.[0].match(/\n/g)?.length ?? 0);
  return current + newline.repeat(Math.max(0, 2 - existing)) + append;
}

export function protectBody(previous: string, next: string, allowRewrite?: boolean): void {
  if (allowRewrite === true || previous === next) return;
  const contentLength = (value: string) => Array.from(value.replace(/\s/gu, '')).length;
  const before = contentLength(previous);
  const after = contentLength(next);
  if ((before > 0 && after === 0) || (before - after >= 100 && after < before * 0.7)) {
    throw new OriaError('SHORTENING_PROTECTED', 'The update would substantially shorten the document. ' +
      'Use append or a smaller patch, or authorize the rewrite explicitly through the CLI.');
  }
}

// block obvious high-confidence secrets/private keys before writing plaintext Markdown.
const secretPatterns: { kind: string; pattern: RegExp }[] = [
  { kind: 'PEM private key', pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { kind: 'GitHub token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { kind: 'AWS access key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: 'Anthropic API key', pattern: /\bsk-ant-(?:api\d{2}-)?[A-Za-z0-9_-]{20,}\b/ },
  { kind: 'OpenAI API key', pattern: /\bsk-proj-[A-Za-z0-9_-]{20,}\b|\bsk-[A-Za-z0-9]{32,}\b/ },
  { kind: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: 'Slack token', pattern: /\bxox[baprs]-[0-9]{10,}-[A-Za-z0-9-]{10,}\b/ },
  { kind: 'Stripe live key', pattern: /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}\b/ },
];

export function protectSecrets(values: (string | undefined)[], allowSecrets?: boolean): void {
  if (allowSecrets === true) return;
  for (const value of values) {
    if (!value) continue;
    for (const { kind, pattern } of secretPatterns) {
      if (pattern.test(value)) {
        throw new OriaError('SECRET_DETECTED', 'Content appears to contain a ' + kind +
          '. Redact secrets before saving, or pass --allow-secrets through the CLI if intentional.');
      }
    }
  }
}

export function isDeviceName(segment: string): boolean {
  const stem = segment.normalize('NFKC').split('.')[0]?.trimEnd() ?? '';
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$)$/i.test(stem);
}

function slug(value: string, maxBytes = 60): string {
  const clean = value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, '-').normalize('NFC');
  let result = '';
  for (const character of clean.replace(/^-|-$/g, '')) {
    if (Buffer.byteLength(result + character) > maxBytes) break;
    result += character;
  }
  return result.replace(/-$/g, '');
}

export function projectId(value: string | undefined, fallback = 'general'): string {
  if (value === undefined) return fallback;
  const normalized = value.normalize('NFKC').trim();
  if (/[\\/:<>"|?*\p{Cc}]/u.test(normalized) || /^\.+$/.test(normalized)) {
    throw new OriaError('UNSAFE_PATH', 'Project must be a name without path components');
  }
  const name = slug(normalized);
  if (!name) throw new OriaError('INVALID_INPUT', 'Project must include a letter or number');
  return isDeviceName(name) ? 'project-' + name : name;
}

// untrusted project_hint safely falls back on non-path-safe hints (e.g. "owner/repo")
// instead of aborting save, while explicit project arguments remain strictly validated.
export function safeProjectHint(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    return projectId(value);
  } catch (error) {
    if (error instanceof OriaError) return undefined;
    throw error;
  }
}

export function gitProject(workspace: string): string | undefined {
  const result = spawnSync('git', ['-C', workspace, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8', timeout: 2000, windowsHide: true,
  });
  if (result.status !== 0 || !result.stdout.trim()) return undefined;
  try {
    return projectId(basename(result.stdout.trim()));
  } catch (error) {
    if (error instanceof OriaError) return undefined;
    throw error;
  }
}

export function noteFilename(metadata: Metadata): string {
  const shortId = metadata.id.replaceAll('-', '').slice(0, 12);
  return ([metadata.created_by, slug(metadata.title) || 'note', shortId].join('-') + '.md').normalize('NFC');
}

export interface Note {
  relativePath: string;
  metadata: Metadata;
  body: string;
  version: string;
  size: number;
  frontmatter: Document;
}

const frontmatterStart = /^\uFEFF?---[ \t]*\r?\n/;
const frontmatterEnd = /^---[ \t]*(?:\r?\n|$)/m;
const managedMarker = /^\s*['"]?(?:oria_format|created_by|updated_by)['"]?\s*:/m;

export function parseNote(relativePath: string, bytes: Buffer): Note | undefined {
  const text = bytes.toString('utf8');
  const start = frontmatterStart.exec(text);
  if (!start) return undefined;
  const remainder = text.slice(start[0].length);
  const end = frontmatterEnd.exec(remainder);
  const header = end ? remainder.slice(0, end.index) : remainder;
  const marked = managedMarker.test(header);
  const invalidNote = () => new OriaError('INVALID_NOTE', 'Invalid ORIA Markdown at ' + relativePath);
  if (!end) {
    if (marked) throw invalidNote();
    return undefined;
  }

  const frontmatter = parseDocument(header, { schema: 'core', uniqueKeys: true });
  if (frontmatter.errors.length || frontmatter.warnings.length) {
    if (marked) throw invalidNote();
    return undefined;
  }
  let fields;
  try {
    fields = frontmatter.toJS({ maxAliasCount: 0 });
  } catch {
    if (marked) throw invalidNote();
    return undefined;
  }
  if (!fields || typeof fields !== 'object') return undefined;
  if (!Object.hasOwn(fields, 'oria_format') && !(Object.hasOwn(fields, 'id') && marked)) return undefined;

  const parsed = metadataSchema.safeParse(fields);
  if (!parsed.success || !Buffer.from(text).equals(bytes) || bytes.length > limits.note) throw invalidNote();
  const metadata = parsed.data;
  try {
    metadata.id = metadata.id.toLowerCase();
    metadata.project = projectId(metadata.project);
  } catch {
    throw invalidNote();
  }
  return {
    relativePath, metadata, body: remainder.slice(end.index + end[0].length),
    version: digest(bytes), size: bytes.length, frontmatter,
  };
}

export function encodeNote(metadata: Metadata, content: string, previous?: Note): Buffer {
  let yaml: string;
  if (previous) {
    const frontmatter = previous.frontmatter;
    for (const [key, value] of Object.entries(metadata)) {
      if (value === undefined) frontmatter.delete(key);
      else frontmatter.set(key, value);
    }
    if (metadata.source_reference === undefined) frontmatter.delete('source_reference');
    if (metadata.archived_at === undefined) frontmatter.delete('archived_at');
    yaml = frontmatter.toString({ lineWidth: 0 });
  } else {
    yaml = stringify(metadata, { lineWidth: 0 });
  }
  const bytes = Buffer.from('---\n' + yaml + '---\n' + content);
  if (bytes.length > limits.note) throw new OriaError('SIZE_LIMIT', 'Markdown document exceeds 2 MiB');
  return bytes;
}
