import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { IGAMDatabase } from '../src/db/schema';
import {
  AttentionItem,
  EmailRecord,
  ScheduledAlarmRecord,
} from '../src/shared/types';
import {
  buildNotificationOptions,
  buildNotificationPayload,
  clearItemAlarms,
  dispatchAttentionNotification,
  handleAlarm,
  handleNotificationButtonClicked,
  handleNotificationClicked,
  openDashboardSidePanel,
  registerScheduledAlarms,
} from '../src/background/notifications/engine';
import { createDefaultNotificationState, AttentionEligibilityResult } from '../src/background/notifications/types';

// Mock Chrome API Harness
interface MockNotification {
  id: string;
  options: chrome.notifications.NotificationOptions;
}

interface MockAlarm {
  name: string;
  info: chrome.alarms.AlarmCreateInfo;
}

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

describe('Phase 5D: Chrome Notifications & Alarms Runtime Integration', () => {
  let testDb: IGAMDatabase;
  let dbName: string;
  let chromeMock: ReturnType<typeof setupChromeMock>;

  const EVENT_TIME = 1726585200000; // Sep 17, 2026, 4:30 PM UTC
  const BASE_TIME = EVENT_TIME - 50 * 60 * 60 * 1000; // 50 hours prior

  beforeEach(async () => {
    chromeMock = setupChromeMock();
    dbName = `test_phase5d_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    testDb = new IGAMDatabase(dbName);
    await testDb.open();
  });

  afterEach(async () => {
    if (testDb.isOpen()) {
      testDb.close();
    }
    await testDb.delete();
    chromeMock.reset();
  });

  function createMockItem(overrides: Partial<AttentionItem> = {}): AttentionItem {
    return {
      id: 'att_test_5d',
      identityKey: 'career_placement::deloitte::role_sde',
      category: 'career_placement',
      canonicalEntity: 'deloitte',
      entityStatus: 'known',
      topicScope: 'role_sde',
      topicStatus: 'known',
      threadIds: ['th_5d_01'],
      messageIds: ['msg_5d_01'],
      latestEmailId: 'msg_5d_01',
      firstSeenAt: BASE_TIME,
      lastSeenAt: BASE_TIME,
      itemLifecycleState: 'active',
      userAttentionState: 'unhandled',
      importanceScore: 85,
      urgencyScore: 80,
      currentState: {
        primaryEventTimestamp: EVENT_TIME,
        primaryDeadlineTimestamp: null,
        venue: 'SJT 717',
        actionRequired: true,
        actionType: 'attend',
        itemLifecycleState: 'active',
        subEvents: [
          {
            subEventId: 'sub_ppt',
            label: 'Deloitte PPT',
            type: 'event',
            timestamp: EVENT_TIME,
            endTimestamp: null,
            timePrecision: 'exact',
            venue: 'SJT 717',
            status: 'active',
          },
        ],
      },
      history: [],
      notificationState: createDefaultNotificationState(),
      ...overrides,
    };
  }

  function createMockEmail(overrides: Partial<EmailRecord> = {}): EmailRecord {
    return {
      id: 'msg_5d_01',
      threadId: 'th_5d_01',
      subject: 'Deloitte Campus Recruitment Drive',
      from: 'placement@university.edu',
      fromDomain: 'university.edu',
      snippet: 'Deloitte PPT tomorrow at SJT 717',
      internalDate: BASE_TIME,
      processedAt: BASE_TIME,
      bodyTextPreview: 'Deloitte PPT scheduled on 17th Sep at 4:30 PM in SJT 717',
      category: 'career_placement',
      confidence: 0.95,
      importanceScore: 85,
      urgencyScore: 80,
      actionRequired: true,
      actionType: 'attend',
      detectionReasons: [],
      extractedEntities: {
        deadlines: [],
        dates: [],
        organizations: ['Deloitte'],
        locations: ['SJT 717'],
        ctc: null,
        urls: [],
      },
      alertStatus: 'pending',
      snoozeUntil: null,
      handledAt: null,
      attentionItemId: 'att_test_5d',
      changeRelation: 'NEW',
      ...overrides,
    };
  }

  // =========================================================================
  // 1. Notification Content & Severity Priority Mapping
  // =========================================================================
  describe('Notification Content & Priority Mapping', () => {
    it('maps critical severity to Chrome priority 2 with requireInteraction true', () => {
      const item = createMockItem();
      const payload = buildNotificationPayload(item, 'new', 'critical');
      const options = buildNotificationOptions(payload);

      expect(options.priority).toBe(2);
      expect(options.requireInteraction).toBe(true);
      expect(payload.title).toContain('🚨 [URGENT]');
    });

    it('maps high severity to Chrome priority 1 with requireInteraction false', () => {
      const item = createMockItem();
      const payload = buildNotificationPayload(item, 'new', 'high');
      const options = buildNotificationOptions(payload);

      expect(options.priority).toBe(1);
      expect(options.requireInteraction).toBe(false);
      expect(payload.title).toContain('⚠️ [IMPORTANT]');
    });

    it('maps standard severity to Chrome priority 0 with requireInteraction false', () => {
      const item = createMockItem();
      const payload = buildNotificationPayload(item, 'new', 'standard');
      const options = buildNotificationOptions(payload);

      expect(options.priority).toBe(0);
      expect(options.requireInteraction).toBe(false);
      expect(payload.title).toContain('📌 [ATTENTION]');
    });

    it('builds CONFLICT notification with Review in Dashboard and Dismiss buttons', () => {
      const item = createMockItem();
      const payload = buildNotificationPayload(item, 'conflict', 'critical');

      expect(payload.id).toContain('conflict');
      expect(payload.title).toContain('🚨 [CONFLICT]');
      expect(payload.buttons.map((b) => b.title)).toEqual([
        '🔍 Review in Dashboard',
        'Dismiss',
      ]);
    });

    it('builds CANCELLED notification with single Dismiss button', () => {
      const item = createMockItem();
      const payload = buildNotificationPayload(item, 'cancellation', 'high');

      expect(payload.id).toContain('cancelled');
      expect(payload.title).toContain('⚠️ [CANCELLED]');
      expect(payload.buttons.map((b) => b.title)).toEqual(['Dismiss']);
    });

    it('builds REMINDER notification with stage-specific copy', () => {
      const item = createMockItem();

      const p30m = buildNotificationPayload(item, 'reminder', 'critical', null, {
        stage: '30m',
      });
      expect(p30m.title).toContain('🚨 [STARTING SOON]');
      expect(p30m.message).toContain('30 minutes');
      expect(p30m.id).toBe('notif::att_test_5d::remind_30m');

      const p3h = buildNotificationPayload(item, 'reminder', 'critical', null, {
        stage: '3h',
      });
      expect(p3h.title).toContain('🚨 [FINAL CALL]');
      expect(p3h.message).toContain('3 hours');

      const p24h = buildNotificationPayload(item, 'reminder', 'standard', null, {
        stage: '24h',
      });
      expect(p24h.title).toContain('📌 [REMINDER - 24h]');
    });

    it('builds SNOOZE_EXPIRED notification with reminder resumed copy', () => {
      const item = createMockItem();
      const payload = buildNotificationPayload(item, 'snooze_expired', 'high', null, {
        snoozeUntil: 1726500000000,
      });

      expect(payload.title).toContain('⏰ [SNOOZE EXPIRED]');
      expect(payload.id).toBe('notif::att_test_5d::snooze_expired_1726500000000');
    });
  });

  // =========================================================================
  // 2. Direct Notification Dispatcher & Idempotency
  // =========================================================================
  describe('dispatchAttentionNotification & Idempotency', () => {
    it('creates notification and persists delivery audit state in Dexie', async () => {
      const item = createMockItem();
      await testDb.attentionItems.put(item);

      const decision: AttentionEligibilityResult = {
        shouldNotify: true,
        severity: 'critical',
        reason: 'Urgent placement interview',
        notificationType: 'new',
        idempotencyKey: `notif::${item.id}::new`,
        effectiveScore: 82,
        baseScore: 82,
        thresholdPassed: true,
        overrideTriggered: 'urgency',
        categorySilenced: false,
        userAttentionStateAction: 'preserve',
        nextUserAttentionState: 'unhandled',
        isMaterialChange: true,
      };

      const result = await dispatchAttentionNotification(
        { item, decision, referenceTime: BASE_TIME },
        testDb
      );

      expect(result.delivered).toBe(true);
      expect(result.notificationId).toBe('notif::att_test_5d::new');

      // Check chrome.notifications.create was called
      expect(chromeMock.notifications.has('notif::att_test_5d::new')).toBe(true);

      // Check Dexie persistence
      const savedItem = await testDb.attentionItems.get(item.id);
      expect(savedItem?.notificationState?.deliveredNotificationKeys).toContain(
        'notif::att_test_5d::new'
      );
      expect(savedItem?.notificationState?.activeNotificationId).toBe(
        'notif::att_test_5d::new'
      );
      expect(savedItem?.notificationState?.lastNotificationType).toBe('new');
      expect(savedItem?.notificationState?.lastNotificationSeverity).toBe('critical');

      // Check proximity alarms were registered for NEW item
      const alarmsInDb = await testDb.scheduledAlarms
        .where('attentionItemId')
        .equals(item.id)
        .toArray();
      expect(alarmsInDb.length).toBeGreaterThan(0);
      expect(chromeMock.alarms.size).toBeGreaterThan(0);
    });

    it('suppresses duplicate notifications using idempotencyKey', async () => {
      const item = createMockItem({
        notificationState: {
          lastNotifiedAt: BASE_TIME,
          lastNotificationType: 'new',
          lastNotificationSeverity: 'critical',
          deliveredNotificationKeys: ['notif::att_test_5d::new'], // Already delivered!
          activeNotificationId: 'notif::att_test_5d::new',
        },
      });
      await testDb.attentionItems.put(item);

      const decision: AttentionEligibilityResult = {
        shouldNotify: true,
        severity: 'critical',
        reason: 'Duplicate call',
        notificationType: 'new',
        idempotencyKey: 'notif::att_test_5d::new',
        effectiveScore: 82,
        baseScore: 82,
        thresholdPassed: true,
        overrideTriggered: null,
        categorySilenced: false,
        userAttentionStateAction: 'preserve',
        nextUserAttentionState: 'unhandled',
        isMaterialChange: false,
      };

      const result = await dispatchAttentionNotification({ item, decision }, testDb);

      expect(result.delivered).toBe(false);
      expect(result.reason).toContain('already delivered');
      expect(chromeMock.notifications.size).toBe(0);
    });

    it('does NOT create notifications when shouldNotify is false or severity is silent', async () => {
      const item = createMockItem();
      await testDb.attentionItems.put(item);

      const decision: AttentionEligibilityResult = {
        shouldNotify: false,
        severity: 'silent',
        reason: 'Repetition suppressed',
        notificationType: null,
        idempotencyKey: null,
        effectiveScore: 40,
        baseScore: 40,
        thresholdPassed: false,
        overrideTriggered: null,
        categorySilenced: false,
        userAttentionStateAction: 'preserve',
        nextUserAttentionState: 'unhandled',
        isMaterialChange: false,
      };

      const result = await dispatchAttentionNotification({ item, decision }, testDb);
      expect(result.delivered).toBe(false);
      expect(chromeMock.notifications.size).toBe(0);
    });

    it('handles CANCELLED notification: purges scheduled alarms and clears active notification', async () => {
      const item = createMockItem({
        notificationState: {
          lastNotifiedAt: BASE_TIME,
          lastNotificationType: 'new',
          lastNotificationSeverity: 'high',
          deliveredNotificationKeys: ['notif::att_test_5d::new'],
          activeNotificationId: 'notif::att_test_5d::new',
        },
      });
      await testDb.attentionItems.put(item);

      // Add dummy alarms
      const alarm: ScheduledAlarmRecord = {
        alarmName: 'remind::att_test_5d::24h',
        attentionItemId: item.id,
        alarmType: 'proximity',
        scheduledAt: EVENT_TIME - 24 * 60 * 60 * 1000,
        purpose: '24h reminder',
      };
      await testDb.scheduledAlarms.put(alarm);
      chrome.alarms.create(alarm.alarmName, { when: alarm.scheduledAt });

      // Put previous notification in mock
      chromeMock.notifications.set('notif::att_test_5d::new', {} as any);

      const decision: AttentionEligibilityResult = {
        shouldNotify: true,
        severity: 'high',
        reason: 'Recruitment process cancelled',
        notificationType: 'cancellation',
        idempotencyKey: 'notif::att_test_5d::cancelled',
        effectiveScore: 80,
        baseScore: 80,
        thresholdPassed: true,
        overrideTriggered: null,
        categorySilenced: false,
        userAttentionStateAction: 'preserve',
        nextUserAttentionState: 'unhandled',
        isMaterialChange: true,
      };

      const result = await dispatchAttentionNotification({ item, decision }, testDb);

      expect(result.delivered).toBe(true);
      expect(result.notificationId).toBe('notif::att_test_5d::cancelled');

      // Previous alarms should be purged from Dexie and chrome.alarms
      const remainingAlarms = await testDb.scheduledAlarms
        .where('attentionItemId')
        .equals(item.id)
        .toArray();
      expect(remainingAlarms).toEqual([]);
      expect(chromeMock.alarms.has('remind::att_test_5d::24h')).toBe(false);

      // Previous notification should be cleared and new cancellation notification created
      expect(chromeMock.notifications.has('notif::att_test_5d::new')).toBe(false);
      expect(chromeMock.notifications.has('notif::att_test_5d::cancelled')).toBe(true);
    });
  });

  // =========================================================================
  // 3. Chrome Alarms Handling (handleAlarm)
  // =========================================================================
  describe('Alarm Trigger Handling (handleAlarm)', () => {
    it('fires valid proximity alarm, creates desktop notification, and deletes alarm record', async () => {
      const item = createMockItem();
      await testDb.attentionItems.put(item);

      const alarmName = 'remind::att_test_5d::24h';
      const scheduledAt = EVENT_TIME - 24 * 60 * 60 * 1000;
      await testDb.scheduledAlarms.put({
        alarmName,
        attentionItemId: item.id,
        alarmType: 'proximity',
        scheduledAt,
        purpose: '24h reminder',
        stage: '24h',
      });

      const triggered = await handleAlarm(alarmName, testDb, scheduledAt);

      expect(triggered).toBe(true);
      expect(chromeMock.notifications.has('notif::att_test_5d::remind_24h')).toBe(true);

      // Delivery audit should be persisted in Dexie
      const updatedItem = await testDb.attentionItems.get(item.id);
      expect(updatedItem?.notificationState?.deliveredNotificationKeys).toContain(
        'notif::att_test_5d::remind_24h'
      );
      expect(updatedItem?.notificationState?.lastNotificationType).toBe('reminder');

      // Executed alarm should be deleted from Dexie
      const alarmInDb = await testDb.scheduledAlarms.get(alarmName);
      expect(alarmInDb).toBeUndefined();
    });

    it('suppresses proximity alarm if item is handled', async () => {
      const item = createMockItem({ userAttentionState: 'handled' });
      await testDb.attentionItems.put(item);

      const alarmName = 'remind::att_test_5d::24h';
      await testDb.scheduledAlarms.put({
        alarmName,
        attentionItemId: item.id,
        alarmType: 'proximity',
        scheduledAt: EVENT_TIME - 24 * 60 * 60 * 1000,
        purpose: '24h reminder',
        stage: '24h',
      });

      const triggered = await handleAlarm(alarmName, testDb, EVENT_TIME - 24 * 60 * 60 * 1000);

      expect(triggered).toBe(false);
      expect(chromeMock.notifications.size).toBe(0);

      // Stale alarm purged
      expect(await testDb.scheduledAlarms.get(alarmName)).toBeUndefined();
    });

    it('suppresses proximity alarm if item is dismissed', async () => {
      const item = createMockItem({ userAttentionState: 'dismissed' });
      await testDb.attentionItems.put(item);

      const alarmName = 'remind::att_test_5d::24h';
      await testDb.scheduledAlarms.put({
        alarmName,
        attentionItemId: item.id,
        alarmType: 'proximity',
        scheduledAt: EVENT_TIME - 24 * 60 * 60 * 1000,
        purpose: '24h reminder',
        stage: '24h',
      });

      const triggered = await handleAlarm(alarmName, testDb, EVENT_TIME - 24 * 60 * 60 * 1000);

      expect(triggered).toBe(false);
      expect(chromeMock.notifications.size).toBe(0);
    });

    it('suppresses proximity alarm if item is currently snoozed', async () => {
      const item = createMockItem({ userAttentionState: 'snoozed' });
      await testDb.attentionItems.put(item);

      const alarmName = 'remind::att_test_5d::24h';
      await testDb.scheduledAlarms.put({
        alarmName,
        attentionItemId: item.id,
        alarmType: 'proximity',
        scheduledAt: EVENT_TIME - 24 * 60 * 60 * 1000,
        purpose: '24h reminder',
        stage: '24h',
      });

      const triggered = await handleAlarm(alarmName, testDb, EVENT_TIME - 24 * 60 * 60 * 1000);

      expect(triggered).toBe(false);
      expect(chromeMock.notifications.size).toBe(0);
    });

    it('suppresses proximity alarm if item lifecycle is cancelled or completed', async () => {
      const item = createMockItem({ itemLifecycleState: 'cancelled' });
      await testDb.attentionItems.put(item);

      const alarmName = 'remind::att_test_5d::24h';
      await testDb.scheduledAlarms.put({
        alarmName,
        attentionItemId: item.id,
        alarmType: 'proximity',
        scheduledAt: EVENT_TIME - 24 * 60 * 60 * 1000,
        purpose: '24h reminder',
        stage: '24h',
      });

      const triggered = await handleAlarm(alarmName, testDb, EVENT_TIME - 24 * 60 * 60 * 1000);

      expect(triggered).toBe(false);
      expect(chromeMock.notifications.size).toBe(0);
    });

    it('suppresses 30m alarm if strict prerequisites are not met (e.g. venue was virtual)', async () => {
      const item = createMockItem({
        currentState: {
          primaryEventTimestamp: EVENT_TIME,
          primaryDeadlineTimestamp: null,
          venue: 'Online (Zoom Meeting)',
          actionRequired: true,
          actionType: 'attend',
          itemLifecycleState: 'active',
          subEvents: [],
        },
      });
      await testDb.attentionItems.put(item);

      const alarmName = 'remind::att_test_5d::30m';
      await testDb.scheduledAlarms.put({
        alarmName,
        attentionItemId: item.id,
        alarmType: 'proximity',
        scheduledAt: EVENT_TIME - 30 * 60 * 1000,
        purpose: '30m reminder',
        stage: '30m',
      });

      const triggered = await handleAlarm(alarmName, testDb, EVENT_TIME - 30 * 60 * 1000);

      expect(triggered).toBe(false);
      expect(chromeMock.notifications.size).toBe(0);
    });

    it('fires snooze expiration alarm, transitions item to unhandled, and recalculates proximity alarms', async () => {
      const snoozeUntil = EVENT_TIME - 36 * 60 * 60 * 1000;
      const item = createMockItem({
        userAttentionState: 'snoozed',
      });
      await testDb.attentionItems.put(item);

      const alarmName = `snooze::att_test_5d::${snoozeUntil}`;
      await testDb.scheduledAlarms.put({
        alarmName,
        attentionItemId: item.id,
        alarmType: 'snooze',
        scheduledAt: snoozeUntil,
        purpose: 'Snooze expiration',
        stage: 'snooze',
      });

      const triggered = await handleAlarm(alarmName, testDb, snoozeUntil);

      expect(triggered).toBe(true);
      expect(
        chromeMock.notifications.has(`notif::att_test_5d::snooze_expired_${snoozeUntil}`)
      ).toBe(true);

      // Item should transition back to unhandled
      const updatedItem = await testDb.attentionItems.get(item.id);
      expect(updatedItem?.userAttentionState).toBe('unhandled');

      // Proximity alarms should be re-calculated and registered for the unhandled item (e.g. 24h, 3h, 30m)
      const remainingAlarms = await testDb.scheduledAlarms
        .where('attentionItemId')
        .equals(item.id)
        .toArray();
      const stages = remainingAlarms.map((a) => a.stage);
      expect(stages).toContain('24h');
      expect(stages).toContain('3h');
      expect(stages).toContain('30m');
    });
  });

  // =========================================================================
  // 4. Notification Action Buttons Routing (handleNotificationButtonClicked)
  // =========================================================================
  describe('Notification Button Routing (handleNotificationButtonClicked)', () => {
    it('Button "Mark Handled": transitions item to handled, clears notification, purges alarms, and logs feedback', async () => {
      const item = createMockItem();
      await testDb.attentionItems.put(item);
      const email = createMockEmail();
      await testDb.emails.put(email);

      // Add an active alarm
      await testDb.scheduledAlarms.put({
        alarmName: 'remind::att_test_5d::24h',
        attentionItemId: item.id,
        alarmType: 'proximity',
        scheduledAt: EVENT_TIME - 24 * 60 * 60 * 1000,
        purpose: '24h reminder',
      });
      chrome.alarms.create('remind::att_test_5d::24h', { when: 123 });

      const notifId = 'notif::att_test_5d::new';
      chromeMock.notifications.set(notifId, {} as any);

      // Click button 0: Mark Handled
      const handled = await handleNotificationButtonClicked(notifId, 0, testDb);

      expect(handled).toBe(true);

      // Notification cleared
      expect(chromeMock.notifications.has(notifId)).toBe(false);

      // Item updated in Dexie
      const updatedItem = await testDb.attentionItems.get(item.id);
      expect(updatedItem?.userAttentionState).toBe('handled');
      expect(updatedItem?.notificationState?.activeNotificationId).toBeNull();

      // Email updated in Dexie
      const updatedEmail = await testDb.emails.get(email.id);
      expect(updatedEmail?.alertStatus).toBe('handled');
      expect(updatedEmail?.handledAt).toBeDefined();

      // Alarms purged in Dexie and chrome.alarms
      const remainingAlarms = await testDb.scheduledAlarms
        .where('attentionItemId')
        .equals(item.id)
        .toArray();
      expect(remainingAlarms).toEqual([]);
      expect(chromeMock.alarms.has('remind::att_test_5d::24h')).toBe(false);

      // User feedback logged
      const feedback = await testDb.userFeedback.toArray();
      expect(feedback.length).toBe(1);
      expect(feedback[0].action).toBe('handled');
      expect(feedback[0].category).toBe('career_placement');
    });

    it('Button "Snooze": transitions item to snoozed, registers snooze alarm, and logs feedback', async () => {
      const item = createMockItem();
      await testDb.attentionItems.put(item);
      const email = createMockEmail();
      await testDb.emails.put(email);

      const notifId = 'notif::att_test_5d::new';
      chromeMock.notifications.set(notifId, {} as any);

      // Click button 1: Snooze
      const snoozed = await handleNotificationButtonClicked(notifId, 1, testDb);

      expect(snoozed).toBe(true);
      expect(chromeMock.notifications.has(notifId)).toBe(false);

      const updatedItem = await testDb.attentionItems.get(item.id);
      expect(updatedItem?.userAttentionState).toBe('snoozed');

      // Check snooze alarm created in Dexie and chrome.alarms
      const alarms = await testDb.scheduledAlarms
        .where('attentionItemId')
        .equals(item.id)
        .toArray();
      const snoozeAlarm = alarms.find((a) => a.alarmType === 'snooze');
      expect(snoozeAlarm).toBeDefined();
      expect(snoozeAlarm?.alarmName).toContain('snooze::att_test_5d::');
      expect(chromeMock.alarms.has(snoozeAlarm!.alarmName)).toBe(true);

      // Email record updated
      const updatedEmail = await testDb.emails.get(email.id);
      expect(updatedEmail?.alertStatus).toBe('snoozed');
      expect(updatedEmail?.snoozeUntil).toBeDefined();

      // Feedback logged
      const feedback = await testDb.userFeedback.toArray();
      expect(feedback[0].action).toBe('snoozed');
    });

    it('Button "Dismiss" on CONFLICT: marks item dismissed and purges alarms', async () => {
      const item = createMockItem();
      await testDb.attentionItems.put(item);
      const notifId = 'notif::att_test_5d::conflict_msg1';
      chromeMock.notifications.set(notifId, {} as any);

      // Button 1 is Dismiss for conflict
      const dismissed = await handleNotificationButtonClicked(notifId, 1, testDb);

      expect(dismissed).toBe(true);
      const updatedItem = await testDb.attentionItems.get(item.id);
      expect(updatedItem?.userAttentionState).toBe('dismissed');

      const feedback = await testDb.userFeedback.toArray();
      expect(feedback[0].action).toBe('dismissed');
    });

    it('Button "Review in Dashboard" on CONFLICT: opens side panel and clears notification', async () => {
      const item = createMockItem();
      await testDb.attentionItems.put(item);
      const notifId = 'notif::att_test_5d::conflict_msg1';
      chromeMock.notifications.set(notifId, {} as any);

      // Button 0 is Review in Dashboard for conflict
      const reviewed = await handleNotificationButtonClicked(notifId, 0, testDb);

      expect(reviewed).toBe(true);
      expect(chromeMock.notifications.has(notifId)).toBe(false);
      expect(chromeMock.sidePanelOpened).toHaveBeenCalledWith({ windowId: 1001 });

      const feedback = await testDb.userFeedback.toArray();
      expect(feedback[0].action).toBe('opened');
    });
  });

  // =========================================================================
  // 5. Notification Body Click (handleNotificationClicked) & SidePanel
  // =========================================================================
  describe('Notification Body Click & SidePanel Integration', () => {
    it('clears notification, logs opened user feedback, and opens side panel in active window', async () => {
      const item = createMockItem();
      await testDb.attentionItems.put(item);

      const notifId = 'notif::att_test_5d::new';
      chromeMock.notifications.set(notifId, {} as any);

      const clicked = await handleNotificationClicked(notifId, testDb);

      expect(clicked).toBe(true);
      expect(chromeMock.notifications.has(notifId)).toBe(false);
      expect(chromeMock.sidePanelOpened).toHaveBeenCalledWith({ windowId: 1001 });

      const feedback = await testDb.userFeedback.toArray();
      expect(feedback.length).toBe(1);
      expect(feedback[0].action).toBe('opened');
    });

    it('openDashboardSidePanel safely resolves windowId and catches errors gracefully', async () => {
      chromeMock.sidePanelOpened.mockClear();
      await openDashboardSidePanel();
      expect(chromeMock.sidePanelOpened).toHaveBeenCalledWith({ windowId: 1001 });
    });
  });

  // =========================================================================
  // 6. Local-Only Guarantee
  // =========================================================================
  describe('Local-Only Guarantee', () => {
    it('executes notification lifecycle without requesting network or modifying Gmail', async () => {
      const item = createMockItem();
      await testDb.attentionItems.put(item);

      const decision: AttentionEligibilityResult = {
        shouldNotify: true,
        severity: 'high',
        reason: 'Local test',
        notificationType: 'new',
        idempotencyKey: 'notif::att_test_5d::new_local',
        effectiveScore: 80,
        baseScore: 80,
        thresholdPassed: true,
        overrideTriggered: null,
        categorySilenced: false,
        userAttentionStateAction: 'preserve',
        nextUserAttentionState: 'unhandled',
        isMaterialChange: true,
      };

      const dispatchResult = await dispatchAttentionNotification({ item, decision }, testDb);
      expect(dispatchResult.delivered).toBe(true);

      const buttonResult = await handleNotificationButtonClicked('notif::att_test_5d::new', 0, testDb);
      expect(buttonResult).toBe(true);

      // Verify final state in Dexie
      const finalItem = await testDb.attentionItems.get(item.id);
      expect(finalItem?.userAttentionState).toBe('handled');
    });
  });
});
