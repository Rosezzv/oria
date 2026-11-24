import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync,
  openSync, readdirSync, readSync, realpathSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, parse } from 'node:path';
import { isDeviceName, limits, manifestName, OriaError } from './domain.js';

export function portableKey(relativePath: string): string {
  return relativePath.normalize('NFC').toUpperCase().normalize('NFC');
}

export function validatePath(relativePath: string): void {
  const segments = relativePath.normalize('NFC').split('/');
  const rootName = portableKey(segments[0] ?? '');
  if (rootName === '.ORIA' || rootName === portableKey(manifestName) || segments.length > 32 ||
      Buffer.byteLength(relativePath) > 220 ||
      segments.some(segment => !segment || segment === '.' || segment === '..' ||
        Buffer.byteLength(segment) > 120 || /[\\:<>"|?*\p{Cc}\p{Cs}]/u.test(segment) ||
        /[ .]$/.test(segment) || isDeviceName(segment))) {
    throw new OriaError('UNSAFE_PATH', 'Invalid portable path ' + JSON.stringify(relativePath));
  }
}

export function stat(path: string) {
  return lstatSync(path, { throwIfNoEntry: false });
}

export function checkDirectory(path: string, create = false): boolean {
  const existing = stat(path);
  if (!existing && create) {
    try {
      mkdirSync(path, { mode: 0o700 });
      flushDirectory(dirname(path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    return checkDirectory(path);
  }
  if (!existing) return false;
  if (!existing.isDirectory() || existing.isSymbolicLink()) {
    throw new OriaError('UNSAFE_PATH', 'Expected a real directory at ' + path);
  }
  return true;
}

function ensureDirectory(path: string): void {
  if (!checkDirectory(path, true)) throw new OriaError('CONFLICT', 'Directory changed at ' + path);
}

export function checkFile(path: string): boolean {
  const existing = stat(path);
  if (!existing) return false;
  if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1) {
    throw new OriaError('UNSAFE_PATH', 'Expected a regular file without links at ' + path);
  }
  return true;
}

// allow symlinks/hardlinks for explicit external CLI input files
// (such as --file or backup ZIP paths) while keeping vault-internal checks strict.
export function checkExternalFile(path: string): ReturnType<typeof statSync> | undefined {
  const existing = statSync(path, { throwIfNoEntry: false });
  if (!existing) return undefined;
  if (!existing.isFile()) {
    throw new OriaError('UNSAFE_PATH', 'Expected a regular file at ' + path);
  }
  return existing;
}

export interface TreeEntry {
  relativePath: string;
  absolutePath: string;
  directory: boolean;
  size: number;
}

export function walkTree(root: string, options: { forBackup?: boolean } = {}): TreeEntry[] {
  const entries: TreeEntry[] = [];
  const seen = new Set<string>();
  if (!checkDirectory(root)) return entries;

  function visit(parent: string, prefix: string): void {
    for (const name of readdirSync(parent).sort()) {
      const relativePath = prefix + name;
      const absolutePath = join(parent, name);
      const info = stat(absolutePath);
      if (!info || info.isSymbolicLink() || !(info.isDirectory() || (info.isFile() && info.nlink === 1))) {
        throw new OriaError('UNSAFE_PATH', 'Unexpected file type at ' + relativePath);
      }
      // A Finder icon has a non-portable name. Only ordinary note scans skip it.
      // Backups must report it rather than claiming to include all library files.
      if (!options.forBackup && info.isFile() && name === 'Icon\r') continue;
      validatePath(relativePath);
      const key = portableKey(relativePath);
      if (seen.has(key)) throw new OriaError('UNSAFE_PATH', 'Path collision at ' + relativePath);
      seen.add(key);
      if (seen.size > limits.entries) throw new OriaError('SIZE_LIMIT', 'Vault exceeds 10,000 entries');

      entries.push({ relativePath, absolutePath, directory: info.isDirectory(), size: info.isDirectory() ? 0 : info.size });
      if (info.isDirectory()) visit(absolutePath, relativePath + '/');
    }
  }
  visit(root, '');
  return entries;
}

export function readChecked(path: string, maxBytes: number): Buffer {
  if (!checkFile(path)) throw new OriaError('CONFLICT', 'File disappeared at ' + path);
  return readFdChecked(path, maxBytes, true);
}

// read user-supplied external CLI input files while following symlinks.
export function readExternalFile(path: string, maxBytes: number): Buffer {
  if (!checkExternalFile(path)) throw new OriaError('NOT_FOUND', 'File does not exist at ' + path);
  return readFdChecked(path, maxBytes, false);
}

function readFdChecked(path: string, maxBytes: number, strictLinks: boolean): Buffer {
  const flags = constants.O_RDONLY | (strictLinks ? (constants.O_NOFOLLOW ?? 0) : 0) | (constants.O_NONBLOCK ?? 0);
  const fd = openSync(path, flags);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || (strictLinks && before.nlink !== 1n)) {
      throw new OriaError('UNSAFE_PATH', 'Unexpected file type at ' + path);
    }
    if (before.size > BigInt(maxBytes)) throw new OriaError('SIZE_LIMIT', 'File exceeds size limit at ' + path);
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = readSync(fd, bytes, length, bytes.length - length, null);
      if (read === 0) break;
      length += read;
    }
    const after = fstatSync(fd, { bigint: true });
    if (BigInt(length) !== before.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new OriaError('CONFLICT', 'File changed while reading ' + path);
    }
    return bytes.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}

export function flushDirectory(path: string): void {
  if (process.platform === 'win32') return;
  const fd = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try {
    fsyncSync(fd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EINVAL' && code !== 'ENOTSUP') throw error;
  } finally {
    closeSync(fd);
  }
}

export function writeNewFile(path: string, bytes: Uint8Array): void {
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export class VaultPaths {
  readonly root: string;
  readonly library: string;
  readonly internal: string;

  constructor(configuredPath?: string) {
    const requested = resolve(configuredPath ?? join(homedir(), '.oria', 'vault'));
    if (requested === parse(requested).root) {
      throw new OriaError('UNSAFE_PATH', 'Vault cannot be the filesystem root');
    }
    mkdirSync(dirname(requested), { recursive: true, mode: 0o700 });
    ensureDirectory(requested);
    this.root = realpathSync(requested);
    this.library = join(this.root, 'library');
    this.internal = join(this.root, '.oria');
    ensureDirectory(this.internal);
    checkDirectory(this.library);
  }

  private verifyRoot(): void {
    if (!checkDirectory(this.root) || realpathSync(this.root) !== this.root) {
      throw new OriaError('UNSAFE_PATH', 'Vault directory changed');
    }
  }

  internalPath(name: string): string {
    this.verifyRoot();
    ensureDirectory(this.internal);
    return join(this.internal, name);
  }

  internalDirectory(name: 'backups' | 'staging' | 'recovered'): string {
    const path = this.internalPath(name);
    ensureDirectory(path);
    return path;
  }

  database(name: 'state' | 'coordination'): string {
    const path = this.internalPath(name + '.sqlite');
    for (const suffix of ['', '-journal', '-wal', '-shm']) checkFile(path + suffix);
    return path;
  }

  pathInLibrary(relativePath: string, createParents = false): string {
    validatePath(relativePath);
    this.verifyRoot();
    const segments = relativePath.split('/');
    let path = this.library;
    if (!checkDirectory(path, createParents)) throw new OriaError('NOT_FOUND', 'Library does not exist');
    for (const segment of segments.slice(0, -1)) {
      path = join(path, segment);
      if (!checkDirectory(path, createParents)) throw new OriaError('NOT_FOUND', 'Library directory changed');
    }
    return join(path, segments.at(-1)!);
  }

  stage(): string {
    return mkdtempSync(join(this.internalDirectory('staging'), 'oria-'));
  }

}
