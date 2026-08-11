import path from 'node:path';
import { spawn } from 'node:child_process';

/**
 * The app's entry point, whose only job is to make sure we are actually
 * running as Electron before anything imports Electron.
 *
 * VS Code exports ELECTRON_RUN_AS_NODE=1 into its integrated terminal, and
 * every process launched from there inherits it — including the installed
 * app, if you start it from a terminal or from anything spawned by one. Our
 * binary then boots as plain Node instead of Electron: `import ... from
 * 'electron'` resolves to a path string with no named exports, the import
 * fails before a single line of our code runs, and the process exits having
 * printed nothing at all. From the outside the app simply does not open.
 *
 * This has to be its own file. ESM hoists every import above the module body,
 * so a guard sitting at the top of main.js still runs *after* the electron
 * import that it exists to prevent. Nothing here may import Electron,
 * directly or transitively.
 *
 * What this covers: `node .`, `electron .`, and anything else that resolves
 * this package's entry point. `desktop/launch.js` covers `npm start`.
 *
 * What it cannot cover: the packaged .exe invoked with no arguments. In that
 * mode the binary is literally Node, and Node with no script reads stdin and
 * exits — package.json `main` is never consulted, so no code of ours runs at
 * any point. That case is unfixable from JavaScript; see the launch note in
 * README.md.
 */
if (process.env.ELECTRON_RUN_AS_NODE) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  // Packaged, the executable knows its own entry point and must be handed no
  // script argument. Unpackaged it is electron.exe, which needs the app path
  // it was originally given.
  const isElectronBinary = /^electron(\.exe)?$/i.test(path.basename(process.execPath));
  const args = isElectronBinary ? process.argv.slice(1) : [];

  spawn(process.execPath, args, { env, detached: true, stdio: 'ignore' }).unref();
  process.exit(0);
}

await import('./main.js');
