import { describe, it, expect } from 'vitest';
import {
  AttentionItem,
  EmailRecord,
  ExtractedTemporalEntity,
  TemporalAnalysis,
} from '../src/shared/types';
import { createDefaultNotificationState } from '../src/background/notifications/types';
import {
  PROXIMITY_MS_48H,
  PROXIMITY_MS_24H,
  PROXIMITY_MS_3H,
  PROXIMITY_MS_30M,
  PROXIMITY_STAGES,
} from '../src/background/notifications/constants';
import {
  calculateItemAlarms,
  calculateProximityAlarms,
  calculateSnoozeAlarm,
  formatProximityAlarmName,
  formatSnoozeAlarmName,
  isPhysicalVenue,
  parseAlarmName,
  resolvePrimaryTemporalTarget,
} from '../src/background/notifications/scheduler';

// Helper to construct test AttentionItem
function createMockItem(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: 'att_sched_001',
    identityKey: 'career_placement::deloitte::recruitment_sde',
    category: 'career_placement',
    canonicalEntity: 'deloitte',
    entityStatus: 'known',
    topicScope: 'recruitment_sde',
    topicStatus: 'known',
    threadIds: ['th_sched_001'],
    messageIds: ['msg_sched_001'],
    latestEmailId: 'msg_sched_001',
    firstSeenAt: 1726400000000,
    lastSeenAt: 1726400000000,
    itemLifecycleState: 'active',
    userAttentionState: 'unhandled',
    importanceScore: 85,
    urgencyScore: 75,
    currentState: {
      primaryEventTimestamp: 1726585200000, // Sep 17, 2026, 4:30 PM UTC
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
          timestamp: 1726585200000,
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

// Helper to construct test EmailRecord
function createMockEmail(overrides: Partial<EmailRecord> = {}): EmailRecord {
  return {
    id: 'msg_sched_001',
    threadId: 'th_sched_001',
    subject: 'Deloitte Campus Recruitment Drive',
    from: 'placement@university.edu',
    fromDomain: 'university.edu',
    snippet: 'Deloitte PPT at SJT 717',
    internalDate: 1726400000000,
    processedAt: 1726400000000,
    bodyTextPreview: 'Deloitte PPT scheduled on 17th Sep at 4:30 PM in SJT 717',
    category: 'career_placement',
    confidence: 0.95,
    importanceScore: 85,
    urgencyScore: 75,
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
    attentionItemId: 'att_sched_001',
    changeRelation: 'NEW',
    ...overrides,
  };
}

// Helper to construct test ExtractedTemporalEntity
function createMockTemporalEntity(
  overrides: Partial<ExtractedTemporalEntity> = {}
): ExtractedTemporalEntity {
  return {
    id: 'temp_0',
    rawText: '17th September 2026 at 4:30 PM',
    type: 'event',
    status: 'upcoming',
    timestamp: 1726585200000,
    endTimestamp: null,
    datePrecision: 'exact',
    timePrecision: 'exact',
    isAmbiguous: false,
    associatedAction: 'attend',
    contextSnippet: 'PPT is scheduled on 17th September 2026 at 4:30 PM',
    confidence: 'HIGH',
    evidenceReasons: ['Explicit date and time specified'],
    ...overrides,
  };
}

// Helper to construct test TemporalAnalysis
function createMockTemporalAnalysis(
  overrides: Partial<TemporalAnalysis> = {}
): TemporalAnalysis {
  const entity = createMockTemporalEntity();
  return {
    entities: [entity],
    primaryDeadline: null,
    primaryEvent: entity,
    hasActiveDeadline: false,
    isOverdue: false,
    hasAmbiguousDates: false,
    temporalUrgencyTier: 'upcoming',
    summaryReason: 'Scheduled event upcoming',
    ...overrides,
  };
}

describe('Phase 5C: Proximity Reminder & Alarm Scheduling Calculation', () => {
  const EVENT_TIME = 1726585200000; // Reference event time: Sep 17, 2026, 4:30 PM UTC

  // =========================================================================
  // 1. Alarm Naming Conventions & Round-trip Helpers
  // =========================================================================
  describe('Alarm Naming & Parsing (Requirement 14)', () => {
    it('generates stable deterministic proximity alarm names for all stages', () => {
      expect(formatProximityAlarmName('att_101', '48h')).toBe('remind::att_101::48h');
      expect(formatProximityAlarmName('att_101', '24h')).toBe('remind::att_101::24h');
      expect(formatProximityAlarmName('att_101', '3h')).toBe('remind::att_101::3h');
      expect(formatProximityAlarmName('att_101', '30m')).toBe('remind::att_101::30m');
    });

    it('generates stable deterministic snooze alarm names', () => {
      expect(formatSnoozeAlarmName('att_101', 1726580000000)).toBe(
        'snooze::att_101::1726580000000'
      );
    });

    it('round-trips parseAlarmName accurately', () => {
      const proximity = parseAlarmName('remind::att_101::24h');
      expect(proximity).toEqual({
        type: 'remind',
        attentionItemId: 'att_101',
        stage: '24h',
        snoozeUntil: null,
      });

      const snooze = parseAlarmName('snooze::att_101::1726580000000');
      expect(snooze).toEqual({
        type: 'snooze',
        attentionItemId: 'att_101',
        stage: null,
        snoozeUntil: 1726580000000,
      });

      const unknown = parseAlarmName('custom_unrelated_alarm');
      expect(unknown).toEqual({
        type: 'unknown',
        attentionItemId: null,
        stage: null,
        snoozeUntil: null,
      });
    });
  });

  // =========================================================================
  // 2. Physical Venue Detection Helper
  // =========================================================================
  describe('isPhysicalVenue', () => {
    it('detects physical campus venues', () => {
      expect(isPhysicalVenue('SJT 717')).toBe(true);
      expect(isPhysicalVenue('TT Gallery')).toBe(true);
      expect(isPhysicalVenue('Amphitheatre')).toBe(true);
      expect(isPhysicalVenue('CDC Office (SJT 717)')).toBe(true);
      expect(isPhysicalVenue('Room 101')).toBe(true);
      expect(isPhysicalVenue('Main Auditorium')).toBe(true);
    });

    it('rejects purely virtual venues', () => {
      expect(isPhysicalVenue('Online')).toBe(false);
      expect(isPhysicalVenue('online')).toBe(false);
      expect(isPhysicalVenue('Online (Virtual)')).toBe(false);
      expect(isPhysicalVenue('Zoom')).toBe(false);
      expect(isPhysicalVenue('Zoom Meeting')).toBe(false);
      expect(isPhysicalVenue('Google Meet')).toBe(false);
      expect(isPhysicalVenue('MS Teams')).toBe(false);
      expect(isPhysicalVenue('Webex')).toBe(false);
      expect(isPhysicalVenue('held online')).toBe(false);
    });

    it('identifies hybrid venues as having physical attendance', () => {
      expect(isPhysicalVenue('SJT 717 / Zoom')).toBe(true);
      expect(isPhysicalVenue('TT Gallery and Teams')).toBe(true);
    });

    it('respects explicit venueType override', () => {
      expect(isPhysicalVenue('Room 101', 'virtual')).toBe(false);
      expect(isPhysicalVenue('Online Link', 'physical')).toBe(true);
      expect(isPhysicalVenue(null, 'physical')).toBe(true);
      expect(isPhysicalVenue(null, 'virtual')).toBe(false);
      expect(isPhysicalVenue(null, null)).toBe(false);
      expect(isPhysicalVenue('', null)).toBe(false);
    });
  });

  // =========================================================================
  // 3. Exact Boundary Conditions (48h, 24h, 3h, 30m)
  // =========================================================================
  describe('Exact Stage Boundaries & Reference Time Injection', () => {
    const target = EVENT_TIME; // Sep 17, 2026, 4:30 PM UTC
    const item = createMockItem();

    // 48h boundary: target - 48h = EVENT_TIME - 172,800,000
    const time48h = target - PROXIMITY_MS_48H;
    // 24h boundary: target - 24h = EVENT_TIME - 86,400,000
    const time24h = target - PROXIMITY_MS_24H;
    // 3h boundary: target - 3h = EVENT_TIME - 10,800,000
    const time3h = target - PROXIMITY_MS_3H;
    // 30m boundary: target - 30m = EVENT_TIME - 1,800,000
    const time30m = target - PROXIMITY_MS_30M;

    it('schedules 48h stage just before boundary (time48h - 1ms)', () => {
      const alarms = calculateProximityAlarms({
        item,
        referenceTime: time48h - 1,
      });
      const stages = alarms.map((a) => a.stage);
      expect(stages).toContain('48h');
      expect(stages).toContain('24h');
      expect(stages).toContain('3h');
      expect(stages).toContain('30m');
      expect(alarms[0].scheduledAt).toBe(time48h);
    });

    it('suppresses 48h stage at exact boundary (referenceTime === time48h)', () => {
      const alarms = calculateProximityAlarms({
        item,
        referenceTime: time48h,
      });
      const stages = alarms.map((a) => a.stage);
      expect(stages).not.toContain('48h');
      expect(stages).toContain('24h');
      expect(stages).toContain('3h');
      expect(stages).toContain('30m');
    });

    it('suppresses 48h stage just after boundary (time48h + 1ms)', () => {
      const alarms = calculateProximityAlarms({
        item,
        referenceTime: time48h + 1,
      });
      const stages = alarms.map((a) => a.stage);
      expect(stages).not.toContain('48h');
      expect(stages).toContain('24h');
      expect(stages).toContain('3h');
      expect(stages).toContain('30m');
    });

    it('schedules 24h stage just before boundary (time24h - 1ms)', () => {
      const alarms = calculateProximityAlarms({
        item,
        referenceTime: time24h - 1,
      });
      const stages = alarms.map((a) => a.stage);
      expect(stages).toContain('24h');
      expect(stages).toContain('3h');
      expect(stages).toContain('30m');
    });

    it('suppresses 24h stage at exact boundary (referenceTime === time24h)', () => {
      const alarms = calculateProximityAlarms({
        item,
        referenceTime: time24h,
      });
      const stages = alarms.map((a) => a.stage);
      expect(stages).not.toContain('24h');
      expect(stages).toContain('3h');
      expect(stages).toContain('30m');
    });

    it('schedules 3h stage just before boundary (time3h - 1ms)', () => {
      const alarms = calculateProximityAlarms({
        item,
        referenceTime: time3h - 1,
      });
      const stages = alarms.map((a) => a.stage);
      expect(stages).toContain('3h');
      expect(stages).toContain('30m');
    });

    it('suppresses 3h stage at exact boundary (referenceTime === time3h)', () => {
      const alarms = calculateProximityAlarms({
        item,
        referenceTime: time3h,
      });
      const stages = alarms.map((a) => a.stage);
      expect(stages).not.toContain('3h');
      expect(stages).toContain('30m');
    });

    it('schedules 30m stage just before boundary (time30m - 1ms)', () => {
      const alarms = calculateProximityAlarms({
        item,
        referenceTime: time30m - 1,
      });
      const stages = alarms.map((a) => a.stage);
      expect(stages).toEqual(['30m']);
      expect(alarms[0].scheduledAt).toBe(time30m);
    });

    it('suppresses 30m stage at exact boundary (referenceTime === time30m)', () => {
      const alarms = calculateProximityAlarms({
        item,
        referenceTime: time30m,
      });
      expect(alarms).toEqual([]);
    });

    it('suppresses 30m stage just after boundary (time30m + 1ms)', () => {
      const alarms = calculateProximityAlarms({
        item,
        referenceTime: time30m + 1,
      });
      expect(alarms).toEqual([]);
    });
  });

  // =========================================================================
  // 4. Future vs Already-Passed Stages
  // =========================================================================
  describe('Future vs Already-Passed Stages', () => {
    const item = createMockItem();

    it('schedules all 4 stages when event is in distant future (> 72h)', () => {
      const referenceTime = EVENT_TIME - 80 * 60 * 60 * 1000; // 80h prior
      const alarms = calculateProximityAlarms({ item, referenceTime });
      expect(alarms.length).toBe(4);
      expect(alarms.map((a) => a.stage)).toEqual(['48h', '24h', '3h', '30m']);
    });

    it('schedules 3 stages when 48h has already passed (36h prior)', () => {
      const referenceTime = EVENT_TIME - 36 * 60 * 60 * 1000;
      const alarms = calculateProximityAlarms({ item, referenceTime });
      expect(alarms.length).toBe(3);
      expect(alarms.map((a) => a.stage)).toEqual(['24h', '3h', '30m']);
    });

    it('schedules 2 stages when 24h has already passed (12h prior)', () => {
      const referenceTime = EVENT_TIME - 12 * 60 * 60 * 1000;
      const alarms = calculateProximityAlarms({ item, referenceTime });
      expect(alarms.length).toBe(2);
      expect(alarms.map((a) => a.stage)).toEqual(['3h', '30m']);
    });

    it('schedules only 30m when 3h has already passed (1h prior)', () => {
      const referenceTime = EVENT_TIME - 60 * 60 * 1000;
      const alarms = calculateProximityAlarms({ item, referenceTime });
      expect(alarms.length).toBe(1);
      expect(alarms[0].stage).toBe('30m');
    });

    it('schedules NO stages when 30m has already passed (15m prior)', () => {
      const referenceTime = EVENT_TIME - 15 * 60 * 1000;
      const alarms = calculateProximityAlarms({ item, referenceTime });
      expect(alarms).toEqual([]);
    });

    it('schedules NO stages when event has already passed (Requirement 5)', () => {
      const referenceTime = EVENT_TIME + 1000; // 1 second past event
      const alarms = calculateProximityAlarms({ item, referenceTime });
      expect(alarms).toEqual([]);
    });
  });

  // =========================================================================
  // 5. Exact-Time Events vs Date-Only Events (Requirement 2)
  // =========================================================================
  describe('Exact-Time vs Date-Only Events (timePrecision === "unknown")', () => {
    it('schedules 48h and 24h for date-only events, but SUPPRESSES 3h and 30m', () => {
      // Date-only event: e.g. Sep 17, 2026, timePrecision unknown
      const item = createMockItem({
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
              timePrecision: 'unknown', // Unknown exact time!
              venue: 'SJT 717',
              status: 'active',
            },
          ],
        },
      });

      const referenceTime = EVENT_TIME - 60 * 60 * 60 * 1000; // 60h prior
      const alarms = calculateProximityAlarms({ item, referenceTime });

      const stages = alarms.map((a) => a.stage);
      expect(stages).toContain('48h');
      expect(stages).toContain('24h');
      // Requirement 2: Do not invent exact event time when timePrecision === 'unknown'
      expect(stages).not.toContain('3h');
      expect(stages).not.toContain('30m');
    });

    it('schedules 3h and 30m when event timePrecision is exact', () => {
      const item = createMockItem(); // Default has timePrecision: 'exact'
      const referenceTime = EVENT_TIME - 4 * 60 * 60 * 1000;
      const alarms = calculateProximityAlarms({ item, referenceTime });

      const stages = alarms.map((a) => a.stage);
      expect(stages).toContain('3h');
      expect(stages).toContain('30m');
    });
  });

  // =========================================================================
  // 6. Ambiguous Dates and LOW Confidence (Requirement 4)
  // =========================================================================
  describe('Ambiguous and LOW-Confidence Temporal Safety (Requirement 4)', () => {
    it('suppresses all rigid proximity alarms when isAmbiguous is true', () => {
      const item = createMockItem();
      const entity = createMockTemporalEntity({ isAmbiguous: true });
      const temporalAnalysis = createMockTemporalAnalysis({
        hasAmbiguousDates: true,
        primaryEvent: entity,
      });

      const referenceTime = EVENT_TIME - 50 * 60 * 60 * 1000;
      const alarms = calculateProximityAlarms({
        item,
        temporalAnalysis,
        referenceTime,
      });

      expect(alarms).toEqual([]);
    });

    it('suppresses all rigid proximity alarms when confidence is LOW', () => {
      const item = createMockItem();
      const entity = createMockTemporalEntity({ confidence: 'LOW' });
      const temporalAnalysis = createMockTemporalAnalysis({
        primaryEvent: entity,
      });

      const referenceTime = EVENT_TIME - 50 * 60 * 60 * 1000;
      const alarms = calculateProximityAlarms({
        item,
        temporalAnalysis,
        referenceTime,
      });

      expect(alarms).toEqual([]);
    });

    it('suppresses all proximity alarms when datePrecision is unresolved', () => {
      const item = createMockItem();
      const entity = createMockTemporalEntity({ datePrecision: 'unresolved' });
      const temporalAnalysis = createMockTemporalAnalysis({
        primaryEvent: entity,
      });

      const referenceTime = EVENT_TIME - 50 * 60 * 60 * 1000;
      const alarms = calculateProximityAlarms({
        item,
        temporalAnalysis,
        referenceTime,
      });

      expect(alarms).toEqual([]);
    });
  });

  // =========================================================================
  // 7. Deadlines vs Events Semantics (Requirements 9 & 10)
  // =========================================================================
  describe('Deadlines vs Events Semantics', () => {
    it('correctly labels deadline in purpose and NEVER schedules 30m for a deadline', () => {
      const deadlineTs = EVENT_TIME;
      const item = createMockItem({
        currentState: {
          primaryEventTimestamp: null,
          primaryDeadlineTimestamp: deadlineTs,
          venue: null,
          actionRequired: true,
          actionType: 'submit',
          itemLifecycleState: 'active',
          subEvents: [
            {
              subEventId: 'sub_deadline',
              label: 'Resume Submission Cutoff',
              type: 'deadline',
              timestamp: deadlineTs,
              endTimestamp: null,
              timePrecision: 'inferred',
              venue: null,
              status: 'active',
            },
          ],
        },
      });

      const referenceTime = deadlineTs - 50 * 60 * 60 * 1000;
      const alarms = calculateProximityAlarms({ item, referenceTime });

      const stages = alarms.map((a) => a.stage);
      expect(stages).toContain('48h');
      expect(stages).toContain('24h');
      expect(stages).toContain('3h');
      // Requirement 9: 30m requires physical attendance event, never scheduled for a deadline!
      expect(stages).not.toContain('30m');

      // Check purpose string preserves deadline semantics
      expect(alarms[0].purpose).toContain('before deadline:');
      expect(alarms[0].purpose).toContain('Resume Submission Cutoff');
    });

    it('correctly labels event with venue in purpose for scheduled event', () => {
      const item = createMockItem();
      const referenceTime = EVENT_TIME - 50 * 60 * 60 * 1000;
      const alarms = calculateProximityAlarms({ item, referenceTime });

      expect(alarms[0].purpose).toContain('before event:');
      expect(alarms[0].purpose).toContain('SJT 717');
    });
  });

  // =========================================================================
  // 8. The 30-Minute Stage Strict Prerequisites (Requirement 9)
  // =========================================================================
  describe('The 30-Minute Stage Strict Prerequisites (Requirement 9)', () => {
    const referenceTime = EVENT_TIME - 60 * 60 * 1000; // 1h prior (30m stage is eligible in time)

    it('requires exact event timing (suppressed if timePrecision is unknown)', () => {
      const item = createMockItem({
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
              label: 'PPT',
              type: 'event',
              timestamp: EVENT_TIME,
              endTimestamp: null,
              timePrecision: 'unknown', // Not exact!
              venue: 'SJT 717',
              status: 'active',
            },
          ],
        },
      });

      const alarms = calculateProximityAlarms({ item, referenceTime });
      expect(alarms.map((a) => a.stage)).not.toContain('30m');
    });

    it('requires physical-attendance evidence (suppressed if venue is virtual)', () => {
      const item = createMockItem({
        currentState: {
          primaryEventTimestamp: EVENT_TIME,
          primaryDeadlineTimestamp: null,
          venue: 'Online (Zoom Meeting)', // Virtual!
          actionRequired: true,
          actionType: 'attend',
          itemLifecycleState: 'active',
          subEvents: [],
        },
      });

      const alarms = calculateProximityAlarms({
        item,
        referenceTime,
        venueType: 'virtual',
      });
      expect(alarms.map((a) => a.stage)).not.toContain('30m');
    });

    it('requires physical-attendance evidence (suppressed if venue is null)', () => {
      const item = createMockItem({
        currentState: {
          primaryEventTimestamp: EVENT_TIME,
          primaryDeadlineTimestamp: null,
          venue: null, // No venue!
          actionRequired: true,
          actionType: 'attend',
          itemLifecycleState: 'active',
          subEvents: [],
        },
      });

      const alarms = calculateProximityAlarms({ item, referenceTime });
      expect(alarms.map((a) => a.stage)).not.toContain('30m');
    });

    it('requires actionable event (suppressed if actionRequired is false)', () => {
      const item = createMockItem({
        currentState: {
          primaryEventTimestamp: EVENT_TIME,
          primaryDeadlineTimestamp: null,
          venue: 'SJT 717',
          actionRequired: false, // Not actionable!
          actionType: null,
          itemLifecycleState: 'active',
          subEvents: [],
        },
      });

      const alarms = calculateProximityAlarms({ item, referenceTime });
      expect(alarms.map((a) => a.stage)).not.toContain('30m');
    });

    it('requires unhandled state (suppressed if item is snoozed)', () => {
      const item = createMockItem({
        userAttentionState: 'snoozed',
      });

      const alarms = calculateProximityAlarms({
        item,
        snoozeUntil: referenceTime - 10000,
        referenceTime,
      });
      expect(alarms.map((a) => a.stage)).not.toContain('30m');
    });

    it('schedules 30m stage when all 5 prerequisites are satisfied', () => {
      const item = createMockItem({
        userAttentionState: 'unhandled',
      });

      const alarms = calculateProximityAlarms({ item, referenceTime });
      expect(alarms.map((a) => a.stage)).toEqual(['30m']);
      expect(alarms[0].scheduledAt).toBe(EVENT_TIME - PROXIMITY_MS_30M);
    });
  });

  // =========================================================================
  // 9. Lifecycle States (Requirement 6)
  // =========================================================================
  describe('Lifecycle State Checks (Requirement 6)', () => {
    const referenceTime = EVENT_TIME - 50 * 60 * 60 * 1000;

    it('schedules alarms when itemLifecycleState is active', () => {
      const item = createMockItem({ itemLifecycleState: 'active' });
      const alarms = calculateProximityAlarms({ item, referenceTime });
      expect(alarms.length).toBeGreaterThan(0);
    });

    it('suppresses all alarms when itemLifecycleState is cancelled', () => {
      const item = createMockItem({ itemLifecycleState: 'cancelled' });
      const alarms = calculateProximityAlarms({ item, referenceTime });
      expect(alarms).toEqual([]);
    });

    it('suppresses all alarms when itemLifecycleState is completed', () => {
      const item = createMockItem({ itemLifecycleState: 'completed' });
      const alarms = calculateProximityAlarms({ item, referenceTime });
      expect(alarms).toEqual([]);
    });

    it('suppresses all alarms when itemLifecycleState is unknown', () => {
      const item = createMockItem({ itemLifecycleState: 'unknown' });
      const alarms = calculateProximityAlarms({ item, referenceTime });
      expect(alarms).toEqual([]);
    });

    it('suppresses all alarms when itemLifecycleState is postponed', () => {
      const item = createMockItem({ itemLifecycleState: 'postponed' });
      const alarms = calculateProximityAlarms({ item, referenceTime });
      expect(alarms).toEqual([]);
    });
  });

  // =========================================================================
  // 10. User Attention States & Snooze Deferral (Requirements 7 & 8)
  // =========================================================================
  describe('User Attention States & Snooze Handling (Requirements 7 & 8)', () => {
    const referenceTime = EVENT_TIME - 50 * 60 * 60 * 1000;

    it('suppresses all alarms when userAttentionState is handled', () => {
      const item = createMockItem({ userAttentionState: 'handled' });
      const alarms = calculateProximityAlarms({ item, referenceTime });
      expect(alarms).toEqual([]);
    });

    it('suppresses all alarms when userAttentionState is dismissed', () => {
      const item = createMockItem({ userAttentionState: 'dismissed' });
      const alarms = calculateProximityAlarms({ item, referenceTime });
      expect(alarms).toEqual([]);
    });

    it('defers proximity alarms occurring before snoozeUntil when item is snoozed', () => {
      // Event is in 50h
      // 48h stage is at EVENT - 48h (in 2 hours)
      // 24h stage is at EVENT - 24h (in 26 hours)
      // Snooze until in 5 hours (past 48h stage, but before 24h stage)
      const snoozeUntil = referenceTime + 5 * 60 * 60 * 1000;

      const item = createMockItem({
        userAttentionState: 'snoozed',
      });

      const alarms = calculateProximityAlarms({
        item,
        snoozeUntil,
        referenceTime,
      });

      const stages = alarms.map((a) => a.stage);
      // 48h stage is <= snoozeUntil, so it is deferred/suppressed!
      expect(stages).not.toContain('48h');
      // 24h stage is > snoozeUntil, so it is scheduled!
      expect(stages).toContain('24h');
      expect(stages).toContain('3h');
      // 30m is suppressed because snoozed != unhandled
      expect(stages).not.toContain('30m');
    });

    it('calculates snooze expiration alarm correctly via calculateSnoozeAlarm', () => {
      const snoozeUntil = referenceTime + 60 * 60 * 1000;
      const item = createMockItem({ userAttentionState: 'snoozed' });

      const alarm = calculateSnoozeAlarm({
        item,
        snoozeUntil,
        referenceTime,
      });

      expect(alarm).not.toBeNull();
      expect(alarm?.alarmName).toBe(`snooze::${item.id}::${snoozeUntil}`);
      expect(alarm?.scheduledAt).toBe(snoozeUntil);
      expect(alarm?.alarmType).toBe('snooze');
      expect(alarm?.stage).toBe('snooze');
    });

    it('does NOT schedule snooze alarm if snoozeUntil is in the past', () => {
      const snoozeUntil = referenceTime - 1000;
      const item = createMockItem({ userAttentionState: 'snoozed' });

      const alarm = calculateSnoozeAlarm({
        item,
        snoozeUntil,
        referenceTime,
      });

      expect(alarm).toBeNull();
    });

    it('combines proximity and snooze alarms in calculateItemAlarms', () => {
      const snoozeUntil = referenceTime + 5 * 60 * 60 * 1000;
      const item = createMockItem({ userAttentionState: 'snoozed' });

      const alarms = calculateItemAlarms({
        item,
        snoozeUntil,
        referenceTime,
      });

      // Should include snooze alarm AND post-snooze proximity alarms
      const types = alarms.map((a) => a.alarmType);
      expect(types).toContain('snooze');
      expect(types).toContain('proximity');

      // Verify sorted chronologically
      for (let i = 1; i < alarms.length; i++) {
        expect(alarms[i].scheduledAt).toBeGreaterThanOrEqual(alarms[i - 1].scheduledAt);
      }
    });
  });

  // =========================================================================
  // 11. Multiple Temporal Entities & Duplicate Prevention (Requirement 11)
  // =========================================================================
  describe('Multiple Temporal Entities & Duplicate Prevention (Requirement 11)', () => {
    it('schedules for earliest active cutoff when both deadline and event exist, with no duplicate alarm names', () => {
      // Deadline: Sep 16, 5:00 PM (EVENT_TIME - 24h)
      // Event: Sep 17, 4:30 PM (EVENT_TIME)
      // ReferenceTime: Sep 14, 10:00 AM (EVENT_TIME - 78h)
      const deadlineTs = EVENT_TIME - 24 * 60 * 60 * 1000;
      const eventTs = EVENT_TIME;
      const referenceTime = EVENT_TIME - 78 * 60 * 60 * 1000;

      const item = createMockItem({
        currentState: {
          primaryDeadlineTimestamp: deadlineTs,
          primaryEventTimestamp: eventTs,
          venue: 'SJT 717',
          actionRequired: true,
          actionType: 'attend',
          itemLifecycleState: 'active',
          subEvents: [
            {
              subEventId: 'sub_reg',
              label: 'Registration Deadline',
              type: 'deadline',
              timestamp: deadlineTs,
              endTimestamp: null,
              timePrecision: 'inferred',
              venue: null,
              status: 'active',
            },
            {
              subEventId: 'sub_ppt',
              label: 'Deloitte PPT',
              type: 'event',
              timestamp: eventTs,
              endTimestamp: null,
              timePrecision: 'exact',
              venue: 'SJT 717',
              status: 'active',
            },
          ],
        },
      });

      const alarms = calculateProximityAlarms({ item, referenceTime });

      // Check unique alarm names (NO DUPLICATES)
      const names = alarms.map((a) => a.alarmName);
      const uniqueNames = new Set(names);
      expect(uniqueNames.size).toBe(names.length);

      // Primary target for 48h, 24h, 3h is earliest active cutoff (the deadline)
      const alarm24h = alarms.find((a) => a.stage === '24h');
      expect(alarm24h).toBeDefined();
      expect(alarm24h?.scheduledAt).toBe(deadlineTs - PROXIMITY_MS_24H);

      // 30m targets the in-person event!
      const alarm30m = alarms.find((a) => a.stage === '30m');
      expect(alarm30m).toBeDefined();
      expect(alarm30m?.scheduledAt).toBe(eventTs - PROXIMITY_MS_30M);
      expect(alarm30m?.purpose).toContain('SJT 717');
    });

    it('switches primary target to event once deadline has passed', () => {
      // Deadline was at EVENT_TIME - 24h
      // Now is EVENT_TIME - 20h (deadline has passed 4 hours ago!)
      const deadlineTs = EVENT_TIME - 24 * 60 * 60 * 1000;
      const eventTs = EVENT_TIME;
      const referenceTime = EVENT_TIME - 20 * 60 * 60 * 1000;

      const item = createMockItem({
        currentState: {
          primaryDeadlineTimestamp: deadlineTs, // Passed!
          primaryEventTimestamp: eventTs,       // Future!
          venue: 'SJT 717',
          actionRequired: true,
          actionType: 'attend',
          itemLifecycleState: 'active',
          subEvents: [],
        },
      });

      const alarms = calculateProximityAlarms({ item, referenceTime });
      const stages = alarms.map((a) => a.stage);

      // 48h and 24h for the event (at EVENT_TIME - 48h and -24h) have already passed relative to referenceTime (-20h)
      expect(stages).not.toContain('48h');
      expect(stages).not.toContain('24h');
      // 3h and 30m for the event are upcoming!
      expect(stages).toContain('3h');
      expect(stages).toContain('30m');
      expect(alarms.find((a) => a.stage === '3h')?.scheduledAt).toBe(
        eventTs - PROXIMITY_MS_3H
      );
    });
  });

  // =========================================================================
  // 12. Timezone Behavior & Purity Invariant (Requirements 13 & 15)
  // =========================================================================
  describe('Timezone Invariance & Purity (Requirement 15)', () => {
    it('produces identical scheduledAt timestamps across different timezone inputs for exact times', () => {
      const item = createMockItem();
      const referenceTime = EVENT_TIME - 50 * 60 * 60 * 1000;

      const alarmsUtc = calculateProximityAlarms({
        item,
        referenceTime,
        timezone: 'UTC',
      });

      const alarmsIst = calculateProximityAlarms({
        item,
        referenceTime,
        timezone: 'Asia/Kolkata',
      });

      const alarmsEst = calculateProximityAlarms({
        item,
        referenceTime,
        timezone: 'America/New_York',
      });

      expect(alarmsUtc.map((a) => a.scheduledAt)).toEqual(
        alarmsIst.map((a) => a.scheduledAt)
      );
      expect(alarmsUtc.map((a) => a.scheduledAt)).toEqual(
        alarmsEst.map((a) => a.scheduledAt)
      );
    });

    it('does NOT mutate input item, email, or temporal analysis (Purity Invariant)', () => {
      const item = createMockItem();
      const email = createMockEmail();
      const entity = createMockTemporalEntity();
      const temporalAnalysis = createMockTemporalAnalysis({ primaryEvent: entity });

      const itemSnapshot = JSON.stringify(item);
      const emailSnapshot = JSON.stringify(email);
      const analysisSnapshot = JSON.stringify(temporalAnalysis);

      calculateItemAlarms({
        item,
        email,
        temporalAnalysis,
        referenceTime: EVENT_TIME - 50 * 60 * 60 * 1000,
      });

      expect(JSON.stringify(item)).toBe(itemSnapshot);
      expect(JSON.stringify(email)).toBe(emailSnapshot);
      expect(JSON.stringify(temporalAnalysis)).toBe(analysisSnapshot);
    });
  });
});
