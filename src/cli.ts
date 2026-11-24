#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { exportVault, importVault } from './backup.js';
import { agentFromConfig, appVersion, gitProject, limits, OriaError } from './domain.js';
import { readExternalFile } from './filesystem.js';
import { Vault } from './vault.js';

const help = [
  'ORIA ' + appVersion + ' — Your AI changes. Your knowledge stays.',
  '',
  'oria init',
  'oria save --title TITLE [--project NAME] [--project-hint NAME] [--type TYPE] [--tag TAG ...] [--source REF] [--file FILE|-] [--allow-secrets]',
  'oria search QUERY [--project NAME] [--limit N]',
  'oria read ID [--revision HASH]',
  'oria update ID --expected-revision HASH [--file FILE|- | --append-file FILE|- | --patch-file FILE|-]',
  '            [--title TITLE] [--project NAME] [--type TYPE] [--tag TAG ...|--clear-tags]',
  '            [--source REF|--clear-source] [--allow-rewrite] [--allow-secrets]',
  'oria history ID [--limit N]',
  'oria restore ID --revision HASH --expected-revision HASH [--allow-rewrite] [--allow-secrets]',
  'oria list [--project NAME] [--limit N]',
  'oria archive ID --expected-revision HASH [--allow-secrets]',
  'oria export',
  'oria import BACKUP.zip',
  'oria mcp [--agent claude-code|codex|antigravity|grok-bot]',
  '',
  'Global options: --vault DIR, --agent claude-code|codex|antigravity|grok-bot, --json, --help, --version (without a command)',
  'Without --file, save reads Markdown piped into stdin.',
  'A patch file is JSON with one exact "find" string and one "replace" string.',
  'Vault selection: --vault DIR, ORIA_VAULT, ~/.oria/vault. Agent provenance: --agent, ORIA_AGENT, unknown.',
].join('\n');

const options = {
  vault: { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'string' },
  revision: { type: 'string' },
  'expected-revision': { type: 'string' },
  'allow-rewrite': { type: 'boolean' },
  'allow-secrets': { type: 'boolean' },
  title: { type: 'string' },
  project: { type: 'string' },
  'project-hint': { type: 'string' },
  type: { type: 'string' },
  tag: { type: 'string', multiple: true },
  source: { type: 'string' },
  file: { type: 'string' },
  'append-file': { type: 'string' },
  'patch-file': { type: 'string' },
  'clear-tags': { type: 'boolean' },
  'clear-source': { type: 'boolean' },
  limit: { type: 'string' },
  agent: { type: 'string' },
} as const;

const commandOptions: Record<string, string[]> = {
  init: [],
  save: ['title', 'project', 'project-hint', 'type', 'tag', 'source', 'file', 'allow-secrets'],
  search: ['project', 'limit'],
  read: ['revision'],
  update: ['version', 'expected-revision', 'allow-rewrite', 'allow-secrets', 'title', 'project', 'type', 'tag', 'source',
    'file', 'append-file', 'patch-file', 'clear-tags', 'clear-source'],
  list: ['project', 'limit'],
  archive: ['version', 'expected-revision', 'allow-secrets'],
  history: ['limit'],
  restore: ['revision', 'version', 'expected-revision', 'allow-rewrite', 'allow-secrets'],
  export: [],
  import: [],
  mcp: [],
};

const commandsWithArgument = new Set(['search', 'read', 'update', 'archive', 'import', 'history', 'restore']);

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new OriaError('INVALID_INPUT', 'Missing ' + name);
  return value;
}

async function markdown(file?: string): Promise<string> {
  let bytes: Buffer;
  if (file === '') throw new OriaError('INVALID_INPUT', 'File path is empty');
  if (file && file !== '-') {
    bytes = readExternalFile(file, limits.note);
  } else {
    if (process.stdin.isTTY) throw new OriaError('INVALID_INPUT', 'Use --file or pipe Markdown to stdin');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      const part = Buffer.from(chunk);
      size += part.length;
      if (size > limits.note) throw new OriaError('SIZE_LIMIT', 'Markdown exceeds 2 MiB');
      chunks.push(part);
    }
    bytes = Buffer.concat(chunks, size);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new OriaError('INVALID_INPUT', 'Markdown must use UTF-8');
  }
}

async function patchFile(file: string) {
  const content = await markdown(file);
  try {
    return JSON.parse(content);
  } catch {
    throw new OriaError('INVALID_INPUT', 'Patch file must be JSON with find and replace fields');
  }
}

type ListedDocument = ReturnType<Vault['list']>['documents'][number];

function documentLine(value: ListedDocument): string {
  // surface archived state clearly in human-readable CLI listings.
  const status = value.archived_at ? '\t[archived]' : '';
  return value.id + '\t' + value.project + '\t' + value.title + '\t' + value.path + '\t' +
    value.created_by + ' → ' + value.updated_by + status;
}

async function main(args: string[]) {
  // support both `oria --version` and `oria --json --version`.
  if (args.includes('--version') && args.every(arg => arg === '--version' || arg === '--json')) {
    console.log(args.includes('--json') ? JSON.stringify({ version: appVersion }) : appVersion);
    return;
  }
  const { values, positionals } = parseArgs({ args, options, allowPositionals: true });
  const [command, argument] = positionals;
  if (values.help || !command) {
    console.log(help);
    return;
  }
  if (!Object.hasOwn(commandOptions, command)) throw new OriaError('INVALID_INPUT', 'Unknown command ' + command);
  const expected = commandsWithArgument.has(command) ? 2 : 1;
  if (positionals.length !== expected) throw new OriaError('INVALID_INPUT', 'Wrong number of arguments. See oria --help.');
  const allowed = new Set(['vault', 'json', 'agent', ...commandOptions[command]!]);
  for (const option of Object.keys(values)) {
    if (!allowed.has(option)) throw new OriaError('INVALID_INPUT', '--' + option + ' is unavailable for ' + command);
  }
  const path = values.vault === undefined ? process.env.ORIA_VAULT || undefined : required(values.vault, '--vault DIR');
  // Grok Bot & CLI adapter provenance support:
  // accepts --agent or ORIA_AGENT, falling back to 'unknown' when unset or unrecognized.
  const agent = agentFromConfig(values.agent ?? process.env.ORIA_AGENT);

  if (command === 'mcp') {
    const { startMcp } = await import('./mcp.js');
    await startMcp(new Vault(path, agent));
    return;
  }

  const limit = values.limit === undefined ? undefined : /^\d+$/.test(values.limit) ? Number(values.limit) : NaN;
  const expectation = { expected_revision: values['expected-revision'], version: values.version };
  const writeOptions = { allowRewrite: values['allow-rewrite'], allowSecrets: values['allow-secrets'] };
  const output = (result: unknown, display: string) => console.log(values.json ? JSON.stringify(result) : display);
  const vault = new Vault(path, agent);
  switch (command) {
    case 'init': {
      const result = vault.init();
      output(result, result.vault);
      break;
    }
    case 'save': {
      const title = required(values.title, '--title TITLE');
      const result = vault.save({
        title, body: await markdown(values.file), project: values.project, project_hint: values['project-hint'],
        type: values.type, tags: values.tag, source_reference: values.source,
      }, values.project === undefined ? gitProject(process.cwd()) : undefined, { allowSecrets: values['allow-secrets'] });
      output(result, (result.created ? 'Saved ' : 'Already saved ') + documentLine(result.document));
      break;
    }
    case 'search': {
      const results = vault.search({ query: argument!, project: values.project, limit });
      output(results, results.length ? results.map(note => documentLine(note) + '\n  ' + note.snippet).join('\n') : 'No matches.');
      break;
    }
    case 'read': {
      const result = vault.read(argument!, values.revision);
      const source = result.source_reference ? '\nSource: ' + result.source_reference : '';
      output(result, documentLine(result) + '\nRevision: ' + result.revision + source + '\n\n' + result.body);
      break;
    }
    case 'update': {
      if (values['clear-tags'] && values.tag || values['clear-source'] && values.source !== undefined) {
        throw new OriaError('INVALID_INPUT', 'Choose either to set or clear tags and source');
      }
      const append = values['append-file'];
      const patch = values['patch-file'];
      if ([values.file, append, patch].filter(value => value !== undefined).length > 1) {
        throw new OriaError('INVALID_INPUT', 'Choose only one body edit option');
      }
      const result = vault.update({
        id: argument!, ...expectation, title: values.title, project: values.project, type: values.type,
        tags: values['clear-tags'] ? [] : values.tag,
        source_reference: values['clear-source'] ? null : values.source,
        body: values.file === undefined ? undefined : await markdown(values.file),
        append: append === undefined ? undefined : await markdown(append),
        patch: patch === undefined ? undefined : await patchFile(patch),
      }, writeOptions);
      output(result, 'Updated ' + documentLine(result) + '\nRevision: ' + result.revision);
      break;
    }
    case 'list': {
      const result = vault.list({ project: values.project, limit });
      const projects = result.projects.map(project => project.id + ' (' + project.count + ')').join(', ');
      const documents = result.documents.map(documentLine).join('\n');
      const warnings = result.warnings?.map(warning => 'Warning [' + warning.code + '] ' + warning.message).join('\n');
      output(result, 'Projects: ' + (projects || 'none') + '\nDocuments: ' + result.total +
        (documents ? '\n' + documents : '') + (warnings ? '\n' + warnings : ''));
      break;
    }
    case 'archive': {
      const result = vault.archive({ id: argument!, ...expectation }, writeOptions);
      output(result, 'Archived ' + documentLine(result) + '\nRevision: ' + result.revision);
      break;
    }
    case 'history': {
      const result = vault.history({ id: argument!, limit });
      const revisions = result.revisions.map(note =>
        note.revision + '\t' + note.updated_at + '\t' + note.updated_by + '\t' + note.title);
      output(result, (result.current_revision ? 'Current revision: ' + result.current_revision : 'Current note missing.') +
        '\nStored revisions: ' + result.total + (revisions.length ? '\n' + revisions.join('\n') : ''));
      break;
    }
    case 'restore': {
      const result = vault.restore({ id: argument!, revision: required(values.revision, '--revision HASH'),
        ...expectation }, writeOptions);
      output(result, 'Restored ' + documentLine(result) + '\nRevision: ' + result.revision);
      break;
    }
    case 'export': {
      const result = await exportVault(vault);
      output(result, result.path);
      break;
    }
    case 'import': {
      const result = await importVault(vault, argument!);
      const status = result.status === 'imported' ? 'Restored ' + result.entries + ' entries.' : 'Vault already matches the backup.';
      output(result, status + ' Search index will reconcile on the next search.' +
        (result.durability_warning ? '\nWarning: ' + result.durability_warning : ''));
      break;
    }
  }
}

const args = process.argv.slice(2);
main(args).catch(error => {
  const code = error instanceof OriaError ? error.code :
    typeof error?.code === 'string' ? error.code : 'UNEXPECTED_ERROR';
  const message = error instanceof Error ? error.message : 'ORIA operation failed';
  console.error(args.includes('--json') ? JSON.stringify({ error: { code, message } }) : 'ORIA [' + code + '] ' + message);
  process.exitCode = 1;
});
