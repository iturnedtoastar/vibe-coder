import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import electron from 'electron';

/**
 * Launch the app with a clean environment.
 *
 * VS Code, Cursor and other Electron-based editors export
 * ELECTRON_RUN_AS_NODE=1 to their integrated terminals. Inherited, it makes the
 * electron binary run as plain Node — the window never opens and you get
 * "Cannot read properties of undefined (reading 'whenReady')". Stripping it
 * here means `npm start` behaves the same wherever you run it from.
 */
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const child = spawn(electron, [projectRoot, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
});

child.on('close', (code) => process.exit(code ?? 0));
child.on('error', (err) => {
  console.error('Failed to launch Electron:', err.message);
  process.exit(1);
});
