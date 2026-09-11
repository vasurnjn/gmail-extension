import { GMAIL_PROFILE_ENDPOINT } from '../../shared/constants';
import { storage } from '../../shared/storage';
import { LocalSyncState } from '../../shared/types';
import { db } from '../../db';
import { clearAllAccountNotificationsAndAlarms } from '../notifications';

export interface GmailProfileResult {
  emailAddress: string;
  historyId: string;
  messagesTotal: number;
}

export interface AuthOperationResult {
  success: boolean;
  email?: string;
  error?: string;
}

/**
 * Low-level wrapper around chrome.identity.getAuthToken.
 * Accepts an optional accountId to target a specific Google account.
 * Returns a valid OAuth 2.0 access token or rejects with a descriptive error.
 */
export async function getAuthToken(interactive = false, accountId?: string): Promise<string> {
  if (typeof chrome === 'undefined' || !chrome.identity?.getAuthToken) {
    throw new Error('Chrome Identity API (chrome.identity.getAuthToken) is not available.');
  }

  const details: chrome.identity.TokenDetails = { interactive };
  if (accountId) {
    details.account = { id: accountId };
  }

  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken(details, (token) => {
      if (chrome.runtime.lastError) {
        const rawError = chrome.runtime.lastError.message || 'Unknown OAuth error';
        if (rawError.includes('OAuth2 client not found') || rawError.includes('bad client id')) {
          reject(
            new Error(
              'Google OAuth Client ID is not configured in manifest.json or not registered in Google Cloud Console for this Extension ID.'
            )
          );
        } else if (rawError.includes('User cancelled') || rawError.includes('user did not approve')) {
          reject(new Error('User declined or closed the Google authorization prompt.'));
        } else {
          reject(new Error(`OAuth error: ${rawError}`));
        }
        return;
      }

      if (!token) {
        reject(new Error('No token returned from chrome.identity.getAuthToken.'));
        return;
      }

      resolve(token);
    });
  });
}

/**
 * Removes an invalidated or expired token from Chrome's identity cache.
 */
export async function removeCachedAuthToken(token: string): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.identity?.removeCachedAuthToken) {
    return;
  }

  return new Promise((resolve) => {
    chrome.identity.removeCachedAuthToken({ token }, () => {
      resolve();
    });
  });
}

/**
 * Clears all cached auth tokens and removes user's account preferences from Chrome Identity.
 * This is critical for account switching so Chrome forgets the previous account preference.
 */
export async function clearAllCachedAuthTokens(): Promise<void> {
  if (typeof chrome !== 'undefined' && typeof chrome.identity?.clearAllCachedAuthTokens === 'function') {
    return new Promise((resolve) => {
      chrome.identity.clearAllCachedAuthTokens(() => {
        resolve();
      });
    });
  }
}

/**
 * Revokes an OAuth access token at Google's OAuth2 revocation endpoint.
 * Ensures the grant is revoked server-side.
 */
export async function revokeTokenOnGoogle(token: string): Promise<void> {
  try {
    await fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `token=${encodeURIComponent(token)}`,
    });
  } catch (err) {
    console.warn('[IGAM Auth] Revoke request error (ignored):', err);
  }
}

/**
 * Returns available accounts known to the Chrome Identity API if supported.
 * On platforms where getAccounts is unsupported or restricted to dev/ChromeOS, returns empty array.
 */
export async function getAvailableAccounts(): Promise<string[]> {
  if (typeof chrome !== 'undefined' && typeof chrome.identity?.getAccounts === 'function') {
    return new Promise((resolve) => {
      try {
        chrome.identity.getAccounts((accounts) => {
          if (chrome.runtime.lastError || !Array.isArray(accounts)) {
            resolve([]);
          } else {
            resolve(accounts.map((a) => a.id).filter(Boolean));
          }
        });
      } catch {
        resolve([]);
      }
    });
  }
  return [];
}

/**
 * Verifies Gmail access by making ONE minimal profile request.
 * Does not read or download email messages.
 */
export async function fetchGmailProfile(token: string): Promise<GmailProfileResult> {
  const response = await fetch(GMAIL_PROFILE_ENDPOINT, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });

  if (response.status === 401) {
    await removeCachedAuthToken(token);
    throw new Error('Gmail token expired or unauthorized (401). Token was invalidated from cache.');
  }

  if (!response.ok) {
    let errorDetail = '';
    try {
      const errJson = await response.json();
      errorDetail = errJson.error?.message || response.statusText;
    } catch {
      errorDetail = response.statusText;
    }
    throw new Error(`Gmail API error (${response.status}): ${errorDetail}`);
  }

  const data = await response.json();
  return {
    emailAddress: data.emailAddress,
    historyId: data.historyId,
    messagesTotal: data.messagesTotal || 0,
  };
}

/**
 * Connects Gmail using Chrome Identity OAuth.
 * Can optionally accept an accountId if switching to a specific known account.
 */
export async function connectGmail(interactive = true, accountId?: string): Promise<AuthOperationResult> {
  try {
    await storage.setSyncState({
      authState: 'connecting',
      lastError: null,
    });

    // 1. Obtain token (passes accountId if provided)
    const token = await getAuthToken(interactive, accountId);

    // 2. Make single verification request (profile only)
    const profile = await fetchGmailProfile(token);

    // 3. Mark connected and save profile metadata (DO NOT store the access token)
    await storage.setSyncState({
      authState: 'connected',
      accountEmail: profile.emailAddress,
      historyId: profile.historyId,
      lastError: null,
    });

    return {
      success: true,
      email: profile.emailAddress,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[IGAM Auth] Connection failed:', message);

    await storage.setSyncState({
      authState: 'error',
      lastError: message,
    });

    return {
      success: false,
      error: message,
    };
  }
}

/**
 * Disconnects the Gmail account:
 * - Evicts token from cache
 * - Revokes token with Google server
 * - Clears all cached tokens in Chrome Identity
 * - Clears local email records from Dexie to prevent data mixing
 * - Resets local sync state
 */
export async function disconnectGmail(): Promise<AuthOperationResult> {
  try {
    let currentToken: string | null = null;
    try {
      currentToken = await getAuthToken(false);
    } catch {
      // Token might already be expired or absent
    }

    if (currentToken) {
      await removeCachedAuthToken(currentToken);
      await revokeTokenOnGoogle(currentToken);
    }

    // Clear Chrome Identity API cached tokens & account preferences
    await clearAllCachedAuthTokens();

    // Clear local stored emails, attention items, scheduled alarms, and notifications so old account data is completely isolated
    try {
      await db.emails.clear();
      await db.attentionItems.clear();
      await clearAllAccountNotificationsAndAlarms(db);
    } catch (dbErr) {
      console.warn('[IGAM Auth] Error clearing DB or alarms on disconnect:', dbErr);
    }

    // Reset local sync state
    await storage.setSyncState({
      historyId: null,
      lastPollTime: null,
      lastSafetyScanTime: null,
      lastSyncTime: null,
      isSyncing: false,
      authState: 'not_connected',
      accountEmail: null,
      lastError: null,
    });

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[IGAM Auth] Disconnect error:', message);
    return { success: false, error: message };
  }
}

/**
 * Switches the active Google account:
 * 1. Fully disconnects current account and clears local data/tokens.
 * 2. Prompts user for authorization with the new/selected account.
 */
export async function switchAccount(accountId?: string): Promise<AuthOperationResult> {
  // Disconnect first to wipe tokens and local emails
  await disconnectGmail();

  // Trigger interactive connection (optionally for specific accountId)
  return connectGmail(true, accountId);
}

/**
 * Validates current authentication state without prompting the user.
 */
export async function checkGmailAuthStatus(): Promise<LocalSyncState> {
  const currentState = await storage.getSyncState();

  if (currentState.authState !== 'connected') {
    return currentState;
  }

  try {
    const token = await getAuthToken(false);
    const profile = await fetchGmailProfile(token);

    if (profile.emailAddress !== currentState.accountEmail) {
      await storage.setSyncState({ accountEmail: profile.emailAddress });
    }

    return await storage.getSyncState();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[IGAM Auth] Silent auth check failed:', message);

    const updated = await storage.setSyncState({
      authState: 'not_connected',
      accountEmail: null,
      lastError: 'Session expired or authorization revoked.',
    });

    return updated;
  }
}
