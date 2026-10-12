const { allowedHosts } = require('./constants');

// Normalize incoming value to a URL instance. Most callers already pass URL,
// but some paths still pass raw strings.
function toUrl(inputUrl) {
  if (inputUrl instanceof URL) {
    return inputUrl;
  }

  return new URL(String(inputUrl || ''));
}

// Verifies that an OAuth redirect_uri points back to Copilot's auth callback.
// This is used in provider-specific checks (Google/Apple) to confirm the
// redirect target is expected for this app's login flow.
function isCopilotAuthCallbackUrl(rawUrl) {
  if (!rawUrl) {
    return false;
  }

  try {
    const parsedUrl = new URL(rawUrl);
    return parsedUrl.host === 'auth.copilot.microsoft.com' && parsedUrl.pathname === '/login/callback';
  } catch {
    return false;
  }
}

// Matches Copilot-hosted broker flows on auth.copilot.microsoft.com.
// Supported patterns:
// - /authorize?connection=<provider> for start of provider handoff.
// - /login/callback when returning from provider OAuth.
// Provider names are supplied by each provider branch to keep the matching
// strict and explicit per branch.
function isCopilotProviderFlow(inputUrl, allowedConnections) {
  const parsedUrl = toUrl(inputUrl);

  // Domain gate is centralized in constants.js.
  if (!allowedHosts.has(parsedUrl.host) || parsedUrl.host !== 'auth.copilot.microsoft.com') {
    return false;
  }

  // Callback is a valid continuation for any provider once external auth returns.
  if (parsedUrl.pathname === '/login/callback') {
    return true;
  }

  if (parsedUrl.pathname !== '/authorize') {
    return false;
  }

  const connection = parsedUrl.searchParams.get('connection');
  const connectionSet = new Set(allowedConnections);
  return Boolean(connection && connectionSet.has(connection));
}

// Microsoft branch -----------------------------------------------------------
// Handles enterprise/federated Microsoft WS-Federation handoffs.
// Important for organizational logins that redirect to ADFS or external IdPs.
function microsoftFederatedLogin(inputUrl) {
  try {
    const parsedUrl = toUrl(inputUrl);
    const realm = parsedUrl.searchParams.get('wtrealm');
    const action = parsedUrl.searchParams.get('wa');
    const microsoftRealm = 'urn:federation:microsoftonline';

    // Enterprise ADFS/WS-Fed handoff (e.g. https://<corp>/adfs/ls/?wa=wsignin1.0&wtrealm=urn:federation:MicrosoftOnline)
    if (parsedUrl.pathname.toLowerCase().includes('/adfs/ls') && action === 'wsignin1.0') {
      if (realm && realm.toLowerCase() === microsoftRealm) {
        return true;
      }

      // Some IdPs encode/relay the realm within the context payload.
      const contextPayload = parsedUrl.searchParams.get('wctx') || '';
      if (contextPayload.includes('urn:federation:MicrosoftOnline') || contextPayload.includes('urn%3Afederation%3AMicrosoftOnline')) {
        return true;
      }
    }

    // Direct realm check without explicit ADFS path.
    return (realm || '').toLowerCase() === microsoftRealm;
  } catch {
    // Fallback for malformed URLs where parsing fails.
    const raw = String(inputUrl || '');
    return (
      raw.includes('wtrealm=urn:federation:MicrosoftOnline') ||
      raw.includes('wtrealm=urn%3Afederation%3AMicrosoftOnline') ||
      (raw.includes('/adfs/ls') && raw.includes('wa=wsignin1.0') && raw.includes('MicrosoftOnline'))
    );
  }
}

// Handles Microsoft login flow when Microsoft account auth is delegated to
// GitHub (idp_hint=github.com path).
// We treat this as Microsoft login because session/callback returns through
// login.live.com, not as a standalone GitHub app login.
function microsoftGithubLogin(inputUrl) {
  try {
    const parsedUrl = toUrl(inputUrl);

    // Domain parsing is centralized in constants.js.
    if (!allowedHosts.has(parsedUrl.host) || parsedUrl.host !== 'github.com') {
      return false;
    }

    const microsoftGithubCallback = 'https://login.live.com/HandleGithubResponse.srf';

    // First GitHub OAuth endpoint used by Microsoft login handoff.
    if (parsedUrl.pathname === '/login/oauth/authorize') {
      const redirectUri = parsedUrl.searchParams.get('redirect_uri') || '';
      return redirectUri.toLowerCase() === microsoftGithubCallback.toLowerCase();
    }

    // Second GitHub step can be /login with an encoded return_to OAuth URL.
    if (parsedUrl.pathname === '/login') {
      const returnTo = parsedUrl.searchParams.get('return_to') || '';
      if (!returnTo) {
        return false;
      }

      try {
        // return_to may be relative; resolve against GitHub origin.
        const returnToUrl = new URL(returnTo, 'https://github.com');
        if (returnToUrl.pathname !== '/login/oauth/authorize') {
          return false;
        }

        const redirectUri = returnToUrl.searchParams.get('redirect_uri') || '';
        return redirectUri.toLowerCase() === microsoftGithubCallback.toLowerCase();
      } catch {
        // Fallback for partially encoded return_to strings.
        return returnTo.includes('/login/oauth/authorize') && returnTo.includes('login.live.com%2FHandleGithubResponse.srf');
      }
    }

    return false;
  } catch {
    return false;
  }
}

// Handles first-party Microsoft account logins (Microsoft Online + Live).
// Also includes Microsoft->GitHub delegated auth via microsoftGithubLogin().
function microsoftLogin(inputUrl) {
  try {
    const parsedUrl = toUrl(inputUrl);
    const appRedirect = 'https://copilot.microsoft.com';

    if (!allowedHosts.has(parsedUrl.host)) {
      return false;
    }

    // Microsoft identity with GitHub as upstream provider is treated as part
    // of the Microsoft login branch.
    if (microsoftGithubLogin(parsedUrl)) {
      return true;
    }

    // Initial MSAL authorize request.
    if (parsedUrl.host === 'login.microsoftonline.com') {
      // Typical MSAL authorization start, e.g. /common/oauth2/v2.0/authorize
      const isAuthorizePath = parsedUrl.pathname.toLowerCase().includes('/oauth2/v2.0/authorize');
      if (!isAuthorizePath) {
        return false;
      }

      const redirectUri = parsedUrl.searchParams.get('redirect_uri');
      return redirectUri === appRedirect;
    }

    // MSA hop after Microsoft Online.
    if (parsedUrl.host === 'login.live.com') {
      // Standard MSA hop from Microsoft Online to Live.
      if (parsedUrl.pathname !== '/oauth20_authorize.srf') {
        return false;
      }

      const redirectUri = parsedUrl.searchParams.get('redirect_uri') || '';
      return redirectUri.toLowerCase() === appRedirect;
    }

    return false;
  } catch {
    return false;
  }
}

// Google branch --------------------------------------------------------------
// Handles Google login flows for Copilot:
// - Copilot brokered flow through auth.copilot.microsoft.com.
// - Direct Google OAuth URLs that point back to Copilot callback.
function googleLogin(inputUrl) {
  try {
    const parsedUrl = toUrl(inputUrl);
    const googleHost = 'accounts.google.com';

    // Copilot brokered Google flow: auth.copilot.microsoft.com/authorize?connection=google(-oauth2)
    if (isCopilotProviderFlow(parsedUrl, ['google', 'google-oauth2'])) {
      return true;
    }

    if (!allowedHosts.has(parsedUrl.host) || parsedUrl.host !== googleHost) {
      return false;
    }

    // Known Google OAuth endpoints observed in this app.
    const allowedGooglePaths = new Set([
      '/o/oauth2/auth',
      '/v3/signin/identifier',
    ]);

    // Backstop for known Google host in case Google introduces additional paths.
    // This prevents accidental external navigation for newly introduced Google
    // auth endpoints that still belong to the same provider flow.
    if (!allowedGooglePaths.has(parsedUrl.pathname)) {
      return true;
    }

    const redirectUri = parsedUrl.searchParams.get('redirect_uri');
    return isCopilotAuthCallbackUrl(redirectUri);
  } catch {
    return false;
  }
}

// Apple branch ---------------------------------------------------------------
// Handles Apple login flows for Copilot:
// - Copilot brokered flow through auth.copilot.microsoft.com.
// - Apple authorize endpoint returning to Copilot callback.
function appleLogin(inputUrl) {
  try {
    const parsedUrl = toUrl(inputUrl);
    const appleHost = 'appleid.apple.com';

    // Copilot brokered Apple flow: auth.copilot.microsoft.com/authorize?connection=apple
    if (isCopilotProviderFlow(parsedUrl, ['apple'])) {
      return true;
    }

    if (!allowedHosts.has(parsedUrl.host) || parsedUrl.host !== appleHost) {
      return false;
    }

    if (parsedUrl.pathname !== '/auth/authorize') {
      // Backstop for known Apple host if Apple updates auth path.
      return true;
    }

    const redirectUri = parsedUrl.searchParams.get('redirect_uri');
    return isCopilotAuthCallbackUrl(redirectUri);
  } catch {
    return false;
  }
}

// Top-level classifier used by navigation guards in the Electron main process.
// The order is intentional:
// 1) Microsoft direct and delegated flows
// 2) Google flows
// 3) Apple flows
// Any match means "keep this navigation in-app".
function isFederatedIdentityProviderLogin(inputUrl) {
  try {
    const parsedUrl = toUrl(inputUrl);

    // Branch 1: Microsoft login flows.
    if (microsoftLogin(parsedUrl) || microsoftFederatedLogin(parsedUrl)) {
      return true;
    }

    // Branch 2: Google login flows.
    if (googleLogin(parsedUrl)) {
      return true;
    }

    // Branch 3: Apple login flows.
    if (appleLogin(parsedUrl)) {
      return true;
    }

    return false;
  } catch {
    // Preserve tolerant fallback for malformed-but-known Microsoft federated
    // URLs, which are common in enterprise WS-Fed redirects.
    return microsoftFederatedLogin(inputUrl);
  }
}

module.exports = {
  microsoftFederatedLogin,
  microsoftLogin,
  googleLogin,
  appleLogin,
  isFederatedIdentityProviderLogin,
};