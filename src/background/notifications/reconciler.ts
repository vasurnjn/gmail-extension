/**
 * Phase 5E: Recovery, Reconciliation & Pipeline Integration
 *
 * Provides startup recovery, alarm reconciliation, missed alarm recovery,
 * snooze recovery, pipeline integration, and initial-sync storm protection.
 *
 * Core Guarantees:
 * 1. 100% Local-Only: Never modifies Gmail or makes external network calls.
 * 2. Zero In-Memory Dependency: Reconstructs state from Dexie + Chrome APIs.
 * 3. Never mutates factual analysis fields (category, importance, urgency, temporal, etc.).
 * 4. Strictly Idempotent: Repeated recovery runs do not spawn duplicate notifications.
 * 5. Full Account Isolation: Clears local state and alarms on disconnect/account switch.
 */

import { db, IGAMDatabase } from '../../db';
import {
  AttentionItem,
  EmailRecord,
  ScheduledAlarmRecord,
} from '../../shared/types';
import { storage } from '../../shared/storage';
import { EmailChangeAnalysis } from '../analysis/change';
import { MISSED_ALARM_GRACE_MS } from './constants';
import { evaluateAttentionEligibility } from './eligibility';
import {
  buildNotificationOptions,
  buildNotificationPayload,
  dispatchAttentionNotification,
  handleAlarm,
  registerScheduledAlarms,
} from './engine';
import {
  calculateProximityAlarms,
  isPhysicalVenue,
  parseAlarmName,
  resolvePrimaryTemporalTarget,
} from './scheduler';
import {
  PipelineNotificationResult,
  ReconciliationReport,
} from './types';

// =========================================================================
// 1. Helper: Chrome Alarms Query Wrapper
// =========================================================================

async function getChromeAlarms(): Promise<chrome.alarms.Alarm[]> {
  if (typeof chrome === 'undefined' || !chrome.alarms?.getAll) {
    return [];
  }
  return new Promise((resolve) => {
    chrome.alarms.getAll((alarms) => {
      resolve(alarms || []);
    });
  });
}

// =========================================================================
// 2. Alarm & Notification Reconciliation (Startup / Install / Safety Scan)
// =========================================================================

/**
 * Reconciles desired notification/alarm state from Dexie against Chrome runtime state.
 * Safe, deterministic, and idempotent against repeated runs.
 */
export async function reconcileNotifications(
  database: IGAMDatabase = db,
  referenceTime: number = Date.now()
): Promise<ReconciliationReport> {
  const report: ReconciliationReport = {
    recreatedAlarms: [],
    clearedOrphanAlarms: [],
    clearedInvalidAlarms: [],
    missedRemindersHandled: [],
    missedRemindersSuppressed: [],
    missedSnoozesHandled: [],
    errors: [],
  };

  try {
    const [attentionItems, dexieAlarms, allChromeAlarms] = await Promise.all([
      database.attentionItems.toArray(),
      database.scheduledAlarms.toArray(),
      getChromeAlarms(),
    ]);

    const itemsMap = new Map<string, AttentionItem>(
      attentionItems.map((item) => [item.id, item])
    );
    const dexieAlarmMap = new Map<string, ScheduledAlarmRecord>(
      dexieAlarms.map((alarm) => [alarm.alarmName, alarm])
    );

    // Map active snooze deadlines by itemId from snooze alarms
    const itemSnoozeMap = new Map<string, number>();
    for (const a of dexieAlarms) {
      const p = parseAlarmName(a.alarmName);
      if (p.type === 'snooze' && p.attentionItemId && p.snoozeUntil) {
        itemSnoozeMap.set(p.attentionItemId, p.snoozeUntil);
      }
    }

    // Filter Chrome alarms to our extension's notification alarms (`remind::` and `snooze::`)
    const extensionChromeAlarms = allChromeAlarms.filter(
      (a) => a.name.startsWith('remind::') || a.name.startsWith('snooze::')
    );
    const chromeAlarmMap = new Map<string, chrome.alarms.Alarm>(
      extensionChromeAlarms.map((a) => [a.name, a])
    );

    // -----------------------------------------------------------------------
    // Step A: Clear Orphan Chrome Alarms
    // -----------------------------------------------------------------------
    for (const ca of extensionChromeAlarms) {
      const parsed = parseAlarmName(ca.name);
      const isOrphan =
        parsed.type === 'unknown' ||
        !parsed.attentionItemId ||
        !itemsMap.has(parsed.attentionItemId) ||
        !dexieAlarmMap.has(ca.name);

      if (isOrphan) {
        if (typeof chrome !== 'undefined' && chrome.alarms?.clear) {
          chrome.alarms.clear(ca.name);
        }
        await database.scheduledAlarms.delete(ca.name);
        report.clearedOrphanAlarms.push(ca.name);
        chromeAlarmMap.delete(ca.name);
      }
    }

    // -----------------------------------------------------------------------
    // Step B: Snooze Expiration Recovery
    // -----------------------------------------------------------------------
    for (const item of attentionItems) {
      if (item.userAttentionState === 'snoozed') {
        let snoozeUntil = itemSnoozeMap.get(item.id);

        // Fallback to email record snoozeUntil if not found in alarm map
        if (!snoozeUntil && item.latestEmailId) {
          const email = await database.emails.get(item.latestEmailId);
          if (email?.snoozeUntil) {
            snoozeUntil = email.snoozeUntil;
          }
        }

        // If snoozeUntil has passed while service worker was sleeping/closed
        if (snoozeUntil && snoozeUntil <= referenceTime) {
          // Check real-world lifecycle state: must be active
          if (
            item.itemLifecycleState !== 'active' ||
            item.currentState.itemLifecycleState !== 'active'
          ) {
            // Inactive real-world lifecycle: purge snooze alarm without notifying
            const snoozeAlarmName = `snooze::${item.id}::${snoozeUntil}`;
            await database.scheduledAlarms.delete(snoozeAlarmName);
            if (typeof chrome !== 'undefined' && chrome.alarms?.clear) {
              chrome.alarms.clear(snoozeAlarmName);
            }
            continue;
          }

          // Transition: snoozed -> unhandled
          item.userAttentionState = 'unhandled';

          // Check delivery idempotency
          const deliveryKey = `notif::${item.id}::snooze_expired_${snoozeUntil}`;
          if (!item.notificationState) {
            item.notificationState = {
              lastNotifiedAt: null,
              lastNotificationType: null,
              lastNotificationSeverity: null,
              deliveredNotificationKeys: [],
              activeNotificationId: null,
            };
          }

          if (!item.notificationState.deliveredNotificationKeys.includes(deliveryKey)) {
            const payload = buildNotificationPayload(item, 'snooze_expired', 'high', null, {
              snoozeUntil,
            });
            const options = buildNotificationOptions(payload);

            if (typeof chrome !== 'undefined' && chrome.notifications?.create) {
              await new Promise<string>((resolve) => {
                chrome.notifications.create(payload.id, options, (id) =>
                  resolve(id || payload.id)
                );
              });
            }

            item.notificationState.deliveredNotificationKeys.push(deliveryKey);
            item.notificationState.lastNotifiedAt = referenceTime;
            item.notificationState.lastNotificationType = 'snooze_expired';
            item.notificationState.lastNotificationSeverity = 'high';
            item.notificationState.activeNotificationId = payload.id;
          }

          // Recalculate remaining valid proximity alarms for unhandled item
          const upcomingAlarms = calculateProximityAlarms({
            item,
            referenceTime,
          });
          await registerScheduledAlarms(upcomingAlarms, database);

          // Clean up the expired snooze alarm
          const snoozeAlarmName = `snooze::${item.id}::${snoozeUntil}`;
          await database.scheduledAlarms.delete(snoozeAlarmName);
          if (typeof chrome !== 'undefined' && chrome.alarms?.clear) {
            chrome.alarms.clear(snoozeAlarmName);
          }

          await database.attentionItems.put(item);
          report.missedSnoozesHandled.push(item.id);
        }
      }
    }

    // -----------------------------------------------------------------------
    // Step C: Validate and Reconcile Scheduled Alarms
    // -----------------------------------------------------------------------
    for (const alarm of dexieAlarms) {
      const parsedAlarm = parseAlarmName(alarm.alarmName);
      const itemId = alarm.attentionItemId || parsedAlarm.attentionItemId;
      const item = itemId ? itemsMap.get(itemId) : undefined;

      // 1. Missing AttentionItem
      if (!item) {
        await database.scheduledAlarms.delete(alarm.alarmName);
        if (typeof chrome !== 'undefined' && chrome.alarms?.clear) {
          chrome.alarms.clear(alarm.alarmName);
        }
        report.clearedInvalidAlarms.push(alarm.alarmName);
        continue;
      }

      // 2. Real-world lifecycle check: inactive lifecycles must have zero alarms
      if (
        item.itemLifecycleState !== 'active' ||
        item.currentState.itemLifecycleState !== 'active'
      ) {
        await database.scheduledAlarms.delete(alarm.alarmName);
        if (typeof chrome !== 'undefined' && chrome.alarms?.clear) {
          chrome.alarms.clear(alarm.alarmName);
        }
        report.clearedInvalidAlarms.push(alarm.alarmName);
        continue;
      }

      // 3. User attention check: handled or dismissed items must have zero alarms
      if (
        item.userAttentionState === 'handled' ||
        item.userAttentionState === 'dismissed'
      ) {
        await database.scheduledAlarms.delete(alarm.alarmName);
        if (typeof chrome !== 'undefined' && chrome.alarms?.clear) {
          chrome.alarms.clear(alarm.alarmName);
        }
        report.clearedInvalidAlarms.push(alarm.alarmName);
        continue;
      }

      // --- Proximity Reminders ---
      if (parsedAlarm.type === 'remind' && parsedAlarm.stage) {
        const stage = parsedAlarm.stage;
        const currentSnoozeUntil = itemSnoozeMap.get(item.id);

        // Deferral check if item is currently snoozed
        if (
          item.userAttentionState === 'snoozed' &&
          currentSnoozeUntil &&
          alarm.scheduledAt <= currentSnoozeUntil
        ) {
          await database.scheduledAlarms.delete(alarm.alarmName);
          if (typeof chrome !== 'undefined' && chrome.alarms?.clear) {
            chrome.alarms.clear(alarm.alarmName);
          }
          report.clearedInvalidAlarms.push(alarm.alarmName);
          continue;
        }

        // Temporal target validity check
        const target = resolvePrimaryTemporalTarget({ item, referenceTime });
        if (
          !target ||
          target.targetTimestamp <= referenceTime ||
          target.isAmbiguous ||
          target.confidence === 'LOW'
        ) {
          await database.scheduledAlarms.delete(alarm.alarmName);
          if (typeof chrome !== 'undefined' && chrome.alarms?.clear) {
            chrome.alarms.clear(alarm.alarmName);
          }
          report.clearedInvalidAlarms.push(alarm.alarmName);
          continue;
        }

        // 30m stage strict prerequisite check
        if (stage === '30m') {
          const isActionable = item.currentState.actionRequired === true;
          const isPhysical = isPhysicalVenue(target.venue, target.venueType);
          const isExactTime = target.timePrecision === 'exact';
          const isConfident = !target.isAmbiguous;
          const isUnhandled = item.userAttentionState === 'unhandled';

          if (
            target.targetType !== 'event' ||
            !isExactTime ||
            !isPhysical ||
            !isActionable ||
            !isConfident ||
            !isUnhandled
          ) {
            await database.scheduledAlarms.delete(alarm.alarmName);
            if (typeof chrome !== 'undefined' && chrome.alarms?.clear) {
              chrome.alarms.clear(alarm.alarmName);
            }
            report.clearedInvalidAlarms.push(alarm.alarmName);
            continue;
          }
        }

        // Check if alarm time already passed (missed alarm)
        if (alarm.scheduledAt <= referenceTime) {
          const deliveryKey = `notif::${item.id}::remind_${stage}`;
          const alreadyDelivered =
            item.notificationState?.deliveredNotificationKeys.includes(deliveryKey);

          if (alreadyDelivered) {
            // Already delivered prior to sleep
            await database.scheduledAlarms.delete(alarm.alarmName);
            if (typeof chrome !== 'undefined' && chrome.alarms?.clear) {
              chrome.alarms.clear(alarm.alarmName);
            }
            report.clearedInvalidAlarms.push(alarm.alarmName);
            continue;
          }

          // Stale evaluation: suppress if passed beyond grace period or event passed
          const isStale = referenceTime - alarm.scheduledAt > MISSED_ALARM_GRACE_MS;
          if (isStale) {
            await database.scheduledAlarms.delete(alarm.alarmName);
            if (typeof chrome !== 'undefined' && chrome.alarms?.clear) {
              chrome.alarms.clear(alarm.alarmName);
            }
            report.missedRemindersSuppressed.push(alarm.alarmName);
            continue;
          }

          // Passed within grace period and still valid: process through runtime engine
          const handled = await handleAlarm(alarm.alarmName, database, referenceTime);
          if (handled) {
            report.missedRemindersHandled.push(alarm.alarmName);
          } else {
            report.missedRemindersSuppressed.push(alarm.alarmName);
          }
          continue;
        }

        // Valid future alarm: check if missing in Chrome
        if (!chromeAlarmMap.has(alarm.alarmName)) {
          if (typeof chrome !== 'undefined' && chrome.alarms?.create) {
            chrome.alarms.create(alarm.alarmName, { when: alarm.scheduledAt });
          }
          report.recreatedAlarms.push(alarm.alarmName);
        }
      }

      // --- Snooze Alarms ---
      if (parsedAlarm.type === 'snooze') {
        if (item.userAttentionState !== 'snoozed') {
          await database.scheduledAlarms.delete(alarm.alarmName);
          if (typeof chrome !== 'undefined' && chrome.alarms?.clear) {
            chrome.alarms.clear(alarm.alarmName);
          }
          report.clearedInvalidAlarms.push(alarm.alarmName);
          continue;
        }

        // Valid future snooze alarm missing in Chrome
        if (alarm.scheduledAt > referenceTime && !chromeAlarmMap.has(alarm.alarmName)) {
          if (typeof chrome !== 'undefined' && chrome.alarms?.create) {
            chrome.alarms.create(alarm.alarmName, { when: alarm.scheduledAt });
          }
          report.recreatedAlarms.push(alarm.alarmName);
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    report.errors.push(msg);
    console.error('[IGAM Reconciler] Reconciliation error:', err);
  }

  return report;
}

// =========================================================================
// 3. Account Isolation: Complete Alarm & Notification State Wipe
// =========================================================================

/**
 * Clears all scheduled alarms and active notifications for account disconnect or switch.
 * Ensures zero cross-account notification or alarm pollution.
 */
export async function clearAllAccountNotificationsAndAlarms(
  database: IGAMDatabase = db
): Promise<void> {
  try {
    // 1. Clear Dexie scheduledAlarms
    await database.scheduledAlarms.clear();

    // 2. Clear all Chrome alarms matching remind::* or snooze::*
    if (typeof chrome !== 'undefined' && chrome.alarms?.getAll) {
      const allAlarms = await new Promise<chrome.alarms.Alarm[]>((resolve) => {
        chrome.alarms.getAll((alarms) => resolve(alarms || []));
      });

      for (const a of allAlarms) {
        if (a.name.startsWith('remind::') || a.name.startsWith('snooze::')) {
          chrome.alarms.clear(a.name);
        }
      }
    }

    // 3. Clear all active desktop notifications matching notif::*
    if (typeof chrome !== 'undefined' && chrome.notifications?.getAll) {
      chrome.notifications.getAll((notifs) => {
        if (notifs) {
          Object.keys(notifs).forEach((id) => {
            if (id.startsWith('notif::')) {
              chrome.notifications.clear(id);
            }
          });
        }
      });
    }
  } catch (err) {
    console.warn('[IGAM Reconciler] Error clearing account alarms and notifications:', err);
  }
}

// =========================================================================
// 4. Pipeline Integration: Attention Decision & Notification Flow
// =========================================================================

/**
 * Connects the email sync/analysis pipeline to the attention eligibility and notification engine.
 *
 * Guarantees:
 * - NEW: Dispatches desktop notification if eligible, schedules future alarms.
 * - REPEAT: Strictly suppressed. No notification. No user attention reset.
 * - UPDATE: Notifies only if Phase 4 materiality criteria are satisfied.
 * - CONFLICT: Uses existing conflict notification behavior.
 * - CANCELLED: Uses existing cancellation notification behavior.
 * - Initial Sync: Suppresses individual popup notifications while still calculating
 *   eligibility, persisting AttentionItems, and scheduling valid future alarms.
 */
export async function handleEmailAttentionPipeline(
  email: EmailRecord,
  changeAnalysis: EmailChangeAnalysis,
  options?: {
    isInitialSync?: boolean;
    referenceTime?: number;
  },
  database: IGAMDatabase = db
): Promise<PipelineNotificationResult> {
  const settings = await storage.getSettings().catch(() => undefined);
  const categories = await storage.getCategories().catch(() => undefined);
  const categoryConfig = categories?.find((c) => c.id === email.category);

  // 1. Evaluate pure deterministic attention eligibility
  const decision = evaluateAttentionEligibility({
    item: changeAnalysis.item,
    email,
    changeResult: changeAnalysis.result,
    settings,
    categoryConfig,
    referenceTime: options?.referenceTime,
  });

  const isEligible = decision.shouldNotify && decision.severity !== 'silent';
  const isInitialSync = options?.isInitialSync === true;

  // 2. Initial Sync Storm Protection:
  // Suppress individual popup notifications during bulk initial sync,
  // but persist AttentionItems and schedule valid future proximity alarms.
  if (isInitialSync) {
    let alarmsScheduled = 0;
    if (
      changeAnalysis.result.relation === 'NEW' ||
      changeAnalysis.result.relation === 'UPDATE'
    ) {
      const alarms = calculateProximityAlarms({
        item: changeAnalysis.item,
        email,
        referenceTime: options?.referenceTime ?? Date.now(),
      });
      await registerScheduledAlarms(alarms, database);
      alarmsScheduled = alarms.length;
    }

    return {
      eligible: isEligible,
      decision,
      dispatchResult: null,
      alarmsScheduled,
    };
  }

  // 3. Normal Live / Incremental Sync Notification Flow:
  const dispatchResult = await dispatchAttentionNotification(
    {
      item: changeAnalysis.item,
      decision,
      email,
      referenceTime: options?.referenceTime,
    },
    database
  );

  return {
    eligible: isEligible,
    decision,
    dispatchResult,
    alarmsScheduled: 0, // Scheduled inside dispatchAttentionNotification for NEW/UPDATE
  };
}

// =========================================================================
// 5. Initial Sync Aggregate Summary Notification
// =========================================================================

/**
 * Dispatches at most ONE aggregate summary notification after initial sync completes,
 * summarizing newly discovered attention-worthy items without notification storms.
 */
export async function dispatchInitialSyncSummaryNotification(
  eligibleCount: number
): Promise<void> {
  if (eligibleCount <= 0) return;

  const notifId = 'notif::initial_sync_summary';
  const iconUrl =
    typeof chrome !== 'undefined' && chrome.runtime?.getURL
      ? chrome.runtime.getURL('icons/icon128.png')
      : 'icons/icon128.png';

  const itemPlural = eligibleCount === 1 ? 'item' : 'items';
  const verb = eligibleCount === 1 ? 'requires' : 'require';

  const options: chrome.notifications.NotificationCreateOptions = {
    type: 'basic',
    iconUrl,
    title: 'Gmail Attention Manager',
    message: `${eligibleCount} actionable ${itemPlural} ${verb} attention in your inbox.`,
    priority: 1,
    buttons: [{ title: '🔍 Review in Dashboard' }],
  };

  if (typeof chrome !== 'undefined' && chrome.notifications?.create) {
    await new Promise<string>((resolve) => {
      chrome.notifications.create(notifId, options, (id) => resolve(id || notifId));
    });
  }
}
