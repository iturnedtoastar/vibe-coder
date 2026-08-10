import fs from 'node:fs/promises';
import path from 'node:path';
import { getWorkspaceRoot, isFolderOpen } from './config.js';
import { walkWorkspace, toRelative } from './sandbox.js';

/**
 * A compact map of the open project, handed to the agent up front.
 *
 * Without it the agent discovers the codebase by calling list_files and then
 * read_file repeatedly — and because the whole conversation is resent on every
 * turn, each of those round-trips re-bills everything before it. Discovery is
 * the most expensive way to learn something we can compute locally for free.
 *
 * The map is signatures only, never bodies: enough to know what exists and
 * where to look, cheap enough to include every time.
 */

const CODE = /\.(js|mjs|cjs|jsx|ts|tsx|vue|svelte|py|rb|go|rs|java|kt|cs|php)$/i;

/**
 * Compiled output and archives are in the folder but tell the agent nothing —
 * they're generated from the source that's already mapped. Left in, they ate
 * the budget and pushed real files out: on a real project 122 source files were
 * truncated while api/dist/** was listed in full.
 */
const GENERATED = /(^|\/)(dist|build|out|coverage|\.next|\.nuxt|\.turbo|\.vite|\.cache|\.parcel-cache|deps|vendor|__pycache__|\.pytest_cache|target|bin|obj|\.venv|venv)(\/|$)/i;
const NOT_SOURCE = /\.(zip|tar|gz|7z|rar|exe|dll|so|dylib|pdf|lock|map|min\.js|min\.css)$/i;

function worthMapping(rel) {
  return !GENERATED.test(rel) && !NOT_SOURCE.test(rel);
}
const MAX_BYTES = 14000;          // roughly 3.5k tokens
const MAX_FILES_SCANNED = 400;
const MAX_SIGNATURES_PER_FILE = 12;

/** Declarations worth surfacing — what a file offers, not how it works. */
const PATTERNS = [
  /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s+(\w+)/,
  /^\s*export\s+(?:const|let|class)\s+(\w+)/,
  /^\s*export\s+\{([^}]+)\}/,
  /^\s*(?:async\s+)?function\s+(\w+)/,
  /^\s*class\s+(\w+)/,
  /^\s*def\s+(\w+)/,
  /^\s*(?:pub\s+)?fn\s+(\w+)/,
  /^\s*func\s+(?:\([^)]*\)\s*)?(\w+)/,
];

function signaturesFrom(text) {
  const found = [];
  for (const line of text.split('\n')) {
    if (line.length > 400) continue;
    for (const re of PATTERNS) {
      const m = re.exec(line);
      if (!m) continue;
      const name = m[1].trim().split(/\s*,\s*/)[0].replace(/\s+as\s+\w+/, '');
      if (name && !found.includes(name)) found.push(name);
      break;
    }
    if (found.length >= MAX_SIGNATURES_PER_FILE) break;
  }
  return found;
}

/** Package scripts and dependencies say more about a project than any file. */
async function projectFacts(root) {
  const facts = [];
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
    if (pkg.name) facts.push(`package: ${pkg.name}`);
    const scripts = Object.keys(pkg.scripts || {});
    if (scripts.length) facts.push(`scripts: ${scripts.slice(0, 12).join(', ')}`);
    const deps = Object.keys(pkg.dependencies || {});
    if (deps.length) facts.push(`dependencies: ${deps.slice(0, 20).join(', ')}`);
  } catch { /* not a node project */ }
  return facts;
}

/**
 * Build the map. Returns '' when no folder is open or it's empty, so callers
 * can concatenate unconditionally.
 */
export async function buildProjectMap() {
  if (!isFolderOpen()) return '';

  const root = getWorkspaceRoot();
  let files;
  try {
    files = await walkWorkspace();
  } catch {
    return '';
  }
  if (!files.length) return '';

  const facts = await projectFacts(root);

  // Shallowest first: entry points and config matter more than leaf modules.
  const ordered = files
    .map((f) => ({ full: f, rel: toRelative(f) }))
    .filter((f) => worthMapping(f.rel))
    .sort((a, b) => a.rel.split('/').length - b.rel.split('/').length || a.rel.localeCompare(b.rel))
    .slice(0, MAX_FILES_SCANNED);

  const lines = [];
  let budget = MAX_BYTES;
  let truncated = 0;

  for (const { full, rel } of ordered) {
    if (budget <= 0) { truncated++; continue; }

    let entry = rel;
    if (CODE.test(rel)) {
      try {
        const stat = await fs.stat(full);
        if (stat.size < 400000) {
          const names = signaturesFrom(await fs.readFile(full, 'utf8'));
          if (names.length) entry += `  — ${names.join(', ')}`;
        }
      } catch { /* unreadable; the path alone is still useful */ }
    }

    if (entry.length + 1 > budget) { truncated++; continue; }
    lines.push(entry);
    budget -= entry.length + 1;
  }

  if (!lines.length) return '';

  return [
    '',
    '## Project map',
    '',
    'Generated locally, so you do not have to discover the codebase by reading it.',
    'Names after a dash are the declarations that file exports or defines.',
    'Read a file when you need its contents — but you should rarely need to list.',
    '',
    ...facts.map((f) => `- ${f}`),
    facts.length ? '' : null,
    '```',
    ...lines,
    truncated ? `… and ${truncated} more files (map truncated to stay cheap)` : null,
    '```',
  ].filter((l) => l !== null).join('\n');
}
