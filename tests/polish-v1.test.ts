import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { IGAMDatabase } from '../src/db';
import { storage } from '../src/shared/storage';
import { AttentionItem, EmailRecord, ScheduledAlarmRecord } from '../src/shared/types';
import {
  bulkMarkHandled,
  buildNotificationPayload,
  cleanSubject,
  formatNotificationTiming,
  getNotificationActionPhrase,
  resolveNotificationEntityLabel,
} from '../src/background/notifications/engine';

function setupChromeMock() {
  const notifications = new Map<string, any>();
  const alarms = new Map<string, any>();

  const mockChrome = {
    notifications: {
      create: vi.fn((id: string, options: any, cb?: (id: string) => void) => {
        notifications.set(id, options);
        if (cb) cb(id);
        return Promise.resolve(id);
      }),
      clear: vi.fn((id: string, cb?: (wasCleared: boolean) => void) => {
        const wasPresent = notifications.delete(id);
        if (cb) cb(wasPresent);
        return Promise.resolve(wasPresent);
      }),
      getAll: vi.fn((cb: (n: Record<string, any>) => void) => {
        const obj: Record<string, any> = {};
        notifications.forEach((v, k) => (obj[k] = v));
        cb(obj);
      }),
    },
    alarms: {
      create: vi.fn((name: string, info: any) => {
        alarms.set(name, info);
      }),
      clear: vi.fn((name: string, cb?: (wasCleared: boolean) => void) => {
        const wasPresent = alarms.delete(name);
        if (cb) cb(wasPresent);
        return Promise.resolve(wasPresent);
      }),
      getAll: vi.fn((cb: (a: any[]) => void) => {
        const list: any[] = [];
        alarms.forEach((info, name) => list.push({ name, scheduledTime: info.when || Date.now() }));
        cb(list);
      }),
    },
    runtime: {
      getURL: (path: string) => `chrome-extension://mock_extension_id/${path}`,
    },
  };

  (globalThis as any).chrome = mockChrome;
  return { notifications, alarms };
}

describe('Gmail Attention Manager v1.0.0: Final UI/UX & Notification Polish', () => {
  let testDb: IGAMDatabase;
  let dbName: string;
  let chromeMock: ReturnType<typeof setupChromeMock>;

  const NOW = 1726585200000; // Reference timestamp

  beforeEach(async () => {
    chromeMock = setupChromeMock();
    dbName = `test_polish_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    testDb = new IGAMDatabase(dbName);
    await testDb.open();
  });

  afterEach(async () => {
    if (testDb.isOpen()) {
      testDb.close();
    }
    await testDb.delete();
  });

  function createMockAttentionItem(overrides: Partial<AttentionItem> = {}): AttentionItem {
    return {
      id: `att_${Math.random().toString(36).slice(2)}`,
      identityKey: 'career_placement::deloitte::role_sde',
      category: 'career_placement',
      canonicalEntity: 'Deloitte',
      entityStatus: 'known',
      topicScope: 'role_sde',
      topicStatus: 'known',
      threadIds: ['th_01'],
      messageIds: ['msg_01'],
      latestEmailId: 'msg_01',
      firstSeenAt: NOW - 3600000,
      lastSeenAt: NOW,
      itemLifecycleState: 'active',
      userAttentionState: 'unhandled',
      importanceScore: 85,
      urgencyScore: 80,
      currentState: {
        primaryEventTimestamp: NOW + 3600000 * 24,
        primaryDeadlineTimestamp: null,
        venue: 'SJT 717',
        actionRequired: true,
        actionType: 'attend',
        itemLifecycleState: 'active',
        subEvents: [
          {
            subEventId: 'sub_01',
            label: 'Pre-Placement Talk',
            type: 'event',
            timestamp: NOW + 3600000 * 24,
            endTimestamp: null,
            timePrecision: 'exact',
            venue: 'SJT 717',
            status: 'active',
          },
        ],
      },
      history: [],
      notificationState: {
        lastNotifiedAt: NOW - 1800000,
        lastNotificationType: 'new',
        lastNotificationSeverity: 'high',
        deliveredNotificationKeys: ['notif::test::new'],
        activeNotificationId: 'notif::test::active_123',
      },
      ...overrides,
    };
  }

  function createMockEmail(overrides: Partial<EmailRecord> = {}): EmailRecord {
    return {
      id: 'msg_01',
      threadId: 'th_01',
      subject: 'Deloitte Campus Recruitment Drive',
      from: 'Campus Relations <campus@deloitte.com>',
      fromDomain: 'deloitte.com',
      snippet: 'Pre-Placement Talk scheduled tomorrow in SJT 717',
      internalDate: NOW - 3600000,
      processedAt: NOW - 3500000,
      bodyTextPreview: 'Pre-Placement Talk scheduled tomorrow in SJT 717',
      category: 'career_placement',
      confidence: 0.95,
      importanceScore: 85,
      urgencyScore: 80,
      actionRequired: true,
      actionType: 'attend',
      detectionReasons: ['Placement keyword detected'],
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
      ...overrides,
    };
  }

  // =========================================================================
  // 1. Bulk Mark Handled Requirements
  // =========================================================================
  describe('Bulk Mark Handled Actions', () => {
    it('marks all unhandled attention items as handled and clears desktop notifications and alarms', async () => {
      // 1. Setup 3 items: 2 unhandled, 1 snoozed
      const item1 = createMockAttentionItem({
        id: 'att_1',
        latestEmailId: 'msg_1',
        userAttentionState: 'unhandled',
        notificationState: {
          lastNotifiedAt: NOW,
          lastNotificationType: 'new',
          lastNotificationSeverity: 'high',
          deliveredNotificationKeys: [],
          activeNotificationId: 'notif::att_1::active',
        },
      });
      const item2 = createMockAttentionItem({
        id: 'att_2',
        latestEmailId: 'msg_2',
        userAttentionState: 'unhandled',
        notificationState: {
          lastNotifiedAt: NOW,
          lastNotificationType: 'new',
          lastNotificationSeverity: 'high',
          deliveredNotificationKeys: [],
          activeNotificationId: 'notif::att_2::active',
        },
      });
      const item3 = createMockAttentionItem({
        id: 'att_3',
        latestEmailId: 'msg_3',
        userAttentionState: 'snoozed',
      });

      await testDb.attentionItems.bulkPut([item1, item2, item3]);

      // Add corresponding emails
      const email1 = createMockEmail({ id: 'msg_1', alertStatus: 'pending' });
      const email2 = createMockEmail({ id: 'msg_2', alertStatus: 'pending' });
      const email3 = createMockEmail({ id: 'msg_3', alertStatus: 'snoozed' });
      await testDb.emails.bulkPut([email1, email2, email3]);

      // Add active notifications and scheduled alarms
      chromeMock.notifications.set('notif::att_1::active', {});
      chromeMock.notifications.set('notif::att_2::active', {});

      const alarm1: ScheduledAlarmRecord = {
        alarmName: 'remind::att_1::24h',
        attentionItemId: 'att_1',
        alarmType: 'proximity',
        purpose: 'proximity reminder',
        stage: '24h',
        scheduledAt: NOW + 100000,
        createdAt: NOW,
      };
      const alarm2: ScheduledAlarmRecord = {
        alarmName: 'remind::att_2::24h',
        attentionItemId: 'att_2',
        alarmType: 'proximity',
        purpose: 'proximity reminder',
        stage: '24h',
        scheduledAt: NOW + 100000,
        createdAt: NOW,
      };
      await testDb.scheduledAlarms.bulkPut([alarm1, alarm2]);
      chromeMock.alarms.set(alarm1.alarmName, { when: alarm1.scheduledAt });
      chromeMock.alarms.set(alarm2.alarmName, { when: alarm2.scheduledAt });

      // 2. Execute bulk mark handled
      const result = await bulkMarkHandled(testDb);

      // 3. Verify counts & response
      expect(result.success).toBe(true);
      expect(result.handledCount).toBe(2);
      expect(result.itemIds).toEqual(['att_1', 'att_2']);

      // 4. Verify unhandled items transitioned to handled
      const updated1 = await testDb.attentionItems.get('att_1');
      const updated2 = await testDb.attentionItems.get('att_2');
      const updated3 = await testDb.attentionItems.get('att_3');

      expect(updated1?.userAttentionState).toBe('handled');
      expect(updated1?.notificationState?.activeNotificationId).toBeNull();
      expect(updated2?.userAttentionState).toBe('handled');
      expect(updated2?.notificationState?.activeNotificationId).toBeNull();

      // Snoozed item must be completely untouched
      expect(updated3?.userAttentionState).toBe('snoozed');

      // 5. Verify factual analysis fields are untouched
      expect(updated1?.importanceScore).toBe(85);
      expect(updated1?.urgencyScore).toBe(80);
      expect(updated1?.category).toBe('career_placement');
      expect(updated1?.canonicalEntity).toBe('Deloitte');
      expect(updated1?.currentState.venue).toBe('SJT 717');

      // 6. Verify notifications were cleared
      expect(chromeMock.notifications.has('notif::att_1::active')).toBe(false);
      expect(chromeMock.notifications.has('notif::att_2::active')).toBe(false);

      // 7. Verify scheduled alarms were purged
      const remainingAlarms = await testDb.scheduledAlarms.toArray();
      expect(remainingAlarms.length).toBe(0);
      expect(chromeMock.alarms.has('remind::att_1::24h')).toBe(false);
      expect(chromeMock.alarms.has('remind::att_2::24h')).toBe(false);

      // 8. Verify emails were updated in Dexie
      const dbEmail1 = await testDb.emails.get('msg_1');
      const dbEmail2 = await testDb.emails.get('msg_2');
      const dbEmail3 = await testDb.emails.get('msg_3');
      expect(dbEmail1?.alertStatus).toBe('handled');
      expect(dbEmail1?.handledAt).toBeTypeOf('number');
      expect(dbEmail2?.alertStatus).toBe('handled');
      expect(dbEmail2?.handledAt).toBeTypeOf('number');
      expect(dbEmail3?.alertStatus).toBe('snoozed'); // untouched
    });

    it('handles empty queue gracefully when no unhandled items exist', async () => {
      const result = await bulkMarkHandled(testDb);
      expect(result.success).toBe(true);
      expect(result.handledCount).toBe(0);
      expect(result.itemIds).toEqual([]);
    });

    it('is strictly idempotent on repeated calls', async () => {
      const item = createMockAttentionItem({ id: 'att_idem_1' });
      await testDb.attentionItems.put(item);

      const run1 = await bulkMarkHandled(testDb);
      expect(run1.handledCount).toBe(1);

      const run2 = await bulkMarkHandled(testDb);
      expect(run2.handledCount).toBe(0);
      expect(run2.itemIds).toEqual([]);
    });

    it('preserves account-scoped decision across reconnects when accountEmail is active', async () => {
      await storage.setSyncState({
        authState: 'connected',
        accountEmail: 'student@university.edu',
        lastSyncTime: Date.now(),
        historyId: 'hist_123',
      });

      const item = createMockAttentionItem({ id: 'att_pers_1', latestEmailId: 'msg_pers_1' });
      await testDb.attentionItems.put(item);
      await testDb.emails.put(createMockEmail({ id: 'msg_pers_1' }));

      await bulkMarkHandled(testDb);

      const accountHistory = await storage.getAccountAttentionHistory('student@university.edu');
      expect(accountHistory['msg_pers_1']).toBeDefined();
      expect(accountHistory['msg_pers_1'].state).toBe('handled');
    });
  });

  // =========================================================================
  // 2. Notification UX & Dynamic Copy Polish
  // =========================================================================
  describe('Notification Content & Title Polish', () => {
    it('uses canonicalEntity and action phrase for descriptive titles', () => {
      const item = createMockAttentionItem({
        canonicalEntity: 'Smart Data Solutions',
        currentState: {
          primaryEventTimestamp: NOW + 3 * 3600000,
          primaryDeadlineTimestamp: null,
          venue: 'SJT 717',
          actionRequired: true,
          actionType: 'attend',
          itemLifecycleState: 'active',
          subEvents: [
            {
              subEventId: 'sub_ppt',
              label: 'Pre-Placement Talk',
              type: 'event',
              timestamp: NOW + 3 * 3600000,
              endTimestamp: null,
              timePrecision: 'exact',
              venue: 'SJT 717',
              status: 'active',
            },
          ],
        },
      });

      const payload = buildNotificationPayload(item, 'reminder', 'critical', null, {
        stage: '3h',
      });

      // Must preserve the prefix
      expect(payload.title).toContain('🚨 [FINAL CALL]');
      // Must contain real entity and real action, NOT generic Academic Education
      expect(payload.title).toContain('Smart Data Solutions');
      expect(payload.title).toContain('Pre-Placement Talk');
      expect(payload.title).not.toContain('Academic Education');
      expect(payload.message).toContain('3 hours');
      expect(payload.message).toContain('SJT 717');
    });

    it('falls back to clean subject instead of category name when canonicalEntity is absent', () => {
      const item = createMockAttentionItem({
        canonicalEntity: null,
        category: 'academic_education',
        currentState: {
          primaryEventTimestamp: NOW + 3 * 3600000,
          primaryDeadlineTimestamp: null,
          venue: 'Hall A',
          actionRequired: true,
          actionType: 'attend',
          itemLifecycleState: 'active',
          subEvents: [],
        },
      });

      const email = createMockEmail({
        subject: 'Re: [Urgent] Midterm Examination Schedule Announcement',
      });

      const payload = buildNotificationPayload(item, 'reminder', 'critical', email, {
        stage: '3h',
      });

      expect(payload.title).toContain('🚨 [FINAL CALL]');
      // Must use clean subject, NOT "Academic Education"
      expect(payload.title).toContain('Midterm Examination Schedule Announcement');
      expect(payload.title).not.toContain('Academic Education');
      expect(payload.title).not.toContain('Re:');
      expect(payload.title).not.toContain('[Urgent]');
    });

    it('derives action phrase from actionType when subEvents label is missing', () => {
      const item = createMockAttentionItem({
        canonicalEntity: 'Google',
        currentState: {
          primaryEventTimestamp: NOW + 24 * 3600000,
          primaryDeadlineTimestamp: null,
          venue: null,
          actionRequired: true,
          actionType: 'submit',
          itemLifecycleState: 'active',
          subEvents: [],
        },
      });

      const payload = buildNotificationPayload(item, 'reminder', 'standard', null, {
        stage: '24h',
      });

      expect(payload.title).toContain('📌 [REMINDER - 24h]');
      expect(payload.title).toContain('Google - Submission Deadline');
    });

    it('never invents an exact time when timePrecision is unknown or date_only', () => {
      const item = createMockAttentionItem({
        canonicalEntity: 'TCS',
        currentState: {
          primaryEventTimestamp: NOW + 24 * 3600000,
          primaryDeadlineTimestamp: null,
          venue: null,
          actionRequired: true,
          actionType: 'attend',
          itemLifecycleState: 'active',
          subEvents: [
            {
              subEventId: 'sub_01',
              label: 'Interview',
              type: 'event',
              timestamp: NOW + 24 * 3600000,
              endTimestamp: null,
              timePrecision: 'unknown', // date only without exact time!
              venue: null,
              status: 'active',
            },
          ],
        },
      });

      const payload = buildNotificationPayload(item, 'reminder', 'standard', null, {
        stage: '24h',
      });

      // Must not contain ":00 AM" or ":00 PM" fake times
      expect(payload.message).not.toMatch(/\d{1,2}:\d{2}\s*(?:AM|PM)/i);
    });

    it('preserves all notification prefixes across severity and type variations', () => {
      const item = createMockAttentionItem();

      expect(buildNotificationPayload(item, 'new', 'critical').title).toContain('🚨 [URGENT]');
      expect(buildNotificationPayload(item, 'new', 'high').title).toContain('⚠️ [IMPORTANT]');
      expect(buildNotificationPayload(item, 'new', 'standard').title).toContain('📌 [ATTENTION]');
      expect(buildNotificationPayload(item, 'conflict', 'critical').title).toContain('🚨 [CONFLICT]');
      expect(buildNotificationPayload(item, 'cancellation', 'high').title).toContain('⚠️ [CANCELLED]');
      expect(buildNotificationPayload(item, 'reminder', 'critical', null, { stage: '30m' }).title).toContain('🚨 [STARTING SOON]');
      expect(buildNotificationPayload(item, 'reminder', 'critical', null, { stage: '3h' }).title).toContain('🚨 [FINAL CALL]');
      expect(buildNotificationPayload(item, 'reminder', 'standard', null, { stage: '24h' }).title).toContain('📌 [REMINDER - 24h]');
      expect(buildNotificationPayload(item, 'reminder', 'standard', null, { stage: '48h' }).title).toContain('⚠️ [REMINDER - 48h]');
      expect(buildNotificationPayload(item, 'snooze_expired', 'high', null, { snoozeUntil: NOW }).title).toContain('⏰ [SNOOZE EXPIRED]');
    });
  });

  // =========================================================================
  // 3. Helper Functions Verification
  // =========================================================================
  describe('Helper Functions (cleanSubject, formatNotificationTiming, etc.)', () => {
    it('cleans various email subject prefixes cleanly', () => {
      expect(cleanSubject('Fwd: Re: [Urgent] Interview Call Letter')).toBe('Interview Call Letter');
      expect(cleanSubject('URGENT: Placement Test Link')).toBe('Placement Test Link');
      expect(cleanSubject('[Important] Campus Update')).toBe('Campus Update');
      expect(cleanSubject('Normal Subject')).toBe('Normal Subject');
      expect(cleanSubject(null)).toBeNull();
      expect(cleanSubject('')).toBeNull();
    });

    it('formats notification timing truthfully relative to reference time', () => {
      const ref = new Date('2026-09-18T10:00:00Z').getTime();
      const sameDay = new Date('2026-09-18T16:30:00Z').getTime();
      const nextDay = new Date('2026-09-19T14:00:00Z').getTime();
      const nextDayDateOnly = new Date('2026-09-19T00:00:00Z').getTime();

      // Same day with exact time
      const resSameDay = formatNotificationTiming(sameDay, 'exact', ref);
      expect(resSameDay).toContain('today at');

      // Tomorrow with exact time
      const resNextDay = formatNotificationTiming(nextDay, 'exact', ref);
      expect(resNextDay).toContain('tomorrow at');

      // Tomorrow date_only (no hour/minute)
      const resDateOnly = formatNotificationTiming(nextDayDateOnly, 'date_only', ref);
      expect(resDateOnly).toBe('tomorrow');
    });

    it('resolves notification entity label with proper fallback priority', () => {
      const itemWithEntity = createMockAttentionItem({ canonicalEntity: 'Microsoft' });
      expect(resolveNotificationEntityLabel(itemWithEntity)).toBe('Microsoft');

      const itemNoEntityWithSubject = createMockAttentionItem({ canonicalEntity: null });
      const email = createMockEmail({ subject: 'Re: Coding Round Results' });
      expect(resolveNotificationEntityLabel(itemNoEntityWithSubject, email)).toBe('Coding Round Results');

      const itemNoEntityNoSubject = createMockAttentionItem({
        canonicalEntity: null,
        topicScope: 'internship_drive',
      });
      expect(resolveNotificationEntityLabel(itemNoEntityNoSubject, null)).toBe('Internship Drive');

      const itemAllEmpty = createMockAttentionItem({
        canonicalEntity: null,
        topicScope: null,
        category: 'academic_education',
      });
      expect(resolveNotificationEntityLabel(itemAllEmpty, null)).toBe('Academic Education');
    });
  });
});
