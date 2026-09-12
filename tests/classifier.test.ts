import { describe, it, expect } from 'vitest';
import { extractSignals } from '../src/background/analysis/extractor';
import { classifyCategory } from '../src/background/analysis/classifier';
import { analyzeEmail } from '../src/background/analysis';
import { EmailRecord } from '../src/shared/types';

function createDummyRecord(overrides: Partial<EmailRecord>): EmailRecord {
  return {
    id: 'msg_test_1',
    threadId: 'th_test_1',
    subject: 'Test Subject',
    from: 'Generic Sender <sender@example.com>',
    fromDomain: 'example.com',
    snippet: 'Snippet preview',
    internalDate: Date.now(),
    processedAt: Date.now(),
    bodyTextPreview: 'Body preview text',
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

describe('Generic Category Classifier (Phase 1C.2)', () => {
  // 1. Recruitment / Assessment Email
  it('classifies recruitment assessment email into Career & Placement', () => {
    const record = createDummyRecord({
      from: 'Campus Relations <careers@enterprise.com>',
      fromDomain: 'enterprise.com',
      subject: 'Recruitment Assessment: Software Engineer Role',
      bodyTextPreview: 'Dear Candidate, please complete your online assessment before tomorrow. Shortlist will be announced next week.',
    });

    const { signals, result } = analyzeEmail(record);
    expect(result.category).toBe('career_placement');
    expect(result.categoryScore).toBeGreaterThanOrEqual(40);
    expect(result.detectionReasons.length).toBeGreaterThan(0);
    expect(result.categoryScores['career_placement']).toBe(result.categoryScore);
  });

  // 2. Banking / Statement Email
  it('classifies banking email into Finance & Banking', () => {
    const record = createDummyRecord({
      from: 'National Bank <alerts@nationalbank.com>',
      fromDomain: 'nationalbank.com',
      subject: 'Your Monthly Account Statement is Ready',
      bodyTextPreview: 'Your monthly bank account statement for August has been generated. Please review your recent transaction history and payment due dates.',
    });

    const { result } = analyzeEmail(record);
    expect(result.category).toBe('finance_banking');
    expect(result.categoryScore).toBeGreaterThanOrEqual(40);
    expect(result.detectionReasons.some((r) => r.toLowerCase().includes('statement') || r.toLowerCase().includes('financial'))).toBe(true);
  });

  // 3. Academic Submission Email
  it('classifies university course submission into Academic & Education', () => {
    const record = createDummyRecord({
      from: 'Department Office <academic.cell@university.edu>',
      fromDomain: 'university.edu',
      subject: 'Assignment 3 Submission Deadline and Exam Schedule',
      bodyTextPreview: 'All students must submit their assignment before Friday. Semester exam hall tickets will be released on the student portal.',
    });

    const { result } = analyzeEmail(record);
    expect(result.category).toBe('academic_education');
    expect(result.categoryScore).toBeGreaterThanOrEqual(40);
    expect(result.detectionReasons.some((r) => r.toLowerCase().includes('educational') || r.toLowerCase().includes('academic'))).toBe(true);
  });

  // 4. Meeting Invitation Email
  it('classifies meeting invitation into Events & Meetings', () => {
    const record = createDummyRecord({
      from: 'Organizer <lead@consulting.org>',
      fromDomain: 'consulting.org',
      subject: 'Architecture Sync - Calendar Invite',
      bodyTextPreview: 'Please join our team sync. Google meet link and agenda attached. Please RSVP before tomorrow.',
    });

    const { result } = analyzeEmail(record);
    expect(result.category).toBe('events_meetings');
    expect(result.categoryScore).toBeGreaterThanOrEqual(40);
    expect(result.detectionReasons.some((r) => r.toLowerCase().includes('meeting') || r.toLowerCase().includes('event'))).toBe(true);
  });

  // 5. Shopping / Order Fulfillment Email
  it('classifies package shipping email into Shopping & Orders', () => {
    const record = createDummyRecord({
      from: 'Order Updates <shipping@storefront.com>',
      fromDomain: 'storefront.com',
      subject: 'Your order has shipped! Tracking number included',
      bodyTextPreview: 'Great news! Your package is out for delivery. You can track package status using the tracking number below.',
    });

    const { result } = analyzeEmail(record);
    expect(result.category).toBe('shopping_orders');
    expect(result.categoryScore).toBeGreaterThanOrEqual(40);
    expect(result.detectionReasons.some((r) => r.toLowerCase().includes('order') || r.toLowerCase().includes('tracking'))).toBe(true);
  });

  // 6. Promotional / Newsletter Email
  it('classifies discount promotional email into Newsletters & Promotions', () => {
    const record = createDummyRecord({
      from: 'Style Club <deals@apparelstore.com>',
      fromDomain: 'apparelstore.com',
      subject: 'Weekend Flash Sale: 40% off everything!',
      bodyTextPreview: 'Exclusive offer! Use promo code FLASH40. Limited time offer. To stop receiving these emails, unsubscribe here.',
      labels: ['CATEGORY_PROMOTIONS'],
    });

    const { result } = analyzeEmail(record);
    expect(result.category).toBe('newsletters_promotions');
    expect(result.categoryScore).toBeGreaterThanOrEqual(40);
    expect(result.detectionReasons.some((r) => r.toLowerCase().includes('promotional') || r.toLowerCase().includes('unsubscribe'))).toBe(true);
  });

  // 7. Personal / Direct Email
  it('classifies direct personal message into Personal & Direct', () => {
    const record = createDummyRecord({
      from: 'Jordan Lee <jordan.lee@gmail.com>',
      fromDomain: 'gmail.com',
      subject: 'Re: Dinner plans for tomorrow night',
      bodyTextPreview: 'Hi! That time works perfectly for me. Let us meet at 7pm at the corner cafe. Cheers, Jordan',
      labels: ['INBOX'],
    });

    const { result } = analyzeEmail(record);
    expect(result.category).toBe('personal');
    expect(result.categoryScore).toBeGreaterThanOrEqual(40);
    expect(result.detectionReasons.some((r) => r.toLowerCase().includes('reply') || r.toLowerCase().includes('personal'))).toBe(true);
  });

  // 8. Ambiguous Email with insufficient evidence
  it('leaves ambiguous email with insufficient evidence as Uncategorized', () => {
    const record = createDummyRecord({
      from: 'Random Sender <contact@randomdomain.xyz>',
      fromDomain: 'randomdomain.xyz',
      subject: 'Hello there',
      bodyTextPreview: 'Can you please give me a quick call when you have a minute?',
      labels: ['INBOX'],
    });

    const { result } = analyzeEmail(record);
    expect(result.category).toBe('uncategorized');
    expect(result.confidence).toBe(0);
    expect(result.categoryScore).toBeLessThan(40);
  });

  // 9. Automated notification without strong domain category
  it('handles automated system alert without forcing into false category', () => {
    const record = createDummyRecord({
      from: 'Auth Service <no-reply@securitygate.net>',
      fromDomain: 'securitygate.net',
      subject: 'Security Notice: New sign-in detected',
      bodyTextPreview: 'A new sign in was observed from Chrome on Windows. If this was you, no action is needed. Automated message, please do not reply.',
      labels: ['INBOX'],
    });

    const { result } = analyzeEmail(record);
    // Should NOT be forced into shopping, healthcare or finance
    expect(result.category).not.toBe('shopping_orders');
    expect(result.category).not.toBe('healthcare');
  });

  // 10. Generic email with no strong category remains Uncategorized
  it('leaves generic text email as Uncategorized', () => {
    const record = createDummyRecord({
      from: 'Notes <info@notesapp.co>',
      fromDomain: 'notesapp.co',
      subject: 'Your scratchpad sync',
      bodyTextPreview: 'Here are the contents of your scratchpad note: lorem ipsum dolor sit amet.',
      labels: ['INBOX'],
    });

    const { result } = analyzeEmail(record);
    expect(result.category).toBe('uncategorized');
    expect(result.confidence).toBe(0);
  });

  // 11. Multi-category evidence preservation
  it('evaluates and preserves competing multi-category evidence scores', () => {
    // Email containing both career/recruitment and event/calendar meeting elements
    const record = createDummyRecord({
      from: 'University Placement Office <placements@techinstitute.ac.in>',
      fromDomain: 'techinstitute.ac.in',
      subject: 'Campus Recruitment Drive & Calendar Invite',
      bodyTextPreview: 'Dear students, attend the upcoming recruitment session. Google meet link and calendar invite included. Complete your registration.',
      labels: ['INBOX'],
    });

    const { result } = analyzeEmail(record);
    // Both categories should have evidence scores
    expect(result.categoryScores['career_placement']).toBeGreaterThan(30);
    expect(result.categoryScores['events_meetings']).toBeGreaterThan(20);
    expect(result.categoryScores['academic_education']).toBeGreaterThan(20);

    // Primary category should be the highest
    expect(result.category).toBe('career_placement');
  });

  // 12. Combination test: Ambiguous keyword alone does not trigger high score
  it('does not classify isolated "appointment" into Healthcare without medical context', () => {
    const record = createDummyRecord({
      from: 'Barber Shop <desk@saloncentral.com>',
      fromDomain: 'saloncentral.com',
      subject: 'Your haircut appointment reminder',
      bodyTextPreview: 'See you tomorrow for your appointment at 3pm.',
      labels: ['INBOX'],
    });

    const { result } = analyzeEmail(record);
    // Without doctor/clinic/prescription/hospital, appointment alone should NOT qualify as healthcare
    expect(result.category).not.toBe('healthcare');
    expect(result.categoryScores['healthcare']).toBeLessThan(40);
  });

  // 13. Verifies that classification is completely user-independent (no hardcoded addresses)
  it('operates generically across different arbitrary user emails and domains', () => {
    const arbitraryUserA = createDummyRecord({
      from: 'Campus Drive <placement@college-a.ac.in>',
      fromDomain: 'college-a.ac.in',
      subject: 'Shortlist announced for Aptitude Assessment',
      bodyTextPreview: 'Check your eligibility and register before the deadline.',
    });

    const arbitraryUserB = createDummyRecord({
      from: 'Campus Drive <placement@college-b.ac.in>',
      fromDomain: 'college-b.ac.in',
      subject: 'Shortlist announced for Aptitude Assessment',
      bodyTextPreview: 'Check your eligibility and register before the deadline.',
    });

    const resA = analyzeEmail(arbitraryUserA).result;
    const resB = analyzeEmail(arbitraryUserB).result;

    expect(resA.category).toBe('career_placement');
    expect(resB.category).toBe('career_placement');
    expect(resA.categoryScore).toBe(resB.categoryScore);
  });

  // 14. Real-Inbox Case 1: Super Dream Offer celebratory notification
  it('classifies "Congratulations!! Human Resocia Co. Ltd. Super Dream Offer..." as Career & Placement', () => {
    const record = createDummyRecord({
      from: 'Placement Cell <placements@university.ac.in>',
      fromDomain: 'university.ac.in',
      subject: 'Congratulations!! Human Resocia Co. Ltd. Super Dream Offer...',
      bodyTextPreview: 'Hearty congratulations to the students selected for the Super Dream Offer. The compensation package and joining details will be shared soon.',
      labels: ['INBOX'],
    });

    const { result } = analyzeEmail(record);
    expect(result.category).toBe('career_placement');
    expect(result.categoryScore).toBeGreaterThanOrEqual(50);
    expect(result.detectionReasons.some((r) => r.toLowerCase().includes('offer') || r.toLowerCase().includes('selection'))).toBe(true);
  });

  // 15. Real-Inbox Case 2: Super Dream Offer selection notification
  it('classifies "Congratulations!! ZS Associates super dream offer selection..." as Career & Placement', () => {
    const record = createDummyRecord({
      from: 'Placement Coordinator <cdc@campus.edu>',
      fromDomain: 'campus.edu',
      subject: 'Congratulations!! ZS Associates super dream offer selection...',
      bodyTextPreview: 'Please find below the final selection results for ZS Associates. Congratulations to all selected candidates.',
      labels: ['INBOX'],
    });

    const { result } = analyzeEmail(record);
    expect(result.category).toBe('career_placement');
    expect(result.categoryScore).toBeGreaterThanOrEqual(55);
    expect(result.detectionReasons.some((r) => r.toLowerCase().includes('selection') || r.toLowerCase().includes('offer'))).toBe(true);
  });

  // 16. Real-Inbox Case 3: Campus PPT and selection process by a financial entity
  it('classifies "Ujjivan Small Finance Bank PPT and selection process..." into Career while preserving Finance evidence', () => {
    const record = createDummyRecord({
      from: 'Career Services <careers@institution.edu>',
      fromDomain: 'institution.edu',
      subject: 'Ujjivan Small Finance Bank PPT and selection process...',
      bodyTextPreview: 'The Pre-Placement Talk (PPT) and initial selection process for Ujjivan Small Finance Bank is scheduled for tomorrow. Eligible students must attend.',
      labels: ['INBOX'],
    });

    const { result } = analyzeEmail(record);
    expect(result.category).toBe('career_placement');
    expect(result.categoryScore).toBeGreaterThanOrEqual(50);
    // Preserves multi-category evidence for finance as well
    expect(result.categoryScores['finance_banking']).toBeGreaterThan(0);
    expect(result.categoryScores['career_placement']).toBeGreaterThan(result.categoryScores['finance_banking']);
  });

  // 17. Real-Inbox Case 4: Scholar batch handling with and without recruitment context
  it('relies on contextual evidence and does not classify general academic scholars/batch as Career', () => {
    // 4A: Pure academic scholarship notice with "scholars" and "batch" -> NOT Career & Placement
    const academicNotice = createDummyRecord({
      from: 'Dean Academic Office <academics@college.edu>',
      fromDomain: 'college.edu',
      subject: 'Kind Attn: Merit Scholars - 2027 Batch',
      bodyTextPreview: 'Please find attached the list of selected students for semester tuition fee scholarship.',
      labels: ['INBOX'],
    });

    const academicResult = analyzeEmail(academicNotice).result;
    expect(academicResult.category).not.toBe('career_placement');
    expect(academicResult.category).toBe('academic_education');

    // 4B: Industry campus hiring program (e.g. Visteon Scholars) with recruitment/internship context -> Career & Placement
    const recruitmentProgram = createDummyRecord({
      from: 'Placement Cell <placements@college.edu>',
      fromDomain: 'college.edu',
      subject: 'Kind Attn: Visteon Scholars - 2027 Batch',
      bodyTextPreview: 'Eligible candidates for the Visteon Scholars campus hiring and internship program must register before Friday. Shortlist for the coding round will follow.',
      labels: ['INBOX'],
    });

    const recruitmentResult = analyzeEmail(recruitmentProgram).result;
    expect(recruitmentResult.category).toBe('career_placement');
    expect(recruitmentResult.categoryScore).toBeGreaterThanOrEqual(45);
  });

  // 18. Anti-false-positive: Commercial retail offer does not classify as Career
  it('does not classify retail/promotional "offer" as Career & Placement', () => {
    const promoRecord = createDummyRecord({
      from: 'Retail Brand <newsletter@clothingstore.com>',
      fromDomain: 'clothingstore.com',
      subject: 'Special Offer: 50% discount this weekend!',
      bodyTextPreview: 'Enjoy our exclusive offer with promo code SAVE50. Unsubscribe anytime.',
      labels: ['CATEGORY_PROMOTIONS'],
    });

    const { result } = analyzeEmail(promoRecord);
    expect(result.category).not.toBe('career_placement');
    expect(result.category).toBe('newsletters_promotions');
  });
});
