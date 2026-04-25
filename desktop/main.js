// Electron main process for BuildID host.
// Owns: control window, screen-source enumeration, native input injection.
// Rendering/WebRTC happens in the renderer (which has navigator.mediaDevices).

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { app, BrowserWindow, desktopCapturer, ipcMain, screen, session, dialog } = require('electron');
const path = require('node:path');
const { dispatchInput, setBaseDisplay } = require('./src/input');
const trustStore = require('./src/trustStore');
const { hashTrustSecret } = require('./src/hash');

const SIGNALING_URL = process.env.SIGNALING_URL || process.env.PUBLIC_HOST || 'http://localhost:8080';
const VIEWER_URL = process.env.PUBLIC_HOST || SIGNALING_URL;

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 460,
    height: 560,
    resizable: false,
    title: 'BuildID',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: false, // we need preload to require electron modules
      nodeIntegration: false,
      backgroundThrottling: false, // keep WebRTC running when window is in background
    },
  });
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.webContents.openDevTools({ mode: 'detach' });
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.send('config', { signalingUrl: SIGNALING_URL, viewerUrl: VIEWER_URL });
  });
}

// Required on newer Chromium for desktop capture without a system picker.
app.whenReady().then(() => {
  trustStore.init(app.getPath('userData'));

  // Make outgoing requests to the signaling server look like they came from the
  // viewer origin (which is on the server's CORS allowlist). The renderer is
  // loaded from file:// so Chromium otherwise tags requests with `Origin: null`
  // which trips CORS regardless of server policy. Also force permissive CORS
  // headers on responses so Chromium accepts them in the file:// renderer.
  try {
    const sigOrigin = new URL(SIGNALING_URL).origin;
    const stampedOrigin = new URL(VIEWER_URL).origin;
    // Match HTTP(S) AND WebSocket (ws/wss) upgrades. Electron's webRequest
    // surfaces WS handshakes under the ws:// or wss:// scheme, so the plain
    // https://host/* filter would miss them and Origin would stay as the
    // file:// renderer's "null", failing the server CORS check.
    const sigUrl = new URL(SIGNALING_URL);
    const wsScheme = sigUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsOrigin = `${wsScheme}//${sigUrl.host}`;
    const filter = { urls: [`${sigOrigin}/*`, `${wsOrigin}/*`] };

    session.defaultSession.webRequest.onBeforeSendHeaders(filter, (details, cb) => {
      details.requestHeaders['Origin'] = stampedOrigin;
      cb({ requestHeaders: details.requestHeaders });
    });

    session.defaultSession.webRequest.onHeadersReceived(filter, (details, cb) => {
      const headers = { ...details.responseHeaders };
      for (const k of Object.keys(headers)) {
        if (/^access-control-/i.test(k)) delete headers[k];
      }
      headers['Access-Control-Allow-Origin'] = ['*'];
      headers['Access-Control-Allow-Methods'] = ['GET, POST, OPTIONS'];
      headers['Access-Control-Allow-Headers'] = ['*'];
      cb({ responseHeaders: headers });
    });
  } catch (e) {
    console.warn('[BuildID] could not install signaling header rewrites:', e.message);
  }

  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
        // Pick the primary screen by default.
        callback({ video: sources[0], audio: 'loopback' });
      });
    },
    { useSystemPicker: false },
  );

  // Prime input mapper with primary display bounds.
  const primary = screen.getPrimaryDisplay();
  setBaseDisplay(primary.bounds);

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── IPC: renderer asks for screen sources ────────────────────────────────────
ipcMain.handle('capture:list-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 180 },
  });
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    display_id: s.display_id,
    thumbnail: s.thumbnail.toDataURL(),
  }));
});

// ── IPC: renderer relays input events from the viewer ────────────────────────
ipcMain.on('input:event', (_evt, event) => {
  dispatchInput(event).catch((err) => console.error('[input] dispatch failed:', err));
});

// Update display bounds if the user picks a specific source.
ipcMain.handle('capture:set-display', (_evt, displayId) => {
  const displays = screen.getAllDisplays();
  const match = displays.find((d) => String(d.id) === String(displayId)) || screen.getPrimaryDisplay();
  setBaseDisplay(match.bounds);
  return match.bounds;
});

// ── Trusted-device IPC ───────────────────────────────────────────────────────
ipcMain.handle('trust:list', () => trustStore.list());

ipcMain.handle('trust:approve', async (_evt, { id, name }) => {
  const entry = trustStore.addOrUpdate({ id, name });
  return { id: entry.id, name: entry.name, secret: entry.secret, addedAt: entry.addedAt };
});

ipcMain.handle('trust:revoke', (_evt, id) => {
  trustStore.remove(id);
  return trustStore.list();
});

// Renderer asks for the list of trust hashes to register with the server.
ipcMain.handle('trust:hashes', () => {
  return trustStore.listFull().map((d) => hashTrustSecret(d.secret));
});

// Renderer asks for a confirmation dialog before approving a new device.
ipcMain.handle('trust:confirm', async (_evt, { name }) => {
  const result = await dialog.showMessageBox(BrowserWindow.getFocusedWindow() || mainWindow, {
    type: 'question',
    buttons: ['Trust this device', 'Reject'],
    defaultId: 1,
    cancelId: 1,
    title: 'Trust device?',
    message: `Allow "${name}" to connect without a code in the future?`,
    detail: 'Trusted devices can connect any time this BuildID host is running, without entering a 6-character code. Only approve devices you own.',
  });
  return result.response === 0;
});
