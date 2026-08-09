import { app, BrowserWindow, Menu, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * A packaged Windows app is a GUI-subsystem binary with no console, so an
 * unhandled startup error means the window silently never appears. Surface it.
 */
function fatal(context, err) {
  const detail = err?.stack || String(err);
  console.error(`[vibe] ${context}:`, detail);
  dialog.showErrorBox('Vibe Coder failed to start', `${context}\n\n${detail}`);
  app.exit(1);
}

process.on('uncaughtException', (err) => fatal('Unexpected error', err));
process.on('unhandledRejection', (err) => fatal('Unexpected error', err));

let backend = null;
let mainWindow = null;
let port = 0;

/** Remember the last opened folder between launches. */
const statePath = () => path.join(app.getPath('userData'), 'state.json');

function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeState(patch) {
  try {
    fs.writeFileSync(statePath(), JSON.stringify({ ...readState(), ...patch }, null, 2));
  } catch {
    /* not fatal */
  }
}

/**
 * The folder that was open last, if it still exists. Nothing is opened or
 * created automatically at launch — the app starts on its welcome screen and
 * the user chooses.
 */
function lastFolder() {
  const remembered = readState().lastFolder;
  return remembered && fs.existsSync(remembered) ? remembered : null;
}

function setFolder(dir) {
  const root = backend.openFolder(dir);
  writeState({ lastFolder: root });
  return root;
}

async function chooseFolder() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Folder',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: backend.getRoot(),
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const root = setFolder(result.filePaths[0]);
  return { root, name: path.basename(root) };
}

const isMac = process.platform === 'darwin';

/**
 * macOS keeps its menu in the system bar, so it gets a real one. Windows and
 * Linux draw the menu *inside* the window, which is exactly the strip of chrome
 * we're removing — so there it's dropped and the shortcuts are bound directly
 * to the window instead.
 */
function buildMenu() {
  if (!isMac) {
    Menu.setApplicationMenu(null);
    return;
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    {
      label: 'File',
      submenu: [
        { label: 'Open Folder…', accelerator: 'CmdOrCtrl+O', click: chooseFolder },
        { label: 'Reveal Folder in Finder', click: () => shell.openPath(backend.getRoot()) },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' }, { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]));
}

/** Menu accelerators, minus the menu. */
function bindShortcuts(win) {
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const mod = process.platform === 'darwin' ? input.meta : input.control;
    if (!mod) return;

    const key = input.key.toLowerCase();
    const consume = (fn) => { event.preventDefault(); fn(); };

    if (key === 'o' && !input.shift) consume(chooseFolder);
    else if (key === 'i' && input.shift) consume(() => win.webContents.toggleDevTools());
    else if (key === 'r' && !input.shift) consume(() => win.webContents.reload());
    else if (key === '=' || key === '+') consume(() => win.webContents.setZoomLevel(win.webContents.getZoomLevel() + 0.5));
    else if (key === '-') consume(() => win.webContents.setZoomLevel(win.webContents.getZoomLevel() - 0.5));
    else if (key === '0') consume(() => win.webContents.setZoomLevel(0));
  });
}

/**
 * Height of the app's own header strip. The Windows control overlay is given
 * the same height so minimise/maximise/close line up with the toolbar buttons
 * instead of floating above them. Keep in sync with --titlebar-height in the CSS.
 */
const TITLEBAR_HEIGHT = 52;

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 720,
    minHeight: 600,
    backgroundColor: '#121212',
    show: false,
    title: 'Vibe Coder',
    icon: path.join(here, '..', 'favicon.png'),

    // No OS title bar. On Windows/Linux the OS still draws the window controls
    // as an overlay; on macOS the traffic lights are inset over our header.
    titleBarStyle: 'hidden',
    ...(isMac
      ? { trafficLightPosition: { x: 16, y: 18 } }
      : {
          titleBarOverlay: {
            color: '#00000000',
            symbolColor: '#e5e5e5',
            height: TITLEBAR_HEIGHT,
          },
        }),

    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  bindShortcuts(mainWindow);
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Keep navigation inside the app; send real links to the system browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // The page sets its own <title>; keep the window and taskbar label fixed.
  mainWindow.on('page-title-updated', (event) => event.preventDefault());
  await mainWindow.loadURL(`http://127.0.0.1:${port}/?token=${backend.token}`);
  mainWindow.setTitle('Vibe Coder');
}

app.whenReady().then(async () => {
  try {
    // Imported here rather than at the top so a failure inside the backend
    // surfaces as a dialog instead of killing the process before app.whenReady.
    const { createServer } = await import('../server/server.js');

    // The backend runs in this same process on a random loopback port. Nothing
    // is exposed to the network and there is no setup step for the user.
    backend = createServer({ version: app.getVersion() });
    const address = await backend.listen(0, '127.0.0.1');
    port = address.port;

    // Deliberately no openFolder() here: launching must not open or create
    // anything. The welcome screen offers the last project, other projects, or
    // a blank start.

    ipcMain.handle('vibe:open-folder', chooseFolder);
    ipcMain.handle('vibe:get-folder', () => ({
      root: backend.getRoot(),
      name: path.basename(backend.getRoot()),
    }));
    ipcMain.handle('vibe:last-folder', () => {
      const remembered = lastFolder();
      return remembered ? { path: remembered, name: path.basename(remembered) } : null;
    });
    ipcMain.handle('vibe:remember-folder', (_e, dir) => {
      if (dir) writeState({ lastFolder: dir });
      else writeState({ lastFolder: null });
      return true;
    });
    ipcMain.handle('vibe:reveal-folder', () => shell.openPath(backend.getRoot()));

    /**
     * Wipe everything the app stores about itself: editor state, settings and
     * cached data. Project folders on disk are never touched — deleting a
     * user's actual work from a "clear cache" button would be indefensible.
     */
    ipcMain.handle('vibe:reset-app', async () => {
      writeState({ lastFolder: null });
      try {
        await mainWindow.webContents.session.clearStorageData({
          storages: ['localstorage', 'indexdb', 'cachestorage', 'websql', 'serviceworkers'],
        });
        await mainWindow.webContents.session.clearCache();
      } catch (err) {
        return { ok: false, error: err.message };
      }
      return { ok: true };
    });

    buildMenu();
    await createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  } catch (err) {
    fatal('The backend could not start', err);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => backend?.close());
