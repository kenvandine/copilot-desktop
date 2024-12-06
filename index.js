const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell } = require('electron');
const { join } = require('path');

let tray = null;
let win = null;
const appURL = 'https://copilot.microsoft.com'

function createWindow () {
  const icon = nativeImage.createFromPath('/snap/ken-copilot/current/icon.png');
  win = new BrowserWindow({
    width: 800,
    height: 800,
    icon: icon,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      nodeIntegration: true,
      contextIsolation: true,
      sandbox: false
    }
  });

  win.removeMenu();

  //win.loadFile(join(__dirname, 'index.html'));
  win.loadURL(appURL);

  tray = new Tray(icon);
  // Ignore double click events for the tray icon
  tray.setIgnoreDoubleClickEvents(true)

  const contextMenu = Menu.buildFromTemplate([
	  { label: 'Copilot', click: () => focusWindow()},
	  { label: 'Quit', click: () => app.quit() }
  ]);

  tray.setTitle('Copilot');
  tray.setToolTip('Copilot');
  tray.setContextMenu(contextMenu);
  tray.on('click', () => {
	  console.log("click");
	  focusWindow();
  });

  ipcMain.on('log-message', (event, message) => {
    console.log('Log from preload: ', message);
  });

  // Open links with default browser
  ipcMain.on('open-external-link', (event, url) => {
    console.log('open-external-link: ', url);
    shell.openExternal(url);
  });

  // Listen for network status updates from the renderer process
  ipcMain.on('network-status', (event, isOnline) => {
    console.log(`Network status: ${isOnline ? 'online' : 'offline'}`);
    console.log("network-status changed: " + isOnline);
    if (isOnline) {
      win.loadURL(appURL);
    } else {
      win.loadFile('offline.html');
    }
  });
}

function focusWindow() {
  console.log("focusWindow");
  if (win.isFocused()) {
    win.hide();
  } else {
    win.show();
  }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  console.log("ACTIVATE");
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});