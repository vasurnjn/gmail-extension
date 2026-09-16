import { db } from '../db';
import {
  ALARM_GMAIL_POLL,
  ALARM_SAFETY_SCAN,
  DEFAULT_POLL_INTERVAL_MINUTES,
  DEFAULT_SAFETY_SCAN_INTERVAL_MINUTES,
} from '../shared/constants';
import { storage } from '../shared/storage';
import {
  checkGmailAuthStatus,
  connectGmail,
  disconnectGmail,
  getAvailableAccounts,
  switchAccount,
} from './gmail/auth';
import {
  bulkMarkHandled,
  calculateProximityAlarms,
  calculateSnoozeAlarm,
  clearItemAlarms,
  DEFAULT_SNOOZE_MS,
  handleAlarm,
  handleNotificationButtonClicked,
  handleNotificationClicked,
  reconcileNotifications,
  registerScheduledAlarms,
} from './notifications';
import {
  performIncrementalSync,
  performInitialSync,
  performSafetyScan,
  reclassifyStoredEmails,
} from './gmail/sync';

console.log('[IGAM] Service worker starting up...');

// Reconcile and recover notifications on service worker startup (Requirement 1 & 8)
reconcileNotifications(db).catch((err) =>
  console.warn('[IGAM] Startup reconciliation error:', err)
);

// Reclassify any existing local emails that were stored before Phase 1C
reclassifyStoredEmails().catch((err) => console.warn('[IGAM] Startup reclassify error:', err));

/**
 * Top-level listener registration required by Manifest V3 service workers.
 * Must be executed synchronously during initial script evaluation.
 */

// 1. Extension lifecycle: onInstalled
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[IGAM] Extension installed/updated. Reason:', details.reason);

  try {
    // Ensure default settings & categories exist in storage
    await storage.getSettings();
    await storage.getCategories();
    await storage.getSyncState();

    // Setup periodic polling alarms
    chrome.alarms.create(ALARM_GMAIL_POLL, {
      periodInMinutes: DEFAULT_POLL_INTERVAL_MINUTES,
      delayInMinutes: 1, // Start 1 min after installation
    });

    chrome.alarms.create(ALARM_SAFETY_SCAN, {
      periodInMinutes: DEFAULT_SAFETY_SCAN_INTERVAL_MINUTES,
      delayInMinutes: DEFAULT_SAFETY_SCAN_INTERVAL_MINUTES,
    });

    // Reconcile and recover notifications upon install or update
    await reconcileNotifications(db);

    console.log('[IGAM] Alarms registered successfully.');
  } catch (err) {
    console.error('[IGAM] Error during onInstalled initialization:', err);
  }
});

// 2. Periodic alarms: onAlarm
chrome.alarms.onAlarm.addListener(async (alarm) => {
  console.log(`[IGAM] Alarm triggered: ${alarm.name} at ${new Date().toISOString()}`);

  const syncState = await storage.getSyncState();

  if (alarm.name === ALARM_GMAIL_POLL) {
    await storage.setSyncState({ lastPollTime: Date.now() });

    // Only run sync if user is connected
    if (syncState.authState === 'connected') {
      console.log('[IGAM] Executing incremental sync...');
      await performIncrementalSync();
    } else {
      console.log('[IGAM] Polling heartbeat (not connected).');
    }
  } else if (alarm.name === ALARM_SAFETY_SCAN) {
    await storage.setSyncState({ lastSafetyScanTime: Date.now() });

    if (syncState.authState === 'connected') {
      console.log('[IGAM] Executing safety scan...');
      await performSafetyScan();
    } else {
      console.log('[IGAM] Safety scan heartbeat (not connected).');
    }
  } else {
    // Attention engine alarms (reminders, snooze expiration)
    await handleAlarm(alarm.name);
  }
});

// 3. Notification interactions: onButtonClicked
chrome.notifications.onButtonClicked.addListener(async (notificationId, buttonIndex) => {
  console.log(`[IGAM] Notification button clicked. ID: ${notificationId}, Button: ${buttonIndex}`);
  await handleNotificationButtonClicked(notificationId, buttonIndex);
});

// 4. Notification interactions: onClicked (body click)
chrome.notifications.onClicked.addListener(async (notificationId) => {
  console.log(`[IGAM] Notification body clicked. ID: ${notificationId}`);
  await handleNotificationClicked(notificationId);
});

// 5. Message dispatcher for Popup / Sidepanel UI
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;

  const { type } = message as { type: string; [key: string]: unknown };

  switch (type) {
    case 'PING':
      sendResponse({ status: 'pong', timestamp: Date.now() });
      break;

    case 'OPEN_SIDE_PANEL':
      if (chrome.sidePanel && sender.tab?.windowId) {
        chrome.sidePanel.open({ windowId: sender.tab.windowId });
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, reason: 'sidePanel API not available or no windowId' });
      }
      break;

    case 'CONNECT_GMAIL':
      connectGmail(true)
        .then(async (result) => {
          if (result.success) {
            // Kick off initial sync immediately after successful connection
            performInitialSync().catch((err) => console.warn('[IGAM] Initial sync error:', err));
          }
          sendResponse(result);
        })
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true; // async sendResponse

    case 'DISCONNECT_GMAIL':
      disconnectGmail()
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true; // async sendResponse

    case 'SWITCH_ACCOUNT':
      switchAccount(typeof message.accountId === 'string' ? message.accountId : undefined)
        .then(async (result) => {
          if (result.success) {
            performInitialSync().catch((err) =>
              console.warn('[IGAM] Initial sync after switch error:', err)
            );
          }
          sendResponse(result);
        })
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true; // async sendResponse

    case 'GET_AVAILABLE_ACCOUNTS':
      getAvailableAccounts()
        .then((accounts) => sendResponse({ success: true, accounts }))
        .catch((err) => sendResponse({ success: false, accounts: [], error: err.message }));
      return true; // async sendResponse

    case 'GET_AUTH_STATUS':
      checkGmailAuthStatus()
        .then((state) => sendResponse(state))
        .catch((err) => sendResponse({ error: err.message }));
      return true; // async sendResponse

    case 'SYNC_NOW':
      (async () => {
        const state = await storage.getSyncState();
        if (state.authState !== 'connected') {
          return { success: false, error: 'Gmail is not connected' };
        }
        if (!state.historyId) {
          return performInitialSync();
        }
        return performIncrementalSync();
      })()
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true; // async sendResponse

    case 'GET_SYNC_STATUS':
      (async () => {
        const state = await storage.getSyncState();
        const emailCount = await db.emails.count();
        return { syncState: state, emailCount };
      })()
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ error: err.message }));
      return true; // async sendResponse

    case 'GET_EMAILS':
      (async () => {
        const limit = typeof message.limit === 'number' ? message.limit : 50;
        const emails = await db.emails.orderBy('internalDate').reverse().limit(limit).toArray();
        return emails;
      })()
        .then((emails) => sendResponse({ success: true, emails }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true; // async sendResponse

    case 'SET_ATTENTION_STATE':
      (async () => {
        const { attentionItemId, emailId, action, snoozeUntil } = message as {
          attentionItemId?: string;
          emailId?: string;
          action: 'mark_handled' | 'snooze' | 'dismiss' | 'reopen';
          snoozeUntil?: number;
        };

        const targetItem = attentionItemId ? await db.attentionItems.get(attentionItemId) : null;
        const targetEmail = emailId ? await db.emails.get(emailId) : null;

        // Persist account-scoped attention decision across reconnects
        const syncState = await storage.getSyncState().catch(() => null);
        if (syncState?.accountEmail && (action === 'mark_handled' || action === 'dismiss' || action === 'reopen')) {
          const ids = new Set<string>();
          if (targetEmail?.id) ids.add(targetEmail.id);
          if (targetItem?.latestEmailId) ids.add(targetItem.latestEmailId);
          if (targetItem?.messageIds) {
            for (const mId of targetItem.messageIds) ids.add(mId);
          }
          const stateToRecord =
            action === 'mark_handled'
              ? 'handled'
              : action === 'dismiss'
              ? 'dismissed'
              : 'unhandled';
          await storage.recordAccountAttentionDecision(
            syncState.accountEmail,
            Array.from(ids),
            stateToRecord
          );
        }

        if (action === 'mark_handled') {
          if (targetItem) {
            targetItem.userAttentionState = 'handled';
            if (targetItem.notificationState?.activeNotificationId) {
              if (typeof chrome !== 'undefined' && chrome.notifications?.clear) {
                chrome.notifications.clear(targetItem.notificationState.activeNotificationId);
              }
              targetItem.notificationState.activeNotificationId = null;
            }
            await clearItemAlarms(targetItem.id, db);
            await db.attentionItems.put(targetItem);
          }
          if (targetEmail) {
            await db.emails.update(targetEmail.id, {
              alertStatus: 'handled',
              handledAt: Date.now(),
            });
            await db.userFeedback.add({
              emailId: targetEmail.id,
              timestamp: Date.now(),
              action: 'handled',
              category: targetEmail.category,
              importanceScoreAtTime: targetEmail.importanceScore,
            });
          }
          return { success: true };
        }

        if (action === 'snooze') {
          const until = snoozeUntil || Date.now() + DEFAULT_SNOOZE_MS;
          if (targetItem) {
            targetItem.userAttentionState = 'snoozed';
            if (targetItem.notificationState?.activeNotificationId) {
              if (typeof chrome !== 'undefined' && chrome.notifications?.clear) {
                chrome.notifications.clear(targetItem.notificationState.activeNotificationId);
              }
              targetItem.notificationState.activeNotificationId = null;
            }
            // Purge proximity alarms occurring before snoozeUntil
            const existingAlarms = await db.scheduledAlarms
              .where('attentionItemId')
              .equals(targetItem.id)
              .toArray();
            for (const a of existingAlarms) {
              if (a.scheduledAt <= until) {
                if (typeof chrome !== 'undefined' && chrome.alarms?.clear) {
                  chrome.alarms.clear(a.alarmName);
                }
                await db.scheduledAlarms.delete(a.alarmName);
              }
            }
            const snoozeAlarm = calculateSnoozeAlarm({
              item: targetItem,
              snoozeUntil: until,
              referenceTime: Date.now(),
            });
            if (snoozeAlarm) {
              await db.scheduledAlarms.put(snoozeAlarm);
              if (typeof chrome !== 'undefined' && chrome.alarms?.create) {
                chrome.alarms.create(snoozeAlarm.alarmName, { when: snoozeAlarm.scheduledAt });
              }
            }
            await db.attentionItems.put(targetItem);
          }
          if (targetEmail) {
            await db.emails.update(targetEmail.id, {
              alertStatus: 'snoozed',
              snoozeUntil: until,
            });
            await db.userFeedback.add({
              emailId: targetEmail.id,
              timestamp: Date.now(),
              action: 'snoozed',
              category: targetEmail.category,
              importanceScoreAtTime: targetEmail.importanceScore,
            });
          }
          return { success: true };
        }

        if (action === 'dismiss') {
          if (targetItem) {
            targetItem.userAttentionState = 'dismissed';
            if (targetItem.notificationState?.activeNotificationId) {
              if (typeof chrome !== 'undefined' && chrome.notifications?.clear) {
                chrome.notifications.clear(targetItem.notificationState.activeNotificationId);
              }
              targetItem.notificationState.activeNotificationId = null;
            }
            await clearItemAlarms(targetItem.id, db);
            await db.attentionItems.put(targetItem);
          }
          if (targetEmail) {
            await db.emails.update(targetEmail.id, {
              alertStatus: 'dismissed',
            });
            await db.userFeedback.add({
              emailId: targetEmail.id,
              timestamp: Date.now(),
              action: 'dismissed',
              category: targetEmail.category,
              importanceScoreAtTime: targetEmail.importanceScore,
            });
          }
          return { success: true };
        }

        if (action === 'reopen') {
          if (targetItem) {
            targetItem.userAttentionState = 'unhandled';
            const alarms = calculateProximityAlarms({
              item: targetItem,
              referenceTime: Date.now(),
            });
            await registerScheduledAlarms(alarms, db);
            await db.attentionItems.put(targetItem);
          }
          if (targetEmail) {
            await db.emails.update(targetEmail.id, {
              alertStatus: 'pending',
              snoozeUntil: null,
              handledAt: null,
            });
          }
          return { success: true };
        }

        return { success: false, error: `Unknown attention action: ${action}` };
      })()
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true; // async sendResponse

    case 'BULK_MARK_HANDLED':
      bulkMarkHandled(db, Array.isArray(message.itemIds) ? message.itemIds : undefined)
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true; // async sendResponse

    default:
      // Unknown message type
      sendResponse({ error: `Unknown message type: ${type}` });
      break;
  }

  return true;
});
