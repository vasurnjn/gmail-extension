import { render } from 'preact';
import { useEffect, useState, useMemo } from 'preact/hooks';
import { storage } from '../shared/storage';
import {
  AttentionItem,
  CategoryConfig,
  EmailRecord,
  ExtensionSettings,
  LocalSyncState,
  ThemeMode,
  UserAttentionState,
} from '../shared/types';
import { STORAGE_KEY_SETTINGS, STORAGE_KEY_SYNC_STATE } from '../shared/constants';
import { applyTheme, initTheme } from '../shared/theme';
import { db } from '../db';

function formatEmailDate(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();

  if (isToday) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  const isThisYear = date.getFullYear() === now.getFullYear();
  if (isThisYear) {
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  return date.toLocaleDateString([], { year: 'numeric', month: 'numeric', day: 'numeric' });
}

function formatEventDate(timestamp: number, timePrecision?: string): string {
  const d = new Date(timestamp);
  if (timePrecision === 'unknown' || timePrecision === 'date_only') {
    return d.toLocaleDateString([], {
      month: 'short',
      day: 'numeric',
      weekday: 'short',
    });
  }
  return d.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function getCategoryInfo(categoryId: string | undefined, categoriesList: CategoryConfig[]) {
  if (!categoryId || categoryId === 'uncategorized') {
    return { label: 'Uncategorized', color: 'var(--text-muted)' };
  }
  const found = categoriesList.find((c) => c.id === categoryId);
  if (found) {
    return { label: found.label, color: found.color };
  }
  return { label: categoryId, color: 'var(--accent)' };
}

function SidePanel() {
  const [settings, setSettings] = useState<ExtensionSettings | null>(null);
  const [categories, setCategories] = useState<CategoryConfig[]>([]);
  const [syncState, setSyncState] = useState<LocalSyncState | null>(null);
  const [emails, setEmails] = useState<EmailRecord[]>([]);
  const [attentionItems, setAttentionItems] = useState<AttentionItem[]>([]);
  const [activeTab, setActiveTab] = useState<'queue' | 'categories' | 'settings'>('queue');
  const [queueFilter, setQueueFilter] = useState<'needs_attention' | 'all' | 'snoozed' | 'handled'>(
    'needs_attention'
  );
  const [isBusy, setIsBusy] = useState<boolean>(false);
  const [availableAccounts, setAvailableAccounts] = useState<string[]>([]);
  const [showBulkConfirm, setShowBulkConfirm] = useState<boolean>(false);

  useEffect(() => {
    let isMounted = true;

    // Initialize Theme
    const cleanupTheme = initTheme((theme) => {
      if (settings && settings.theme !== theme) {
        setSettings({ ...settings, theme });
      }
    });

    async function loadData() {
      const s = await storage.getSettings();
      const c = await storage.getCategories();
      const sync = await storage.getSyncState();

      let localEmails: EmailRecord[] = [];
      let localItems: AttentionItem[] = [];
      try {
        localEmails = await db.emails.orderBy('internalDate').reverse().limit(100).toArray();
        localItems = await db.attentionItems.toArray();
      } catch (err) {
        console.warn('Failed to load data from DB:', err);
      }

      if (isMounted) {
        setSettings(s);
        setCategories(c);
        setSyncState(sync);
        setEmails(localEmails);
        setAttentionItems(localItems);
      }

      // Query available Google accounts from Chrome Identity if supported
      chrome.runtime?.sendMessage?.({ type: 'GET_AVAILABLE_ACCOUNTS' }, (res) => {
        if (isMounted && res?.success && Array.isArray(res.accounts)) {
          setAvailableAccounts(res.accounts);
        }
      });
    }

    loadData();

    // Live storage sync
    const storageListener = (changes: { [key: string]: chrome.storage.StorageChange }) => {
      if (changes[STORAGE_KEY_SYNC_STATE]) {
        const nextSync = changes[STORAGE_KEY_SYNC_STATE].newValue as LocalSyncState;
        setSyncState(nextSync);
        // Refresh emails and attention items from DB
        Promise.all([
          db.emails.orderBy('internalDate').reverse().limit(100).toArray(),
          db.attentionItems.toArray(),
        ])
          .then(([refreshedEmails, refreshedItems]) => {
            if (isMounted) {
              setEmails(refreshedEmails);
              setAttentionItems(refreshedItems);
            }
          })
          .catch(() => {});
      }
      if (changes[STORAGE_KEY_SETTINGS]) {
        const nextSettings = changes[STORAGE_KEY_SETTINGS].newValue as ExtensionSettings;
        setSettings(nextSettings);
        applyTheme(nextSettings.theme || 'system');
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

  const refreshData = () => {
    Promise.all([
      db.emails.orderBy('internalDate').reverse().limit(100).toArray(),
      db.attentionItems.toArray(),
    ])
      .then(([localEmails, localItems]) => {
        setEmails(localEmails);
        setAttentionItems(localItems);
      })
      .catch((err) => console.warn('Refresh error:', err));
  };

  const handleConnectGmail = () => {
    setIsBusy(true);
    chrome.runtime.sendMessage({ type: 'CONNECT_GMAIL' }, (response) => {
      setIsBusy(false);
      if (chrome.runtime.lastError) {
        console.error('Connect Gmail error:', chrome.runtime.lastError.message);
      } else if (response?.success) {
        refreshData();
      }
      storage.getSyncState().then(setSyncState);
    });
  };

  const handleDisconnectGmail = () => {
    setIsBusy(true);
    chrome.runtime.sendMessage({ type: 'DISCONNECT_GMAIL' }, () => {
      setIsBusy(false);
      refreshData();
      storage.getSyncState().then(setSyncState);
    });
  };

  const handleSwitchAccount = (accountId?: string) => {
    setIsBusy(true);
    chrome.runtime.sendMessage({ type: 'SWITCH_ACCOUNT', accountId }, (response) => {
      setIsBusy(false);
      if (chrome.runtime.lastError) {
        console.error('Switch account error:', chrome.runtime.lastError.message);
      } else if (response?.success) {
        refreshData();
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
        refreshData();
      }
      storage.getSyncState().then(setSyncState);
    });
  };

  const handleThemeChange = async (newTheme: ThemeMode) => {
    applyTheme(newTheme);
    const updated = await storage.setSettings({ theme: newTheme });
    setSettings(updated);
  };

  const handleUpdateThreshold = async (newVal: number) => {
    if (!settings) return;
    const updated = await storage.setSettings({ alertThreshold: newVal });
    setSettings(updated);
  };

  const handleOpenInGmail = (emailId: string) => {
    if (typeof chrome !== 'undefined' && chrome.tabs?.create) {
      chrome.tabs.create({ url: `https://mail.google.com/mail/u/0/#inbox/${emailId}` });
    } else {
      window.open(`https://mail.google.com/mail/u/0/#inbox/${emailId}`, '_blank');
    }
  };

  const handleSetAttentionState = (
    action: 'mark_handled' | 'snooze' | 'dismiss' | 'reopen',
    email: EmailRecord,
    item?: AttentionItem
  ) => {
    setIsBusy(true);
    chrome.runtime.sendMessage(
      {
        type: 'SET_ATTENTION_STATE',
        emailId: email.id,
        attentionItemId: item?.id ?? email.attentionItemId ?? undefined,
        action,
        snoozeUntil: action === 'snooze' ? Date.now() + 60 * 60 * 1000 : undefined,
      },
      () => {
        setIsBusy(false);
        refreshData();
      }
    );
  };

  const handleBulkMarkHandled = () => {
    setIsBusy(true);
    chrome.runtime.sendMessage({ type: 'BULK_MARK_HANDLED' }, (response) => {
      setIsBusy(false);
      setShowBulkConfirm(false);
      if (chrome.runtime.lastError) {
        console.error('Bulk mark handled error:', chrome.runtime.lastError.message);
      } else {
        refreshData();
      }
    });
  };

  // Build AttentionItem Map for fast O(1) lookup
  const itemMap = useMemo(() => {
    const map = new Map<string, AttentionItem>();
    for (const item of attentionItems) {
      map.set(item.id, item);
    }
    return map;
  }, [attentionItems]);

  // Compute authoritative user attention state for an email
  const getEffectiveAttentionState = (email: EmailRecord): UserAttentionState => {
    if (email.attentionItemId && itemMap.has(email.attentionItemId)) {
      return itemMap.get(email.attentionItemId)!.userAttentionState;
    }
    if (email.alertStatus === 'snoozed' || email.alertStatus === 'handled' || email.alertStatus === 'dismissed') {
      return email.alertStatus;
    }
    return 'unhandled';
  };

  // Filter and tally counts
  const unhandledCount = useMemo(() => {
    return emails.filter((e) => getEffectiveAttentionState(e) === 'unhandled').length;
  }, [emails, itemMap]);

  const snoozedCount = useMemo(() => {
    return emails.filter((e) => getEffectiveAttentionState(e) === 'snoozed').length;
  }, [emails, itemMap]);

  const handledCount = useMemo(() => {
    return emails.filter((e) => {
      const state = getEffectiveAttentionState(e);
      return state === 'handled' || state === 'dismissed';
    }).length;
  }, [emails, itemMap]);

  const filteredEmails = useMemo(() => {
    return emails.filter((email) => {
      const state = getEffectiveAttentionState(email);
      if (queueFilter === 'needs_attention') return state === 'unhandled';
      if (queueFilter === 'snoozed') return state === 'snoozed';
      if (queueFilter === 'handled') return state === 'handled' || state === 'dismissed';
      return true; // 'all'
    });
  }, [emails, queueFilter, itemMap]);

  const isConnected = syncState?.authState === 'connected';
  const isSyncing = Boolean(syncState?.isSyncing || isBusy);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        backgroundColor: 'var(--bg-app)',
        color: 'var(--text-primary)',
      }}
    >
      {/* Top Header */}
      <header
        style={{
          padding: '12px 16px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--bg-surface)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '22px',
              height: '22px',
              borderRadius: '4px',
              background: 'var(--accent)',
              color: '#ffffff',
              fontSize: '12px',
              fontWeight: 700,
            }}
          >
            M
          </span>
          <div>
            <h1 style={{ fontSize: '14px', fontWeight: 600, margin: 0, letterSpacing: '-0.01em' }}>
              Attention Manager
            </h1>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
              {isConnected ? syncState?.accountEmail : 'No account connected'}
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {isSyncing ? (
            <span className="status-pill syncing">
              <span className="spinner" />
              Syncing
            </span>
          ) : isConnected ? (
            <button
              onClick={handleSyncNow}
              className="btn-secondary"
              style={{ padding: '4px 8px', fontSize: '11px' }}
              title="Synchronize recent emails"
            >
              Sync
            </button>
          ) : null}
        </div>
      </header>

      {/* Nav Tabs */}
      <nav
        style={{
          display: 'flex',
          background: 'var(--bg-surface)',
          borderBottom: '1px solid var(--border)',
          padding: '0 16px',
        }}
      >
        <button
          onClick={() => setActiveTab('queue')}
          style={{
            padding: '10px 14px',
            fontSize: '12px',
            fontWeight: 500,
            background: 'none',
            border: 'none',
            borderBottom: activeTab === 'queue' ? '2px solid var(--accent)' : '2px solid transparent',
            color: activeTab === 'queue' ? 'var(--accent)' : 'var(--text-secondary)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
          }}
        >
          <span>Attention Queue</span>
          {unhandledCount > 0 ? (
            <span
              style={{
                fontSize: '10px',
                fontWeight: 700,
                padding: '1px 6px',
                borderRadius: '10px',
                background: 'var(--warning-subtle)',
                color: 'var(--warning-text)',
                border: '1px solid var(--warning)',
              }}
            >
              {unhandledCount}
            </span>
          ) : (
            <span
              style={{
                fontSize: '10px',
                padding: '1px 6px',
                borderRadius: '10px',
                background: 'var(--badge-bg)',
                color: 'var(--badge-text)',
              }}
            >
              {emails.length}
            </span>
          )}
        </button>

        <button
          onClick={() => setActiveTab('categories')}
          style={{
            padding: '10px 14px',
            fontSize: '12px',
            fontWeight: 500,
            background: 'none',
            border: 'none',
            borderBottom: activeTab === 'categories' ? '2px solid var(--accent)' : '2px solid transparent',
            color: activeTab === 'categories' ? 'var(--accent)' : 'var(--text-secondary)',
            cursor: 'pointer',
          }}
        >
          Categories
        </button>

        <button
          onClick={() => setActiveTab('settings')}
          style={{
            padding: '10px 14px',
            fontSize: '12px',
            fontWeight: 500,
            background: 'none',
            border: 'none',
            borderBottom: activeTab === 'settings' ? '2px solid var(--accent)' : '2px solid transparent',
            color: activeTab === 'settings' ? 'var(--accent)' : 'var(--text-secondary)',
            cursor: 'pointer',
          }}
        >
          Settings
        </button>
      </nav>

      {/* Main View Area */}
      <main style={{ flex: 1, overflowY: 'auto', padding: '16px' }}>
        {activeTab === 'queue' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {/* If not connected, show onboarding card */}
            {!isConnected && (
              <div
                style={{
                  background: 'var(--bg-surface)',
                  border: '1px solid var(--border)',
                  borderRadius: '6px',
                  padding: '16px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '10px',
                  boxShadow: 'var(--card-shadow)',
                }}
              >
                <h3 style={{ margin: 0, fontSize: '13px', fontWeight: 600 }}>Connect Gmail to View Inbox</h3>
                <p style={{ margin: 0, fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.45 }}>
                  Connect your Google account with read-only permissions to securely mirror and index recent communications locally.
                </p>

                {syncState?.authState === 'error' && syncState.lastError && (
                  <div
                    style={{
                      background: 'var(--danger-subtle)',
                      border: '1px solid var(--danger)',
                      borderRadius: '4px',
                      padding: '8px',
                      fontSize: '11px',
                      color: 'var(--danger-text)',
                    }}
                  >
                    {syncState.lastError}
                  </div>
                )}

                <button
                  onClick={handleConnectGmail}
                  disabled={isBusy || syncState?.authState === 'connecting'}
                  className="btn-primary"
                  style={{ alignSelf: 'flex-start' }}
                >
                  {syncState?.authState === 'connecting' ? 'Authorizing with Google...' : 'Connect Gmail'}
                </button>
              </div>
            )}

            {/* Filter Pills Bar */}
            {isConnected && (
              <div
                style={{
                  display: 'flex',
                  gap: '6px',
                  overflowX: 'auto',
                  paddingBottom: '2px',
                }}
              >
                {(
                  [
                    { key: 'needs_attention', label: 'Needs Attention', count: unhandledCount },
                    { key: 'all', label: 'All Messages', count: emails.length },
                    { key: 'snoozed', label: 'Snoozed', count: snoozedCount },
                    { key: 'handled', label: 'Handled', count: handledCount },
                  ] as const
                ).map(({ key, label, count }) => {
                  const isSelected = queueFilter === key;
                  return (
                    <button
                      key={key}
                      onClick={() => setQueueFilter(key)}
                      style={{
                        padding: '4px 10px',
                        borderRadius: '20px',
                        fontSize: '11px',
                        fontWeight: isSelected ? 600 : 500,
                        border: isSelected ? '1px solid var(--accent)' : '1px solid var(--border)',
                        background: isSelected ? 'var(--accent-subtle)' : 'var(--bg-surface)',
                        color: isSelected ? 'var(--accent-text)' : 'var(--text-secondary)',
                        cursor: 'pointer',
                        whiteSpace: 'nowrap',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '5px',
                        transition: 'all 0.15s ease',
                      }}
                    >
                      <span>{label}</span>
                      <span
                        style={{
                          fontSize: '10px',
                          opacity: 0.8,
                          background: isSelected ? 'rgba(37, 99, 235, 0.15)' : 'var(--badge-bg)',
                          padding: '1px 5px',
                          borderRadius: '8px',
                        }}
                      >
                        {count}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            {/* Empty State: Not synced at all */}
            {isConnected && emails.length === 0 && (
              <div
                style={{
                  background: 'var(--bg-surface)',
                  border: '1px dashed var(--border)',
                  borderRadius: '6px',
                  padding: '32px 20px',
                  textAlign: 'center',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: '8px',
                }}
              >
                <div style={{ fontSize: '24px' }}>📥</div>
                <div style={{ fontSize: '13px', fontWeight: 600 }}>No Messages Synced Yet</div>
                <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: 0, maxWidth: '260px' }}>
                  Click Sync Now to pull a conservative initial batch of recent Inbox messages.
                </p>
                <button
                  onClick={handleSyncNow}
                  disabled={isSyncing}
                  className="btn-primary"
                  style={{ marginTop: '8px' }}
                >
                  {isSyncing ? 'Syncing Messages...' : 'Sync Now'}
                </button>
              </div>
            )}

            {/* Empty State: Filter yielded no items */}
            {isConnected && emails.length > 0 && filteredEmails.length === 0 && (
              <div
                style={{
                  background: 'var(--bg-surface)',
                  border: '1px dashed var(--border)',
                  borderRadius: '6px',
                  padding: '28px 16px',
                  textAlign: 'center',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: '6px',
                }}
              >
                <div style={{ fontSize: '22px' }}>
                  {queueFilter === 'needs_attention' ? '✨' : queueFilter === 'snoozed' ? '⏰' : '✓'}
                </div>
                <div style={{ fontSize: '13px', fontWeight: 600 }}>
                  {queueFilter === 'needs_attention'
                    ? 'All Caught Up!'
                    : queueFilter === 'snoozed'
                    ? 'No Snoozed Messages'
                    : 'No Handled Messages'}
                </div>
                <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: 0 }}>
                  {queueFilter === 'needs_attention'
                    ? 'There are currently no pending communications requiring your attention.'
                    : queueFilter === 'snoozed'
                    ? 'Emails you snooze will be deferred here until their reminder time.'
                    : 'Emails marked handled or dismissed will appear here.'}
                </p>
              </div>
            )}

            {/* Bulk Mark as Handled Action Bar */}
            {isConnected && queueFilter === 'needs_attention' && unhandledCount > 0 && (
              <div
                style={{
                  background: 'var(--bg-surface)',
                  border: '1px solid var(--border)',
                  borderRadius: '6px',
                  padding: '8px 12px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '8px',
                  boxShadow: 'var(--card-shadow)',
                }}
              >
                {showBulkConfirm ? (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      width: '100%',
                      gap: '8px',
                    }}
                  >
                    <span style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-primary)' }}>
                      Mark {unhandledCount} attention {unhandledCount === 1 ? 'item' : 'items'} as handled?
                    </span>
                    <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                      <button
                        onClick={handleBulkMarkHandled}
                        disabled={isBusy}
                        className="btn-primary"
                        style={{ padding: '3px 10px', fontSize: '11px' }}
                      >
                        Confirm
                      </button>
                      <button
                        onClick={() => setShowBulkConfirm(false)}
                        disabled={isBusy}
                        className="btn-secondary"
                        style={{ padding: '3px 8px', fontSize: '11px' }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                      {unhandledCount} {unhandledCount === 1 ? 'item requires' : 'items require'} attention
                    </span>
                    <button
                      onClick={() => setShowBulkConfirm(true)}
                      disabled={isBusy}
                      className="btn-secondary"
                      style={{
                        padding: '3px 10px',
                        fontSize: '11px',
                        color: 'var(--success-text)',
                        borderColor: 'var(--success)',
                        fontWeight: 500,
                      }}
                    >
                      ✓ Mark all as handled
                    </button>
                  </>
                )}
              </div>
            )}

            {/* Attention Cards List */}
            {filteredEmails.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {filteredEmails.map((email) => {
                  const item = email.attentionItemId ? itemMap.get(email.attentionItemId) : undefined;
                  const attentionState = getEffectiveAttentionState(email);
                  const effectiveImportance = item?.importanceScore ?? email.importanceScore ?? 0;
                  const effectiveUrgency = item?.urgencyScore ?? email.urgencyScore ?? 0;
                  const attentionScore = Math.round(effectiveImportance * 0.45 + effectiveUrgency * 0.55);
                  const isHighAttention = attentionScore >= 70 || effectiveImportance >= 75;

                  // Temporal event extraction
                  const primaryDeadline = email.temporalAnalysis?.primaryDeadline;
                  const primaryEvent = email.temporalAnalysis?.primaryEvent;
                  const deadlineTimestamp = item?.currentState?.primaryDeadlineTimestamp ?? primaryDeadline?.timestamp;
                  const eventTimestamp = item?.currentState?.primaryEventTimestamp ?? primaryEvent?.timestamp;
                  const venue = item?.currentState?.venue || (email.extractedEntities?.locations?.[0] ?? null);

                  // Extract additional sub-events so multiple targets don't hide each other
                  const additionalSubEvents = (item?.currentState?.subEvents || []).filter((se) => {
                    if (se.status === 'cancelled') return false;
                    if (deadlineTimestamp && se.timestamp === deadlineTimestamp && se.type === 'deadline') return false;
                    if (eventTimestamp && se.timestamp === eventTimestamp && se.type === 'event') return false;
                    return true;
                  });

                  // Entity recognition
                  const entityName = item?.canonicalEntity || (email.extractedEntities?.organizations?.[0] ?? null);
                  const topicName = item?.topicScope;

                  return (
                    <div
                      key={email.id}
                      style={{
                        background: 'var(--bg-surface)',
                        border:
                          attentionState === 'unhandled'
                            ? isHighAttention
                              ? '1px solid var(--danger)'
                              : '1px solid var(--border-strong)'
                            : '1px solid var(--border)',
                        borderRadius: '8px',
                        padding: '12px 14px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '8px',
                        boxShadow: 'var(--card-shadow)',
                        transition: 'border-color 0.15s ease',
                      }}
                    >
                      {/* Top Row: Sender, Date & Attention Status Badge */}
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: '8px',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', overflow: 'hidden' }}>
                          {email.isUnread && (
                            <span
                              style={{
                                width: '6px',
                                height: '6px',
                                borderRadius: '50%',
                                backgroundColor: 'var(--accent)',
                                flexShrink: 0,
                              }}
                              title="Unread in Gmail"
                            />
                          )}
                          <span
                            style={{
                              fontSize: '12px',
                              fontWeight: email.isUnread ? 600 : 500,
                              color: 'var(--text-primary)',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {email.from}
                          </span>
                        </div>

                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                            {formatEmailDate(email.internalDate)}
                          </span>

                          {/* Attention State Badge */}
                          {attentionState === 'unhandled' ? (
                            <span
                              style={{
                                fontSize: '10px',
                                fontWeight: 600,
                                padding: '2px 7px',
                                borderRadius: '10px',
                                background: isHighAttention ? 'var(--danger-subtle)' : 'var(--warning-subtle)',
                                color: isHighAttention ? 'var(--danger-text)' : 'var(--warning-text)',
                                border: isHighAttention
                                  ? '1px solid var(--danger)'
                                  : '1px solid var(--warning)',
                              }}
                            >
                              {isHighAttention ? '🚨 High Attention' : '⚠️ Attention'}
                            </span>
                          ) : attentionState === 'snoozed' ? (
                            <span
                              style={{
                                fontSize: '10px',
                                fontWeight: 500,
                                padding: '2px 7px',
                                borderRadius: '10px',
                                background: 'var(--accent-subtle)',
                                color: 'var(--accent-text)',
                                border: '1px solid var(--accent-subtle)',
                              }}
                            >
                              ⏰ Snoozed
                            </span>
                          ) : attentionState === 'handled' ? (
                            <span
                              style={{
                                fontSize: '10px',
                                fontWeight: 500,
                                padding: '2px 7px',
                                borderRadius: '10px',
                                background: 'var(--success-subtle)',
                                color: 'var(--success-text)',
                                border: '1px solid var(--success-subtle)',
                              }}
                            >
                              ✓ Handled
                            </span>
                          ) : (
                            <span
                              style={{
                                fontSize: '10px',
                                fontWeight: 500,
                                padding: '2px 7px',
                                borderRadius: '10px',
                                background: 'var(--badge-bg)',
                                color: 'var(--text-muted)',
                                border: '1px solid var(--border)',
                              }}
                            >
                              ✕ Dismissed
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Entity / Topic Recognition Banner */}
                      {entityName && (
                        <div
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            alignSelf: 'flex-start',
                            gap: '5px',
                            background: 'var(--bg-surface-raised)',
                            border: '1px solid var(--border)',
                            borderRadius: '4px',
                            padding: '2px 8px',
                            fontSize: '11px',
                            color: 'var(--text-secondary)',
                            maxWidth: '100%',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          <span>📌</span>
                          <strong>{entityName}</strong>
                          {topicName && <span>· Role: {topicName}</span>}
                        </div>
                      )}

                      {/* Subject */}
                      <div
                        style={{
                          fontSize: '13px',
                          fontWeight: email.isUnread ? 600 : 500,
                          color: 'var(--text-primary)',
                          lineHeight: 1.35,
                        }}
                      >
                        {email.subject || '(No Subject)'}
                      </div>

                      {/* Prominent Event / Deadline Highlight Box */}
                      {(primaryDeadline || primaryEvent || deadlineTimestamp || eventTimestamp) && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                          {(primaryDeadline || deadlineTimestamp) && (
                            <div
                              style={{
                                background: 'var(--warning-subtle)',
                                border: '1px solid var(--warning)',
                                borderRadius: '6px',
                                padding: '6px 10px',
                                fontSize: '11px',
                                display: 'flex',
                                flexDirection: 'column',
                                gap: '2px',
                              }}
                            >
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                <span style={{ fontWeight: 600, color: 'var(--warning-text)' }}>
                                  ⏰ Action Deadline
                                </span>
                                {primaryDeadline?.confidence && (
                                  <span
                                    style={{
                                      fontSize: '9px',
                                      fontWeight: 600,
                                      textTransform: 'uppercase',
                                      opacity: 0.8,
                                    }}
                                  >
                                    {primaryDeadline.confidence} Confidence
                                  </span>
                                )}
                              </div>
                              <div style={{ color: 'var(--text-primary)', fontWeight: 500 }}>
                                {primaryDeadline?.timestamp
                                  ? formatEventDate(primaryDeadline.timestamp, primaryDeadline.timePrecision)
                                  : deadlineTimestamp
                                  ? formatEventDate(deadlineTimestamp)
                                  : primaryDeadline?.rawText}
                              </div>
                              {(primaryDeadline?.associatedVerbText || primaryDeadline?.contextSnippet) && (
                                <div style={{ fontSize: '10px', color: 'var(--text-secondary)' }}>
                                  Context: {primaryDeadline.associatedVerbText || primaryDeadline.contextSnippet}
                                </div>
                              )}
                            </div>
                          )}

                          {(primaryEvent || eventTimestamp) && (
                            <div
                              style={{
                                background: 'var(--accent-subtle)',
                                border: '1px solid var(--accent)',
                                borderRadius: '6px',
                                padding: '6px 10px',
                                fontSize: '11px',
                                display: 'flex',
                                flexDirection: 'column',
                                gap: '2px',
                              }}
                            >
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                <span style={{ fontWeight: 600, color: 'var(--accent-text)' }}>
                                  📍 Event Scheduled
                                </span>
                                {primaryEvent?.confidence && (
                                  <span
                                    style={{
                                      fontSize: '9px',
                                      fontWeight: 600,
                                      textTransform: 'uppercase',
                                      opacity: 0.8,
                                    }}
                                  >
                                    {primaryEvent.confidence} Confidence
                                  </span>
                                )}
                              </div>
                              <div style={{ color: 'var(--text-primary)', fontWeight: 500 }}>
                                {primaryEvent?.timestamp
                                  ? formatEventDate(primaryEvent.timestamp, primaryEvent.timePrecision)
                                  : eventTimestamp
                                  ? formatEventDate(eventTimestamp)
                                  : primaryEvent?.rawText}
                                {venue && <span> @ {venue}</span>}
                              </div>
                              {(primaryEvent?.associatedVerbText || primaryEvent?.contextSnippet) && (
                                <div style={{ fontSize: '10px', color: 'var(--text-secondary)' }}>
                                  Context: {primaryEvent.associatedVerbText || primaryEvent.contextSnippet}
                                </div>
                              )}
                            </div>
                          )}

                          {additionalSubEvents.length > 0 && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '2px' }}>
                              <span style={{ fontSize: '10px', fontWeight: 600, color: 'var(--text-muted)' }}>
                                Additional Milestones &amp; Schedule:
                              </span>
                              {additionalSubEvents.map((sub, sIdx) => (
                                <div
                                  key={sIdx}
                                  style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'space-between',
                                    fontSize: '11px',
                                    padding: '4px 8px',
                                    borderRadius: '4px',
                                    background: 'var(--bg-surface-raised)',
                                    border: '1px solid var(--border)',
                                    gap: '8px',
                                  }}
                                >
                                  <span style={{ fontWeight: 500, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    {sub.type === 'deadline' ? '⏰' : '📍'} {sub.label}
                                  </span>
                                  <span style={{ color: 'var(--text-secondary)', fontSize: '10px', flexShrink: 0 }}>
                                    {sub.timestamp ? formatEventDate(sub.timestamp, sub.timePrecision) : 'Time unstated'}
                                    {sub.venue ? ` @ ${sub.venue}` : ''}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}

                      {/* Snippet preview */}
                      <div
                        style={{
                          fontSize: '11px',
                          color: 'var(--text-secondary)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          display: '-webkit-box',
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: 'vertical',
                          lineHeight: 1.4,
                        }}
                      >
                        {email.snippet || email.bodyTextPreview || ''}
                      </div>

                      {/* Category, Score & Explainability Row */}
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: '6px',
                          paddingTop: '6px',
                          borderTop: '1px solid var(--border-subtle)',
                          fontSize: '10px',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                          {/* Category pill */}
                          <span
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '4px',
                              padding: '2px 6px',
                              borderRadius: '4px',
                              background: 'var(--bg-surface-raised)',
                              border: '1px solid var(--border)',
                              color: 'var(--text-secondary)',
                              fontWeight: 500,
                            }}
                          >
                            <span
                              style={{
                                width: '6px',
                                height: '6px',
                                borderRadius: '50%',
                                backgroundColor: getCategoryInfo(email.category, categories).color,
                                display: 'inline-block',
                              }}
                            />
                            {getCategoryInfo(email.category, categories).label}
                          </span>

                          {/* Attention Score */}
                          <span
                            style={{
                              padding: '2px 6px',
                              borderRadius: '4px',
                              background: 'var(--badge-bg)',
                              border: '1px solid var(--border)',
                              color: 'var(--text-secondary)',
                              fontWeight: 500,
                            }}
                            title={`Importance: ${effectiveImportance}/100, Urgency: ${effectiveUrgency}/100`}
                          >
                            Score: {attentionScore}/100
                          </span>

                          {/* Relation indicator (if not NEW) */}
                          {email.changeRelation && email.changeRelation !== 'NEW' && (
                            <span
                              style={{
                                padding: '2px 6px',
                                borderRadius: '4px',
                                background:
                                  email.changeRelation === 'UPDATE'
                                    ? 'var(--accent-subtle)'
                                    : email.changeRelation === 'CONFLICT'
                                    ? 'var(--danger-subtle)'
                                    : email.changeRelation === 'CANCELLED'
                                    ? 'var(--danger-subtle)'
                                    : 'var(--badge-bg)',
                                color:
                                  email.changeRelation === 'UPDATE'
                                    ? 'var(--accent-text)'
                                    : email.changeRelation === 'CONFLICT' || email.changeRelation === 'CANCELLED'
                                    ? 'var(--danger-text)'
                                    : 'var(--badge-text)',
                                fontWeight: 600,
                              }}
                            >
                              {email.changeRelation}
                            </span>
                          )}
                        </div>

                        {/* First detection reason */}
                        {email.detectionReasons && email.detectionReasons.length > 0 && (
                          <span
                            style={{
                              color: 'var(--text-muted)',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              maxWidth: '130px',
                            }}
                            title={email.detectionReasons.join('\n')}
                          >
                            {email.detectionReasons[0]}
                          </span>
                        )}
                      </div>

                      {/* Interactive Actions Row */}
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '6px',
                          paddingTop: '6px',
                          borderTop: '1px solid var(--border-subtle)',
                        }}
                      >
                        {attentionState === 'unhandled' ? (
                          <>
                            <button
                              onClick={() => handleSetAttentionState('mark_handled', email, item)}
                              disabled={isBusy}
                              className="btn-secondary"
                              style={{
                                flex: 1,
                                padding: '4px 8px',
                                fontSize: '11px',
                                color: 'var(--success-text)',
                                borderColor: 'var(--success)',
                              }}
                            >
                              ✓ Mark Handled
                            </button>
                            <button
                              onClick={() => handleSetAttentionState('snooze', email, item)}
                              disabled={isBusy}
                              className="btn-secondary"
                              style={{ padding: '4px 8px', fontSize: '11px' }}
                              title="Snooze attention reminder for 1 hour"
                            >
                              ⏰ Snooze (1h)
                            </button>
                            <button
                              onClick={() => handleSetAttentionState('dismiss', email, item)}
                              disabled={isBusy}
                              className="btn-secondary"
                              style={{ padding: '4px 8px', fontSize: '11px', color: 'var(--text-muted)' }}
                              title="Dismiss from attention queue"
                            >
                              ✕ Dismiss
                            </button>
                          </>
                        ) : attentionState === 'snoozed' ? (
                          <>
                            <button
                              onClick={() => handleSetAttentionState('mark_handled', email, item)}
                              disabled={isBusy}
                              className="btn-secondary"
                              style={{
                                flex: 1,
                                padding: '4px 8px',
                                fontSize: '11px',
                                color: 'var(--success-text)',
                              }}
                            >
                              ✓ Mark Handled
                            </button>
                            <button
                              onClick={() => handleSetAttentionState('reopen', email, item)}
                              disabled={isBusy}
                              className="btn-secondary"
                              style={{ padding: '4px 8px', fontSize: '11px' }}
                              title="Un-snooze and return to Attention Queue"
                            >
                              ↺ Un-snooze
                            </button>
                            <button
                              onClick={() => handleSetAttentionState('dismiss', email, item)}
                              disabled={isBusy}
                              className="btn-secondary"
                              style={{ padding: '4px 8px', fontSize: '11px', color: 'var(--text-muted)' }}
                            >
                              ✕ Dismiss
                            </button>
                          </>
                        ) : (
                          <button
                            onClick={() => handleSetAttentionState('reopen', email, item)}
                            disabled={isBusy}
                            className="btn-secondary"
                            style={{
                              padding: '4px 10px',
                              fontSize: '11px',
                            }}
                            title="Re-open and move back to Needs Attention"
                          >
                            ↺ Reopen
                          </button>
                        )}

                        <button
                          onClick={() => handleOpenInGmail(email.id)}
                          className="btn-secondary"
                          style={{
                            padding: '4px 8px',
                            fontSize: '11px',
                            marginLeft: 'auto',
                          }}
                          title="Open original thread directly in Gmail"
                        >
                          ↗ Open in Gmail
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {activeTab === 'categories' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
              Categories used to organize and identify your incoming mail.
            </div>
            {categories.map((cat) => (
              <div
                key={cat.id}
                style={{
                  background: 'var(--bg-surface)',
                  border: '1px solid var(--border)',
                  borderRadius: '6px',
                  padding: '10px 12px',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  boxShadow: 'var(--card-shadow)',
                }}
              >
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span
                      style={{
                        width: '8px',
                        height: '8px',
                        borderRadius: '50%',
                        background: cat.color,
                        display: 'inline-block',
                      }}
                    />
                    <span style={{ fontSize: '12px', fontWeight: 500 }}>{cat.label}</span>
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                    {cat.description || 'Emails and notifications'}
                  </div>
                </div>
                <span
                  style={{
                    fontSize: '10px',
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    color: cat.alertEnabled ? 'var(--success-text)' : 'var(--text-muted)',
                    background: cat.alertEnabled ? 'var(--success-subtle)' : 'var(--badge-bg)',
                    padding: '2px 6px',
                    borderRadius: '4px',
                  }}
                >
                  {cat.alertEnabled ? cat.defaultPriority : 'Disabled'}
                </span>
              </div>
            ))}
          </div>
        )}

        {activeTab === 'settings' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            {/* Theme Selector Section */}
            <div
              style={{
                background: 'var(--bg-surface)',
                border: '1px solid var(--border)',
                borderRadius: '6px',
                padding: '14px',
                boxShadow: 'var(--card-shadow)',
              }}
            >
              <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '4px' }}>Interface Theme</div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '10px' }}>
                Select appearance preference. Persists locally.
              </div>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr 1fr',
                  gap: '6px',
                }}
              >
                {(['system', 'light', 'dark'] as const).map((mode) => {
                  const isSelected = (settings?.theme || 'system') === mode;
                  return (
                    <button
                      key={mode}
                      onClick={() => handleThemeChange(mode)}
                      style={{
                        padding: '8px',
                        borderRadius: '6px',
                        fontSize: '12px',
                        fontWeight: 500,
                        border: isSelected ? '1px solid var(--accent)' : '1px solid var(--border)',
                        background: isSelected ? 'var(--accent-subtle)' : 'var(--bg-surface-raised)',
                        color: isSelected ? 'var(--accent-text)' : 'var(--text-primary)',
                        cursor: 'pointer',
                        textTransform: 'capitalize',
                        transition: 'all 0.15s ease',
                      }}
                    >
                      {mode}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Account Card */}
            <div
              style={{
                background: 'var(--bg-surface)',
                border: '1px solid var(--border)',
                borderRadius: '6px',
                padding: '14px',
                boxShadow: 'var(--card-shadow)',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <span style={{ fontSize: '12px', fontWeight: 600 }}>Gmail Account</span>
                {isConnected ? (
                  <span className="status-pill connected">● Connected</span>
                ) : (
                  <span className="status-pill not-connected">Disconnected</span>
                )}
              </div>

              <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '10px' }}>
                {syncState?.accountEmail ? (
                  <span>Connected as: <strong>{syncState.accountEmail}</strong></span>
                ) : (
                  <span>No account connected.</span>
                )}
              </div>

              {isConnected ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                      onClick={() => handleSwitchAccount()}
                      disabled={isBusy}
                      className="btn-primary"
                      style={{ flex: 1 }}
                      title="Switch to another Google Account"
                    >
                      Switch Account
                    </button>
                    <button
                      onClick={handleDisconnectGmail}
                      disabled={isBusy}
                      className="btn-danger"
                      title="Disconnect Gmail account and clear local cache"
                    >
                      Disconnect
                    </button>
                  </div>

                  {availableAccounts.length > 0 && (
                    <div style={{ marginTop: '6px', paddingTop: '8px', borderTop: '1px solid var(--border-subtle)' }}>
                      <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '6px' }}>
                        Detected Accounts:
                      </div>
                      {availableAccounts.map((accId) => (
                        <div key={accId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                          <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>{accId}</span>
                          <button
                            onClick={() => handleSwitchAccount(accId)}
                            disabled={isBusy || accId === syncState?.accountEmail}
                            className="btn-secondary"
                            style={{ fontSize: '10px', padding: '3px 8px' }}
                          >
                            {accId === syncState?.accountEmail ? 'Active' : 'Switch'}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', lineHeight: 1.4, marginTop: '4px' }}>
                    Switching accounts resets local email storage and opens the Google account picker.
                    <br />
                    <em>Tip:</em> Chrome extensions bind to the active Chrome Profile. If your college account uses a dedicated Chrome Profile, launch that profile to use it directly.
                  </div>
                </div>
              ) : (
                <button
                  onClick={handleConnectGmail}
                  disabled={isBusy}
                  className="btn-primary"
                >
                  Connect Gmail Account
                </button>
              )}
            </div>

            {/* Alert Threshold */}
            <div
              style={{
                background: 'var(--bg-surface)',
                border: '1px solid var(--border)',
                borderRadius: '6px',
                padding: '14px',
                boxShadow: 'var(--card-shadow)',
              }}
            >
              <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, marginBottom: '4px' }}>
                Notification Threshold: {settings?.alertThreshold ?? 50} / 100
              </label>
              <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: '0 0 10px 0' }}>
                Minimum importance score to trigger OS-level attention reminders.
              </p>
              <input
                type="range"
                min="20"
                max="90"
                step="5"
                value={settings?.alertThreshold ?? 50}
                onInput={(e) => handleUpdateThreshold(Number((e.target as HTMLInputElement).value))}
                style={{ width: '100%', accentColor: 'var(--accent)', cursor: 'pointer' }}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: 'var(--text-muted)' }}>
                <span>More Alerts (20)</span>
                <span>Balanced (50)</span>
                <span>Critical Only (90)</span>
              </div>
            </div>

            {/* Advanced Diagnostics (Collapsible) */}
            <details
              style={{
                background: 'var(--bg-surface)',
                border: '1px solid var(--border)',
                borderRadius: '6px',
                padding: '12px 14px',
                boxShadow: 'var(--card-shadow)',
              }}
            >
              <summary
                style={{
                  fontSize: '12px',
                  fontWeight: 600,
                  cursor: 'pointer',
                  userSelect: 'none',
                  outline: 'none',
                  color: 'var(--text-secondary)',
                }}
              >
                Advanced Diagnostics
              </summary>
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '6px',
                  fontSize: '11px',
                  color: 'var(--text-secondary)',
                  marginTop: '10px',
                  paddingTop: '8px',
                  borderTop: '1px solid var(--border-subtle)',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--text-muted)' }}>Messages Indexed:</span>
                  <span>{emails.length}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--text-muted)' }}>Attention Items:</span>
                  <span>{attentionItems.length}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--text-muted)' }}>Pending Attention:</span>
                  <span style={{ fontWeight: 600, color: unhandledCount > 0 ? 'var(--warning-text)' : 'inherit' }}>
                    {unhandledCount}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--text-muted)' }}>Sync Cursor:</span>
                  <span style={{ fontFamily: 'monospace' }}>{syncState?.historyId || 'None'}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--text-muted)' }}>Check Frequency:</span>
                  <span>Every {settings?.pollingIntervalMinutes || 2}m</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--text-muted)' }}>Safety Verification:</span>
                  <span>Every 30m</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--text-muted)' }}>Permission Scope:</span>
                  <span>Read-only Gmail access</span>
                </div>
              </div>
            </details>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer
        style={{
          padding: '8px 16px',
          borderTop: '1px solid var(--border)',
          background: 'var(--bg-surface)',
          fontSize: '11px',
          color: 'var(--text-muted)',
          display: 'flex',
          justifyContent: 'space-between',
        }}
      >
        <span>Attention Manager v1.0.0</span>
        <span>Private &amp; on-device</span>
      </footer>
    </div>
  );
}

const root = document.getElementById('root');
if (root) {
  render(<SidePanel />, root);
}
