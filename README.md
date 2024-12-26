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

## Updating the source code

Simply pull the latest version of master and install any changed dependencies:

```bash
git checkout main
git pull
npm install
```
