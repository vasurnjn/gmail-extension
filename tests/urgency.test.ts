import { describe, it, expect } from 'vitest';
import { analyzeEmail } from '../src/background/analysis';
import { EmailRecord } from '../src/shared/types';

function createDummyRecord(overrides: Partial<EmailRecord>): EmailRecord {
  return {
    id: 'msg_test_urgency',
    threadId: 'th_test_urgency',
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

describe('Deterministic Urgency Scoring Engine (Phase 2)', () => {
  it('ranks imminent deadlines higher than upcoming deadlines and non-urgent notices', () => {
    const imminentRecord = createDummyRecord({
      from: 'Placement Officer <placements@college.edu>',
      fromDomain: 'college.edu',
      subject: 'URGENT: Submit company application form by EOD today',
      bodyTextPreview: 'Students must submit their company registration form today before end of day. Portal closes today.',
    });

    const upcomingRecord = createDummyRecord({
      from: 'Placement Officer <placements@college.edu>',
      fromDomain: 'college.edu',
      subject: 'Notice: Application deadline is tomorrow evening',
      bodyTextPreview: 'Please complete your application before tomorrow. The deadline is tomorrow at 5 PM.',
    });

    const passiveRecord = createDummyRecord({
      from: 'Placement Officer <placements@college.edu>',
      fromDomain: 'college.edu',
      subject: 'Overview of campus recruitment policies for upcoming semester',
      bodyTextPreview: 'Here are the updated general guidelines and placement policies for all students.',
    });

    const imminentResult = analyzeEmail(imminentRecord);
    const upcomingResult = analyzeEmail(upcomingRecord);
    const passiveResult = analyzeEmail(passiveRecord);

    // Relative ordering: Imminent > Upcoming > Passive
    expect(imminentResult.urgency.urgencyScore).toBeGreaterThan(upcomingResult.urgency.urgencyScore);
    expect(upcomingResult.urgency.urgencyScore).toBeGreaterThan(passiveResult.urgency.urgencyScore);

    expect(imminentResult.urgency.urgencyScore).toBeGreaterThanOrEqual(60);
    expect(passiveResult.urgency.urgencyScore).toBeLessThanOrEqual(20);
    expect(imminentResult.urgency.urgencyReasons.some(r => r.includes('Imminent deadline'))).toBe(true);
  });

  it('triggers high urgency for critical disruptions and travel schedule cancellations', () => {
    const flightDisruption = createDummyRecord({
      from: 'Airline Notifications <alerts@airline.com>',
      fromDomain: 'airline.com',
      subject: 'Flight cancelled: AI-302 departure alert',
      bodyTextPreview: 'Your flight has been cancelled due to weather disruption. Please check alternate booking options.',
    });

    const result = analyzeEmail(flightDisruption);

    expect(result.urgency.urgencyScore).toBeGreaterThanOrEqual(50);
    expect(result.urgency.urgencyReasons.some(r => r.includes('disruption'))).toBe(true);
  });

  it('strictly caps commercial marketing urgency at 20 or below (Commercial Guardrail)', () => {
    const promoHype = createDummyRecord({
      from: 'FastFashion <offers@fashionhub.com>',
      fromDomain: 'fashionhub.com',
      subject: 'Hurry! Flash sale ends in 2 hours! 50% discount today only!',
      bodyTextPreview: 'Limited time offer! Act fast, few hours left to save 50% off. Shop now before deals end. Unsubscribe here.',
    });

    const result = analyzeEmail(promoHype);

    // Must NEVER let marketing tactics produce false urgency
    expect(result.urgency.urgencyScore).toBeLessThanOrEqual(20);
    expect(result.urgency.actionRequired).toBe(false);
    expect(result.urgency.actionType).toBeNull();
    expect(result.urgency.urgencyReasons.some(r => r.includes('Commercial urgency suppressed'))).toBe(true);
  });

  it('resolves actionRequired and actionType conservatively', () => {
    // 1. Explicit submission request with imminent deadline
    const formSubmission = createDummyRecord({
      from: 'HR Dept <hr@company.com>',
      fromDomain: 'company.com',
      subject: 'Action required: Please submit onboarding documents today',
      bodyTextPreview: 'Please submit your signed offer acceptance and tax declaration form today.',
    });
    const subResult = analyzeEmail(formSubmission);
    expect(subResult.urgency.actionRequired).toBe(true);
    expect(subResult.urgency.actionType).toBe('submit');

    // 2. Explicit registration request
    const registrationRequest = createDummyRecord({
      from: 'Campus Relations <campus@enterprise.com>',
      fromDomain: 'enterprise.com',
      subject: 'Mandatory registration for online coding assessment tomorrow',
      bodyTextPreview: 'Please register for the coding round before tomorrow evening.',
    });
    const regResult = analyzeEmail(registrationRequest);
    expect(regResult.urgency.actionRequired).toBe(true);
    expect(regResult.urgency.actionType).toBe('register');

    // 3. Informational notice without action calls
    const informational = createDummyRecord({
      from: 'Library <library@college.edu>',
      fromDomain: 'college.edu',
      subject: 'Library book return policy reminder',
      bodyTextPreview: 'The library will remain open on weekends during the semester.',
    });
    const infoResult = analyzeEmail(informational);
    expect(infoResult.urgency.actionRequired).toBe(false);
    expect(infoResult.urgency.actionType).toBeNull();
  });

  it('ranks registration-required recruitment higher than passive recruitment announcement', () => {
    const registrationRecord = createDummyRecord({
      from: 'Campus Relations <campus@enterprise.com>',
      fromDomain: 'enterprise.com',
      subject: 'McKinsey Super Dream Internship: Registration',
      bodyTextPreview: 'Students must complete their registration form for the upcoming summer internship selection process.',
    });

    const passiveRecord = createDummyRecord({
      from: 'Placement Cell <placements@college.edu>',
      fromDomain: 'college.edu',
      subject: 'General guidelines for summer internship opportunities',
      bodyTextPreview: 'Here is an overview of the internship guidelines and eligibility criteria for the upcoming year.',
    });

    const regResult = analyzeEmail(registrationRecord);
    const passiveResult = analyzeEmail(passiveRecord);

    // Relative check: actionable registration has greater urgency than passive announcement
    expect(regResult.urgency.urgencyScore).toBeGreaterThan(passiveResult.urgency.urgencyScore);
    expect(regResult.urgency.actionRequired).toBe(true);
    expect(regResult.urgency.actionType).toBe('register');
    expect(regResult.urgency.urgencyReasons.some(r => r.includes('Actionable requirement'))).toBe(true);
    expect(passiveResult.urgency.urgencyScore).toBeLessThanOrEqual(15);
    expect(passiveResult.urgency.actionRequired).toBe(false);
  });

  it('ranks scheduled assessment/presentation higher than unscheduled/passive announcement', () => {
    const scheduledRecord = createDummyRecord({
      from: 'Campus Hiring <recruiting@techcorp.com>',
      fromDomain: 'techcorp.com',
      subject: 'Smart Data Solutions PPT scheduled on 17th September 2026 at 4:30 PM',
      bodyTextPreview: 'The pre-placement talk session is scheduled on Friday at 4:30 PM. Please attend the PPT session to learn about roles.',
    });

    const unscheduledRecord = createDummyRecord({
      from: 'Campus Hiring <recruiting@techcorp.com>',
      fromDomain: 'techcorp.com',
      subject: 'Smart Data Solutions company background and brochure',
      bodyTextPreview: 'Here is general company background information and brochure for interested candidates.',
    });

    const schedResult = analyzeEmail(scheduledRecord);
    const unschedResult = analyzeEmail(unscheduledRecord);

    // Scheduled event timing creates meaningful urgency compared to passive announcement
    expect(schedResult.urgency.urgencyScore).toBeGreaterThan(unschedResult.urgency.urgencyScore);
    expect(schedResult.urgency.urgencyScore).toBeGreaterThanOrEqual(35);
    expect(schedResult.urgency.urgencyReasons.some(r => r.includes('Scheduled event'))).toBe(true);
    expect(schedResult.urgency.actionRequired).toBe(true);
    expect(schedResult.urgency.actionType).toBe('attend');
  });

  it('verifies explicit action request increases urgency score', () => {
    const withoutAction = createDummyRecord({
      from: 'Department Office <dept@college.edu>',
      fromDomain: 'college.edu',
      subject: 'Elective course options for next semester',
      bodyTextPreview: 'The department offers artificial intelligence and distributed systems as elective options next semester.',
    });

    const withAction = createDummyRecord({
      from: 'Department Office <dept@college.edu>',
      fromDomain: 'college.edu',
      subject: 'Action required: Elective course options for next semester',
      bodyTextPreview: 'Please submit your elective course selection form. Action required before portal closure.',
    });

    const resWithout = analyzeEmail(withoutAction);
    const resWith = analyzeEmail(withAction);

    expect(resWith.urgency.urgencyScore).toBeGreaterThan(resWithout.urgency.urgencyScore);
    expect(resWith.urgency.actionRequired).toBe(true);
    expect(resWithout.urgency.actionRequired).toBe(false);
  });

  it('keeps job offer without time pressure at low urgency despite high importance', () => {
    const offerRecord = createDummyRecord({
      from: 'Placement Cell <placements@college.edu>',
      fromDomain: 'college.edu',
      subject: 'Congratulations!! ZS Associates Super Dream Offer / Selection List',
      bodyTextPreview: 'Congratulations to all students selected for the Super Dream Offer. The final selection list has been published.',
    });

    const result = analyzeEmail(offerRecord);

    // High importance because it's a major career milestone
    expect(result.importance.importanceScore).toBeGreaterThanOrEqual(70);
    // But urgency remains low because there is no immediate action or time pressure
    expect(result.urgency.urgencyScore).toBeLessThanOrEqual(20);
    expect(result.urgency.actionRequired).toBe(false);
  });

  it('ensures promotional emails with "2 hours left" remain capped at 20', () => {
    const promoRecord = createDummyRecord({
      from: 'Flash Deals <sales@eshop.com>',
      fromDomain: 'eshop.com',
      subject: 'Only 2 hours left! Clearance sale discount ends soon',
      bodyTextPreview: 'Hurry up! Act fast to save with our promo code. Few hours left. Unsubscribe to opt out.',
    });

    const result = analyzeEmail(promoRecord);

    expect(result.urgency.urgencyScore).toBeLessThanOrEqual(20);
    expect(result.urgency.actionRequired).toBe(false);
    expect(result.urgency.actionType).toBeNull();
    expect(result.urgency.urgencyReasons.some(r => r.includes('Commercial urgency suppressed'))).toBe(true);
  });

  it('keeps actionRequired conservative for passive informational text with bare verbs', () => {
    const passiveCircular = createDummyRecord({
      from: 'Admin <admin@college.edu>',
      fromDomain: 'college.edu',
      subject: 'Updated campus parking regulations',
      bodyTextPreview: 'Students can review the updated parking guidelines. Anyone wishing to apply for a pass in future may consult the portal.',
    });

    const result = analyzeEmail(passiveCircular);

    expect(result.urgency.actionRequired).toBe(false);
    expect(result.urgency.actionType).toBeNull();
  });
});

