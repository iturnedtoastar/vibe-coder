import { spawn } from 'node:child_process';

/**
 * Spawn a command that might be a Windows shim.
 *
 * Node refuses to spawn .cmd/.bat directly (CVE-2024-27980), so those have to
 * go through cmd.exe. But cmd.exe does its own parsing: handed
 * `C:\Program Files\nodejs\npx.cmd` as a plain argv entry it splits at the
 * space and reports `'C:\Program' is not recognized`. Node's own quoting does
 * not help, because it quotes for a normal program, not for cmd.
 *
 * The fix is to build the command line ourselves — every token quoted, the
 * whole line wrapped in one more pair — and pass it verbatim. With `/s`,
 * cmd.exe strips exactly that outer pair and runs the rest as written.
 */

const isWin = process.platform === 'win32';

/** Quote a single token for cmd.exe. */
function quote(token) {
  const value = String(token);
  if (value === '') return '""';
  // Escape any embedded quotes, then wrap if there's anything cmd would split on.
  const escaped = value.replace(/"/g, '\\"');
  return /[\s&|<>^()"]/.test(value) ? `"${escaped}"` : escaped;
}

export function needsShim(binPath) {
  return isWin && !/\.(exe|com)$/i.test(binPath || '');
}

/**
 * Spawn `bin` with `args`, routing through cmd.exe only when required.
 * Returns a ChildProcess, same as child_process.spawn.
 */
export function spawnCommand(bin, args = [], options = {}) {
  if (!needsShim(bin)) {
    return spawn(bin, args, { windowsHide: true, ...options });
  }

  const line = [bin, ...args].map(quote).join(' ');
  return spawn(
    process.env.ComSpec || 'cmd.exe',
    ['/d', '/s', '/c', `"${line}"`],
    { windowsHide: true, ...options, windowsVerbatimArguments: true }
  );
}
