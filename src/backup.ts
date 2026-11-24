import { randomUUID } from 'node:crypto';
import { createWriteStream, closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, rmdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { crc32 } from 'node:zlib';
import * as yauzl from 'yauzl';
import * as yazl from 'yazl';
import { z } from 'zod';
import { digest, hashSchema, limits, manifestName, OriaError } from './domain.js';
import {
  checkDirectory, checkExternalFile, flushDirectory, portableKey, readChecked, stat, validatePath, walkTree, writeNewFile,
} from './filesystem.js';
import { historyEntries, isHistoryPath, readHistory } from './history.js';
import { loadNotes, type Vault } from './vault.js';
import { assertNoRecoveryCopies } from './replacement.js';

const recordSchema = z.discriminatedUnion('kind', [
  z.strictObject({ path: z.string(), kind: z.literal('directory') }),
  z.strictObject({ path: z.string(), kind: z.literal('file'), size: z.int().min(0).max(limits.file), sha256: hashSchema }),
]);

const manifestSchema = z.strictObject({
  format: z.literal('oria-vault'),
  version: z.union([z.literal(1), z.literal(2)]),
  exported_at: z.iso.datetime(),
  entries: z.array(recordSchema).max(limits.entries),
});

type RecordEntry = z.infer<typeof recordSchema>;
type Manifest = z.infer<typeof manifestSchema>;

function comparePaths(left: RecordEntry, right: RecordEntry): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function validateRecords(records: RecordEntry[]): void {
  const paths = new Map<string, RecordEntry>();
  for (const entry of records) {
    validatePath(entry.path);
    const key = portableKey(entry.path);
    if (paths.has(key)) throw new OriaError('UNSAFE_PATH', 'Duplicate or colliding path ' + entry.path);
    paths.set(key, entry);
  }
  for (const entry of records) {
    const separator = entry.path.lastIndexOf('/');
    if (separator < 0) continue;
    const parent = entry.path.slice(0, separator);
    const record = paths.get(portableKey(parent));
    if (record?.kind !== 'directory' || record.path !== parent) {
      throw new OriaError('INVALID_BACKUP', 'Missing matching directory entry for ' + entry.path);
    }
  }
}

function sameEntries(left: RecordEntry[], right: RecordEntry[], exactPaths = false): boolean {
  if (left.length !== right.length) return false;
  const pathKey = (entry: RecordEntry) => exactPaths ? entry.path : entry.path.normalize('NFC');
  const byPath = new Map(right.map(entry => [pathKey(entry), entry]));
  return left.every(entry => {
    const other = byPath.get(pathKey(entry));
    if (entry.kind === 'directory') return other?.kind === 'directory';
    return other?.kind === 'file' && other.size === entry.size && other.sha256 === entry.sha256;
  });
}

function snapshot(root: string, files?: Map<string, Buffer>): RecordEntry[] {
  let total = 0;
  const tree = walkTree(root, { forBackup: true });
  const entries = tree.map((entry): RecordEntry => {
    const { relativePath: path, absolutePath } = entry;
    if (entry.directory) return { path, kind: 'directory' };
    const bytes = readChecked(absolutePath, limits.file);
    total += bytes.length;
    if (total > limits.total) throw new OriaError('SIZE_LIMIT', 'Vault exceeds the 256 MiB backup limit');
    files?.set(path, bytes);
    return { path, kind: 'file', size: bytes.length, sha256: digest(bytes) };
  }).sort(comparePaths);
  if (files) {
    loadNotes(tree, entry => files.get(entry.relativePath)!);
    for (const snapshot of historyEntries(tree).values()) {
      readHistory(snapshot, files.get(snapshot.entry.relativePath)!);
    }
  }
  return entries;
}

export async function exportVault(vault: Vault) {
  const files = new Map<string, Buffer>();
  const entries = vault.transaction(() => {
    assertNoRecoveryCopies(vault.paths);
    return snapshot(vault.paths.library, files);
  });
  const manifest: Manifest = {
    format: 'oria-vault', version: 2, exported_at: new Date().toISOString(), entries,
  };
  const name = 'oria-' + manifest.exported_at.replaceAll(/[:.]/g, '-') + '-' + randomUUID() + '.zip';
  const stage = vault.paths.stage();
  try {
    const temporary = join(stage, 'backup.zip');
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2) + '\n'), manifestName, { mode: 0o100600 });
    for (const entry of entries) {
      if (entry.kind === 'directory') zip.addEmptyDirectory(entry.path, { mode: 0o40700 });
      else zip.addBuffer(files.get(entry.path)!, entry.path, { mode: 0o100600 });
    }
    const writing = pipeline(zip.outputStream, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
    zip.end();
    await writing;
    const fd = openSync(temporary, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const directory = vault.paths.internalDirectory('backups');
    const path = join(directory, name);
    vault.transaction(() => {
      if (stat(path)) throw new OriaError('CONFLICT', 'Backup path already exists');
      renameSync(temporary, path);
    });
    flushDirectory(directory);
    return { path, entries: entries.length, format_version: manifest.version };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function openBackup(path: string): Promise<yauzl.ZipFile> {
  return new Promise((done, fail) => {
    yauzl.open(path, { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true },
      (error, zip) => error || !zip ? fail(error ?? new Error('ZIP is unavailable')) : done(zip));
  });
}

async function readEntry(zip: yauzl.ZipFile, entry: yauzl.Entry, max: number): Promise<Buffer> {
  if (entry.uncompressedSize > max) throw new OriaError('SIZE_LIMIT', 'ZIP entry exceeds size limit');
  const stream = await new Promise<NodeJS.ReadableStream>((done, fail) => {
    zip.openReadStream(entry, (error, stream) => error || !stream ? fail(error ?? new Error('Missing stream')) : done(stream));
  });
  const chunks: Buffer[] = [];
  let count = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk);
    count += bytes.length;
    if (count > max || count > entry.uncompressedSize) {
      throw new OriaError('SIZE_LIMIT', 'ZIP entry exceeds declared size');
    }
    chunks.push(bytes);
  }
  const result = Buffer.concat(chunks, count);
  if (count !== entry.uncompressedSize || crc32(result) !== entry.crc32) {
    throw new OriaError('INVALID_BACKUP', 'ZIP checksum or length mismatch');
  }
  return result;
}

function entryKind(entry: yauzl.Entry): 'directory' | 'file' {
  const directory = entry.fileName.endsWith('/');
  const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
  const expectedMode = directory ? 0o040000 : 0o100000;
  const hasDosDirectoryFlag = (entry.externalFileAttributes & 0x10) !== 0;
  if ((mode !== 0 && mode !== expectedMode) || (!directory && hasDosDirectoryFlag) ||
    (entry.generalPurposeBitFlag & 1) !== 0) {
    throw new OriaError('UNSAFE_PATH', 'ZIP contains a link, special file, or encrypted entry');
  }
  return directory ? 'directory' : 'file';
}

async function extractBackup(backup: string, stagedLibrary: string): Promise<Manifest> {
  const info = checkExternalFile(backup);
  if (!info) throw new OriaError('NOT_FOUND', 'Backup ZIP file does not exist');
  if (info.size > limits.total + limits.manifest + 4 * 1024 * 1024) {
    throw new OriaError('SIZE_LIMIT', 'Backup ZIP exceeds size limit');
  }
  try {
    const zip = await openBackup(backup);
    try {
      return await validateZip(zip, stagedLibrary);
    } finally {
      zip.close();
    }
  } catch (error) {
    if (error instanceof OriaError) throw error;
    throw new OriaError('INVALID_BACKUP', 'Could not read or validate backup ZIP');
  }
}

async function validateZip(zip: yauzl.ZipFile, staging: string): Promise<Manifest> {
  if (zip.entryCount > limits.entries + 1) throw new OriaError('SIZE_LIMIT', 'ZIP exceeds 10,000 entries');
  const records: RecordEntry[] = [];
  const seen = new Set<string>();
  let manifest: Manifest | undefined;
  let total = 0;

  async function extract(entry: yauzl.Entry): Promise<void> {
    const kind = entryKind(entry);
    const path = kind === 'directory' ? entry.fileName.slice(0, -1) : entry.fileName;
    const key = portableKey(path);
    if (seen.has(key)) throw new OriaError('UNSAFE_PATH', 'Duplicate or colliding ZIP path');
    seen.add(key);
    if (seen.size > limits.entries + 1) throw new OriaError('SIZE_LIMIT', 'ZIP exceeds 10,000 entries');

    if (path === manifestName && kind === 'file') {
      const bytes = await readEntry(zip, entry, limits.manifest);
      const fields = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (fields?.format !== 'oria-vault' || ![1, 2].includes(fields?.version)) {
        throw new OriaError('UNSUPPORTED_FORMAT', 'Unsupported ORIA backup format or version');
      }
      const result = manifestSchema.safeParse(fields);
      if (!result.success) throw new OriaError('INVALID_BACKUP', 'Invalid ORIA manifest');
      manifest = result.data;
      validateRecords(manifest.entries);
      return;
    }

    validatePath(path);
    const destination = join(staging, ...path.split('/'));
    if (kind === 'directory') {
      await readEntry(zip, entry, 0);
      mkdirSync(destination, { recursive: true, mode: 0o700 });
      records.push({ path, kind });
      return;
    }
    total += entry.uncompressedSize;
    if (total > limits.total) throw new OriaError('SIZE_LIMIT', 'ZIP expands beyond the 256 MiB limit');
    const bytes = await readEntry(zip, entry, limits.file);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    writeNewFile(destination, bytes);
    records.push({ path, kind, size: bytes.length, sha256: digest(bytes) });
  }

  await new Promise<void>((done, fail) => {
    zip.on('error', fail);
    zip.once('end', done);
    zip.on('entry', (entry: yauzl.Entry) => {
      void extract(entry).then(() => zip.readEntry()).catch(fail);
    });
    zip.readEntry();
  });

  if (!manifest) throw new OriaError('INVALID_BACKUP', 'Missing ORIA backup manifest');
  validateRecords(records);
  if (!sameEntries(records, manifest.entries, true)) {
    throw new OriaError('INVALID_BACKUP', 'ZIP contents do not match the ORIA manifest');
  }
  const tree = walkTree(staging, { forBackup: true });
  if (manifest.version === 1 && tree.some(entry => isHistoryPath(entry.relativePath))) {
    throw new OriaError('INVALID_BACKUP', 'Backup format 1 uses the path reserved for ORIA history');
  }
  loadNotes(tree);
  for (const snapshot of historyEntries(tree).values()) readHistory(snapshot);
  for (const entry of tree.reverse()) {
    if (entry.directory) flushDirectory(entry.absolutePath);
  }
  flushDirectory(staging);
  return manifest;
}

export async function importVault(vault: Vault, backupPath: string) {
  const stage = vault.paths.stage();
  const stagedLibrary = join(stage, 'library');
  mkdirSync(stagedLibrary, { mode: 0o700 });
  try {
    const manifest = await extractBackup(resolve(backupPath), stagedLibrary);
    return vault.transaction(() => {
      assertNoRecoveryCopies(vault.paths);
      const library = vault.paths.library;
      const libraryExists = checkDirectory(library);
      const existing = snapshot(library);
      // only treat as unchanged when library already exists (not a fresh uninitialized vault).
      if (libraryExists && sameEntries(existing, manifest.entries) &&
        manifest.entries.every(entry => stat(join(library, ...entry.path.split('/'))))) {
        return { status: 'unchanged', entries: existing.length, format_version: manifest.version, index_status: 'rebuild_on_search' };
      }
      if (existing.length) {
        throw new OriaError('IMPORT_CONFLICT', 'Vault already contains different data. Restore into a new vault directory.');
      }
      // rmdir will fail if an external process has added any file since the scan.
      if (libraryExists) rmdirSync(library);
      renameSync(stagedLibrary, library);
      try {
        flushDirectory(vault.paths.root);
      } catch {
        // The namespace change already happened. Report that fact without
        // claiming the directory entry is durable across power loss.
        return { status: 'imported', entries: manifest.entries.length, format_version: manifest.version,
          index_status: 'rebuild_on_search', durability_warning: 'Could not flush the vault directory after publishing.' };
      }
      return { status: 'imported', entries: manifest.entries.length, format_version: manifest.version,
        index_status: 'rebuild_on_search' };
    });
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
