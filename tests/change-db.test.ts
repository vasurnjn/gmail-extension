import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { IGAMDatabase } from '../src/db/schema';
import {
  AttentionItem,
  EmailRecord,
  ItemLifecycleState,
  UserAttentionState,
} from '../src/shared/types';

describe('Phase 4B: Dexie Schema Version 3 & AttentionItem Persistence', () => {
  let dbName: string;
  let testDb: IGAMDatabase;

  beforeEach(() => {
    dbName = `test_change_db_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    testDb = new IGAMDatabase(dbName);
  });

  afterEach(async () => {
    if (testDb.isOpen()) {
      testDb.close();
    }
    await testDb.delete();
  });

  it('initializes schema version 3 with attentionItems and updated emails index', async () => {
    await testDb.open();
    expect(testDb.verno).toBeGreaterThanOrEqual(3);

    // Verify attentionItems table exists and is accessible
    expect(testDb.attentionItems).toBeDefined();
    expect(testDb.emails).toBeDefined();

    // Verify table structure in Dexie tables array
    const tableNames = testDb.tables.map((t) => t.name);
    expect(tableNames).toContain('attentionItems');
    expect(tableNames).toContain('emails');
    expect(tableNames).toContain('senderProfiles');
    expect(tableNames).toContain('userFeedback');
    expect(tableNames).toContain('categoryWeights');
    expect(tableNames).toContain('scheduledAlarms');

    // Verify index names on attentionItems table
    const attentionItemTable = testDb.table('attentionItems');
    const attentionIndexes = attentionItemTable.schema.indexes.map((idx) => idx.name);
    expect(attentionIndexes).toContain('identityKey');
    expect(attentionIndexes).toContain('category');
    expect(attentionIndexes).toContain('canonicalEntity');
    expect(attentionIndexes).toContain('itemLifecycleState');
    expect(attentionIndexes).toContain('userAttentionState');
    expect(attentionIndexes).toContain('firstSeenAt');
    expect(attentionIndexes).toContain('lastSeenAt');
    expect(attentionIndexes).toContain('latestEmailId');

    // Verify attentionItemId index on emails table
    const emailsTable = testDb.table('emails');
    const emailIndexes = emailsTable.schema.indexes.map((idx) => idx.name);
    expect(emailIndexes).toContain('attentionItemId');
  });

  it('safely migrates from schema version 2 to 3 without losing existing email data', async () => {
    const migrationDbName = `migrate_v2_to_v3_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    // 1. Simulate an existing v2 database
    const v2Db = new Dexie(migrationDbName);
    v2Db.version(1).stores({
      emails: 'id, threadId, category, alertStatus, importanceScore, urgencyScore, processedAt, internalDate, snoozeUntil',
      senderProfiles: 'email, domain, reputationScore, lastSeen',
      userFeedback: '++id, emailId, timestamp, category, action',
      categoryWeights: 'categoryId, lastUpdated',
      scheduledAlarms: 'alarmName, emailId, scheduledAt, alarmType',
    });
    v2Db.version(2).stores({
      emails: 'id, threadId, category, alertStatus, importanceScore, urgencyScore, analysisVersion, processedAt, internalDate, snoozeUntil',
    });
    await v2Db.open();

    // 2. Add realistic existing records with Phase 1/2/3 data (no attentionItemId/changeRelation)
    const existingEmail: any = {
      id: 'msg_legacy_101',
      threadId: 'th_legacy_101',
      subject: 'Deloitte Campus Recruitment PPT on Sep 17',
      from: 'placement@university.edu',
      fromDomain: 'university.edu',
      to: ['student@university.edu'],
      snippet: 'Deloitte will conduct PPT on Sep 17 at 5 PM in SJT 717.',
      internalDate: 1726500000000,
      processedAt: 1726500010000,
      bodyTextPreview: 'Deloitte will conduct PPT on Sep 17 at 5 PM in SJT 717.',
      labels: ['INBOX'],
      isUnread: true,
      analysisVersion: 3,
      category: 'career_placement',
      confidence: 0.95,
      categoryScore: 90,
      categoryScores: { career_placement: 90 },
      importanceScore: 85,
      importanceReasons: ['High placement signal'],
      urgencyScore: 78,
      urgencyReasons: ['Scheduled event imminent'],
      actionRequired: true,
      actionType: 'attend',
      detectionReasons: ['Placement keyword detected'],
      extractedEntities: {
        deadlines: [],
        dates: [{ text: 'Sep 17 at 5 PM', parsedTimestamp: 1726573800000 }],
        organizations: ['Deloitte'],
        locations: ['SJT 717'],
        ctc: null,
        urls: [],
      },
      temporalAnalysis: {
        entities: [
          {
            id: 'temp_0',
            rawText: 'Sep 17 at 5 PM',
            type: 'event',
            status: 'upcoming',
            timestamp: 1726573800000,
            datePrecision: 'exact',
            timePrecision: 'exact',
            isAmbiguous: false,
            associatedAction: 'attend',
            contextSnippet: 'PPT on Sep 17 at 5 PM',
            confidence: 'HIGH',
            evidenceReasons: ['Explicit datetime match'],
          },
        ],
        primaryDeadline: null,
        primaryEvent: {
          id: 'temp_0',
          rawText: 'Sep 17 at 5 PM',
          type: 'event',
          status: 'upcoming',
          timestamp: 1726573800000,
          datePrecision: 'exact',
          timePrecision: 'exact',
          isAmbiguous: false,
          associatedAction: 'attend',
          contextSnippet: 'PPT on Sep 17 at 5 PM',
          confidence: 'HIGH',
          evidenceReasons: ['Explicit datetime match'],
        },
        hasActiveDeadline: false,
        isOverdue: false,
        hasAmbiguousDates: false,
        temporalUrgencyTier: 'upcoming',
        summaryReason: 'Upcoming event on Sep 17',
      },
      alertStatus: 'notified',
      snoozeUntil: 1726550000000,
      handledAt: null,
    };

    await v2Db.table('emails').add(existingEmail);
    v2Db.close();

    // 3. Open the database using IGAMDatabase (which declares v1, v2, and v3 with migration)
    const migratedDb = new IGAMDatabase(migrationDbName);
    await migratedDb.open();
    expect(migratedDb.verno).toBeGreaterThanOrEqual(3);

    // 4. Verify the email record is intact with all Phase 1/2/3 data preserved
    const retrieved = await migratedDb.emails.get('msg_legacy_101');
    expect(retrieved).toBeDefined();
    expect(retrieved?.id).toBe('msg_legacy_101');
    expect(retrieved?.threadId).toBe('th_legacy_101');
    expect(retrieved?.subject).toBe('Deloitte Campus Recruitment PPT on Sep 17');
    expect(retrieved?.category).toBe('career_placement');
    expect(retrieved?.importanceScore).toBe(85);
    expect(retrieved?.urgencyScore).toBe(78);
    expect(retrieved?.alertStatus).toBe('notified');
    expect(retrieved?.snoozeUntil).toBe(1726550000000);
    expect(retrieved?.temporalAnalysis?.primaryEvent?.timestamp).toBe(1726573800000);

    // 5. Verify that attentionItemId and changeRelation were safely initialized to null
    expect(retrieved?.attentionItemId).toBeNull();
    expect(retrieved?.changeRelation).toBeNull();

    migratedDb.close();
    await migratedDb.delete();
  });

  it('stores, queries, and updates AttentionItem records with full index support', async () => {
    await testDb.open();

    const sampleItem: AttentionItem = {
      id: 'att_01JMTEST001',
      identityKey: 'career_placement::deloitte::campus_drive_2027',
      category: 'career_placement',
      canonicalEntity: 'deloitte',
      entityStatus: 'known',
      topicScope: 'campus_drive_2027',
      topicStatus: 'known',
      threadIds: ['th_001', 'th_002'],
      messageIds: ['msg_001', 'msg_002'],
      latestEmailId: 'msg_002',
      firstSeenAt: 1726400000000,
      lastSeenAt: 1726500000000,
      itemLifecycleState: 'active',
      userAttentionState: 'unhandled',
      importanceScore: 88,
      urgencyScore: 80,
      currentState: {
        primaryEventTimestamp: 1726573800000,
        primaryDeadlineTimestamp: null,
        venue: 'SJT 717',
        actionRequired: true,
        actionType: 'attend',
        itemLifecycleState: 'active',
        subEvents: [
          {
            subEventId: 'sub_ppt',
            label: 'PPT Presentation',
            type: 'event',
            timestamp: 1726573800000,
            endTimestamp: null,
            timePrecision: 'exact',
            venue: 'SJT 717',
            status: 'active',
          },
        ],
      },
      history: [
        {
          emailId: 'msg_001',
          internalDate: 1726400000000,
          recordedAt: 1726400010000,
          relation: 'NEW',
          deltas: [],
          summary: 'Initial discovery of Deloitte campus drive',
        },
        {
          emailId: 'msg_002',
          internalDate: 1726500000000,
          recordedAt: 1726500010000,
          relation: 'REPEAT',
          deltas: [],
          summary: 'Reminder of Deloitte PPT',
        },
      ],
    };

    await testDb.attentionItems.add(sampleItem);

    // Fetch by primary key
    const fetched = await testDb.attentionItems.get('att_01JMTEST001');
    expect(fetched).toBeDefined();
    expect(fetched?.canonicalEntity).toBe('deloitte');
    expect(fetched?.currentState.venue).toBe('SJT 717');
    expect(fetched?.history.length).toBe(2);

    // Query by identityKey index
    const byKey = await testDb.attentionItems
      .where('identityKey')
      .equals('career_placement::deloitte::campus_drive_2027')
      .toArray();
    expect(byKey.length).toBe(1);
    expect(byKey[0].id).toBe('att_01JMTEST001');

    // Query by canonicalEntity index
    const byEntity = await testDb.attentionItems
      .where('canonicalEntity')
      .equals('deloitte')
      .toArray();
    expect(byEntity.length).toBe(1);

    // Query by category index
    const byCat = await testDb.attentionItems
      .where('category')
      .equals('career_placement')
      .toArray();
    expect(byCat.length).toBe(1);

    // Query by itemLifecycleState index
    const byLife = await testDb.attentionItems
      .where('itemLifecycleState')
      .equals('active')
      .toArray();
    expect(byLife.length).toBe(1);

    // Query by userAttentionState index
    const byUserAtt = await testDb.attentionItems
      .where('userAttentionState')
      .equals('unhandled')
      .toArray();
    expect(byUserAtt.length).toBe(1);

    // Query by latestEmailId index
    const byLatestEmail = await testDb.attentionItems
      .where('latestEmailId')
      .equals('msg_002')
      .toArray();
    expect(byLatestEmail.length).toBe(1);

    // Query by firstSeenAt range index
    const byFirstSeen = await testDb.attentionItems
      .where('firstSeenAt')
      .aboveOrEqual(1726300000000)
      .toArray();
    expect(byFirstSeen.length).toBe(1);
  });

  it('supports complete decoupling of itemLifecycleState and userAttentionState', async () => {
    await testDb.open();

    const statesToTest: Array<{
      id: string;
      life: ItemLifecycleState;
      user: UserAttentionState;
      description: string;
    }> = [
      {
        id: 'att_decouple_1',
        life: 'active',
        user: 'handled',
        description: 'Active future event already registered/handled by user',
      },
      {
        id: 'att_decouple_2',
        life: 'cancelled',
        user: 'unhandled',
        description: 'Cancelled event pending user awareness/acknowledgement',
      },
      {
        id: 'att_decouple_3',
        life: 'postponed',
        user: 'snoozed',
        description: 'Postponed event snoozed by user',
      },
      {
        id: 'att_decouple_4',
        life: 'completed',
        user: 'dismissed',
        description: 'Completed event dismissed by user',
      },
      {
        id: 'att_decouple_5',
        life: 'unknown',
        user: 'unhandled',
        description: 'Unresolved lifecycle awaiting clarification',
      },
    ];

    for (const s of statesToTest) {
      await testDb.attentionItems.add({
        id: s.id,
        identityKey: `cat::${s.id}`,
        category: 'test_category',
        canonicalEntity: 'test_entity',
        entityStatus: 'known',
        topicScope: 'test_topic',
        topicStatus: 'known',
        threadIds: ['th_test'],
        messageIds: ['msg_test'],
        latestEmailId: 'msg_test',
        firstSeenAt: Date.now(),
        lastSeenAt: Date.now(),
        itemLifecycleState: s.life,
        userAttentionState: s.user,
        importanceScore: 50,
        urgencyScore: 50,
        currentState: {
          primaryEventTimestamp: null,
          primaryDeadlineTimestamp: null,
          venue: null,
          actionRequired: false,
          actionType: null,
          itemLifecycleState: s.life,
          subEvents: [],
        },
        history: [],
      });
    }

    // Verify independent queries
    const handledActive = await testDb.attentionItems
      .where('userAttentionState')
      .equals('handled')
      .toArray();
    expect(handledActive.length).toBe(1);
    expect(handledActive[0].itemLifecycleState).toBe('active');

    const unhandledCancelled = await testDb.attentionItems
      .where('itemLifecycleState')
      .equals('cancelled')
      .toArray();
    expect(unhandledCancelled.length).toBe(1);
    expect(unhandledCancelled[0].userAttentionState).toBe('unhandled');
  });

  it('safely stores and queries attention items with unknown or ambiguous entity/topic and null identityKey', async () => {
    await testDb.open();

    // Invariant: "When identity is uncertain, do not suppress"
    // When entity is unknown or ambiguous, identityKey MUST remain null (no synthetic keys)
    const uncertainItem: AttentionItem = {
      id: 'att_uncertain_001',
      identityKey: null,
      category: 'career_placement',
      canonicalEntity: null,
      entityStatus: 'unknown',
      topicScope: null,
      topicStatus: 'unknown',
      threadIds: ['th_generic_1'],
      messageIds: ['msg_generic_1'],
      latestEmailId: 'msg_generic_1',
      firstSeenAt: 1726400000000,
      lastSeenAt: 1726400000000,
      itemLifecycleState: 'active',
      userAttentionState: 'unhandled',
      importanceScore: 70,
      urgencyScore: 65,
      currentState: {
        primaryEventTimestamp: 1726500000000,
        primaryDeadlineTimestamp: null,
        venue: 'Auditorium',
        actionRequired: true,
        actionType: 'attend',
        itemLifecycleState: 'active',
        subEvents: [],
      },
      history: [
        {
          emailId: 'msg_generic_1',
          internalDate: 1726400000000,
          recordedAt: 1726400010000,
          relation: 'NEW',
          deltas: [],
          summary: 'Generic announcement without identifiable entity',
        },
      ],
    };

    await testDb.attentionItems.add(uncertainItem);

    const fetched = await testDb.attentionItems.get('att_uncertain_001');
    expect(fetched).toBeDefined();
    expect(fetched?.identityKey).toBeNull();
    expect(fetched?.entityStatus).toBe('unknown');
    expect(fetched?.canonicalEntity).toBeNull();
    expect(fetched?.topicStatus).toBe('unknown');
    expect(fetched?.topicScope).toBeNull();

    // Querying by canonicalEntity with null is safely ignored or unindexed
    const knownEntities = await testDb.attentionItems
      .where('canonicalEntity')
      .equals('deloitte')
      .toArray();
    expect(knownEntities.length).toBe(0);
  });

  it('links EmailRecords to AttentionItems and queries via attentionItemId index', async () => {
    await testDb.open();

    const email1: EmailRecord = {
      id: 'msg_linked_001',
      threadId: 'th_linked_100',
      subject: 'Company A PPT Invitation',
      from: 'placement@univ.edu',
      fromDomain: 'univ.edu',
      snippet: 'PPT tomorrow',
      internalDate: 1726400000000,
      processedAt: Date.now(),
      bodyTextPreview: 'PPT tomorrow',
      category: 'career_placement',
      confidence: 0.9,
      importanceScore: 80,
      urgencyScore: 75,
      actionRequired: true,
      actionType: 'attend',
      detectionReasons: [],
      extractedEntities: {
        deadlines: [],
        dates: [],
        organizations: ['Company A'],
        locations: [],
        ctc: null,
        urls: [],
      },
      alertStatus: 'notified',
      snoozeUntil: null,
      handledAt: null,
      attentionItemId: 'att_target_123',
      changeRelation: 'NEW',
    };

    const email2: EmailRecord = {
      id: 'msg_linked_002',
      threadId: 'th_linked_100',
      subject: 'Reminder: Company A PPT Invitation',
      from: 'placement@univ.edu',
      fromDomain: 'univ.edu',
      snippet: 'Reminder PPT tomorrow',
      internalDate: 1726450000000,
      processedAt: Date.now(),
      bodyTextPreview: 'Reminder PPT tomorrow',
      category: 'career_placement',
      confidence: 0.9,
      importanceScore: 80,
      urgencyScore: 75,
      actionRequired: true,
      actionType: 'attend',
      detectionReasons: [],
      extractedEntities: {
        deadlines: [],
        dates: [],
        organizations: ['Company A'],
        locations: [],
        ctc: null,
        urls: [],
      },
      alertStatus: 'pending',
      snoozeUntil: null,
      handledAt: null,
      attentionItemId: 'att_target_123',
      changeRelation: 'REPEAT',
    };

    const unlinkedEmail: EmailRecord = {
      id: 'msg_unlinked_003',
      threadId: 'th_other_200',
      subject: 'Newsletter',
      from: 'news@univ.edu',
      fromDomain: 'univ.edu',
      snippet: 'Monthly news',
      internalDate: 1726460000000,
      processedAt: Date.now(),
      bodyTextPreview: 'Monthly news',
      category: 'general_announcement',
      confidence: 0.8,
      importanceScore: 20,
      urgencyScore: 10,
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
      attentionItemId: null,
      changeRelation: null,
    };

    await testDb.emails.bulkPut([email1, email2, unlinkedEmail]);

    // Query emails linked to att_target_123 via index
    const linkedEmails = await testDb.emails
      .where('attentionItemId')
      .equals('att_target_123')
      .toArray();

    expect(linkedEmails.length).toBe(2);
    const ids = linkedEmails.map((e) => e.id);
    expect(ids).toContain('msg_linked_001');
    expect(ids).toContain('msg_linked_002');
    expect(ids).not.toContain('msg_unlinked_003');

    // Verify changeRelations stored on email records
    const record1 = linkedEmails.find((e) => e.id === 'msg_linked_001');
    const record2 = linkedEmails.find((e) => e.id === 'msg_linked_002');
    expect(record1?.changeRelation).toBe('NEW');
    expect(record2?.changeRelation).toBe('REPEAT');
  });
});
