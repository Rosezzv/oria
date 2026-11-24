// Recoverable note publication.
import { randomUUID } from 'node:crypto';
import { linkSync, readdirSync, renameSync, rmSync, rmdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { digest, hashSchema, limits, OriaError } from './domain.js';
import { checkDirectory, checkFile, flushDirectory, readChecked, stat, validatePath, type VaultPaths, writeNewFile } from './filesystem.js';

function sameFile(left: ReturnType<typeof stat>, right: ReturnType<typeof stat>): boolean {
  return !!left?.isFile() && !!right?.isFile() && left.dev === right.dev && left.ino === right.ino;
}

export function assertNoRecoveryCopies(paths: VaultPaths): void {
  const directory = paths.internalPath('recovered');
  if (checkDirectory(directory) && readdirSync(directory).length > 0) {
    throw new OriaError('RECOVERY_PENDING', 'Review and move the preserved files out of ' + directory +
      ' before exporting, so the backup does not omit recovered data.');
  }
}

// Called under the vault lock before any library scan, and after a failed publish.
export function settleReplacement(paths: VaultPaths): void {
  const active = paths.internalPath('replacement');
  if (!checkDirectory(active)) return;
  const record = join(active, 'record.json');
  const previous = join(active, 'previous.md');
  const next = join(active, 'next.md');
  const published = join(active, 'published');
  const original = stat(previous);
  const candidate = stat(next);
  if (!stat(record) && readdirSync(active).length === 0) {
    rmdirSync(active);
    return;
  }

  let operation: { path: string; expected?: string };
  try {
    operation = JSON.parse(readChecked(record, 2048).toString('utf8'));
    if (typeof operation.path !== 'string' ||
      (operation.expected !== undefined && !hashSchema.safeParse(operation.expected).success)) throw new Error();
    validatePath(operation.path);
  } catch {
    throw new OriaError('RECOVERY_PENDING', 'Could not validate the pending replacement in ' + active +
      '. The files have been preserved.');
  }
  for (const file of [original, candidate]) {
    if (file && (!file.isFile() || file.isSymbolicLink())) {
      throw new OriaError('RECOVERY_PENDING', 'Unexpected file in ' + active + '. The files have been preserved.');
    }
  }

  const committed = checkFile(published);
  if (original && committed) {
    // The directory entry was published before the marker. A later edit, move
    // or delete is independent of this transaction; check only the old inode.
    if (!matchesOriginal(previous, operation.expected)) {
      preserveConflict(paths, active, next, candidate?.nlink);
    }
  } else if (original) {
    let target: string | undefined;
    try {
      target = paths.pathInLibrary(operation.path);
    } catch (error) {
      if (!(error instanceof OriaError) || error.code !== 'NOT_FOUND') throw error;
    }
    const live = target ? stat(target) : undefined;
    if (sameFile(live, original)) {
      // A previous recovery already linked the original back before it stopped.
      flushDirectory(dirname(target!));
    } else if (sameFile(live, candidate)) {
      // The next transaction checks for writes via a still-open descriptor to the old inode.
      if (!matchesOriginal(previous, operation.expected)) {
        preserveConflict(paths, active, next, live?.nlink);
      }
      flushDirectory(dirname(target!));
    } else if (target && !live && (candidate?.nlink ?? 1) === 1) {
      // The replacement was interrupted before it published. Link back without clobbering a new external save.
      checkFile(previous);
      try {
        linkSync(previous, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        preserveConflict(paths, active, next, candidate?.nlink);
      }
      flushDirectory(dirname(target));
    } else {
      preserveConflict(paths, active, next, candidate?.nlink);
    }
  }
  if (original) {
    unlinkSync(previous);
    flushDirectory(active);
  }

  if (candidate) {
    // If a prior create was interrupted after linking, the directory entry must be
    // durable before the staging link is removed.
    if (!committed && candidate.nlink > 1) {
      try {
        flushDirectory(dirname(paths.pathInLibrary(operation.path)));
      } catch (error) {
        if (!(error instanceof OriaError) || error.code !== 'NOT_FOUND') throw error;
      }
    }
    unlinkSync(next);
  }
  if (committed) unlinkSync(published);
  unlinkSync(record);
  rmdirSync(active);
  flushDirectory(paths.internal);
}

function matchesOriginal(previous: string, expected?: string): boolean {
  try {
    return digest(readChecked(previous, limits.note)) === expected;
  } catch (error) {
    if (error instanceof OriaError) return false;
    throw error;
  }
}

function preserveConflict(paths: VaultPaths, active: string, next: string, candidateLinks?: number): never {
  const directory = paths.internalDirectory('recovered');
  const preserved = join(directory, 'oria-' + randomUUID());
  // A staged link to a live note must not leave the note hard-linked in the vault.
  if ((candidateLinks ?? 1) > 1) unlinkSync(next);
  renameSync(active, preserved);
  flushDirectory(directory);
  flushDirectory(paths.internal);
  throw new OriaError('RECOVERY_PENDING', 'An external edit collided with a replacement. ORIA preserved files in ' +
    preserved + '. Review the copies before trying another update or backup.');
}

export function publishNote(paths: VaultPaths, relativePath: string, bytes: Buffer, expected?: string): void {
  const target = paths.pathInLibrary(relativePath, expected === undefined);
  const active = paths.internalPath('replacement');
  const stage = paths.stage();
  try {
    writeNewFile(join(stage, 'next.md'), bytes);
    writeNewFile(join(stage, 'record.json'), Buffer.from(JSON.stringify({ path: relativePath, expected }) + '\n'));
    flushDirectory(stage);
    if (stat(active)) throw new OriaError('RECOVERY_PENDING', 'An earlier replacement needs recovery');
    renameSync(stage, active);
    flushDirectory(paths.internal);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }

  const previous = join(active, 'previous.md');
  try {
    if (expected !== undefined) {
      if (!checkFile(target)) throw new OriaError('VERSION_CONFLICT', 'Document disappeared before replacement');
      // Claim the actual directory entry first. An atomic external save just before
      // this move is validated on the claimed file instead of being overwritten.
      renameSync(target, previous);
      flushDirectory(dirname(target));
      flushDirectory(active);
      if (!matchesOriginal(previous, expected)) {
        throw new OriaError('VERSION_CONFLICT', 'An external edit changed the document during replacement.');
      }
    }
    linkSync(join(active, 'next.md'), target);
  } catch (error) {
    settleReplacement(paths);
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new OriaError('VERSION_CONFLICT', 'A file was written at the document path during publication.');
    }
    throw error;
  }

  flushDirectory(dirname(target));
  if (expected === undefined) {
    settleReplacement(paths);
  } else {
    // Keep the original inode until the next vault operation. If an editor
    // finishes writing through its old descriptor in that interval, preserve it.
    writeNewFile(join(active, 'published'), Buffer.alloc(0));
    flushDirectory(active);
    // The durable marker is enough to recover without referring to the live
    // pathname. Only the old inode needs retaining after a successful write.
    unlinkSync(join(active, 'next.md'));
    flushDirectory(active);
  }
}
