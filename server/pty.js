import { spawn } from 'node:child_process';
import { config, getWorkspaceRoot, ensureWorkspaceExists } from './config.js';

/**
 * node-pty is a native module. It ships prebuilt binaries for common
 * platforms, but if the install failed (no build toolchain) we fall back to a
 * line-oriented shell bridge: real commands with real output, just no
 * interactive TTY (so no vim, no interactive prompts).
 */
let nodePty = null;
try {
  nodePty = (await import('node-pty')).default ?? (await import('node-pty'));
} catch {
  nodePty = null;
}

export const ptyAvailable = Boolean(nodePty?.spawn);

const isWin = process.platform === 'win32';

function shellArgs(command) {
  return isWin
    ? ['-NoProfile', '-NonInteractive', '-Command', command]
    : ['-lc', command];
}

/**
 * Attach a websocket to a terminal session.
 *
 * Wire protocol (JSON both directions):
 *   client -> { t:'i', d }        keystroke input        (pty mode)
 *   client -> { t:'c', d }        whole command line     (line mode)
 *   client -> { t:'r', c, r }     resize
 *   client -> { t:'k' }           interrupt current command
 *   server -> { t:'ready', mode, cwd, shell }
 *   server -> { t:'o', d }        output
 *   server -> { t:'exit', code }  command / shell ended
 */
export function attachTerminal(ws, options = {}) {
  const send = (msg) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  // This runs synchronously inside the websocket upgrade callback, so a throw
  // here is uncatchable by the caller and would reach uncaughtException — which
  // the Electron shell turns into "quit the app". A terminal that can't start
  // must degrade to an error in that tab, never take the IDE with it.
  try {
    if (ptyAvailable) {
      attachPty(ws, send, options);
    } else {
      attachLineShell(ws, send, options);
    }
  } catch (err) {
    send({ t: 'o', d: `\r\n\x1b[31mCould not start a shell: ${err.message}\x1b[0m\r\n` });
    send({ t: 'exit', code: 1 });
    try { ws.close(); } catch { /* already closing */ }
  }
}

function attachPty(ws, send, { bootstrap, env: extraEnv, cols = 80, rows = 24, autostart } = {}) {
  // Nothing is created until it's needed, so the scratch root may not exist
  // yet — spawning into a missing cwd throws.
  ensureWorkspaceExists();
  const shell = config.shell;
  const term = nodePty.spawn(shell, isWin ? ['-NoLogo'] : [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: getWorkspaceRoot(),
    env: {
      ...process.env,
      ...extraEnv,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    },
  });

  send({ t: 'ready', mode: 'pty', cwd: getWorkspaceRoot(), shell, autostart: Boolean(autostart) });

  // Start a program in the fresh shell (used by the dedicated Claude Code
  // tab). It's a normal shell underneath, so quitting that program leaves the
  // user at a prompt where npm/git/node all work. `clear` first so the shell's
  // own banner doesn't sit above the TUI.
  if (bootstrap) {
    const clear = isWin ? 'Clear-Host; ' : 'clear; ';
    setTimeout(() => term.write(`${clear}${bootstrap}\r`), isWin ? 500 : 150);
  }

  // ws.close() is an async handshake, so messages can still arrive after the
  // pty is gone. resize() on a dead pty throws ("Cannot resize a pty that has
  // already exited") — and xterm's fit addon fires on every layout change, so
  // closing a terminal mid-drag would otherwise crash the app.
  let alive = true;

  term.onData((data) => send({ t: 'o', d: data }));
  term.onExit(({ exitCode }) => {
    alive = false;
    send({ t: 'exit', code: exitCode });
    if (ws.readyState === ws.OPEN) ws.close();
  });

  ws.on('message', (raw) => {
    if (!alive) return;
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    try {
      if (msg.t === 'i') term.write(msg.d);
      else if (msg.t === 'r') term.resize(Math.max(2, msg.c | 0), Math.max(2, msg.r | 0));
      else if (msg.t === 'k') term.write('\x03');
    } catch {
      alive = false;   // the pty died between our check and the write
    }
  });

  ws.on('close', () => {
    alive = false;
    try {
      term.kill();
    } catch {
      /* already gone */
    }
  });
}

function attachLineShell(ws, send, { env: extraEnv } = {}) {
  ensureWorkspaceExists();
  let running = null;
  const childEnv = { ...process.env, ...extraEnv };

  send({
    t: 'ready',
    mode: 'line',
    cwd: getWorkspaceRoot(),
    shell: config.shell,
    note: 'node-pty is not installed - running in line mode. Commands work; interactive TTY programs do not.',
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.t === 'k') {
      if (running) running.kill();
      return;
    }
    if (msg.t !== 'c') return;

    const command = String(msg.d || '').trim();
    if (!command) {
      send({ t: 'exit', code: 0 });
      return;
    }
    if (running) {
      send({ t: 'o', d: '\r\n\x1b[33mA command is already running.\x1b[0m\r\n' });
      return;
    }

    const child = spawn(config.shell, shellArgs(command), {
      cwd: getWorkspaceRoot(),
      env: childEnv,
      windowsHide: true,
    });
    running = child;

    const forward = (chunk) => send({ t: 'o', d: chunk.toString().replace(/\n/g, '\r\n') });
    child.stdout.on('data', forward);
    child.stderr.on('data', forward);

    child.on('error', (err) => {
      send({ t: 'o', d: `\x1b[31m${err.message}\x1b[0m\r\n` });
    });
    child.on('close', (code) => {
      running = null;
      send({ t: 'exit', code });
    });
  });

  ws.on('close', () => {
    if (running) running.kill();
  });
}
