import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';

/**
 * Speech to text with Whisper, running locally.
 *
 * Browser audio arrives as WebM/Opus, which Whisper can't read directly, so
 * ffmpeg converts it to the 16 kHz mono WAV Whisper expects. Everything stays
 * on this machine — no audio is uploaded anywhere.
 *
 * Several Whisper builds are in the wild and their CLIs differ; each is probed
 * in turn rather than assuming one is installed.
 */

const isWin = process.platform === 'win32';

/**
 * Only distinctive names. whisper.cpp's own binary used to be called `main`,
 * but probing for that is reckless: on Windows it resolves to
 * C:\Windows\System32\main.cpl — the Mouse control panel — which would then be
 * handed your recording. A generic name is not evidence of the right program.
 */
const WHISPER_BUILDS = [
  // openai-whisper (Python): writes <name>.txt into an output dir
  { bin: 'whisper', kind: 'openai' },
  // faster-whisper CLI, same surface
  { bin: 'faster-whisper', kind: 'openai' },
  // whisper.cpp: prints to stdout with -nt (no timestamps)
  { bin: 'whisper-cli', kind: 'cpp' },
  { bin: 'whisper-cpp', kind: 'cpp' },
];

/**
 * Prefer what this platform can actually execute. `where` happily returns
 * .cpl control panels and npm's extensionless bash shims, neither of which
 * can be spawned on Windows.
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
  return null;
}

let cache = null;

/** Which Whisper build (if any) and whether ffmpeg is present. */
export function transcriptionStatus() {
  if (cache) return cache;

  let build = null;
  for (const candidate of WHISPER_BUILDS) {
    const found = which(candidate.bin);
    if (found) { build = { ...candidate, path: found }; break; }
  }

  cache = {
    available: Boolean(build),
    build: build?.bin || null,
    kind: build?.kind || null,
    ffmpeg: Boolean(which('ffmpeg')),
    hint: 'Install with: pip install -U openai-whisper  (needs ffmpeg, which you have)',
  };
  return cache;
}

function run(command, args, { cwd, timeoutMs = 180000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, windowsHide: true, shell: false });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c.toString(); });
    child.stderr.on('data', (c) => { err += c.toString(); });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: err + e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

/**
 * Transcribe a recorded audio buffer. Returns { text } or { error }.
 */
export async function transcribe(buffer, { model = 'base', language } = {}) {
  const status = transcriptionStatus();
  if (!status.available) return { error: `Whisper is not installed. ${status.hint}` };
  if (!status.ffmpeg) return { error: 'ffmpeg is required to convert recorded audio.' };

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vibe-stt-'));
  const source = path.join(dir, 'input.webm');
  const wav = path.join(dir, 'input.wav');

  try {
    await fsp.writeFile(source, buffer);

    // Whisper wants 16 kHz mono PCM.
    const conv = await run('ffmpeg', ['-i', source, '-ar', '16000', '-ac', '1', '-f', 'wav', wav, '-y']);
    if (conv.code !== 0 || !fs.existsSync(wav)) {
      return { error: `Could not decode the recording: ${conv.err.slice(-300)}` };
    }

    if (status.kind === 'cpp') {
      const res = await run(status.build, ['-f', wav, '-nt']);
      const text = res.out.replace(/\[[^\]]*\]/g, '').trim();
      return text ? { text } : { error: res.err.slice(-300) || 'No speech detected.' };
    }

    const args = [wav, '--model', model, '--output_format', 'txt', '--output_dir', dir, '--fp16', 'False'];
    if (language) args.push('--language', language);
    const res = await run(status.build, args);

    const txt = path.join(dir, 'input.txt');
    if (fs.existsSync(txt)) {
      const text = (await fsp.readFile(txt, 'utf8')).trim();
      if (text) return { text };
    }
    // Some builds print the transcript instead of writing a file.
    const spoken = res.out.replace(/^\[[^\]]*\]\s*/gm, '').trim();
    if (spoken) return { text: spoken };

    return { error: res.err.slice(-300) || 'No speech detected.' };
  } catch (err) {
    return { error: err.message };
  } finally {
    fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
