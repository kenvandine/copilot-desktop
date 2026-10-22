const { app, BrowserWindow, ipcMain, net } = require('electron');
const path = require('path');
const { allowedHosts } = require('./constants');

// Track network status
let isOnline = true;

// Create the browser window
function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    icon: path.join(__dirname, 'assets/img/icon.png'),
  });

  // Load the index.html file
  mainWindow.loadFile(path.join(__dirname, 'assets/html/index.html'));

  // Check network status
  checkNetworkStatus();

  // Listen for network status changes
  const handleNetworkChange = () => {
    checkNetworkStatus();
  };

  // Listen for network status changes (Electron 20+ way)
  if (app.isPackaged) {
    // For packaged apps, we can't use the old way, so we'll check periodically
    setInterval(handleNetworkChange, 5000);
  } else {
    // For development, we can use the old way
    app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
      // Allow certificate errors (for development)
      callback(true);
    });
  }

  // Handle navigation events
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const urlObj = new URL(url);
    if (!allowedHosts.has(urlObj.hostname)) {
      event.preventDefault();
      mainWindow.loadURL(url);
    }
  });

  // Handle new window events
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const urlObj = new URL(url);
    if (allowedHosts.has(urlObj.hostname)) {
      return { action: 'allow' };
    }
    return { action: 'deny' };
  });

  // Handle network errors
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (isMainFrame && errorCode !== 0) {
      // If the main frame fails to load, show offline page
      mainWindow.loadFile(path.join(__dirname, 'assets/html/offline.html'));
    }
  });

  // Handle online/offline events
  mainWindow.webContents.on('did-change-theme-color', (event, themeColor) => {
    // Handle theme color changes if needed
  });

  return mainWindow;
}

// Check network status
function checkNetworkStatus() {
  const request = net.request('https://www.google.com');
  request.on('response', (response) => {
    if (response.statusCode === 200) {
      isOnline = true;
      // If we were offline, we might want to reload the main page
      // but we don't want to reset the conversation
    }
  });
  request.on('error', () => {
    isOnline = false;
  });
  request.end();
}

// Handle app ready event
app.whenReady().then(() => {
  const mainWindow = createWindow();

  // Handle window close event
  mainWindow.on('close', (event) => {
    // Prevent closing the window, just hide it
    event.preventDefault();
    mainWindow.hide();
  });

  // Handle app quit event
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });

  // Handle IPC messages
  ipcMain.on('show-window', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  ipcMain.on('hide-window', () => {
    mainWindow.hide();
  });

  ipcMain.on('reload-window', () => {
    // Only reload if we're online
    if (isOnline) {
      mainWindow.reload();
    }
  });

  ipcMain.on('check-network', () => {
    checkNetworkStatus();
    mainWindow.webContents.send('network-status', isOnline);
  });
});

// Handle app quit
app.on('before-quit', () => {
  // Clean up resources if needed
});
