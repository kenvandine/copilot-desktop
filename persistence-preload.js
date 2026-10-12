const { ipcRenderer } = require('electron');
const { join, dirname } = require('path');
const fs = require('fs');
const { allowedHosts } = require('./constants');

const sessionStorageSnapshotsFile = 'session-storage-snapshots.json';
const lastAppLocationFile = 'last-app-location.json';
const appURL = 'https://copilot.microsoft.com';
const resumableHosts = new Set([
    'copilot.microsoft.com',
    'copilot.cloud.microsoft',
    'm365.cloud.microsoft'
]);

let userDataPath = '';

function initializeUserDataPath() {
    try {
        userDataPath = ipcRenderer.sendSync('persistency-get-user-data-path-sync') || '';
    } catch {
        userDataPath = '';
    }
}

function shouldRunInitialRestore() {
    try {
        return ipcRenderer.sendSync('persistency-consume-initial-restore-sync') === true;
    } catch {
        return false;
    }
}

function getSessionStorageSnapshotsPath() {
    return userDataPath ? join(userDataPath, sessionStorageSnapshotsFile) : '';
}

function getLastAppLocationPath() {
    return userDataPath ? join(userDataPath, lastAppLocationFile) : '';
}

function readJsonFile(filePath, fallbackValue) {
    try {
        if (!filePath || !fs.existsSync(filePath)) {
            return fallbackValue;
        }
        const raw = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(raw);
    } catch {
        return fallbackValue;
    }
}

function writeJsonFile(filePath, value) {
    try {
        if (!filePath) {
            return;
        }
        fs.mkdirSync(dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
    } catch {
        // Best effort persistence.
    }
}

function isAllowedSnapshotOrigin(urlString) {
    try {
        const url = new URL(urlString);
        return (url.protocol === 'http:' || url.protocol === 'https:') && allowedHosts.has(url.host);
    } catch {
        return false;
    }
}

function isResumableAppURL(urlString) {
    try {
        const url = new URL(urlString);
        return (url.protocol === 'http:' || url.protocol === 'https:') && resumableHosts.has(url.host);
    } catch {
        return false;
    }
}

function loadSessionStorageSnapshots() {
    const snapshots = readJsonFile(getSessionStorageSnapshotsPath(), {});
    if (!snapshots || typeof snapshots !== 'object' || Array.isArray(snapshots)) {
        return {};
    }
    return snapshots;
}

function saveSessionStorageSnapshots(snapshots) {
    writeJsonFile(getSessionStorageSnapshotsPath(), snapshots);
}

function loadLastAppLocation() {
    const value = readJsonFile(getLastAppLocationPath(), null);
    if (!value || typeof value.url !== 'string' || !isResumableAppURL(value.url)) {
        return '';
    }
    return value.url;
}

function saveLastAppLocation(urlString) {
    if (!isResumableAppURL(urlString)) {
        return;
    }

    writeJsonFile(getLastAppLocationPath(), {
        url: urlString,
        updatedAt: new Date().toISOString()
    });
}

function captureSessionStorageSnapshot() {
    try {
        if (!isAllowedSnapshotOrigin(window.location.href)) {
            return {};
        }

        const snapshot = {};
        for (let i = 0; i < window.sessionStorage.length; i += 1) {
            const key = window.sessionStorage.key(i);
            if (key) {
                snapshot[key] = window.sessionStorage.getItem(key) || '';
            }
        }
        return snapshot;
    } catch {
        return {};
    }
}

function persistSessionStorageSnapshot() {
    try {
        if (!isAllowedSnapshotOrigin(window.location.href)) {
            return;
        }

        const origin = new URL(window.location.href).origin;
        const snapshots = loadSessionStorageSnapshots();
        snapshots[origin] = {
            updatedAt: new Date().toISOString(),
            data: captureSessionStorageSnapshot()
        };
        saveSessionStorageSnapshots(snapshots);
        saveLastAppLocation(window.location.href);
    } catch {
        // Best effort persistence.
    }
}

function restoreSessionStorageEarly() {
    try {
        if (!isAllowedSnapshotOrigin(window.location.href)) {
            return;
        }

        const origin = new URL(window.location.href).origin;
        const snapshots = loadSessionStorageSnapshots();
        const entry = snapshots[origin];
        const snapshot = entry && entry.data;
        if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
            return;
        }

        Object.keys(snapshot).forEach((key) => {
            const value = snapshot[key];
            if (typeof value === 'string') {
                window.sessionStorage.setItem(key, value);
            }
        });
    } catch (error) {
        ipcRenderer.send('log-message', `sessionStorage early restore failed: ${String(error)}`);
    }
}

function resumeLastLocationEarly() {
    try {
        const lastUrl = loadLastAppLocation();
        if (!lastUrl) {
            return;
        }

        const currentUrl = new URL(window.location.href);
        const appRoot = new URL(appURL);

        const isCopilotRoot = currentUrl.origin === appRoot.origin && (currentUrl.pathname === '/' || currentUrl.pathname === '');
        if (isCopilotRoot && lastUrl !== window.location.href) {
            window.location.replace(lastUrl);
        }
    } catch {
        // Best effort resume.
    }
}

initializeUserDataPath();
if (shouldRunInitialRestore()) {
    restoreSessionStorageEarly();
    resumeLastLocationEarly();
}

// Network status detection
function updateNetworkStatus() {
    ipcRenderer.send('network-status', navigator.onLine);
}

window.addEventListener('online', updateNetworkStatus);
window.addEventListener('offline', updateNetworkStatus);
window.addEventListener('beforeunload', persistSessionStorageSnapshot);
window.addEventListener('pagehide', persistSessionStorageSnapshot);
window.addEventListener('hashchange', persistSessionStorageSnapshot);
window.addEventListener('popstate', persistSessionStorageSnapshot);

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
        persistSessionStorageSnapshot();
    }
});

setInterval(persistSessionStorageSnapshot, 5000);
// Don't call updateNetworkStatus() immediately to avoid reload loops
// Only send status on actual online/offline events

// Listen for DOMContentLoaded event
window.addEventListener('DOMContentLoaded', () => {
    persistSessionStorageSnapshot();

    // Wire up retry button on offline page
    const retryBtn = document.getElementById('retry-btn');
    if (retryBtn) {
        retryBtn.addEventListener('click', () => {
            ipcRenderer.send('retry-connection');
        });
    }

    // Listen for click events and open non-allowed links externally
    document.addEventListener('click', (event) => {
        const target = event.target;
        if (!(target instanceof Element)) {
            return;
        }
        const link = target.closest('a');
        if (link && link.href && link.href.startsWith('http')) {
            try {
                const host = new URL(link.href).host;
                if (allowedHosts.has(host)) {
                    return; // Allow app + auth links to navigate in-app
                }
            } catch (e) {
                // If URL parsing fails, open externally as a safety measure
            }
            event.preventDefault();
            ipcRenderer.send('open-external-link', link.href);
        }
    });
});

// Handle keyboard shortcuts for zoom
document.addEventListener('keydown', (event) => {
    if (event.ctrlKey) {
        if (event.key === '+') {
            ipcRenderer.send('zoom-in');
        } else if (event.key === '-') {
            ipcRenderer.send('zoom-out');
        } else if (event.key === '0') {
            ipcRenderer.send('zoom-reset');
        }
    }
});

// Handle mouse wheel zoom
document.addEventListener('wheel', (event) => {
    if (event.ctrlKey) {
        event.preventDefault(); // Prevent default scrolling
        if (event.deltaY < 0) {
            ipcRenderer.send('zoom-in');
        } else {
            ipcRenderer.send('zoom-out');
        }
    }
});
