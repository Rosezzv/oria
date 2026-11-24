import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  type Agent, type ArchiveInput, type Metadata, type Note, type RestoreInput, type SaveInput, type UpdateInput,
  OriaError, archiveSchema, digest, encodeNote, expectedRevision, historySchema, limits, listSchema, noteFilename,
  parseNote, projectId, protectBody, protectSecrets, readSchema, restoreSchema, reviseBody, safeProjectHint,
  saveSchema, searchSchema, updateSchema, validate,
} from './domain.js';
import { type TreeEntry, VaultPaths, checkFile, flushDirectory, portableKey, readChecked, validatePath, walkTree } from './filesystem.js';
import { historyEntries, historyPath, isHistoryPath, readHistory } from './history.js';
import { publishNote, settleReplacement } from './replacement.js';

// isolate invalid or duplicated ORIA notes during normal vault
// reads/writes instead of bricking healthy notes, while keeping strict loadNotes for backups.
export interface LoadWarning {
  code: 'INVALID_NOTE' | 'DUPLICATE_ID';
  path: string;
  message: string;
  id?: string;
}

interface LoadedNotes {
  notes: Map<string, Note>;
  warnings: LoadWarning[];
  duplicates: Map<string, string[]>;
}

function scanNotes(entries: TreeEntry[],
  read: (entry: TreeEntry) => Buffer = entry => readChecked(entry.absolutePath, limits.file),
  strict = true,
): LoadedNotes {
  const notes = new Map<string, Note>();
  const warnings: LoadWarning[] = [];
  const duplicates = new Map<string, string[]>();
  let total = 0;
  for (const entry of entries) {
    if (entry.directory || isHistoryPath(entry.relativePath) || !entry.relativePath.toLowerCase().endsWith('.md')) continue;
    const bytes = read(entry);
    let note: Note | undefined;
    try {
      note = parseNote(entry.relativePath, bytes);
    } catch (error) {
      if (!strict && error instanceof OriaError && error.code === 'INVALID_NOTE') {
        warnings.push({ code: 'INVALID_NOTE', path: 'library/' + entry.relativePath, message: error.message });
        continue;
      }
      throw error;
    }
    if (!note) continue;
    total += bytes.length;
    if (total > limits.total) throw new OriaError('SIZE_LIMIT', 'Markdown exceeds the 256 MiB vault limit');
    const id = note.metadata.id;
    const existingDuplicate = duplicates.get(id);
    if (existingDuplicate) {
      existingDuplicate.push(note.relativePath);
      continue;
    }
    const previous = notes.get(id);
    if (previous) {
      if (strict) {
        throw new OriaError('CONFLICT', 'Duplicate document ID at ' + previous.relativePath +
          ' and ' + note.relativePath);
      }
      notes.delete(id);
      duplicates.set(id, [previous.relativePath, note.relativePath]);
      continue;
    }
    notes.set(id, note);
  }
  for (const [id, paths] of duplicates) {
    warnings.push({
      code: 'DUPLICATE_ID',
      id,
      path: 'library/' + paths[0],
      message: 'Duplicate document ID at ' + paths.join(' and '),
    });
  }
  return { notes, warnings, duplicates };
}

export function loadNotes(entries: TreeEntry[],
  read: (entry: TreeEntry) => Buffer = entry => readChecked(entry.absolutePath, limits.file),
): Map<string, Note> {
  return scanNotes(entries, read, true).notes;
}

function summary(note: Note) {
  const { metadata, relativePath, version } = note;
  const { id, title, project, type, created_at, updated_at, created_by, updated_by, archived_at, tags,
    source_reference } = metadata;
  return {
    id, title, project, type, path: 'library/' + relativePath, revision: version, version,
    created_at, updated_at, created_by, updated_by, archived_at, tags, source_reference,
  };
}

function document(note: Note) {
  return { ...summary(note), body: note.body };
}

function byRecency(left: Note, right: Note): number {
  return Date.parse(right.metadata.updated_at) - Date.parse(left.metadata.updated_at) ||
    left.metadata.id.localeCompare(right.metadata.id);
}

function nextTimestamp(previous: string): string {
  return new Date(Math.max(Date.now(), Date.parse(previous) + 1)).toISOString();
}

function checkVersion(note: Note, version: string): void {
  if (note.version !== version) {
    throw new OriaError('VERSION_CONFLICT', 'Document changed. Read it again before retrying the update.');
  }
}

function noteFor(loaded: LoadedNotes, id: string): Note {
  const key = id.toLowerCase();
  const conflict = loaded.duplicates.get(key);
  if (conflict) {
    throw new OriaError('CONFLICT', 'Duplicate document ID at ' + conflict.join(' and '));
  }
  const note = loaded.notes.get(key);
  if (!note) throw new OriaError('NOT_FOUND', 'Document not found for ID ' + id);
  return note;
}

function normalizedBody(body: string): string {
  return body.replaceAll('\r\n', '\n').trimEnd();
}

function checkWriteCapacity(tree: TreeEntry[], writes: { path: string; size: number }[]): void {
  const entries = new Map(tree.map(entry => [portableKey(entry.relativePath), entry]));
  let bytes = tree.reduce((total, entry) => total + entry.size, 0);
  for (const write of writes) {
    validatePath(write.path);
    const key = portableKey(write.path);
    const previous = entries.get(key);
    if (previous?.directory) throw new OriaError('CONFLICT', 'Document path is already a directory');
    bytes += write.size - (previous?.size ?? 0);
    entries.set(key, { relativePath: write.path, absolutePath: '', directory: false, size: write.size });
    const parts = write.path.split('/');
    parts.pop();
    while (parts.length) {
      const path = parts.join('/');
      const key = portableKey(path);
      const directory = entries.get(key);
      if (directory && !directory.directory) throw new OriaError('CONFLICT', 'Document parent is already a file');
      entries.set(key, { relativePath: path, absolutePath: '', directory: true, size: 0 });
      parts.pop();
    }
  }
  if (entries.size > limits.entries || bytes > limits.total) {
    throw new OriaError('SIZE_LIMIT', 'The write and its history would exceed vault backup capacity (10,000 entries or 256 MiB)');
  }
}

function folded(value: string): string {
  return value.normalize('NFC').toLowerCase().normalize('NFC');
}

// slice excerpts by Unicode codepoints on NFC text to avoid lone UTF-16 surrogates and NFD offset drift.
function snippet(content: string, terms: string[]): string {
  const chars = Array.from(content.normalize('NFC'));
  const indexMap: number[] = [];
  let text = '';
  for (let i = 0; i < chars.length; i++) {
    const part = chars[i]!.toLowerCase().normalize('NFC');
    text += part;
    for (let j = 0; j < part.length; j++) indexMap.push(i);
  }
  const query = terms.find(term => text.includes(term)) ?? '';
  const rawMatch = query ? text.indexOf(query) : 0;
  const matchChar = rawMatch >= 0 && rawMatch < indexMap.length ? indexMap[rawMatch]! : 0;
  const queryChars = Array.from(query).length;
  const start = Math.max(0, matchChar - 55);
  const end = Math.min(chars.length, Math.max(start + 155, matchChar + queryChars + 30));
  return (start ? '…' : '') + chars.slice(start, end).join('').replace(/\s+/g, ' ').trim() +
    (end < chars.length ? '…' : '');
}

export class Vault {
  readonly paths: VaultPaths;

  constructor(path?: string, private readonly agent: Agent = 'unknown') {
    this.paths = new VaultPaths(path);
  }

  transaction<T>(operation: () => T): T {
    const db = new DatabaseSync(this.paths.database('coordination'), { timeout: 8000 });
    try {
      db.exec('BEGIN IMMEDIATE');
      settleReplacement(this.paths);
      const result = operation();
      db.exec('COMMIT');
      return result;
    } finally {
      db.close();
    }
  }

  init() {
    this.transaction(() => undefined);
    return { vault: this.paths.root };
  }

  private withIndex<T>(operation: (db: DatabaseSync) => T): T {
    const path = this.paths.database('state');
    const query = () => {
      const db = new DatabaseSync(path);
      try {
        db.exec('BEGIN IMMEDIATE');
        const result = operation(db);
        db.exec('COMMIT');
        return result;
      } finally {
        db.close();
      }
    };
    try {
      return query();
    } catch (error) {
      const sqlite = error as Error & { errcode?: number; code?: string };
      const code = (sqlite.errcode ?? 0) & 0xff;
      const brokenSchema = code === 1 && /no such (?:column|table)|unable to use function bm25/.test(sqlite.message);
      if (sqlite.code !== 'ERR_SQLITE_ERROR' || (!brokenSchema && code !== 11 && code !== 26)) throw error;
      // Coordination is independent of these disposable index files.
      for (const suffix of ['', '-journal', '-wal', '-shm']) {
        if (checkFile(path + suffix)) unlinkSync(path + suffix);
      }
      flushDirectory(dirname(path));
      return query();
    }
  }

  save(input: SaveInput, workspaceProject?: string, options: { allowSecrets?: boolean } = {}) {
    const values = validate(saveSchema, input, 'save');
    // strict validation for explicit project, safe fallback for untrusted project_hint.
    const project = values.project !== undefined
      ? projectId(values.project)
      : projectId(safeProjectHint(values.project_hint) ?? workspaceProject);
    return this.transaction(() => {
      const entries = walkTree(this.paths.library);
      const { notes } = scanNotes(entries, undefined, false);
      const comparableTitle = folded(values.title.normalize('NFKC'));
      const comparableBody = normalizedBody(values.body);
      const similar: { id: string; title: string; path: string }[] = [];
      for (const note of notes.values()) {
        // never silently deduplicate against archived notes or swallow new metadata.
        if (note.metadata.archived_at) continue;
        if (note.metadata.project === project &&
            folded(note.metadata.title.normalize('NFKC')) === comparableTitle) {
          if (normalizedBody(note.body) === comparableBody) {
            const typeMatches = values.type === undefined || values.type === note.metadata.type;
            const sourceMatches = values.source_reference === undefined ||
              values.source_reference === note.metadata.source_reference;
            const tagsMatch = values.tags === undefined ||
              values.tags.every(tag => note.metadata.tags.includes(tag));
            if (typeMatches && sourceMatches && tagsMatch) {
              return { created: false, document: summary(note) };
            }
          }
          similar.push({ id: note.metadata.id, title: note.metadata.title, path: 'library/' + note.relativePath });
        }
      }
      const now = new Date().toISOString();
      const metadata: Metadata = {
        oria_format: 1, id: randomUUID(), title: values.title, project, type: values.type ?? 'note',
        created_at: now, updated_at: now, created_by: this.agent, updated_by: this.agent,
        tags: values.tags ?? [],
        ...(values.source_reference === undefined ? {} : { source_reference: values.source_reference }),
      };
      const projectsEntry = entries.find(entry => portableKey(entry.relativePath) === 'PROJECTS');
      const projects = projectsEntry?.relativePath ?? 'projects';
      const projectPath = projects + '/' + project;
      const projectEntry = entries.find(entry => portableKey(entry.relativePath) === portableKey(projectPath));
      const directory = projectEntry?.relativePath ?? projectPath;
      const relativePath = directory + '/' + noteFilename(metadata);
      const bytes = encodeNote(metadata, values.body);
      protectSecrets([bytes.toString('utf8')], options.allowSecrets);
      checkWriteCapacity(entries, [{ path: relativePath, size: bytes.length }]);
      const written = parseNote(relativePath, bytes)!;
      publishNote(this.paths, relativePath, bytes);
      return {
        created: true,
        document: summary(written),
        ...(similar.length ? { similar_notes: similar } : {}),
      };
    });
  }

  read(id: string, revision?: string) {
    validate(readSchema, { id, revision }, 'read');
    return this.transaction(() => {
      const tree = walkTree(this.paths.library);
      const loaded = scanNotes(tree, undefined, false);
      if (revision === undefined || loaded.notes.get(id.toLowerCase())?.version === revision) {
        return document(noteFor(loaded, id));
      }
      return document(this.snapshot(tree, id, revision));
    });
  }

  update(input: UpdateInput, options: { allowRewrite?: boolean; allowSecrets?: boolean } = {}) {
    const values = validate(updateSchema, input, 'update');
    const { id, body, append, patch, source_reference, clear_source_reference, project, title, type, tags } = values;
    const expected = expectedRevision(values);
    if (clear_source_reference && source_reference !== undefined && source_reference !== null) {
      throw new OriaError('INVALID_INPUT', 'Choose either to set or clear source_reference');
    }
    if ([body, append, patch, source_reference, project, title, type, tags].every(value => value === undefined) &&
        !clear_source_reference) {
      throw new OriaError('INVALID_INPUT', 'Specify at least one field to update');
    }
    return this.transaction(() => {
      const tree = walkTree(this.paths.library);
      const note = noteFor(scanNotes(tree, undefined, false), id);
      checkVersion(note, expected);
      const metadata = { ...note.metadata };
      if (title !== undefined) metadata.title = title;
      if (type !== undefined) metadata.type = type;
      if (tags !== undefined) metadata.tags = tags;
      if (project !== undefined) metadata.project = projectId(project);
      if (clear_source_reference || source_reference === null) delete metadata.source_reference;
      else if (source_reference !== undefined) metadata.source_reference = source_reference;
      const nextBody = reviseBody(note.body, values);
      protectBody(note.body, nextBody, options.allowRewrite);
      return this.replace(tree, note, metadata, nextBody, note, options.allowSecrets);
    });
  }

  archive(input: ArchiveInput, options: { allowSecrets?: boolean } = {}) {
    const values = validate(archiveSchema, input, 'archive');
    const expected = expectedRevision(values);
    return this.transaction(() => {
      const tree = walkTree(this.paths.library);
      const note = noteFor(scanNotes(tree, undefined, false), values.id);
      checkVersion(note, expected);
      if (note.metadata.archived_at) return summary(note);
      return this.replace(tree, note, {
        ...note.metadata, archived_at: nextTimestamp(note.metadata.updated_at),
      }, note.body, note, options.allowSecrets);
    });
  }

  history(input: { id: string; limit?: number }) {
    const { id: inputId, limit = 25 } = validate(historySchema, input, 'history');
    const id = inputId.toLowerCase();
    return this.transaction(() => {
      const tree = walkTree(this.paths.library);
      const loaded = scanNotes(tree, undefined, false);
      const conflict = loaded.duplicates.get(id);
      if (conflict) {
        throw new OriaError('CONFLICT', 'Duplicate document ID at ' + conflict.join(' and '));
      }
      const current = loaded.notes.get(id);
      const records = [...historyEntries(tree).values()].filter(snapshot => snapshot.id === id);
      if (!current && !records.length) throw new OriaError('NOT_FOUND', 'Document or history not found for ID ' + id);
      return {
        id, current_revision: current?.version, total: records.length,
        revisions: records.map(snapshot => readHistory(snapshot)).sort(byRecency).slice(0, limit).map(summary),
      };
    });
  }

  restore(input: RestoreInput, options: { allowRewrite?: boolean; allowSecrets?: boolean } = {}) {
    const { id, revision, ...expectation } = validate(restoreSchema, input, 'restore');
    const expected = expectedRevision(expectation);
    return this.transaction(() => {
      const tree = walkTree(this.paths.library);
      const note = noteFor(scanNotes(tree, undefined, false), id);
      checkVersion(note, expected);
      if (note.version === revision) return summary(note);
      const snapshot = this.snapshot(tree, id, revision);
      protectBody(note.body, snapshot.body, options.allowRewrite);
      const { created_at, created_by } = note.metadata;
      return this.replace(tree, note, { ...snapshot.metadata, created_at, created_by }, snapshot.body, snapshot, options.allowSecrets);
    });
  }

  private snapshot(tree: TreeEntry[], id: string, revision: string) {
    const previous = historyEntries(tree).get(historyPath(id.toLowerCase(), revision));
    if (!previous) throw new OriaError('NOT_FOUND', 'Stored revision not found for ID ' + id);
    return readHistory(previous);
  }

  private replace(tree: TreeEntry[], note: Note, metadata: Metadata, body: string, template: Note, allowSecrets?: boolean) {
    metadata.updated_at = nextTimestamp(note.metadata.updated_at);
    metadata.updated_by = this.agent;
    const bytes = encodeNote(metadata, body, template);
    protectSecrets([bytes.toString('utf8')], allowSecrets);
    const snapshotPath = historyPath(note.metadata.id, note.version);
    const previous = historyEntries(tree).get(snapshotPath);
    if (previous) readHistory(previous);
    checkWriteCapacity(tree, [
      { path: note.relativePath, size: bytes.length }, { path: snapshotPath, size: note.size },
    ]);
    const written = parseNote(note.relativePath, bytes)!;
    if (!previous) {
      const original = readChecked(this.paths.pathInLibrary(note.relativePath), limits.note);
      if (digest(original) !== note.version) {
        throw new OriaError('VERSION_CONFLICT', 'Document changed before its history could be saved.');
      }
      publishNote(this.paths, snapshotPath, original);
    }
    publishNote(this.paths, note.relativePath, bytes, note.version);
    return summary(written);
  }

  list(input: { project?: string; limit?: number } = {}) {
    const values = validate(listSchema, input, 'list');
    const project = values.project === undefined ? undefined : projectId(values.project);
    return this.transaction(() => {
      const { notes, warnings } = scanNotes(walkTree(this.paths.library), undefined, false);
      const counts = new Map<string, number>();
      const matched: Note[] = [];
      for (const note of notes.values()) {
        const name = note.metadata.project;
        counts.set(name, (counts.get(name) ?? 0) + 1);
        if (!project || name === project) matched.push(note);
      }
      return {
        projects: [...counts].sort(([left], [right]) => left.localeCompare(right))
          .map(([id, count]) => ({ id, count })),
        total: matched.length,
        documents: matched.sort(byRecency).slice(0, values.limit ?? 25).map(summary),
        ...(warnings.length ? { warnings } : {}),
      };
    });
  }

  search(input: { query: string; project?: string; limit?: number }) {
    const { query, project: name, limit = 20 } = validate(searchSchema, input, 'search');
    const project = name === undefined ? undefined : projectId(name);
    const terms = [...new Set(folded(query).split(/\s+/u))];
    const longTerms = terms.filter(term => Array.from(term).length >= 3);
    const shortTerms = terms.filter(term => Array.from(term).length < 3);
    return this.transaction(() => this.withIndex(db => {
      const loaded = scanNotes(walkTree(this.paths.library), undefined, false);
      const { notes } = loaded;
      this.refreshIndex(db, notes);
      const candidates = longTerms.length
        ? this.ftsSearch(db, loaded, longTerms, project)
        : [...notes.values()].sort(byRecency);
      const results = [];
      for (const note of candidates) {
        if (project && note.metadata.project !== project) continue;
        const fields = [note.body, note.metadata.title, ...note.metadata.tags].map(value => ({ value, text: folded(value) }));
        if (!shortTerms.every(term => fields.some(field => field.text.includes(term)))) continue;
        const excerpt = fields.find(field => terms.some(term => field.text.includes(term)))?.value ?? note.body;
        results.push({ ...summary(note), snippet: snippet(excerpt, terms) });
        if (results.length === limit) break;
      }
      return results;
    }));
  }

  private ensureIndex(db: DatabaseSync): void {
    // Revision hashes stay valid when the index tokenizer or normalization changes.
    if (db.prepare('PRAGMA user_version').get()?.user_version !== 2) {
      db.exec('DROP TABLE IF EXISTS notes; PRAGMA user_version = 2');
    }
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS notes USING fts5(" +
      "id UNINDEXED, version UNINDEXED, project UNINDEXED, title, body, tags, tokenize='trigram')");
  }

  private refreshIndex(db: DatabaseSync, notes: Map<string, Note>): void {
    this.ensureIndex(db);
    const current = new Map(db.prepare('SELECT id, version FROM notes').all()
      .map(row => [String(row.id), String(row.version)]));
    const remove = db.prepare('DELETE FROM notes WHERE id = ?');
    const insert = db.prepare('INSERT INTO notes(id, version, project, title, body, tags) VALUES (?, ?, ?, ?, ?, ?)');
    for (const [id, version] of current) if (notes.get(id)?.version !== version) remove.run(id);
    for (const [id, note] of notes) {
      if (current.get(id) !== note.version) {
        insert.run(id, note.version, note.metadata.project, folded(note.metadata.title), folded(note.body),
          note.metadata.tags.map(folded).join(' '));
      }
    }
  }

  private *ftsSearch(db: DatabaseSync, loaded: LoadedNotes, terms: string[], project?: string) {
    const phrase = terms.map(term => '"' + term.replaceAll('"', '""') + '"').join(' AND ');
    const rows = db.prepare('SELECT id FROM notes WHERE notes MATCH ?' + (project ? ' AND project = ?' : '') +
      ' ORDER BY bm25(notes, 0, 0, 0, 5, 1, 2), id').iterate(phrase, ...(project ? [project] : []));
    for (const row of rows) yield noteFor(loaded, String(row.id));
  }
}
