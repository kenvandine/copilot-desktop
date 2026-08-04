# About


Unofficial wrapper for Microsoft's Copilot AI Companion, providing a native Linux desktop experince.

## Disclaimer

This project and its contributors are not affiliated with Microsoft. This is simply an Electron wrapper that loads the offical Microsoft Copilot web application.
# Installation

[![Get it from the Snap Store](https://raw.githubusercontent.com/snapcore/snap-store-badges/master/EN/%5BEN%5D-snap-store-white.png)](https://snapcraft.io/copilot-desktop)

[![copilot-desktop](https://snapcraft.io/copilot-desktop/badge.svg)](https://snapcraft.io/copilot-desktop)
[![copilot-desktop](https://snapcraft.io/copilot-desktop/trending.svg?name=0)](https://snapcraft.io/copilot-desktop)

## Requirements

You will need to install [npm](https://www.npmjs.com/), the Node.js package manager. On most distributions, the package is simply called `npm`.

## Cloning the source code

Once you have npm, clone the wrapper to a convenient location:

```bash
git clone https://github.com/kenvandine/copilot-desktop.git
```

## Building

```bash
npm install
npm start
```

On subsequent runs, `npm start` will be all that's required.

## Window toggling and system shortcuts

This app previously supported an internal keyboard shortcut for showing and hiding windows. That approach was removed because global shortcut registration is not reliable across Linux desktop environments, especially under Wayland and portal-managed sessions.

Instead, window toggling now uses a launch argument handled by the already running app instance:

```bash
--toggle-windows
```

When a second app launch includes this argument, the running instance receives it and toggles window visibility instead of opening a duplicate app process.

To toggle visibility in an already running instance from the CLI, use:

```bash
npm run toggle-windows
```

If you prefer using `npm start`, pass script arguments through npm with `--`:

```bash
npm start -- --toggle-windows
```

For desktop use, the recommended replacement for the removed internal shortcut is to create a system keyboard shortcut that launches the app with this argument.

Examples:

```bash
copilot-desktop --toggle-windows
```

For local development from this repository:

```bash
cd /path/to/copilot-desktop && npm run toggle-windows
```

Recommended system shortcut setup:

1. Open your desktop environment keyboard shortcut settings.
2. Create a new custom shortcut.
3. Set the command to `copilot-desktop --toggle-windows` if the app is installed system-wide.
4. If you are running from source, set the command to `npm run toggle-windows` from this project directory, or wrap it in a small launcher script that first changes into the repository directory.
5. Bind the shortcut to your preferred key combination.

This approach is more reliable than in-app shortcut registration because the desktop environment owns the keybinding, while the app only responds to a normal second-launch command.

## Updating the source code

Simply pull the latest version of master and install any changed dependencies:

```bash
git checkout main
git pull
npm install
```
