import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { db } from '../src/db';
import { storage } from '../src/shared/storage';
import {
  gmailClient,
  GmailAuthError,
  GmailNotFoundError,
} from '../src/background/gmail/client';
import {
  isSyncActive,
  performIncrementalSync,
  performInitialSync,
  performSafetyScan,
  resetSyncLockForTesting,
} from '../src/background/gmail/sync';

describe('Gmail Synchronization Engine (Phase 1B)', () => {
  beforeEach(async () => {
    resetSyncLockForTesting();
    await db.emails.clear();
    await storage.clearAll();
    vi.restoreAllMocks();

    // Default connected sync state
    await storage.setSyncState({
      authState: 'connected',
      accountEmail: 'test@example.com',
      historyId: 'cursor_100',
      isSyncing: false,
      lastError: null,
    });
  });

  it('performs initial sync, fetches recent messages, and saves to Dexie', async () => {
    vi.spyOn(gmailClient, 'listMessages').mockResolvedValue({
      messages: [{ id: 'msg_1', threadId: 'th_1' }, { id: 'msg_2', threadId: 'th_2' }],
    });

    vi.spyOn(gmailClient, 'getMessage').mockImplementation(async (id: string) => ({
      id,
      threadId: `th_${id}`,
      labelIds: ['INBOX', 'UNREAD'],
      snippet: `Snippet for ${id}`,
      internalDate: '1726400000000',
      payload: {
        mimeType: 'text/plain',
        headers: [
          { name: 'Subject', value: `Subject ${id}` },
          { name: 'From', value: 'Recruiter <jobs@company.com>' },
        ],
        body: {
          data: Buffer.from(`Body content for ${id}`).toString('base64'),
        },
      },
    }));

    vi.spyOn(gmailClient, 'getProfile').mockResolvedValue({
      emailAddress: 'test@example.com',
      messagesTotal: 100,
      threadsTotal: 50,
      historyId: 'cursor_200',
    });

    const result = await performInitialSync(10);
    expect(result.success).toBe(true);
    expect(result.syncedCount).toBe(2);
    expect(result.historyId).toBe('cursor_200');

    // Verify Dexie storage
    const count = await db.emails.count();
    expect(count).toBe(2);

    const email1 = await db.emails.get('msg_1');
    expect(email1?.subject).toBe('Subject msg_1');
    expect(email1?.fromDomain).toBe('company.com');
    expect(email1?.isUnread).toBe(true);

    // Verify storage state
    const syncState = await storage.getSyncState();
    expect(syncState.historyId).toBe('cursor_200');
    expect(syncState.isSyncing).toBe(false);
    expect(syncState.lastSyncTime).toBeGreaterThan(0);
  });

  it('prevents duplicate emails when syncing the same messages multiple times', async () => {
    vi.spyOn(gmailClient, 'listMessages').mockResolvedValue({
      messages: [{ id: 'msg_duplicate', threadId: 'th_dup' }],
    });

    vi.spyOn(gmailClient, 'getMessage').mockResolvedValue({
      id: 'msg_duplicate',
      threadId: 'th_dup',
      snippet: 'Initial snippet',
      internalDate: '1726400000000',
      payload: {
        mimeType: 'text/plain',
        headers: [{ name: 'Subject', value: 'Job Opportunity' }],
        body: { data: Buffer.from('Initial text').toString('base64') },
      },
    });

    vi.spyOn(gmailClient, 'getProfile').mockResolvedValue({
      emailAddress: 'test@example.com',
      messagesTotal: 1,
      threadsTotal: 1,
      historyId: 'cursor_101',
    });

    // Run sync 1
    await performInitialSync();
    expect(await db.emails.count()).toBe(1);

    // Run sync 2 with modified snippet to test update vs duplicate
    vi.spyOn(gmailClient, 'getMessage').mockResolvedValue({
      id: 'msg_duplicate',
      threadId: 'th_dup',
      snippet: 'Updated snippet',
      internalDate: '1726400000000',
      payload: {
        mimeType: 'text/plain',
        headers: [{ name: 'Subject', value: 'Job Opportunity Updated' }],
        body: { data: Buffer.from('Updated text').toString('base64') },
      },
    });

    await performInitialSync();

    // Verify no duplicates were created
    const countAfter = await db.emails.count();
    expect(countAfter).toBe(1);

    const updated = await db.emails.get('msg_duplicate');
    expect(updated?.subject).toBe('Job Opportunity Updated');
  });

  it('protects against concurrent overlapping sync operations', async () => {
    let resolveList: (val: unknown) => void;
    const slowListPromise = new Promise((resolve) => {
      resolveList = resolve;
    });

    vi.spyOn(gmailClient, 'listMessages').mockReturnValue(slowListPromise as never);
    vi.spyOn(gmailClient, 'getProfile').mockResolvedValue({
      emailAddress: 'test@example.com',
      messagesTotal: 0,
      threadsTotal: 0,
      historyId: 'cursor_100',
    });

    // Start first sync (holds lock)
    const firstSyncPromise = performInitialSync();

    // Attempt second sync immediately
    const secondSyncResult = await performInitialSync();
    expect(secondSyncResult.skipped).toBe(true);
    expect(secondSyncResult.success).toBe(false);

    // Release first sync
    resolveList!({ messages: [] });
    await firstSyncPromise;

    expect(isSyncActive()).toBe(false);
  });

  it('performs incremental sync using history.list with messagesAdded', async () => {
    vi.spyOn(gmailClient, 'listHistory').mockResolvedValue({
      historyId: 'cursor_300',
      history: [
        {
          id: 'hist_1',
          messagesAdded: [
            {
              message: {
                id: 'new_msg_99',
                threadId: 'th_99',
                labelIds: ['INBOX'],
              },
            },
          ],
        },
      ],
    });

    vi.spyOn(gmailClient, 'getMessage').mockResolvedValue({
      id: 'new_msg_99',
      threadId: 'th_99',
      labelIds: ['INBOX'],
      snippet: 'Fresh email arrived',
      internalDate: '1726405000000',
      payload: {
        mimeType: 'text/plain',
        headers: [{ name: 'Subject', value: 'New Assessment Link' }],
        body: { data: Buffer.from('Test details').toString('base64') },
      },
    });

    const result = await performIncrementalSync();
    expect(result.success).toBe(true);
    expect(result.syncedCount).toBe(1);
    expect(result.historyId).toBe('cursor_300');

    const stored = await db.emails.get('new_msg_99');
    expect(stored).toBeDefined();
    expect(stored?.subject).toBe('New Assessment Link');

    const syncState = await storage.getSyncState();
    expect(syncState.historyId).toBe('cursor_300');
  });

  it('gracefully falls back to initial sync when history cursor has expired (404)', async () => {
    // 1. History returns 404
    vi.spyOn(gmailClient, 'listHistory').mockRejectedValue(new GmailNotFoundError());

    // 2. Initial sync mocks
    vi.spyOn(gmailClient, 'listMessages').mockResolvedValue({
      messages: [{ id: 'fallback_msg_1', threadId: 'th_fb' }],
    });
    vi.spyOn(gmailClient, 'getMessage').mockResolvedValue({
      id: 'fallback_msg_1',
      threadId: 'th_fb',
      snippet: 'Recovered after history expired',
      internalDate: '1726405000000',
      payload: {
        mimeType: 'text/plain',
        headers: [{ name: 'Subject', value: 'Recovered Message' }],
      },
    });
    vi.spyOn(gmailClient, 'getProfile').mockResolvedValue({
      emailAddress: 'test@example.com',
      messagesTotal: 5,
      threadsTotal: 5,
      historyId: 'new_fresh_cursor_500',
    });

    const result = await performIncrementalSync();
    expect(result.success).toBe(true);
    expect(result.syncedCount).toBe(1);
    expect(result.historyId).toBe('new_fresh_cursor_500');

    const stored = await db.emails.get('fallback_msg_1');
    expect(stored).toBeDefined();
    expect(stored?.subject).toBe('Recovered Message');
  });

  it('handles 401 authentication expiration during sync without crashing', async () => {
    vi.spyOn(gmailClient, 'listMessages').mockRejectedValue(new GmailAuthError());

    const result = await performInitialSync();
    expect(result.success).toBe(false);
    expect(result.error).toBe('Authentication expired');

    // Verify storage updated to error state
    const syncState = await storage.getSyncState();
    expect(syncState.authState).toBe('error');
    expect(syncState.lastError).toContain('session expired');
    expect(syncState.isSyncing).toBe(false);
  });

  it('runs periodic safety scan for recent unread emails', async () => {
    vi.spyOn(gmailClient, 'listMessages').mockResolvedValue({
      messages: [{ id: 'safety_msg_1', threadId: 'th_safety' }],
    });

    vi.spyOn(gmailClient, 'getMessage').mockResolvedValue({
      id: 'safety_msg_1',
      threadId: 'th_safety',
      labelIds: ['INBOX', 'UNREAD'],
      snippet: 'Found via safety scan',
      internalDate: '1726406000000',
      payload: {
        mimeType: 'text/plain',
        headers: [{ name: 'Subject', value: 'Unread Alert' }],
      },
    });

    const result = await performSafetyScan();
    expect(result.success).toBe(true);
    expect(result.syncedCount).toBe(1);

    const syncState = await storage.getSyncState();
    expect(syncState.lastSafetyScanTime).toBeGreaterThan(0);
    expect(await db.emails.count()).toBe(1);
  });
});
