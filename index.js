const { app, BrowserWindow, screen, Tray, Menu, nativeImage, ipcMain, shell , globalShortcut} = require('electron');
const { join } = require('path');
const fs = require('fs');
const { allowedHosts } = require('./constants');

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

// Open links with default browser
ipcMain.on('open-external-link', (event, url) => {
  console.log('open-external-link: ', url);
  if (!url) {
    return;
  }

  // Validate the sender origin for security
  const senderURL = event.senderFrame.url;
  const isOfflinePage = senderURL.startsWith('file://') && senderURL.includes('offline.html');
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

function createWindow () {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { x, y, width, height } = primaryDisplay.bounds;

  // Log geometry information for easier debugging
  console.log(`Primary Screen Geometry - Width: ${width} Height: ${height} X: ${x} Y: ${y}`);

  win = new BrowserWindow({
    width: width * 0.6,
    height: height * 0.8,
    x: x + ((width - (width * 0.6)) / 2),
    y: y + ((height - (height * 0.8)) / 2),
    icon: icon,
    show: !isTray, // Start hiden if --tray
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      nodeIntegration: true,
      contextIsolation: true,
      sandbox: false
    }
  });

  win.removeMenu();

  win.on('close', (event) => {
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
      (errorCode <= -100 && errorCode >= -199) // Connection errors
    );

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
      const parsedUrl = new URL(url);
      const protocol = parsedUrl.protocol;
      const targetHost = parsedUrl.host;

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
      const parsedUrl = new URL(url);
      const protocol = parsedUrl.protocol;
      const host = parsedUrl.host;
      
      if (host === new URL(appURL).host) {
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
    return { action: 'deny' }
  });

  win.loadURL(appURL);

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

app.on('ready', () => {
  console.log(`Electron Version: ${process.versions.electron}`);
  console.log(`App Version: ${app.getVersion()}`);

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
        app.exit();
      }
    },
  ]);

  tray.setToolTip('Copilot');
  tray.setContextMenu(contextMenu);

  createWindow();
});

function showOrHide() {
  console.log("showOrHide");
  if (win.isVisible()) {
    win.hide();
  } else {
    win.show();
  }
}

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
