import { strict as assert } from 'node:assert';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync,
  truncateSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { ZipFile } from 'yazl';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const entrypoint = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const runFile = promisify(execFile);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'oria-test-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  return root;
}

function cli(vault, args, options = {}) {
  const result = spawnSync(process.execPath, [entrypoint, '--vault', vault, '--json', ...args], {
    encoding: 'utf8', ...options,
  });
  assert.ifError(result.error);
  if (result.status !== 0) return { failed: JSON.parse(result.stderr).error };
  return JSON.parse(result.stdout);
}

function succeeds(vault, args, options) {
  const result = cli(vault, args, options);
  assert.equal(result.failed, undefined, JSON.stringify(result.failed));
  return result;
}

function save(vault, title, body, ...options) {
  return succeeds(vault, ['save', '--title', title, ...options], { input: body }).document;
}

function repo(root) {
  const directory = join(root, 'Acme Product');
  mkdirSync(join(directory, 'nested'), { recursive: true });
  execFileSync('git', ['init', '-q', directory]);
  return directory;
}

test('CLI detects Git project, has General fallback, deduplicates, and searches across projects', t => {
  const root = fixture(t);
  const vault = join(root, 'vault');
  const repository = repo(root);
  succeeds(vault, ['init']);
  const fromGit = succeeds(vault, ['save', '--title', '中文方案', '--tag', '结构优化'], {
    cwd: join(repository, 'nested'), input: '# Fixture\n全文搜索与重复检测\n"open" AND (',
  });
  assert.equal(fromGit.document.project, 'acme-product');
  assert.equal(fromGit.document.created_by, 'unknown');
  assert.match(fromGit.document.path, /\/unknown-/);
  const again = succeeds(vault, ['save', '--title', '中文方案', '--project', 'ＡＣＭＥ product'], {
    input: '# Fixture\r\n全文搜索与重复检测\r\n"open" AND (\n',
  });
  assert.equal(again.created, false);
  assert.equal(again.document.id, fromGit.document.id);

  const general = succeeds(vault, ['save', '--title', 'General note'], { cwd: root, input: '全文搜索也支持中文' });
  assert.equal(general.document.project, 'general');
  assert.equal(succeeds(vault, ['search', '全文搜索']).length, 2);
  assert.equal(succeeds(vault, ['search', '全文']).length, 2);
  assert.equal(succeeds(vault, ['search', '全文搜', '--project', 'ACME PRODUCT'])[0].id, fromGit.document.id);
  assert.equal(succeeds(vault, ['search', '"open" AND ('])[0].id, fromGit.document.id);
  assert.equal(succeeds(vault, ['search', '结构优'])[0].snippet, '结构优化');
  assert.deepEqual(succeeds(vault, ['list']).projects, [
    { id: 'acme-product', count: 1 }, { id: 'general', count: 1 },
  ]);
  assert.equal(cli(vault, ['search', 'x', '--limit', '1e2']).failed.code, 'INVALID_INPUT');
});

test('search combines English, short Chinese and mixed trigrams across fields', t => {
  const vault = join(fixture(t), 'vault');
  const first = save(vault, 'Moonlight PLAN', '迁移方案已经确认。 Backup需要回滚，也支持 Cafe\u0301。', '--project', 'Release');
  const other = save(vault, 'Backup plan draft', '草案仍在审核。', '--project', 'Draft');
  const ids = (query, args = []) => succeeds(vault, ['search', query, ...args]).map(note => note.id);
  assert.deepEqual(new Set(ids('pLaN')), new Set([first.id, other.id]));
  assert.deepEqual(ids('回滚'), [first.id]);
  assert.deepEqual(ids('PLAN 回滚', ['--limit', '1']), [first.id]);
  assert.deepEqual(ids('迁移方案 backup PLAN'), [first.id]);
  assert.deepEqual(ids('backup需要'), [first.id]);
  assert.deepEqual(ids('Café'), [first.id]);
  assert.deepEqual(ids('回滚 PLAN', ['--project', 'Draft']), []);
  assert.match(succeeds(vault, ['search', 'PLAN 回滚'])[0].snippet, /回滚/);
});

test('stable IDs survive rename and move, manual changes invalidate versions, and archive preserves data', t => {
  const root = fixture(t);
  const vault = join(root, 'vault');
  const note = save(vault, 'Read me', 'old-index-key\n', '--project', 'Product', '--source', 'decision-42');
  assert.equal(succeeds(vault, ['search', 'old-index'])[0].id, note.id);
  const oldFile = join(vault, note.path);
  const relocated = join(vault, 'library', 'manual', 'read-me.md');
  mkdirSync(join(vault, 'library', 'manual'));
  renameSync(oldFile, relocated);
  assert.equal(succeeds(vault, ['read', note.id]).version, note.version);
  writeFileSync(relocated, readFileSync(relocated, 'utf8')
    .replace('---\n', '---\n# user comment\ncustom_property: retained\n')
    .replace('old-index-key', 'new-index-key'));
  assert.equal(cli(vault, ['update', note.id, '--version', note.version, '--title', 'Stale']).failed.code, 'VERSION_CONFLICT');
  const moved = succeeds(vault, ['read', note.id]);
  assert.equal(moved.path, 'library/manual/read-me.md');
  assert.equal(moved.project, 'product');
  assert.deepEqual(succeeds(vault, ['search', 'old-index']), []);
  assert.equal(succeeds(vault, ['search', 'new-index'])[0].path, moved.path);
  const updated = succeeds(vault, ['update', note.id, '--version', moved.version, '--title', 'Renamed title', '--clear-source']);
  assert.equal(updated.path, moved.path);
  assert.equal(updated.source_reference, undefined);
  assert.notEqual(updated.version, moved.version);
  assert.match(readFileSync(relocated, 'utf8'), /# user comment\ncustom_property: retained/);
  const archived = succeeds(vault, ['archive', note.id, '--version', updated.version]);
  assert.ok(archived.archived_at);
  assert.equal(succeeds(vault, ['read', note.id]).body, 'new-index-key\n');
  assert.equal(succeeds(vault, ['search', 'new-index'])[0].archived_at, archived.archived_at);
});

test('simultaneous writers cannot both commit the same version', async t => {
  const vault = join(fixture(t), 'vault');
  const note = save(vault, 'Concurrent note', 'start', '--project', 'Concurrency');
  const writers = ['Writer one', 'Writer two'].map(title => runFile(process.execPath, [
    entrypoint, '--vault', vault, '--json', 'update', note.id, '--expected-revision', note.revision, '--title', title,
  ]));
  const outcomes = await Promise.allSettled(writers);
  const winner = outcomes.find(item => item.status === 'fulfilled');
  const failed = outcomes.find(item => item.status === 'rejected');
  assert.ok(winner && failed);
  assert.equal(JSON.parse(failed.reason.stderr).error.code, 'VERSION_CONFLICT');
  assert.equal(succeeds(vault, ['read', note.id]).title, JSON.parse(winner.value.stdout).title);
  assert.equal(succeeds(vault, ['history', note.id]).total, 1);
});

test('append and exact patches keep untouched content, and an unexpected rewrite requires explicit authorization', t => {
  const root = fixture(t);
  const vault = join(root, 'vault');
  const original = '# Plan\r\n\r\n状态：待定\r\n' + '材料与背景需要完整保留。'.repeat(25) + '\r\n尾部\r\n';
  const note = save(vault, 'Long plan', original, '--project', 'Safety');
  const mutation = (expected, ...args) => ['update', note.id, '--expected-revision', expected, ...args];
  const read = () => succeeds(vault, ['read', note.id]);
  assert.equal(cli(vault, ['update', note.id, '--title', 'Missing hash']).failed.code, 'INVALID_INPUT');
  assert.equal(cli(vault, mutation(note.revision, '--file', '-'), { input: '简短摘要' }).failed.code, 'SHORTENING_PROTECTED');
  assert.equal(cli(vault, mutation(note.revision, '--file', '-'), { input: '   \n' }).failed.code, 'SHORTENING_PROTECTED');
  assert.equal(read().revision, note.revision);
  assert.equal(succeeds(vault, ['history', note.id]).total, 0);
  assert.equal(cli(vault, mutation(note.revision, '--patch-file', '-'), {
    input: JSON.stringify({ find: '需要完整保留', replace: '保留' }),
  }).failed.code, 'PATCH_CONFLICT');
  assert.equal(cli(vault, mutation(note.revision, '--patch-file', '-'), {
    input: JSON.stringify({ find: '已不存在的段落', replace: '新内容' }),
  }).failed.code, 'PATCH_CONFLICT');

  const patched = succeeds(vault, mutation(note.revision, '--patch-file', '-'), {
    input: JSON.stringify({ find: '状态：待定', replace: '状态：通过' }),
  });
  const afterPatch = original.replace('状态：待定', '状态：通过');
  assert.equal(read().body, afterPatch);
  const appended = succeeds(vault, mutation(patched.revision, '--append-file', '-'), { input: '追加一段。\r\n' });
  assert.equal(read().body, afterPatch + '\r\n追加一段。\r\n');
  assert.equal(cli(vault, mutation(patched.revision, '--append-file', '-'), { input: '过时信息' }).failed.code, 'VERSION_CONFLICT');
  assert.equal(cli(vault, mutation(appended.revision, '--patch-file', '-'), {
    input: JSON.stringify({ find: read().body, replace: 'only summary' }),
  }).failed.code, 'SHORTENING_PROTECTED');

  const rewritten = succeeds(vault, mutation(appended.revision, '--file', '-', '--allow-rewrite'), { input: '授权重写' });
  assert.equal(read().body, '授权重写');
  assert.equal(succeeds(vault, ['history', note.id]).total, 3);
  assert.equal(succeeds(vault, ['read', note.id, '--revision', note.revision]).body, original);
  const restored = succeeds(vault, ['restore', note.id, '--revision', note.revision,
    '--expected-revision', rewritten.revision]);
  assert.equal(read().body, original);
  assert.equal(restored.path, note.path);
  assert.notEqual(restored.revision, note.revision);
  assert.equal(succeeds(vault, ['read', note.id, '--revision', rewritten.revision]).body, '授权重写');
  assert.equal(cli(vault, ['restore', note.id, '--revision', rewritten.revision,
    '--expected-revision', restored.revision]).failed.code, 'SHORTENING_PROTECTED');
  assert.equal(cli(vault, ['restore', note.id, '--revision', rewritten.revision,
    '--expected-revision', appended.revision, '--allow-rewrite']).failed.code, 'VERSION_CONFLICT');
});

test('ZIP restores unchanged notes, attachments, empty directories, and a rebuilt index', t => {
  const root = fixture(t);
  const source = join(root, 'source');
  const target = join(root, 'target');
  const attachmentName = '附件 Cafe\u0301.bin';
  const note = save(source, '备份测试', '# Fixture\n跨电脑迁移这篇笔记\n[附件](../../attachments/' + attachmentName + ')',
    '--project', '知识资产', '--type', 'decision', '--tag', '迁移', '--source', 'fixture-42');
  const historical = succeeds(source, ['read', note.id]);
  const updated = succeeds(source, ['update', note.id, '--expected-revision', note.revision, '--title', '迁移后的标题']);
  const before = succeeds(source, ['read', note.id]);
  const attachmentDir = join(source, 'library', 'attachments');
  mkdirSync(join(attachmentDir, '空目录'), { recursive: true });
  const payload = Buffer.from([0, 17, 255, 42]);
  writeFileSync(join(attachmentDir, attachmentName), payload);
  succeeds(source, ['search', '跨电脑']);
  const backup = succeeds(source, ['export']);
  assert.match(backup.path, /\.zip$/);
  assert.equal(backup.format_version, 2);

  succeeds(target, ['init']);
  mkdirSync(join(target, 'library'));
  assert.equal(succeeds(target, ['import', backup.path]).status, 'imported');
  assert.deepEqual(succeeds(target, ['read', note.id]), before);
  assert.deepEqual(readFileSync(join(target, 'library', 'attachments', attachmentName)), payload);
  assert.deepEqual(readdirSync(join(target, 'library', 'attachments')).sort(), readdirSync(attachmentDir).sort());
  assert.equal(succeeds(target, ['read', note.id, '--revision', note.revision]).body, historical.body);
  assert.equal(succeeds(target, ['history', note.id]).total, 1);
  assert.deepEqual(succeeds(target, ['search', '备份测试']), []);
  assert.deepEqual(readdirSync(join(target, 'library', 'attachments', '空目录')), []);
  assert.deepEqual(readdirSync(join(target, '.oria')).sort(), ['staging', 'state.sqlite']);
  rmSync(join(target, '.oria', 'state.sqlite'));
  assert.equal(succeeds(target, ['search', '跨电脑'])[0].id, note.id);
  assert.equal(succeeds(target, ['import', backup.path]).status, 'unchanged');
  const changed = succeeds(target, ['update', note.id, '--expected-revision', updated.revision, '--title', 'Local edits']);
  assert.equal(cli(target, ['import', backup.path]).failed.code, 'IMPORT_CONFLICT');
  assert.equal(succeeds(target, ['read', note.id]).version, changed.version);
});

function zipFixture(path, entries, manifestChanges = {}, alter = bytes => bytes) {
  const zip = new ZipFile();
  const records = entries.map(({ path, body }) => body === undefined ? { path, kind: 'directory' } :
    { path, kind: 'file', size: body.length, sha256: sha256(body) });
  const collected = [];
  const finished = new Promise((done, fail) => {
    zip.outputStream.on('data', bytes => collected.push(bytes));
    zip.outputStream.on('error', fail);
    zip.outputStream.on('end', () => {
      try {
        writeFileSync(path, alter(Buffer.concat(collected)));
        done();
      } catch (error) {
        fail(error);
      }
    });
  });
  zip.addBuffer(Buffer.from(JSON.stringify({
    format: 'oria-vault', version: 1, exported_at: new Date().toISOString(), entries: records, ...manifestChanges,
  })), 'oria-manifest.json');
  for (const entry of entries) {
    if (entry.body === undefined) zip.addEmptyDirectory(entry.path);
    else zip.addBuffer(entry.body, entry.path, { mode: entry.mode ?? 0o100600 });
  }
  zip.end();
  return finished;
}

test('bad backups are rejected before publishing any library data', async t => {
  const root = fixture(t);
  const target = join(root, 'vault');
  const good = { path: 'plain.txt', body: Buffer.from('synthetic') };
  const zip = join(root, 'fixture.zip');
  await zipFixture(zip, [good], { version: 3 });
  assert.equal(cli(target, ['import', zip]).failed.code, 'UNSUPPORTED_FORMAT');
  await zipFixture(zip, [good], {
    entries: [{ path: good.path, kind: 'file', size: good.body.length, sha256: '0'.repeat(64) }],
  });
  assert.equal(cli(target, ['import', zip]).failed.code, 'INVALID_BACKUP');
  await zipFixture(zip, [good], {}, bytes => {
    const name = Buffer.from('plain.txt');
    let offset = bytes.indexOf(name);
    while (offset !== -1) {
      bytes.write('../xx.txt', offset, name.length, 'utf8');
      offset = bytes.indexOf(name, offset + name.length);
    }
    return bytes;
  });
  assert.ok(cli(target, ['import', zip]).failed);
  await zipFixture(zip, [good, { ...good, path: 'PLAIN.TXT' }]);
  assert.equal(cli(target, ['import', zip]).failed.code, 'UNSAFE_PATH');
  await zipFixture(zip, [{ ...good, path: 'Cafe\u0301.txt' }, { ...good, path: 'Café.txt' }]);
  assert.equal(cli(target, ['import', zip]).failed.code, 'UNSAFE_PATH');
  await zipFixture(zip, [{ ...good, mode: 0o120777 }]);
  assert.equal(cli(target, ['import', zip]).failed.code, 'UNSAFE_PATH');
  await zipFixture(zip, [{ ...good, path: 'CON.txt' }]);
  assert.equal(cli(target, ['import', zip]).failed.code, 'UNSAFE_PATH');
  assert.deepEqual(succeeds(target, ['list']).documents, []);
  assert.deepEqual(readdirSync(join(target, '.oria', 'staging')), []);
  assert.deepEqual(readdirSync(root).sort(), ['fixture.zip', 'vault']);
});

test('archives in format 1 still restore, and format 2 rejects snapshots with mismatched identities or digests', async t => {
  const root = fixture(t);
  const source = join(root, 'source');
  const target = join(root, 'vault');
  const note = save(source, 'Legacy', '用于旧格式恢复。', '--project', 'Legacy Test');
  const content = readFileSync(join(source, note.path));
  const zip = join(root, 'fixture.zip');
  await zipFixture(zip, [{ path: 'legacy.md', body: content }]);
  assert.equal(succeeds(target, ['import', zip]).format_version, 1);
  assert.equal(succeeds(target, ['search', '旧格式'])[0].path, 'library/legacy.md');
  assert.equal(succeeds(target, ['history', note.id]).total, 0);

  const invalid = join(root, 'invalid-target');
  const history = '.oria-history/' + note.id;
  await zipFixture(zip, [{ path: 'legacy.md', body: content }, { path: '.oria-history' },
    { path: history }, { path: history + '/' + '0'.repeat(64) + '.md', body: content }], { version: 2 });
  assert.equal(cli(invalid, ['import', zip]).failed.code, 'INVALID_HISTORY');
  assert.equal(existsSync(join(invalid, 'library')), false);
});

test('Unicode note moves and external edits retain UUID and exact pre-update bytes', t => {
  const vault = join(fixture(t), 'vault');
  const note = save(vault, 'Cafe\u0301 中文笔记', '原文', '--project', 'Cafe\u0301 书房');
  assert.equal(note.project, 'café-书房');
  assert.equal(note.path, note.path.normalize('NFC'));
  assert.match(note.path, /中文笔记/);
  const moved = join(vault, 'library', '改名 Cafe\u0301.md');
  renameSync(join(vault, note.path), moved);
  const manual = Buffer.concat([readFileSync(moved), Buffer.from('\n手动补充 Manual edit。')]);
  writeFileSync(moved, manual);
  assert.equal(cli(vault, ['update', note.id, '--expected-revision', note.revision, '--title', 'Stale']).failed.code, 'VERSION_CONFLICT');
  const latest = succeeds(vault, ['search', '补充 manual'])[0];
  assert.equal(latest.id, note.id);
  assert.equal(latest.revision, sha256(manual));
  succeeds(vault, ['update', note.id, '--expected-revision', latest.revision, '--title', 'Safe rename']);
  const previous = succeeds(vault, ['read', note.id, '--revision', latest.revision]);
  assert.deepEqual(readFileSync(join(vault, previous.path)), manual);
  assert.equal(succeeds(vault, ['list']).total, 1);
  assert.equal(succeeds(vault, ['search', 'manual 补充']).length, 1);
});

test('history capacity failures leave the live note untouched', t => {
  const vault = join(fixture(t), 'vault');
  const note = save(vault, 'Capacity', 'File must survive a failed write', '--project', 'Safety');
  const attachment = join(vault, 'library', 'large-fixture.bin');
  writeFileSync(attachment, '');
  truncateSync(attachment, 256 * 1024 * 1024 - readFileSync(join(vault, note.path)).length);
  assert.equal(cli(vault, ['update', note.id, '--expected-revision', note.revision, '--title', 'Overwrite']).failed.code, 'SIZE_LIMIT');
  assert.equal(succeeds(vault, ['read', note.id]).revision, note.revision);
  assert.equal(succeeds(vault, ['history', note.id]).total, 0);
});

test('project paths, symlinks and hard links cannot redirect vault access', t => {
  const root = fixture(t);
  const vault = join(root, 'vault');
  for (const project of ['../escape', 'C:\\escape', 'unsafe／path']) {
    assert.equal(cli(vault, ['save', '--title', 'Example', '--project', project], { input: 'test' }).failed.code, 'UNSAFE_PATH');
  }

  const outside = join(root, 'outside');
  mkdirSync(outside);
  const note = save(vault, 'Link safety', 'stay in vault', '--project', 'safe');
  const outsideFile = join(outside, 'safe.md');
  writeFileSync(outsideFile, 'outside sentinel');
  const attachment = join(vault, 'library', 'attachment.md');
  linkSync(outsideFile, attachment);
  assert.equal(cli(vault, ['export']).failed.code, 'UNSAFE_PATH');
  rmSync(attachment);

  if (process.platform !== 'win32') {
    symlinkSync(outside, join(vault, 'library', 'redirect'), 'dir');
    assert.equal(cli(vault, ['save', '--title', 'X', '--project', 'redirect'], { input: 'test' }).failed.code, 'UNSAFE_PATH');
    rmSync(join(vault, 'library', 'redirect'));
    symlinkSync(outsideFile, join(vault, '.oria', 'state.sqlite-journal'));
    assert.equal(cli(vault, ['read', note.id]).failed.code, 'UNSAFE_PATH');
    rmSync(join(vault, '.oria', 'state.sqlite-journal'));
  }
  assert.equal(succeeds(vault, ['read', note.id]).body, 'stay in vault');
  assert.equal(readFileSync(outsideFile, 'utf8'), 'outside sentinel');
});

async function mcp(t, vault, agent, workspace) {
  const client = new Client({ name: 'oria-tests', version: '1.0.0' }, {
    capabilities: workspace ? { roots: {} } : {},
  });
  if (workspace) {
    client.setRequestHandler(ListRootsRequestSchema, () => ({ roots: [{ uri: pathToFileURL(workspace).href }] }));
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entrypoint, '--vault', vault, 'mcp', ...agent ? ['--agent', agent] : []],
    stderr: 'pipe',
  });
  t.after(() => client.close());
  await client.connect(transport);
  return client;
}

async function tool(client, name, args) {
  const response = await client.callTool({ name: 'oria_' + name, arguments: args });
  assert.equal(response.isError, undefined, JSON.stringify(response.content));
  return response.structuredContent;
}

test('three MCP clients and CLI share one vault, using configured provenance and roots', async t => {
  const root = fixture(t);
  const vault = join(root, 'vault');
  const claude = await mcp(t, vault, 'claude-code', repo(root));
  const codex = await mcp(t, vault, 'codex');
  const unknown = await mcp(t, vault, 'unrecognized-host');
  const { tools } = await claude.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    'oria_archive', 'oria_history', 'oria_list', 'oria_read', 'oria_restore', 'oria_save', 'oria_search', 'oria_update',
  ]);

  const saved = (await tool(claude, 'save', {
    title: 'MCP document', body: 'Shared fixture phrase', source_reference: 'fixture-source',
  })).document;
  assert.equal(saved.project, 'acme-product');
  assert.equal(saved.created_by, 'claude-code');
  assert.match(saved.path, /\/claude-code-/);
  const found = (await tool(codex, 'search', { query: 'fixture phrase' })).matches[0];
  assert.equal(found.id, saved.id);
  assert.equal(found.source_reference, 'fixture-source');
  const read = await tool(codex, 'read', { id: found.id });
  assert.equal(read.body, 'Shared fixture phrase');
  const updated = await tool(codex, 'update', { id: read.id, expected_revision: read.revision, append: 'Updated fixture phrase' });
  assert.equal(updated.updated_by, 'codex');
  assert.equal(updated.created_by, 'claude-code');
  assert.equal(updated.path, saved.path);
  assert.deepEqual(await tool(claude, 'read', { id: read.id }), succeeds(vault, ['read', read.id]));
  const stale = await claude.callTool({
    name: 'oria_update', arguments: { id: read.id, version: read.version, title: 'Stale' },
  });
  assert.equal(stale.isError, true);
  assert.equal(stale.structuredContent.error.code, 'VERSION_CONFLICT');
  assert.equal((await tool(claude, 'history', { id: read.id })).revisions[0].revision, read.revision);
  assert.equal((await tool(codex, 'read', { id: read.id, revision: read.revision })).body, read.body);
  const modelRewrite = await codex.callTool({ name: 'oria_update', arguments: {
    id: read.id, expected_revision: updated.revision, body: '', allow_rewrite: true,
  } });
  assert.equal(modelRewrite.isError, true);
  const guarded = await codex.callTool({ name: 'oria_update', arguments: {
    id: read.id, expected_revision: updated.revision, body: '',
  } });
  assert.equal(guarded.structuredContent.error.code, 'SHORTENING_PROTECTED');
  const restored = await tool(claude, 'restore', { id: read.id, expected_revision: updated.revision, revision: read.revision });
  assert.equal(restored.updated_by, 'claude-code');
  assert.equal((await tool(codex, 'read', { id: read.id })).body, read.body);
  const fallback = (await tool(unknown, 'save', { title: 'Unknown host fixture', body: 'Unknown synthetic' })).document;
  assert.equal(fallback.project, 'general');
  assert.equal(fallback.created_by, 'unknown');
  const hinted = (await tool(codex, 'save', { title: 'Hinted fixture', body: 'context', project_hint: 'Project Hint' })).document;
  assert.equal(hinted.project, 'project-hint');
  const spoofed = await unknown.callTool({
    name: 'oria_save', arguments: { title: 'Spoofed source', body: 'text', created_by: 'claude-code' },
  });
  assert.equal(spoofed.isError, true);
  assert.equal((await tool(unknown, 'list', {})).total, 3);
});

test('single-file YAML error or duplicate ID does not brick healthy notes, while YAML null stays valid', t => {
  const vault = join(fixture(t), 'vault');
  const first = save(vault, 'Healthy One', 'alpha body', '--project', 'Core');
  const second = save(vault, 'Healthy Two', 'beta body', '--project', 'Core');

  // Explicit YAML null (e.g. source_reference: null) must parse cleanly.
  const firstPath = join(vault, first.path);
  writeFileSync(firstPath, readFileSync(firstPath, 'utf8').replace('tags: []\n', 'tags: []\nsource_reference: null\n'));
  const rereadFirst = succeeds(vault, ['read', first.id]);
  assert.equal(rereadFirst.source_reference, undefined);

  // Corrupt YAML in first note isolates warning without blocking second note.
  const validBytes = readFileSync(firstPath);
  writeFileSync(firstPath, validBytes.toString('utf8').replace('title: Healthy One', 'title: Broken: Unquoted: YAML'));
  assert.equal(succeeds(vault, ['read', second.id]).body, 'beta body');
  assert.equal(succeeds(vault, ['search', 'beta']).length, 1);
  const listedCorrupt = succeeds(vault, ['list']);
  assert.equal(listedCorrupt.total, 1);
  assert.equal(listedCorrupt.warnings?.[0]?.code, 'INVALID_NOTE');
  assert.equal(cli(vault, ['export']).failed.code, 'INVALID_NOTE');

  // Restore valid first note, then duplicate it (simulating Finder Cmd+D).
  writeFileSync(firstPath, validBytes);
  const duplicatePath = join(vault, 'library', 'copy-of-first.md');
  copyFileSync(firstPath, duplicatePath);
  assert.equal(succeeds(vault, ['read', second.id]).body, 'beta body');
  assert.equal(cli(vault, ['read', first.id]).failed.code, 'CONFLICT');
  assert.equal(cli(vault, ['update', first.id, '--expected-revision', rereadFirst.revision, '--title', 'Nope']).failed.code, 'CONFLICT');
  const listedDup = succeeds(vault, ['list']);
  assert.equal(listedDup.total, 1);
  assert.equal(listedDup.warnings?.[0]?.code, 'DUPLICATE_ID');
  assert.equal(cli(vault, ['export']).failed.code, 'CONFLICT');
});

test('MCP tool schemas avoid RE2-incompatible regexes and nullable anyOf, and clear_source_reference works', async t => {
  const vault = join(fixture(t), 'vault');
  const client = await mcp(t, vault, 'antigravity');
  const { tools } = await client.listTools();
  const serialized = JSON.stringify(tools);
  assert.equal(serialized.includes('\\p{'), false, 'MCP schemas must not emit \\p{...} regex escapes');
  assert.equal(serialized.includes('"anyOf"'), false, 'MCP schemas must not emit anyOf nullable unions');

  const saved = (await tool(client, 'save', {
    title: 'Schema check', body: 'Check source clearing', source_reference: 'https://example.com/spec',
  })).document;
  assert.equal(saved.source_reference, 'https://example.com/spec');
  const cleared = await tool(client, 'update', {
    id: saved.id, expected_revision: saved.revision, clear_source_reference: true,
  });
  assert.equal(cleared.source_reference, undefined);
  assert.equal((await tool(client, 'read', { id: saved.id })).source_reference, undefined);
  const badControl = await client.callTool({
    name: 'oria_save', arguments: { title: 'Bad\u0007Title', body: 'text' },
  });
  assert.equal(badControl.isError, true);
});

test('OS metadata files (.DS_Store, Icon\\r, ._*) are ignored across read, export, and import', t => {
  const root = fixture(t);
  const source = join(root, 'source');
  const target = join(root, 'target');
  const note = save(source, 'Finder test', 'macOS metadata safety', '--project', 'Mac');
  writeFileSync(join(source, 'library', '.DS_Store'), 'finder-meta-v1');
  writeFileSync(join(source, 'library', 'Icon\r'), '');
  writeFileSync(join(source, 'library', '._appledouble'), 'meta');
  assert.equal(succeeds(source, ['read', note.id]).body, 'macOS metadata safety');

  const exported = succeeds(source, ['export']);
  // Target has an empty library/ containing only Finder .DS_Store.
  succeeds(target, ['init']);
  mkdirSync(join(target, 'library'), { recursive: true });
  writeFileSync(join(target, 'library', '.DS_Store'), 'target-finder-meta');
  assert.equal(succeeds(target, ['import', exported.path]).status, 'imported');
  assert.equal(succeeds(target, ['read', note.id]).body, 'macOS metadata safety');

  // Finder writes a fresh .DS_Store inside restored library; idempotent re-import must stay unchanged.
  writeFileSync(join(target, 'library', '.DS_Store'), 'finder-meta-v2-changed');
  assert.equal(succeeds(target, ['import', exported.path]).status, 'unchanged');

  // Symlink named .DS_Store must still be rejected as UNSAFE_PATH.
  if (process.platform !== 'win32') {
    rmSync(join(target, 'library', '.DS_Store'));
    symlinkSync(join(root, 'outside-target'), join(target, 'library', '.DS_Store'));
    assert.equal(cli(target, ['list']).failed.code, 'UNSAFE_PATH');
  }
});

test('search snippets stay UTF-16 well-formed around emojis and NFD text', t => {
  const vault = join(fixture(t), 'vault');
  const body = '🚀'.repeat(60) + 'Cafe\u0301 关键决策' + '🚀'.repeat(60);
  save(vault, 'Emoji snippet', body, '--project', 'Unicode');
  const matches = succeeds(vault, ['search', '关键决策']);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].snippet.isWellFormed(), true);
  assert.match(matches[0].snippet, /关键决策/);
});

test('secret guard blocks obvious credentials by default, CLI can override, and MCP read/search carry untrusted-data framing', async t => {
  const root = fixture(t);
  const vault = join(root, 'vault');
  const fakeGh = 'ghp_' + 'A'.repeat(36);
  const fakePem = '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----';
  assert.equal(cli(vault, ['save', '--title', 'Leak'], { input: 'token: ' + fakeGh }).failed.code, 'SECRET_DETECTED');
  const allowed = succeeds(vault, ['save', '--title', 'Intentional fixture', '--allow-secrets'], { input: 'key: ' + fakePem });
  assert.equal(allowed.created, true);

  const client = await mcp(t, vault, 'antigravity', repo(root));
  const blocked = await client.callTool({
    name: 'oria_save', arguments: { title: 'MCP Leak', body: 'token=' + fakeGh },
  });
  assert.equal(blocked.isError, true);
  assert.equal(blocked.structuredContent.error.code, 'SECRET_DETECTED');
  const forbiddenFlag = await client.callTool({
    name: 'oria_save', arguments: { title: 'MCP Leak', body: 'token=' + fakeGh, allow_secrets: true },
  });
  assert.equal(forbiddenFlag.isError, true);

  // P2-6: untrusted project_hint with slash falls back safely to workspace repo project.
  const hinted = await tool(client, 'save', {
    title: 'Hint fallback', body: 'safe body content', project_hint: 'Rosezzv/oria',
  });
  assert.equal(hinted.document.project, 'acme-product');

  // P2-3: MCP read/search attach untrusted-data framing in content while keeping structuredContent exact.
  const readRaw = await client.callTool({ name: 'oria_read', arguments: { id: hinted.document.id } });
  assert.equal(readRaw.isError, undefined);
  assert.ok(readRaw.content.some(block => block.type === 'text' && block.text.includes('UNTRUSTED VAULT DATA')));
  const searchRaw = await client.callTool({ name: 'oria_search', arguments: { query: 'safe body' } });
  assert.equal(searchRaw.isError, undefined);
  assert.ok(searchRaw.content.some(block => block.type === 'text' && block.text.includes('UNTRUSTED VAULT DATA')));
});

test('save dedup respects archive/metadata, CLI displays archived status, external symlinks work, and empty restore reports imported', t => {
  const root = fixture(t);
  const vault = join(root, 'vault');
  const orig = succeeds(vault, ['save', '--title', 'Plan', '--project', 'ORIA', '--tag', 'v1'], { input: 'same body' }).document;
  // Adding a new tag creates a distinct save rather than silently dropping the tag, and flags similar_notes.
  const withNewTag = succeeds(vault, ['save', '--title', 'Plan', '--project', 'ORIA', '--tag', 'v2'], { input: 'same body' });
  assert.equal(withNewTag.created, true);
  assert.equal(withNewTag.similar_notes?.[0]?.id, orig.id);

  // Archived note is not deduplicated against, and CLI human output marks [archived].
  succeeds(vault, ['archive', orig.id, '--expected-revision', orig.revision]);
  const humanList = spawnSync(process.execPath, [entrypoint, '--vault', vault, 'list'], { encoding: 'utf8' });
  assert.equal(humanList.status, 0);
  assert.match(humanList.stdout, /\[archived\]/);

  // External symlinked --file and symlinked backup ZIP are accepted (vault-internal symlinks remain blocked).
  if (process.platform !== 'win32') {
    const realMd = join(root, 'real.md');
    writeFileSync(realMd, 'loaded via external symlink');
    const linkMd = join(root, 'link.md');
    symlinkSync(realMd, linkMd);
    const saved = succeeds(vault, ['save', '--title', 'From symlink', '--file', linkMd]);
    assert.equal(saved.created, true);

    const exported = succeeds(vault, ['export']);
    const linkZip = join(root, 'latest-backup.zip');
    symlinkSync(exported.path, linkZip);
    const restoredVault = join(root, 'restored');
    assert.equal(succeeds(restoredVault, ['import', linkZip]).status, 'imported');
  }

  // Empty backup imported into a brand-new vault reports imported, then unchanged on repeat.
  const emptySrc = join(root, 'empty-src');
  const emptyDst = join(root, 'empty-dst');
  succeeds(emptySrc, ['init']);
  const emptyZip = succeeds(emptySrc, ['export']);
  assert.equal(succeeds(emptyDst, ['import', emptyZip.path]).status, 'imported');
  assert.equal(succeeds(emptyDst, ['import', emptyZip.path]).status, 'unchanged');

  // --json --version outputs valid JSON matching package.json version.
  const expectedVersion = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')).version;
  const ver = spawnSync(process.execPath, [entrypoint, '--json', '--version'], { encoding: 'utf8' });
  assert.equal(ver.status, 0);
  assert.deepEqual(JSON.parse(ver.stdout), { version: expectedVersion });
});

// Grok Bot cross-agent compatibility acceptance test (simulated CLI/MCP).
test('Grok Bot shares the vault with Claude Code and Codex via local CLI and MCP with grok-bot provenance', async t => {
  const root = fixture(t);
  const vault = join(root, 'vault');
  const restored = join(root, 'restored');
  const claude = await mcp(t, vault, 'claude-code');
  const codex = await mcp(t, vault, 'codex');
  const grokMcp = await mcp(t, vault, 'grok-bot');

  // 1. Grok Bot saves via local CLI (--agent grok-bot) from a non-Git cwd with unsafe project_hint fallback to general.
  const grokSaved = succeeds(vault, [
    '--agent', 'grok-bot', 'save', '--title', 'Grok 调研结论', '--project-hint', 'owner/repo', '--type', 'research',
  ], { cwd: root, input: '# Grok 调研\n核心结论：本地 CLI 复用与回滚策略。' }).document;
  assert.equal(grokSaved.project, 'general');
  assert.equal(grokSaved.created_by, 'grok-bot');
  assert.equal(grokSaved.updated_by, 'grok-bot');
  assert.match(grokSaved.path, /\/grok-bot-/);

  // 2. Codex searches and reads the document created by Grok Bot.
  const codexMatches = (await tool(codex, 'search', { query: '回滚 Grok' })).matches;
  assert.equal(codexMatches.length, 1);
  assert.equal(codexMatches[0].id, grokSaved.id);
  const codexRead = await tool(codex, 'read', { id: grokSaved.id });
  assert.equal(codexRead.created_by, 'grok-bot');
  assert.match(codexRead.body, /本地 CLI 复用/);

  // 3. Claude Code creates a note; Grok Bot reads and updates it via local CLI preserving created_by and filename.
  const claudeSaved = (await tool(claude, 'save', {
    title: '跨 Agent 协作规范',
    project: 'ORIA',
    body: '# 规范\n状态：待 Grok 补充\n' + '保留现有核心安全机制。'.repeat(15),
  })).document;
  assert.equal(claudeSaved.created_by, 'claude-code');

  const grokFound = succeeds(vault, ['--agent', 'grok-bot', 'search', '协作规范']);
  assert.equal(grokFound[0].id, claudeSaved.id);
  const grokRead = succeeds(vault, ['--agent', 'grok-bot', 'read', claudeSaved.id]);
  const grokPatched = succeeds(vault, [
    '--agent', 'grok-bot', 'update', claudeSaved.id, '--expected-revision', grokRead.revision, '--patch-file', '-',
  ], { input: JSON.stringify({ find: '状态：待 Grok 补充', replace: '状态：Grok 已补充' }) });
  assert.equal(grokPatched.created_by, 'claude-code');
  assert.equal(grokPatched.updated_by, 'grok-bot');
  assert.equal(grokPatched.path, claudeSaved.path);

  // ORIA_AGENT env var also works for CLI provenance, and invalid values fall back to unknown.
  const envAppended = succeeds(vault, [
    'update', claudeSaved.id, '--expected-revision', grokPatched.revision, '--append-file', '-',
  ], { input: 'Grok 追加的结论。', env: { ...process.env, ORIA_AGENT: 'grok-bot' } });
  assert.equal(envAppended.updated_by, 'grok-bot');
  const claudeReadBack = await tool(claude, 'read', { id: claudeSaved.id });
  assert.equal(claudeReadBack.created_by, 'claude-code');
  assert.equal(claudeReadBack.updated_by, 'grok-bot');
  assert.match(claudeReadBack.body, /状态：Grok 已补充/);
  assert.match(claudeReadBack.body, /Grok 追加的结论/);

  // 4. Revision conflict, shortening protection, secret guard, invalid agent fallback, MCP grok-bot, and ZIP migration.
  assert.equal(cli(vault, ['--agent', 'grok-bot', 'update', claudeSaved.id, '--expected-revision', claudeSaved.revision, '--title', 'Stale']).failed.code, 'VERSION_CONFLICT');
  assert.equal(cli(vault, ['--agent', 'grok-bot', 'update', claudeSaved.id, '--expected-revision', envAppended.revision, '--file', '-'], { input: '太短' }).failed.code, 'SHORTENING_PROTECTED');
  assert.equal(cli(vault, ['--agent', 'grok-bot', 'save', '--title', 'Secret'], { input: 'ghp_' + 'Z'.repeat(36) }).failed.code, 'SECRET_DETECTED');
  const unknownFallback = succeeds(vault, ['--agent', 'invalid-bot', 'save', '--title', 'Fallback'], { input: 'safe' }).document;
  assert.equal(unknownFallback.created_by, 'unknown');

  const grokMcpSaved = (await tool(grokMcp, 'save', { title: 'Grok MCP note', body: 'stdio mcp works too' })).document;
  assert.equal(grokMcpSaved.created_by, 'grok-bot');

  const backup = succeeds(vault, ['export']);
  assert.equal(succeeds(restored, ['import', backup.path]).status, 'imported');
  assert.equal(succeeds(restored, ['read', claudeSaved.id]).updated_by, 'grok-bot');
  assert.equal(succeeds(restored, ['history', claudeSaved.id]).total, 2);
});
