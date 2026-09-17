import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { storage } from '../shared/storage';
import { ExtensionSettings, LocalSyncState } from '../shared/types';
import { STORAGE_KEY_SETTINGS, STORAGE_KEY_SYNC_STATE } from '../shared/constants';
import { initTheme } from '../shared/theme';
import { db } from '../db';

function formatRelativeTime(timestamp: number | null): string {
  if (!timestamp) return 'Never';
  const diffSec = Math.floor((Date.now() - timestamp) / 1000);
  if (diffSec < 30) return 'Just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function Popup() {
  const [settings, setSettings] = useState<ExtensionSettings | null>(null);
  const [syncState, setSyncState] = useState<LocalSyncState | null>(null);
  const [emailCount, setEmailCount] = useState<number>(0);
  const [attentionCount, setAttentionCount] = useState<number>(0);
  const [isBusy, setIsBusy] = useState<boolean>(false);

  useEffect(() => {
    let isMounted = true;

    // Initialize design tokens / dark theme
    const cleanupTheme = initTheme();

    async function loadData() {
      const s = await storage.getSettings();
      const sync = await storage.getSyncState();
      let count = 0;
      let attCount = 0;
      try {
        count = await db.emails.count();
        attCount = await db.attentionItems.where('userAttentionState').equals('unhandled').count();
      } catch (err) {
        console.warn('Could not count items:', err);
      }

      if (isMounted) {
        setSettings(s);
        setSyncState(sync);
        setEmailCount(count);
        setAttentionCount(attCount);
      }
    }

    loadData();

    // Listen to real-time storage state updates
    const storageListener = (changes: { [key: string]: chrome.storage.StorageChange }) => {
      if (changes[STORAGE_KEY_SYNC_STATE]) {
        const nextSync = changes[STORAGE_KEY_SYNC_STATE].newValue as LocalSyncState;
        setSyncState(nextSync);
        db.emails.count().then(setEmailCount).catch(() => {});
        db.attentionItems.where('userAttentionState').equals('unhandled').count().then(setAttentionCount).catch(() => {});
      }
      if (changes[STORAGE_KEY_SETTINGS]) {
        const nextSettings = changes[STORAGE_KEY_SETTINGS].newValue as ExtensionSettings;
        setSettings(nextSettings);
      }
    };

    if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
      chrome.storage.onChanged.addListener(storageListener);
    }

    return () => {
      isMounted = false;
      cleanupTheme.then((c) => c());
      if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
        chrome.storage.onChanged.removeListener(storageListener);
      }
    };
  }, []);

  const handleConnectGmail = () => {
    setIsBusy(true);
    chrome.runtime.sendMessage({ type: 'CONNECT_GMAIL' }, (response) => {
      setIsBusy(false);
      if (chrome.runtime.lastError) {
        console.error('Connect error:', chrome.runtime.lastError.message);
      } else if (response?.success) {
        // Trigger immediate email count refresh
        db.emails.count().then(setEmailCount).catch(() => {});
      }
      storage.getSyncState().then(setSyncState);
    });
  };

  const handleDisconnectGmail = () => {
    setIsBusy(true);
    chrome.runtime.sendMessage({ type: 'DISCONNECT_GMAIL' }, () => {
      setIsBusy(false);
      storage.getSyncState().then(setSyncState);
    });
  };

  const handleSwitchAccount = () => {
    setIsBusy(true);
    chrome.runtime.sendMessage({ type: 'SWITCH_ACCOUNT' }, (response) => {
      setIsBusy(false);
      if (chrome.runtime.lastError) {
        console.error('Switch account error:', chrome.runtime.lastError.message);
      } else if (response?.success) {
        db.emails.count().then(setEmailCount).catch(() => {});
      }
      storage.getSyncState().then(setSyncState);
    });
  };

  const handleSyncNow = () => {
    setIsBusy(true);
    chrome.runtime.sendMessage({ type: 'SYNC_NOW' }, (response) => {
      setIsBusy(false);
      if (chrome.runtime.lastError) {
        console.error('Sync error:', chrome.runtime.lastError.message);
      } else {
        db.emails.count().then(setEmailCount).catch(() => {});
      }
      storage.getSyncState().then(setSyncState);
    });
  };

  const handleOpenSidePanel = async () => {
    try {
      const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (currentTab?.windowId && chrome.sidePanel) {
        await chrome.sidePanel.open({ windowId: currentTab.windowId });
        window.close();
      }
    } catch (err) {
      console.error('Error opening side panel:', err);
    }
  };

  const isConnected = syncState?.authState === 'connected';
  const isSyncing = Boolean(syncState?.isSyncing || isBusy);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {/* Header Bar */}
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingBottom: '8px',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '20px',
              height: '20px',
              borderRadius: '4px',
              background: 'var(--accent)',
              color: '#ffffff',
              fontSize: '11px',
              fontWeight: 700,
            }}
          >
            M
          </span>
          <h1 style={{ fontSize: '13px', fontWeight: 600, margin: 0, letterSpacing: '-0.01em' }}>
            Attention Manager
          </h1>
        </div>

        {/* Status Pill */}
        {isSyncing ? (
          <span className="status-pill syncing">
            <span className="spinner" />
            Syncing
          </span>
        ) : isConnected ? (
          <span className="status-pill connected">
            <span style={{ fontSize: '7px' }}>●</span> Connected
          </span>
        ) : syncState?.authState === 'error' ? (
          <span className="status-pill error">Auth Failed</span>
        ) : (
          <span className="status-pill not-connected">Not Connected</span>
        )}
      </header>

      {/* Main Status & Metrics Card */}
      <div
        style={{
          background: 'var(--bg-surface)',
          border: '1px solid var(--border)',
          borderRadius: '6px',
          padding: '12px',
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
          boxShadow: 'var(--card-shadow)',
        }}
      >
        {/* Account Row */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '12px' }}>
          <span style={{ color: 'var(--text-muted)' }}>Account</span>
          <span
            style={{
              fontWeight: 500,
              maxWidth: '180px',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              color: 'var(--text-primary)',
            }}
            title={syncState?.accountEmail || ''}
          >
            {syncState?.accountEmail || 'None connected'}
          </span>
        </div>

        {/* Needs Attention Row */}
        {isConnected && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '12px' }}>
            <span style={{ color: 'var(--text-muted)' }}>Needs Attention</span>
            <span
              style={{
                fontWeight: 600,
                color: attentionCount > 0 ? 'var(--accent)' : 'var(--text-secondary)',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '5px',
              }}
            >
              {attentionCount > 0 && (
                <span
                  style={{
                    width: '6px',
                    height: '6px',
                    borderRadius: '50%',
                    backgroundColor: 'var(--accent)',
                    display: 'inline-block',
                  }}
                />
              )}
              {attentionCount} {attentionCount === 1 ? 'item' : 'items'}
            </span>
          </div>
        )}

        {/* Local Emails Count */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '12px' }}>
          <span style={{ color: 'var(--text-muted)' }}>Inbox Messages</span>
          <span style={{ fontWeight: 500, color: 'var(--text-primary)' }}>
            {emailCount} <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>synced</span>
          </span>
        </div>

        {/* Last Sync Time */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '12px' }}>
          <span style={{ color: 'var(--text-muted)' }}>Last Sync</span>
          <span style={{ fontWeight: 500, color: 'var(--text-secondary)' }}>
            {formatRelativeTime(syncState?.lastSyncTime ?? null)}
          </span>
        </div>

        {/* Error Callout if Auth Failed */}
        {syncState?.authState === 'error' && syncState.lastError && (
          <div
            style={{
              background: 'var(--danger-subtle)',
              border: '1px solid var(--danger)',
              borderRadius: '4px',
              padding: '6px 8px',
              fontSize: '11px',
              color: 'var(--danger-text)',
              marginTop: '4px',
              lineHeight: 1.35,
            }}
          >
            {syncState.lastError}
          </div>
        )}
      </div>

      {/* Action Controls */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {isConnected ? (
          <>
            <div style={{ display: 'flex', gap: '6px' }}>
              <button
                onClick={handleSyncNow}
                disabled={isSyncing}
                className="btn-primary"
                style={{ flex: 1 }}
              >
                {isSyncing ? (
                  <>
                    <span className="spinner" />
                    <span>Syncing...</span>
                  </>
                ) : (
                  <span>Sync Now</span>
                )}
              </button>
              <button
                onClick={handleDisconnectGmail}
                disabled={isSyncing}
                className="btn-secondary"
                style={{ fontSize: '11px', padding: '7px 10px' }}
                title="Disconnect Gmail account"
              >
                Disconnect
              </button>
            </div>
            <button
              onClick={handleSwitchAccount}
              disabled={isSyncing}
              className="btn-secondary"
              style={{ width: '100%', fontSize: '11px' }}
              title="Switch to another Google Account"
            >
              Switch Account
            </button>
          </>
        ) : (
          <button
            onClick={handleConnectGmail}
            disabled={isBusy || syncState?.authState === 'connecting'}
            className="btn-primary"
            style={{ width: '100%' }}
          >
            {syncState?.authState === 'connecting' ? 'Authorizing with Google...' : 'Connect Gmail'}
          </button>
        )}

        <button
          onClick={handleOpenSidePanel}
          className="btn-secondary"
          style={{ width: '100%' }}
        >
          <span>Open Attention Dashboard</span>
          <span style={{ fontSize: '10px', opacity: 0.6 }}>↗</span>
        </button>
      </div>

      {/* Footer Info */}
      <footer
        style={{
          display: 'flex',
          justifyContent: 'center',
          fontSize: '10px',
          color: 'var(--text-muted)',
          paddingTop: '6px',
          borderTop: '1px solid var(--border-subtle)',
        }}
      >
        <span>Private &amp; on-device</span>
      </footer>
    </div>
  );
}

const root = document.getElementById('root');
if (root) {
  render(<Popup />, root);
}
