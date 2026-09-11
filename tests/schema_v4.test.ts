import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { IGAMDatabase } from '../src/db/schema';
import { AttentionItem, EmailRecord, ScheduledAlarmRecord } from '../src/shared/types';
import { createAttentionItem, mutateAttentionItem } from '../src/background/analysis/change/state';
import { InvariantExtractionOutput } from '../src/background/analysis/change/types';
import { createDefaultNotificationState } from '../src/background/notifications/types';

describe('Phase 5A: Dexie Schema Version 4 & Notification State Persistence', () => {
  let dbName: string;
  let testDb: IGAMDatabase;

  beforeEach(() => {
    dbName = `test_phase5a_db_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    testDb = new IGAMDatabase(dbName);
  });

  afterEach(async () => {
    if (testDb.isOpen()) {
      testDb.close();
    }
    await testDb.delete();
  });

  it('initializes schema version 4 with scheduledAlarms indexed by attentionItemId', async () => {
    await testDb.open();
    expect(testDb.verno).toBe(4);

    // Verify all core tables exist and are accessible
    const tableNames = testDb.tables.map((t) => t.name);
    expect(tableNames).toContain('emails');
    expect(tableNames).toContain('attentionItems');
    expect(tableNames).toContain('scheduledAlarms');
    expect(tableNames).toContain('senderProfiles');
    expect(tableNames).toContain('userFeedback');
    expect(tableNames).toContain('categoryWeights');

    // Verify scheduledAlarms indexes in v4
    const alarmTable = testDb.table('scheduledAlarms');
    const alarmIndexes = alarmTable.schema.indexes.map((idx) => idx.name);
    expect(alarmIndexes).toContain('attentionItemId');
    expect(alarmIndexes).toContain('emailId');
    expect(alarmIndexes).toContain('scheduledAt');
    expect(alarmIndexes).toContain('alarmType');
  });

  it('safely migrates from schema version 3 to 4, initializing safe defaults for AttentionItems without notificationState', async () => {
    const migrationDbName = `migrate_v3_to_v4_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    // 1. Setup a legacy v3 Dexie database
    const v3Db = new Dexie(migrationDbName);
    v3Db.version(1).stores({
      emails: 'id, threadId, category, alertStatus, importanceScore, urgencyScore, processedAt, internalDate, snoozeUntil',
      senderProfiles: 'email, domain, reputationScore, lastSeen',
      userFeedback: '++id, emailId, timestamp, category, action',
      categoryWeights: 'categoryId, lastUpdated',
      scheduledAlarms: 'alarmName, emailId, scheduledAt, alarmType',
    });
    v3Db.version(2).stores({
      emails: 'id, threadId, category, alertStatus, importanceScore, urgencyScore, analysisVersion, processedAt, internalDate, snoozeUntil',
    });
    v3Db.version(3).stores({
      emails: 'id, threadId, attentionItemId, category, alertStatus, importanceScore, urgencyScore, analysisVersion, processedAt, internalDate, snoozeUntil',
      attentionItems: 'id, identityKey, category, canonicalEntity, itemLifecycleState, userAttentionState, firstSeenAt, lastSeenAt, latestEmailId',
    });
    await v3Db.open();

    // 2. Insert a realistic Phase 4 AttentionItem that has NO notificationState field
    const legacyAttentionItem: any = {
      id: 'att_legacy_smart_data',
      identityKey: 'career_placement::smart data solutions::role_software',
      category: 'career_placement',
      canonicalEntity: 'smart data solutions',
      entityStatus: 'known',
      topicScope: 'role_software',
      topicStatus: 'known',
      threadIds: ['th_smart_1'],
      messageIds: ['msg_smart_1'],
      latestEmailId: 'msg_smart_1',
      firstSeenAt: 1726500000000,
      lastSeenAt: 1726500000000,
      itemLifecycleState: 'active',
      userAttentionState: 'unhandled',
      importanceScore: 85,
      urgencyScore: 80,
      currentState: {
        primaryEventTimestamp: 1726585200000,
        primaryDeadlineTimestamp: null,
        venue: 'SJT 717',
        actionRequired: true,
        actionType: 'attend',
        itemLifecycleState: 'active',
        subEvents: [],
      },
      history: [
        {
          emailId: 'msg_smart_1',
          internalDate: 1726500000000,
          recordedAt: 1726500000000,
          relation: 'NEW',
          deltas: [],
          summary: 'Initial item creation',
        },
      ],
      // notificationState is intentionally undefined
    };

    // Insert a legacy scheduledAlarm that has NO attentionItemId field
    const legacyAlarm: any = {
      alarmName: 'alarm_legacy_1',
      emailId: 'msg_smart_1',
      alarmType: 'reminder',
      scheduledAt: 1726580000000,
      purpose: 'Upcoming event reminder',
      // attentionItemId is intentionally undefined
    };

    await v3Db.table('attentionItems').add(legacyAttentionItem);
    await v3Db.table('scheduledAlarms').add(legacyAlarm);
    v3Db.close();

    // 3. Open database with IGAMDatabase which runs v4 upgrade
    const migratedDb = new IGAMDatabase(migrationDbName);
    await migratedDb.open();
    expect(migratedDb.verno).toBe(4);

    // 4. Verify AttentionItem has safe notificationState initialized
    const itemAfterMigration = await migratedDb.attentionItems.get('att_legacy_smart_data');
    expect(itemAfterMigration).toBeDefined();
    expect(itemAfterMigration?.notificationState).toBeDefined();
    expect(itemAfterMigration?.notificationState?.lastNotifiedAt).toBeNull();
    expect(itemAfterMigration?.notificationState?.lastNotificationType).toBeNull();
    expect(itemAfterMigration?.notificationState?.lastNotificationSeverity).toBeNull();
    expect(itemAfterMigration?.notificationState?.deliveredNotificationKeys).toEqual([]);
    expect(itemAfterMigration?.notificationState?.activeNotificationId).toBeNull();

    // 5. Verify all existing AttentionItem facts are 100% intact
    expect(itemAfterMigration?.id).toBe('att_legacy_smart_data');
    expect(itemAfterMigration?.identityKey).toBe('career_placement::smart data solutions::role_software');
    expect(itemAfterMigration?.canonicalEntity).toBe('smart data solutions');
    expect(itemAfterMigration?.topicScope).toBe('role_software');
    expect(itemAfterMigration?.itemLifecycleState).toBe('active');
    expect(itemAfterMigration?.userAttentionState).toBe('unhandled');
    expect(itemAfterMigration?.importanceScore).toBe(85);
    expect(itemAfterMigration?.urgencyScore).toBe(80);
    expect(itemAfterMigration?.currentState.venue).toBe('SJT 717');
    expect(itemAfterMigration?.currentState.primaryEventTimestamp).toBe(1726585200000);
    expect(itemAfterMigration?.history.length).toBe(1);

    // 6. Verify legacy scheduledAlarm has attentionItemId defaulted to null
    const alarmAfterMigration = await migratedDb.scheduledAlarms.get('alarm_legacy_1');
    expect(alarmAfterMigration).toBeDefined();
    expect(alarmAfterMigration?.attentionItemId).toBeNull();
    expect(alarmAfterMigration?.emailId).toBe('msg_smart_1');
    expect(alarmAfterMigration?.scheduledAt).toBe(1726580000000);

    migratedDb.close();
    await migratedDb.delete();
  });

  it('persists and retrieves AttentionItem with populated notificationState', async () => {
    await testDb.open();

    const attentionItem: AttentionItem = {
      id: 'att_persisted_test',
      identityKey: 'career_placement::ujjivan::null',
      category: 'career_placement',
      canonicalEntity: 'ujjivan',
      entityStatus: 'known',
      topicScope: null,
      topicStatus: 'unknown',
      threadIds: ['th_1'],
      messageIds: ['msg_1'],
      latestEmailId: 'msg_1',
      firstSeenAt: 1726500000000,
      lastSeenAt: 1726500000000,
      itemLifecycleState: 'active',
      userAttentionState: 'unhandled',
      importanceScore: 80,
      urgencyScore: 75,
      currentState: {
        primaryEventTimestamp: 1726580000000,
        primaryDeadlineTimestamp: null,
        venue: 'SJT 706',
        actionRequired: true,
        actionType: 'attend',
        itemLifecycleState: 'active',
        subEvents: [],
      },
      history: [],
      notificationState: {
        lastNotifiedAt: 1726501000000,
        lastNotificationType: 'new',
        lastNotificationSeverity: 'high',
        deliveredNotificationKeys: ['new', 'remind_24h'],
        activeNotificationId: 'notif::att_persisted_test::new',
      },
    };

    await testDb.attentionItems.put(attentionItem);

    const retrieved = await testDb.attentionItems.get('att_persisted_test');
    expect(retrieved).toBeDefined();
    expect(retrieved?.notificationState?.lastNotifiedAt).toBe(1726501000000);
    expect(retrieved?.notificationState?.lastNotificationType).toBe('new');
    expect(retrieved?.notificationState?.lastNotificationSeverity).toBe('high');
    expect(retrieved?.notificationState?.deliveredNotificationKeys).toEqual(['new', 'remind_24h']);
    expect(retrieved?.notificationState?.activeNotificationId).toBe('notif::att_persisted_test::new');
  });

  it('persists scheduledAlarms and allows fast index queries by attentionItemId', async () => {
    await testDb.open();

    const alarm1: ScheduledAlarmRecord = {
      alarmName: 'remind::att_target::24h',
      attentionItemId: 'att_target',
      emailId: 'msg_1',
      alarmType: 'proximity',
      stage: '24h',
      scheduledAt: 1726550000000,
      purpose: '24 hour reminder',
      createdAt: Date.now(),
    };

    const alarm2: ScheduledAlarmRecord = {
      alarmName: 'remind::att_target::3h',
      attentionItemId: 'att_target',
      emailId: 'msg_1',
      alarmType: 'proximity',
      stage: '3h',
      scheduledAt: 1726580000000,
      purpose: '3 hour reminder',
      createdAt: Date.now(),
    };

    const alarmOther: ScheduledAlarmRecord = {
      alarmName: 'remind::att_other::24h',
      attentionItemId: 'att_other',
      emailId: 'msg_2',
      alarmType: 'proximity',
      stage: '24h',
      scheduledAt: 1726590000000,
      purpose: 'Other item reminder',
      createdAt: Date.now(),
    };

    await testDb.scheduledAlarms.bulkPut([alarm1, alarm2, alarmOther]);

    // Query alarms for specific attentionItemId
    const targetAlarms = await testDb.scheduledAlarms.where('attentionItemId').equals('att_target').toArray();
    expect(targetAlarms.length).toBe(2);
    expect(targetAlarms.map((a) => a.alarmName).sort()).toEqual([
      'remind::att_target::24h',
      'remind::att_target::3h',
    ]);

    // Query by alarmType
    const proximityAlarms = await testDb.scheduledAlarms.where('alarmType').equals('proximity').toArray();
    expect(proximityAlarms.length).toBe(3);
  });

  it('createAttentionItem initializes safe default notificationState', () => {
    const dummyEmail: EmailRecord = {
      id: 'msg_test_create',
      threadId: 'th_test_create',
      subject: 'Ujjivan Small Finance Bank PPT',
      from: 'cdc@vit.ac.in',
      fromDomain: 'vit.ac.in',
      to: ['student@vit.ac.in'],
      snippet: 'PPT scheduled on 16th September',
      internalDate: 1726400000000,
      processedAt: 1726400000000,
      bodyTextPreview: 'PPT scheduled on 16th September @ SJT 706',
      labels: ['INBOX'],
      isUnread: true,
      category: 'career_placement',
      confidence: 0.9,
      importanceScore: 80,
      urgencyScore: 70,
      actionRequired: true,
      actionType: 'attend',
      detectionReasons: [],
      extractedEntities: { deadlines: [], dates: [], organizations: [], locations: [], ctc: null, urls: [] },
      alertStatus: 'pending',
      snoozeUntil: null,
      handledAt: null,
    };

    const dummyInvariants: InvariantExtractionOutput = {
      canonicalEntity: 'ujjivan small finance bank',
      entityStatus: 'known',
      topicScope: null,
      topicStatus: 'unknown',
      rawTopic: null,
      venue: 'SJT 706',
      venueType: 'physical',
      reminderSignals: { isReminder: false, isUrgentTone: false, isFinalNotice: false, cues: [] },
      evidence: [],
    };

    const item = createAttentionItem(dummyEmail, dummyInvariants);
    expect(item.notificationState).toBeDefined();
    expect(item.notificationState).toEqual(createDefaultNotificationState());
  });

  it('mutateAttentionItem preserves existing notificationState and delivered keys', () => {
    const baseItem: AttentionItem = {
      id: 'att_mutate_test',
      identityKey: 'career_placement::test::role',
      category: 'career_placement',
      canonicalEntity: 'test',
      entityStatus: 'known',
      topicScope: 'role',
      topicStatus: 'known',
      threadIds: ['th_1'],
      messageIds: ['msg_1'],
      latestEmailId: 'msg_1',
      firstSeenAt: 1726500000000,
      lastSeenAt: 1726500000000,
      itemLifecycleState: 'active',
      userAttentionState: 'unhandled',
      importanceScore: 80,
      urgencyScore: 70,
      currentState: {
        primaryEventTimestamp: 1726580000000,
        primaryDeadlineTimestamp: null,
        venue: 'SJT 706',
        actionRequired: true,
        actionType: 'attend',
        itemLifecycleState: 'active',
        subEvents: [],
      },
      history: [],
      notificationState: {
        lastNotifiedAt: 1726501000000,
        lastNotificationType: 'new',
        lastNotificationSeverity: 'high',
        deliveredNotificationKeys: ['new', 'remind_24h'],
        activeNotificationId: 'notif::att_mutate_test::new',
      },
    };

    const updateEmail: EmailRecord = {
      id: 'msg_update_2',
      threadId: 'th_1',
      subject: 'Update: Venue change to SJT 717',
      from: 'cdc@vit.ac.in',
      fromDomain: 'vit.ac.in',
      to: ['student@vit.ac.in'],
      snippet: 'Venue changed to SJT 717',
      internalDate: 1726505000000,
      processedAt: 1726505000000,
      bodyTextPreview: 'Venue changed to SJT 717',
      labels: ['INBOX'],
      isUnread: true,
      category: 'career_placement',
      confidence: 0.9,
      importanceScore: 80,
      urgencyScore: 70,
      actionRequired: true,
      actionType: 'attend',
      detectionReasons: [],
      extractedEntities: { deadlines: [], dates: [], organizations: [], locations: [], ctc: null, urls: [] },
      alertStatus: 'pending',
      snoozeUntil: null,
      handledAt: null,
    };

    const invariants: InvariantExtractionOutput = {
      canonicalEntity: 'test',
      entityStatus: 'known',
      topicScope: 'role',
      topicStatus: 'known',
      rawTopic: null,
      venue: 'SJT 717',
      venueType: 'physical',
      reminderSignals: { isReminder: false, isUrgentTone: false, isFinalNotice: false, cues: [] },
      evidence: [],
    };

    const mutated = mutateAttentionItem(
      baseItem,
      updateEmail,
      invariants,
      'UPDATE',
      [{ field: 'venue', oldValue: 'SJT 706', newValue: 'SJT 717', changeType: 'updated', description: 'Venue updated' }],
      'Venue changed from SJT 706 to SJT 717'
    );

    // Mutated item must preserve the existing notificationState intact
    expect(mutated.notificationState).toBeDefined();
    expect(mutated.notificationState?.lastNotifiedAt).toBe(1726501000000);
    expect(mutated.notificationState?.deliveredNotificationKeys).toEqual(['new', 'remind_24h']);
    expect(mutated.notificationState?.activeNotificationId).toBe('notif::att_mutate_test::new');
  });
});
