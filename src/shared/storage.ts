import {
  CategoryConfig,
  ExtensionSettings,
  LocalSyncState,
} from './types';
import {
  DEFAULT_CATEGORIES,
  DEFAULT_SETTINGS,
  DEFAULT_SYNC_STATE,
  STORAGE_KEY_CATEGORIES,
  STORAGE_KEY_SETTINGS,
  STORAGE_KEY_SYNC_STATE,
} from './constants';

// In-memory fallback for non-extension environments (e.g. testing)
const memoryStorageLocal: Record<string, unknown> = {};
const memoryStorageSession: Record<string, unknown> = {};

function hasChromeStorageLocal(): boolean {
  return typeof chrome !== 'undefined' && Boolean(chrome.storage?.local);
}

function hasChromeStorageSession(): boolean {
  return typeof chrome !== 'undefined' && Boolean(chrome.storage?.session);
}

export const storage = {
  async getSettings(): Promise<ExtensionSettings> {
    if (hasChromeStorageLocal()) {
      const result = await chrome.storage.local.get(STORAGE_KEY_SETTINGS);
      return result[STORAGE_KEY_SETTINGS]
        ? { ...DEFAULT_SETTINGS, ...result[STORAGE_KEY_SETTINGS] }
        : DEFAULT_SETTINGS;
    }
    return (memoryStorageLocal[STORAGE_KEY_SETTINGS] as ExtensionSettings) || DEFAULT_SETTINGS;
  },

  async setSettings(settings: Partial<ExtensionSettings>): Promise<ExtensionSettings> {
    const current = await this.getSettings();
    const updated = { ...current, ...settings };
    if (hasChromeStorageLocal()) {
      await chrome.storage.local.set({ [STORAGE_KEY_SETTINGS]: updated });
    } else {
      memoryStorageLocal[STORAGE_KEY_SETTINGS] = updated;
    }
    return updated;
  },

  async getSyncState(): Promise<LocalSyncState> {
    if (hasChromeStorageLocal()) {
      const result = await chrome.storage.local.get(STORAGE_KEY_SYNC_STATE);
      return result[STORAGE_KEY_SYNC_STATE]
        ? { ...DEFAULT_SYNC_STATE, ...result[STORAGE_KEY_SYNC_STATE] }
        : DEFAULT_SYNC_STATE;
    }
    return (memoryStorageLocal[STORAGE_KEY_SYNC_STATE] as LocalSyncState) || DEFAULT_SYNC_STATE;
  },

  async setSyncState(state: Partial<LocalSyncState>): Promise<LocalSyncState> {
    const current = await this.getSyncState();
    const updated = { ...current, ...state };
    if (hasChromeStorageLocal()) {
      await chrome.storage.local.set({ [STORAGE_KEY_SYNC_STATE]: updated });
    } else {
      memoryStorageLocal[STORAGE_KEY_SYNC_STATE] = updated;
    }
    return updated;
  },

  async getCategories(): Promise<CategoryConfig[]> {
    if (hasChromeStorageLocal()) {
      const result = await chrome.storage.local.get(STORAGE_KEY_CATEGORIES);
      return (result[STORAGE_KEY_CATEGORIES] as CategoryConfig[]) || DEFAULT_CATEGORIES;
    }
    return (memoryStorageLocal[STORAGE_KEY_CATEGORIES] as CategoryConfig[]) || DEFAULT_CATEGORIES;
  },

  async setCategories(categories: CategoryConfig[]): Promise<void> {
    if (hasChromeStorageLocal()) {
      await chrome.storage.local.set({ [STORAGE_KEY_CATEGORIES]: categories });
    } else {
      memoryStorageLocal[STORAGE_KEY_CATEGORIES] = categories;
    }
  },

  // Session storage helpers (survives service worker sleep/wake within session, cleared on browser exit)
  async getSessionItem<T>(key: string): Promise<T | null> {
    if (hasChromeStorageSession()) {
      const result = await chrome.storage.session.get(key);
      return (result[key] as T) ?? null;
    }
    return (memoryStorageSession[key] as T) ?? null;
  },

  async setSessionItem<T>(key: string, value: T): Promise<void> {
    if (hasChromeStorageSession()) {
      await chrome.storage.session.set({ [key]: value });
    } else {
      memoryStorageSession[key] = value;
    }
  },

  // Account-scoped persistent attention history (persists handled/dismissed decisions across reconnects)
  async getAccountAttentionHistory(accountEmail: string): Promise<Record<string, { state: 'handled' | 'dismissed'; updatedAt: number }>> {
    if (!accountEmail) return {};
    const key = `igam_account_attention_${accountEmail.toLowerCase().trim()}`;
    if (hasChromeStorageLocal()) {
      const res = await chrome.storage.local.get(key);
      return (res[key] as Record<string, { state: 'handled' | 'dismissed'; updatedAt: number }>) || {};
    }
    return (memoryStorageLocal[key] as Record<string, { state: 'handled' | 'dismissed'; updatedAt: number }>) || {};
  },

  async recordAccountAttentionDecision(
    accountEmail: string,
    emailIds: string[],
    state: 'handled' | 'dismissed' | 'unhandled'
  ): Promise<void> {
    if (!accountEmail || !Array.isArray(emailIds) || emailIds.length === 0) return;
    const key = `igam_account_attention_${accountEmail.toLowerCase().trim()}`;
    const current = await this.getAccountAttentionHistory(accountEmail);
    const updated = { ...current };

    for (const id of emailIds) {
      if (!id) continue;
      if (state === 'unhandled') {
        delete updated[id];
      } else {
        updated[id] = { state, updatedAt: Date.now() };
      }
    }

    if (hasChromeStorageLocal()) {
      await chrome.storage.local.set({ [key]: updated });
    } else {
      memoryStorageLocal[key] = updated;
    }
  },

  async lookupAccountAttentionState(
    accountEmail: string,
    emailId: string
  ): Promise<'handled' | 'dismissed' | null> {
    if (!accountEmail || !emailId) return null;
    const history = await this.getAccountAttentionHistory(accountEmail);
    return history[emailId]?.state ?? null;
  },

  async clearAccountAttentionHistory(accountEmail: string): Promise<void> {
    if (!accountEmail) return;
    const key = `igam_account_attention_${accountEmail.toLowerCase().trim()}`;
    if (hasChromeStorageLocal()) {
      await chrome.storage.local.remove(key);
    } else {
      delete memoryStorageLocal[key];
    }
  },

  async clearAll(): Promise<void> {
    if (hasChromeStorageLocal()) {
      await chrome.storage.local.clear();
    }
    if (hasChromeStorageSession()) {
      await chrome.storage.session.clear();
    }
    for (const key of Object.keys(memoryStorageLocal)) delete memoryStorageLocal[key];
    for (const key of Object.keys(memoryStorageSession)) delete memoryStorageSession[key];
  },
};
