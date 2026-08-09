import path from 'node:path';
import fs from 'node:fs/promises';
import { getWorkspaceRoot } from './config.js';

export class SandboxError extends Error {}

/**
 * Resolve a model- or client-supplied path against the currently open folder
 * and refuse anything that escapes it.
 *
 * The folder itself is chosen by the user (File → Open Folder), so this is not
 * trying to protect you from yourself — it stops the *model* from wandering
 * outside the project you pointed it at.
 *
 * Handles absolute paths, `..` traversal, and symlinks pointing outside the
 * root (checked against the deepest existing ancestor, so paths that don't
 * exist yet can still be created).
 */
export async function resolveInWorkspace(userPath) {
  if (typeof userPath !== 'string' || userPath.length === 0) {
    throw new SandboxError('A path is required.');
  }
  if (userPath.includes('\0')) throw new SandboxError('Invalid path.');

  const root = getWorkspaceRoot();

  // Strip leading separators / drive letters so "/etc/passwd" and "C:\Windows"
  // are read as project-relative rather than absolute.
  const cleaned = userPath.replace(/^[a-zA-Z]:[\\/]/, '').replace(/^[\\/]+/, '');

  const full = path.resolve(root, cleaned);
  assertInside(full, root);

  // Walk up to the deepest ancestor that exists and verify its real path is
  // still inside the folder — catches symlinked directories.
  let probe = full;
  for (;;) {
    try {
      assertInside(await fs.realpath(probe), root);
      break;
    } catch (err) {
      if (err instanceof SandboxError) throw err;
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }

  return full;
}

function assertInside(candidate, root = getWorkspaceRoot()) {
  const rel = path.relative(root, candidate);
  if (rel === '') return;
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new SandboxError(
      'Path is outside the open folder. Open that folder instead if you need to work in it.'
    );
  }
}

/** Project-relative, forward-slash path for display back to the model. */
export function toRelative(fullPath) {
  return path.relative(getWorkspaceRoot(), fullPath).split(path.sep).join('/') || '.';
}

/**
 * Only dependency and VCS trees are skipped. Everything else in the folder you
 * opened is yours and gets listed — including dotfiles and build output.
 * node_modules and .git stay out because they routinely hold tens of thousands
 * of files and would stall the editor for no benefit.
 */
const IGNORED_DIRS = new Set(['node_modules', '.git']);

/** Recursively list every file under a directory. */
export async function walkWorkspace(dir, out = [], depth = 0) {
  const start = dir || getWorkspaceRoot();
  if (depth > 16 || out.length > 20000) return out;

  let entries;
  try {
    entries = await fs.readdir(start, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const full = path.join(start, entry.name);
    if (entry.isDirectory()) await walkWorkspace(full, out, depth + 1);
    else if (entry.isFile()) out.push(full);
    if (out.length > 20000) return out;
  }
  return out;
}
