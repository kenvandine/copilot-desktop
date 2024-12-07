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

  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show/Hide CoPilot',
      icon: icon,
      click: () => {
        if (win.isVisible()) {
          win.hide();
        } else {
          win.show();
        }
      }
    },
    { type: 'separator' },
    { label: 'Quit', role: 'quit' }
  ]);

  tray.setToolTip('Copilot');
  tray.setContextMenu(contextMenu);

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

  //win.loadFile(join(__dirname, 'index.html'));
  win.loadURL(appURL);
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
