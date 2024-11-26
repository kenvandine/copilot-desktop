const { app, BrowserWindow, Tray, Menu, nativeImage } = require('electron');

let tray = null;
let win = null;

function createWindow () {
  const icon = nativeImage.createFromPath('/snap/ken-copilot/current/icon.png');
  win = new BrowserWindow({
    width: 800,
    height: 800,
    icon: icon,
    webPreferences: {
      nodeIntegration: true
    }
  });

  win.removeMenu();
  win.loadURL('https://copilot.microsoft.com');

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

/*
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
*/

app.on('activate', () => {
	console.log("ACTIVATE");
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
