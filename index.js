const { app, BrowserWindow, screen, Tray, Menu, nativeImage, ipcMain, shell, session } = require('electron');
const { join, dirname } = require('path');
const fs = require('fs');
const { allowedHosts } = require('./constants');
const { isFederatedIdentityProviderLogin } = require('./login-logic');

let tray = null;
let trayMenu = null;
let win = null;
let autostart = false;
let minimizeOnClose = true;
let wasOffline = false;
const appWindows = new Map();
let nextWindowId = 1;
const appURL = 'https://copilot.microsoft.com'
const icon = nativeImage.createFromPath(join(__dirname, '/assets/img/icon.png'));
const isTray = process.argv.includes('--tray');
const toggleWindowsArg = '--toggle-windows';
const snapPath = process.env.SNAP
const snapUserData = process.env.SNAP_USER_DATA
const isScreenshotMode = process.env.TEST_SCREENSHOT === '1';
const screenshotPath = process.env.SCREENSHOT_PATH || 'screenshot.png';
const persistentSessionPartition = 'persist:copilot-desktop';
const sessionStorageSnapshotsFile = 'session-storage-snapshots.json';
const cookiesSnapshotFile = 'cookies-snapshot.json';
const lastAppLocationFile = 'last-app-location.json';
const windowsStateFile = 'windows-state.json';
let allowInitialSessionRestore = true;
let initialSessionRestoreTokens = 1;
let allowStartupAuthPromptBypass = true;
let lastFocusedWindow = null;
let lastFocusedWindowAt = 0;

function getAnyWindow() {
  if (win && !win.isDestroyed()) {
    return win;
  }

  for (const existingWindow of appWindows.values()) {
    if (!existingWindow.isDestroyed()) {
      return existingWindow;
    }
  }

  return null;
}

function getWindowFromWebContents(webContents) {
  return BrowserWindow.fromWebContents(webContents) || getAnyWindow();
}

function setOfflineBanner(targetWindow, isOffline) {
  if (!targetWindow || targetWindow.isDestroyed()) {
    return;
  }

  const script = `(() => {
    const bannerId = 'copilot-desktop-offline-banner';
    let banner = document.getElementById(bannerId);

    if (${isOffline ? 'true' : 'false'}) {
      if (!banner) {
        banner = document.createElement('div');
        banner.id = bannerId;
        banner.style.position = 'fixed';
        banner.style.top = '0';
        banner.style.left = '0';
        banner.style.right = '0';
        banner.style.zIndex = '2147483647';
        banner.style.padding = '10px 14px';
        banner.style.background = '#b42318';
        banner.style.color = '#ffffff';
        banner.style.fontFamily = 'sans-serif';
        banner.style.fontSize = '13px';
        banner.style.fontWeight = '600';
        banner.style.textAlign = 'center';
        banner.style.boxShadow = '0 2px 10px rgba(0, 0, 0, 0.2)';
        banner.style.pointerEvents = 'none';
        banner.textContent = 'You are offline. We will reconnect automatically when network returns.';
        document.documentElement.appendChild(banner);
      }
      return;
    }

    if (banner) {
      banner.remove();
    }
  })();`;

  targetWindow.webContents.executeJavaScript(script).catch(() => {
    // Best effort visual indicator.
  });
}

function applyOfflineState(isOffline, sourceWindow = null) {
  wasOffline = isOffline;

  const windowsToUpdate = Array.from(appWindows.values())
    .filter((existingWindow) => !existingWindow.isDestroyed());

  if (sourceWindow && !sourceWindow.isDestroyed()) {
    setOfflineBanner(sourceWindow, isOffline);
  }

  windowsToUpdate.forEach((existingWindow) => {
    if (sourceWindow && existingWindow === sourceWindow) {
      return;
    }

    setOfflineBanner(existingWindow, isOffline);
  });
}

function focusWindow(targetWindow) {
  if (!targetWindow || targetWindow.isDestroyed()) {
    return;
  }

  if (targetWindow.isMinimized()) {
    targetWindow.restore();
  }

  targetWindow.show();
  targetWindow.focus();
  win = targetWindow;
}

function getUrlBasedWindowTitle(rawUrl) {
  try {
    const parsed = new URL(rawUrl || appURL);
    const host = parsed.host || 'copilot.microsoft.com';
    const path = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : '';
    return `Copilot - ${host}${path}`;
  } catch {
    return 'Copilot';
  }
}

function getWindowDisplayName(windowId, managedWindow) {
  if (!managedWindow || managedWindow.isDestroyed()) {
    return 'Window';
  }

  const currentTitle = (managedWindow.getTitle() || '').trim();
  if (currentTitle) {
    return currentTitle;
  }

  const currentUrl = managedWindow.webContents.getURL() || appURL;
  return getUrlBasedWindowTitle(currentUrl);
}

function syncWindowTitleFromState(managedWindow, forcedTitle) {
  if (!managedWindow || managedWindow.isDestroyed()) {
    return;
  }

  const candidateTitle = (forcedTitle || managedWindow.getTitle() || '').trim();
  const nextTitle = candidateTitle || getUrlBasedWindowTitle(managedWindow.webContents.getURL());
  if (nextTitle && managedWindow.getTitle() !== nextTitle) {
    managedWindow.setTitle(nextTitle);
  }
}

function closeManagedWindow(targetWindow) {
  if (!targetWindow || targetWindow.isDestroyed()) {
    return;
  }

  // Mark this close as intentional (tray-driven) so the close handler
  // does not convert it into hide-to-tray.
  targetWindow.allowCloseFromTray = true;
  targetWindow.close();
}

function getActiveVisibleWindow() {
  const focusedWindow = BrowserWindow.getFocusedWindow();
  if (focusedWindow && !focusedWindow.isDestroyed() && focusedWindow.isVisible()) {
    return focusedWindow;
  }

  // Interacting with tray can briefly remove BrowserWindow focus.
  // Allow close only when our window was focused very recently.
  const recentlyFocusedMs = 2000;
  if (
    lastFocusedWindow &&
    !lastFocusedWindow.isDestroyed() &&
    lastFocusedWindow.isVisible() &&
    (Date.now() - lastFocusedWindowAt) <= recentlyFocusedMs
  ) {
    return lastFocusedWindow;
  }

  return null;
}

function getSessionStorageSnapshotsPath() {
  return join(app.getPath('userData'), sessionStorageSnapshotsFile);
}

function getLastAppLocationPath() {
  return join(app.getPath('userData'), lastAppLocationFile);
}

function getWindowsStatePath() {
  return join(app.getPath('userData'), windowsStateFile);
}

function blockWebNotifications() {
  const targetSession = session.fromPartition(persistentSessionPartition);

  targetSession.setPermissionCheckHandler((webContents, permission) => {
    if (permission === 'notifications') {
      return false;
    }

    return true;
  });

  targetSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'notifications') {
      callback(false);
      return;
    }

    callback(true);
  });
}

function loadWindowsStateSnapshot() {
  try {
    const snapshotPath = getWindowsStatePath();
    if (!fs.existsSync(snapshotPath)) {
      return [];
    }

    const raw = fs.readFileSync(snapshotPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter((entry) => entry && typeof entry === 'object');
  } catch (error) {
    console.error('Failed to load windows state snapshot:', error);
    return [];
  }
}

function saveWindowsStateSnapshot(snapshot) {
  try {
    const snapshotPath = getWindowsStatePath();
    fs.mkdirSync(dirname(snapshotPath), { recursive: true });
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
  } catch (error) {
    console.error('Failed to save windows state snapshot:', error);
  }
}

function collectWindowsStateSnapshot() {
  const windows = Array.from(appWindows.values()).filter((existingWindow) => !existingWindow.isDestroyed());
  const snapshot = [];

  for (const existingWindow of windows) {
    const bounds = existingWindow.getBounds();
    const url = existingWindow.webContents.getURL() || appURL;

    if (!url || !isTrustedAllowedHostURL(url)) {
      continue;
    }

    snapshot.push({
      bounds,
      url,
      isVisible: existingWindow.isVisible(),
      isMaximized: existingWindow.isMaximized(),
    });
  }

  return snapshot;
}

function persistWindowsStateSnapshot() {
  const snapshot = collectWindowsStateSnapshot();

  // Keep previous startup snapshot when app exits with no live windows.
  if (!snapshot.length) {
    console.log('No windows available for state persistence; keeping previous windows snapshot.');
    return;
  }

  saveWindowsStateSnapshot(snapshot);
  console.log(`Persisted ${snapshot.length} window state entr${snapshot.length === 1 ? 'y' : 'ies'}`);
}

function toPositiveNumber(value, fallbackValue) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }

  return fallbackValue;
}

function normalizeWindowBounds(rawBounds) {
  if (!rawBounds || typeof rawBounds !== 'object') {
    return null;
  }

  const primaryDisplay = screen.getPrimaryDisplay();
  const displayBounds = primaryDisplay.bounds;

  const width = Math.round(toPositiveNumber(rawBounds.width, displayBounds.width * 0.6));
  const height = Math.round(toPositiveNumber(rawBounds.height, displayBounds.height * 0.8));
  const x = Number.isFinite(rawBounds.x) ? Math.round(rawBounds.x) : displayBounds.x + Math.round((displayBounds.width - width) / 2);
  const y = Number.isFinite(rawBounds.y) ? Math.round(rawBounds.y) : displayBounds.y + Math.round((displayBounds.height - height) / 2);

  return { x, y, width, height };
}

function restoreWindowsFromSnapshot() {
  const snapshot = loadWindowsStateSnapshot();
  if (!snapshot.length) {
    return false;
  }

  // One token is consumed by preload in each restored renderer.
  initialSessionRestoreTokens = Math.max(initialSessionRestoreTokens, snapshot.length);

  let restoredCount = 0;

  for (const [index, entry] of snapshot.entries()) {
    const entryUrl = typeof entry.url === 'string' && isTrustedAllowedHostURL(entry.url) ? entry.url : appURL;
    const bounds = normalizeWindowBounds(entry.bounds);
    const shouldShow = true;
    const createdWindow = createWindow({
      showWindow: shouldShow,
      initialUrl: entryUrl,
      bounds,
    });

    if (entry.isMaximized) {
      createdWindow.maximize();
    }

    if (!shouldShow) {
      createdWindow.hide();
    }

    restoredCount += 1;

    // Focus only the last shown window in non-tray startup mode.
    if (index === snapshot.length - 1) {
      focusWindow(createdWindow);
    }
  }

  console.log(`Restored ${restoredCount} window${restoredCount === 1 ? '' : 's'} from persisted state`);
  return restoredCount > 0;
}

function saveLastAppLocation(urlString) {
  try {
    if (!urlString) {
      return;
    }

    const parsed = new URL(urlString);
    const resumableHosts = new Set([
      'copilot.microsoft.com',
      'copilot.cloud.microsoft',
      'm365.cloud.microsoft'
    ]);

    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !resumableHosts.has(parsed.host)) {
      return;
    }

    const targetPath = getLastAppLocationPath();
    fs.mkdirSync(dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, JSON.stringify({
      url: urlString,
      updatedAt: new Date().toISOString()
    }, null, 2));
  } catch {
    // Best effort persistence.
  }
}

function grantInitialSessionRestore() {
  initialSessionRestoreTokens += 1;
}
function hasPersistedSessionArtifacts() {
  return fs.existsSync(getCookiesSnapshotPath()) || fs.existsSync(getSessionStorageSnapshotsPath());
}

function isTrustedAllowedHostURL(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && allowedHosts.has(parsed.host);
  } catch {
    return false;
  }
}

function normalizeMicrosoftLoginURL(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const isMicrosoftLoginHost = parsed.host === 'login.microsoftonline.com' || parsed.host === 'login.live.com';
    if (!isMicrosoftLoginHost) {
      return null;
    }

    const prompt = parsed.searchParams.get('prompt');
    if (prompt !== 'select_account') {
      return null;
    }

    if (!allowStartupAuthPromptBypass || !hasPersistedSessionArtifacts()) {
      return null;
    }

    parsed.searchParams.delete('prompt');
    return parsed.toString();
  } catch {
    return null;
  }
}

function normalizeMicrosoftLoginRequest(rawUrl) {
  const normalized = normalizeMicrosoftLoginURL(rawUrl);
  if (normalized && normalized !== rawUrl) {
    return normalized;
  }

  try {
    const parsed = new URL(rawUrl);
    const isMicrosoftLoginHost = parsed.host === 'login.microsoftonline.com' || parsed.host === 'login.live.com';
    if (!allowStartupAuthPromptBypass || !isMicrosoftLoginHost || !hasPersistedSessionArtifacts()) {
      return null;
    }

    if (parsed.searchParams.get('prompt') === 'login') {
      parsed.searchParams.delete('prompt');
      return parsed.toString();
    }

    return null;
  } catch {
    return null;
  }
}

function stripForcedPromptFromNestedValue(value) {
  if (typeof value !== 'string' || !value) {
    return value;
  }

  const stripPlain = (input) => input
    .replace(/([?&])prompt=select_account(&|$)/ig, '$1')
    .replace(/([?&])prompt=login(&|$)/ig, '$1')
    .replace(/[?&]$/, '')
    .replace(/[?&]{2,}/g, '&')
    .replace('?&', '?');

  let updated = stripPlain(value);

  try {
    const decoded = decodeURIComponent(value);
    const strippedDecoded = stripPlain(decoded);
    if (strippedDecoded !== decoded) {
      updated = encodeURIComponent(strippedDecoded);
    }
  } catch {
    // Keep best-effort plain replacement result.
  }

  return updated;
}

function normalizeMicrosoftLoginRequestDeep(rawUrl) {
  const direct = normalizeMicrosoftLoginRequest(rawUrl);
  if (direct && direct !== rawUrl) {
    return direct;
  }

  try {
    const parsed = new URL(rawUrl);
    const isMicrosoftLoginHost = parsed.host === 'login.microsoftonline.com' || parsed.host === 'login.live.com';
    if (!allowStartupAuthPromptBypass || !isMicrosoftLoginHost || !hasPersistedSessionArtifacts()) {
      return null;
    }

    let changed = false;
    parsed.searchParams.forEach((value, key) => {
      const updated = stripForcedPromptFromNestedValue(value);
      if (updated !== value) {
        parsed.searchParams.set(key, updated);
        changed = true;
      }
    });

    if (changed) {
      return parsed.toString();
    }

    return null;
  } catch {
    return null;
  }
}

function getCookiesSnapshotPath() {
  return join(app.getPath('userData'), cookiesSnapshotFile);
}

function loadCookiesSnapshot() {
  try {
    const snapshotPath = getCookiesSnapshotPath();
    if (!fs.existsSync(snapshotPath)) {
      return [];
    }

    const raw = fs.readFileSync(snapshotPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed;
  } catch (error) {
    console.error('Failed to load cookies snapshot:', error);
    return [];
  }
}

function saveCookiesSnapshot(cookies) {
  try {
    const snapshotPath = getCookiesSnapshotPath();
    fs.mkdirSync(dirname(snapshotPath), { recursive: true });
    fs.writeFileSync(snapshotPath, JSON.stringify(cookies, null, 2));
  } catch (error) {
    console.error('Failed to save cookies snapshot:', error);
  }
}

function cookieToURL(cookie) {
  const protocol = cookie.secure ? 'https://' : 'http://';
  const normalizedDomain = cookie.domain && cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain;
  const path = cookie.path || '/';
  return `${protocol}${normalizedDomain}${path}`;
}

async function captureCookiesSnapshot() {
  const targetWindow = getAnyWindow();
  if (!targetWindow) {
    return;
  }

  try {
    const cookies = await targetWindow.webContents.session.cookies.get({});
    saveCookiesSnapshot(cookies);
    console.log(`Captured ${cookies.length} cookies for restart persistence`);
  } catch (error) {
    console.error('Failed to capture cookies snapshot:', error);
  }
}

async function restoreCookiesSnapshot() {
  try {
    const snapshot = loadCookiesSnapshot();
    if (!snapshot.length) {
      return;
    }

    const targetSession = session.fromPartition(persistentSessionPartition);
    for (const cookie of snapshot) {
      try {
        const details = {
          url: cookieToURL(cookie),
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          path: cookie.path,
          secure: cookie.secure,
          httpOnly: cookie.httpOnly,
          sameSite: cookie.sameSite
        };

        if (typeof cookie.expirationDate === 'number') {
          details.expirationDate = cookie.expirationDate;
        }

        await targetSession.cookies.set(details);
      } catch (error) {
        const cookieName = cookie && cookie.name ? cookie.name : 'unknown';
        console.log(`Skipping cookie restore for ${cookieName}:`, error.message || error);
      }
    }

    await targetSession.cookies.flushStore();
    console.log(`Restored ${snapshot.length} cookies from snapshot`);
  } catch (error) {
    console.error('Failed to restore cookies snapshot:', error);
  }
}

async function persistSessionData() {
  const targetWindow = getAnyWindow();
  if (!targetWindow) {
    return;
  }

  try {
    await captureCookiesSnapshot();
    const { session } = targetWindow.webContents;
    await session.flushStorageData();
    await session.cookies.flushStore();
    console.log('Session data flushed successfully');
  } catch (error) {
    console.error('Failed to flush session data:', error);
  }
}

async function clearPersistentSessionData() {
  const targetWindow = getAnyWindow();
  if (!targetWindow) {
    return;
  }

  try {
    const { session } = targetWindow.webContents;
    const cookies = await session.cookies.get({});

    await Promise.all(cookies.map((cookie) => {
      const protocol = cookie.secure ? 'https://' : 'http://';
      const normalizedDomain = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain;
      const cookieUrl = `${protocol}${normalizedDomain}${cookie.path}`;
      return session.cookies.remove(cookieUrl, cookie.name);
    }));

    await session.clearStorageData();
    await session.clearCache();
    await session.flushStorageData();

    const snapshotsPath = getSessionStorageSnapshotsPath();
    if (fs.existsSync(snapshotsPath)) {
      fs.rmSync(snapshotsPath);
    }

    const cookiesSnapshotPath = getCookiesSnapshotPath();
    if (fs.existsSync(cookiesSnapshotPath)) {
      fs.rmSync(cookiesSnapshotPath);
    }

    const lastLocationPath = getLastAppLocationPath();
    if (fs.existsSync(lastLocationPath)) {
      fs.rmSync(lastLocationPath);
    }

    console.log('Persistent session data cleared successfully');

    wasOffline = false;
    targetWindow.loadURL(appURL);
    focusWindow(targetWindow);
  } catch (error) {
    console.error('Failed to clear persistent session data:', error);
  }
}

function initializeAutostart() {
  if (fs.existsSync(snapUserData + '/.config/autostart/copilot-desktop.desktop')) {
    console.log('Autostart file exists')
    autostart = true;
  } else {
    console.log('Autostart file does not exist')
    autostart = false;
  }
}

function handleAutoStartChange() {
  if (autostart) {
    console.log("Enabling autostart");
    if (!fs.existsSync(snapUserData + '/.config/autostart')) {
      fs.mkdirSync(snapUserData + '/.config/autostart', { recursive: true });
    }
    if (!fs.existsSync(snapUserData + '/.config/autostart/copilot-desktop.desktop')) {
      fs.copyFileSync(snapPath + '/com.github.kenvandine.copilot-desktop-autostart.desktop', snapUserData + '/.config/autostart/copilot-desktop.desktop');
    }
  } else {
    console.log("Disabling autostart");
    if (fs.existsSync(snapUserData + '/.config/autostart/copilot-desktop.desktop')) {
      fs.rmSync(snapUserData + '/.config/autostart/copilot-desktop.desktop');
    }
  }
}

function buildTrayMenu() {
  const activeVisibleWindow = getActiveVisibleWindow();

  const managedWindowItems = Array.from(appWindows.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([windowId, managedWindow]) => {
      const isDestroyed = managedWindow.isDestroyed();
      const isVisible = !isDestroyed && managedWindow.isVisible();
      const suffix = isDestroyed ? ' (closed)' : (isVisible ? ' (visible)' : ' (hidden)');
      const displayName = getWindowDisplayName(windowId, managedWindow);

      return {
        label: `${displayName}${suffix}`,
        enabled: !isDestroyed,
        submenu: [
          {
            label: 'Show/Focus',
            enabled: !isDestroyed,
            click: () => {
              focusWindow(managedWindow);
            }
          },
          {
            label: 'Close',
            enabled: !isDestroyed,
            click: () => {
              if (!managedWindow.isDestroyed()) {
                closeManagedWindow(managedWindow);
              }
            }
          }
        ]
      };
    });

  if (!managedWindowItems.length) {
    managedWindowItems.push({
      label: 'No windows',
      enabled: false,
    });
  }

  return Menu.buildFromTemplate([
    {
      label: 'Show/Hide CoPilot',
      icon: icon,
      click: () => {
        showOrHide();
      }
    },
    {
      label: 'New Window',
      click: () => {
        const newWindow = createWindow({ showWindow: true });
        focusWindow(newWindow);
      }
    },
    {
      label: 'Window Management',
      submenu: managedWindowItems,
    },
    {
      label: 'Close Window',
      enabled: Boolean(activeVisibleWindow),
      click: () => {
        const activeWindow = getActiveVisibleWindow();
        if (activeWindow) {
          closeManagedWindow(activeWindow);
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Autostart',
      type: 'checkbox',
      checked: autostart,
      click: (menuItem) => {
        autostart = menuItem.checked;
        console.log('Autostart toggled: ' + autostart);
        handleAutoStartChange();
        refreshTrayMenu();
      }
    },
    {
      label: 'Minimize Window On Close',
      type: 'checkbox',
      checked: minimizeOnClose,
      click: (menuItem) => {
        minimizeOnClose = menuItem.checked;
        console.log('Minimize on close toggled: ' + minimizeOnClose);
        refreshTrayMenu();
      }
    },
    {
      label: 'Clear persistent data',
      click: () => {
        console.log('Clear persistent data clicked');
        clearPersistentSessionData();
      }
    },
    { type: 'separator' },
    {
      label: 'About',
      click: () => {
        console.log('About clicked');
        createAboutWindow();
      }
    },
    {
      label: 'Quit',
      click: () => {
        console.log('Quit clicked, Exiting');
        app.quit();
      }
    },
  ]);
}

function refreshTrayMenu() {
  if (!tray) {
    return;
  }

  trayMenu = buildTrayMenu();
  tray.setContextMenu(trayMenu);
}

// IPC listeners (registered once, outside createWindow to avoid leaks)
ipcMain.on('zoom-in', () => {
  console.log('zoom-in');
  const targetWindow = BrowserWindow.getFocusedWindow() || getAnyWindow();
  if (!targetWindow) {
    return;
  }

  const currentZoom = targetWindow.webContents.getZoomLevel();
  targetWindow.webContents.setZoomLevel(currentZoom + 1);
});

ipcMain.on('zoom-out', () => {
  console.log('zoom-out');
  const targetWindow = BrowserWindow.getFocusedWindow() || getAnyWindow();
  if (!targetWindow) {
    return;
  }

  const currentZoom = targetWindow.webContents.getZoomLevel();
  targetWindow.webContents.setZoomLevel(currentZoom - 1);
});

ipcMain.on('zoom-reset', () => {
  console.log('zoom-reset');
  const targetWindow = BrowserWindow.getFocusedWindow() || getAnyWindow();
  if (!targetWindow) {
    return;
  }

  targetWindow.webContents.setZoomLevel(0);
});

ipcMain.on('log-message', (event, message) => {
  console.log('Log from preload: ', message);
});

ipcMain.on('persistency-get-user-data-path-sync', (event) => {
  event.returnValue = app.getPath('userData');
});

ipcMain.on('persistency-consume-initial-restore-sync', (event) => {
  if (!isTrustedAllowedHostURL(event.senderFrame.url)) {
    event.returnValue = false;
    return;
  }

  if (!allowInitialSessionRestore || initialSessionRestoreTokens <= 0) {
    event.returnValue = false;
    return;
  }

  initialSessionRestoreTokens -= 1;
  event.returnValue = true;
});

// Open links with default browser
ipcMain.on('open-external-link', (event, url) => {
  console.log('open-external-link: ', url);
  if (!url) {
    return;
  }

  // Validate the sender origin for security
  const senderURL = event.senderFrame.url;
  const isOfflinePage = senderURL.startsWith('file://') && senderURL.endsWith('offline.html');
  const isAllowedHost = (() => {
    try {
      const host = new URL(senderURL).host;
      return allowedHosts.has(host);
    } catch {
      return false;
    }
  })();

  if (!isOfflinePage && !isAllowedHost) {
    console.log('open-external-link: rejected from untrusted origin', senderURL);
    return;
  }

  // Only allow http: and https: protocols for security
  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      console.log('open-external-link: rejected non-http(s) protocol', parsedUrl.protocol);
      return;
    }
    shell.openExternal(url).catch(err => {
      console.error('Failed to open external URL:', err);
    });
  } catch (e) {
    console.log('open-external-link: invalid URL', url, e);
  }
});

// Retry connection from offline page
ipcMain.on('retry-connection', () => {
  console.log('Retrying connection...');
  const targetWindow = getAnyWindow();
  if (!targetWindow) {
    return;
  }

  // Preserve session by avoiding navigation; only update current offline indicator.
  setOfflineBanner(targetWindow, wasOffline);
});

// Listen for network status updates from the preload script
// Only act on transitions to avoid reload loops
ipcMain.on('network-status', (event, isOnline) => {
  console.log(`Network status: ${isOnline ? 'online' : 'offline'}`);
  const targetWindow = getWindowFromWebContents(event.sender);
  if (!targetWindow) {
    return;
  }

  applyOfflineState(!isOnline, targetWindow);
});

function addUrlChangeLogging(webContents) {
  let lastMainFrameUrl = '';

  const logUrlChange = (eventName, nextUrl, details = '') => {
    if (!nextUrl || nextUrl === lastMainFrameUrl) {
      return;
    }

    const previousUrl = lastMainFrameUrl || '(initial)';
    const detailText = details ? ` ${details}` : '';
    console.log(`[url-change] ${eventName}: ${previousUrl} -> ${nextUrl}${detailText}`);
    lastMainFrameUrl = nextUrl;
  };

  webContents.on('did-start-navigation', (event, url, isInPlace, isMainFrame) => {
    if (!isMainFrame) {
      return;
    }
    logUrlChange('did-start-navigation', url, isInPlace ? '(in-page)' : '');
  });

  webContents.on('will-redirect', (event, url, isInPlace, isMainFrame) => {
    if (!isMainFrame) {
      return;
    }
    logUrlChange('will-redirect', url, isInPlace ? '(in-page)' : '(redirect)');
  });

  webContents.on('did-redirect-navigation', (event, url, isInPlace, isMainFrame) => {
    if (!isMainFrame) {
      return;
    }
    logUrlChange('did-redirect-navigation', url, isInPlace ? '(in-page)' : '(redirect)');
  });

  webContents.on('did-navigate', (event, url, httpResponseCode, httpStatusText) => {
    const status = httpResponseCode ? `(${httpResponseCode}${httpStatusText ? ` ${httpStatusText}` : ''})` : '';
    logUrlChange('did-navigate', url, status);
  });

  webContents.on('did-navigate-in-page', (event, url, isMainFrame) => {
    if (!isMainFrame) {
      return;
    }
    logUrlChange('did-navigate-in-page', url, '(in-page)');
  });
}

function createWindow (options = {}) {
  const {
    showWindow = !isTray,
    sourceWindow = null,
    inheritPersistence = false,
    initialUrl = appURL,
    bounds = null,
  } = options;
  const primaryDisplay = screen.getPrimaryDisplay();
  const { x, y, width, height } = primaryDisplay.bounds;
  const persistedBounds = normalizeWindowBounds(bounds);
  const windowId = nextWindowId++;

  if (inheritPersistence && sourceWindow && !sourceWindow.isDestroyed()) {
    // Trigger preload persistence hooks so latest sessionStorage snapshot is saved.
    sourceWindow.webContents.executeJavaScript("window.dispatchEvent(new Event('pagehide')); true;")
      .catch(() => {
        // Best effort only.
      });

    saveLastAppLocation(sourceWindow.webContents.getURL());
    grantInitialSessionRestore();
  }

  // Log geometry information for easier debugging
  console.log(`Primary Screen Geometry - Width: ${width} Height: ${height} X: ${x} Y: ${y}`);

  const currentWindow = new BrowserWindow({
    width: isScreenshotMode ? 1920 : (persistedBounds ? persistedBounds.width : Math.round(width * 0.6)),
    height: isScreenshotMode ? 1080 : (persistedBounds ? persistedBounds.height : Math.round(height * 0.8)),
    x: isScreenshotMode ? undefined : (persistedBounds ? persistedBounds.x : x + ((width - (width * 0.6)) / 2)),
    y: isScreenshotMode ? undefined : (persistedBounds ? persistedBounds.y : y + ((height - (height * 0.8)) / 2)),
    icon: icon,
    show: isScreenshotMode ? false : showWindow,
    webPreferences: {
      preload: join(__dirname, 'persistence-preload.js'),
      partition: persistentSessionPartition,
      nodeIntegration: true,
      contextIsolation: true,
      sandbox: false
    }
  });
  // win.webContents.openDevTools({ mode: 'detach' }); // Open DevTools for debugging

  win = currentWindow;
  appWindows.set(windowId, currentWindow);

  currentWindow.removeMenu();

  currentWindow.on('focus', () => {
    win = currentWindow;
    lastFocusedWindow = currentWindow;
    lastFocusedWindowAt = Date.now();
    refreshTrayMenu();
  });

  currentWindow.on('page-title-updated', (event, title) => {
    syncWindowTitleFromState(currentWindow, title);
    refreshTrayMenu();
  });

  currentWindow.on('show', refreshTrayMenu);
  currentWindow.on('hide', refreshTrayMenu);
  currentWindow.on('closed', () => {
    appWindows.delete(windowId);
    if (win === currentWindow) {
      win = getAnyWindow();
    }

    if (lastFocusedWindow === currentWindow) {
      lastFocusedWindow = null;
      lastFocusedWindowAt = 0;
    }

    refreshTrayMenu();
  });

  currentWindow.webContents.session.webRequest.onBeforeRequest({
    urls: [
      'https://login.microsoftonline.com/*',
      'https://login.live.com/*'
    ]
  }, (details, callback) => {
    const normalizedLoginUrl = normalizeMicrosoftLoginRequestDeep(details.url);
    if (normalizedLoginUrl && normalizedLoginUrl !== details.url) {
      console.log('onBeforeRequest: redirecting login request without forced account prompt');
      callback({ redirectURL: normalizedLoginUrl });
      return;
    }

    callback({ cancel: false });
  });

  currentWindow.on('close', (event) => {
    if (isScreenshotMode || app.isQuittingForSessionPersist || currentWindow.allowCloseFromTray) {
      return;
    }

    if (!minimizeOnClose) {
      return;
    }

    event.preventDefault();
    currentWindow.hide();
  });

  // Keep the current page/session alive when offline; use in-app banner instead of navigation.
  currentWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    console.log(`did-fail-load: ${errorDescription} (${errorCode}) on ${validatedURL}, mainFrame=${isMainFrame}`);

    // Ignore non-main-frame failures and benign aborts (e.g. redirects or intentional load cancellations)
    if (!isMainFrame || errorCode === -3) {
      return;
    }

    // Only treat failures on the app URL as connectivity state changes.
    if (validatedURL && !validatedURL.startsWith(appURL)) {
      return;
    }

    // Only treat network-related errors as "offline"
    // Common network error codes: -2 (FAILED), -7 (TIMED_OUT), -21 (NETWORK_CHANGED),
    // -100 to -199 (connection errors), -105 (NAME_NOT_RESOLVED), -106 (INTERNET_DISCONNECTED)
    const isNetworkError = (
      errorCode === -2 ||   // FAILED
      errorCode === -7 ||   // TIMED_OUT
      errorCode === -21 ||  // NETWORK_CHANGED
      errorCode === -105 || // NAME_NOT_RESOLVED
      errorCode === -106 || // INTERNET_DISCONNECTED
      (errorCode >= -199 && errorCode <= -100) // Connection errors
    );

    if (isScreenshotMode) {
      setTimeout(async () => {
        try {
          const image = await currentWindow.capturePage();
          fs.writeFileSync(screenshotPath, image.toPNG());
          console.log(`Screenshot of error state saved to ${screenshotPath}`);
        } catch (error) {
          console.error('Error capturing error screenshot:', error);
        }
        app.exit(1);
      }, 2000);
      return;
    }

    if (isNetworkError) {
      applyOfflineState(true, currentWindow);
    } else {
      console.log(`did-fail-load: Non-network error ${errorCode}, not applying offline mode`);
    }
  });

  // Intercept navigation and only allow app + auth hosts in-app
  currentWindow.webContents.on('will-navigate', (event, url) => {
    try {
      const normalizedLoginUrl = normalizeMicrosoftLoginURL(url);
      if (normalizedLoginUrl && normalizedLoginUrl !== url) {
        console.log('will-navigate: retrying login without forced account chooser');
        event.preventDefault();
        currentWindow.loadURL(normalizedLoginUrl);
        return;
      }

      const parsedUrl = new URL(url);
      const protocol = parsedUrl.protocol;
      const targetHost = parsedUrl.host;
      const isLoginRequest = isFederatedIdentityProviderLogin(parsedUrl);

      if (isLoginRequest) {
        // Organizational/federated logins (Microsoft WS-Federation, Google,
        // Apple) must complete inside this webContents session for the login
        // cookies/state to be usable by the app. Keep the navigation in-app
        // regardless of host allowlist.
        console.log('will-navigate federated login: keeping in-app', url);
        return;
      }

      // Only allow http/https navigations to known hosts
      if ((protocol !== 'http:' && protocol !== 'https:') || !allowedHosts.has(targetHost)) {
        console.log('will-navigate external: ', url);
        event.preventDefault();
        // Only open http/https URLs externally for security
        if (protocol === 'http:' || protocol === 'https:') {
          shell.openExternal(url).catch(err => {
            console.error('Failed to open external URL:', err);
          });
        }
      }
    } catch (e) {
      // If URL parsing fails, block the navigation to avoid crashes
      console.log('will-navigate invalid URL: ', url, e);
      event.preventDefault();
    }
  });

  currentWindow.webContents.on('did-navigate', () => {
    syncWindowTitleFromState(currentWindow);
    refreshTrayMenu();
  });

  currentWindow.webContents.on('did-navigate-in-page', () => {
    syncWindowTitleFromState(currentWindow);
    refreshTrayMenu();
  });

  // New-window requests (window.open / target="_blank"): only keep the
  // app host in-app; everything else opens in the default browser
  currentWindow.webContents.setWindowOpenHandler(({url}) => {
    console.log('windowOpenHandler: ', url);
    try {
      const normalizedLoginUrl = normalizeMicrosoftLoginURL(url);
      if (normalizedLoginUrl && normalizedLoginUrl !== url) {
        currentWindow.loadURL(normalizedLoginUrl);
        return { action: 'deny' };
      }

      const parsedUrl = new URL(url);
      const protocol = parsedUrl.protocol;
      const host = parsedUrl.host;
      
      if (host === new URL(appURL).host || isFederatedIdentityProviderLogin(parsedUrl)) {
        currentWindow.loadURL(url);
        return { action: 'deny' };
      }

      // Only open http/https URLs externally for security
      if (protocol === 'http:' || protocol === 'https:') {
        shell.openExternal(url).catch(err => {
          console.error('Failed to open external URL:', err);
        });
      }
    } catch (e) {
      // If URL parsing fails, just deny the action
      console.log('windowOpenHandler: invalid URL', url, e);
    }
    return { action: 'deny' };
  });

  currentWindow.loadURL(initialUrl);
  syncWindowTitleFromState(currentWindow);

  // Disable startup-only auth prompt bypass after the first loaded page.
  currentWindow.webContents.once('did-finish-load', () => {
    allowStartupAuthPromptBypass = false;
  });

  currentWindow.webContents.on('did-finish-load', () => {
    // The banner is DOM-based and may be removed by page navigations.
    // Re-apply it after each load while offline.
    if (wasOffline) {
      setOfflineBanner(currentWindow, true);
    }

    if (isScreenshotMode) {
      console.log('Screenshot mode: waiting 5 seconds for content to render...');
      setTimeout(async () => {
        try {
          console.log('Capturing screenshot...');
          const image = await currentWindow.capturePage();
          fs.writeFileSync(screenshotPath, image.toPNG());
          console.log(`Screenshot saved to ${screenshotPath}`);
          app.quit();
        } catch (error) {
          console.error('Error capturing screenshot:', error);
          app.exit(1);
        }
      }, 5000);
    }
  });

  refreshTrayMenu();
  return currentWindow;
}

// Ensure we're a single instance app
const firstInstance = app.requestSingleInstanceLock();

if (!firstInstance) {
  app.quit();
} else {
  app.on("second-instance", (event, commandLine, workingDirectory) => {
    console.log("second-instance", { commandLine, workingDirectory });

    if (Array.isArray(commandLine) && commandLine.includes(toggleWindowsArg)) {
      showOrHide();
      return;
    }

    const targetWindow = getAnyWindow() || createWindow({ showWindow: true });
    focusWindow(targetWindow);
  });
}

function createAboutWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { x, y, width, height } = primaryDisplay.bounds;
  const parentWindow = BrowserWindow.getFocusedWindow() || getAnyWindow();

  const aboutWindow = new BrowserWindow({
    width: 500,
    height: 420,
    x: x + ((width - 500) / 2),
    y: y + ((height - 420) / 2),
    title: 'About',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    modal: true,  // Make the About window modal
    parent: parentWindow || undefined  // Attach to the active app window when available
  });

  aboutWindow.loadFile('./assets/html/about.html');
  aboutWindow.removeMenu();

  // Read version from package.json
  const packageJson = JSON.parse(fs.readFileSync(join(__dirname, 'package.json')));
  const appVersion = packageJson.version;
  const appDescription = packageJson.description;
  const appTitle = packageJson.title;
  const appBugsUrl = packageJson.bugs.url;
  const appHomePage = packageJson.homepage;
  const appAuthor = packageJson.author;

  // Send version to the About window
  aboutWindow.webContents.on('did-finish-load', () => {
    console.log("did-finish-load", appTitle);
    aboutWindow.webContents.send('app-version', appVersion);
    aboutWindow.webContents.send('app-description', appDescription);
    aboutWindow.webContents.send('app-title', appTitle);
    aboutWindow.webContents.send('app-bugs-url', appBugsUrl);
    aboutWindow.webContents.send('app-homepage', appHomePage);
    aboutWindow.webContents.send('app-author', appAuthor);
  });
  // Link clicks open new windows, let's force them to open links in
  // the default browser
  aboutWindow.webContents.setWindowOpenHandler(({url}) => {
    console.log('windowOpenHandler: ', url);
    shell.openExternal(url);
    return { action: 'deny' }
  });
}

ipcMain.on('get-app-metadata', (event) => {
    const packageJson = JSON.parse(fs.readFileSync(join(__dirname, 'package.json')));
    const appVersion = packageJson.version;
    const appDescription = packageJson.description;
    const appTitle = packageJson.title;
    const appBugsUrl = packageJson.bugs.url;
    const appHomePage = packageJson.homepage;
    const appAuthor = packageJson.author;
    event.sender.send('app-version', appVersion);
    event.sender.send('app-description', appDescription);
    event.sender.send('app-title', appTitle);
    event.sender.send('app-bugs-url', appBugsUrl);
    event.sender.send('app-homepage', appHomePage);
    event.sender.send('app-author', appAuthor);
});

app.on('ready', async () => {
  console.log(`Electron Version: ${process.versions.electron}`);
  console.log(`App Version: ${app.getVersion()}`);

  blockWebNotifications();

  await restoreCookiesSnapshot();

  if (!isScreenshotMode) {
    tray = new Tray(icon);
    // Ignore double click events for the tray icon
    tray.setIgnoreDoubleClickEvents(true)
    tray.on('click', () => {
      console.log("AppIndicator clicked");
      refreshTrayMenu();
      showOrHide();
    });
    tray.on('right-click', () => {
      refreshTrayMenu();
      tray.popUpContextMenu(trayMenu || undefined);
    });

    // Ensure autostart is set properly at start
    initializeAutostart();

    tray.setToolTip('Copilot');
    refreshTrayMenu();
  }

  if (!restoreWindowsFromSnapshot() && (!win || win.isDestroyed())) {
    createWindow({ showWindow: true });
  }
});

function showOrHide() {
  console.log("showOrHide");
  const managedWindows = Array.from(appWindows.values()).filter((existingWindow) => !existingWindow.isDestroyed());

  if (!managedWindows.length) {
    const newWindow = createWindow({ showWindow: true });
    focusWindow(newWindow);
    return;
  }

  // If any window is currently visible, hide all windows. Otherwise show all.
  const hasVisibleWindow = managedWindows.some((existingWindow) => existingWindow.isVisible());

  if (hasVisibleWindow) {
    managedWindows.forEach((existingWindow) => {
      existingWindow.hide();
    });
    return;
  }

  // Show windows without forcing focus to avoid desktop "is ready" notifications.
  managedWindows.forEach((existingWindow) => {
    if (typeof existingWindow.showInactive === 'function') {
      existingWindow.showInactive();
      return;
    }

    existingWindow.show();
  });
}

app.on('before-quit', async (event) => {
  if (app.isQuittingForSessionPersist) {
    return;
  }

  app.isQuittingForSessionPersist = true;
  event.preventDefault();
  persistWindowsStateSnapshot();
  await persistSessionData();
  app.quit();
});

app.on('will-quit', () => {
  // no-op: keyboard shortcut system removed
});

app.on('window-all-closed', () => {
  console.log("window-all-closed");
});

app.on('activate', () => {
  console.log("ACTIVATE");
  if (appWindows.size === 0) {
    const newWindow = createWindow({ showWindow: true });
    focusWindow(newWindow);
    return;
  }

  focusWindow(getAnyWindow());
});
