import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(here, '.env') });

const repoRoot = path.resolve(here, '..');

/**
 * In a packaged build these files live inside app.asar, which is a read-only
 * virtual filesystem — a workspace path under it can never be created. Fall
 * back to a real directory instead. (The Electron shell overrides this
 * immediately with the remembered or user-picked folder; this only has to be
 * somewhere valid.)
 */
/**
 * Where the terminal points before you've opened anything.
 *
 * A scratch directory in the system temp folder, not Documents: launching the
 * app must not create project folders you didn't ask for. It isn't created
 * here either — only when something actually needs it.
 */
function defaultWorkspaceRoot() {
  if (process.env.WORKSPACE_ROOT) return path.resolve(process.env.WORKSPACE_ROOT);
  return path.join(os.tmpdir(), 'vibe-coder-scratch');
}

/**
 * The open folder. Everything the terminal runs and everything the agent reads
 * or writes is resolved against this directory — the same idea as VS Code's
 * "Open Folder". It changes at runtime, so read it through getWorkspaceRoot()
 * rather than capturing it once at import time.
 */
/**
 * Store the *real* path, with symlinks and NTFS junctions already resolved.
 *
 * The sandbox check compares a realpath'd candidate against this root, so if
 * the root itself were a symlink every path would resolve outside it and every
 * read and write would be rejected — `/tmp` on macOS, junctioned project dirs
 * and redirected profile folders on Windows all hit that.
 */
function realOrSelf(dir) {
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
}

// Deliberately does NOT create the directory. This module is imported on every
// boot, and creating the default here silently re-made "Vibe Coder Projects" in
// Documents even when the user had opened a folder of their own. Only
// setWorkspaceRoot() — which runs when a folder is actually opened — creates
// anything.
let workspaceRoot = realOrSelf(defaultWorkspaceRoot());

// Whether the user has actually opened a folder, as opposed to sitting on the
// scratch default. The UI needs to tell those apart.
let folderOpen = false;

export function getWorkspaceRoot() {
  return workspaceRoot;
}

export function isFolderOpen() {
  return folderOpen;
}

export function setWorkspaceRoot(next, { opened = true } = {}) {
  const resolved = path.resolve(next);
  fs.mkdirSync(resolved, { recursive: true });
  workspaceRoot = realOrSelf(resolved);
  folderOpen = opened;
  return workspaceRoot;
}

/** Create the current root on demand, so nothing is made until it's needed. */
export function ensureWorkspaceExists() {
  try {
    fs.mkdirSync(workspaceRoot, { recursive: true });
  } catch { /* the caller will surface the real failure */ }
  return workspaceRoot;
}

export const config = {
  port: Number(process.env.PORT || 4400),
  host: process.env.HOST || '127.0.0.1',
  repoRoot,

  keys: {
    anthropic: process.env.ANTHROPIC_API_KEY || '',
    openai: process.env.OPENAI_API_KEY || '',
    google: process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || '',
  },

  baseUrls: {
    anthropic: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
    openai: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    google: process.env.GOOGLE_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta',
  },

  agent: {
    maxIterations: Number(process.env.AGENT_MAX_ITERATIONS || 24),
    maxTokens: Number(process.env.AGENT_MAX_TOKENS || 32000),
    // "low" | "medium" | "high" | "xhigh" | "max" — only sent to models that support it.
    effort: process.env.AGENT_EFFORT || 'high',
    allowBash: process.env.AGENT_ALLOW_BASH !== 'false',
    // Server-side refusal fallbacks for Claude Opus 5 / Fable 5. Set to "off" to disable.
    anthropicFallbacks: process.env.ANTHROPIC_FALLBACKS || 'default',
  },

  shell:
    process.env.SHELL_BIN ||
    (process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/bash'),

  // Max bytes of command output fed back to the model in one tool result.
  maxToolOutput: Number(process.env.MAX_TOOL_OUTPUT || 30000),
  commandTimeoutMs: Number(process.env.COMMAND_TIMEOUT_MS || 120000),

  // Opening a folder loads everything in it. These are backstops against a
  // pathological folder locking up the editor, not routine filters — a normal
  // project should never hit them.
  maxEditorFiles: Number(process.env.MAX_EDITOR_FILES || 5000),
  maxEditorFileBytes: Number(process.env.MAX_EDITOR_FILE_BYTES || 5 * 1024 * 1024),
  // Binaries load as base64 data URLs, which are ~33% larger than the file.
  maxAssetBytes: Number(process.env.MAX_ASSET_BYTES || 25 * 1024 * 1024),

  // Container for project folders. Projects live here as directories; this is
  // never opened as a workspace itself.
  projectsHome:
    process.env.PROJECTS_HOME || path.join(os.homedir(), 'Documents', 'Vibe Coder Projects'),
};
