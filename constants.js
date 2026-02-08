// Shared constants for the Copilot Desktop application

// Hosts allowed to navigate within the Electron window
// This list is used in both the main process (index.js) and preload script (preload.js)
// to ensure consistent navigation behavior for the app and authentication flows
const allowedHosts = new Set([
    'copilot.microsoft.com',
    'login.microsoftonline.com',
    'login.live.com',
]);

module.exports = {
    allowedHosts
};
