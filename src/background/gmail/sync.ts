import { db } from '../../db';
import { storage } from '../../shared/storage';
import { EmailRecord } from '../../shared/types';
import { CURRENT_ANALYSIS_VERSION } from '../../shared/constants';
import {
  gmailClient,
  GmailAuthError,
  GmailNotFoundError,
  GmailRateLimitError,
} from './client';
import { normalizeGmailMessage } from './parser';
import { analyzeEmail } from '../analysis';
import { processEmailChange } from '../analysis/change';
import {
  dispatchInitialSyncSummaryNotification,
  handleEmailAttentionPipeline,
  reconcileNotifications,
} from '../notifications';

export interface SyncResult {
  success: boolean;
  syncedCount: number;
  historyId?: string;
  error?: string;
  skipped?: boolean;
}

// Memory lock to guard against overlapping sync runs
let isSyncRunning = false;

/**
 * Returns whether a sync operation is currently active.
 */
export function isSyncActive(): boolean {
  return isSyncRunning;
}

/**
 * Resets sync lock (used in testing environments).
 */
export function resetSyncLockForTesting(): void {
  isSyncRunning = false;
}

/**
 * Re-analyzes any stored emails in Dexie that were saved before Phase 1C classification
 * or need category assignment.
 */
export async function reclassifyStoredEmails(): Promise<number> {
  try {
    const allEmails = await db.emails.toArray();
    let updatedCount = 0;

    for (const email of allEmails) {
      // Stale detection: any email without current analysis version or lacking temporalAnalysis is re-analyzed
      if (email.analysisVersion !== CURRENT_ANALYSIS_VERSION || !email.temporalAnalysis) {
        const { signals, result, importance, urgency, temporal } = analyzeEmail(email);
        email.category = result.category;
        email.confidence = result.confidence;
        email.categoryScore = result.categoryScore;
        email.categoryScores = result.categoryScores;
        email.detectionReasons = result.detectionReasons;
        email.signals = signals;
        email.importanceScore = importance.importanceScore;
        email.importanceReasons = importance.importanceReasons;
        email.urgencyScore = urgency.urgencyScore;
        email.urgencyReasons = urgency.urgencyReasons;
        email.actionRequired = urgency.actionRequired;
        email.actionType = urgency.actionType;
        email.temporalAnalysis = temporal;
        email.extractedEntities = {
          ...email.extractedEntities,
          deadlines: temporal.entities
            .filter((e) => e.type === 'deadline' && e.timestamp !== null)
            .map((e) => ({ text: e.rawText, parsedTimestamp: e.timestamp!, confidence: e.confidence })),
          dates: temporal.entities
            .filter((e) => e.timestamp !== null)
            .map((e) => ({ text: e.rawText, parsedTimestamp: e.timestamp! })),
        };
        email.analysisVersion = CURRENT_ANALYSIS_VERSION;
        email.processedAt = Date.now();
        const changeAnalysis = await processEmailChange(email, db);
        await handleEmailAttentionPipeline(email, changeAnalysis, { isInitialSync: true }, db);
        updatedCount++;
      }
    }
    return updatedCount;
  } catch (err) {
    console.warn('[IGAM Sync] Reclassification error:', err);
    return 0;
  }
}

/**
 * Fetches message bodies in controlled concurrent chunks (e.g. 5 at a time)
 * to respect rate limits and memory constraints.
 */
async function fetchAndNormalizeBatch(messageIds: string[]): Promise<EmailRecord[]> {
  const results: EmailRecord[] = [];
  const chunkSize = 5;

  for (let i = 0; i < messageIds.length; i += chunkSize) {
    const chunk = messageIds.slice(i, i + chunkSize);
    const promises = chunk.map(async (id) => {
      try {
        const raw = await gmailClient.getMessage(id, 'full');
        const record = normalizeGmailMessage(raw);

        // Run local signal extraction, category classification, temporal analysis & scoring
        const { signals, result, importance, urgency, temporal } = analyzeEmail(record);
        record.category = result.category;
        record.confidence = result.confidence;
        record.categoryScore = result.categoryScore;
        record.categoryScores = result.categoryScores;
        record.detectionReasons = result.detectionReasons;
        record.signals = signals;
        record.importanceScore = importance.importanceScore;
        record.importanceReasons = importance.importanceReasons;
        record.urgencyScore = urgency.urgencyScore;
        record.urgencyReasons = urgency.urgencyReasons;
        record.actionRequired = urgency.actionRequired;
        record.actionType = urgency.actionType;
        record.temporalAnalysis = temporal;
        record.extractedEntities = {
          ...record.extractedEntities,
          deadlines: temporal.entities
            .filter((e) => e.type === 'deadline' && e.timestamp !== null)
            .map((e) => ({ text: e.rawText, parsedTimestamp: e.timestamp!, confidence: e.confidence })),
          dates: temporal.entities
            .filter((e) => e.timestamp !== null)
            .map((e) => ({ text: e.rawText, parsedTimestamp: e.timestamp! })),
        };
        record.analysisVersion = CURRENT_ANALYSIS_VERSION;
        record.processedAt = Date.now();

        return record;
      } catch (err) {
        console.warn(`[IGAM Sync] Failed to fetch message ${id}:`, err);
        return null;
      }
    });

    const chunkResults = await Promise.all(promises);
    for (const record of chunkResults) {
      if (record) {
        results.push(record);
      }
    }
  }

  return results;
}

/**
 * Performs a conservative initial sync:
 * 1. Checks that Gmail is connected.
 * 2. Fetches recent messages from INBOX (default max 15).
 * 3. Normalizes and upserts them into Dexie DB (preventing duplicates).
 * 4. Captures latest historyId and updates sync state.
 */
export async function performInitialSync(maxResults = 100): Promise<SyncResult> {
  if (isSyncRunning) {
    console.log('[IGAM Sync] Sync already in progress, skipping.');
    return { success: false, syncedCount: 0, skipped: true };
  }
  isSyncRunning = true;

  const syncState = await storage.getSyncState();
  if (syncState.authState !== 'connected') {
    isSyncRunning = false;
    return { success: false, syncedCount: 0, error: 'Gmail is not connected' };
  }

  await storage.setSyncState({ isSyncing: true, lastError: null });

  let result: SyncResult;
  try {
    // 1. Fetch recent INBOX messages list
    const listResponse = await gmailClient.listMessages({
      q: 'label:INBOX',
      maxResults,
    });

    const messageList = listResponse.messages || [];
    let syncedCount = 0;

    if (messageList.length > 0) {
      const ids = messageList.map((m) => m.id);
      // 2. Fetch details & parse
      const records = await fetchAndNormalizeBatch(ids);

      if (records.length > 0) {
        // Sort chronologically ascending so earlier emails establish AttentionItems first
        records.sort((a, b) => (a.internalDate || 0) - (b.internalDate || 0));
        let eligibleCount = 0;
        for (const record of records) {
          const changeAnalysis = await processEmailChange(record, db);
          const pipeRes = await handleEmailAttentionPipeline(
            record,
            changeAnalysis,
            { isInitialSync: true },
            db
          );
          if (pipeRes.eligible) {
            eligibleCount++;
          }
        }
        if (eligibleCount > 0) {
          await dispatchInitialSyncSummaryNotification(eligibleCount);
        }
        syncedCount = records.length;
      }
    }

    // 4. Capture current historyId from profile
    let currentHistoryId = syncState.historyId;
    try {
      const profile = await gmailClient.getProfile();
      currentHistoryId = profile.historyId;
    } catch (err) {
      console.warn('[IGAM Sync] Could not refresh profile historyId:', err);
    }

    // 5. Update sync state
    await storage.setSyncState({
      historyId: currentHistoryId,
      lastSyncTime: Date.now(),
      isSyncing: false,
      lastError: null,
    });

    result = {
      success: true,
      syncedCount,
      historyId: currentHistoryId || undefined,
    };
  } catch (err) {
    result = await handleSyncError(err);
  } finally {
    isSyncRunning = false;
  }

  return result;
}

/**
 * Performs incremental sync using users.history.list:
 * 1. Uses saved historyId as cursor.
 * 2. If no historyId exists or if API returns 404 (cursor expired), falls back to initial sync.
 * 3. Fetches newly added messages, parses, and upserts them.
 * 4. Advances historyId cursor.
 */
export async function performIncrementalSync(): Promise<SyncResult> {
  if (isSyncRunning) {
    console.log('[IGAM Sync] Sync already in progress, skipping.');
    return { success: false, syncedCount: 0, skipped: true };
  }
  isSyncRunning = true;

  const syncState = await storage.getSyncState();
  if (syncState.authState !== 'connected') {
    isSyncRunning = false;
    return { success: false, syncedCount: 0, error: 'Gmail is not connected' };
  }

  // Fallback to initial sync if we have no history cursor
  if (!syncState.historyId) {
    console.log('[IGAM Sync] No history cursor found. Running initial sync...');
    isSyncRunning = false;
    return performInitialSync();
  }

  await storage.setSyncState({ isSyncing: true, lastError: null });

  let result: SyncResult;
  try {
    let historyResponse;
    try {
      historyResponse = await gmailClient.listHistory({
        startHistoryId: syncState.historyId,
        historyTypes: 'messageAdded',
        maxResults: 50,
      });
    } catch (err) {
      if (err instanceof GmailNotFoundError) {
        // 404 on history.list means historyId is too old or expired (>7 days)
        console.warn('[IGAM Sync] historyId expired (404). Falling back gracefully to initial sync.');
        isSyncRunning = false;
        return performInitialSync();
      }
      throw err;
    }

    const historyRecords = historyResponse.history || [];
    const newIds = new Set<string>();

    for (const record of historyRecords) {
      if (record.messagesAdded) {
        for (const added of record.messagesAdded) {
          if (added.message?.id) {
            newIds.add(added.message.id);
          }
        }
      }
    }

    let syncedCount = 0;
    if (newIds.size > 0) {
      const records = await fetchAndNormalizeBatch(Array.from(newIds));
      if (records.length > 0) {
        // Sort chronologically ascending so earlier emails establish AttentionItems first
        records.sort((a, b) => (a.internalDate || 0) - (b.internalDate || 0));
        for (const record of records) {
          const changeAnalysis = await processEmailChange(record, db);
          await handleEmailAttentionPipeline(
            record,
            changeAnalysis,
            { isInitialSync: false },
            db
          );
        }
        syncedCount = records.length;
      }
    }

    const updatedHistoryId = historyResponse.historyId || syncState.historyId;

    await storage.setSyncState({
      historyId: updatedHistoryId,
      lastSyncTime: Date.now(),
      isSyncing: false,
      lastError: null,
    });

    result = {
      success: true,
      syncedCount,
      historyId: updatedHistoryId,
    };
  } catch (err) {
    result = await handleSyncError(err);
  } finally {
    isSyncRunning = false;
  }

  return result;
}

/**
 * Safety scan fallback (called every 30 minutes):
 * Queries recent unread INBOX messages to ensure nothing slipped past.
 */
export async function performSafetyScan(): Promise<SyncResult> {
  if (isSyncRunning) {
    return { success: false, syncedCount: 0, skipped: true };
  }
  isSyncRunning = true;

  const syncState = await storage.getSyncState();
  if (syncState.authState !== 'connected') {
    isSyncRunning = false;
    return { success: false, syncedCount: 0, error: 'Gmail is not connected' };
  }

  await storage.setSyncState({ isSyncing: true });

  let result: SyncResult;
  try {
    const listResponse = await gmailClient.listMessages({
      q: 'label:INBOX is:unread newer_than:2d',
      maxResults: 20,
    });

    const messages = listResponse.messages || [];
    let syncedCount = 0;

    if (messages.length > 0) {
      const ids = messages.map((m) => m.id);
      const records = await fetchAndNormalizeBatch(ids);
      if (records.length > 0) {
        // Sort chronologically ascending so earlier emails establish AttentionItems first
        records.sort((a, b) => (a.internalDate || 0) - (b.internalDate || 0));
        for (const record of records) {
          const changeAnalysis = await processEmailChange(record, db);
          await handleEmailAttentionPipeline(
            record,
            changeAnalysis,
            { isInitialSync: false },
            db
          );
        }
        syncedCount = records.length;
      }
    }

    // Run notification recovery as part of safety scan (Requirement 7)
    await reconcileNotifications(db);

    await storage.setSyncState({
      lastSafetyScanTime: Date.now(),
      isSyncing: false,
    });

    result = { success: true, syncedCount };
  } catch (err) {
    result = await handleSyncError(err);
  } finally {
    isSyncRunning = false;
  }

  return result;
}

/**
 * Unified error handler for sync operations.
 * Classifies auth, rate-limit, and network errors and records them into local state.
 */
async function handleSyncError(err: unknown): Promise<SyncResult> {
  const message = err instanceof Error ? err.message : String(err);
  console.error('[IGAM Sync] Error during synchronization:', message);

  if (err instanceof GmailAuthError) {
    await storage.setSyncState({
      authState: 'error',
      isSyncing: false,
      lastError: 'Gmail session expired or authorization revoked. Please reconnect.',
    });
    return { success: false, syncedCount: 0, error: 'Authentication expired' };
  }

  if (err instanceof GmailRateLimitError) {
    await storage.setSyncState({
      isSyncing: false,
      lastError: 'Gmail rate limit reached. Synchronization will retry shortly.',
    });
    return { success: false, syncedCount: 0, error: 'Rate limit exceeded' };
  }

  await storage.setSyncState({
    isSyncing: false,
    lastError: message,
  });

  return { success: false, syncedCount: 0, error: message };
}
