import { describe, it, expect } from 'vitest';
import {
  AttentionItem,
  EmailRecord,
  ExtractedTemporalEntity,
  TemporalAnalysis,
} from '../src/shared/types';
import {
  buildSubEventsFromEmail,
  diffAttentionItemState,
  diffSubEvents,
  getCalendarDay,
  isExplicitVenueRemoval,
} from '../src/background/analysis/change/diff';
import { InvariantExtractionOutput } from '../src/background/analysis/change/types';

function createSampleEmail(overrides: Partial<EmailRecord> = {}): EmailRecord {
  return {
    id: 'msg_diff_001',
    threadId: 'th_diff_001',
    subject: 'Deloitte Campus Recruitment Drive',
    from: 'placement@university.edu',
    fromDomain: 'university.edu',
    snippet: 'Deloitte PPT tomorrow at 5 PM',
    internalDate: 1726500000000,
    processedAt: 1726500000000,
    bodyTextPreview: 'Deloitte PPT tomorrow at 5 PM in SJT 717',
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
      organizations: ['Deloitte'],
      locations: ['SJT 717'],
      ctc: null,
      urls: [],
    },
    alertStatus: 'pending',
    snoozeUntil: null,
    handledAt: null,
    attentionItemId: null,
    changeRelation: null,
    ...overrides,
  };
}

function createSampleInvariants(
  overrides: Partial<InvariantExtractionOutput> = {}
): InvariantExtractionOutput {
  return {
    canonicalEntity: 'deloitte',
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
    ...overrides,
  };
}

function createSampleAttentionItem(
  overrides: Partial<AttentionItem> = {}
): AttentionItem {
  return {
    id: 'att_diff_item_001',
    identityKey: 'career_placement::deloitte::recruitment_software_engineer',
    category: 'career_placement',
    canonicalEntity: 'deloitte',
    entityStatus: 'known',
    topicScope: 'recruitment_software_engineer',
    topicStatus: 'known',
    threadIds: ['th_diff_001'],
    messageIds: ['msg_diff_prior'],
    latestEmailId: 'msg_diff_prior',
    firstSeenAt: 1726400000000,
    lastSeenAt: 1726400000000,
    itemLifecycleState: 'active',
    userAttentionState: 'unhandled',
    importanceScore: 85,
    urgencyScore: 78,
    currentState: {
      primaryEventTimestamp: 1726573800000, // 17 Sep 2026 4:30 PM UTC
      primaryDeadlineTimestamp: null,
      venue: 'SJT 717',
      actionRequired: true,
      actionType: 'attend',
      itemLifecycleState: 'active',
      subEvents: [
        {
          subEventId: 'sub_ppt',
          label: 'PPT',
          type: 'event',
          timestamp: 1726573800000,
          endTimestamp: null,
          timePrecision: 'exact',
          venue: 'SJT 717',
          status: 'active',
        },
      ],
    },
    history: [],
    ...overrides,
  };
}

function createSampleTemporalAnalysis(
  entities: Partial<ExtractedTemporalEntity>[] = []
): TemporalAnalysis {
  const fullEntities: ExtractedTemporalEntity[] = entities.map((e, idx) => ({
    id: e.id || `temp_${idx}`,
    rawText: e.rawText || 'Sep 17 at 4:30 PM',
    type: e.type || 'event',
    status: e.status || 'upcoming',
    timestamp: e.timestamp !== undefined ? e.timestamp : 1726573800000,
    endTimestamp: e.endTimestamp || null,
    datePrecision: e.datePrecision || 'exact',
    timePrecision: e.timePrecision || 'exact',
    isAmbiguous: e.isAmbiguous || false,
    associatedAction: e.associatedAction || 'attend',
    contextSnippet: e.contextSnippet || 'PPT on Sep 17',
    confidence: e.confidence || 'HIGH',
    evidenceReasons: [],
  }));

  const primaryEvent = fullEntities.find((e) => e.type === 'event') || null;
  const primaryDeadline = fullEntities.find((e) => e.type === 'deadline') || null;

  return {
    entities: fullEntities,
    primaryEvent,
    primaryDeadline,
    hasActiveDeadline: Boolean(primaryDeadline),
    isOverdue: false,
    hasAmbiguousDates: false,
    temporalUrgencyTier: 'upcoming',
    summaryReason: 'Upcoming event',
  };
}

describe('Phase 4D: State Diffing & Sub-Event Evaluator', () => {
  // Scenario 1: Exact same facts -> no factual delta
  it('Scenario 1: Exact same facts -> no factual delta', () => {
    const email = createSampleEmail({
      temporalAnalysis: createSampleTemporalAnalysis([
        { contextSnippet: 'PPT on Sep 17', timestamp: 1726573800000 },
      ]),
    });
    const invariants = createSampleInvariants();
    const item = createSampleAttentionItem();

    const diff = diffAttentionItemState(email, invariants, item);
    expect(diff.hasChanges).toBe(false);
    expect(diff.deltas.length).toBe(0);
  });

  // Scenario 2: Same facts, rewritten prose -> no delta
  it('Scenario 2: Rewritten prose -> no delta', () => {
    const email = createSampleEmail({
      subject: 'Please note Company Presentation details',
      bodyTextPreview: 'Kindly be advised that Deloitte presentation will convene on 17 Sep at 4:30 PM in SJT 717.',
      temporalAnalysis: createSampleTemporalAnalysis([
        { contextSnippet: 'presentation on 17 Sep', timestamp: 1726573800000 },
      ]),
    });
    const invariants = createSampleInvariants();
    const item = createSampleAttentionItem();

    const diff = diffAttentionItemState(email, invariants, item);
    expect(diff.hasChanges).toBe(false);
    expect(diff.deltas.length).toBe(0);
  });

  // Scenario 3: Urgent / final reminder wording -> no delta
  it('Scenario 3: Urgent / final reminder wording -> no delta', () => {
    const email = createSampleEmail({
      subject: 'URGENT FINAL REMINDER: REPORT IMMEDIATELY',
      bodyTextPreview: 'URGENT: Deloitte PPT on 17 Sep at 4:30 PM in SJT 717. REPORT NOW.',
      temporalAnalysis: createSampleTemporalAnalysis([
        { contextSnippet: 'PPT on 17 Sep', timestamp: 1726573800000 },
      ]),
    });
    const invariants = createSampleInvariants({
      reminderSignals: {
        isReminder: true,
        isUrgentTone: true,
        isFinalNotice: true,
        cues: ['urgent reminder', 'final notice'],
      },
    });
    const item = createSampleAttentionItem();

    const diff = diffAttentionItemState(email, invariants, item);
    expect(diff.hasChanges).toBe(false);
    expect(diff.deltas.length).toBe(0);
  });

  // Scenario 4: Venue change -> venue delta
  it('Scenario 4: Venue change with revision cue -> venue delta (updated)', () => {
    const email = createSampleEmail({
      bodyTextPreview: 'Venue updated: PPT moved to TT 302.',
      temporalAnalysis: createSampleTemporalAnalysis([
        { contextSnippet: 'PPT on 17 Sep', timestamp: 1726573800000 },
      ]),
    });
    const invariants = createSampleInvariants({ venue: 'TT 302' });
    const item = createSampleAttentionItem();

    const diff = diffAttentionItemState(email, invariants, item);
    expect(diff.hasChanges).toBe(true);
    const venueDelta = diff.deltas.find((d) => d.field === 'venue');
    expect(venueDelta).toBeDefined();
    expect(venueDelta?.changeType).toBe('updated');
    expect(venueDelta?.oldValue).toBe('SJT 717');
    expect(venueDelta?.newValue).toBe('TT 302');
  });

  // Scenario 5: Date reschedule -> temporal delta
  it('Scenario 5: Date reschedule -> temporal delta', () => {
    const newTimestamp = 1726660200000; // 18 Sep 2026 4:30 PM
    const email = createSampleEmail({
      temporalAnalysis: createSampleTemporalAnalysis([
        { contextSnippet: 'PPT rescheduled to Sep 18', timestamp: newTimestamp },
      ]),
    });
    const invariants = createSampleInvariants();
    const item = createSampleAttentionItem();

    const diff = diffAttentionItemState(email, invariants, item);
    expect(diff.hasChanges).toBe(true);
    const eventDelta = diff.deltas.find((d) => d.field === 'primaryEventTimestamp');
    expect(eventDelta).toBeDefined();
    expect(eventDelta?.changeType).toBe('updated');
    expect(eventDelta?.oldValue).toBe(1726573800000);
    expect(eventDelta?.newValue).toBe(newTimestamp);
  });

  // Scenario 6: Time shift -> temporal delta
  it('Scenario 6: Time shift on same day -> temporal delta', () => {
    const newTimestamp = 1726575600000; // 17 Sep 2026 5:00 PM (shifted by 30 min)
    const email = createSampleEmail({
      temporalAnalysis: createSampleTemporalAnalysis([
        { contextSnippet: 'PPT shifted to 5 PM', timestamp: newTimestamp },
      ]),
    });
    const invariants = createSampleInvariants();
    const item = createSampleAttentionItem();

    const diff = diffAttentionItemState(email, invariants, item);
    expect(diff.hasChanges).toBe(true);
    const eventDelta = diff.deltas.find((d) => d.field === 'primaryEventTimestamp');
    expect(eventDelta).toBeDefined();
    expect(eventDelta?.changeType).toBe('updated');
    expect(eventDelta?.description).toContain('time shifted');
  });

  // Scenario 7: Deadline extension -> deadline delta
  it('Scenario 7: Deadline extension -> deadline delta', () => {
    const oldDeadline = 1726486200000; // 16 Sep 5 PM
    const newDeadline = 1726659000000; // 18 Sep 5 PM
    const email = createSampleEmail({
      temporalAnalysis: createSampleTemporalAnalysis([
        {
          id: 'temp_deadline',
          contextSnippet: 'submit application before Sep 18',
          type: 'deadline',
          timestamp: newDeadline,
        },
      ]),
    });
    const invariants = createSampleInvariants();
    const item = createSampleAttentionItem({
      currentState: {
        primaryEventTimestamp: null,
        primaryDeadlineTimestamp: oldDeadline,
        venue: null,
        actionRequired: true,
        actionType: 'submit',
        itemLifecycleState: 'active',
        subEvents: [],
      },
    });

    const diff = diffAttentionItemState(email, invariants, item);
    expect(diff.hasChanges).toBe(true);
    const dlDelta = diff.deltas.find((d) => d.field === 'primaryDeadlineTimestamp');
    expect(dlDelta).toBeDefined();
    expect(dlDelta?.changeType).toBe('updated');
    expect(dlDelta?.oldValue).toBe(oldDeadline);
    expect(dlDelta?.newValue).toBe(newDeadline);
  });

  // Scenario 8: Entity change -> entity delta
  it('Scenario 8: Entity change -> entity delta', () => {
    const email = createSampleEmail();
    const invariants = createSampleInvariants({ canonicalEntity: 'deloitte digital' });
    const item = createSampleAttentionItem({ canonicalEntity: 'deloitte' });

    const diff = diffAttentionItemState(email, invariants, item);
    expect(diff.hasChanges).toBe(true);
    const entityDelta = diff.deltas.find((d) => d.field === 'entity');
    expect(entityDelta).toBeDefined();
    expect(entityDelta?.changeType).toBe('updated');
    expect(entityDelta?.oldValue).toBe('deloitte');
    expect(entityDelta?.newValue).toBe('deloitte digital');
  });

  // Scenario 9: Topic change -> topic delta
  it('Scenario 9: Topic change -> topic delta', () => {
    const email = createSampleEmail();
    const invariants = createSampleInvariants({ topicScope: 'recruitment_data_analyst' });
    const item = createSampleAttentionItem({ topicScope: 'recruitment_software_engineer' });

    const diff = diffAttentionItemState(email, invariants, item);
    expect(diff.hasChanges).toBe(true);
    const topicDelta = diff.deltas.find((d) => d.field === 'topic');
    expect(topicDelta).toBeDefined();
    expect(topicDelta?.changeType).toBe('updated');
  });

  // Scenario 10: Action requirement added -> action delta
  it('Scenario 10: Action requirement added -> action delta', () => {
    const email = createSampleEmail({
      bodyTextPreview: 'Please attend PPT tomorrow. Mandatory to bring your hall ticket and ID card.',
      temporalAnalysis: createSampleTemporalAnalysis([
        { contextSnippet: 'PPT on Sep 17', timestamp: 1726573800000 },
      ]),
    });
    const invariants = createSampleInvariants();
    const item = createSampleAttentionItem();

    const diff = diffAttentionItemState(email, invariants, item);
    expect(diff.hasChanges).toBe(true);
    const actionDelta = diff.deltas.find((d) => d.field === 'actionRequired');
    expect(actionDelta).toBeDefined();
    expect(actionDelta?.changeType).toBe('added');
    expect(actionDelta?.description).toContain('bring hall ticket');
  });

  // Scenario 11: Omitted venue -> NOT a removal
  it('Scenario 11: Omitted venue -> NOT a removal', () => {
    const email = createSampleEmail({
      snippet: 'Reminder: PPT tomorrow at 4:30 PM.',
      bodyTextPreview: 'Reminder for PPT tomorrow at 4:30 PM.',
      temporalAnalysis: createSampleTemporalAnalysis([
        { contextSnippet: 'PPT on Sep 17', timestamp: 1726573800000 },
      ]),
    });
    const invariants = createSampleInvariants({ venue: null }); // venue omitted
    const item = createSampleAttentionItem({
      currentState: {
        primaryEventTimestamp: 1726573800000,
        primaryDeadlineTimestamp: null,
        venue: 'SJT 717', // existing known venue
        actionRequired: true,
        actionType: 'attend',
        itemLifecycleState: 'active',
        subEvents: [],
      },
    });

    const diff = diffAttentionItemState(email, invariants, item);
    expect(diff.hasChanges).toBe(false);
    expect(diff.deltas.find((d) => d.field === 'venue')).toBeUndefined();
    expect(diff.unchangedFields).toContain('venue');
  });

  // Scenario 12: Omitted sub-event -> NOT a removal
  it('Scenario 12: Omitted sub-event -> NOT a removal', () => {
    const email = createSampleEmail({
      snippet: 'Reminder for PPT tomorrow.',
      temporalAnalysis: createSampleTemporalAnalysis([
        { contextSnippet: 'PPT on Sep 17', timestamp: 1726573800000 },
      ]),
    });
    const invariants = createSampleInvariants();
    const item = createSampleAttentionItem({
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
            label: 'PPT',
            type: 'event',
            timestamp: 1726573800000,
            endTimestamp: null,
            timePrecision: 'exact',
            venue: 'SJT 717',
            status: 'active',
          },
          {
            subEventId: 'sub_interview',
            label: 'Interview',
            type: 'event',
            timestamp: 1726660200000,
            endTimestamp: null,
            timePrecision: 'exact',
            venue: 'SJT 717',
            status: 'active',
          },
        ],
      },
    });

    const diff = diffAttentionItemState(email, invariants, item);
    expect(diff.hasChanges).toBe(false);
    expect(diff.deltas.length).toBe(0);
  });

  // Scenario 13: Explicit venue removal -> removal delta
  it('Scenario 13: Explicit venue removal -> removal delta', () => {
    const email = createSampleEmail({
      bodyTextPreview: 'The physical venue in SJT 717 is cancelled. Event is fully virtual.',
      temporalAnalysis: createSampleTemporalAnalysis([
        { contextSnippet: 'PPT on Sep 17', timestamp: 1726573800000 },
      ]),
    });
    const invariants = createSampleInvariants({ venue: null });
    const item = createSampleAttentionItem();

    const diff = diffAttentionItemState(email, invariants, item);
    expect(diff.hasChanges).toBe(true);
    const venueDelta = diff.deltas.find((d) => d.field === 'venue');
    expect(venueDelta).toBeDefined();
    expect(venueDelta?.changeType).toBe('removed');
    expect(venueDelta?.oldValue).toBe('SJT 717');
    expect(venueDelta?.newValue).toBeNull();
  });

  // Scenario 14: Explicit cancellation -> lifecycle delta
  it('Scenario 14: Explicit cancellation -> lifecycle delta', () => {
    const email = createSampleEmail({
      bodyTextPreview: 'We regret to inform you that the Deloitte PPT has been cancelled.',
      temporalAnalysis: createSampleTemporalAnalysis([
        { contextSnippet: 'PPT on Sep 17', timestamp: 1726573800000 },
      ]),
    });
    const invariants = createSampleInvariants();
    const item = createSampleAttentionItem();

    const diff = diffAttentionItemState(email, invariants, item);
    expect(diff.hasChanges).toBe(true);
    const lifeDelta = diff.deltas.find((d) => d.field === 'itemLifecycleState');
    expect(lifeDelta).toBeDefined();
    expect(lifeDelta?.changeType).toBe('updated');
    expect(lifeDelta?.oldValue).toBe('active');
    expect(lifeDelta?.newValue).toBe('cancelled');
  });

  // Scenario 15: Explicit postponement -> lifecycle delta
  it('Scenario 15: Explicit postponement -> lifecycle delta', () => {
    const email = createSampleEmail({
      bodyTextPreview: 'Deloitte PPT has been postponed until further notice.',
    });
    const invariants = createSampleInvariants();
    const item = createSampleAttentionItem();

    const diff = diffAttentionItemState(email, invariants, item);
    expect(diff.hasChanges).toBe(true);
    const lifeDelta = diff.deltas.find((d) => d.field === 'itemLifecycleState');
    expect(lifeDelta).toBeDefined();
    expect(lifeDelta?.changeType).toBe('updated');
    expect(lifeDelta?.oldValue).toBe('active');
    expect(lifeDelta?.newValue).toBe('postponed');
  });

  // Scenario 16: Conflicting venue without supersession -> conflict
  it('Scenario 16: Conflicting venue without supersession cue -> conflict delta', () => {
    const email = createSampleEmail({
      bodyTextPreview: 'PPT at TT 302.', // No "updated", "revised", "moved to", etc.
      temporalAnalysis: createSampleTemporalAnalysis([
        { contextSnippet: 'PPT on Sep 17', timestamp: 1726573800000 },
      ]),
    });
    const invariants = createSampleInvariants({ venue: 'TT 302' });
    const item = createSampleAttentionItem({
      currentState: {
        primaryEventTimestamp: 1726573800000,
        primaryDeadlineTimestamp: null,
        venue: 'SJT 717',
        actionRequired: true,
        actionType: 'attend',
        itemLifecycleState: 'active',
        subEvents: [],
      },
    });

    const diff = diffAttentionItemState(email, invariants, item);
    expect(diff.hasChanges).toBe(true);
    const venueDelta = diff.deltas.find((d) => d.field === 'venue');
    expect(venueDelta).toBeDefined();
    expect(venueDelta?.changeType).toBe('conflict');
  });

  // Scenario 17: Low-confidence temporal observation vs exact old state
  it('Scenario 17: Low-confidence temporal observation vs exact old state -> do not hard-overwrite exact state', () => {
    const email = createSampleEmail({
      temporalAnalysis: createSampleTemporalAnalysis([
        {
          contextSnippet: 'PPT maybe around the 17th',
          timestamp: 1726531200000, // vague date
          confidence: 'LOW',
          timePrecision: 'unknown',
          isAmbiguous: true,
        },
      ]),
    });
    const invariants = createSampleInvariants();
    const item = createSampleAttentionItem({
      currentState: {
        primaryEventTimestamp: 1726573800000, // Verified 4:30 PM exact
        primaryDeadlineTimestamp: null,
        venue: 'SJT 717',
        actionRequired: true,
        actionType: 'attend',
        itemLifecycleState: 'active',
        subEvents: [],
      },
    });

    const diff = diffAttentionItemState(email, invariants, item);
    expect(diff.hasChanges).toBe(false);
    expect(diff.deltas.find((d) => d.field === 'primaryEventTimestamp')).toBeUndefined();
    expect(diff.unchangedFields).toContain('primaryEventTimestamp');
  });

  // Scenario 18: Date-only event does not become a midnight / time shift
  it('Scenario 18: Date-only event does not become a midnight / time shift', () => {
    const dateOnlyTimestamp = 1726531200000; // 17 Sep 00:00 UTC
    const email = createSampleEmail({
      temporalAnalysis: createSampleTemporalAnalysis([
        {
          contextSnippet: 'PPT on September 17',
          timestamp: dateOnlyTimestamp,
          timePrecision: 'unknown', // date-only
        },
      ]),
    });
    const invariants = createSampleInvariants();
    const item = createSampleAttentionItem({
      currentState: {
        primaryEventTimestamp: dateOnlyTimestamp, // also 17 Sep date-only
        primaryDeadlineTimestamp: null,
        venue: 'SJT 717',
        actionRequired: true,
        actionType: 'attend',
        itemLifecycleState: 'active',
        subEvents: [],
      },
    });

    const diff = diffAttentionItemState(email, invariants, item);
    expect(diff.hasChanges).toBe(false);
    expect(diff.deltas.length).toBe(0);
  });

  // Scenario 19: Multiple dates preserved
  it('Scenario 19: Multiple dates preserved in sub-event breakdown', () => {
    const email = createSampleEmail({
      temporalAnalysis: createSampleTemporalAnalysis([
        { contextSnippet: 'PPT on 17 Sep 4:30 PM', timestamp: 1726573800000 },
        { contextSnippet: 'Interview on 18 Sep 9 AM', timestamp: 1726650000000 },
      ]),
    });
    const invariants = createSampleInvariants();
    const item = createSampleAttentionItem();

    const subEvents = buildSubEventsFromEmail(email, invariants);
    expect(subEvents.length).toBe(2);
    expect(subEvents[0].label).toBe('PPT');
    expect(subEvents[1].label).toBe('Interview');
  });

  // Scenario 20: Real-world Smart Data example: PPT unchanged + shifted interview
  it('Scenario 20: Smart Data example: PPT unchanged + shifted interview', () => {
    const pptTimestamp = 1726573800000; // 17 Sep 4:30 PM
    const oldInterviewTimestamp = 1726650000000; // 18 Sep 9 AM
    const newInterviewTimestamp = 1726736400000; // 19 Sep 9 AM

    const email = createSampleEmail({
      bodyTextPreview: 'PPT confirmed for 17 Sep. Interview has been rescheduled to 19 Sep 9 AM.',
      temporalAnalysis: createSampleTemporalAnalysis([
        { contextSnippet: 'PPT on 17 Sep 4:30 PM', timestamp: pptTimestamp },
        { contextSnippet: 'Interview on 19 Sep 9 AM', timestamp: newInterviewTimestamp },
      ]),
    });
    const invariants = createSampleInvariants();

    const item = createSampleAttentionItem({
      currentState: {
        primaryEventTimestamp: pptTimestamp,
        primaryDeadlineTimestamp: null,
        venue: 'SJT 717',
        actionRequired: true,
        actionType: 'attend',
        itemLifecycleState: 'active',
        subEvents: [
          {
            subEventId: 'sub_ppt',
            label: 'PPT',
            type: 'event',
            timestamp: pptTimestamp,
            endTimestamp: null,
            timePrecision: 'exact',
            venue: 'SJT 717',
            status: 'active',
          },
          {
            subEventId: 'sub_interview',
            label: 'Interview',
            type: 'event',
            timestamp: oldInterviewTimestamp,
            endTimestamp: null,
            timePrecision: 'exact',
            venue: 'SJT 717',
            status: 'active',
          },
        ],
      },
    });

    const diff = diffAttentionItemState(email, invariants, item);
    expect(diff.hasChanges).toBe(true);

    // Verify PPT is NOT reported as changed
    const pptDelta = diff.deltas.find((d) => d.subEventId === 'sub_ppt');
    expect(pptDelta).toBeUndefined();

    // Verify Interview is reported as updated
    const interviewDelta = diff.deltas.find((d) => d.subEventId === 'sub_interview');
    expect(interviewDelta).toBeDefined();
    expect(interviewDelta?.changeType).toBe('updated');
    expect(interviewDelta?.oldValue).toBe(oldInterviewTimestamp);
    expect(interviewDelta?.newValue).toBe(newInterviewTimestamp);
  });

  // Scenario 21: Sub-event order changes -> no false changes
  it('Scenario 21: Sub-event order changes -> no false changes', () => {
    const oldSubEvents = [
      {
        subEventId: 'sub_ppt',
        label: 'PPT',
        type: 'event' as const,
        timestamp: 1726573800000,
        endTimestamp: null,
        timePrecision: 'exact' as const,
        venue: 'SJT 717',
        status: 'active' as const,
      },
      {
        subEventId: 'sub_interview',
        label: 'Interview',
        type: 'event' as const,
        timestamp: 1726650000000,
        endTimestamp: null,
        timePrecision: 'exact' as const,
        venue: 'SJT 717',
        status: 'active' as const,
      },
    ];

    // Same events in reverse order in incoming email
    const newSubEvents = [
      {
        subEventId: 'sub_interview',
        label: 'Interview',
        type: 'event' as const,
        timestamp: 1726650000000,
        endTimestamp: null,
        timePrecision: 'exact' as const,
        venue: 'SJT 717',
        status: 'active' as const,
      },
      {
        subEventId: 'sub_ppt',
        label: 'PPT',
        type: 'event' as const,
        timestamp: 1726573800000,
        endTimestamp: null,
        timePrecision: 'exact' as const,
        venue: 'SJT 717',
        status: 'active' as const,
      },
    ];

    const deltas = diffSubEvents(oldSubEvents, newSubEvents, 'Sample text');
    expect(deltas.length).toBe(0);
  });

  // Scenario 22: New sub-event added -> addition delta
  it('Scenario 22: New sub-event added -> addition delta', () => {
    const oldSubEvents = [
      {
        subEventId: 'sub_ppt',
        label: 'PPT',
        type: 'event' as const,
        timestamp: 1726573800000,
        endTimestamp: null,
        timePrecision: 'exact' as const,
        venue: 'SJT 717',
        status: 'active' as const,
      },
    ];

    const newSubEvents = [
      {
        subEventId: 'sub_ppt',
        label: 'PPT',
        type: 'event' as const,
        timestamp: 1726573800000,
        endTimestamp: null,
        timePrecision: 'exact' as const,
        venue: 'SJT 717',
        status: 'active' as const,
      },
      {
        subEventId: 'sub_interview',
        label: 'Interview',
        type: 'event' as const,
        timestamp: 1726650000000,
        endTimestamp: null,
        timePrecision: 'exact' as const,
        venue: 'SJT 717',
        status: 'active' as const,
      },
    ];

    const deltas = diffSubEvents(oldSubEvents, newSubEvents, 'Sample text');
    expect(deltas.length).toBe(1);
    expect(deltas[0].changeType).toBe('added');
    expect(deltas[0].subEventId).toBe('sub_interview');
  });

  // Scenario 23: Same company/entity but changed role/topic -> topic delta
  it('Scenario 23: Changed role/topic -> topic delta', () => {
    const email = createSampleEmail();
    const invariants = createSampleInvariants({ topicScope: 'recruitment_data_analyst' });
    const item = createSampleAttentionItem({ topicScope: 'recruitment_software_engineer' });

    const diff = diffAttentionItemState(email, invariants, item);
    expect(diff.hasChanges).toBe(true);
    const delta = diff.deltas.find((d) => d.field === 'topic');
    expect(delta).toBeDefined();
    expect(delta?.changeType).toBe('updated');
  });

  // Scenario 24: Same venue but different underlying item -> comparison remains factual
  it('Scenario 24: Same venue across items -> venue compared as unchanged', () => {
    const email = createSampleEmail({
      temporalAnalysis: createSampleTemporalAnalysis([
        { contextSnippet: 'PPT on Sep 17', timestamp: 1726573800000 },
      ]),
    });
    const invariants = createSampleInvariants({ venue: 'SJT 717' });
    const item = createSampleAttentionItem({
      currentState: {
        primaryEventTimestamp: 1726573800000,
        primaryDeadlineTimestamp: null,
        venue: 'SJT 717',
        actionRequired: true,
        actionType: 'attend',
        itemLifecycleState: 'active',
        subEvents: [],
      },
    });

    const diff = diffAttentionItemState(email, invariants, item);
    expect(diff.unchangedFields).toContain('venue');
  });

  // Scenario 25: No new factual information -> no changes
  it('Scenario 25: No new factual information -> no changes', () => {
    const email = createSampleEmail({
      subject: 'Update regarding Deloitte PPT',
      bodyTextPreview: 'Please be reminded about Deloitte PPT.',
      temporalAnalysis: createSampleTemporalAnalysis([
        { contextSnippet: 'PPT on Sep 17', timestamp: 1726573800000 },
      ]),
    });
    const invariants = createSampleInvariants();
    const item = createSampleAttentionItem();

    const diff = diffAttentionItemState(email, invariants, item);
    expect(diff.hasChanges).toBe(false);
    expect(diff.deltas.length).toBe(0);
  });

  // Scenario 26: Tone escalation alone -> no changes
  it('Scenario 26: Tone escalation alone -> no changes', () => {
    const email = createSampleEmail({
      subject: 'FINAL CALL: REPORT NOW OR FACE DISQUALIFICATION',
      bodyTextPreview: 'URGENT NOTICE: All candidates must report for Deloitte PPT on 17 Sep at 4:30 PM in SJT 717.',
      temporalAnalysis: createSampleTemporalAnalysis([
        { contextSnippet: 'PPT on Sep 17', timestamp: 1726573800000 },
      ]),
    });
    const invariants = createSampleInvariants({
      reminderSignals: {
        isReminder: true,
        isUrgentTone: true,
        isFinalNotice: true,
        cues: ['final call', 'report now'],
      },
    });
    const item = createSampleAttentionItem();

    const diff = diffAttentionItemState(email, invariants, item);
    expect(diff.hasChanges).toBe(false);
    expect(diff.deltas.length).toBe(0);
  });
});
