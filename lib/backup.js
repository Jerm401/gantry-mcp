'use strict';

/**
 * Layout backups — automatic snapshots before any mutating layout op.
 *
 * Layout: ./backups/<host>/<outline>/<ISO-timestamp>-<op>.json
 *
 * Each file is the literal JSON returned by `lm.builder.serialize()` — i.e.
 * exactly what would be POSTed if you saved the current layout.
 *
 * Configurable directory: GANTRY_BACKUP_DIR env var, otherwise ./backups
 */

const fs = require('fs');
const path = require('path');

function backupRoot() {
  return path.resolve(process.cwd(), process.env.GANTRY_BACKUP_DIR || 'backups');
}

function safeHost(ctx) {
  try {
    return new URL(ctx.base).host.replace(/[^a-zA-Z0-9._-]/g, '_');
  } catch {
    return 'site';
  }
}

function backupDir(ctx, outline) {
  const dir = path.join(backupRoot(), safeHost(ctx), String(outline || 'default'));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function timestamp() {
  // 2026-05-07T15-30-45 — filesystem-safe ISO
  return new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
}

/**
 * Save a snapshot of the given structure to disk, returning the file path.
 *   takeBackup(ctx, "75", "remove", structureJson)
 */
function takeBackup(ctx, outline, op, structure) {
  const dir = backupDir(ctx, outline);
  const file = path.join(dir, `${timestamp()}-${op}.json`);
  fs.writeFileSync(file, JSON.stringify(structure, null, 2));
  return file;
}

/**
 * List all backups for an outline, newest first.
 */
function listBackups(ctx, outline) {
  const dir = backupDir(ctx, outline);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .reverse()
    .map((f) => ({
      name: f,
      path: path.join(dir, f),
      size: fs.statSync(path.join(dir, f)).size,
      mtime: fs.statSync(path.join(dir, f)).mtime,
    }));
}

/**
 * Resolve a backup path — accepts an absolute file path, a basename within the
 * outline's backup dir, or `latest` (most recent for the outline).
 */
function resolveBackup(ctx, outline, ref) {
  if (!ref) throw new Error('No backup ref given (path | name | "latest")');
  if (ref === 'latest' || ref === 'last') {
    const list = listBackups(ctx, outline);
    if (!list.length) throw new Error(`No backups found for outline ${outline}`);
    return list[0].path;
  }
  if (path.isAbsolute(ref) && fs.existsSync(ref)) return ref;
  const candidate = path.join(backupDir(ctx, outline), ref);
  if (fs.existsSync(candidate)) return candidate;
  throw new Error(`Backup not found: ${ref}`);
}

/**
 * Read a backup file's JSON.
 */
function readBackup(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

module.exports = {
  backupRoot,
  backupDir,
  takeBackup,
  listBackups,
  resolveBackup,
  readBackup,
};
