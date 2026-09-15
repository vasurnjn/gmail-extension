import { describe, it, expect } from 'vitest';
import {
  extractCanonicalEntity,
  extractTopicScope,
  extractVenue,
  extractReminderSignals,
  extractInvariants,
  isTopicCompatible,
} from '../src/background/analysis/change';
import { EmailRecord } from '../src/shared/types';

function createRecord(overrides: Partial<EmailRecord>): EmailRecord {
  return {
    id: 'msg_test_change',
    threadId: 'th_test_change',
    subject: 'Subject',
    from: 'Sender <sender@example.com>',
    fromDomain: 'example.com',
    snippet: 'Snippet',
    internalDate: 1789642800000,
    processedAt: 1789642800000,
    bodyTextPreview: 'Body text preview',
    labels: ['INBOX'],
    isUnread: true,
    category: 'career_recruitment',
    confidence: 0.9,
    importanceScore: 70,
    urgencyScore: 50,
    actionRequired: true,
    actionType: 'attend',
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

describe('Phase 4A: Invariant and Entity Extraction', () => {
  // 1. Known company explicitly mentioned
  it('1. extracts known company explicitly mentioned in subject', () => {
    const record = createRecord({
      subject: 'Smart Data Solutions PPT scheduled on 17th September 2026 by 4.30pm',
      from: 'Placement Office <placement@vit.ac.in>',
      fromDomain: 'vit.ac.in',
    });

    const result = extractCanonicalEntity(record);
    expect(result.entityStatus).toBe('known');
    expect(result.canonicalEntity).toBe('smart data solutions');
    expect(result.rawEntity).toBe('Smart Data Solutions');
  });

  // 2. Company extracted from content despite university/aggregator sender
  it('2. extracts company from content despite university/aggregator sender domain', () => {
    const record = createRecord({
      subject: 'Schneider Electric Super Dream Internship - 2027 Batch',
      from: 'CDC Team <cdc@university.ac.in>',
      fromDomain: 'university.ac.in',
      bodyTextPreview: 'Please register for Schneider Electric campus drive.',
    });

    const result = extractCanonicalEntity(record);
    expect(result.entityStatus).toBe('known');
    expect(result.canonicalEntity).toBe('schneider electric');
    // Must NOT extract "university.ac.in" as the entity!
    expect(result.canonicalEntity).not.toContain('university');
  });

  // 3. Unknown entity
  it('3. returns entityStatus unknown when no reliable organization is identifiable', () => {
    const record = createRecord({
      subject: 'Important Announcement Regarding Tomorrow',
      from: 'User <user@gmail.com>',
      fromDomain: 'gmail.com',
      bodyTextPreview: 'Please attend the mandatory meeting in the auditorium.',
    });

    const result = extractCanonicalEntity(record);
    expect(result.entityStatus).toBe('unknown');
    expect(result.canonicalEntity).toBeNull();
  });

  // 4. Ambiguous/multiple entities
  it('4. returns entityStatus ambiguous when multiple competing entities share the subject anchor', () => {
    const record = createRecord({
      subject: 'Consortium drive: Company A, Company B, and Company C',
      from: 'TPO <tpo@college.edu>',
      fromDomain: 'college.edu',
    });

    const result = extractCanonicalEntity(record);
    expect(result.entityStatus).toBe('ambiguous');
    expect(result.canonicalEntity).toBeNull();
  });

  // 5. Company A vs Company B extraction
  it('5. extracts distinct canonical entities for Company A and Company B with identical wording', () => {
    const recordA = createRecord({
      subject: 'Company A PPT tomorrow at 5 PM in SJT 717',
    });
    const recordB = createRecord({
      subject: 'Company B PPT tomorrow at 5 PM in SJT 717',
    });

    const resultA = extractCanonicalEntity(recordA);
    const resultB = extractCanonicalEntity(recordB);

    expect(resultA.entityStatus).toBe('known');
    expect(resultB.entityStatus).toBe('known');
    expect(resultA.canonicalEntity).toBe('company a');
    expect(resultB.canonicalEntity).toBe('company b');
    expect(resultA.canonicalEntity).not.toBe(resultB.canonicalEntity);
  });

  // 6. Software Engineer topic
  it('6. extracts Software Engineer role scope', () => {
    const record = createRecord({
      subject: 'Company A Software Engineer recruitment drive',
      bodyTextPreview: 'Applications are open for Software Engineer role.',
    });

    const result = extractTopicScope(record);
    expect(result.topicStatus).toBe('known');
    expect(result.roleOrProfile).toBe('software_engineer');
    expect(result.topicScope).toContain('software_engineer');
  });

  // 7. Data Analyst topic
  it('7. extracts Data Analyst role scope distinctly from Software Engineer', () => {
    const record = createRecord({
      subject: 'Company A Data Analyst recruitment drive',
      bodyTextPreview: 'Applications are open for Data Analyst role.',
    });

    const result = extractTopicScope(record);
    expect(result.topicStatus).toBe('known');
    expect(result.roleOrProfile).toBe('data_analyst');
    expect(result.topicScope).toContain('data_analyst');
    expect(result.topicScope).not.toBe('recruitment_software_engineer');
  });

  // 8. Recruitment vs Hackathon topic distinction
  it('8. distinguishes Recruitment process from Hackathon process under same company', () => {
    const recordRecruitment = createRecord({
      subject: 'Company A recruitment drive announcement',
    });
    const recordHackathon = createRecord({
      subject: 'Company A hackathon registration open',
    });

    const topicRecruitment = extractTopicScope(recordRecruitment);
    const topicHackathon = extractTopicScope(recordHackathon);

    expect(topicRecruitment.topicStatus).toBe('known');
    expect(topicHackathon.topicStatus).toBe('known');
    expect(topicRecruitment.topicScope).toBe('recruitment');
    expect(topicHackathon.topicScope).toBe('hackathon');
    expect(topicRecruitment.topicScope).not.toBe(topicHackathon.topicScope);
  });

  // 9. Order identifier
  it('9. extracts Order identifier as canonical topicScope', () => {
    const record = createRecord({
      subject: 'Amazon Order #112-987654 confirmed',
      bodyTextPreview: 'Thank you for your purchase. Details for Order #112-987654 below.',
    });

    const result = extractTopicScope(record);
    expect(result.topicStatus).toBe('known');
    expect(result.identifier).toBe('order_112-987654');
    expect(result.topicScope).toBe('order_112-987654');
  });

  // 10. Course code
  it('10. extracts Course code identifier as canonical topicScope', () => {
    const record = createRecord({
      subject: 'CSE1001 Final Examination Schedule',
      bodyTextPreview: 'The exam for CSE1001 will be held next Monday.',
    });

    const result = extractTopicScope(record);
    expect(result.topicStatus).toBe('known');
    expect(result.identifier).toBe('course_cse1001');
    expect(result.topicScope).toBe('course_cse1001');
  });

  // 11. Explicit room/venue
  it('11. extracts explicit physical venue accurately', () => {
    const record1 = createRecord({
      subject: 'Company A PPT tomorrow at 5 PM. Report to SJT 717.',
    });
    const record2 = createRecord({
      subject: 'Technical Round in TT 302',
    });
    const record3 = createRecord({
      subject: 'Annual Meeting',
      bodyTextPreview: 'The session will take place in the Auditorium.',
    });

    expect(extractVenue(record1).venue).toBe('SJT 717');
    expect(extractVenue(record1).venueType).toBe('physical');

    expect(extractVenue(record2).venue).toBe('TT 302');
    expect(extractVenue(record2).venueType).toBe('physical');

    expect(extractVenue(record3).venue).toBe('Auditorium');
    expect(extractVenue(record3).venueType).toBe('physical');
  });

  // 12. Online/Zoom venue
  it('12. extracts virtual/online venue platform', () => {
    const recordZoom = createRecord({
      subject: 'Interview Schedule',
      bodyTextPreview: 'The interview will be conducted on Zoom Meeting. Link below.',
    });
    const recordGMeet = createRecord({
      subject: 'Project Sync',
      bodyTextPreview: 'Join us on Google Meet at 4 PM.',
    });
    const recordVirtual = createRecord({
      subject: 'Orientation',
      bodyTextPreview: 'The event is held online. No physical attendance required.',
    });

    expect(extractVenue(recordZoom).venue).toBe('Zoom');
    expect(extractVenue(recordZoom).venueType).toBe('virtual');

    expect(extractVenue(recordGMeet).venue).toBe('Google Meet');
    expect(extractVenue(recordGMeet).venueType).toBe('virtual');

    expect(extractVenue(recordVirtual).venue).toBe('Online (Virtual)');
    expect(extractVenue(recordVirtual).venueType).toBe('virtual');
  });

  // 13. Reminder detection
  it('13. detects standard reminder signals', () => {
    const record1 = createRecord({
      subject: 'Reminder: Company A PPT tomorrow at 5 PM',
    });
    const record2 = createRecord({
      subject: 'Gentle reminder: Please submit your feedback',
    });

    const res1 = extractReminderSignals(record1);
    expect(res1.isReminder).toBe(true);
    expect(res1.isUrgentTone).toBe(false);

    const res2 = extractReminderSignals(record2);
    expect(res2.isReminder).toBe(true);
    expect(res2.cues).toContain('gentle reminder');
  });

  // 14. URGENT reminder detection
  it('14. detects URGENT reminder and immediate tone', () => {
    const record = createRecord({
      subject: 'URGENT REMINDER: Company A PPT tomorrow at 5 PM. Report immediately.',
    });

    const res = extractReminderSignals(record);
    expect(res.isReminder).toBe(true);
    expect(res.isUrgentTone).toBe(true);
    expect(res.cues).toContain('urgent reminder');
    expect(res.cues).toContain('report immediately');
  });

  // 15. Final reminder detection
  it('15. detects final reminder and final notice signals', () => {
    const record = createRecord({
      subject: 'LAST AND FINAL REMINDER: Registration closes today',
    });

    const res = extractReminderSignals(record);
    expect(res.isReminder).toBe(true);
    expect(res.isFinalNotice).toBe(true);
  });

  // 16. Reminder wording does not alter factual extraction
  it('16. produces identical factual invariants regardless of reminder / urgent wording', () => {
    const baseRecord = createRecord({
      subject: 'Company A PPT on Sep 17 at 5 PM in SJT 717',
    });
    const urgentReminderRecord = createRecord({
      subject: 'URGENT FINAL REMINDER: Company A PPT on Sep 17 at 5 PM in SJT 717. Report immediately!',
    });

    const baseInvariants = extractInvariants(baseRecord);
    const urgentInvariants = extractInvariants(urgentReminderRecord);

    // Factual fields must match identically
    expect(baseInvariants.canonicalEntity).toBe('company a');
    expect(urgentInvariants.canonicalEntity).toBe('company a');
    expect(baseInvariants.entityStatus).toBe('known');
    expect(urgentInvariants.entityStatus).toBe('known');
    expect(baseInvariants.venue).toBe('SJT 717');
    expect(urgentInvariants.venue).toBe('SJT 717');
    expect(baseInvariants.topicScope).toBe(urgentInvariants.topicScope);

    // Only communication tone signals differ
    expect(baseInvariants.reminderSignals.isReminder).toBe(false);
    expect(urgentInvariants.reminderSignals.isReminder).toBe(true);
    expect(urgentInvariants.reminderSignals.isUrgentTone).toBe(true);
    expect(urgentInvariants.reminderSignals.isFinalNotice).toBe(true);
  });

  // 17. Generic "PPT tomorrow" remains topic/entity unknown
  it('17. keeps entity and topic unknown for generic "Tomorrow PPT schedule"', () => {
    const record = createRecord({
      subject: "Tomorrow's PPT schedule has been updated",
      from: 'Notification <noreply@aggregator.com>',
      fromDomain: 'aggregator.com',
      bodyTextPreview: 'Please check your portal for tomorrow schedule.',
    });

    const invariants = extractInvariants(record);
    expect(invariants.entityStatus).toBe('unknown');
    expect(invariants.canonicalEntity).toBeNull();
    expect(invariants.topicStatus).toBe('unknown');
    expect(invariants.topicScope).toBeNull();
  });

  // 18. No hardcoded user/company-specific assumptions
  it('18. works on arbitrary novel organization names without hardcoding', () => {
    const recordNovel = createRecord({
      subject: 'NovaTech BioSciences Recruitment Drive 2027',
      from: 'HR Department <careers@novatechbio.com>',
      fromDomain: 'novatechbio.com',
      bodyTextPreview: 'NovaTech BioSciences is visiting for campus placements.',
    });

    const result = extractCanonicalEntity(recordNovel);
    expect(result.entityStatus).toBe('known');
    expect(result.canonicalEntity).toBe('novatech biosciences');
  });
});

describe('Phase 4A Real-World Regression Tests (Hardening Pass)', () => {
  // E1. Ujjivan entity extraction
  it('E1. extracts known entity for Ujjivan Small Finance Bank with urgent prefix and intermediary sender', () => {
    const record = createRecord({
      subject:
        'Report immediately: Ujjivan Small Finance Bank PPT and selection process is scheduled on 16th September 2026 by 6.30 pm - SJT706',
      from: 'CDC Office <cdc@vit.ac.in>',
      fromDomain: 'vit.ac.in',
    });

    const result = extractCanonicalEntity(record);
    expect(result.entityStatus).toBe('known');
    expect(result.canonicalEntity).toBe('ujjivan small finance bank');
  });

  // E2. Ujjivan venue
  it('E2. extracts SJT706 as venue and NOT as topicScope/identifier', () => {
    const record = createRecord({
      subject:
        'Report immediately: Ujjivan Small Finance Bank PPT and selection process is scheduled on 16th September 2026 by 6.30 pm - SJT706',
    });

    const venueRes = extractVenue(record);
    expect(venueRes.venue).toBe('SJT 706');
    expect(venueRes.venueType).toBe('physical');

    const topicRes = extractTopicScope(record);
    expect(topicRes.identifier).not.toBe('course_sjt706');
    expect(topicRes.topicScope).not.toBe('course_sjt706');
    expect(topicRes.topicScope).not.toContain('sjt706');
  });

  // E3. Ujjivan second venue
  it('E3. extracts SJT717 as venue and NOT as topicScope/identifier for Ujjivan second email', () => {
    const record = createRecord({
      subject:
        'Update: Ujjivan Small Finance Bank PPT and selection process is scheduled on 16th & 17th September 2026 by 8.00 am - CDC Office (SJT717)',
    });

    const venueRes = extractVenue(record);
    expect(venueRes.venue).toBe('SJT 717');
    expect(venueRes.venueType).toBe('physical');

    const topicRes = extractTopicScope(record);
    expect(topicRes.identifier).not.toBe('course_sjt717');
    expect(topicRes.topicScope).not.toBe('course_sjt717');
    expect(topicRes.topicScope).not.toContain('sjt717');
  });

  // E4. Smart Data AI
  it('E4. extracts known Smart Data entity and AI-specific topic for Smart Data AI role', () => {
    const record = createRecord({
      subject: 'Smart Data Solutions PPT (AI Role)',
    });

    const entityRes = extractCanonicalEntity(record);
    expect(entityRes.entityStatus).toBe('known');
    expect(entityRes.canonicalEntity).toBe('smart data solutions');

    const topicRes = extractTopicScope(record);
    expect(topicRes.topicStatus).toBe('known');
    expect(topicRes.topicScope).toBe('role_ai');
    expect(topicRes.roleOrProfile).toBe('role_ai');
  });

  // E5. Smart Data Software
  it('E5. extracts known Smart Data entity and Software-specific topic for Smart Data Software role', () => {
    const record = createRecord({
      subject: 'Smart Data Solutions PPT (Software Role)',
    });

    const entityRes = extractCanonicalEntity(record);
    expect(entityRes.entityStatus).toBe('known');
    expect(entityRes.canonicalEntity).toBe('smart data solutions');

    const topicRes = extractTopicScope(record);
    expect(topicRes.topicStatus).toBe('known');
    expect(topicRes.topicScope).toBe('role_software');
    expect(topicRes.roleOrProfile).toBe('role_software');
  });

  // E6. AI vs Software compatibility
  it('E6. verifies AI and Software role topics are incompatible according to isTopicCompatible', () => {
    expect(isTopicCompatible('role_ai', 'role_software')).toBe(false);
    expect(isTopicCompatible('role_ai', 'role_ai')).toBe(true);
    expect(isTopicCompatible('role_software', 'role_software')).toBe(true);
  });

  // E7. Explicit course
  it('E7. allows course topic when explicit course context is present', () => {
    const record = createRecord({
      subject: 'Course CSE1001 - Database Management Systems',
      bodyTextPreview: 'Course materials for Course CSE1001 are now uploaded.',
    });

    const topicRes = extractTopicScope(record);
    expect(topicRes.topicStatus).toBe('known');
    expect(topicRes.topicScope).toBe('course_cse1001');
    expect(topicRes.identifier).toBe('course_cse1001');
  });

  // E8. Venue-looking identifier
  it('E8. ensures venue-looking identifier Room SJT717 does not become a course topic', () => {
    const record = createRecord({
      subject: 'Placement meeting in Room SJT717',
      bodyTextPreview: 'All candidates report to Room SJT717.',
    });

    const topicRes = extractTopicScope(record);
    expect(topicRes.identifier).not.toBe('course_sjt717');
    expect(topicRes.topicScope).not.toBe('course_sjt717');

    const venueRes = extractVenue(record);
    expect(venueRes.venue).toBe('SJT 717');
    expect(venueRes.venueType).toBe('physical');
  });

  // E9. Generic identifier
  it('E9. ensures generic identifier TOP100 does not become a course topic without course context', () => {
    const record = createRecord({
      subject: 'Announcement for TOP100 shortlisted candidates',
      bodyTextPreview: 'The TOP100 students should check their portal.',
    });

    const topicRes = extractTopicScope(record);
    expect(topicRes.identifier).toBeNull();
    expect(topicRes.topicScope).toBeNull();
    expect(topicRes.topicStatus).toBe('unknown');
  });

  // E10. Batch number
  it('E10. ensures batch number Batch 2027 does not become a course topic', () => {
    const record = createRecord({
      subject: 'Important notice for Batch 2027',
      bodyTextPreview: 'Batch 2027 students must register before Friday.',
    });

    const topicRes = extractTopicScope(record);
    expect(topicRes.identifier).toBeNull();
    expect(topicRes.topicScope).toBeNull();
    expect(topicRes.topicStatus).toBe('unknown');
  });
});
