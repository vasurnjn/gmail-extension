/**
 * Phase 5D: Chrome Notifications & Alarms Runtime Integration
 *
 * Provides isolated runtime handling for Chrome Notifications and Chrome Alarms.
 *
 * Core Guarantees:
 * 1. 100% Local-Only: Never modifies Gmail or makes external network calls.
 * 2. Strict Idempotency: Deduplicates notifications via stored delivery keys in Dexie.
 * 3. Never mutates factual analysis fields (category, importance, urgency, temporal, etc.).
 * 4. Suppresses notifications for handled, dismissed, cancelled, or snoozed items appropriately.
 */

import { db, IGAMDatabase } from '../../db';
import {
  AttentionItem,
  EmailRecord,
  NotificationSeverity,
  NotificationType,
  ScheduledAlarmRecord,
} from '../../shared/types';
import { storage } from '../../shared/storage';
import {
  DEFAULT_SNOOZE_MS,
  PROXIMITY_STAGE_CONFIGS,
} from './constants';
import {
  calculateProximityAlarms,
  calculateSnoozeAlarm,
  isPhysicalVenue,
  parseAlarmName,
  resolvePrimaryTemporalTarget,
} from './scheduler';
import {
  NotificationButtonConfig,
  NotificationDispatchInput,
  NotificationDispatchResult,
  NotificationPayload,
  ProximityStage,
} from './types';

// =========================================================================
// 1. Notification Content & Option Builders
// =========================================================================

function capitalizeWords(str: string): string {
  return str
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

export function cleanSubject(subject?: string | null): string | null {
  if (!subject) return null;
  const cleaned = subject
    .replace(/^(\s*(?:re|fwd|fw|urgent|important|alert|reminder)\s*:\s*)+/i, '')
    .replace(/^\[(?:urgent|important|action required|notice|reminder|update|fwd|re)[^\]]*\]\s*/i, '')
    .trim();
  return cleaned || null;
}

export function getNotificationActionPhrase(
  item: AttentionItem,
  email?: EmailRecord | null
): string | null {
  // 1. Check active subEvents on item
  const activeSubEvent = item.currentState?.subEvents?.find(
    (se) => se.status === 'active' && se.label && se.label.trim().length > 0
  );
  if (activeSubEvent?.label) {
    return activeSubEvent.label.trim();
  }

  // 2. Check temporal analysis in email
  if (email?.temporalAnalysis) {
    const event = email.temporalAnalysis.primaryEvent;
    const deadline = email.temporalAnalysis.primaryDeadline;
    if (event?.contextSnippet && event.contextSnippet.trim().length > 0 && event.contextSnippet.length <= 40) {
      return capitalizeWords(event.contextSnippet.trim());
    }
    if (deadline?.contextSnippet && deadline.contextSnippet.trim().length > 0 && deadline.contextSnippet.length <= 40) {
      return capitalizeWords(deadline.contextSnippet.trim());
    }
  }

  // 3. Check actionType on currentState
  if (item.currentState?.actionType) {
    switch (item.currentState.actionType) {
      case 'attend':
        return 'Interview / Meeting';
      case 'submit':
        return 'Submission Deadline';
      case 'register':
        return 'Registration';
      case 'apply':
        return 'Application Deadline';
      case 'pay':
        return 'Fee Payment';
      case 'confirm':
        return 'Confirmation';
      case 'review':
        return 'Review Required';
      case 'reply':
        return 'Response Required';
      case 'other':
        return 'Action Required';
    }
  }

  // 4. Check topicScope
  if (item.topicScope && item.topicScope !== 'general' && item.topicScope !== 'unknown') {
    return capitalizeWords(item.topicScope.replace(/_/g, ' '));
  }

  return null;
}

export function resolveNotificationEntityLabel(
  item: AttentionItem,
  email?: EmailRecord | null
): string {
  if (item.canonicalEntity && item.canonicalEntity.trim().length > 0) {
    return capitalizeWords(item.canonicalEntity.trim());
  }
  const cleanSub = cleanSubject(email?.subject);
  if (cleanSub) {
    return cleanSub.length > 45 ? cleanSub.slice(0, 42) + '...' : cleanSub;
  }
  if (item.topicScope && item.topicScope !== 'general' && item.topicScope !== 'unknown') {
    return capitalizeWords(item.topicScope.replace(/_/g, ' '));
  }
  return capitalizeWords(item.category.replace(/_/g, ' '));
}

export function formatNotificationTiming(
  timestamp: number | null | undefined,
  timePrecision: 'exact' | 'date_only' | 'inferred' | 'unknown' = 'exact',
  referenceTime: number = Date.now()
): string | null {
  if (!timestamp) return null;
  try {
    const target = new Date(timestamp);
    const now = new Date(referenceTime);

    const isToday =
      target.getFullYear() === now.getFullYear() &&
      target.getMonth() === now.getMonth() &&
      target.getDate() === now.getDate();

    const tomorrow = new Date(referenceTime + 24 * 60 * 60 * 1000);
    const isTomorrow =
      target.getFullYear() === tomorrow.getFullYear() &&
      target.getMonth() === tomorrow.getMonth() &&
      target.getDate() === tomorrow.getDate();

    let dayStr: string;
    if (isToday) {
      dayStr = 'today';
    } else if (isTomorrow) {
      dayStr = 'tomorrow';
    } else {
      dayStr = target.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }

    if (timePrecision === 'unknown' || timePrecision === 'date_only') {
      return isToday || isTomorrow ? dayStr : `on ${dayStr}`;
    }

    const timeStr = target.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });

    if (isToday || isTomorrow) {
      return `${dayStr} at ${timeStr}`;
    }
    return `on ${dayStr} at ${timeStr}`;
  } catch {
    return null;
  }
}

/**
 * Constructs a structured NotificationPayload for any notification type.
 */
export function buildNotificationPayload(
  item: AttentionItem,
  notificationType: NotificationType,
  severity: NotificationSeverity,
  email?: EmailRecord | null,
  options?: {
    stage?: ProximityStage | null;
    snoozeUntil?: number | null;
    materialFields?: string[];
    customMessage?: string;
  }
): NotificationPayload {
  const entityLabel = resolveNotificationEntityLabel(item, email);
  const actionPhrase = getNotificationActionPhrase(item, email);

  // Combine entity and action into a descriptive label if distinct
  let eventLabel = entityLabel;
  if (actionPhrase) {
    if (entityLabel.toLowerCase().includes(actionPhrase.toLowerCase())) {
      eventLabel = entityLabel;
    } else if (actionPhrase.toLowerCase().includes(entityLabel.toLowerCase())) {
      eventLabel = actionPhrase;
    } else {
      eventLabel = `${entityLabel} - ${actionPhrase}`;
    }
  }

  // Derive timePrecision
  let precision: 'exact' | 'date_only' | 'inferred' | 'unknown' = 'exact';
  const targetSubEvent = item.currentState?.subEvents?.find(
    (se) =>
      se.timestamp === item.currentState.primaryEventTimestamp ||
      se.timestamp === item.currentState.primaryDeadlineTimestamp
  );
  if (targetSubEvent?.timePrecision) {
    precision = targetSubEvent.timePrecision;
  } else if (email?.temporalAnalysis?.primaryEvent?.timePrecision) {
    precision = email.temporalAnalysis.primaryEvent.timePrecision;
  } else if (email?.temporalAnalysis?.primaryDeadline?.timePrecision) {
    precision = email.temporalAnalysis.primaryDeadline.timePrecision;
  }

  const venueStr = item.currentState?.venue ? `@ ${item.currentState.venue}` : '';
  const timeFormatted = formatNotificationTiming(
    item.currentState?.primaryEventTimestamp ??
      item.currentState?.primaryDeadlineTimestamp,
    precision
  );
  const timeStr = timeFormatted ? (timeFormatted.startsWith('on ') ? timeFormatted : `${timeFormatted}`) : '';

  let id = `notif::${item.id}::${notificationType}`;
  let title = '';
  let message = '';
  let buttons: NotificationButtonConfig[] = [
    { title: '✓ Mark Handled', action: 'mark_handled' },
    { title: '⏰ Snooze (1 hr)', action: 'snooze' },
  ];

  switch (notificationType) {
    case 'new': {
      id = `notif::${item.id}::new`;
      const prefix =
        severity === 'critical'
          ? '🚨 [URGENT]'
          : severity === 'high'
          ? '⚠️ [IMPORTANT]'
          : '📌 [ATTENTION]';
      const subject = email?.subject && !eventLabel.includes(email.subject) ? `: ${email.subject}` : '';
      title = `${prefix} ${eventLabel}${subject}`.slice(0, 120);
      const actionDesc = actionPhrase ? capitalizeWords(actionPhrase) : 'Engagement';
      message =
        options?.customMessage ||
        (timeStr || venueStr
          ? `${actionDesc} scheduled ${timeStr} ${venueStr}`.trim()
          : item.topicScope
          ? `Regarding ${item.topicScope.replace(/_/g, ' ')}`
          : 'Action required on campus communication');
      break;
    }

    case 'update': {
      const materialSuffix = options?.materialFields?.length
        ? options.materialFields.sort().join('_')
        : 'general';
      id = `notif::${item.id}::update_${materialSuffix}_${email?.id ?? Date.now()}`;
      title = `⚠️ [RESCHEDULED] ${eventLabel}: Details Updated`.slice(0, 120);
      message =
        options?.customMessage ||
        (venueStr || timeStr
          ? `Updated ${timeStr} ${venueStr}`.trim()
          : 'Factual schedule update received. Verification required.');
      break;
    }

    case 'conflict': {
      id = `notif::${item.id}::conflict_${email?.id ?? Date.now()}`;
      title = `🚨 [CONFLICT] ${eventLabel}: Contradictory Information`.slice(0, 120);
      message =
        options?.customMessage ||
        'Subject and announcement body specify conflicting dates, times, or roles. Manual review required.';
      buttons = [
        { title: '🔍 Review in Dashboard', action: 'open_dashboard' },
        { title: 'Dismiss', action: 'dismiss' },
      ];
      break;
    }

    case 'cancellation': {
      id = `notif::${item.id}::cancelled`;
      title = `⚠️ [CANCELLED] ${eventLabel}: Engagement Cancelled`.slice(0, 120);
      message =
        options?.customMessage ||
        'The scheduled recruitment, exam, or process has been cancelled by the company or organizer.';
      buttons = [{ title: 'Dismiss', action: 'dismiss' }];
      break;
    }

    case 'reminder': {
      const stage = options?.stage ?? '24h';
      id = `notif::${item.id}::remind_${stage}`;
      const eventName = actionPhrase || 'Event';

      if (stage === '30m') {
        title = `🚨 [STARTING SOON] ${eventLabel}: Starting in 30 minutes`.slice(0, 120);
        message = isPhysicalVenue(item.currentState?.venue)
          ? `In-person ${eventName.toLowerCase()} is starting in 30 minutes ${venueStr}. Please arrive at the venue immediately.`.trim()
          : `${eventName} is starting in 30 minutes ${venueStr}. Please prepare to join.`.trim();
      } else if (stage === '3h') {
        title = `🚨 [FINAL CALL] ${eventLabel}: Starting in 3 hours`.slice(0, 120);
        message = `Scheduled ${eventName.toLowerCase()} begins in 3 hours ${venueStr}.`.trim();
      } else if (stage === '24h') {
        title = `📌 [REMINDER - 24h] ${eventLabel}: Scheduled Tomorrow`.slice(0, 120);
        message = timeStr || venueStr
          ? `Upcoming ${eventName.toLowerCase()} scheduled ${timeStr} ${venueStr}`.trim()
          : `Upcoming ${eventName.toLowerCase()} scheduled tomorrow.`;
      } else {
        title = `⚠️ [REMINDER - 48h] ${eventLabel}: Upcoming in 2 days`.slice(0, 120);
        message = timeStr || venueStr
          ? `Upcoming ${eventName.toLowerCase()} scheduled ${timeStr} ${venueStr}`.trim()
          : `Upcoming ${eventName.toLowerCase()} scheduled in 2 days.`;
      }
      break;
    }

    case 'snooze_expired': {
      const ts = options?.snoozeUntil ?? Date.now();
      id = `notif::${item.id}::snooze_expired_${ts}`;
      title = `⏰ [SNOOZE EXPIRED] ${eventLabel}: Reminder Resumed`.slice(0, 120);
      message =
        options?.customMessage ||
        `Snooze period has expired for this item ${venueStr}. Please review or take required action.`.trim();
      break;
    }
  }

  // Priority mapping: critical = 2, high = 1, standard = 0, silent = -1
  const priority =
    severity === 'critical' ? 2 : severity === 'high' ? 1 : severity === 'standard' ? 0 : -1;
  const requireInteraction = severity === 'critical';

  return {
    id,
    attentionItemId: item.id,
    title,
    message,
    priority,
    requireInteraction,
    buttons,
    severity,
    notificationType,
  };
}

/**
 * Converts a NotificationPayload into Chrome Notifications API options.
 */
export function buildNotificationOptions(
  payload: NotificationPayload
): chrome.notifications.NotificationCreateOptions {
  const iconUrl =
    typeof chrome !== 'undefined' && chrome.runtime?.getURL
      ? chrome.runtime.getURL('icons/icon128.png')
      : 'icons/icon128.png';

  return {
    type: 'basic',
    iconUrl,
    title: payload.title,
    message: payload.message,
    priority: payload.priority,
    requireInteraction: payload.requireInteraction,
    buttons: payload.buttons.map((b) => ({ title: b.title })),
    silent: payload.severity === 'silent',
  };
}

// =========================================================================
// 2. Direct Notification Dispatcher
// =========================================================================

/**
 * Dispatches an active desktop notification for an AttentionItem based on an eligibility decision.
 * Idempotent: Skips if delivery key was already recorded in Dexie.
 */
export function dispatchAttentionNotification(
  input: NotificationDispatchInput,
  database: IGAMDatabase = db
): Promise<NotificationDispatchResult> {
  const { item, decision, email } = input;

  return (async () => {
    // 1. Check shouldNotify
    if (!decision.shouldNotify || decision.severity === 'silent') {
      return {
        delivered: false,
        notificationId: null,
        reason: decision.reason || 'Decision marked silent or shouldNotify false',
      };
    }

    const notifType = decision.notificationType ?? 'new';

    // 2. Check Idempotency Key
    if (!item.notificationState) {
      item.notificationState = {
        lastNotifiedAt: null,
        lastNotificationType: null,
        lastNotificationSeverity: null,
        deliveredNotificationKeys: [],
        activeNotificationId: null,
      };
    }

    const idempotencyKey = decision.idempotencyKey;
    if (
      idempotencyKey &&
      item.notificationState.deliveredNotificationKeys.includes(idempotencyKey)
    ) {
      return {
        delivered: false,
        notificationId: null,
        reason: 'Notification already delivered (idempotency key match)',
      };
    }

    // 3. Special handling for cancellation: purge alarms and clear previous notification
    if (notifType === 'cancellation') {
      await clearItemAlarms(item.id, database);
      if (
        item.notificationState.activeNotificationId &&
        typeof chrome !== 'undefined' &&
        chrome.notifications?.clear
      ) {
        chrome.notifications.clear(item.notificationState.activeNotificationId);
      }
    }

    // 4. Build Notification Payload
    const payload = buildNotificationPayload(item, notifType, decision.severity, email);
    const options = buildNotificationOptions(payload);

    // 5. Create Desktop Notification in Chrome
    if (typeof chrome !== 'undefined' && chrome.notifications?.create) {
      await new Promise<string>((resolve) => {
        chrome.notifications.create(payload.id, options, (id) => {
          resolve(id || payload.id);
        });
      });
    }

    // 6. Persist Delivery Audit in Dexie
    if (idempotencyKey) {
      item.notificationState.deliveredNotificationKeys.push(idempotencyKey);
    }
    item.notificationState.lastNotifiedAt = Date.now();
    item.notificationState.lastNotificationType = notifType;
    item.notificationState.lastNotificationSeverity = decision.severity;
    item.notificationState.activeNotificationId = payload.id;

    await database.attentionItems.put(item);

    // 7. Calculate and Register Proximity Alarms for NEW or UPDATE
    if (notifType === 'new' || notifType === 'update') {
      const alarms = calculateProximityAlarms({
        item,
        email,
        referenceTime: input.referenceTime ?? Date.now(),
      });
      await registerScheduledAlarms(alarms, database);
    }

    return {
      delivered: true,
      notificationId: payload.id,
      reason: 'Notification successfully delivered',
    };
  })();
}

// =========================================================================
// 3. Chrome Alarms Registration & Cleanup Helpers
// =========================================================================

/**
 * Persists calculated alarms to Dexie and registers them with chrome.alarms.
 */
export async function registerScheduledAlarms(
  alarms: ScheduledAlarmRecord[],
  database: IGAMDatabase = db
): Promise<void> {
  if (!alarms || alarms.length === 0) return;

  for (const alarm of alarms) {
    // Persist in Dexie
    await database.scheduledAlarms.put(alarm);

    // Register with chrome.alarms
    if (typeof chrome !== 'undefined' && chrome.alarms?.create) {
      chrome.alarms.create(alarm.alarmName, { when: alarm.scheduledAt });
    }
  }
}

/**
 * Clears all pending alarms for an AttentionItem from both Dexie and chrome.alarms.
 */
export async function clearItemAlarms(
  attentionItemId: string,
  database: IGAMDatabase = db
): Promise<void> {
  try {
    const alarms = await database.scheduledAlarms
      .where('attentionItemId')
      .equals(attentionItemId)
      .toArray();

    for (const alarm of alarms) {
      if (typeof chrome !== 'undefined' && chrome.alarms?.clear) {
        chrome.alarms.clear(alarm.alarmName);
      }
    }

    await database.scheduledAlarms
      .where('attentionItemId')
      .equals(attentionItemId)
      .delete();
  } catch (err) {
    console.warn(`[IGAM] Error clearing alarms for item ${attentionItemId}:`, err);
  }
}

// =========================================================================
// 4. Chrome Alarms Trigger Handler (onAlarm)
// =========================================================================

/**
 * Handles incoming alarm triggers from chrome.alarms.onAlarm.
 * Validates freshness, lifecycle, attention state, and idempotency before notifying.
 */
export async function handleAlarm(
  alarmName: string,
  database: IGAMDatabase = db,
  referenceTime: number = Date.now()
): Promise<boolean> {
  const parsed = parseAlarmName(alarmName);
  if (parsed.type === 'unknown' || !parsed.attentionItemId) {
    return false;
  }

  const itemId = parsed.attentionItemId;
  const item = await database.attentionItems.get(itemId);

  // If item was deleted, purge alarm
  if (!item) {
    await database.scheduledAlarms.delete(alarmName);
    return false;
  }

  // Handle Proximity Reminder Alarm
  if (parsed.type === 'remind' && parsed.stage) {
    const stage = parsed.stage;

    // 1. Lifecycle Check: item must be active
    if (
      item.itemLifecycleState !== 'active' ||
      item.currentState.itemLifecycleState !== 'active'
    ) {
      await database.scheduledAlarms.delete(alarmName);
      return false;
    }

    // 2. Attention State Check: must not be handled, dismissed, or currently snoozed
    if (
      item.userAttentionState === 'handled' ||
      item.userAttentionState === 'dismissed' ||
      item.userAttentionState === 'snoozed'
    ) {
      await database.scheduledAlarms.delete(alarmName);
      return false;
    }

    // 3. Temporal Validity: target must not have passed
    const target = resolvePrimaryTemporalTarget({ item, referenceTime });
    if (!target || target.targetTimestamp <= referenceTime) {
      await database.scheduledAlarms.delete(alarmName);
      return false;
    }

    // 4. Safety Guardrail: suppress if ambiguous or LOW confidence
    if (target.isAmbiguous || target.confidence === 'LOW') {
      await database.scheduledAlarms.delete(alarmName);
      return false;
    }

    // 5. 30m Stage Strict Prerequisites Check
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
        await database.scheduledAlarms.delete(alarmName);
        return false;
      }
    }

    // 6. Idempotency Check
    const deliveryKey = `notif::${item.id}::remind_${stage}`;
    if (!item.notificationState) {
      item.notificationState = {
        lastNotifiedAt: null,
        lastNotificationType: null,
        lastNotificationSeverity: null,
        deliveredNotificationKeys: [],
        activeNotificationId: null,
      };
    }

    if (item.notificationState.deliveredNotificationKeys.includes(deliveryKey)) {
      await database.scheduledAlarms.delete(alarmName);
      return false;
    }

    // 7. Display Notification
    let targetEmail: EmailRecord | null = null;
    if (item.latestEmailId) {
      const fetched = await database.emails.get(item.latestEmailId);
      targetEmail = fetched ?? null;
    }
    const severity = PROXIMITY_STAGE_CONFIGS[stage].minSeverity;
    const payload = buildNotificationPayload(item, 'reminder', severity, targetEmail, {
      stage,
    });
    const options = buildNotificationOptions(payload);

    if (typeof chrome !== 'undefined' && chrome.notifications?.create) {
      await new Promise<string>((resolve) => {
        chrome.notifications.create(payload.id, options, (id) => resolve(id || payload.id));
      });
    }

    // 8. Persist Delivery Audit in Dexie
    item.notificationState.deliveredNotificationKeys.push(deliveryKey);
    item.notificationState.lastNotifiedAt = Date.now();
    item.notificationState.lastNotificationType = 'reminder';
    item.notificationState.lastNotificationSeverity = severity;
    item.notificationState.activeNotificationId = payload.id;

    await database.attentionItems.put(item);
    await database.scheduledAlarms.delete(alarmName);
    return true;
  }

  // Handle Snooze Expiration Alarm
  if (parsed.type === 'snooze' && parsed.snoozeUntil) {
    // 1. Lifecycle check
    if (
      item.itemLifecycleState !== 'active' ||
      item.currentState.itemLifecycleState !== 'active'
    ) {
      await database.scheduledAlarms.delete(alarmName);
      return false;
    }

    // 2. Attention State Check: item must be in snoozed state
    if (item.userAttentionState !== 'snoozed') {
      await database.scheduledAlarms.delete(alarmName);
      return false;
    }

    // 3. Transition: snoozed -> unhandled
    item.userAttentionState = 'unhandled';

    // 4. Idempotency Check
    const deliveryKey = `notif::${item.id}::snooze_expired_${parsed.snoozeUntil}`;
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
      // 5. Display Notification
      let targetEmail: EmailRecord | null = null;
      if (item.latestEmailId) {
        const fetched = await database.emails.get(item.latestEmailId);
        targetEmail = fetched ?? null;
      }
      const payload = buildNotificationPayload(item, 'snooze_expired', 'high', targetEmail, {
        snoozeUntil: parsed.snoozeUntil,
      });
      const options = buildNotificationOptions(payload);

      if (typeof chrome !== 'undefined' && chrome.notifications?.create) {
        await new Promise<string>((resolve) => {
          chrome.notifications.create(payload.id, options, (id) => resolve(id || payload.id));
        });
      }

      item.notificationState.deliveredNotificationKeys.push(deliveryKey);
      item.notificationState.lastNotifiedAt = Date.now();
      item.notificationState.lastNotificationType = 'snooze_expired';
      item.notificationState.lastNotificationSeverity = 'high';
      item.notificationState.activeNotificationId = payload.id;
    }

    // 6. Re-calculate upcoming proximity alarms for unhandled item
    const upcomingAlarms = calculateProximityAlarms({
      item,
      referenceTime,
    });
    await registerScheduledAlarms(upcomingAlarms, database);

    await database.attentionItems.put(item);
    await database.scheduledAlarms.delete(alarmName);
    return true;
  }

  return false;
}

// =========================================================================
// 5. Notification Action Listeners (onButtonClicked & onClicked)
// =========================================================================

/**
 * Safely opens the extension side panel from a notification interaction in Manifest V3.
 * Queries chrome.windows.getLastFocused() to obtain the active browser windowId.
 */
export async function openDashboardSidePanel(): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.sidePanel?.open) return;
  try {
    if (chrome.windows?.getLastFocused) {
      const win = await chrome.windows.getLastFocused();
      if (win?.id) {
        await chrome.sidePanel.open({ windowId: win.id });
        return;
      }
    }
    const fallbackWindowId = (chrome.windows as any)?.WINDOW_ID_CURRENT ?? -2;
    await chrome.sidePanel.open({ windowId: fallbackWindowId });
  } catch (err) {
    console.warn('[IGAM] Could not open side panel:', err);
  }
}

/**
 * Handles clicks on notification action buttons.
 * Actions: Mark Handled, Snooze, Dismiss, Open Dashboard.
 * 100% Local-Only.
 */
export async function handleNotificationButtonClicked(
  notificationId: string,
  buttonIndex: number,
  database: IGAMDatabase = db
): Promise<boolean> {
  // Handle initial sync aggregate summary notification
  if (notificationId === 'notif::initial_sync_summary') {
    if (typeof chrome !== 'undefined' && chrome.notifications?.clear) {
      chrome.notifications.clear(notificationId);
    }
    await openDashboardSidePanel();
    return true;
  }

  // Parse attentionItemId from notificationId: `notif::<attentionItemId>::<key>`
  const parts = notificationId.split('::');
  if (parts.length < 3 || parts[0] !== 'notif') {
    if (typeof chrome !== 'undefined' && chrome.notifications?.clear) {
      chrome.notifications.clear(notificationId);
    }
    return false;
  }

  const itemId = parts[1];
  const item = await database.attentionItems.get(itemId);

  // Clear desktop notification
  if (typeof chrome !== 'undefined' && chrome.notifications?.clear) {
    chrome.notifications.clear(notificationId);
  }

  if (!item) return false;

  // Determine action from notification type and buttonIndex
  const isConflict = notificationId.includes('::conflict_');
  const isCancelled = notificationId.includes('::cancelled');

  let action: 'mark_handled' | 'snooze' | 'dismiss' | 'open_dashboard' = 'mark_handled';

  if (isConflict) {
    action = buttonIndex === 0 ? 'open_dashboard' : 'dismiss';
  } else if (isCancelled) {
    action = 'dismiss';
  } else {
    action = buttonIndex === 0 ? 'mark_handled' : 'snooze';
  }

  // Execute Action
  switch (action) {
    case 'mark_handled': {
      item.userAttentionState = 'handled';
      if (item.notificationState) {
        item.notificationState.activeNotificationId = null;
      }
      await clearItemAlarms(item.id, database);
      await database.attentionItems.put(item);

      // Record persistent account-scoped attention decision
      const syncState = await storage.getSyncState().catch(() => null);
      if (syncState?.accountEmail) {
        const ids = new Set<string>();
        if (item.latestEmailId) ids.add(item.latestEmailId);
        if (item.messageIds) {
          for (const mId of item.messageIds) ids.add(mId);
        }
        await storage.recordAccountAttentionDecision(
          syncState.accountEmail,
          Array.from(ids),
          'handled'
        );
      }

      // Local email record sync
      if (item.latestEmailId) {
        await database.emails.update(item.latestEmailId, {
          alertStatus: 'handled',
          handledAt: Date.now(),
        });
        await database.userFeedback.add({
          emailId: item.latestEmailId,
          timestamp: Date.now(),
          action: 'handled',
          category: item.category,
          importanceScoreAtTime: item.importanceScore,
        });
      }
      return true;
    }

    case 'snooze': {
      const snoozeUntil = Date.now() + DEFAULT_SNOOZE_MS;
      item.userAttentionState = 'snoozed';
      if (item.notificationState) {
        item.notificationState.activeNotificationId = null;
      }

      // Purge proximity alarms occurring before snoozeUntil
      const existingAlarms = await database.scheduledAlarms
        .where('attentionItemId')
        .equals(item.id)
        .toArray();

      for (const a of existingAlarms) {
        if (a.scheduledAt <= snoozeUntil) {
          if (typeof chrome !== 'undefined' && chrome.alarms?.clear) {
            chrome.alarms.clear(a.alarmName);
          }
          await database.scheduledAlarms.delete(a.alarmName);
        }
      }

      // Register new snooze alarm
      const snoozeAlarm = calculateSnoozeAlarm({
        item,
        snoozeUntil,
        referenceTime: Date.now(),
      });

      if (snoozeAlarm) {
        await database.scheduledAlarms.put(snoozeAlarm);
        if (typeof chrome !== 'undefined' && chrome.alarms?.create) {
          chrome.alarms.create(snoozeAlarm.alarmName, { when: snoozeAlarm.scheduledAt });
        }
      }

      await database.attentionItems.put(item);

      // Local email record sync
      if (item.latestEmailId) {
        await database.emails.update(item.latestEmailId, {
          alertStatus: 'snoozed',
          snoozeUntil,
        });
        await database.userFeedback.add({
          emailId: item.latestEmailId,
          timestamp: Date.now(),
          action: 'snoozed',
          category: item.category,
          importanceScoreAtTime: item.importanceScore,
        });
      }
      return true;
    }

    case 'dismiss': {
      item.userAttentionState = 'dismissed';
      if (item.notificationState) {
        item.notificationState.activeNotificationId = null;
      }
      await clearItemAlarms(item.id, database);
      await database.attentionItems.put(item);

      // Record persistent account-scoped attention decision
      const syncState = await storage.getSyncState().catch(() => null);
      if (syncState?.accountEmail) {
        const ids = new Set<string>();
        if (item.latestEmailId) ids.add(item.latestEmailId);
        if (item.messageIds) {
          for (const mId of item.messageIds) ids.add(mId);
        }
        await storage.recordAccountAttentionDecision(
          syncState.accountEmail,
          Array.from(ids),
          'dismissed'
        );
      }

      if (item.latestEmailId) {
        await database.emails.update(item.latestEmailId, {
          alertStatus: 'dismissed',
        });
        await database.userFeedback.add({
          emailId: item.latestEmailId,
          timestamp: Date.now(),
          action: 'dismissed',
          category: item.category,
          importanceScoreAtTime: item.importanceScore,
        });
      }
      return true;
    }

    case 'open_dashboard': {
      await openDashboardSidePanel();
      if (item.latestEmailId) {
        await database.userFeedback.add({
          emailId: item.latestEmailId,
          timestamp: Date.now(),
          action: 'opened',
          category: item.category,
          importanceScoreAtTime: item.importanceScore,
        });
      }
      return true;
    }
  }
}

/**
 * Handles click on the notification body itself.
 */
export async function handleNotificationClicked(
  notificationId: string,
  database: IGAMDatabase = db
): Promise<boolean> {
  // Clear notification
  if (typeof chrome !== 'undefined' && chrome.notifications?.clear) {
    chrome.notifications.clear(notificationId);
  }

  // Handle initial sync aggregate summary notification
  if (notificationId === 'notif::initial_sync_summary') {
    await openDashboardSidePanel();
    return true;
  }

  const parts = notificationId.split('::');
  if (parts.length >= 2 && parts[0] !== 'notif') {
    return false;
  }

  if (parts.length >= 2 && parts[0] === 'notif') {
    const itemId = parts[1];
    const item = await database.attentionItems.get(itemId);
    if (item?.latestEmailId) {
      await database.userFeedback.add({
        emailId: item.latestEmailId,
        timestamp: Date.now(),
        action: 'opened',
        category: item.category,
        importanceScoreAtTime: item.importanceScore,
      });
    }
  }

  // Open Side Panel if available
  await openDashboardSidePanel();

  return true;
}

// =========================================================================
// 6. Bulk Actions
// =========================================================================

export interface BulkMarkHandledResult {
  success: boolean;
  handledCount: number;
  itemIds: string[];
}

/**
 * Bulk marks unhandled AttentionItems as handled.
 *
 * Guarantees:
 * 1. Strictly transitions only userAttentionState and alertStatus.
 * 2. Never mutates factual analysis fields (category, importance, urgency, temporal, etc.).
 * 3. Clears active Chrome desktop notifications for handled items.
 * 4. Clears pending Chrome alarms and Dexie scheduledAlarms records.
 * 5. Persists account-scoped attention decision across reconnects.
 * 6. Purely local operation (zero Gmail write APIs).
 */
export async function bulkMarkHandled(
  database: IGAMDatabase = db,
  targetItemIds?: string[]
): Promise<BulkMarkHandledResult> {
  const syncState = await storage.getSyncState().catch(() => null);
  const accountEmail = syncState?.accountEmail;

  // 1. Fetch unhandled AttentionItems
  let itemsToHandle: AttentionItem[] = [];
  if (targetItemIds && targetItemIds.length > 0) {
    const fetched = await Promise.all(targetItemIds.map((id) => database.attentionItems.get(id)));
    itemsToHandle = fetched.filter(
      (item): item is AttentionItem => Boolean(item && item.userAttentionState === 'unhandled')
    );
  } else {
    itemsToHandle = await database.attentionItems
      .where('userAttentionState')
      .equals('unhandled')
      .toArray();
  }

  const handledItemIds: string[] = [];
  const handledEmailIds = new Set<string>();
  const now = Date.now();

  for (const item of itemsToHandle) {
    item.userAttentionState = 'handled';
    if (item.notificationState?.activeNotificationId) {
      if (typeof chrome !== 'undefined' && chrome.notifications?.clear) {
        chrome.notifications.clear(item.notificationState.activeNotificationId);
      }
      item.notificationState.activeNotificationId = null;
    }

    // Clear all pending proximity and snooze alarms
    await clearItemAlarms(item.id, database);
    await database.attentionItems.put(item);

    handledItemIds.push(item.id);

    if (item.latestEmailId) {
      handledEmailIds.add(item.latestEmailId);
    }
    if (item.messageIds) {
      for (const mId of item.messageIds) {
        handledEmailIds.add(mId);
      }
    }
  }

  // Also transition any pending emails in db.emails
  const pendingEmails = await database.emails.where('alertStatus').equals('pending').toArray();
  for (const e of pendingEmails) {
    handledEmailIds.add(e.id);
  }

  // Update email records in Dexie
  for (const emailId of handledEmailIds) {
    await database.emails.update(emailId, {
      alertStatus: 'handled',
      handledAt: now,
    });
  }

  // Persist account-scoped attention decision across reconnects
  if (accountEmail && handledEmailIds.size > 0) {
    await storage.recordAccountAttentionDecision(
      accountEmail,
      Array.from(handledEmailIds),
      'handled'
    );
  }

  return {
    success: true,
    handledCount: handledItemIds.length || handledEmailIds.size,
    itemIds: handledItemIds,
  };
}

