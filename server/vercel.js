import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { config, getWorkspaceRoot, isFolderOpen } from './config.js';

/**
 * Deploy the open folder to Vercel.
 *
 * The Vercel CLI already understands "a folder of files" — the same model this
 * IDE uses — so this drives it rather than reimplementing anything. Auth is the
 * CLI's own (`vercel login`); no token is stored here.
 *
 * Deploys are outward-facing and hard to take back, so nothing happens without
 * an explicit request, and a preview deploy is the default rather than
 * production.
 */

const isWin = process.platform === 'win32';
const WIN_PREFERENCE = ['.exe', '.cmd', '.bat', '.com'];

function which(bin) {
  const res = spawnSync(isWin ? 'where' : 'which', [bin], {
    encoding: 'utf8', shell: false, windowsHide: true,
  });
  if (res.status !== 0) return null;
  const hits = (res.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!isWin) return hits[0] || null;
  for (const ext of WIN_PREFERENCE) {
    const hit = hits.find((h) => h.toLowerCase().endsWith(ext));
    if (hit) return hit;
  }
  return null;
}

let cache = null;

export function vercelStatus({ force = false } = {}) {
  if (cache && !force) return cache;

  const bin = which('vercel') || which('vc');
  let loggedIn = false;
  let user = null;

  if (bin) {
    const res = runSync(bin, ['whoami']);
    // `vercel whoami` prints the username, but the surrounding lines vary by
    // version — a "Vercel CLI x.y.z" banner, and newer builds emit an
    // <claude-code-hint .../> tag. Pick the line that actually looks like a
    // username rather than assuming a position or scanning for "error".
    if (res.status === 0) {
      const candidate = `${res.stdout}\n${res.stderr}`
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .filter((l) => !l.startsWith('<') && !/^vercel cli/i.test(l) && !/\s/.test(l))
        .pop();

      if (candidate && /^[a-z0-9][a-z0-9-_]*$/i.test(candidate)) {
        loggedIn = true;
        user = candidate;
      }
    }
  }

  const root = getWorkspaceRoot();
  cache = {
    available: Boolean(bin),
    path: bin,
    loggedIn,
    user,
    linked: isFolderOpen() && fs.existsSync(path.join(root, '.vercel', 'project.json')),
    hint: 'Install with: npm i -g vercel   then run: vercel login',
  };
  return cache;
}

function runSync(bin, args) {
  const needsShell = isWin && !bin.toLowerCase().endsWith('.exe');
  const command = needsShell ? (process.env.ComSpec || 'cmd.exe') : bin;
  const argv = needsShell ? ['/d', '/s', '/c', bin, ...args] : args;
  const res = spawnSync(command, argv, {
    cwd: getWorkspaceRoot(), encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function run(bin, args, { onOutput, timeoutMs = 900000 } = {}) {
  const needsShell = isWin && !bin.toLowerCase().endsWith('.exe');
  const command = needsShell ? (process.env.ComSpec || 'cmd.exe') : bin;
  const argv = needsShell ? ['/d', '/s', '/c', bin, ...args] : args;

  return new Promise((resolve) => {
    const child = spawn(command, argv, {
      cwd: getWorkspaceRoot(),
      windowsHide: true,
      // Never let the CLI block on an interactive prompt in a headless context.
      env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
    });

    let out = '';
    const push = (c) => {
      const text = c.toString();
      if (out.length < config.maxToolOutput * 2) out += text;
      onOutput?.(text);
    };
    child.stdout.on('data', push);
    child.stderr.on('data', push);

    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, timeoutMs);
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, out: out + err.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

/**
 * Make sure the folder has something Vercel can serve. A bare HTML project
 * needs no build step, but it does need to not look like an unconfigured
 * framework project.
 */
async function ensureVercelConfig() {
  const root = getWorkspaceRoot();
  const configPath = path.join(root, 'vercel.json');
  const pkgPath = path.join(root, 'package.json');

  if (fs.existsSync(configPath)) return { created: false };
  // A framework project (Next, Vite, etc.) knows how to build itself.
  if (fs.existsSync(pkgPath)) return { created: false };

  // Plain static site: say so explicitly rather than letting Vercel guess.
  await fsp.writeFile(
    configPath,
    JSON.stringify({ $schema: 'https://openapi.vercel.sh/vercel.json', framework: null }, null, 2) + '\n',
    'utf8'
  );
  return { created: true };
}

/**
 * Deploy the open folder. Returns { url } or { error }.
 * `production: true` promotes to the production domain.
 */
export async function deployToVercel({ production = false, name, onOutput } = {}) {
  const status = vercelStatus({ force: true });

  if (!status.available) return { error: `Vercel CLI is not installed. ${status.hint}` };
  if (!status.loggedIn) return { error: 'Not signed in to Vercel. Run `vercel login` in the Workspace Terminal.' };
  if (!isFolderOpen()) return { error: 'Open or save a project first — Vercel deploys a folder.' };

  const config = await ensureVercelConfig();

  const args = ['deploy', '--yes'];
  if (production) args.push('--prod');
  if (name) args.push('--name', name);

  const res = await run(status.path, args, { onOutput });

  // The CLI prints the deployment URL on its own line.
  const url = (res.out.match(/https:\/\/[^\s]+\.vercel\.app/g) || []).pop();

  if (res.code !== 0 || !url) {
    return { error: `Vercel deploy failed (exit ${res.code}).\n${res.out.slice(-800)}` };
  }
  return { url, production, createdConfig: config.created, log: res.out.slice(-2000) };
}

/**
 * Connect the linked Vercel project to a git remote, so future pushes deploy
 * automatically. Requires the folder to be a git repo with an origin.
 */
export async function connectVercelGit({ onOutput } = {}) {
  const status = vercelStatus({ force: true });
  if (!status.available) return { error: `Vercel CLI is not installed. ${status.hint}` };
  if (!status.loggedIn) return { error: 'Not signed in to Vercel. Run `vercel login` first.' };

  const root = getWorkspaceRoot();
  if (!fs.existsSync(path.join(root, '.git'))) {
    return { error: 'This folder is not a git repository. Run `git init` and add a remote first.' };
  }

  const remote = runSync('git', ['remote', 'get-url', 'origin']);
  if (remote.status !== 0 || !remote.stdout.trim()) {
    return { error: 'No git remote named "origin". Push the folder to GitHub first.' };
  }

  const res = await run(status.path, ['git', 'connect', '--yes'], { onOutput });
  if (res.code !== 0) return { error: `vercel git connect failed.\n${res.out.slice(-600)}` };

  return { connected: true, remote: remote.stdout.trim(), log: res.out.slice(-1000) };
}

export const VERCEL_TOOLS = [
  {
    name: 'deploy_vercel',
    description:
      'Deploy the open folder to Vercel and return the live URL. Detects the framework automatically (Next.js, Vite, static HTML, etc). Use production: true to promote to the production domain, otherwise a preview deployment is created. Only deploy when the user asks — it publishes their work publicly.',
    parameters: {
      type: 'object',
      properties: {
        production: { type: 'boolean', description: 'Promote to the production domain instead of a preview URL.' },
        name: { type: 'string', description: 'Project name. Defaults to the folder name.' },
      },
      required: [],
    },
  },
  {
    name: 'connect_vercel_git',
    description:
      'Link the Vercel project to the folder\'s GitHub remote so future pushes deploy automatically. Requires a git repo with an "origin" remote.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
];

export function vercelToolsAvailable() {
  const s = vercelStatus();
  return s.available && s.loggedIn;
}
