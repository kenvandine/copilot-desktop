// Shared constants for the Copilot Desktop application

// Hosts allowed to navigate within the Electron window
// This list is used in both the main process (index.js) and preload script (persistence-preload.js)
// to ensure consistent navigation behavior for the app and authentication flows
const allowedHosts = new Set([
    // Copilot app hosts
    'copilot.microsoft.com',
    'auth.copilot.microsoft.com',

    // Microsoft first-party auth hosts
    'login.microsoftonline.com',
    'login.live.com',

    // Third-party provider auth hosts used by Copilot login
    'accounts.google.com',
    'appleid.apple.com',
    'github.com',

    // Additional Microsoft cloud hosts
    'copilot.cloud.microsoft',
    'm365.cloud.microsoft',
]);

module.exports = {
    allowedHosts
};
