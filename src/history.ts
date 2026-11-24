import { hashSchema, idSchema, limits, OriaError, parseNote } from './domain.js';
import { portableKey, readChecked, type TreeEntry } from './filesystem.js';

const historyDirectory = '.oria-history';

export function isHistoryPath(path: string): boolean {
  return portableKey(path.split('/')[0]!) === '.ORIA-HISTORY';
}

export function historyPath(id: string, revision: string): string {
  return historyDirectory + '/' + id + '/' + revision + '.md';
}

type Snapshot = { id: string; revision: string; entry: TreeEntry };

export function historyEntries(tree: TreeEntry[]): Map<string, Snapshot> {
  const snapshots = new Map<string, Snapshot>();
  for (const entry of tree) {
    if (!isHistoryPath(entry.relativePath)) continue;

    const invalid = () => new OriaError('INVALID_HISTORY', 'Unexpected history path at ' + entry.relativePath);
    const [folder, id, file, ...extra] = entry.relativePath.split('/');
    if (folder !== historyDirectory || extra.length) throw invalid();
    if (id === undefined) {
      if (!entry.directory) throw invalid();
      continue;
    }
    if (id !== id.toLowerCase() || !idSchema.safeParse(id).success) throw invalid();
    if (file === undefined) {
      if (!entry.directory) throw invalid();
      continue;
    }
    const revision = file.slice(0, -3);
    if (entry.directory || !file.endsWith('.md') || !hashSchema.safeParse(revision).success ||
      entry.size > limits.note) throw invalid();
    snapshots.set(entry.relativePath, { id, revision, entry });
  }
  return snapshots;
}

export function readHistory(snapshot: Snapshot, bytes = readChecked(snapshot.entry.absolutePath, limits.note)) {
  const note = parseNote(snapshot.entry.relativePath, bytes);
  if (!note || note.metadata.id !== snapshot.id || note.version !== snapshot.revision) {
    throw new OriaError('INVALID_HISTORY', 'Snapshot does not match its document ID and hash at ' + snapshot.entry.relativePath);
  }
  return note;
}
