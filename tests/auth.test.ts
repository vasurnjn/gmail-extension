import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { AttentionItem } from '../src/shared/types';
import { db } from '../src/db';
import { storage } from '../src/shared/storage';
import {
  clearAllCachedAuthTokens,
  connectGmail,
  disconnectGmail,
  fetchGmailProfile,
  getAuthToken,
  getAvailableAccounts,
  removeCachedAuthToken,
  switchAccount,
} from '../src/background/gmail/auth';

function createDummyAttentionItem(id = 'att_sample_123'): AttentionItem {
  return {
    id,
    identityKey: 'career_placement::test company::role_software',
    category: 'career_placement',
    canonicalEntity: 'test company',
    entityStatus: 'known',
    topicScope: 'role_software',
    topicStatus: 'known',
    threadIds: ['th_test'],
    messageIds: ['msg_test'],
    latestEmailId: 'msg_test',
    firstSeenAt: 1726500000000,
    lastSeenAt: 1726500000000,
    itemLifecycleState: 'active',
    userAttentionState: 'unhandled',
    importanceScore: 80,
    urgencyScore: 70,
    currentState: {
      primaryEventTimestamp: 1727024400000,
      primaryDeadlineTimestamp: null,
      venue: 'SJT 706',
      actionRequired: true,
      actionType: 'attend',
      itemLifecycleState: 'active',
      subEvents: [],
    },
    history: [
      {
        emailId: 'msg_test',
        internalDate: 1726500000000,
        recordedAt: 1726500000000,
        relation: 'NEW',
        deltas: [],
        summary: 'Initial item creation',
      },
    ],
  };
}

describe('Gmail Auth Module (Phase 1A)', () => {
  beforeEach(async () => {
    await db.emails.clear();
    await db.attentionItems.clear();
    await storage.clearAll();
    vi.restoreAllMocks();

    // Mock chrome API environment
    (globalThis as unknown as { chrome: unknown }).chrome = {
      identity: {
        getAuthToken: vi.fn((_details: { interactive: boolean; account?: { id: string } }, cb: (token?: string) => void) => {
          cb('mock_valid_token_123');
        }),
        removeCachedAuthToken: vi.fn((_details: { token: string }, cb: () => void) => {
          if (cb) cb();
        }),
        clearAllCachedAuthTokens: vi.fn((cb: () => void) => {
          if (cb) cb();
        }),
        getAccounts: vi.fn((cb: (accounts: { id: string }[]) => void) => {
          if (cb) cb([{ id: 'acc1@college.edu' }, { id: 'acc2@gmail.com' }]);
        }),
      },
      runtime: {
        lastError: null,
      },
    };
  });

  it('obtains auth token via chrome.identity', async () => {
    const token = await getAuthToken(false);
    expect(token).toBe('mock_valid_token_123');
    expect(chrome.identity.getAuthToken).toHaveBeenCalledWith(
      { interactive: false },
      expect.any(Function)
    );
  });

  it('handles user cancellation or OAuth failure gracefully', async () => {
    (globalThis as unknown as { chrome: { identity: { getAuthToken: ReturnType<typeof vi.fn> }; runtime: { lastError: unknown } } }).chrome.identity.getAuthToken = vi.fn(
      (_details: { interactive: boolean }, cb: (token?: string) => void) => {
        (chrome.runtime as { lastError: unknown }).lastError = { message: 'User cancelled the prompt' };
        cb(undefined);
      }
    );

    await expect(getAuthToken(true)).rejects.toThrow('User declined or closed the Google authorization prompt.');
  });

  it('handles missing or bad client ID error with clear instructions', async () => {
    (globalThis as unknown as { chrome: { identity: { getAuthToken: ReturnType<typeof vi.fn> }; runtime: { lastError: unknown } } }).chrome.identity.getAuthToken = vi.fn(
      (_details: { interactive: boolean }, cb: (token?: string) => void) => {
        (chrome.runtime as { lastError: unknown }).lastError = { message: 'OAuth2 client not found' };
        cb(undefined);
      }
    );

    await expect(getAuthToken(true)).rejects.toThrow('Google OAuth Client ID is not configured');
  });

  it('removes token from cache via removeCachedAuthToken', async () => {
    await removeCachedAuthToken('bad_token');
    expect(chrome.identity.removeCachedAuthToken).toHaveBeenCalledWith(
      { token: 'bad_token' },
      expect.any(Function)
    );
  });

  it('verifies Gmail access via minimal profile request (GET /users/me/profile)', async () => {
    const mockProfile = {
      emailAddress: 'student@university.edu',
      messagesTotal: 342,
      threadsTotal: 120,
      historyId: '9876543',
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockProfile,
    });

    const result = await fetchGmailProfile('mock_token');
    expect(result.emailAddress).toBe('student@university.edu');
    expect(result.historyId).toBe('9876543');
    expect(result.messagesTotal).toBe(342);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://gmail.googleapis.com/gmail/v1/users/me/profile',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer mock_token',
        }),
      })
    );
  });

  it('invalidates cached token and throws on 401 Unauthorized', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: async () => ({ error: { message: 'Invalid Credentials' } }),
    });

    await expect(fetchGmailProfile('expired_token')).rejects.toThrow(
      'Gmail token expired or unauthorized (401)'
    );

    expect(chrome.identity.removeCachedAuthToken).toHaveBeenCalledWith(
      { token: 'expired_token' },
      expect.any(Function)
    );
  });

  it('executes full connectGmail flow and updates storage without persisting the raw token', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        emailAddress: 'applicant@gmail.com',
        historyId: '54321',
        messagesTotal: 10,
      }),
    });

    const result = await connectGmail(true);
    expect(result.success).toBe(true);
    expect(result.email).toBe('applicant@gmail.com');

    // Verify storage has state updated
    const syncState = await storage.getSyncState();
    expect(syncState.authState).toBe('connected');
    expect(syncState.accountEmail).toBe('applicant@gmail.com');
    expect(syncState.historyId).toBe('54321');
    expect(syncState.lastError).toBeNull();

    // Verify token was NOT stored in storage
    const allLocal = await chrome.storage?.local?.get(null) || {};
    expect(JSON.stringify(allLocal)).not.toContain('mock_valid_token_123');
  });

  it('handles connectGmail failure and records error state', async () => {
    (globalThis as unknown as { chrome: { identity: { getAuthToken: ReturnType<typeof vi.fn> }; runtime: { lastError: unknown } } }).chrome.identity.getAuthToken = vi.fn(
      (_details: { interactive: boolean }, cb: (token?: string) => void) => {
        (chrome.runtime as { lastError: unknown }).lastError = { message: 'Network error' };
        cb(undefined);
      }
    );

    const result = await connectGmail(true);
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();

    const syncState = await storage.getSyncState();
    expect(syncState.authState).toBe('error');
    expect(syncState.lastError).toContain('OAuth error: Network error');
  });

  it('disconnectGmail resets state, calls revoke, clears cached tokens and wipes Dexie emails', async () => {
    // Populate dummy email in Dexie
    await db.emails.put({
      id: 'msg_old',
      threadId: 'th_old',
      subject: 'Old',
      from: 'sender@example.com',
      fromDomain: 'example.com',
      snippet: 'Old email',
      internalDate: Date.now(),
      processedAt: Date.now(),
      bodyTextPreview: 'Text',
      labels: ['INBOX'],
      category: 'general',
      confidence: 0.9,
      importanceScore: 50,
      urgencyScore: 50,
      actionRequired: false,
      actionType: null,
      detectionReasons: [],
      extractedEntities: {
        deadlines: [],
        dates: [],
        organizations: [],
        locations: [],
        ctc: null,
        urls: [],
      },
      alertStatus: 'pending',
      snoozeUntil: null,
      handledAt: null,
    });
    expect(await db.emails.count()).toBe(1);

    // Set initially connected
    await storage.setSyncState({
      authState: 'connected',
      accountEmail: 'user@gmail.com',
      historyId: '100',
    });

    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });

    const result = await disconnectGmail();
    expect(result.success).toBe(true);

    // Verify token revocation was called
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://oauth2.googleapis.com/revoke',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'token=mock_valid_token_123',
      })
    );

    // Verify clearAllCachedAuthTokens was called
    expect(chrome.identity.clearAllCachedAuthTokens).toHaveBeenCalled();

    // Verify Dexie emails were wiped to prevent account data pollution
    expect(await db.emails.count()).toBe(0);

    const syncState = await storage.getSyncState();
    expect(syncState.authState).toBe('not_connected');
    expect(syncState.accountEmail).toBeNull();
    expect(syncState.historyId).toBeNull();
  });

  it('disconnect clears emails', async () => {
    await db.emails.put({
      id: 'msg_test_disconnect',
      threadId: 'th_1',
      subject: 'Test Subject',
      from: 'sender@example.com',
      fromDomain: 'example.com',
      snippet: 'Snippet',
      internalDate: Date.now(),
      processedAt: Date.now(),
      bodyTextPreview: 'Body text',
      labels: ['INBOX'],
      category: 'career_placement',
      confidence: 0.9,
      importanceScore: 80,
      urgencyScore: 80,
      actionRequired: true,
      actionType: 'attend',
      detectionReasons: [],
      extractedEntities: { deadlines: [], dates: [], organizations: [], locations: [], ctc: null, urls: [] },
      alertStatus: 'pending',
      snoozeUntil: null,
      handledAt: null,
    });
    expect(await db.emails.count()).toBe(1);

    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });
    const result = await disconnectGmail();
    expect(result.success).toBe(true);

    // 1. Disconnect clears emails
    expect(await db.emails.count()).toBe(0);
  });

  it('disconnect also clears attentionItems', async () => {
    await db.attentionItems.put(createDummyAttentionItem('att_test_1'));
    await db.attentionItems.put(createDummyAttentionItem('att_test_2'));
    expect(await db.attentionItems.count()).toBe(2);

    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });
    const result = await disconnectGmail();
    expect(result.success).toBe(true);

    // 2. Disconnect also clears attentionItems
    expect(await db.attentionItems.count()).toBe(0);
  });

  it('reconnecting an account starts with no previous AttentionItems', async () => {
    // Populate old AttentionItems and emails from prior session
    await db.emails.put({
      id: 'msg_prior',
      threadId: 'th_prior',
      subject: 'Prior Subject',
      from: 'placement@vit.ac.in',
      fromDomain: 'vit.ac.in',
      snippet: 'Prior snippet',
      internalDate: Date.now(),
      processedAt: Date.now(),
      bodyTextPreview: 'Prior text',
      labels: ['INBOX'],
      category: 'career_placement',
      confidence: 0.9,
      importanceScore: 80,
      urgencyScore: 80,
      actionRequired: true,
      actionType: 'attend',
      detectionReasons: [],
      extractedEntities: { deadlines: [], dates: [], organizations: [], locations: [], ctc: null, urls: [] },
      alertStatus: 'pending',
      snoozeUntil: null,
      handledAt: null,
      attentionItemId: 'att_prior_1',
      changeRelation: 'NEW',
    });
    await db.attentionItems.put(createDummyAttentionItem('att_prior_1'));
    expect(await db.emails.count()).toBe(1);
    expect(await db.attentionItems.count()).toBe(1);

    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('revoke')) {
        return { ok: true, status: 200, json: async () => ({}) };
      }
      if (url.includes('profile')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            emailAddress: 'student@vitstudent.ac.in',
            historyId: '10001',
            messagesTotal: 10,
          }),
        };
      }
      return { ok: false, status: 404 };
    });

    // Step 1: Disconnect happens
    const disconnectResult = await disconnectGmail();
    expect(disconnectResult.success).toBe(true);
    expect(await db.emails.count()).toBe(0);
    expect(await db.attentionItems.count()).toBe(0);

    // Step 2: Reconnect happens
    const connectResult = await connectGmail(true);
    expect(connectResult.success).toBe(true);
    expect(connectResult.email).toBe('student@vitstudent.ac.in');

    // Step 3: Reconnecting an account starts with no previous AttentionItems
    expect(await db.attentionItems.count()).toBe(0);
    expect(await db.emails.count()).toBe(0);
  });

  it('getAuthToken passes account parameter when accountId is specified', async () => {
    const token = await getAuthToken(true, 'college@university.edu');
    expect(token).toBe('mock_valid_token_123');
    expect(chrome.identity.getAuthToken).toHaveBeenCalledWith(
      { interactive: true, account: { id: 'college@university.edu' } },
      expect.any(Function)
    );
  });

  it('clearAllCachedAuthTokens calls chrome.identity.clearAllCachedAuthTokens', async () => {
    await clearAllCachedAuthTokens();
    expect(chrome.identity.clearAllCachedAuthTokens).toHaveBeenCalled();
  });

  it('getAvailableAccounts retrieves account IDs from chrome.identity', async () => {
    const accounts = await getAvailableAccounts();
    expect(accounts).toEqual(['acc1@college.edu', 'acc2@gmail.com']);
  });

  it('switchAccount disconnects current account and connects new account', async () => {
    // Insert an email for the old account
    await db.emails.put({
      id: 'msg_personal',
      threadId: 'th_personal',
      subject: 'Personal',
      from: 'friend@example.com',
      fromDomain: 'example.com',
      snippet: 'Personal email',
      internalDate: Date.now(),
      processedAt: Date.now(),
      bodyTextPreview: 'Text',
      labels: ['INBOX'],
      category: 'general',
      confidence: 0.9,
      importanceScore: 50,
      urgencyScore: 50,
      actionRequired: false,
      actionType: null,
      detectionReasons: [],
      extractedEntities: {
        deadlines: [],
        dates: [],
        organizations: [],
        locations: [],
        ctc: null,
        urls: [],
      },
      alertStatus: 'pending',
      snoozeUntil: null,
      handledAt: null,
    });

    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('revoke')) {
        return { ok: true, status: 200, json: async () => ({}) };
      }
      if (url.includes('profile')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            emailAddress: 'college@university.edu',
            historyId: '99999',
            messagesTotal: 42,
          }),
        };
      }
      return { ok: false, status: 404 };
    });

    const result = await switchAccount('college@university.edu');
    expect(result.success).toBe(true);
    expect(result.email).toBe('college@university.edu');

    // Verify old account emails were purged
    expect(await db.emails.count()).toBe(0);

    // Verify new sync state
    const syncState = await storage.getSyncState();
    expect(syncState.authState).toBe('connected');
    expect(syncState.accountEmail).toBe('college@university.edu');
    expect(syncState.historyId).toBe('99999');
  });

  it('account switching cannot retain AttentionItems from the previous account', async () => {
    // Populate previous account data with both an email and an AttentionItem
    await db.emails.put({
      id: 'msg_account_a',
      threadId: 'th_account_a',
      subject: 'Account A Recruitment',
      from: 'cdc@vit.ac.in',
      fromDomain: 'vit.ac.in',
      snippet: 'Previous account recruitment message',
      internalDate: Date.now(),
      processedAt: Date.now(),
      bodyTextPreview: 'Previous account body',
      labels: ['INBOX'],
      category: 'career_placement',
      confidence: 0.9,
      importanceScore: 80,
      urgencyScore: 80,
      actionRequired: true,
      actionType: 'attend',
      detectionReasons: [],
      extractedEntities: { deadlines: [], dates: [], organizations: [], locations: [], ctc: null, urls: [] },
      alertStatus: 'pending',
      snoozeUntil: null,
      handledAt: null,
      attentionItemId: 'att_account_a',
      changeRelation: 'NEW',
    });
    await db.attentionItems.put(createDummyAttentionItem('att_account_a'));
    expect(await db.emails.count()).toBe(1);
    expect(await db.attentionItems.count()).toBe(1);

    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('revoke')) {
        return { ok: true, status: 200, json: async () => ({}) };
      }
      if (url.includes('profile')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            emailAddress: 'account_b@university.edu',
            historyId: '88888',
            messagesTotal: 25,
          }),
        };
      }
      return { ok: false, status: 404 };
    });

    // Perform account switch to Account B
    const result = await switchAccount('account_b@university.edu');
    expect(result.success).toBe(true);
    expect(result.email).toBe('account_b@university.edu');

    // 4. Account switching cannot retain AttentionItems from the previous account
    expect(await db.attentionItems.count()).toBe(0);
    expect(await db.emails.count()).toBe(0);

    const syncState = await storage.getSyncState();
    expect(syncState.authState).toBe('connected');
    expect(syncState.accountEmail).toBe('account_b@university.edu');
    expect(syncState.historyId).toBe('88888');
  });
});
