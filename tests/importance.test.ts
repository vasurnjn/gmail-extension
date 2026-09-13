import { describe, it, expect } from 'vitest';
import { analyzeEmail } from '../src/background/analysis';
import { EmailRecord } from '../src/shared/types';

function createDummyRecord(overrides: Partial<EmailRecord>): EmailRecord {
  return {
    id: 'msg_test_importance',
    threadId: 'th_test_importance',
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

describe('Deterministic Importance Scoring Engine (Phase 2)', () => {
  it('ranks confirmed job offer significantly higher than generic job announcement', () => {
    const offerRecord = createDummyRecord({
      from: 'University Placement Cell <placements@university.edu>',
      fromDomain: 'university.edu',
      subject: 'Congratulations!! Human Resocia Co. Ltd. Super Dream Offer Selection',
      bodyTextPreview: 'Dear Student, Congratulations on being selected for the Super Dream Offer. Your offer letter is attached.',
    });

    const genericJobAnnouncement = createDummyRecord({
      from: 'Job Portal <info@jobboard.com>',
      fromDomain: 'jobboard.com',
      subject: 'New career opportunity: Software Engineer openings this week',
      bodyTextPreview: 'Check out the latest job openings for software developers on our platform. Manage preferences or unsubscribe.',
    });

    const offerResult = analyzeEmail(offerRecord);
    const genericResult = analyzeEmail(genericJobAnnouncement);

    // Relative behavioral assertions: offer matters substantially more than a generic newsletter-like job board
    expect(offerResult.importance.importanceScore).toBeGreaterThan(genericResult.importance.importanceScore);
    expect(offerResult.importance.importanceScore).toBeGreaterThanOrEqual(70);
    expect(genericResult.importance.importanceScore).toBeLessThanOrEqual(45);

    // Verify explanation reasons
    expect(offerResult.importance.importanceReasons.some(r => r.includes('High-stakes career milestone'))).toBe(true);
    expect(offerResult.importance.importanceReasons.some(r => r.includes('academic domain'))).toBe(true);
  });

  it('ranks critical examination / hall ticket higher than general university circular', () => {
    const examRecord = createDummyRecord({
      from: 'Controller of Examinations <coe@university.edu>',
      fromDomain: 'university.edu',
      subject: 'End Semester Examination Schedule and Hall Ticket download',
      bodyTextPreview: 'All students must download their examination admit card and hall ticket for upcoming semester exams.',
    });

    const circularRecord = createDummyRecord({
      from: 'Registrar Office <registrar@university.edu>',
      fromDomain: 'university.edu',
      subject: 'University campus greenery initiative and general guidelines',
      bodyTextPreview: 'Students are encouraged to participate in the upcoming campus tree plantation drive. Read guidelines. Unsubscribe to opt out.',
    });

    const examResult = analyzeEmail(examRecord);
    const circularResult = analyzeEmail(circularRecord);

    expect(examResult.importance.importanceScore).toBeGreaterThan(circularResult.importance.importanceScore);
    expect(examResult.importance.importanceScore).toBeGreaterThanOrEqual(60);
    expect(examResult.importance.importanceReasons.some(r => r.includes('academic milestone'))).toBe(true);
  });

  it('ranks formal salary / financial credit higher than marketing discount email', () => {
    const salaryRecord = createDummyRecord({
      from: 'HDFC Bank Alerts <alerts@hdfcbank.com>',
      fromDomain: 'hdfcbank.com',
      subject: 'Account Credited: Monthly Salary Deposit',
      bodyTextPreview: 'Your account has been credited with salary INR 85,000. View your updated account statement and transaction details.',
    });

    const discountRecord = createDummyRecord({
      from: 'Fashion Store <news@retailstore.com>',
      fromDomain: 'retailstore.com',
      subject: 'Mega weekend clearance sale: up to 60% off everything!',
      bodyTextPreview: 'Use promo code SAVE60 for discount on all apparel. Limited time offer. Unsubscribe here.',
    });

    const salaryResult = analyzeEmail(salaryRecord);
    const discountResult = analyzeEmail(discountRecord);

    expect(salaryResult.importance.importanceScore).toBeGreaterThan(discountResult.importance.importanceScore);
    expect(salaryResult.importance.importanceScore).toBeGreaterThanOrEqual(55);
    expect(discountResult.importance.importanceScore).toBeLessThanOrEqual(20);
    expect(discountResult.importance.importanceReasons.some(r => r.includes('Promotional'))).toBe(true);
  });

  it('boosts direct one-to-one conversation thread over mass distribution', () => {
    const directReply = createDummyRecord({
      from: 'Professor Smith <smith@university.edu>',
      fromDomain: 'university.edu',
      subject: 'Re: Feedback on Chapter 3 thesis draft',
      bodyTextPreview: 'Hi Vasu, I reviewed your chapter draft. The methodology section looks solid, let us discuss on Tuesday.',
    });

    const massNewsletter = createDummyRecord({
      from: 'Tech Weekly <digest@technews.com>',
      fromDomain: 'technews.com',
      subject: 'This week in AI: What is new in Chrome 134',
      bodyTextPreview: 'Here is your weekly digest of technology developments. Click here to unsubscribe or manage your subscription.',
    });

    const directResult = analyzeEmail(directReply);
    const newsletterResult = analyzeEmail(massNewsletter);

    expect(directResult.importance.importanceScore).toBeGreaterThan(newsletterResult.importance.importanceScore);
    expect(directResult.importance.importanceReasons.some(r => r.includes('Direct individual reply'))).toBe(true);
    expect(newsletterResult.importance.importanceReasons.some(r => r.includes('Broadcast mailing list'))).toBe(true);
  });

  it('keeps scores bounded strictly between 0 and 100', () => {
    const extremeLow = createDummyRecord({
      from: 'Promo <spam@promo.com>',
      fromDomain: 'promo.com',
      subject: 'Discounts promo code coupon clearance sale',
      bodyTextPreview: 'Exclusive promo code 70% off discount. Unsubscribe now.',
    });

    const extremeHigh = createDummyRecord({
      from: 'Dean Office <dean@university.edu>',
      fromDomain: 'university.edu',
      subject: 'Re: Congratulations!! Super Dream Offer and Final Placement Selection Letter',
      bodyTextPreview: 'Dear Student, Congratulations on your Super Dream Offer letter. Please submit the signed acceptance today.',
    });

    const lowResult = analyzeEmail(extremeLow);
    const highResult = analyzeEmail(extremeHigh);

    expect(lowResult.importance.importanceScore).toBeGreaterThanOrEqual(0);
    expect(lowResult.importance.importanceScore).toBeLessThanOrEqual(100);
    expect(highResult.importance.importanceScore).toBeGreaterThanOrEqual(0);
    expect(highResult.importance.importanceScore).toBeLessThanOrEqual(100);
  });
});
