/**
 * Phase 5E: Recovery, Reconciliation & Pipeline Integration Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { IGAMDatabase } from '../src/db/schema';
import {
  AttentionItem,
  EmailRecord,
  ScheduledAlarmRecord,
} from '../src/shared/types';
import {
  clearAllAccountNotificationsAndAlarms,
  dispatchInitialSyncSummaryNotification,
  handleEmailAttentionPipeline,
  reconcileNotifications,
} from '../src/background/notifications/reconciler';
import {
  createDefaultNotificationState,
} from '../src/background/notifications/types';
import { EmailChangeAnalysis } from '../src/background/analysis/change';

// =========================================================================
// Mock Chrome API Harness
// =========================================================================

function setupChromeMock() {
  const notifications = new Map<string, chrome.notifications.NotificationOptions>();
  const alarms = new Map<string, chrome.alarms.AlarmCreateInfo>();
  const sidePanelOpened = vi.fn().mockResolvedValue(undefined);

  const mockChrome = {
    notifications: {
      create: vi.fn((id: string, options: chrome.notifications.NotificationOptions, callback?: (id: string) => void) => {
        notifications.set(id, options);
        if (callback) callback(id);
        return Promise.resolve(id);
      }),
      clear: vi.fn((id: string, callback?: (wasCleared: boolean) => void) => {
        const wasPresent = notifications.delete(id);
        if (callback) callback(wasPresent);
        return Promise.resolve(wasPresent);
      }),
      getAll: vi.fn((callback: (notifications: Record<string, chrome.notifications.NotificationOptions>) => void) => {
        const obj: Record<string, chrome.notifications.NotificationOptions> = {};
        notifications.forEach((val, key) => {
          obj[key] = val;
        });
        callback(obj);
      }),
      onButtonClicked: { addListener: vi.fn() },
      onClicked: { addListener: vi.fn() },
    },
    alarms: {
      create: vi.fn((name: string, info: chrome.alarms.AlarmCreateInfo) => {
        alarms.set(name, info);
      }),
      clear: vi.fn((name: string, callback?: (wasCleared: boolean) => void) => {
        const wasPresent = alarms.delete(name);
        if (callback) callback(wasPresent);
        return Promise.resolve(wasPresent);
      }),
      getAll: vi.fn((callback: (alarms: chrome.alarms.Alarm[]) => void) => {
        const list: chrome.alarms.Alarm[] = [];
        alarms.forEach((info, name) => {
          list.push({
            name,
            scheduledTime: (info as any).when || Date.now(),
            persistAcrossSessions: true,
          } as chrome.alarms.Alarm);
        });
        callback(list);
      }),
      onAlarm: { addListener: vi.fn() },
    },
    sidePanel: {
      open: sidePanelOpened,
    },
    windows: {
      getLastFocused: vi.fn().mockResolvedValue({ id: 1001 }),
      WINDOW_ID_CURRENT: -2,
    },
    runtime: {
      getURL: (path: string) => `chrome-extension://mock_extension_id/${path}`,
    },
  };

  (globalThis as any).chrome = mockChrome;

  return {
    notifications,
    alarms,
    sidePanelOpened,
    reset: () => {
      notifications.clear();
      alarms.clear();
      sidePanelOpened.mockClear();
    },
  };
}

function createMockItem(id = 'att_test_5e'): AttentionItem {
  return {
    id,
    identityKey: 'cat::company::topic',
    category: 'career_placement',
    canonicalEntity: 'google',
    entityStatus: 'known',
    topicScope: 'swe_intern',
    topicStatus: 'known',
    threadIds: ['th_5e'],
    messageIds: ['msg_5e'],
    latestEmailId: 'msg_5e',
    firstSeenAt: Date.now() - 3600000,
    lastSeenAt: Date.now(),
    itemLifecycleState: 'active',
    userAttentionState: 'unhandled',
    importanceScore: 85,
    urgencyScore: 85,
    currentState: {
      primaryEventTimestamp: Date.now() + 24 * 3600 * 1000, // tomorrow
      primaryDeadlineTimestamp: null,
      venue: 'SJT 717',
      actionRequired: true,
      actionType: 'attend',
      itemLifecycleState: 'active',
      subEvents: [],
    },
    history: [],
    notificationState: createDefaultNotificationState(),
  };
}

function createMockEmail(id = 'msg_5e', subject = 'Campus Placement Notice'): EmailRecord {
  return {
    id,
    threadId: 'th_5e',
    subject,
    from: 'placement@vit.ac.in',
    fromDomain: 'vit.ac.in',
    snippet: 'Placement test scheduled in SJT 717',
    internalDate: Date.now(),
    processedAt: Date.now(),
    bodyTextPreview: 'Placement test scheduled in SJT 717 tomorrow at 4:30 PM',
    labels: ['INBOX'],
    category: 'career_placement',
    confidence: 0.95,
    importanceScore: 85,
    urgencyScore: 85,
    actionRequired: true,
    actionType: 'attend',
    detectionReasons: ['Placement keyword match'],
    extractedEntities: {
      deadlines: [],
      dates: [{ text: 'tomorrow at 4:30 PM', parsedTimestamp: Date.now() + 24 * 3600 * 1000 }],
      organizations: ['Google'],
      locations: ['SJT 717'],
      ctc: null,
      urls: [],
    },
    temporalAnalysis: {
      entities: [
        {
          id: 'temp_1',
          rawText: 'tomorrow at 4:30 PM',
          type: 'event',
          status: 'upcoming',
          timestamp: Date.now() + 24 * 3600 * 1000,
          datePrecision: 'exact',
          timePrecision: 'exact',
          isAmbiguous: false,
          confidence: 'HIGH',
          associatedAction: 'attend',
          contextSnippet: 'Placement test scheduled in SJT 717',
          evidenceReasons: [],
        },
      ],
      primaryEvent: {
        id: 'temp_1',
        rawText: 'tomorrow at 4:30 PM',
        type: 'event',
        status: 'upcoming',
        timestamp: Date.now() + 24 * 3600 * 1000,
        datePrecision: 'exact',
        timePrecision: 'exact',
        isAmbiguous: false,
        confidence: 'HIGH',
        associatedAction: 'attend',
        contextSnippet: 'Placement test scheduled in SJT 717',
        evidenceReasons: [],
      },
      primaryDeadline: null,
      hasActiveDeadline: false,
      isOverdue: false,
      hasAmbiguousDates: false,
      temporalUrgencyTier: 'upcoming',
      summaryReason: 'Event scheduled tomorrow',
    },
    alertStatus: 'pending',
    snoozeUntil: null,
    handledAt: null,
  };
}

describe('Phase 5E: Recovery, Reconciliation & Pipeline Integration', () => {
  let testDb: IGAMDatabase;
  let chromeMock: ReturnType<typeof setupChromeMock>;

  beforeEach(async () => {
    testDb = new IGAMDatabase(`test_5e_${Date.now()}_${Math.random()}`);
    chromeMock = setupChromeMock();
  });

  afterEach(async () => {
    await testDb.delete();
    chromeMock.reset();
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. Startup Reconciliation & Alarm Re-creation / Orphan Removal
  // =========================================================================
  describe('Alarm Reconciliation (reconcileNotifications)', () => {
    it('recreates missing Chrome alarm when Dexie contains a valid future alarm', async () => {
      const item = createMockItem();
      await testDb.attentionItems.put(item);

      const futureAlarm: ScheduledAlarmRecord = {
        alarmName: `remind::${item.id}::24h`,
        attentionItemId: item.id,
        alarmType: 'reminder',
        scheduledAt: Date.now() + 3600 * 1000, // 1 hour in future
        purpose: 'Upcoming event in 24h',
        stage: '24h',
      };
      await testDb.scheduledAlarms.put(futureAlarm);

      // Chrome currently has NO alarm registered
      expect(chromeMock.alarms.size).toBe(0);

      const report = await reconcileNotifications(testDb);

      expect(report.recreatedAlarms).toContain(futureAlarm.alarmName);
      expect(chromeMock.alarms.has(futureAlarm.alarmName)).toBe(true);
      expect(chromeMock.alarms.get(futureAlarm.alarmName)?.when).toBe(futureAlarm.scheduledAt);
    });

    it('clears orphan Chrome alarm whose AttentionItem does not exist in Dexie', async () => {
      const orphanAlarmName = 'remind::att_non_existent::24h';
      chromeMock.alarms.set(orphanAlarmName, { when: Date.now() + 10000 });

      const report = await reconcileNotifications(testDb);

      expect(report.clearedOrphanAlarms).toContain(orphanAlarmName);
      expect(chromeMock.alarms.has(orphanAlarmName)).toBe(false);
    });

    it('clears invalid alarms if AttentionItem is marked handled or dismissed', async () => {
      const item = createMockItem();
      item.userAttentionState = 'handled';
      await testDb.attentionItems.put(item);

      const alarm: ScheduledAlarmRecord = {
        alarmName: `remind::${item.id}::24h`,
        attentionItemId: item.id,
        alarmType: 'reminder',
        scheduledAt: Date.now() + 3600 * 1000,
        purpose: 'Handled item alarm',
        stage: '24h',
      };
      await testDb.scheduledAlarms.put(alarm);
      chromeMock.alarms.set(alarm.alarmName, { when: alarm.scheduledAt });

      const report = await reconcileNotifications(testDb);

      expect(report.clearedInvalidAlarms).toContain(alarm.alarmName);
      expect(chromeMock.alarms.has(alarm.alarmName)).toBe(false);
      expect(await testDb.scheduledAlarms.count()).toBe(0);
    });

    it('clears invalid alarms if AttentionItem lifecycle is cancelled or completed', async () => {
      const item = createMockItem();
      item.itemLifecycleState = 'cancelled';
      item.currentState.itemLifecycleState = 'cancelled';
      await testDb.attentionItems.put(item);

      const alarm: ScheduledAlarmRecord = {
        alarmName: `remind::${item.id}::24h`,
        attentionItemId: item.id,
        alarmType: 'reminder',
        scheduledAt: Date.now() + 3600 * 1000,
        purpose: 'Cancelled item alarm',
        stage: '24h',
      };
      await testDb.scheduledAlarms.put(alarm);
      chromeMock.alarms.set(alarm.alarmName, { when: alarm.scheduledAt });

      const report = await reconcileNotifications(testDb);

      expect(report.clearedInvalidAlarms).toContain(alarm.alarmName);
      expect(chromeMock.alarms.has(alarm.alarmName)).toBe(false);
      expect(await testDb.scheduledAlarms.count()).toBe(0);
    });
  });

  // =========================================================================
  // 2. Missed Alarms Handling
  // =========================================================================
  describe('Missed Alarms Handling', () => {
    it('processes missed 24h reminder within grace period and delivers notification', async () => {
      const now = 1726500000000;
      const item = createMockItem();
      // Target event is 20 hours from now (still comfortably in future)
      item.currentState.primaryEventTimestamp = now + 20 * 3600 * 1000;
      await testDb.attentionItems.put(item);

      // 24h reminder was scheduled 5 minutes ago (within 15m grace period)
      const scheduledAt = now - 5 * 60 * 1000;
      const alarm: ScheduledAlarmRecord = {
        alarmName: `remind::${item.id}::24h`,
        attentionItemId: item.id,
        alarmType: 'reminder',
        scheduledAt,
        purpose: 'Missed 24h reminder',
        stage: '24h',
      };
      await testDb.scheduledAlarms.put(alarm);
      chromeMock.alarms.set(alarm.alarmName, { when: scheduledAt });

      const report = await reconcileNotifications(testDb, now);

      expect(report.missedRemindersHandled).toContain(alarm.alarmName);
      expect(chromeMock.notifications.has(`notif::${item.id}::remind_24h`)).toBe(true);
      // Expired alarm should be cleaned from Dexie
      expect(await testDb.scheduledAlarms.get(alarm.alarmName)).toBeUndefined();
    });

    it('processes missed 3h reminder within grace period and delivers notification', async () => {
      const now = 1726500000000;
      const item = createMockItem();
      // Event is in 2 hours 55 minutes
      item.currentState.primaryEventTimestamp = now + (2 * 3600 + 55 * 60) * 1000;
      await testDb.attentionItems.put(item);

      // 3h reminder was scheduled 5 minutes ago
      const scheduledAt = now - 5 * 60 * 1000;
      const alarm: ScheduledAlarmRecord = {
        alarmName: `remind::${item.id}::3h`,
        attentionItemId: item.id,
        alarmType: 'reminder',
        scheduledAt,
        purpose: 'Missed 3h reminder',
        stage: '3h',
      };
      await testDb.scheduledAlarms.put(alarm);

      const report = await reconcileNotifications(testDb, now);

      expect(report.missedRemindersHandled).toContain(alarm.alarmName);
      expect(chromeMock.notifications.has(`notif::${item.id}::remind_3h`)).toBe(true);
    });

    it('processes missed 30m reminder if 5 prerequisites are met', async () => {
      const now = 1726500000000;
      const item = createMockItem();
      item.currentState.primaryEventTimestamp = now + 25 * 60 * 1000; // Event in 25 mins
      item.currentState.venue = 'SJT 717'; // physical
      item.currentState.actionRequired = true;
      item.userAttentionState = 'unhandled';
      await testDb.attentionItems.put(item);

      const scheduledAt = now - 5 * 60 * 1000; // scheduled 5m ago
      const alarm: ScheduledAlarmRecord = {
        alarmName: `remind::${item.id}::30m`,
        attentionItemId: item.id,
        alarmType: 'reminder',
        scheduledAt,
        purpose: 'Missed 30m reminder',
        stage: '30m',
      };
      await testDb.scheduledAlarms.put(alarm);

      const report = await reconcileNotifications(testDb, now);

      expect(report.missedRemindersHandled).toContain(alarm.alarmName);
      expect(chromeMock.notifications.has(`notif::${item.id}::remind_30m`)).toBe(true);
    });

    it('suppresses stale missed reminder scheduled > 15 minutes ago', async () => {
      const now = 1726500000000;
      const item = createMockItem();
      await testDb.attentionItems.put(item);

      // Scheduled 2 hours ago (beyond 15m grace period)
      const scheduledAt = now - 2 * 3600 * 1000;
      const alarm: ScheduledAlarmRecord = {
        alarmName: `remind::${item.id}::48h`,
        attentionItemId: item.id,
        alarmType: 'reminder',
        scheduledAt,
        purpose: 'Stale 48h reminder',
        stage: '48h',
      };
      await testDb.scheduledAlarms.put(alarm);

      const report = await reconcileNotifications(testDb, now);

      expect(report.missedRemindersSuppressed).toContain(alarm.alarmName);
      expect(chromeMock.notifications.has(`notif::${item.id}::remind_48h`)).toBe(false);
      expect(await testDb.scheduledAlarms.get(alarm.alarmName)).toBeUndefined();
    });

    it('suppresses missed reminder if target event has already passed', async () => {
      const now = 1726500000000;
      const item = createMockItem();
      // Target event passed 10 minutes ago
      item.currentState.primaryEventTimestamp = now - 10 * 60 * 1000;
      await testDb.attentionItems.put(item);

      const alarm: ScheduledAlarmRecord = {
        alarmName: `remind::${item.id}::30m`,
        attentionItemId: item.id,
        alarmType: 'reminder',
        scheduledAt: now - 40 * 60 * 1000,
        purpose: 'Missed 30m reminder for passed event',
        stage: '30m',
      };
      await testDb.scheduledAlarms.put(alarm);

      const report = await reconcileNotifications(testDb, now);

      expect(report.clearedInvalidAlarms).toContain(alarm.alarmName);
      expect(chromeMock.notifications.size).toBe(0);
    });
  });

  // =========================================================================
  // 3. Snooze Expiration Recovery
  // =========================================================================
  describe('Snooze Recovery', () => {
    it('detects passed snoozeUntil, transitions to unhandled, fires SNOOZE_EXPIRED, and re-arms proximity alarms', async () => {
      const now = 1726500000000;
      const item = createMockItem();
      item.userAttentionState = 'snoozed';
      const snoozeUntil = now - 5000; // Snooze expired 5 seconds ago
      // Future event is tomorrow
      item.currentState.primaryEventTimestamp = now + 24 * 3600 * 1000;
      await testDb.attentionItems.put(item);

      const snoozeAlarm: ScheduledAlarmRecord = {
        alarmName: `snooze::${item.id}::${snoozeUntil}`,
        attentionItemId: item.id,
        alarmType: 'snooze',
        scheduledAt: snoozeUntil,
        purpose: 'Snooze alarm',
      };
      await testDb.scheduledAlarms.put(snoozeAlarm);

      const report = await reconcileNotifications(testDb, now);

      expect(report.missedSnoozesHandled).toContain(item.id);

      // Item should now be unhandled
      const updatedItem = await testDb.attentionItems.get(item.id);
      expect(updatedItem?.userAttentionState).toBe('unhandled');

      // Notification should be delivered
      const notifKey = `notif::${item.id}::snooze_expired_${snoozeUntil}`;
      expect(chromeMock.notifications.has(notifKey)).toBe(true);

      // Old snooze alarm cleared
      expect(await testDb.scheduledAlarms.get(snoozeAlarm.alarmName)).toBeUndefined();

      // Proximity alarms recalculated and registered
      const upcoming = await testDb.scheduledAlarms.where('attentionItemId').equals(item.id).toArray();
      expect(upcoming.length).toBeGreaterThan(0);
    });

    it('repeated recovery runs are idempotent for snooze recovery', async () => {
      const now = 1726500000000;
      const item = createMockItem();
      item.userAttentionState = 'snoozed';
      const snoozeUntil = now - 5000;
      await testDb.attentionItems.put(item);

      const snoozeAlarm: ScheduledAlarmRecord = {
        alarmName: `snooze::${item.id}::${snoozeUntil}`,
        attentionItemId: item.id,
        alarmType: 'snooze',
        scheduledAt: snoozeUntil,
        purpose: 'Snooze alarm',
      };
      await testDb.scheduledAlarms.put(snoozeAlarm);

      // Run recovery first time
      await reconcileNotifications(testDb, now);
      const notifsFirst = chromeMock.notifications.size;

      // Run recovery second time
      const report2 = await reconcileNotifications(testDb, now);
      expect(report2.missedSnoozesHandled.length).toBe(0);
      expect(chromeMock.notifications.size).toBe(notifsFirst); // No duplicate notifications
    });
  });

  // =========================================================================
  // 4. Pipeline Integration: NEW, REPEAT, UPDATE, CONFLICT, CANCELLED
  // =========================================================================
  describe('Pipeline Integration (handleEmailAttentionPipeline)', () => {
    it('eligible NEW email produces notification in live incremental sync', async () => {
      const item = createMockItem();
      const email = createMockEmail();
      const changeAnalysis: EmailChangeAnalysis = {
        item,
        result: {
          attentionItemId: item.id,
          relation: 'NEW',
          shouldCreateNewAttentionItem: true,
          deltas: [],
          summary: 'New placement notice',
          confidence: 'HIGH',
        },
        isNew: true,
      };

      const result = await handleEmailAttentionPipeline(
        email,
        changeAnalysis,
        { isInitialSync: false },
        testDb
      );

      expect(result.eligible).toBe(true);
      expect(result.dispatchResult?.delivered).toBe(true);
      expect(chromeMock.notifications.has(`notif::${item.id}::new`)).toBe(true);
    });

    it('REPEAT produces strictly NO notification and does not schedule duplicate alarms', async () => {
      const item = createMockItem();
      const email = createMockEmail();
      const changeAnalysis: EmailChangeAnalysis = {
        item,
        result: {
          attentionItemId: item.id,
          relation: 'REPEAT',
          shouldCreateNewAttentionItem: false,
          deltas: [],
          summary: 'Repetition of previous notice',
          confidence: 'HIGH',
        },
        isNew: false,
      };

      const result = await handleEmailAttentionPipeline(
        email,
        changeAnalysis,
        { isInitialSync: false },
        testDb
      );

      expect(result.eligible).toBe(false);
      expect(result.dispatchResult?.delivered).toBe(false);
      expect(chromeMock.notifications.size).toBe(0);
    });

    it('material UPDATE produces notification', async () => {
      const item = createMockItem();
      const email = createMockEmail('msg_upd', 'Update: Venue Rescheduled');
      const changeAnalysis: EmailChangeAnalysis = {
        item,
        result: {
          attentionItemId: item.id,
          relation: 'UPDATE',
          shouldCreateNewAttentionItem: false,
          deltas: [
            {
              field: 'venue',
              oldValue: 'SJT 717',
              newValue: 'TT Gallery',
              changeType: 'updated',
              description: 'Venue changed to TT Gallery',
              confidence: 'HIGH',
            },
          ],
          summary: 'Venue updated to TT Gallery',
          confidence: 'HIGH',
        },
        isNew: false,
      };

      const result = await handleEmailAttentionPipeline(
        email,
        changeAnalysis,
        { isInitialSync: false },
        testDb
      );

      expect(result.eligible).toBe(true);
      expect(result.dispatchResult?.delivered).toBe(true);
      expect(chromeMock.notifications.size).toBe(1);
    });

    it('non-material UPDATE produces NO notification', async () => {
      const item = createMockItem();
      const email = createMockEmail('msg_upd', 'Reminder');
      const changeAnalysis: EmailChangeAnalysis = {
        item,
        result: {
          attentionItemId: item.id,
          relation: 'UPDATE',
          shouldCreateNewAttentionItem: false,
          deltas: [], // No material deltas
          summary: 'Formatting update',
          confidence: 'HIGH',
        },
        isNew: false,
      };

      const result = await handleEmailAttentionPipeline(
        email,
        changeAnalysis,
        { isInitialSync: false },
        testDb
      );

      expect(result.eligible).toBe(false);
      expect(result.dispatchResult?.delivered).toBe(false);
      expect(chromeMock.notifications.size).toBe(0);
    });

    it('CONFLICT produces notification', async () => {
      const item = createMockItem();
      const email = createMockEmail('msg_conf', 'PPT Contradiction');
      const changeAnalysis: EmailChangeAnalysis = {
        item,
        result: {
          attentionItemId: item.id,
          relation: 'CONFLICT',
          shouldCreateNewAttentionItem: false,
          deltas: [
            {
              field: 'topic',
              oldValue: 'role_software',
              newValue: 'role_ai',
              changeType: 'conflict',
              description: 'Contradictory role specified',
            },
          ],
          summary: 'Contradictory roles between subject and body',
          confidence: 'HIGH',
        },
        isNew: false,
      };

      const result = await handleEmailAttentionPipeline(
        email,
        changeAnalysis,
        { isInitialSync: false },
        testDb
      );

      expect(result.eligible).toBe(true);
      expect(result.dispatchResult?.delivered).toBe(true);
      expect(chromeMock.notifications.size).toBe(1);
    });

    it('CANCELLED produces notification and purges alarms', async () => {
      const item = createMockItem();
      await testDb.attentionItems.put(item);

      // Pre-existing alarm
      const alarm: ScheduledAlarmRecord = {
        alarmName: `remind::${item.id}::24h`,
        attentionItemId: item.id,
        alarmType: 'reminder',
        scheduledAt: Date.now() + 3600 * 1000,
        purpose: 'Pre-existing reminder',
      };
      await testDb.scheduledAlarms.put(alarm);
      chromeMock.alarms.set(alarm.alarmName, { when: alarm.scheduledAt });

      const email = createMockEmail('msg_canc', 'PPT Cancelled');
      const changeAnalysis: EmailChangeAnalysis = {
        item,
        result: {
          attentionItemId: item.id,
          relation: 'CANCELLED',
          shouldCreateNewAttentionItem: false,
          deltas: [
            {
              field: 'itemLifecycleState',
              oldValue: 'active',
              newValue: 'cancelled',
              changeType: 'updated',
              description: 'Company cancelled session',
            },
          ],
          summary: 'Session cancelled',
          confidence: 'HIGH',
        },
        isNew: false,
      };

      const result = await handleEmailAttentionPipeline(
        email,
        changeAnalysis,
        { isInitialSync: false },
        testDb
      );

      expect(result.eligible).toBe(true);
      expect(result.dispatchResult?.delivered).toBe(true);
      expect(chromeMock.notifications.has(`notif::${item.id}::cancelled`)).toBe(true);

      // Pre-existing alarms should be purged
      expect(await testDb.scheduledAlarms.count()).toBe(0);
      expect(chromeMock.alarms.has(alarm.alarmName)).toBe(false);
    });
  });

  // =========================================================================
  // 5. Initial Sync Notification Storm Protection
  // =========================================================================
  describe('Initial Sync Storm Protection', () => {
    it('suppresses individual NEW popups during bulk initial sync while still scheduling future alarms', async () => {
      const item = createMockItem();
      const email = createMockEmail();
      const changeAnalysis: EmailChangeAnalysis = {
        item,
        result: {
          attentionItemId: item.id,
          relation: 'NEW',
          shouldCreateNewAttentionItem: true,
          deltas: [],
          summary: 'New placement notice during initial sync',
          confidence: 'HIGH',
        },
        isNew: true,
      };

      const result = await handleEmailAttentionPipeline(
        email,
        changeAnalysis,
        { isInitialSync: true },
        testDb
      );

      // Eligible, but popup was suppressed
      expect(result.eligible).toBe(true);
      expect(result.dispatchResult).toBeNull();
      expect(chromeMock.notifications.size).toBe(0);

      // Future proximity alarms WERE scheduled
      expect(result.alarmsScheduled).toBeGreaterThan(0);
      const scheduledInDb = await testDb.scheduledAlarms.where('attentionItemId').equals(item.id).toArray();
      expect(scheduledInDb.length).toBeGreaterThan(0);
      expect(chromeMock.alarms.size).toBeGreaterThan(0);
    });

    it('dispatches at most ONE aggregate summary notification after initial sync', async () => {
      await dispatchInitialSyncSummaryNotification(5);

      expect(chromeMock.notifications.size).toBe(1);
      expect(chromeMock.notifications.has('notif::initial_sync_summary')).toBe(true);
      const notif = chromeMock.notifications.get('notif::initial_sync_summary');
      expect(notif?.title).toBe('Gmail Attention Manager');
      expect(notif?.message).toContain('5 actionable items require attention');
    });

    it('does not dispatch summary notification if 0 eligible items exist', async () => {
      await dispatchInitialSyncSummaryNotification(0);
      expect(chromeMock.notifications.size).toBe(0);
    });
  });

  // =========================================================================
  // 6. Account Isolation
  // =========================================================================
  describe('Account Isolation', () => {
    it('clears all scheduled alarms, Chrome alarms, and notifications on disconnect', async () => {
      const item = createMockItem();
      await testDb.attentionItems.put(item);

      const alarm: ScheduledAlarmRecord = {
        alarmName: `remind::${item.id}::24h`,
        attentionItemId: item.id,
        alarmType: 'reminder',
        scheduledAt: Date.now() + 3600 * 1000,
        purpose: 'Old account alarm',
      };
      await testDb.scheduledAlarms.put(alarm);
      chromeMock.alarms.set(alarm.alarmName, { when: alarm.scheduledAt });
      chromeMock.notifications.set(`notif::${item.id}::new`, {} as any);

      expect(await testDb.scheduledAlarms.count()).toBe(1);
      expect(chromeMock.alarms.size).toBe(1);
      expect(chromeMock.notifications.size).toBe(1);

      await clearAllAccountNotificationsAndAlarms(testDb);

      expect(await testDb.scheduledAlarms.count()).toBe(0);
      expect(chromeMock.alarms.size).toBe(0);
      expect(chromeMock.notifications.size).toBe(0);
    });
  });
});
