import { describe, it, expect } from 'vitest';
import { analyzeEmail } from '../src/background/analysis';
import { EmailRecord } from '../src/shared/types';

function createDummyRecord(overrides: Partial<EmailRecord>): EmailRecord {
  return {
    id: 'msg_test_independence',
    threadId: 'th_test_independence',
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

describe('Importance vs Urgency Independence (Phase 2)', () => {
  // Quadrant 1: High Importance, Low Urgency
  it('handles High Importance + Low Urgency (University curriculum & grading policy)', () => {
    const policyNotice = createDummyRecord({
      from: 'Academic Council <academics@university.edu>',
      fromDomain: 'university.edu',
      subject: 'Official Revision: End-Semester Grade Report and Examination Scheme Guidelines',
      bodyTextPreview: 'The university senate has ratified the updated semester curriculum and grade report criteria for all departments. Please review.',
    });

    const result = analyzeEmail(policyNotice);

    // Matters greatly (crucial academic criteria), but has no immediate time pressure or panic
    expect(result.importance.importanceScore).toBeGreaterThanOrEqual(55);
    expect(result.urgency.urgencyScore).toBeLessThanOrEqual(25);
  });

  // Quadrant 2: Moderate/Low Importance, High Urgency
  it('handles Urgent Alert with Moderate Importance (Flight departure reschedule)', () => {
    const travelReschedule = createDummyRecord({
      from: 'Budget Airlines <support@flybudget.com>',
      fromDomain: 'flybudget.com',
      subject: 'Urgent Alert: Flight 402 departure rescheduled',
      bodyTextPreview: 'Your flight has been rescheduled due to technical delay. Departure time updated immediately.',
    });

    const result = analyzeEmail(travelReschedule);

    // Highly time sensitive (requires prompt attention today), but not a high-stakes life milestone
    expect(result.urgency.urgencyScore).toBeGreaterThanOrEqual(45);
    expect(result.importance.importanceScore).toBeLessThanOrEqual(60);
  });

  // Quadrant 3: High Importance, High Urgency
  it('handles High Importance + High Urgency (Placement assessment round today)', () => {
    const criticalRecruitment = createDummyRecord({
      from: 'Placement Cell <placements@university.edu>',
      fromDomain: 'university.edu',
      subject: 'URGENT: Microsoft Super Dream Offer Coding Round Today at 6 PM',
      bodyTextPreview: 'Dear Student, Congratulations on being shortlisted. Your online assessment for the Super Dream Offer is scheduled today. Mandatory registration closes immediately.',
    });

    const result = analyzeEmail(criticalRecruitment);

    // Both high-stakes milestone and immediate deadline
    expect(result.importance.importanceScore).toBeGreaterThanOrEqual(70);
    expect(result.urgency.urgencyScore).toBeGreaterThanOrEqual(60);
    expect(result.urgency.actionRequired).toBe(true);
  });

  // Quadrant 4: Low Importance, Low Urgency
  it('handles Low Importance + Low Urgency (Weekly marketing digest)', () => {
    const promoDigest = createDummyRecord({
      from: 'Gadget World <newsletter@gadgets.com>',
      fromDomain: 'gadgets.com',
      subject: 'Top 10 gadgets of the month',
      bodyTextPreview: 'Check out the coolest electronics and devices reviewed by our team this month. Unsubscribe to opt out.',
    });

    const result = analyzeEmail(promoDigest);

    // Neither important nor urgent
    expect(result.importance.importanceScore).toBeLessThanOrEqual(25);
    expect(result.urgency.urgencyScore).toBeLessThanOrEqual(20);
    expect(result.urgency.actionRequired).toBe(false);
  });
});
