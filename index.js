const { app, BrowserWindow, screen, Tray, Menu, nativeImage, ipcMain, shell , globalShortcut, session } = require('electron');
const { join, dirname } = require('path');
const fs = require('fs');
const { allowedHosts } = require('./constants');
const { isFederatedIdentityProviderLogin } = require('./login-logic');

let showHideShortcut = 'Alt+H'
let tray = null;
let win = null;
let autostart = false;
let wasOffline = false;
const appURL = 'https://copilot.microsoft.com'
const icon = nativeImage.createFromPath(join(__dirname, '/assets/img/icon.png'));
const isTray = process.argv.includes('--tray');
const snapPath = process.env.SNAP
const snapUserData = process.env.SNAP_USER_DATA
const isScreenshotMode = process.env.TEST_SCREENSHOT === '1';
const screenshotPath = process.env.SCREENSHOT_PATH || 'screenshot.png';
const persistentSessionPartition = 'persist:copilot-desktop';
const sessionStorageSnapshotsFile = 'session-storage-snapshots.json';
const cookiesSnapshotFile = 'cookies-snapshot.json';
const lastAppLocationFile = 'last-app-location.json';
let allowInitialSessionRestore = true;
let allowStartupAuthPromptBypass = true;

function getSessionStorageSnapshotsPath() {
  return join(app.getPath('userData'), sessionStorageSnapshotsFile);
}

function getLastAppLocationPath() {
  return join(app.getPath('userData'), lastAppLocationFile);
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
  if (!win || win.isDestroyed()) {
    return;
  }

  try {
    const cookies = await win.webContents.session.cookies.get({});
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
  if (!win || win.isDestroyed()) {
    return;
  }

  try {
    await captureCookiesSnapshot();
    const { session } = win.webContents;
    await session.flushStorageData();
    await session.cookies.flushStore();
    console.log('Session data flushed successfully');
  } catch (error) {
    console.error('Failed to flush session data:', error);
  }
}

async function clearPersistentSessionData() {
  if (!win || win.isDestroyed()) {
    return;
  }

  try {
    const { session } = win.webContents;
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
    win.loadURL(appURL);
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

// IPC listeners (registered once, outside createWindow to avoid leaks)
ipcMain.on('zoom-in', () => {
  console.log('zoom-in');
  const currentZoom = win.webContents.getZoomLevel();
  win.webContents.setZoomLevel(currentZoom + 1);
});

ipcMain.on('zoom-out', () => {
  console.log('zoom-out');
  const currentZoom = win.webContents.getZoomLevel();
  win.webContents.setZoomLevel(currentZoom - 1);
});

ipcMain.on('zoom-reset', () => {
  console.log('zoom-reset');
  win.webContents.setZoomLevel(0);
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

  if (!allowInitialSessionRestore) {
    event.returnValue = false;
    return;
  }

  allowInitialSessionRestore = false;
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
  wasOffline = false;
  win.loadURL(appURL);
});

// Listen for network status updates from the preload script
// Only act on transitions to avoid reload loops
ipcMain.on('network-status', (event, isOnline) => {
  console.log(`Network status: ${isOnline ? 'online' : 'offline'}`);
  if (isOnline && wasOffline) {
    wasOffline = false;
    win.loadURL(appURL);
  } else if (!isOnline && !wasOffline) {
    wasOffline = true;
    win.loadFile(join(__dirname, 'assets', 'html', 'offline.html'));
  }
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

function createWindow () {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { x, y, width, height } = primaryDisplay.bounds;

  // Log geometry information for easier debugging
  console.log(`Primary Screen Geometry - Width: ${width} Height: ${height} X: ${x} Y: ${y}`);

  win = new BrowserWindow({
    width: isScreenshotMode ? 1920 : width * 0.6,
    height: isScreenshotMode ? 1080 : height * 0.8,
    x: isScreenshotMode ? undefined : x + ((width - (width * 0.6)) / 2),
    y: isScreenshotMode ? undefined : y + ((height - (height * 0.8)) / 2),
    icon: icon,
    show: isScreenshotMode ? false : !isTray, // Start hidden if --tray or screenshot mode
    webPreferences: {
      preload: join(__dirname, 'persistence-preload.js'),
      partition: persistentSessionPartition,
      nodeIntegration: true,
      contextIsolation: true,
      sandbox: false
    }
  });
  // win.webContents.openDevTools({ mode: 'detach' }); // Open DevTools for debugging

  win.removeMenu();

  win.webContents.session.webRequest.onBeforeRequest({
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

  win.on('close', (event) => {
    if (isScreenshotMode || app.isQuittingForSessionPersist) return;
    event.preventDefault();
    win.hide();
  });

  // Show offline page if the *main* app URL fails to load due to a real network error
  win.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    console.log(`did-fail-load: ${errorDescription} (${errorCode}) on ${validatedURL}, mainFrame=${isMainFrame}`);

    // Ignore non-main-frame failures and benign aborts (e.g. redirects or intentional load cancellations)
    if (!isMainFrame || errorCode === -3) {
      return;
    }

    // Only trigger offline page for failures related to the main app URL
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
          const image = await win.capturePage();
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
      wasOffline = true;
      win.loadFile(join(__dirname, 'assets', 'html', 'offline.html'));
    } else {
      console.log(`did-fail-load: Non-network error ${errorCode}, not showing offline page`);
    }
  });

  // Intercept navigation and only allow app + auth hosts in-app
  win.webContents.on('will-navigate', (event, url) => {
    try {
      const normalizedLoginUrl = normalizeMicrosoftLoginURL(url);
      if (normalizedLoginUrl && normalizedLoginUrl !== url) {
        console.log('will-navigate: retrying login without forced account chooser');
        event.preventDefault();
        win.loadURL(normalizedLoginUrl);
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

  // New-window requests (window.open / target="_blank"): only keep the
  // app host in-app; everything else opens in the default browser
  win.webContents.setWindowOpenHandler(({url}) => {
    console.log('windowOpenHandler: ', url);
    try {
      const normalizedLoginUrl = normalizeMicrosoftLoginURL(url);
      if (normalizedLoginUrl && normalizedLoginUrl !== url) {
        win.loadURL(normalizedLoginUrl);
        return { action: 'deny' };
      }

      const parsedUrl = new URL(url);
      const protocol = parsedUrl.protocol;
      const host = parsedUrl.host;
      
      if (host === new URL(appURL).host || isFederatedIdentityProviderLogin(parsedUrl)) {
        win.loadURL(url);
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

  win.loadURL(appURL);

  // Disable startup-only auth prompt bypass after the first loaded page.
  win.webContents.once('did-finish-load', () => {
    allowStartupAuthPromptBypass = false;
  });

  win.webContents.on('did-finish-load', () => {
    if (isScreenshotMode) {
      console.log('Screenshot mode: waiting 5 seconds for content to render...');
      setTimeout(async () => {
        try {
          console.log('Capturing screenshot...');
          const image = await win.capturePage();
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

  win.webContents.on('before-input-event', (event, input) => {
    if (input.control && input.key.toLowerCase() === 'r') {
      console.log('Pressed Control+R')
      event.preventDefault()
      win.loadURL(appURL);
    }
  })
}

// Ensure we're a single instance app
const firstInstance = app.requestSingleInstanceLock();

if (!firstInstance) {
  app.quit();
} else {
  app.on("second-instance", (event) => {
    console.log("second-instance");
    if (!win) {
      createWindow();
    }
    if (win) {
      win.show();
      win.focus();
    }
  });
}

function createAboutWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { x, y, width, height } = primaryDisplay.bounds;

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
    parent: win  // Set the main window as parent
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

// Enable usage of Portal's globalShortcuts. This is essential for cases when
// the app runs in a Wayland session.
app.commandLine.appendSwitch('enable-features', 'GlobalShortcutsPortal')

app.on('ready', async () => {
  console.log(`Electron Version: ${process.versions.electron}`);
  console.log(`App Version: ${app.getVersion()}`);

  await restoreCookiesSnapshot();

  if (!isScreenshotMode) {
    // Register global shortcut  Alt+H
    const ret = globalShortcut.register(showHideShortcut, () => {
      console.log("globalShortcut: " + showHideShortcut);
      showOrHide();
    });

    if (!ret) {
      console.log('registration failed')
    }

    // Check whether a shortcut is registered.
    console.log(globalShortcut.isRegistered(showHideShortcut));

    tray = new Tray(icon);
    // Ignore double click events for the tray icon
    tray.setIgnoreDoubleClickEvents(true)
    tray.on('click', () => {
      console.log("AppIndicator clicked");
      showOrHide();
    });

    // Ensure autostart is set properly at start
    initializeAutostart();

    const contextMenu = Menu.buildFromTemplate([
      {
        label: `Show/Hide CoPilot (${showHideShortcut})`,
        icon: icon,
        click: () => {
          showOrHide();
        }
      },
      {
        label: 'Autostart',
        type: 'checkbox',
        checked: autostart,
        click: () => {
          autostart = contextMenu.items[1].checked;
          console.log("Autostart toggled: " + autostart);
          handleAutoStartChange();
          // We need to setContextMenu to get the state changed for checked
          tray.setContextMenu(contextMenu);
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
      { label: 'About',
        click: () => {
          console.log("About clicked");
      createAboutWindow();
        }
      },
      { label: 'Quit',
        click: () => {
          console.log("Quit clicked, Exiting");
          app.quit();
        }
      },
    ]);

    tray.setToolTip('Copilot');
    tray.setContextMenu(contextMenu);
  }

  if (!win || win.isDestroyed()) {
    createWindow();
  }
});

function showOrHide() {
  console.log("showOrHide");
  if (win.isVisible()) {
    win.hide();
  } else {
    win.show();
  }
}

app.on('before-quit', async (event) => {
  if (app.isQuittingForSessionPersist) {
    return;
  }

  app.isQuittingForSessionPersist = true;
  event.preventDefault();
  await persistSessionData();
  app.quit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  console.log("window-all-closed");
});

app.on('activate', () => {
  console.log("ACTIVATE");
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
