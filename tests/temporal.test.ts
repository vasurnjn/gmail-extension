import { describe, it, expect } from 'vitest';
import {
  analyzeEmail,
  analyzeTemporals,
  evaluateTemporalStatus,
  getEndOfCalendarDay,
} from '../src/background/analysis';
import { EmailRecord } from '../src/shared/types';

function createDummyRecord(overrides: Partial<EmailRecord>): EmailRecord {
  return {
    id: 'msg_test_temporal',
    threadId: 'th_test_temporal',
    subject: 'Subject',
    from: 'Sender <sender@example.com>',
    fromDomain: 'example.com',
    snippet: 'Snippet',
    internalDate: Date.now(),
    processedAt: Date.now(),
    bodyTextPreview: 'Body',
    labels: ['INBOX'],
    isUnread: true,
    category: 'uncategorized',
    confidence: 0,
    importanceScore: 0,
    urgencyScore: 0,
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
    ...overrides,
  };
}

describe('Phase 3: Deadline & Temporal Understanding', () => {
  // -------------------------------------------------------------------------
  // Case A: Date-only event calendar-day status
  // -------------------------------------------------------------------------
  it('Case A: treats date-only event as a calendar-day event that stays imminent throughout the day and passes only on the next day', () => {
    // Sept 20, 2026 local time
    // Base email sent Sept 10, 2026
    const emailSent = new Date(2026, 8, 10, 10, 0, 0).getTime();
    const record = createDummyRecord({
      internalDate: emailSent,
      subject: 'Interview Schedule Announcement',
      bodyTextPreview: 'Your technical interview is scheduled on 20th September 2026. Please prepare your setup.',
    });

    const sept20_0900 = new Date(2026, 8, 20, 9, 0, 0).getTime();
    const sept20_1500 = new Date(2026, 8, 20, 15, 0, 0).getTime();
    const sept20_2359 = new Date(2026, 8, 20, 23, 59, 0).getTime();
    const sept21_0001 = new Date(2026, 8, 21, 0, 1, 0).getTime();

    // 1. Evaluate at 09:00 on Sept 20
    const res0900 = analyzeEmail(record, sept20_0900);
    const eventEntity = res0900.temporal.entities.find(e => e.type === 'event');
    expect(eventEntity).toBeDefined();
    expect(eventEntity?.timePrecision).toBe('unknown');
    expect(eventEntity?.status).toBe('imminent'); // Happening today! Not passed!

    // 2. Evaluate at 15:00 on Sept 20
    const status1500 = evaluateTemporalStatus(eventEntity!, sept20_1500);
    expect(status1500).toBe('imminent');

    // 3. Evaluate at 23:59 on Sept 20
    const status2359 = evaluateTemporalStatus(eventEntity!, sept20_2359);
    expect(status2359).toBe('imminent');

    // 4. Evaluate at 00:01 on Sept 21 (day has ended -> passed)
    const statusNextDay = evaluateTemporalStatus(eventEntity!, sept21_0001);
    expect(statusNextDay).toBe('passed');
  });

  // -------------------------------------------------------------------------
  // Case B: Conservative year inference (March email mentioning February)
  // -------------------------------------------------------------------------
  it('Case B: refuses to guess a year when target month precedes email month without explicit context', () => {
    // Email sent March 5, 2026
    const emailSent = new Date(2026, 2, 5, 10, 0, 0).getTime();
    const record = createDummyRecord({
      internalDate: emailSent,
      subject: 'Program Registration Notice',
      bodyTextPreview: 'Please complete registration deadline February 28. Details on portal.',
    });

    const { temporal } = analyzeEmail(record, emailSent);
    const entity = temporal.entities[0];

    expect(entity).toBeDefined();
    // Must NOT manufacture 2026 or 2027!
    expect(entity.timestamp).toBeNull();
    expect(entity.isAmbiguous).toBe(true);
    expect(entity.confidence).toBe('LOW');
    expect(entity.datePrecision).toBe('unresolved');
    expect(entity.evidenceReasons.some(r => r.includes('ambiguous'))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Case C: Relative "tomorrow" static resolution vs dynamic status
  // -------------------------------------------------------------------------
  it('Case C: statically resolves "tomorrow" from email sent date, and dynamically transitions status across days', () => {
    // Email sent Sept 15, 2026 at 14:00
    const emailSent = new Date(2026, 8, 15, 14, 0, 0).getTime();
    const record = createDummyRecord({
      internalDate: emailSent,
      subject: 'Action Required',
      bodyTextPreview: 'Please submit your form tomorrow before closing.',
    });

    // Reference clocks:
    const sept15Clock = new Date(2026, 8, 15, 15, 0, 0).getTime();
    const sept16Clock = new Date(2026, 8, 16, 10, 0, 0).getTime();
    const sept17Clock = new Date(2026, 8, 17, 10, 0, 0).getTime();

    // 1. Evaluated on Sept 15
    const resSept15 = analyzeEmail(record, sept15Clock);
    const entity = resSept15.temporal.primaryDeadline;
    expect(entity).toBeDefined();
    expect(entity?.datePrecision).toBe('relative');

    // Static resolution check: timestamp represents Sept 16 23:59:59
    const resolvedDate = new Date(entity!.timestamp!);
    expect(resolvedDate.getFullYear()).toBe(2026);
    expect(resolvedDate.getMonth()).toBe(8); // September
    expect(resolvedDate.getDate()).toBe(16);

    // Dynamic status on Sept 15: upcoming
    expect(entity?.status).toBe('upcoming');

    // Dynamic status on Sept 16: imminent
    const statusSept16 = evaluateTemporalStatus(entity!, sept16Clock);
    expect(statusSept16).toBe('imminent');

    // Dynamic status on Sept 17: passed
    const statusSept17 = evaluateTemporalStatus(entity!, sept17Clock);
    expect(statusSept17).toBe('passed');
  });

  // -------------------------------------------------------------------------
  // Case D: Date-only deadline with inferred EOD
  // -------------------------------------------------------------------------
  it('Case D: treats date-only deadline as an inferred EOD cutoff (23:59:59)', () => {
    const emailSent = new Date(2026, 8, 1, 10, 0, 0).getTime();
    const record = createDummyRecord({
      internalDate: emailSent,
      subject: 'Job Application',
      bodyTextPreview: 'Please submit your job application before 20th September 2026.',
    });

    const { temporal } = analyzeEmail(record, emailSent);
    const deadline = temporal.primaryDeadline;

    expect(deadline).toBeDefined();
    expect(deadline?.type).toBe('deadline');
    expect(deadline?.datePrecision).toBe('exact');
    expect(deadline?.timePrecision).toBe('inferred');

    const dt = new Date(deadline!.timestamp!);
    expect(dt.getHours()).toBe(23);
    expect(dt.getMinutes()).toBe(59);
    expect(dt.getSeconds()).toBe(59);
    expect(deadline?.evidenceReasons.some(r => r.includes('inferred as end of day'))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Case E: Explicit deadline with exact author-provided date & time
  // -------------------------------------------------------------------------
  it('Case E: extracts explicit deadline with author-provided exact date and time', () => {
    const emailSent = new Date(2026, 8, 1, 10, 0, 0).getTime();
    const record = createDummyRecord({
      internalDate: emailSent,
      subject: 'Placement Drive Registration',
      bodyTextPreview: 'Students should register on or before 20th September 2026 (10.00 AM).',
    });

    const { temporal } = analyzeEmail(record, emailSent);
    const deadline = temporal.primaryDeadline;

    expect(deadline).toBeDefined();
    expect(deadline?.type).toBe('deadline');
    expect(deadline?.associatedAction).toBe('register');
    expect(deadline?.datePrecision).toBe('exact');
    expect(deadline?.timePrecision).toBe('exact');

    const dt = new Date(deadline!.timestamp!);
    expect(dt.getFullYear()).toBe(2026);
    expect(dt.getMonth()).toBe(8); // September
    expect(dt.getDate()).toBe(20);
    expect(dt.getHours()).toBe(10);
    expect(dt.getMinutes()).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Real-world Recruitment Registration Deadline (EA Games case)
  // -------------------------------------------------------------------------
  it('correctly interprets real-world recruitment registration deadline (EA Games case)', () => {
    const emailSent = new Date(2026, 8, 15, 10, 0, 0).getTime();
    const record = createDummyRecord({
      internalDate: emailSent,
      from: 'Placement Cell <placements@university.edu>',
      fromDomain: 'university.edu',
      subject: 'EA Games - Campus Recruitment 2027 Batch',
      bodyTextPreview:
        'Dear Students, Electronic Arts (EA Games) is conducting campus hiring. Please complete your registration on or before 20th September 2026 (10.00 AM). Late submissions will not be accepted.',
    });

    const output = analyzeEmail(record, emailSent);

    // 1. Primary deadline identified
    const deadline = output.temporal.primaryDeadline;
    expect(deadline).toBeDefined();
    expect(deadline?.type).toBe('deadline');
    expect(deadline?.associatedAction).toBe('register');
    expect(deadline?.datePrecision).toBe('exact');
    expect(deadline?.timePrecision).toBe('exact');

    // 2. Exact timestamp
    const dt = new Date(deadline!.timestamp!);
    expect(dt.getFullYear()).toBe(2026);
    expect(dt.getMonth()).toBe(8); // September
    expect(dt.getDate()).toBe(20);
    expect(dt.getHours()).toBe(10);
    expect(dt.getMinutes()).toBe(0);

    // 3. Action Required and Action Type resolved
    expect(output.urgency.actionRequired).toBe(true);
    expect(output.urgency.actionType).toBe('register');

    // 4. Category is Career & Placement
    expect(output.result.category).toBe('career_placement');
  });

  // -------------------------------------------------------------------------
  // Case F: Scheduled event with author-provided exact time
  // -------------------------------------------------------------------------
  it('Case F: extracts scheduled event with author-provided time and attendance action', () => {
    const emailSent = new Date(2026, 8, 1, 10, 0, 0).getTime();
    const record = createDummyRecord({
      internalDate: emailSent,
      subject: 'Pre-Placement Talk Schedule',
      bodyTextPreview: 'PPT is scheduled on 17th September 2026 by 4.30pm. Please attend the session.',
    });

    const { temporal } = analyzeEmail(record, emailSent);
    const event = temporal.primaryEvent;

    expect(event).toBeDefined();
    expect(event?.type).toBe('event');
    expect(event?.associatedAction).toBe('attend');
    expect(event?.datePrecision).toBe('exact');
    expect(event?.timePrecision).toBe('exact');

    const dt = new Date(event!.timestamp!);
    expect(dt.getFullYear()).toBe(2026);
    expect(dt.getMonth()).toBe(8);
    expect(dt.getDate()).toBe(17);
    expect(dt.getHours()).toBe(16);
    expect(dt.getMinutes()).toBe(30);
  });

  // -------------------------------------------------------------------------
  // Multiple dates handling (Timeline extraction)
  // -------------------------------------------------------------------------
  it('preserves all dates in timeline emails while identifying primary deadline and primary event', () => {
    const emailSent = new Date(2026, 8, 1, 10, 0, 0).getTime();
    const record = createDummyRecord({
      internalDate: emailSent,
      subject: 'Recruitment Schedule',
      bodyTextPreview:
        'Registration closes on 20th September 2026. Pre-placement talk PPT will be held on 22nd September 2026 at 4 PM. Technical interviews begin on 25th September 2026 at 10 AM.',
    });

    const { temporal } = analyzeEmail(record, emailSent);

    // All 3 entities preserved
    expect(temporal.entities.length).toBeGreaterThanOrEqual(3);
    expect(temporal.primaryDeadline?.rawText).toContain('20th September');
    expect(temporal.primaryDeadline?.type).toBe('deadline');
    expect(temporal.primaryEvent?.rawText).toContain('22nd September');
    expect(temporal.primaryEvent?.type).toBe('event');
    expect(temporal.hasActiveDeadline).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Explicit Timezone Offset
  // -------------------------------------------------------------------------
  it('parses explicit numeric UTC timezone offset accurately', () => {
    const emailSent = new Date(2026, 8, 1, 10, 0, 0).getTime();
    const record = createDummyRecord({
      internalDate: emailSent,
      subject: 'Virtual Meeting',
      bodyTextPreview: 'The virtual briefing is scheduled on 20th September 2026 at 10:00 am +05:30.',
    });

    const { temporal } = analyzeEmail(record, emailSent);
    const event = temporal.entities[0];

    expect(event).toBeDefined();
    // 10:00 +05:30 in UTC is 04:30 UTC
    const utcDate = new Date(event.timestamp!);
    expect(utcDate.getUTCHours()).toBe(4);
    expect(utcDate.getUTCMinutes()).toBe(30);
  });

  // -------------------------------------------------------------------------
  // Ambiguous Timezone Abbreviation
  // -------------------------------------------------------------------------
  it('handles ambiguous regional timezone abbreviations safely without guessing', () => {
    const emailSent = new Date(2026, 8, 1, 10, 0, 0).getTime();
    const record = createDummyRecord({
      internalDate: emailSent,
      subject: 'Sync Call',
      bodyTextPreview: 'Call is scheduled on 20th September 2026 at 4:00 PM CT.',
    });

    const { temporal } = analyzeEmail(record, emailSent);
    const event = temporal.entities[0];

    expect(event).toBeDefined();
    expect(event.evidenceReasons.some(r => r.includes('local user timezone'))).toBe(true);
    expect(event.isAmbiguous).toBe(true);
    expect(event.confidence).toBe('MEDIUM');
    expect(temporal.hasAmbiguousDates).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Timezone-consistent Calendar-Day Evaluation
  // -------------------------------------------------------------------------
  it('evaluates date-only event calendar-day status timezone-consistently with supplied timezone', () => {
    const emailSent = new Date(2026, 8, 1, 10, 0, 0).getTime();
    const record = createDummyRecord({
      internalDate: emailSent,
      subject: 'Interview Schedule',
      bodyTextPreview: 'Technical interview is scheduled on 20th September 2026.',
    });

    const { temporal } = analyzeEmail(record, emailSent, 'America/New_York');
    const event = temporal.entities[0];

    expect(event).toBeDefined();
    expect(event.type).toBe('event');
    expect(event.timePrecision).toBe('unknown');

    // Sept 20 in America/New_York has EDT (UTC - 4).
    // EOD (23:59:59.999 EDT) corresponds to Sept 21 03:59:59.999 UTC:
    const eodNY = getEndOfCalendarDay(event.timestamp!, 'America/New_York');
    expect(eodNY).toBe(Date.UTC(2026, 8, 21, 3, 59, 59, 999));

    // 1. Sept 20 at 10:00 PM EDT (Sept 21 02:00:00 UTC) -> Still Sept 20 in NY -> imminent
    const clock10pmNY = Date.UTC(2026, 8, 21, 2, 0, 0);
    expect(evaluateTemporalStatus(event, clock10pmNY, 'America/New_York')).toBe('imminent');

    // 2. Sept 21 at 00:01:00 EDT (Sept 21 04:01:00 UTC) -> Next calendar day in NY -> passed
    const clockNextDayNY = Date.UTC(2026, 8, 21, 4, 1, 0);
    expect(evaluateTemporalStatus(event, clockNextDayNY, 'America/New_York')).toBe('passed');
  });

  // -------------------------------------------------------------------------
  // Quoted text exclusion
  // -------------------------------------------------------------------------
  it('quarantines dates from historical reply threads and forwarded headers', () => {
    const emailSent = new Date(2026, 8, 20, 10, 0, 0).getTime();
    const record = createDummyRecord({
      internalDate: emailSent,
      subject: 'Re: Previous discussion',
      bodyTextPreview:
        'Sounds good, let us proceed.\n\nOn Tue, Sep 15, 2026 at 10:00 AM, Senior Manager <mgr@company.com> wrote:\n> Please submit by 16th September 2026 at 5 PM.\n> Thanks.',
    });

    const { temporal } = analyzeEmail(record, emailSent);

    // The historical date Sept 16 inside the quote should NOT be extracted as an active deadline
    const activeDeadline = temporal.entities.find(e => e.rawText.includes('16th September'));
    expect(activeDeadline).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Commercial promo guardrail
  // -------------------------------------------------------------------------
  it('suppresses commercial promotional countdowns from becoming operational action deadlines', () => {
    const emailSent = new Date(2026, 8, 20, 10, 0, 0).getTime();
    const promoRecord = createDummyRecord({
      internalDate: emailSent,
      subject: 'Mega Sale Alert',
      bodyTextPreview:
        'Save 50% discount on all orders! Sale deadline closes on 25th September 2026. Use promo code SAVE50. Unsubscribe here.',
    });

    const { temporal } = analyzeEmail(promoRecord, emailSent);

    // Commercial promo dates are downgraded from operational deadlines
    const deadline = temporal.entities.find(e => e.type === 'deadline');
    expect(deadline).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Regression Suite: Smart Data Solutions Email & Parsing Robustness
  // -------------------------------------------------------------------------
  describe('Smart Data Solutions & Multi-event Robustness', () => {
    it('Case A & B: normalizes whitespace across newlines and deduplicates subject/body duplicates', () => {
      const emailSent = new Date(2026, 8, 15, 10, 0, 0).getTime();
      const record = createDummyRecord({
        internalDate: emailSent,
        subject: 'PPT scheduled on 17th September 2026 by 4.30pm',
        bodyTextPreview: 'Dear Students,\n\nThe PPT is scheduled on 17th September\n2026 by 4.30pm in the auditorium.',
      });

      const { temporal } = analyzeEmail(record, emailSent);

      // Should have exactly 1 entity after deduplication
      expect(temporal.entities.length).toBe(1);
      const entity = temporal.entities[0];
      expect(entity.rawText).toBe('17th September 2026 by 4.30pm');
      expect(entity.type).toBe('event');
      expect(entity.timePrecision).toBe('exact');
      expect(new Date(entity.timestamp!).getDate()).toBe(17);
      expect(new Date(entity.timestamp!).getMonth()).toBe(8); // September
      expect(new Date(entity.timestamp!).getFullYear()).toBe(2026);
      expect(new Date(entity.timestamp!).getHours()).toBe(16);
      expect(new Date(entity.timestamp!).getMinutes()).toBe(30);
    });

    it('Case C & D: parses numeric date with two-digit year and handles open-ended "onwards" cue', () => {
      const emailSent = new Date(2026, 8, 15, 10, 0, 0).getTime();
      const record = createDummyRecord({
        internalDate: emailSent,
        subject: 'Interview Schedule Announcement',
        bodyTextPreview: 'The interviews will be conducted on 18-09-26 9 am onwards in the main lab.',
      });

      const { temporal } = analyzeEmail(record, emailSent);

      expect(temporal.entities.length).toBe(1);
      const entity = temporal.entities[0];
      expect(entity.type).toBe('event');
      expect(entity.timePrecision).toBe('exact');
      expect(entity.endTimestamp).toBeNull();
      expect(entity.evidenceReasons.some(r => r.includes('Open-ended') || r.includes('onwards'))).toBe(true);

      const d = new Date(entity.timestamp!);
      expect(d.getFullYear()).toBe(2026);
      expect(d.getMonth()).toBe(8); // September
      expect(d.getDate()).toBe(18);
      expect(d.getHours()).toBe(9);
      expect(d.getMinutes()).toBe(0);
    });

    it('Case E: parses real Smart Data Solutions email containing both PPT and Interview events', () => {
      const emailSent = new Date(2026, 8, 15, 10, 0, 0).getTime();
      const record = createDummyRecord({
        internalDate: emailSent,
        subject: 'Smart Data Solutions PPT scheduled on 17th September 2026 by 4.30pm',
        bodyTextPreview:
          'Dear Candidates,\n\n' +
          'Smart Data Solutions PPT is scheduled on 17th September\n' +
          '2026 by 4.30pm.\n\n' +
          'Following the presentation, individual interview sessions are scheduled on 18-09-26 9 am onwards.\n' +
          'Please ensure timely attendance.',
      });

      const { temporal } = analyzeEmail(record, emailSent);

      // Exactly two distinct events must be present
      expect(temporal.entities.length).toBe(2);

      const pptEvent = temporal.entities.find(e => e.rawText.includes('17th September'));
      const interviewEvent = temporal.entities.find(e => e.rawText.includes('18-09-26'));

      expect(pptEvent).toBeDefined();
      expect(interviewEvent).toBeDefined();

      // Verify Event 1 (PPT)
      expect(pptEvent?.type).toBe('event');
      expect(pptEvent?.timePrecision).toBe('exact');
      expect(pptEvent?.rawText).toBe('17th September 2026 by 4.30pm');
      const pptDate = new Date(pptEvent!.timestamp!);
      expect(pptDate.getFullYear()).toBe(2026);
      expect(pptDate.getMonth()).toBe(8);
      expect(pptDate.getDate()).toBe(17);
      expect(pptDate.getHours()).toBe(16);
      expect(pptDate.getMinutes()).toBe(30);

      // Verify Event 2 (Interview)
      expect(interviewEvent?.type).toBe('event');
      expect(interviewEvent?.timePrecision).toBe('exact');
      expect(interviewEvent?.endTimestamp).toBeNull();
      const intDate = new Date(interviewEvent!.timestamp!);
      expect(intDate.getFullYear()).toBe(2026);
      expect(intDate.getMonth()).toBe(8);
      expect(intDate.getDate()).toBe(18);
      expect(intDate.getHours()).toBe(9);
      expect(intDate.getMinutes()).toBe(0);

      // Primary event should be the earlier active one (PPT)
      expect(temporal.primaryEvent).toBeDefined();
      expect(temporal.primaryEvent?.id).toBe(pptEvent?.id);
    });
  });
});
