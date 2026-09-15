import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IGAMDatabase } from '../src/db/schema';
import {
  AttentionItem,
  EmailRecord,
  ExtractedTemporalEntity,
  ItemLifecycleState,
  UserAttentionState,
} from '../src/shared/types';
import {
  analyzeEmailChange,
  processEmailChange,
  findAttentionItemCandidate,
  extractCanonicalEntity,
  extractTopicScope,
} from '../src/background/analysis/change';
import {
  createAttentionItem,
  mutateAttentionItem,
} from '../src/background/analysis/change/state';
import { InvariantExtractionOutput } from '../src/background/analysis/change/types';

function createTemporalEntity(
  overrides: Partial<ExtractedTemporalEntity> = {}
): ExtractedTemporalEntity {
  return {
    id: `temp_${Math.random().toString(36).slice(2, 7)}`,
    rawText: '17th September 2026 at 4:30 PM',
    type: 'event',
    status: 'upcoming',
    timestamp: new Date('2026-09-17T16:30:00.000Z').getTime(),
    datePrecision: 'exact',
    timePrecision: 'exact',
    isAmbiguous: false,
    associatedAction: 'attend',
    contextSnippet: 'Smart Data Solutions PPT on 17th September 2026 at 4:30 PM',
    confidence: 'HIGH',
    evidenceReasons: [],
    ...overrides,
  };
}

function createSampleEmail(overrides: Partial<EmailRecord> = {}): EmailRecord {
  return {
    id: `msg_${Math.random().toString(36).slice(2, 9)}`,
    threadId: 'th_001',
    subject: 'Smart Data Solutions PPT scheduled on 17th September 2026 by 4.30pm',
    from: 'placement@vit.ac.in',
    fromDomain: 'vit.ac.in',
    snippet: 'Smart Data Solutions PPT on 17th September 2026 at 4:30 PM in SJT 717',
    internalDate: 1726500000000,
    processedAt: 1726500000000,
    bodyTextPreview: 'Smart Data Solutions PPT on 17th September 2026 at 4:30 PM in SJT 717',
    category: 'career_placement',
    confidence: 0.95,
    importanceScore: 85,
    urgencyScore: 78,
    actionRequired: true,
    actionType: 'attend',
    detectionReasons: [],
    extractedEntities: {
      deadlines: [],
      dates: [],
      organizations: ['Smart Data Solutions'],
      locations: ['SJT 717'],
      ctc: null,
      urls: [],
    },
    temporalAnalysis: {
      primaryEvent: createTemporalEntity(),
      primaryDeadline: null,
      entities: [createTemporalEntity()],
      hasActiveDeadline: false,
      isOverdue: false,
      hasAmbiguousDates: false,
      temporalUrgencyTier: 'upcoming',
      summaryReason: 'PPT scheduled',
    },
    alertStatus: 'pending',
    snoozeUntil: null,
    handledAt: null,
    attentionItemId: null,
    changeRelation: null,
    ...overrides,
  };
}

describe('Phase 4E: Relation Classifier & Pipeline Integration (25 Scenarios)', () => {
  let dbName: string;
  let testDb: IGAMDatabase;

  beforeEach(() => {
    dbName = `test_pipe_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    testDb = new IGAMDatabase(dbName);
  });

  afterEach(async () => {
    if (testDb.isOpen()) {
      testDb.close();
    }
    await testDb.delete();
  });

  // Scenario 1: First Smart Data email -> NEW
  it('Scenario 1: First Smart Data email creates NEW AttentionItem', () => {
    const email = createSampleEmail();
    const { item, result, isNew } = analyzeEmailChange(email, []);

    expect(isNew).toBe(true);
    expect(result.relation).toBe('NEW');
    expect(result.shouldCreateNewAttentionItem).toBe(true);
    expect(item.canonicalEntity).toBe('smart data solutions');
    expect(item.entityStatus).toBe('known');
    expect(item.itemLifecycleState).toBe('active');
    expect(item.userAttentionState).toBe('unhandled');
    expect(item.currentState.venue).toBe('SJT 717');
    expect(item.currentState.primaryEventTimestamp).toBe(
      new Date('2026-09-17T16:30:00.000Z').getTime()
    );
    expect(item.messageIds).toContain(email.id);
  });

  // Scenario 2: Smart Data repeated rewritten prose -> REPEAT
  it('Scenario 2: Smart Data repeated rewritten prose is classified as REPEAT', () => {
    const email1 = createSampleEmail({ id: 'msg_001' });
    const { item: item1 } = analyzeEmailChange(email1, []);

    const email2 = createSampleEmail({
      id: 'msg_002',
      subject: 'Please Note: Information regarding Smart Data Solutions',
      snippet:
        'Kindly attend the pre-placement talk of Smart Data Solutions scheduled on 17 Sep at 4:30 PM in SJT 717.',
      bodyTextPreview:
        'Kindly attend the pre-placement talk of Smart Data Solutions scheduled on 17 Sep at 4:30 PM in SJT 717.',
    });

    const { item, result, isNew } = analyzeEmailChange(email2, [item1]);

    expect(isNew).toBe(false);
    expect(result.relation).toBe('REPEAT');
    expect(result.shouldCreateNewAttentionItem).toBe(false);
    expect(result.deltas.length).toBe(0);
    expect(item.currentState.venue).toBe('SJT 717');
    expect(item.messageIds).toContain('msg_001');
    expect(item.messageIds).toContain('msg_002');
  });

  // Scenario 3: Smart Data "URGENT FINAL REMINDER" -> REPEAT
  it('Scenario 3: Smart Data URGENT FINAL REMINDER with unchanged facts is classified as REPEAT', () => {
    const email1 = createSampleEmail({ id: 'msg_001' });
    const { item: item1 } = analyzeEmailChange(email1, []);

    const email3 = createSampleEmail({
      id: 'msg_003',
      subject: 'URGENT FINAL REMINDER: Smart Data Solutions PPT',
      snippet:
        'FINAL CALL: All students must report immediately to SJT 717 for Smart Data Solutions PPT on 17 September 2026 at 4:30 PM.',
      bodyTextPreview:
        'FINAL CALL: All students must report immediately to SJT 717 for Smart Data Solutions PPT on 17 September 2026 at 4:30 PM.',
    });

    const { result, isNew } = analyzeEmailChange(email3, [item1]);

    expect(isNew).toBe(false);
    expect(result.relation).toBe('REPEAT');
    expect(result.shouldCreateNewAttentionItem).toBe(false);
  });

  // Scenario 4: Smart Data venue changed with revision -> UPDATE
  it('Scenario 4: Smart Data venue changed with revision cue is classified as UPDATE', () => {
    const email1 = createSampleEmail({ id: 'msg_001' });
    const { item: item1 } = analyzeEmailChange(email1, []);

    const email4 = createSampleEmail({
      id: 'msg_004',
      subject: 'VENUE UPDATE: Smart Data Solutions PPT',
      snippet:
        'Please note that the venue for Smart Data Solutions PPT on 17 September 2026 at 4:30 PM has been revised and moved to SJT 718 instead of SJT 717.',
      bodyTextPreview:
        'Please note that the venue for Smart Data Solutions PPT on 17 September 2026 at 4:30 PM has been revised and moved to SJT 718 instead of SJT 717.',
      extractedEntities: {
        deadlines: [],
        dates: [],
        organizations: ['Smart Data Solutions'],
        locations: ['SJT 718'],
        ctc: null,
        urls: [],
      },
    });

    const { item, result, isNew } = analyzeEmailChange(email4, [item1]);

    expect(isNew).toBe(false);
    expect(result.relation).toBe('UPDATE');
    expect(result.shouldCreateNewAttentionItem).toBe(false);
    expect(item.currentState.venue).toBe('SJT 718');
    expect(item.previousState?.venue).toBe('SJT 717');
    const venueDelta = result.deltas.find((d) => d.field === 'venue');
    expect(venueDelta).toBeDefined();
    expect(venueDelta?.changeType).toBe('updated');
  });

  // Scenario 5: Smart Data interview moved 18 -> 19 Sep -> UPDATE
  it('Scenario 5: Smart Data interview moved 18 to 19 Sep is classified as UPDATE', () => {
    const email1 = createSampleEmail({
      id: 'msg_001',
      snippet:
        'Smart Data Solutions PPT on 17th September 2026 at 4:30 PM. Interview on 18-09-26 9 am onwards.',
      bodyTextPreview:
        'Smart Data Solutions PPT on 17th September 2026 at 4:30 PM. Interview on 18-09-26 9 am onwards.',
      temporalAnalysis: {
        primaryEvent: createTemporalEntity({
          contextSnippet: 'Smart Data Solutions PPT on 17th September 2026',
        }),
        primaryDeadline: null,
        entities: [
          createTemporalEntity({
            contextSnippet: 'Smart Data Solutions PPT on 17th September 2026',
          }),
          createTemporalEntity({
            timestamp: new Date('2026-09-18T09:00:00.000Z').getTime(),
            rawText: '18-09-26 9 am onwards',
            contextSnippet: 'Interview on 18-09-26 9 am onwards',
          }),
        ],
        hasActiveDeadline: false,
        isOverdue: false,
        hasAmbiguousDates: false,
        temporalUrgencyTier: 'upcoming',
        summaryReason: 'Schedule set',
      },
    });

    const { item: item1 } = analyzeEmailChange(email1, []);

    const email5 = createSampleEmail({
      id: 'msg_005',
      subject: 'Interview Rescheduled: Smart Data Solutions',
      snippet:
        'Smart Data Solutions PPT on 17th September 2026 at 4:30 PM. Interview has been rescheduled and moved to 19-09-26 9 am onwards.',
      bodyTextPreview:
        'Smart Data Solutions PPT on 17th September 2026 at 4:30 PM. Interview has been rescheduled and moved to 19-09-26 9 am onwards.',
      temporalAnalysis: {
        primaryEvent: createTemporalEntity({
          contextSnippet: 'Smart Data Solutions PPT on 17th September 2026',
        }),
        primaryDeadline: null,
        entities: [
          createTemporalEntity({
            contextSnippet: 'Smart Data Solutions PPT on 17th September 2026',
          }),
          createTemporalEntity({
            timestamp: new Date('2026-09-19T09:00:00.000Z').getTime(),
            rawText: '19-09-26 9 am onwards',
            contextSnippet: 'Interview has been rescheduled and moved to 19-09-26 9 am onwards',
          }),
        ],
        hasActiveDeadline: false,
        isOverdue: false,
        hasAmbiguousDates: false,
        temporalUrgencyTier: 'upcoming',
        summaryReason: 'Rescheduled',
      },
    });

    const { item, result, isNew } = analyzeEmailChange(email5, [item1]);

    expect(isNew).toBe(false);
    expect(result.relation).toBe('UPDATE');
    const subDelta = result.deltas.find((d) => d.field === 'subEvent');
    expect(subDelta).toBeDefined();
    expect(subDelta?.changeType).toBe('updated');
  });

  // Scenario 6: Smart Data new interview sub-event added -> UPDATE
  it('Scenario 6: Smart Data new interview sub-event added is classified as UPDATE', () => {
    const email1 = createSampleEmail({ id: 'msg_001' });
    const { item: item1 } = analyzeEmailChange(email1, []);

    const email6 = createSampleEmail({
      id: 'msg_006',
      subject: 'Smart Data Solutions: Interview Schedule Announced',
      snippet:
        'Smart Data Solutions PPT on 17th September 2026 at 4:30 PM. Interviews will be conducted on 18-09-26 9 am onwards.',
      bodyTextPreview:
        'Smart Data Solutions PPT on 17th September 2026 at 4:30 PM. Interviews will be conducted on 18-09-26 9 am onwards.',
      temporalAnalysis: {
        primaryEvent: createTemporalEntity(),
        primaryDeadline: null,
        entities: [
          createTemporalEntity(),
          createTemporalEntity({
            timestamp: new Date('2026-09-18T09:00:00.000Z').getTime(),
            rawText: '18-09-26 9 am onwards',
            contextSnippet: 'Interviews will be conducted on 18-09-26 9 am onwards',
          }),
        ],
        hasActiveDeadline: false,
        isOverdue: false,
        hasAmbiguousDates: false,
        temporalUrgencyTier: 'upcoming',
        summaryReason: 'Schedule set',
      },
    });

    const { item, result, isNew } = analyzeEmailChange(email6, [item1]);

    expect(isNew).toBe(false);
    expect(result.relation).toBe('UPDATE');
    const addDelta = result.deltas.find(
      (d) => d.field === 'subEvent' && d.changeType === 'added'
    );
    expect(addDelta).toBeDefined();
    expect(item.currentState.subEvents.length).toBe(2);
  });

  // Scenario 7: Company A same schedule as Company B -> separate NEW
  it('Scenario 7: Company A same schedule as Company B creates separate NEW item', () => {
    const emailA = createSampleEmail({
      id: 'msg_compA',
      subject: 'Deloitte Campus Recruitment PPT',
      extractedEntities: {
        deadlines: [],
        dates: [],
        organizations: ['Deloitte'],
        locations: ['SJT 717'],
        ctc: null,
        urls: [],
      },
    });
    const { item: itemA } = analyzeEmailChange(emailA, []);

    const emailB = createSampleEmail({
      id: 'msg_compB',
      subject: 'Google Campus Recruitment PPT',
      extractedEntities: {
        deadlines: [],
        dates: [],
        organizations: ['Google'],
        locations: ['SJT 717'],
        ctc: null,
        urls: [],
      },
    });

    const { item: itemB, result, isNew } = analyzeEmailChange(emailB, [itemA]);

    expect(isNew).toBe(true);
    expect(result.relation).toBe('NEW');
    expect(itemA.id).not.toBe(itemB.id);
  });

  // Scenario 8: Same company, different role -> separate NEW
  it('Scenario 8: Same company with different role scopes creates separate NEW items', () => {
    const emailA = createSampleEmail({
      id: 'msg_se',
      subject: 'Microsoft Software Engineer Recruitment Drive',
    });
    const { item: itemA } = analyzeEmailChange(emailA, []);

    const emailB = createSampleEmail({
      id: 'msg_da',
      subject: 'Microsoft Data Analyst Recruitment Drive',
    });

    const { item: itemB, result, isNew } = analyzeEmailChange(emailB, [itemA]);

    expect(isNew).toBe(true);
    expect(result.relation).toBe('NEW');
    expect(itemA.id).not.toBe(itemB.id);
  });

  // Scenario 9: Unknown entity -> NEW
  it('Scenario 9: Generic announcement with unknown entity creates NEW item without fabricated key', () => {
    const email = createSampleEmail({
      id: 'msg_unknown',
      subject: "Tomorrow's PPT Schedule Details",
      snippet: 'PPT scheduled for tomorrow at 4:30 PM in SJT 717',
      bodyTextPreview: 'PPT scheduled for tomorrow at 4:30 PM in SJT 717',
      from: 'placement@vit.ac.in',
      extractedEntities: {
        deadlines: [],
        dates: [],
        organizations: [],
        locations: ['SJT 717'],
        ctc: null,
        urls: [],
      },
    });

    const { item, result, isNew } = analyzeEmailChange(email, []);

    expect(isNew).toBe(true);
    expect(result.relation).toBe('NEW');
    expect(item.canonicalEntity).toBeNull();
    expect(item.entityStatus).toBe('unknown');
    expect(item.identityKey).toBeNull();
  });

  // Scenario 10: Known entity + unknown topic across threads -> NEW
  it('Scenario 10: Known entity with unknown topic across different threads creates separate NEW item', () => {
    const email1 = createSampleEmail({
      id: 'msg_th1',
      threadId: 'th_101',
      subject: 'Microsoft Software Engineer Recruitment Drive',
    });
    const { item: item1 } = analyzeEmailChange(email1, []);

    const email2 = createSampleEmail({
      id: 'msg_th2',
      threadId: 'th_202', // different thread
      subject: 'Microsoft Update',
      snippet: 'Important announcement from Microsoft for registered students',
      bodyTextPreview: 'Important announcement from Microsoft for registered students',
    });

    const { result, isNew } = analyzeEmailChange(email2, [item1]);

    expect(isNew).toBe(true);
    expect(result.relation).toBe('NEW');
  });

  // Scenario 11: Same-thread uncertain identity -> marked uncertain
  it('Scenario 11: Same-thread email with uncertain identity retains thread connection but notes uncertainty', () => {
    const email1 = createSampleEmail({
      id: 'msg_th1',
      threadId: 'th_101',
      subject: 'Microsoft Campus Update',
      snippet: 'Microsoft schedule tomorrow at 4:30 PM in SJT 717',
      bodyTextPreview: 'Microsoft schedule tomorrow at 4:30 PM in SJT 717',
    });
    const { item: item1 } = analyzeEmailChange(email1, []);

    const email2 = createSampleEmail({
      id: 'msg_th2',
      threadId: 'th_101', // same thread
      subject: 'Re: Microsoft Campus Update',
      snippet: 'Reminder: Microsoft schedule tomorrow at 4:30 PM in SJT 717',
      bodyTextPreview: 'Reminder: Microsoft schedule tomorrow at 4:30 PM in SJT 717',
    });

    const { result, isNew } = analyzeEmailChange(email2, [item1]);

    expect(isNew).toBe(false);
    expect(result.relation).toBe('REPEAT');
    expect(
      result.summary.toLowerCase().includes('repeat') ||
        result.summary.toLowerCase().includes('identical')
    ).toBe(true);
  });

  // Scenario 12: Conflicting venue without revision cue -> CONFLICT
  it('Scenario 12: Contradictory venue asserted without revision cue is classified as CONFLICT', () => {
    const email1 = createSampleEmail({ id: 'msg_001' });
    const { item: item1 } = analyzeEmailChange(email1, []);

    const email12 = createSampleEmail({
      id: 'msg_012',
      subject: 'Smart Data Solutions PPT Venue Announcement',
      snippet:
        'Smart Data Solutions PPT will be held in SJT 718 on 17th September 2026 at 4:30 PM.',
      bodyTextPreview:
        'Smart Data Solutions PPT will be held in SJT 718 on 17th September 2026 at 4:30 PM.',
      extractedEntities: {
        deadlines: [],
        dates: [],
        organizations: ['Smart Data Solutions'],
        locations: ['SJT 718'],
        ctc: null,
        urls: [],
      },
    });

    const { item, result, isNew } = analyzeEmailChange(email12, [item1]);

    expect(isNew).toBe(false);
    expect(result.relation).toBe('CONFLICT');
    expect(item.currentState.venue).toBe('SJT 717'); // preserved without corruption
    expect(item.history.some((h) => h.relation === 'CONFLICT')).toBe(true);
  });

  // Scenario 13: Explicit cancellation -> CANCELLED
  it('Scenario 13: Explicit cancellation notice transitions item to CANCELLED', () => {
    const email1 = createSampleEmail({ id: 'msg_001' });
    const { item: item1 } = analyzeEmailChange(email1, []);

    const email13 = createSampleEmail({
      id: 'msg_013',
      subject: 'CANCELLED: Smart Data Solutions PPT',
      snippet:
        'Please note that Smart Data Solutions PPT on 17 September 2026 has been cancelled.',
      bodyTextPreview:
        'Please note that Smart Data Solutions PPT on 17 September 2026 has been cancelled.',
    });

    const { item, result, isNew } = analyzeEmailChange(email13, [item1]);

    expect(isNew).toBe(false);
    expect(result.relation).toBe('CANCELLED');
    expect(item.itemLifecycleState).toBe('cancelled');
    expect(item.currentState.itemLifecycleState).toBe('cancelled');
  });

  // Scenario 14: Cancellation followed by rescheduling -> UPDATE
  it('Scenario 14: Rescheduling a previously cancelled event re-activates item as UPDATE', () => {
    const email1 = createSampleEmail({ id: 'msg_001' });
    const { item: item1 } = analyzeEmailChange(email1, []);

    const email13 = createSampleEmail({
      id: 'msg_013',
      subject: 'CANCELLED: Smart Data Solutions PPT',
      snippet:
        'Please note that Smart Data Solutions PPT on 17 September 2026 has been cancelled.',
      bodyTextPreview:
        'Please note that Smart Data Solutions PPT on 17 September 2026 has been cancelled.',
    });
    const { item: itemCancelled } = analyzeEmailChange(email13, [item1]);
    expect(itemCancelled.itemLifecycleState).toBe('cancelled');

    const email14 = createSampleEmail({
      id: 'msg_014',
      subject: 'RESCHEDULED: Smart Data Solutions PPT',
      snippet:
        'Smart Data Solutions PPT has been rescheduled to 20th September 2026 at 4:30 PM in SJT 717.',
      bodyTextPreview:
        'Smart Data Solutions PPT has been rescheduled to 20th September 2026 at 4:30 PM in SJT 717.',
      temporalAnalysis: {
        primaryEvent: createTemporalEntity({
          timestamp: new Date('2026-09-20T16:30:00.000Z').getTime(),
          rawText: '20th September 2026 at 4:30 PM',
        }),
        primaryDeadline: null,
        entities: [
          createTemporalEntity({
            timestamp: new Date('2026-09-20T16:30:00.000Z').getTime(),
            rawText: '20th September 2026 at 4:30 PM',
          }),
        ],
        hasActiveDeadline: false,
        isOverdue: false,
        hasAmbiguousDates: false,
        temporalUrgencyTier: 'upcoming',
        summaryReason: 'Rescheduled',
      },
    });

    const { item: itemReopened, result, isNew } = analyzeEmailChange(email14, [
      itemCancelled,
    ]);

    expect(isNew).toBe(false);
    expect(result.relation).toBe('UPDATE');
    expect(itemReopened.itemLifecycleState).toBe('active');
    expect(itemReopened.currentState.primaryEventTimestamp).toBe(
      new Date('2026-09-20T16:30:00.000Z').getTime()
    );
  });

  // Scenario 15: Omitted venue -> retained (REPEAT)
  it('Scenario 15: Omission of venue in subsequent reminder retains prior venue as REPEAT', () => {
    const email1 = createSampleEmail({ id: 'msg_001' });
    const { item: item1 } = analyzeEmailChange(email1, []);
    expect(item1.currentState.venue).toBe('SJT 717');

    const email15 = createSampleEmail({
      id: 'msg_015',
      subject: 'Reminder: Smart Data Solutions PPT Tomorrow',
      snippet:
        'Reminder: Smart Data Solutions PPT will take place tomorrow at 4:30 PM.',
      bodyTextPreview:
        'Reminder: Smart Data Solutions PPT will take place tomorrow at 4:30 PM.',
      extractedEntities: {
        deadlines: [],
        dates: [],
        organizations: ['Smart Data Solutions'],
        locations: [], // venue omitted
        ctc: null,
        urls: [],
      },
    });

    const { item, result, isNew } = analyzeEmailChange(email15, [item1]);

    expect(isNew).toBe(false);
    expect(result.relation).toBe('REPEAT');
    expect(item.currentState.venue).toBe('SJT 717'); // non-destructive retention
  });

  // Scenario 16: Omitted sub-event -> retained (REPEAT)
  it('Scenario 16: Omission of interview sub-event retains all existing sub-events as REPEAT', () => {
    const email1 = createSampleEmail({
      id: 'msg_001',
      snippet:
        'Smart Data Solutions PPT on 17th September 2026 at 4:30 PM in SJT 717. Interview on 18-09-26 9 am onwards.',
      bodyTextPreview:
        'Smart Data Solutions PPT on 17th September 2026 at 4:30 PM in SJT 717. Interview on 18-09-26 9 am onwards.',
      temporalAnalysis: {
        primaryEvent: createTemporalEntity({
          contextSnippet: 'Smart Data Solutions PPT on 17th September 2026',
        }),
        primaryDeadline: null,
        entities: [
          createTemporalEntity({
            contextSnippet: 'Smart Data Solutions PPT on 17th September 2026',
          }),
          createTemporalEntity({
            timestamp: new Date('2026-09-18T09:00:00.000Z').getTime(),
            rawText: '18-09-26 9 am onwards',
            contextSnippet: 'Interview on 18-09-26 9 am onwards',
          }),
        ],
        hasActiveDeadline: false,
        isOverdue: false,
        hasAmbiguousDates: false,
        temporalUrgencyTier: 'upcoming',
        summaryReason: 'Multiple events',
      },
    });

    const { item: item1 } = analyzeEmailChange(email1, []);
    expect(item1.currentState.subEvents.length).toBe(2);

    const email16 = createSampleEmail({
      id: 'msg_016',
      subject: 'Reminder: PPT Tomorrow',
      snippet: 'Reminder: Smart Data Solutions PPT tomorrow at 4:30 PM in SJT 717.',
      bodyTextPreview:
        'Reminder: Smart Data Solutions PPT tomorrow at 4:30 PM in SJT 717.',
    });

    const { item, result, isNew } = analyzeEmailChange(email16, [item1]);

    expect(isNew).toBe(false);
    expect(result.relation).toBe('REPEAT');
    expect(item.currentState.subEvents.length).toBe(2); // interview retained
  });

  // Scenario 17: Same facts, aggressive tone -> REPEAT
  it('Scenario 17: Aggressive emotional tone with identical facts is classified as REPEAT', () => {
    const email1 = createSampleEmail({ id: 'msg_001' });
    const { item: item1 } = analyzeEmailChange(email1, []);

    const email17 = createSampleEmail({
      id: 'msg_017',
      subject: 'FINAL WARNING: ATTEND SMART DATA SOLUTIONS PPT IMMEDIATELY',
      snippet:
        'CRITICAL: You are required to report to SJT 717 at 4:30 PM on 17th September 2026 or face disciplinary action.',
      bodyTextPreview:
        'CRITICAL: You are required to report to SJT 717 at 4:30 PM on 17th September 2026 or face disciplinary action.',
    });

    const { result, isNew } = analyzeEmailChange(email17, [item1]);

    expect(isNew).toBe(false);
    expect(result.relation).toBe('REPEAT');
  });

  // Scenario 18: Handled item + REPEAT -> remains handled
  it('Scenario 18: User-handled item remains handled when receiving a REPEAT', () => {
    const email1 = createSampleEmail({ id: 'msg_001' });
    const { item: item1 } = analyzeEmailChange(email1, []);
    item1.userAttentionState = 'handled';

    const email18 = createSampleEmail({ id: 'msg_018' });
    const { item, result } = analyzeEmailChange(email18, [item1]);

    expect(result.relation).toBe('REPEAT');
    expect(item.userAttentionState).toBe('handled');
  });

  // Scenario 19: Snoozed item + REPEAT -> snooze preserved
  it('Scenario 19: Snoozed item preserves user snooze state when receiving a REPEAT', () => {
    const email1 = createSampleEmail({ id: 'msg_001' });
    const { item: item1 } = analyzeEmailChange(email1, []);
    item1.userAttentionState = 'snoozed';

    const email19 = createSampleEmail({ id: 'msg_019' });
    const { item, result } = analyzeEmailChange(email19, [item1]);

    expect(result.relation).toBe('REPEAT');
    expect(item.userAttentionState).toBe('snoozed');
  });

  // Scenario 20: Handled item + UPDATE -> user state preserved, deltas logged
  it('Scenario 20: Handled item preserves handled user state while recording factual UPDATE deltas', () => {
    const email1 = createSampleEmail({ id: 'msg_001' });
    const { item: item1 } = analyzeEmailChange(email1, []);
    item1.userAttentionState = 'handled';

    const email20 = createSampleEmail({
      id: 'msg_020',
      subject: 'VENUE UPDATE: Smart Data Solutions PPT moved to SJT 718',
      snippet:
        'Smart Data Solutions PPT on 17 September 2026 at 4:30 PM has been moved to SJT 718 instead of SJT 717.',
      bodyTextPreview:
        'Smart Data Solutions PPT on 17 September 2026 at 4:30 PM has been moved to SJT 718 instead of SJT 717.',
      extractedEntities: {
        deadlines: [],
        dates: [],
        organizations: ['Smart Data Solutions'],
        locations: ['SJT 718'],
        ctc: null,
        urls: [],
      },
    });

    const { item, result } = analyzeEmailChange(email20, [item1]);

    expect(result.relation).toBe('UPDATE');
    expect(item.userAttentionState).toBe('handled'); // preserved independently
    expect(item.currentState.venue).toBe('SJT 718');
    expect(item.history[item.history.length - 1].deltas.length).toBeGreaterThan(0);
  });

  // Scenario 21: Duplicate processing of same message -> idempotent
  it('Scenario 21: Re-processing identical message ID is completely idempotent', () => {
    const email = createSampleEmail({ id: 'msg_idem_001' });
    const { item: item1 } = analyzeEmailChange(email, []);

    // Simulate second execution with identical message
    const item2 = mutateAttentionItem(
      item1,
      email,
      {
        canonicalEntity: 'smart data solutions',
        entityStatus: 'known',
        topicScope: 'recruitment_software_engineer',
        topicStatus: 'known',
        venue: 'SJT 717',
        venueType: 'physical',
        reminderSignals: {
          isReminder: false,
          isUrgentTone: false,
          isFinalNotice: false,
          cues: [],
        },
        evidence: [],
      },
      'REPEAT',
      [],
      'Repeated sync'
    );

    expect(item2.messageIds.length).toBe(1);
    expect(item2.history.length).toBe(1);
  });

  // Scenario 22: Multiple candidate items -> NEW
  it('Scenario 22: Multiple ambiguous candidate items refuse arbitrary selection and create NEW item', () => {
    const itemA = createSampleEmail({ id: 'msg_a' });
    const { item: attA } = analyzeEmailChange(itemA, []);
    attA.id = 'att_a';

    const itemB = createSampleEmail({ id: 'msg_b' });
    const { item: attB } = analyzeEmailChange(itemB, []);
    attB.id = 'att_b';

    const emailIncoming = createSampleEmail({ id: 'msg_incoming' });
    const { item, result, isNew } = analyzeEmailChange(emailIncoming, [
      attA,
      attB,
    ]);

    expect(isNew).toBe(true);
    expect(result.relation).toBe('NEW');
    expect(item.id).not.toBe('att_a');
    expect(item.id).not.toBe('att_b');
  });

  // Scenario 23: Low-confidence temporal difference -> REPEAT
  it('Scenario 23: Low-confidence or ambiguous temporal difference preserves exact state as REPEAT', () => {
    const email1 = createSampleEmail({ id: 'msg_001' });
    const { item: item1 } = analyzeEmailChange(email1, []);
    const verifiedTimestamp = item1.currentState.primaryEventTimestamp;

    const email23 = createSampleEmail({
      id: 'msg_023',
      subject: 'Smart Data Solutions PPT Note',
      snippet: 'Reminder: Smart Data Solutions PPT around 4:30 PM in SJT 717',
      bodyTextPreview:
        'Reminder: Smart Data Solutions PPT around 4:30 PM in SJT 717',
      temporalAnalysis: {
        primaryEvent: createTemporalEntity({
          timestamp: verifiedTimestamp! + 3600000,
          rawText: 'around 4:30 PM',
          timePrecision: 'unknown',
          confidence: 'LOW',
          isAmbiguous: true,
        }),
        primaryDeadline: null,
        entities: [],
        hasActiveDeadline: false,
        isOverdue: false,
        hasAmbiguousDates: true,
        temporalUrgencyTier: 'none',
        summaryReason: 'Low confidence temporal info',
      },
    });

    const { item, result, isNew } = analyzeEmailChange(email23, [item1]);

    expect(isNew).toBe(false);
    expect(result.relation).toBe('REPEAT');
    expect(item.currentState.primaryEventTimestamp).toBe(verifiedTimestamp);
  });

  // Scenario 24: Same venue/date/time, different company -> NEW
  it('Scenario 24: Identical venue and timing for different company creates separate NEW item', () => {
    const email1 = createSampleEmail({
      id: 'msg_001',
      subject: 'Apple Campus Drive in SJT 717',
      extractedEntities: {
        deadlines: [],
        dates: [],
        organizations: ['Apple'],
        locations: ['SJT 717'],
        ctc: null,
        urls: [],
      },
    });
    const { item: item1 } = analyzeEmailChange(email1, []);

    const email24 = createSampleEmail({
      id: 'msg_024',
      subject: 'Google Campus Drive in SJT 717',
      extractedEntities: {
        deadlines: [],
        dates: [],
        organizations: ['Google'],
        locations: ['SJT 717'],
        ctc: null,
        urls: [],
      },
    });

    const { item, result, isNew } = analyzeEmailChange(email24, [item1]);

    expect(isNew).toBe(true);
    expect(result.relation).toBe('NEW');
    expect(item.canonicalEntity).toBe('google');
  });

  // Scenario 25: Different category -> NEW
  it('Scenario 25: Different category email creates separate NEW item', () => {
    const email1 = createSampleEmail({
      id: 'msg_career',
      category: 'career_placement',
    });
    const { item: item1 } = analyzeEmailChange(email1, []);

    const email25 = createSampleEmail({
      id: 'msg_academic',
      category: 'academic',
      subject: 'Computer Science Midterm Examination in SJT 717',
      extractedEntities: {
        deadlines: [],
        dates: [],
        organizations: ['Computer Science'],
        locations: ['SJT 717'],
        ctc: null,
        urls: [],
      },
    });

    const { item, result, isNew } = analyzeEmailChange(email25, [item1]);

    expect(isNew).toBe(true);
    expect(result.relation).toBe('NEW');
    expect(item.category).toBe('academic');
  });

  // Database persistence integration tests
  it('persists AttentionItem and links EmailRecord during processEmailChange', async () => {
    await testDb.open();

    const email1 = createSampleEmail({ id: 'msg_db_001' });
    const { item: item1, result: res1 } = await processEmailChange(
      email1,
      testDb
    );

    expect(res1.relation).toBe('NEW');
    expect(email1.attentionItemId).toBe(item1.id);
    expect(email1.changeRelation).toBe('NEW');

    // Verify stored in DB
    const storedItem = await testDb.attentionItems.get(item1.id);
    expect(storedItem).toBeDefined();
    expect(storedItem?.id).toBe(item1.id);

    const storedEmail = await testDb.emails.get('msg_db_001');
    expect(storedEmail?.attentionItemId).toBe(item1.id);
    expect(storedEmail?.changeRelation).toBe('NEW');

    // Subsequent update
    const email2 = createSampleEmail({
      id: 'msg_db_002',
      subject: 'VENUE UPDATE: Smart Data Solutions PPT moved to SJT 718',
      snippet:
        'Smart Data Solutions PPT on 17 September 2026 has been revised to SJT 718 instead of SJT 717.',
      bodyTextPreview:
        'Smart Data Solutions PPT on 17 September 2026 has been revised to SJT 718 instead of SJT 717.',
      extractedEntities: {
        deadlines: [],
        dates: [],
        organizations: ['Smart Data Solutions'],
        locations: ['SJT 718'],
        ctc: null,
        urls: [],
      },
    });

    const { item: item2, result: res2 } = await processEmailChange(
      email2,
      testDb
    );

    expect(res2.relation).toBe('UPDATE');
    expect(item2.id).toBe(item1.id);
    expect(item2.currentState.venue).toBe('SJT 718');

    const updatedStoredItem = await testDb.attentionItems.get(item1.id);
    expect(updatedStoredItem?.currentState.venue).toBe('SJT 718');
    expect(updatedStoredItem?.messageIds).toContain('msg_db_001');
    expect(updatedStoredItem?.messageIds).toContain('msg_db_002');

    // Idempotency: re-running processEmailChange with email2 does not duplicate
    await processEmailChange(email2, testDb);
    const countAfter = await testDb.attentionItems.count();
    expect(countAfter).toBe(1);
  });
});
