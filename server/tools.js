import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { config, getWorkspaceRoot } from './config.js';
import { resolveInWorkspace, toRelative, walkWorkspace, SandboxError } from './sandbox.js';
import { renderVideo, videoToolAvailable, VIDEO_TOOL } from './video.js';
import { deployToVercel, connectVercelGit, vercelToolsAvailable, VERCEL_TOOLS } from './vercel.js';

/**
 * Canonical tool definitions. Each provider adapter translates this shape into
 * its own wire format, so the agent loop stays provider-agnostic.
 */
export const TOOL_DEFS = [
  {
    name: 'list_files',
    description:
      'List files in the workspace. Use this first to understand the project layout. Returns workspace-relative paths.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory to list, relative to the workspace root. Defaults to the root.',
        },
      },
      required: [],
    },
  },
  {
    name: 'read_file',
    description:
      'Read the full contents of a file in the workspace. Call this before editing a file so you are working from its current contents.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description:
      'Create a file, or overwrite one completely. Provide the entire final contents — never a fragment or a placeholder like "// rest unchanged". For a small change to a large existing file, prefer edit_file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root.' },
        content: { type: 'string', description: 'The complete file contents.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description:
      'Replace one exact occurrence of a string in a file. old_string must match the file byte-for-byte including indentation, and must appear exactly once. Fails if it appears zero or multiple times.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root.' },
        old_string: { type: 'string', description: 'Exact text to replace.' },
        new_string: { type: 'string', description: 'Replacement text.' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'delete_file',
    description: 'Delete a file from the workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'search',
    description:
      'Search file contents across the workspace with a regular expression. Returns matching lines with their file and line number.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'JavaScript regular expression source.' },
        glob: {
          type: 'string',
          description: 'Optional file-extension filter, e.g. "js" or "ts,tsx".',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'run_command',
    description:
      'Run a shell command inside the workspace sandbox (npm, node, git, etc.). Returns combined stdout and stderr plus the exit code. The working directory is always the workspace root.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command line to execute.' },
      },
      required: ['command'],
    },
  },
];

/**
 * Fetching media with yt-dlp, offered only when it's actually installed — an
 * advertised tool that always fails is worse than no tool.
 */
const MEDIA_TOOL = {
  name: 'download_media',
  description:
    'Download a video or audio track from a URL into the open folder using yt-dlp. Use for sourcing media assets a project needs. Returns the saved file path.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The page or media URL.' },
      audioOnly: { type: 'boolean', description: 'Extract audio only (mp3).' },
      path: { type: 'string', description: 'Destination folder, relative to the workspace. Defaults to "media".' },
    },
    required: ['url'],
  },
};

let mediaCache = null;
export function mediaToolAvailable() {
  if (mediaCache !== null) return mediaCache;
  const probe = process.platform === 'win32' ? 'where' : 'which';
  const res = spawnSync(probe, ['yt-dlp'], { encoding: 'utf8', shell: false, windowsHide: true });
  mediaCache = res.status === 0 && Boolean(res.stdout?.trim());
  return mediaCache;
}

export function availableTools() {
  const tools = config.agent.allowBash
    ? [...TOOL_DEFS]
    : TOOL_DEFS.filter((t) => t.name !== 'run_command');
  if (mediaToolAvailable()) tools.push(MEDIA_TOOL);
  if (videoToolAvailable()) tools.push(VIDEO_TOOL);
  if (vercelToolsAvailable()) tools.push(...VERCEL_TOOLS);
  return tools;
}

function truncate(text) {
  const limit = config.maxToolOutput;
  if (text.length <= limit) return text;
  return (
    text.slice(0, limit) +
    `\n\n[...truncated, ${text.length - limit} more characters. Narrow the request if you need the rest.]`
  );
}

const IMPLS = {
  async list_files({ path: dir }) {
    const root = dir ? await resolveInWorkspace(dir) : getWorkspaceRoot();
    const files = await walkWorkspace(root);
    if (files.length === 0) return 'The folder is empty.';
    return files.map(toRelative).sort().join('\n');
  },

  async read_file({ path: p }) {
    const full = await resolveInWorkspace(p);
    const stat = await fs.stat(full);
    if (stat.isDirectory()) throw new Error(`${toRelative(full)} is a directory, not a file.`);
    if (stat.size > 2_000_000) throw new Error(`${toRelative(full)} is too large to read.`);
    return truncate(await fs.readFile(full, 'utf8'));
  },

  async write_file({ path: p, content }) {
    if (typeof content !== 'string') throw new Error('content must be a string.');
    const full = await resolveInWorkspace(p);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf8');
    return `Wrote ${content.length} characters to ${toRelative(full)}.`;
  },

  async edit_file({ path: p, old_string, new_string }) {
    const full = await resolveInWorkspace(p);
    const current = await fs.readFile(full, 'utf8');
    const first = current.indexOf(old_string);
    if (first === -1) {
      throw new Error(
        `old_string was not found in ${toRelative(full)}. Read the file again and match it exactly.`
      );
    }
    if (current.indexOf(old_string, first + 1) !== -1) {
      throw new Error(
        `old_string appears more than once in ${toRelative(full)}. Include more surrounding context to make it unique.`
      );
    }
    await fs.writeFile(full, current.replace(old_string, new_string), 'utf8');
    return `Edited ${toRelative(full)}.`;
  },

  async delete_file({ path: p }) {
    const full = await resolveInWorkspace(p);
    await fs.rm(full, { force: false });
    return `Deleted ${toRelative(full)}.`;
  },

  async search({ pattern, glob }) {
    let re;
    try {
      re = new RegExp(pattern, 'i');
    } catch {
      throw new Error(`Invalid regular expression: ${pattern}`);
    }
    const exts = glob
      ? glob.split(',').map((e) => '.' + e.trim().replace(/^[.*]+/, ''))
      : null;

    const files = await walkWorkspace();
    const hits = [];
    for (const file of files) {
      if (exts && !exts.includes(path.extname(file))) continue;
      let text;
      try {
        text = await fs.readFile(file, 'utf8');
      } catch {
        continue;
      }
      text.split('\n').forEach((line, i) => {
        if (hits.length < 200 && re.test(line)) {
          hits.push(`${toRelative(file)}:${i + 1}: ${line.trim().slice(0, 300)}`);
        }
      });
    }
    return hits.length ? truncate(hits.join('\n')) : `No matches for /${pattern}/.`;
  },

  async download_media({ url, audioOnly, path: dest }) {
    if (!mediaToolAvailable()) throw new Error('yt-dlp is not installed.');
    if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('A http(s) URL is required.');

    const target = await resolveInWorkspace(dest || 'media');
    await fs.mkdir(target, { recursive: true });

    const args = ['--no-playlist', '--restrict-filenames', '-P', target, '-o', '%(title)s.%(ext)s'];
    if (audioOnly) args.push('-x', '--audio-format', 'mp3');
    args.push(String(url));

    return new Promise((resolve) => {
      const child = spawn('yt-dlp', args, { cwd: getWorkspaceRoot(), windowsHide: true, shell: false });
      let out = '';
      const push = (c) => { if (out.length < config.maxToolOutput) out += c.toString(); };
      child.stdout.on('data', push);
      child.stderr.on('data', push);

      const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 600000);
      child.on('error', (err) => { clearTimeout(timer); resolve(`yt-dlp failed to start: ${err.message}`); });
      child.on('close', (code) => {
        clearTimeout(timer);
        const saved = out.match(/\[download\] Destination: (.+)/)?.[1]
          || out.match(/\[ExtractAudio\] Destination: (.+)/)?.[1];
        resolve(code === 0
          ? `Downloaded to ${saved ? toRelative(saved.trim()) : toRelative(target)}.\n${truncate(out)}`
          : truncate(`yt-dlp exited ${code}\n${out}`));
      });
    });
  },

  async deploy_vercel({ production, name }) {
    const result = await deployToVercel({ production: Boolean(production), name });
    if (result.error) throw new Error(result.error);
    return `Deployed to ${result.url}${result.production ? ' (production)' : ' (preview)'}.`
      + (result.createdConfig ? '\nAdded vercel.json for this static project.' : '');
  },

  async connect_vercel_git() {
    const result = await connectVercelGit();
    if (result.error) throw new Error(result.error);
    return `Linked to ${result.remote}. Pushes to that repo now deploy automatically.`;
  },

  async render_video({ entry, out }) {
    const result = await renderVideo({ entry, out });
    if (result.error) throw new Error(result.error);
    return `Rendered ${result.path} (${Math.round(result.bytes / 1024)} KB).`;
  },

  run_command({ command }) {
    if (!config.agent.allowBash) throw new Error('Command execution is disabled on this server.');
    if (typeof command !== 'string' || !command.trim()) throw new Error('command is required.');

    return new Promise((resolve) => {
      const isWin = process.platform === 'win32';
      const child = spawn(
        config.shell,
        isWin ? ['-NoProfile', '-NonInteractive', '-Command', command] : ['-lc', command],
        { cwd: getWorkspaceRoot(), env: { ...process.env, NO_COLOR: '1' }, windowsHide: true }
      );

      let out = '';
      const push = (chunk) => {
        if (out.length < config.maxToolOutput * 2) out += chunk.toString();
      };
      child.stdout.on('data', push);
      child.stderr.on('data', push);

      const timer = setTimeout(() => {
        child.kill();
        out += `\n[Command timed out after ${config.commandTimeoutMs}ms and was killed.]`;
      }, config.commandTimeoutMs);

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve(`Failed to start command: ${err.message}`);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve(truncate(`$ ${command}\n${out.trim() || '(no output)'}\n\n[exit code ${code}]`));
      });
    });
  },
};

/**
 * Execute one tool call. Never throws — failures come back as
 * `{ ok: false, content }` so they can be handed to the model as an error
 * tool result and recovered from.
 */
export async function executeTool(name, input) {
  const impl = IMPLS[name];
  if (!impl) return { ok: false, content: `Unknown tool: ${name}` };
  try {
    const content = await impl(input || {});
    return { ok: true, content: String(content) };
  } catch (err) {
    const prefix = err instanceof SandboxError ? 'Sandbox violation' : 'Error';
    return { ok: false, content: `${prefix}: ${err.message}` };
  }
}
