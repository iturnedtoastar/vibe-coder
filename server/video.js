import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { config, getWorkspaceRoot } from './config.js';
import { toRelative } from './sandbox.js';

/**
 * Video rendering and editing, both driven by tools that already speak
 * "folder of files" — the same model this IDE uses.
 *
 * HyperFrames (Apache-2.0) turns the HTML you're already writing into a
 * deterministic MP4. video-use (MIT) is a Claude Code skill that edits raw
 * footage in a folder, so it works through the Claude Code tab rather than
 * through us.
 *
 * Both are detected, never assumed. An advertised feature that always fails is
 * worse than one that says what's missing.
 */

const isWin = process.platform === 'win32';

/**
 * Resolve a command, preferring what this platform can actually execute.
 *
 * npm installs three shims side by side: `foo` (a bash script), `foo.cmd` and
 * `foo.ps1`. On Windows the extensionless one is first in PATH order but is not
 * executable — spawning it fails. Order the candidates by preference rather
 * than taking whatever `where` lists first.
 */
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
  return null;   // only a bash shim or a .cpl — not runnable here
}

let cache = null;

export function videoStatus({ force = false } = {}) {
  if (cache && !force) return cache;

  // HyperFrames needs Node 22+. Electron bundles Node 20, so it has to run on
  // the system Node — never process.execPath.
  const systemNode = which('node');
  let nodeMajor = 0;
  if (systemNode) {
    const v = spawnSync(systemNode, ['--version'], { encoding: 'utf8', windowsHide: true });
    nodeMajor = Number((v.stdout || '').match(/^v(\d+)/)?.[1] || 0);
  }

  // Installed locally in the open folder, or globally.
  const localBin = path.join(
    getWorkspaceRoot(), 'node_modules', '.bin', isWin ? 'hyperframes.cmd' : 'hyperframes'
  );
  const hyperframes = fs.existsSync(localBin) ? localBin : which('hyperframes');

  // video-use is a Claude Code skill; presence means the skill folder exists.
  const skillDirs = [
    path.join(process.env.USERPROFILE || process.env.HOME || '', '.claude', 'skills', 'video-use'),
    path.join(getWorkspaceRoot(), '.claude', 'skills', 'video-use'),
  ];
  const videoUse = skillDirs.find((d) => d && fs.existsSync(d)) || null;

  cache = {
    ffmpeg: Boolean(which('ffmpeg')),
    node: nodeMajor || null,
    nodeOk: nodeMajor >= 22,
    hyperframes: Boolean(hyperframes),
    hyperframesPath: hyperframes,
    videoUse: Boolean(videoUse),
    videoUsePath: videoUse,
    hints: {
      hyperframes: 'Install with: npm i -g hyperframes   (needs Node 22+ and ffmpeg)',
      videoUse: 'Clone browser-use/video-use into ~/.claude/skills, then use the Claude Code tab.',
    },
  };
  return cache;
}

/**
 * Render the project's HTML to MP4 with HyperFrames.
 * Returns { path } on success or { error }.
 */
export function renderVideo({ entry, out = 'video/out.mp4' } = {}) {
  const status = videoStatus({ force: true });

  if (!status.hyperframes) return Promise.resolve({ error: `HyperFrames is not installed. ${status.hints.hyperframes}` });
  if (!status.ffmpeg) return Promise.resolve({ error: 'ffmpeg is required to encode video.' });
  if (!status.nodeOk) {
    return Promise.resolve({
      error: `HyperFrames needs Node 22 or newer; found ${status.node ? 'v' + status.node : 'no system Node'}.`,
    });
  }

  const root = getWorkspaceRoot();
  const outPath = path.resolve(root, out);
  if (!outPath.startsWith(path.resolve(root))) {
    return Promise.resolve({ error: 'Output path escapes the open folder.' });
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const args = ['render', '--out', outPath];
  if (entry) args.push('--input', path.resolve(root, entry));

  // .cmd shims can't be spawned directly on Windows (CVE-2024-27980); route
  // through cmd.exe with an argv array so Node still quotes each argument.
  const needsShell = isWin && !status.hyperframesPath.toLowerCase().endsWith('.exe');
  const command = needsShell ? (process.env.ComSpec || 'cmd.exe') : status.hyperframesPath;
  const argv = needsShell ? ['/d', '/s', '/c', status.hyperframesPath, ...args] : args;

  return new Promise((resolve) => {
    const child = spawn(command, argv, { cwd: root, windowsHide: true, shell: false });
    let log = '';
    const push = (c) => { if (log.length < config.maxToolOutput) log += c.toString(); };
    child.stdout.on('data', push);
    child.stderr.on('data', push);

    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 900000);
    child.on('error', (err) => { clearTimeout(timer); resolve({ error: `Could not start HyperFrames: ${err.message}` }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && fs.existsSync(outPath)) {
        resolve({ path: toRelative(outPath), bytes: fs.statSync(outPath).size, log });
      } else {
        resolve({ error: `HyperFrames exited ${code}.\n${log.slice(-600)}` });
      }
    });
  });
}

/** Tool definition, offered only when HyperFrames can actually run. */
export const VIDEO_TOOL = {
  name: 'render_video',
  description:
    'Render the project\'s HTML page to an MP4 video with HyperFrames. Animations defined in CSS/GSAP/Lottie are captured deterministically. Returns the saved file path.',
  parameters: {
    type: 'object',
    properties: {
      entry: { type: 'string', description: 'HTML file to render. Defaults to the project entry.' },
      out: { type: 'string', description: 'Output path relative to the folder. Defaults to video/out.mp4.' },
    },
    required: [],
  },
};

export function videoToolAvailable() {
  const s = videoStatus();
  return s.hyperframes && s.ffmpeg && s.nodeOk;
}
