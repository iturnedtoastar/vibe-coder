import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';

import { config, getWorkspaceRoot, setWorkspaceRoot, isFolderOpen } from './config.js';
import { runAgent, PROVIDERS, SYSTEM_PROMPT, availableCliAgents } from './agent.js';
import { attachTerminal, ptyAvailable } from './pty.js';
import { cliAvailable } from './providers/cli-agents.js';
import { ollamaStatus } from './providers/ollama.js';
import { transcribe, transcriptionStatus } from './transcribe.js';
import { resolveInWorkspace, toRelative, walkWorkspace } from './sandbox.js';
import { mediaToolAvailable } from './tools.js';
import { videoStatus, renderVideo } from './video.js';
import { vercelStatus, deployToVercel, connectVercelGit } from './vercel.js';
import { scaffoldStatus, scaffold, COMPONENT_GUIDANCE } from './scaffold.js';
import { buildProjectMap } from './projectmap.js';
import { buildPlan, planAsInstructions } from './planner.js';

const TEXT_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.json', '.html', '.htm', '.css',
  '.scss', '.sass', '.less', '.md', '.markdown', '.txt', '.yml', '.yaml', '.toml',
  '.xml', '.svg', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.c', '.h', '.cpp',
  '.hpp', '.cs', '.php', '.sh', '.ps1', '.sql', '.env', '.gitignore', '.example',
  '.vue', '.svelte', '.astro', '.lock', '.cfg', '.ini', '.conf',
]);

function looksLikeText(file) {
  const ext = path.extname(file).toLowerCase();
  return ext === '' || TEXT_EXTENSIONS.has(ext);
}

/** Content type for a binary loaded as a data: URL, so the preview can inline it. */
const MIME_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.json': 'application/json',
};

function mimeFor(file) {
  return MIME_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

/**
 * Are these bytes valid UTF-8?
 *
 * Decoded loosely, invalid bytes become U+FFFD — but scanning the *result* for
 * U+FFFD is wrong, because a perfectly valid UTF-8 file is allowed to contain
 * that character (this file did, and classified itself as binary). A strict
 * decoder answers the actual question.
 */
function isValidUtf8(bytes) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

// npm_package_version only exists when launched via an npm script, so the
// packaged app has to pass its real version in (see desktop/main.js).
let APP_VERSION = process.env.npm_package_version || '1.0.0';

/**
 * Describe how the live preview actually renders, so the agent writes code that
 * looks right *here*.
 *
 * The preview is not a web server. It takes one HTML file, concatenates every
 * CSS and JS file in the project into it, inlines assets by filename, and drops
 * the result into an iframe. A model that doesn't know this writes a perfectly
 * correct page with <link href="styles.css"> that silently renders unstyled.
 */
/**
 * Attach the volatile workspace context to the newest user message.
 *
 * Kept out of the system prompt on purpose: that block is the cached prefix,
 * and anything that changes between turns invalidates it.
 */
function withVolatileContext(messages, previewContext, folder, projectMap = '') {
  const contract = [describePreviewContract(previewContext, folder), projectMap]
    .filter(Boolean).join('\n');
  if (!contract || !messages.length) return messages;

  const out = messages.slice();
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].role !== 'user') continue;
    const msg = out[i];
    out[i] = Array.isArray(msg.content)
      ? { ...msg, content: [{ type: 'text', text: contract }, ...msg.content] }
      : { ...msg, content: `${contract}\n\n---\n\n${msg.content}` };
    break;
  }
  return out;
}

export function describePreviewContract(ctx, folder) {
  if (!ctx) return '';

  const lines = [
    '',
    '## How the live preview works',
    '',
    folder ? `The open folder is "${folder}".` : '',
    'The preview is an iframe built from the project files — NOT a web server.',
    `- It renders one entry file: ${ctx.entry || '(no HTML file yet — create index.html)'}`,
    '- Every .css file in the project is concatenated and injected into that page.',
    '- Every .js/.ts file is concatenated and injected too, in file order.',
    '- Relative URLs do NOT resolve. Never rely on <link href="styles.css"> or',
    '  <script src="app.js"> — put the code in .css/.js files and it is included',
    '  automatically. CDN URLs (https://…) do work.',
    '- Image/font assets are inlined by matching their filename in the markup.',
  ];

  if (ctx.cssFiles?.length) lines.push(`- CSS files injected: ${ctx.cssFiles.join(', ')}`);
  if (ctx.jsFiles?.length) lines.push(`- JS files injected: ${ctx.jsFiles.join(', ')}`);
  if (ctx.assets?.length) lines.push(`- Assets available: ${ctx.assets.join(', ')}`);

  if (ctx.viewport?.width) {
    lines.push(
      '',
      `The preview is currently showing the **${ctx.device}** view at `
      + `${Math.round(ctx.viewport.width)}×${Math.round(ctx.viewport.height)} CSS pixels. `
      + 'Design and verify against that size — if it is a phone width, lay the UI out '
      + 'for a phone rather than scaling a desktop design down.'
    );
  }

  // components.build guidance is stable, so it lives in the cached system
  // prompt rather than being re-sent here on every turn.

  lines.push(
    '',
    'After you edit a file the preview reloads by itself. Prefer editing the '
    + 'existing entry file over creating new pages, unless asked for a new page.'
  );

  lines.push(describeRuntimeErrors(ctx.errors));

  return lines.filter(Boolean).join('\n');
}

/**
 * What the preview threw on its last run.
 *
 * These are the errors the user would otherwise have to read off the console
 * and paste back. Handing them over unprompted is what turns "write it and
 * hope" into "write it, see what broke, fix it" without a human in the middle.
 */
function describeRuntimeErrors(errors) {
  if (!Array.isArray(errors) || !errors.length) return '';

  // A build failure means nothing ran at all, so it outranks anything the page
  // managed to throw — it must never be the entry that gets cut for budget.
  // Among the rest the newest win: an old error is often one already fixed.
  const build = errors.filter((e) => e.level === 'build');
  const runtime = errors.filter((e) => e.level !== 'build');
  const ranked = [...build, ...runtime.slice(-Math.max(0, 8 - build.length))];

  const shown = ranked.slice(0, 8).map((e) => {
    const repeat = e.count > 1 ? ` (×${e.count})` : '';
    return `- [${e.level}] ${String(e.text).slice(0, 400)}${repeat}`;
  });

  const hasBuild = errors.some((e) => e.level === 'build');

  return [
    '',
    '## Current errors',
    '',
    hasBuild
      ? '[build] lines came from the dev server and mean the project does not '
        + 'compile — nothing runs until they are fixed. [error] and [warn] came '
        + 'from the page itself as it last ran.'
      : 'These came from the page as it last ran.',
    '',
    'They are the current state of the code you are about to change. If one is',
    'related to the task, fix it as part of the work rather than reporting it',
    'back. If none are related, leave them alone and do not mention them.',
    '',
    ...shown,
  ].join('\n');
}


/**
 * Write a launcher shim for the built-in agent and put its directory on the
 * terminal's PATH, so `vibe` is a real command in any Vibe Coder terminal.
 *
 * Deliberately NOT named `claude`: these are real terminals with your real
 * PATH, so an installed Claude Code (or any other agent CLI) must keep
 * working. For the same reason the directory is *appended* to PATH rather than
 * prepended — nothing of yours gets shadowed.
 *
 * The shim runs the CLI through `process.execPath`. In the packaged app that's
 * the Electron binary, and ELECTRON_RUN_AS_NODE makes it behave as plain Node
 * *and* lets it read the script out of app.asar, which a system `node` cannot.
 */
function createCommandShims() {
  const dir = path.join(os.tmpdir(), 'vibe-coder-bin');
  const cli = path.join(config.repoRoot, 'server', 'cli', 'agent-cli.cjs');
  const runner = process.execPath;
  const asNode = process.versions.electron ? '1' : '';

  try {
    fs.mkdirSync(dir, { recursive: true });

    if (process.platform === 'win32') {
      fs.writeFileSync(
        path.join(dir, 'vibe.cmd'),
        `@echo off\r\nset "ELECTRON_RUN_AS_NODE=${asNode}"\r\n"${runner}" "${cli}" %*\r\n`
      );
    } else {
      const sh = path.join(dir, 'vibe');
      fs.writeFileSync(
        sh,
        `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=${asNode || '""'}\nexec "${runner}" "${cli}" "$@"\n`
      );
      fs.chmodSync(sh, 0o755);
    }
  } catch (err) {
    console.warn(`[vibe] could not create the "vibe" command: ${err.message}`);
  }

  return dir;
}

/**
 * Build the app + websocket server. Exported so the Electron shell can start it
 * in-process on a random port; running this file directly starts it standalone.
 */
export function createServer({ token, version } = {}) {
  if (version) APP_VERSION = version;
  // Even bound to localhost, a token is required on every call: without it a
  // page in another tab could POST here even though it couldn't read the reply.
  const TOKEN = token || process.env.VIBE_TOKEN || crypto.randomBytes(24).toString('hex');
  const binDir = createCommandShims();

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32mb' }));

  app.use('/api', (req, res, next) => {
    const supplied =
      req.get('x-vibe-token') || new URL(req.url, 'http://localhost').searchParams.get('token');
    if (supplied === TOKEN) return next();
    res.status(401).json({ error: 'Missing or invalid token.' });
  });

  // -------------------------------------------------------------- static ---

  const HTML_PATH = path.join(config.repoRoot, 'vibecoder.html');

  app.get(['/', '/index.html', '/vibecoder.html'], async (_req, res) => {
    try {
      const html = await fsp.readFile(HTML_PATH, 'utf8');
      const injected = html.replace(
        '</head>',
        `<script>window.__VIBE_BACKEND__={url:location.origin,token:${JSON.stringify(TOKEN)}};</script>\n</head>`
      );
      res.type('html').send(injected);
    } catch (err) {
      res.status(500).send(`Could not read vibecoder.html: ${err.message}`);
    }
  });

  app.get('/favicon.png', (_req, res) => res.sendFile(path.join(config.repoRoot, 'favicon.png')));

  // -------------------------------------------------------------- status ---

  app.get('/api/status', (_req, res) => {
    res.json({
      ok: true,
      workspace: getWorkspaceRoot(),
      folderName: isFolderOpen() ? path.basename(getWorkspaceRoot()) : null,
      folderOpen: isFolderOpen(),
      shell: config.shell,
      terminal: ptyAvailable ? 'pty' : 'line',
      desktop: Boolean(process.versions.electron),
      cliAgents: availableCliAgents(),
      speech: transcriptionStatus(),
      media: mediaToolAvailable(),
      video: videoStatus({ force: true }),
      vercel: vercelStatus({ force: true }),
      scaffold: scaffoldStatus(),
      agent: { maxIterations: config.agent.maxIterations, allowBash: config.agent.allowBash },
      providers: Object.fromEntries(Object.keys(PROVIDERS).map((p) => [p, Boolean(config.keys[p])])),
    });
  });

  /**
   * Speech to text, entirely on this machine. The renderer records with
   * MediaRecorder and posts the raw blob; nothing is uploaded off the box.
   */
  app.post('/api/transcribe', (req, res) => {
    const chunks = [];
    let bytes = 0;
    const LIMIT = 60 * 1024 * 1024;   // ~an hour of Opus

    req.on('data', (c) => {
      bytes += c.length;
      if (bytes <= LIMIT) chunks.push(c);
    });
    req.on('error', () => res.status(400).json({ error: 'Upload failed.' }));
    req.on('end', async () => {
      if (bytes > LIMIT) return res.status(413).json({ error: 'Recording too long.' });
      if (!chunks.length) return res.status(400).json({ error: 'No audio received.' });
      const result = await transcribe(Buffer.concat(chunks), {
        model: req.query.model || 'base',
        language: req.query.language || undefined,
      });
      res.status(result.error ? 400 : 200).json(result);
    });
  });

  /** Render the project's HTML to MP4 with HyperFrames. */
  app.post('/api/video/render', async (req, res) => {
    const result = await renderVideo({ entry: req.body?.entry, out: req.body?.out });
    res.status(result.error ? 400 : 200).json(result);
  });

  /** Is a local Ollama running, and which models does it have? */
  app.get('/api/ollama', async (req, res) => {
    const status = await ollamaStatus({ baseUrl: req.query.baseUrl, force: req.query.force === '1' });
    res.json(status);
  });

  // ----------------------------------------------------------- workspace ---

  app.get('/api/workspace/root', (_req, res) => {
    res.json({ root: getWorkspaceRoot(), name: path.basename(getWorkspaceRoot()) });
  });

  app.post('/api/workspace/root', async (req, res) => {
    const next = req.body?.path;
    if (!next) return res.status(400).json({ error: 'A path is required.' });

    try {
      // The projects container holds many projects side by side. Opening it as
      // a workspace would load all of them at once — several projects' files
      // in one editor, and a preview with no idea which page it should render.
      // Tell the client to pick a project instead.
      if (path.resolve(next) === path.resolve(config.projectsHome)) {
        return res.status(409).json({
          error: 'That folder holds your projects. Pick one to open.',
          isProjectsHome: true,
        });
      }

      const root = openFolder(next);
      res.json({ root, name: path.basename(root) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  /** Create a project folder and write the editor's current files into it. */
  app.post('/api/projects/save', async (req, res) => {
    const files = Array.isArray(req.body?.files) ? req.body.files : [];
    try {
      const dir = safeProjectPath(req.body?.name);
      if (fs.existsSync(dir) && !req.body?.overwrite) {
        return res.status(409).json({ error: 'A project with that name already exists.' });
      }
      await fsp.mkdir(dir, { recursive: true });

      for (const file of files) {
        if (!file?.path || typeof file.content !== 'string') continue;
        const full = path.join(dir, file.path.replace(/^[\\/]+/, ''));
        if (!path.resolve(full).startsWith(path.resolve(dir))) continue;
        await fsp.mkdir(path.dirname(full), { recursive: true });
        await fsp.writeFile(full, file.content, 'utf8');
      }

      const root = openFolder(dir);
      res.json({ name: path.basename(root), path: root, written: files.length });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ------------------------------------------------------------ projects ---
  //
  // A project is a folder on disk, not a copy stashed in browser storage.
  // PROJECTS_HOME is the container those folders live in; opening a project
  // just points the workspace at one of them. That keeps "saved projects" and
  // "open folder" from being two competing sources of truth.

  function projectsHome() {
    return config.projectsHome;
  }

  function safeProjectPath(name) {
    const raw = String(name || '').trim();

    // Reject rather than sanitize. Stripping separators turns "../escape" into
    // the perfectly valid folder name "..escape", which then gets created and
    // opened — a silently wrong result is worse than an error.
    if (!raw) throw new Error('A project name is required.');
    if (raw.length > 80) throw new Error('That project name is too long.');
    if (/[<>:"/\\|?*\x00-\x1f]/.test(raw)) throw new Error('Project names cannot contain / \\ : * ? " < > |');
    if (raw.startsWith('.')) throw new Error('Project names cannot start with a dot.');

    const dir = path.join(projectsHome(), raw);
    const rel = path.relative(projectsHome(), dir);
    if (rel !== raw || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error('Invalid project name.');
    }
    return dir;
  }

  app.get('/api/projects', async (_req, res) => {
    try {
      const home = projectsHome();
      await fsp.mkdir(home, { recursive: true });
      const entries = await fsp.readdir(home, { withFileTypes: true });

      const projects = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const dir = path.join(home, entry.name);
        let count = 0;
        let modified = 0;
        try {
          const stat = await fsp.stat(dir);
          modified = stat.mtimeMs;
          count = (await fsp.readdir(dir)).filter((f) => !f.startsWith('.')).length;
        } catch { /* unreadable, still list it */ }
        projects.push({ name: entry.name, path: dir, files: count, modified });
      }

      projects.sort((a, b) => b.modified - a.modified);
      res.json({ home, projects, open: getWorkspaceRoot() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/projects', async (req, res) => {
    try {
      const dir = safeProjectPath(req.body?.name);
      if (fs.existsSync(dir)) return res.status(409).json({ error: 'A project with that name already exists.' });
      await fsp.mkdir(dir, { recursive: true });
      const root = openFolder(dir);
      res.json({ name: path.basename(root), path: root });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete('/api/projects', async (req, res) => {
    try {
      const dir = safeProjectPath(req.query.name);
      if (path.resolve(dir) === path.resolve(getWorkspaceRoot())) {
        return res.status(409).json({ error: 'That project is currently open. Open another one first.' });
      }
      await fsp.rm(dir, { recursive: true, force: true });
      res.json({ deleted: path.basename(dir) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get('/api/workspace/files', async (_req, res) => {
    try {
      const files = await walkWorkspace();
      const payload = [];
      let skipped = 0;

      const skippedDetail = [];

      for (const file of files) {
        const rel = toRelative(file);

        if (payload.length >= config.maxEditorFiles) {
          skipped++;
          skippedDetail.push({ path: rel, reason: 'over the file cap' });
          continue;
        }

        try {
          const stat = await fsp.stat(file);
          const bytes = await fsp.readFile(file);
          const asText = bytes.toString('utf8');

          // Decide by content, not extension. Extensions lie in both
          // directions — path.extname('.env.local') is '.local', which no
          // sensible list contains, and plenty of text files have no extension
          // at all. A NUL byte means binary; bytes that aren't valid UTF-8
          // would be corrupted if written back as text. Either case loads as an
          // asset: still in the project, still inlineable by the preview, and
          // never re-encoded (only non-asset files sync back to disk).
          const isText = !bytes.includes(0) && isValidUtf8(bytes);

          if (isText) {
            if (stat.size > config.maxEditorFileBytes) {
              skipped++;
              skippedDetail.push({ path: rel, reason: `text over ${Math.round(config.maxEditorFileBytes / 1024)} KB` });
              continue;
            }
            payload.push({ path: rel, content: asText, isAsset: false });
          } else {
            if (stat.size > config.maxAssetBytes) {
              skipped++;
              skippedDetail.push({ path: rel, reason: `asset over ${Math.round(config.maxAssetBytes / 1024 / 1024)} MB` });
              continue;
            }
            payload.push({
              path: rel,
              content: `data:${mimeFor(file)};base64,${bytes.toString('base64')}`,
              isAsset: true,
            });
          }
        } catch (err) {
          skipped++;
          skippedDetail.push({ path: rel, reason: err.code || 'unreadable' });
        }
      }

      res.json({ root: getWorkspaceRoot(), files: payload, skipped, skippedDetail });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/workspace/file', async (req, res) => {
    try {
      const full = await resolveInWorkspace(req.query.path);
      res.json({ path: toRelative(full), content: await fsp.readFile(full, 'utf8') });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  /**
   * Deleting and renaming have to reach the disk. The sync endpoint only ever
   * writes, so without these the file stays on disk and the folder watcher
   * pulls it straight back into the editor.
   */
  app.delete('/api/workspace/file', async (req, res) => {
    try {
      const full = await resolveInWorkspace(req.query.path);
      await fsp.rm(full, { force: true, recursive: false });
      res.json({ deleted: toRelative(full) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/workspace/rename', async (req, res) => {
    const { from, to } = req.body || {};
    if (!from || !to) return res.status(400).json({ error: 'from and to are required.' });
    try {
      const src = await resolveInWorkspace(from);
      const dest = await resolveInWorkspace(to);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.rename(src, dest);
      res.json({ from: toRelative(src), to: toRelative(dest) });
    } catch (err) {
      // A rename of a file the editor created but never flushed is not fatal;
      // the follow-up sync will write it at the new name.
      const code = err.code === 'ENOENT' ? 404 : 400;
      res.status(code).json({ error: err.message });
    }
  });

  /**
   * Stage an attachment into the open folder so the agent can reach it.
   *
   * Anything sizeable can't go into a prompt — no model has a 900 MB context —
   * so large or binary files are written into .vibe-attachments/ and the agent
   * is told the path. It then reads them with its own tools, which is how you
   * reference a big file rather than paste one.
   *
   * Streamed straight to disk so a large upload never sits in memory.
   */
  app.post('/api/attachments', (req, res) => {
    const name = String(req.query.name || 'attachment').split(/[\\/]/).pop();
    const limit = Number(req.query.limit) || 900 * 1024 * 1024;

    (async () => {
      const dir = path.join(getWorkspaceRoot(), '.vibe-attachments');
      await fsp.mkdir(dir, { recursive: true });

      // Never clobber an existing file.
      let target = path.join(dir, name);
      const ext = path.extname(name);
      const stem = path.basename(name, ext);
      for (let i = 1; fs.existsSync(target); i++) target = path.join(dir, `${stem}-${i}${ext}`);

      let tooBig = false;
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(target);
        let bytes = 0;

        req.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > limit && !tooBig) {
            tooBig = true;
            // Stop consuming, but do NOT destroy the socket — the client needs
            // to read the error response, and a destroyed socket surfaces as an
            // opaque "fetch failed" instead.
            req.unpipe(out);
            req.pause();
            out.destroy();
            fs.rm(target, { force: true }, () => {});
            resolve();
          }
        });

        req.on('error', reject);
        out.on('error', (err) => { if (!tooBig) reject(err); });
        out.on('finish', resolve);
        req.pipe(out);
      });

      if (tooBig) {
        req.resume();   // drain the rest so the response can be delivered
        return res.status(413).json({
          error: `Attachment exceeds ${Math.round(limit / 1024 / 1024)} MB.`,
        });
      }

      const stat = await fsp.stat(target);
      res.json({ path: toRelative(target), bytes: stat.size });
    })().catch((err) => {
      if (!res.headersSent) res.status(400).json({ error: err.message });
    });
  });

  /** Mirror the editor's buffers onto disk so the terminal/agent see them. */
  app.post('/api/workspace/sync', async (req, res) => {
    const files = Array.isArray(req.body?.files) ? req.body.files : [];
    const written = [];
    const failed = [];

    // Per file, not per batch: one buffer with a bad path used to abort the
    // whole sync, so every file after it silently stopped reaching disk while
    // the editor showed no error.
    for (const file of files) {
      if (!file?.path || typeof file.content !== 'string') continue;
      try {
        const full = await resolveInWorkspace(file.path);
        await fsp.mkdir(path.dirname(full), { recursive: true });
        await fsp.writeFile(full, file.content, 'utf8');
        written.push(toRelative(full));
      } catch (err) {
        failed.push({ path: file.path, error: err.message });
      }
    }

    res.json({ written, failed });
  });

  // --------------------------------------------------------------- agent ---

  /**
   * Plan a task without touching anything.
   *
   * Cheap model, read-only tools, one response. Nothing here can change a file,
   * so the answer is safe to show and throw away.
   */
  app.post('/api/plan', async (req, res) => {
    const {
      provider = 'anthropic', model, apiKey: clientKey, baseUrl,
      messages = [], previewContext,
    } = req.body || {};

    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });

    try {
      const folder = path.basename(getWorkspaceRoot());
      const projectMap = await buildProjectMap();

      const result = await buildPlan({
        provider,
        model,
        apiKey: clientKey || config.keys[provider],
        baseUrl,
        messages: withVolatileContext(messages, previewContext, folder, projectMap),
        previewContext: describePreviewContract(previewContext, folder) + projectMap,
        signal: controller.signal,
      });

      res.json(result);
    } catch (err) {
      // Planning is an optimisation, never a gate. If it breaks, the caller
      // runs the task directly rather than being blocked by it.
      res.json({ error: err?.message || String(err) });
    }
  });

  app.post('/api/agent', async (req, res) => {
    const {
      provider = 'anthropic',
      model,
      apiKey: clientKey,
      baseUrl,
      messages = [],
      system,
      useTools = true,
      sessionId,
      previewContext,
      // An approved plan, when the run came through the planning step.
      plan,
    } = req.body || {};

    // A key typed into Settings wins; otherwise fall back to server/.env.
    const apiKey = clientKey || config.keys[provider];

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    // Computed locally and handed over up front, so the agent does not spend
    // billed round-trips discovering what is already on disk.
    const projectMap = await buildProjectMap();

    const controller = new AbortController();
    // Abort on the RESPONSE closing, not the request. `req`'s close fires as
    // soon as the request body has been consumed — which for a buffered JSON
    // POST is immediately — so aborting on it killed every agent run the
    // instant it started. Guard on writableEnded so a normal finish isn't
    // mistaken for a disconnect.
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });

    const emit = (event) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    try {
      const folder = path.basename(getWorkspaceRoot());
      for await (const event of runAgent({
        provider,
        model,
        apiKey,
        baseUrl,
        // The system prompt is the cached prefix, so it must be byte-identical
        // across turns. Anything volatile — the viewport size, the file list —
        // rides on the newest user message instead. Mixing them meant every
        // pane resize silently invalidated the cache and re-billed the whole
        // prefix at full price.
        messages: withVolatileContext(
          messages, previewContext, folder, projectMap + planAsInstructions(plan)
        ),
        system: (system || SYSTEM_PROMPT) + COMPONENT_GUIDANCE,
        useTools,
        sessionId,
        previewContext: describePreviewContract(previewContext, folder)
          + projectMap + planAsInstructions(plan),
        // Claude Code owns the transcript; the client keeps its session id so
        // follow-up turns reattach to the same conversation.
        onSession: (id) => emit({ type: 'session', id }),
        signal: controller.signal,
      })) {
        emit(event);
      }
    } catch (err) {
      emit({ type: 'error', message: err?.message || String(err) });
    } finally {
      if (!res.writableEnded) res.end();
    }
  });

  /** Single-shot completion with no tools. */
  app.post('/api/chat', async (req, res) => {
    const { provider = 'anthropic', model, apiKey: clientKey, baseUrl, system, prompt } = req.body || {};
    const apiKey = clientKey || config.keys[provider];

    let text = '';
    try {
      for await (const event of runAgent({
        provider,
        model,
        apiKey,
        baseUrl,
        system: system || 'You are a concise, helpful assistant.',
        messages: [{ role: 'user', content: String(prompt ?? '') }],
        useTools: false,
      })) {
        if (event.type === 'text') text += event.text;
        if (event.type === 'error') return res.status(502).json({ error: event.message });
      }
      res.json({ text });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------- websockets ---

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });
  const watchers = new Set();

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.searchParams.get('token') !== TOKEN) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    if (url.pathname !== '/ws/pty' && url.pathname !== '/ws/files') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (url.pathname === '/ws/pty') {
        attachTerminal(ws, terminalOptions(url));
      } else {
        watchers.add(ws);
        ws.on('close', () => watchers.delete(ws));
      }
    });
  });

  /**
   * Every terminal is a plain shell. What makes the agent available is a
   * `claude` command placed on its PATH — so you start it the way you'd start
   * any CLI, and quitting it leaves you at a normal prompt.
   */
  function terminalOptions(url) {
    const port = server.address()?.port ?? config.port;
    const isClaudeTab = url.searchParams.get('mode') === 'agent';
    const cols = Number(url.searchParams.get('cols')) || 80;
    const rows = Number(url.searchParams.get('rows')) || 24;

    return {
      cols,
      rows,
      // The Claude Code tab is dedicated to it, so it launches on open — but
      // only if it's actually installed, otherwise the tab would greet you
      // with "command not found".
      bootstrap: isClaudeTab && cliAvailable('claude-code') ? 'claude' : null,
      autostart: isClaudeTab && cliAvailable('claude-code'),
      env: {
        // Appended, never prepended — an installed `claude`, `gemini` or any
        // other CLI on your PATH keeps priority.
        PATH: `${process.env.PATH || ''}${path.delimiter}${binDir}`,
        // The CLI is a separate process, so it needs the same connection
        // details and provider settings the UI is using.
        VIBE_URL: `http://127.0.0.1:${port}`,
        VIBE_TOKEN: TOKEN,
        VIBE_PROVIDER: url.searchParams.get('provider') || 'anthropic',
        VIBE_MODEL: url.searchParams.get('model') || '',
        VIBE_API_KEY: url.searchParams.get('apiKey') || '',
        VIBE_BASE_URL: url.searchParams.get('baseUrl') || '',
        VIBE_VERSION: APP_VERSION,
      },
    };
  }

  function broadcast(message) {
    for (const ws of watchers) {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
    }
  }

  // ------------------------------------------------------- folder watching ---

  let watcher = null;
  let watchTimer = null;
  const pendingChanges = new Set();

  function stopWatching() {
    if (watcher) {
      const dying = watcher;
      watcher = null;
      // Detach handlers before closing. A recursive fs.watch on Windows can
      // still deliver events into a closing handle, which trips a libuv
      // assertion and aborts the process rather than throwing.
      try { dying.removeAllListeners(); } catch { /* ignore */ }
      // unref before close: an abrupt process exit while a recursive watcher
      // handle is still closing trips a libuv assertion and aborts instead of
      // exiting. Open Folder replaces the watcher, so this is the common path.
      try { dying.unref(); } catch { /* not all platforms */ }
      try { dying.close(); } catch { /* already closed */ }
    }
    clearTimeout(watchTimer);
    watchTimer = null;
    pendingChanges.clear();
  }

  function startWatching() {
    stopWatching();

    const root = getWorkspaceRoot();
    // Before a folder is opened there is nothing to watch, and the scratch root
    // does not exist yet — watching it would only log a spurious failure.
    if (!isFolderOpen() || !fs.existsSync(root)) return;

    let burst = 0;

    try {
      watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
        // A deleted watch directory emits events in an unbounded loop —
        // ~100k/sec, enough to saturate this thread (which is also Electron's
        // main thread) on its own. Debouncing downstream isn't enough; the
        // storm has to be cut off at the source. One existsSync per 500 events
        // is nothing next to the storm it stops.
        if (++burst >= 500) {
          burst = 0;
          if (!fs.existsSync(root)) {
            stopWatching();
            broadcast({ t: 'root-missing', root });
            return;
          }
        }

        if (!filename) return;

        // When the watched directory is deleted, Windows reports absolute
        // paths — normalise before the filters, or they match nothing.
        let rel = filename.toString();
        if (path.isAbsolute(rel)) rel = path.relative(root, rel);
        rel = rel.split(path.sep).join('/');
        if (!rel || rel.startsWith('..')) return;
        if (rel.includes('node_modules') || rel.includes('.git/')) return;

        if (pendingChanges.size < 500) pendingChanges.add(rel);

        // Deliberately NOT a clearTimeout/setTimeout pair. A deleted watch
        // directory emits events in a tight unbounded loop (~100k/sec), which
        // re-arms a resettable debounce faster than it can ever fire — pinning
        // this thread, which is also Electron's main thread, at 100% forever.
        // A single trailing flush can't be starved that way.
        if (watchTimer) return;
        watchTimer = setTimeout(() => {
          watchTimer = null;

          // If the folder itself is gone, stop rather than spin on it.
          if (!fs.existsSync(root)) {
            stopWatching();
            broadcast({ t: 'root-missing', root });
            return;
          }

          const files = [...pendingChanges];
          pendingChanges.clear();
          if (files.length) broadcast({ t: 'changed', files });
        }, 250);
      });

      // fs.watch is an EventEmitter: an unhandled 'error' would throw out of
      // the event loop and take the whole app down.
      watcher.on('error', (err) => {
        console.warn(`[vibe] folder watch error: ${err.message}`);
        stopWatching();
      });
    } catch (err) {
      console.warn(`[vibe] file watching unavailable: ${err.message}`);
    }
  }

  /** Point the terminal, the agent and the editor at a different folder. */
  function openFolder(dir) {
    const previous = getWorkspaceRoot();
    const root = setWorkspaceRoot(dir);
    // Only churn the watcher when the folder actually changed — replacing it
    // needlessly leaves closing handles around that an abrupt process exit can
    // abort on.
    if (root !== previous) startWatching();
    broadcast({ t: 'root', root, name: path.basename(root) });
    return root;
  }

  startWatching();

  return {
    server,
    token: TOKEN,
    openFolder,
    getRoot: getWorkspaceRoot,
    listen: (port = config.port, host = config.host) =>
      new Promise((resolve) => server.listen(port, host, () => resolve(server.address()))),
    close: () => {
      stopWatching();
      for (const ws of watchers) ws.close();
      watchers.clear();
      wss.close();
      server.close();
    },
  };
}

// --------------------------------------------------------------- standalone ---

const runDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (runDirectly) {
  const instance = createServer();
  const address = await instance.listen();
  const url = `http://${config.host}:${address.port}/?token=${instance.token}`;
  const configured = Object.entries(config.keys).filter(([, v]) => v).map(([k]) => k);

  console.log('');
  console.log('  Vibe Coder backend');
  console.log('  ------------------');
  console.log(`  Open IDE   ${url}`);
  console.log(`  Folder     ${instance.getRoot()}`);
  console.log(`  Terminal   ${ptyAvailable ? 'node-pty (full TTY)' : 'line mode (node-pty not installed)'}`);
  console.log(`  Shell      ${config.shell}`);
  console.log(`  API keys   ${configured.length ? configured.join(', ') : 'none in .env - enter one in Settings'}`);
  console.log('');
}
