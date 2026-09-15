import { describe, it, expect } from 'vitest';
import { EmailRecord, AttentionItem } from '../src/shared/types';
import {
  extractCanonicalEntity,
  extractTopicScope,
  extractVenue,
  extractInvariants,
  splitAnnouncementAndFooter,
  isAcademicOrInstitutionalContext,
} from '../src/background/analysis/change/extractor';
import {
  isTopicCompatible,
  findAttentionItemCandidate,
  evaluateItemCandidate,
} from '../src/background/analysis/change/identity';
import { diffAttentionItemState } from '../src/background/analysis/change/diff';
import { classifyRelation } from '../src/background/analysis/change/classifier';
import { analyzeEmailChange } from '../src/background/analysis/change/pipeline';
import { ExtractedTemporalEntity } from '../src/shared/types';

function createTemporalEntity(
  overrides: Partial<ExtractedTemporalEntity> = {}
): ExtractedTemporalEntity {
  return {
    id: `temp_${Math.random().toString(36).slice(2, 7)}`,
    rawText: '17th September 2026 by 4.30pm',
    type: 'event',
    status: 'upcoming',
    timestamp: Date.UTC(2026, 8, 17, 11, 0, 0),
    datePrecision: 'exact',
    timePrecision: 'exact',
    isAmbiguous: false,
    associatedAction: 'attend',
    contextSnippet: 'PPT is scheduled on 17th September 2026 by 4.30pm',
    confidence: 'HIGH',
    evidenceReasons: [],
    ...overrides,
  };
}

function createEmail(overrides: Partial<EmailRecord> = {}): EmailRecord {
  const event1 = createTemporalEntity({
    rawText: '17th September 2026 by 4.30pm',
    timestamp: Date.UTC(2026, 8, 17, 11, 0, 0),
    contextSnippet: 'PPT is scheduled on 17th September 2026 by 4.30pm',
  });
  const event2 = createTemporalEntity({
    rawText: '18-09-26 9 am onwards',
    timestamp: Date.UTC(2026, 8, 18, 3, 30, 0),
    contextSnippet: 'interviews on 18-09-26 9 am onwards',
  });

  return {
    id: `msg_${Math.random().toString(36).slice(2, 9)}`,
    threadId: 'thread_smart_data_001',
    from: 'Campus Placement Office <cdc@vit.ac.in>',
    fromDomain: 'vit.ac.in',
    to: ['student@vitstudent.ac.in'],
    subject: '',
    snippet: '',
    bodyTextPreview: '',
    internalDate: 1789640000000,
    processedAt: 1789640000000,
    importanceScore: 80,
    urgencyScore: 85,
    category: 'recruitment',
    confidence: 0.95,
    actionRequired: true,
    actionType: 'attend',
    analysisVersion: 3,
    alertStatus: 'pending',
    snoozeUntil: null,
    handledAt: null,
    detectionReasons: [],
    extractedEntities: {
      deadlines: [],
      dates: [],
      organizations: ['Smart Data Solutions'],
      locations: ['SJT 717'],
      ctc: null,
      urls: [],
    },
    attentionItemId: null,
    changeRelation: null,
    temporalAnalysis: {
      entities: [event1, event2],
      primaryEvent: event1,
      primaryDeadline: null,
      hasActiveDeadline: false,
      isOverdue: false,
      hasAmbiguousDates: false,
      temporalUrgencyTier: 'upcoming',
      summaryReason: 'Scheduled PPT event',
    },
    ...overrides,
  };
}

describe('Phase 4 Final Hardening: Contradictory & Ambiguous Topic Handling', () => {
  // Test 1: Internal subject/body topic contradiction
  it('1. Internal subject/body topic contradiction: Subject=Software, Body=AI => topic is ambiguous/conflicting', () => {
    const email1 = createEmail({
      subject:
        'Smart Data Solutions PPT (Software Role ) is scheduled on 17th September 2026 by 4.30pm @SJT 717 Vellore Campus',
      bodyTextPreview:
        'Smart Data Solutions PPT (AI Role) is scheduled on 17th September 2026 by 4.30pm @SJT 717\nPPT followed by interviews on 18-09-26 9 am onwards at VIT Vellore\nAll shortlisted students must attend.',
    });

    const entityResult = extractCanonicalEntity(email1);
    expect(entityResult.entityStatus).toBe('known');
    expect(entityResult.canonicalEntity).toBe('smart data solutions');

    const topicResult = extractTopicScope(email1);
    expect(topicResult.topicStatus).toBe('ambiguous');
    expect(topicResult.topicScope).toBeNull();
    expect(topicResult.subjectTopic).toBe('role_software');
    expect(topicResult.bodyTopic).toBe('role_ai');
    expect(topicResult.conflictingTopics).toEqual(['role_software', 'role_ai']);

    // Evidence must preserve both observations without guessing intent
    expect(topicResult.evidence.some((e) => e.includes('role_software'))).toBe(true);
    expect(topicResult.evidence.some((e) => e.includes('role_ai'))).toBe(true);
    expect(
      topicResult.evidence.some((e) => e.toLowerCase().includes('internal topic contradiction'))
    ).toBe(true);

    const invariants = extractInvariants(email1);
    expect(invariants.canonicalEntity).toBe('smart data solutions');
    expect(invariants.entityStatus).toBe('known');
    expect(invariants.topicStatus).toBe('ambiguous');
    expect(invariants.topicScope).toBeNull();
    expect(invariants.venue).toBe('SJT 717');
  });

  // Test 2: Consistent Software email
  it('2. Consistent Software email: Subject=Software Role, Body=Software Role => topic known = role_software', () => {
    const email2 = createEmail({
      subject:
        'Update : Smart Data Solutions PPT (Software Role ) is scheduled on 17th September 2026 by 4.30pm @SJT 717 Vellore Campus',
      bodyTextPreview:
        'Smart Data Solutions PPT (Software Role) is scheduled on 17th September 2026 by 4.30pm @SJT 717\nPPT followed by interviews on 18-09-26 9 am onwards at VIT Vellore',
    });

    const entityResult = extractCanonicalEntity(email2);
    expect(entityResult.entityStatus).toBe('known');
    expect(entityResult.canonicalEntity).toBe('smart data solutions');

    const topicResult = extractTopicScope(email2);
    expect(topicResult.topicStatus).toBe('known');
    expect(topicResult.topicScope).toBe('role_software');
    expect(topicResult.subjectTopic).toBe('role_software');
    expect(topicResult.bodyTopic).toBe('role_software');
  });

  // Test 3: Consistent AI email
  it('3. Consistent AI email: Subject=AI Role, Body=AI Role => topic known = role_ai', () => {
    const emailAI = createEmail({
      subject:
        'Smart Data Solutions PPT (AI Role) is scheduled on 17th September 2026 by 4.30pm @SJT 717',
      bodyTextPreview:
        'Smart Data Solutions PPT (AI Role) is scheduled on 17th September 2026 by 4.30pm @SJT 717',
    });

    const topicResult = extractTopicScope(emailAI);
    expect(topicResult.topicStatus).toBe('known');
    expect(topicResult.topicScope).toBe('role_ai');
    expect(topicResult.subjectTopic).toBe('role_ai');
    expect(topicResult.bodyTopic).toBe('role_ai');
  });

  // Test 4: AI vs Software independently known => incompatible topics
  it('4. AI vs Software independently known: incompatible topics', () => {
    expect(isTopicCompatible('role_ai', 'role_software')).toBe(false);
    expect(isTopicCompatible('role_software', 'role_ai')).toBe(false);
    expect(isTopicCompatible('role_ai', 'role_ai')).toBe(true);
    expect(isTopicCompatible('role_software', 'role_software')).toBe(true);

    // Existing item with role_software vs incoming consistent AI email
    const emailAI = createEmail({
      threadId: 'thread_ai_001',
      subject: 'Smart Data Solutions PPT (AI Role)',
      bodyTextPreview: 'Smart Data Solutions PPT (AI Role) is scheduled tomorrow.',
    });
    const invariantsAI = extractInvariants(emailAI);

    const existingSoftwareItem: AttentionItem = {
      id: 'att_software_001',
      identityKey: 'recruitment::smart data solutions::role_software',
      category: 'recruitment',
      canonicalEntity: 'smart data solutions',
      entityStatus: 'known',
      topicScope: 'role_software',
      topicStatus: 'known',
      threadIds: ['thread_software_001'],
      messageIds: ['msg_001'],
      latestEmailId: 'msg_001',
      firstSeenAt: Date.now() - 60000,
      lastSeenAt: Date.now() - 60000,
      itemLifecycleState: 'active',
      userAttentionState: 'unhandled',
      importanceScore: 80,
      urgencyScore: 85,
      currentState: {
        primaryEventTimestamp: Date.UTC(2026, 8, 17, 11, 0, 0),
        primaryDeadlineTimestamp: null,
        venue: 'SJT 717',
        actionRequired: true,
        actionType: 'attend',
        itemLifecycleState: 'active',
        subEvents: [],
      },
      history: [],
    };

    const evalResult = evaluateItemCandidate(emailAI, invariantsAI, existingSoftwareItem);
    expect(evalResult.isEligible).toBe(false);
    expect(evalResult.matchStatus).toBe('incompatible');
    expect(evalResult.reasons.some((r) => r.includes('topic contradiction'))).toBe(true);
  });

  // Test 5: Contradictory Smart Data email must NOT produce a confident Software -> AI update
  it('5. Contradictory Smart Data email must NOT produce a confident Software -> AI update', () => {
    const contradictoryEmail = createEmail({
      threadId: 'thread_smart_data_001',
      subject:
        'Smart Data Solutions PPT (Software Role ) is scheduled on 17th September 2026 by 4.30pm @SJT 717 Vellore Campus',
      bodyTextPreview:
        'Smart Data Solutions PPT (AI Role) is scheduled on 17th September 2026 by 4.30pm @SJT 717',
    });
    const contradictoryInvariants = extractInvariants(contradictoryEmail);

    const existingSoftwareItem: AttentionItem = {
      id: 'att_software_001',
      identityKey: 'recruitment::smart data solutions::role_software',
      category: 'recruitment',
      canonicalEntity: 'smart data solutions',
      entityStatus: 'known',
      topicScope: 'role_software',
      topicStatus: 'known',
      threadIds: ['thread_smart_data_001'],
      messageIds: ['msg_001'],
      latestEmailId: 'msg_001',
      firstSeenAt: Date.now() - 60000,
      lastSeenAt: Date.now() - 60000,
      itemLifecycleState: 'active',
      userAttentionState: 'unhandled',
      importanceScore: 80,
      urgencyScore: 85,
      currentState: {
        primaryEventTimestamp: Date.UTC(2026, 8, 17, 11, 0, 0),
        primaryDeadlineTimestamp: null,
        venue: 'SJT 717',
        actionRequired: true,
        actionType: 'attend',
        itemLifecycleState: 'active',
        subEvents: [],
      },
      history: [],
    };

    // State diffing must detect conflicting topic assertion
    const diff = diffAttentionItemState(
      contradictoryEmail,
      contradictoryInvariants,
      existingSoftwareItem
    );
    const topicDelta = diff.deltas.find((d) => d.field === 'topic');
    expect(topicDelta).toBeDefined();
    expect(topicDelta?.changeType).toBe('conflict');

    // Candidate match
    const candidateResult = findAttentionItemCandidate(
      contradictoryEmail,
      [existingSoftwareItem],
      contradictoryInvariants
    );

    // Classification decision: Must be CONFLICT, NEVER UPDATE!
    const decision = classifyRelation(
      candidateResult,
      diff,
      contradictoryInvariants,
      existingSoftwareItem
    );
    expect(decision.relation).toBe('CONFLICT');
    expect(decision.relation).not.toBe('UPDATE');
    expect(decision.shouldCreateNewAttentionItem).toBe(false);
  });

  // Test 6: Later consistent Software email must not cause the system to invent that earlier AI mention was definitely a typo
  it('6. Later consistent Software email must not cause the system to invent that earlier AI mention was definitely a typo', () => {
    // Step 1: Contradictory email arrives first
    const email1 = createEmail({
      id: 'msg_email1',
      threadId: 'thread_smart_data_001',
      internalDate: 1789640000000,
      subject:
        'Smart Data Solutions PPT (Software Role ) is scheduled on 17th September 2026 by 4.30pm @SJT 717 Vellore Campus',
      bodyTextPreview:
        'Smart Data Solutions PPT (AI Role) is scheduled on 17th September 2026 by 4.30pm @SJT 717\nPPT followed by interviews on 18-09-26 9 am onwards at VIT Vellore\nAll shortlisted students must attend.',
    });

    const analysis1 = analyzeEmailChange(email1, []);
    expect(analysis1.isNew).toBe(true);
    expect(analysis1.result.relation).toBe('NEW');
    expect(analysis1.item.canonicalEntity).toBe('smart data solutions');
    expect(analysis1.item.entityStatus).toBe('known');
    expect(analysis1.item.topicStatus).toBe('ambiguous');
    expect(analysis1.item.topicScope).toBeNull();
    // Invariants of email1 remain ambiguous
    const invariants1 = extractInvariants(email1);
    expect(invariants1.topicStatus).toBe('ambiguous');
    expect(invariants1.conflictingTopics).toEqual(['role_software', 'role_ai']);

    // Step 2: Consistent Software email arrives 3 minutes later in the same thread
    const email2 = createEmail({
      id: 'msg_email2',
      threadId: 'thread_smart_data_001',
      internalDate: 1789640000000 + 180000,
      subject:
        'Update : Smart Data Solutions PPT (Software Role ) is scheduled on 17th September 2026 by 4.30pm @SJT 717 Vellore Campus',
      bodyTextPreview:
        'Smart Data Solutions PPT (Software Role) is scheduled on 17th September 2026 by 4.30pm @SJT 717\nPPT followed by interviews on 18-09-26 9 am onwards at VIT Vellore',
    });

    const analysis2 = analyzeEmailChange(email2, [analysis1.item]);

    // System does NOT claim the earlier email had a "typo" or invent explanations
    const allSummariesAndReasons = [
      analysis2.result.summary,
      ...analysis2.item.history.map((h) => h.summary),
      ...(analysis2.result.deltas?.map((d) => d.description) || []),
    ].join(' ');

    expect(allSummariesAndReasons.toLowerCase()).not.toContain('typo');
    expect(allSummariesAndReasons.toLowerCase()).not.toContain('mistake');
    expect(allSummariesAndReasons.toLowerCase()).not.toContain('error in email 1');

    // Email 1's original extracted invariants are preserved
    expect(invariants1.topicStatus).toBe('ambiguous');
    expect(invariants1.subjectTopic).toBe('role_software');
    expect(invariants1.bodyTopic).toBe('role_ai');
  });

  // Test 7: Ujjivan regression
  it('7. Ujjivan regression: entity and recruitment topic remain correctly extracted', () => {
    const emailUjjivanA = createEmail({
      subject:
        'Report immediately: Ujjivan Small Finance Bank PPT and selection process is scheduled on 16th September 2026 by 6.30 pm - SJT706',
      from: 'CDC Office <cdc@vit.ac.in>',
      fromDomain: 'vit.ac.in',
    });

    const emailUjjivanB = createEmail({
      subject:
        'Update: Ujjivan Small Finance Bank PPT and selection process is scheduled on 16th & 17th September 2026 by 8.00 am - CDC Office (SJT717)',
      from: 'CDC Office <cdc@vit.ac.in>',
      fromDomain: 'vit.ac.in',
    });

    const invA = extractInvariants(emailUjjivanA);
    const invB = extractInvariants(emailUjjivanB);

    expect(invA.canonicalEntity).toBe('ujjivan small finance bank');
    expect(invA.entityStatus).toBe('known');
    expect(invA.topicScope).toBe('recruitment');
    expect(invA.topicStatus).toBe('known');

    expect(invB.canonicalEntity).toBe('ujjivan small finance bank');
    expect(invB.entityStatus).toBe('known');
    expect(invB.topicScope).toBe('recruitment');
    expect(invB.topicStatus).toBe('known');

    expect(isTopicCompatible(invA.topicScope, invB.topicScope)).toBe(true);
  });

  // Test 8: Venue regression
  it('8. Venue regression: SJT706/SJT717 are venues, not course topics', () => {
    const recordA = createEmail({
      subject: 'Session in SJT706 tomorrow',
    });
    const recordB = createEmail({
      subject: 'Interview in SJT717 tomorrow',
    });

    const venueA = extractVenue(recordA);
    const venueB = extractVenue(recordB);
    expect(venueA.venue).toBe('SJT 706');
    expect(venueB.venue).toBe('SJT 717');

    const topicA = extractTopicScope(recordA);
    const topicB = extractTopicScope(recordB);
    expect(topicA.topicScope).not.toBe('course_sjt706');
    expect(topicB.topicScope).not.toBe('course_sjt717');
    expect(topicA.identifier).toBeNull();
    expect(topicB.identifier).toBeNull();
  });

  // Test 9: Aggregator/intermediary sender safety tests remain passing
  it('9. Aggregator/intermediary sender safety: intermediary addresses do not become entities', () => {
    const recordAggregator = createEmail({
      from: 'VIT Placement Office <cdc@vit.ac.in>',
      fromDomain: 'vit.ac.in',
      subject: 'Placement Drive Schedule',
      bodyTextPreview: 'Please attend the campus presentation.',
    });

    const entityRes = extractCanonicalEntity(recordAggregator);
    expect(entityRes.canonicalEntity).not.toBe('vit');
    expect(entityRes.canonicalEntity).not.toBe('cdc');
    expect(entityRes.entityStatus).toBe('unknown');
  });

  // Test 10: Cross-thread ambiguous item cannot merge with subsequent known topic item
  it('10. Cross-thread safety: ambiguous item never merges across threads with known topic', () => {
    const email1 = createEmail({
      threadId: 'thread_001',
      subject: 'Smart Data Solutions PPT (Software Role)',
      bodyTextPreview: 'Smart Data Solutions PPT (AI Role)',
    });
    const email2 = createEmail({
      threadId: 'thread_002', // Different thread
      subject: 'Smart Data Solutions PPT (Software Role)',
      bodyTextPreview: 'Smart Data Solutions PPT (Software Role)',
    });

    const analysis1 = analyzeEmailChange(email1, []);
    expect(analysis1.isNew).toBe(true);
    expect(analysis1.item.topicStatus).toBe('ambiguous');

    const analysis2 = analyzeEmailChange(email2, [analysis1.item]);
    // Must NOT merge cross-thread!
    expect(analysis2.isNew).toBe(true);
    expect(analysis2.result.relation).toBe('NEW');
    expect(analysis2.item.id).not.toBe(analysis1.item.id);
  });
});

describe('Institutional Footer Isolation & Topic Authority Tests', () => {
  // Test A: Software subject + AI announcement body => ambiguous
  it('A. Software subject + AI announcement body => ambiguous', () => {
    const email = createEmail({
      subject:
        'Smart Data Solutions PPT (Software Role) is scheduled on 17th September 2026 by 4.30pm @SJT 717 Vellore Campus',
      bodyTextPreview:
        'Smart Data Solutions PPT (AI Role) is scheduled on 17th September 2026 by 4.30pm @SJT 717\nPPT followed by interviews on 18-09-26 9 am onwards at VIT Vellore\nAll shortlisted students must attend.',
    });

    const topicRes = extractTopicScope(email);
    expect(topicRes.topicStatus).toBe('ambiguous');
    expect(topicRes.topicScope).toBeNull();
    expect(topicRes.subjectTopic).toBe('role_software');
    expect(topicRes.bodyTopic).toBe('role_ai');
    expect(topicRes.conflictingTopics).toEqual(['role_software', 'role_ai']);
    expect(
      topicRes.evidence.some((e) => e.toLowerCase().includes('internal topic contradiction'))
    ).toBe(true);

    const inv = extractInvariants(email);
    expect(inv.topicStatus).toBe('ambiguous');
    expect(inv.topicScope).toBeNull();
  });

  // Test B: Software subject + Software announcement + VIT institutional footer containing Data Science and AI => known Software
  it('B. Software subject + Software announcement + VIT institutional footer containing Data Science and AI => known Software', () => {
    const email = createEmail({
      subject:
        'Update : Smart Data Solutions PPT (Software Role) is scheduled on 17th September 2026 by 4.30pm @SJT 717 Vellore Campus',
      bodyTextPreview: `Smart Data Solutions PPT (Software Role) is scheduled on 17th September 2026 by 4.30pm @SJT 717
PPT followed by interviews on 18-09-26 9 am onwards at VIT Vellore

Regards,
Centre for Career Development
Centre for Data Science and AI
VIT University - Ranked #8 NIRF, NAAC A++ | QS World Rankings`,
    });

    const topicRes = extractTopicScope(email);
    expect(topicRes.topicStatus).toBe('known');
    expect(topicRes.topicScope).toBe('role_software');
    expect(topicRes.subjectTopic).toBe('role_software');
    expect(topicRes.bodyTopic).toBe('role_software');
    expect(topicRes.conflictingTopics).toBeUndefined();

    const inv = extractInvariants(email);
    expect(inv.topicStatus).toBe('known');
    expect(inv.topicScope).toBe('role_software');
    expect(inv.canonicalEntity).toBe('smart data solutions');
  });

  // Test C: AI subject + AI announcement + footer => known AI
  it('C. AI subject + AI announcement + footer => known AI', () => {
    const email = createEmail({
      subject:
        'Smart Data Solutions PPT (AI Role) is scheduled on 17th September 2026 by 4.30pm @SJT 717',
      bodyTextPreview: `Smart Data Solutions PPT (AI Role) is scheduled on 17th September 2026 by 4.30pm @SJT 717
PPT followed by interviews on 18-09-26 9 am onwards at VIT Vellore

Regards,
Centre for Career Development
Centre for Data Science and AI
VIT University - Ranked #8 NIRF, NAAC A++ | QS World Rankings`,
    });

    const topicRes = extractTopicScope(email);
    expect(topicRes.topicStatus).toBe('known');
    expect(topicRes.topicScope).toBe('role_ai');
    expect(topicRes.subjectTopic).toBe('role_ai');
    expect(topicRes.bodyTopic).toBe('role_ai');
    expect(topicRes.conflictingTopics).toBeUndefined();

    const inv = extractInvariants(email);
    expect(inv.topicStatus).toBe('known');
    expect(inv.topicScope).toBe('role_ai');
  });

  // Test D: Footer-only AI/Data Science mentions => must not establish a recruitment role
  it('D. Footer-only AI/Data Science mentions => must not establish a recruitment role', () => {
    const email = createEmail({
      subject: 'Schedule and Guidelines Update',
      bodyTextPreview: `Please assemble at the auditorium tomorrow morning at 9:00 AM for the presentation.

Regards,
Centre for Career Development
Centre for Data Science and AI
VIT University - Ranked #8 NIRF, NAAC A++ | QS World Rankings`,
    });

    const topicRes = extractTopicScope(email);
    expect(topicRes.topicStatus).toBe('unknown');
    expect(topicRes.topicScope).toBeNull();
    expect(topicRes.roleOrProfile).toBeNull();

    const inv = extractInvariants(email);
    expect(inv.topicStatus).toBe('unknown');
    expect(inv.topicScope).toBeNull();
  });

  // Test 5: Existing Ujjivan/Flowserve behavior must remain unchanged
  it('5. Existing Ujjivan/Flowserve behavior must remain unchanged', () => {
    // Ujjivan Email A
    const ujjivanA = createEmail({
      subject:
        'Report immediately: Ujjivan Small Finance Bank PPT and selection process is scheduled on 16th September 2026 by 6.30 pm - SJT706',
      bodyTextPreview: 'Please report immediately to SJT 706 for PPT.',
    });

    // Ujjivan Email B
    const ujjivanB = createEmail({
      subject:
        'Update: Ujjivan Small Finance Bank PPT and selection process is scheduled on 16th & 17th September 2026 by 8.00 am - CDC Office (SJT717)',
      bodyTextPreview: 'Selection process scheduled at CDC Office SJT717.',
    });

    const invA = extractInvariants(ujjivanA);
    const invB = extractInvariants(ujjivanB);

    expect(invA.canonicalEntity).toBe('ujjivan small finance bank');
    expect(invA.entityStatus).toBe('known');
    expect(invA.venue).toBe('SJT 706');
    expect(invA.topicScope).not.toBe('course_sjt706');

    expect(invB.canonicalEntity).toBe('ujjivan small finance bank');
    expect(invB.entityStatus).toBe('known');
    expect(invB.venue).toBe('SJT 717');
    expect(invB.topicScope).not.toBe('course_sjt717');

    // Flowserve corporate recruitment announcement
    const flowserveEmail = createEmail({
      subject: 'Flowserve PPT & Recruitment Drive 2026 - Schedule & Instructions',
      bodyTextPreview: `Flowserve PPT followed by online assessments will be conducted in CDMM Building.
All registered students must report by 8:30 AM.

Regards,
Placement Cell`,
    });

    const invFlowserve = extractInvariants(flowserveEmail);
    expect(invFlowserve.canonicalEntity).toBe('flowserve');
    expect(invFlowserve.entityStatus).toBe('known');
    expect(invFlowserve.topicScope).not.toBe('recruitment_placement_cell');
  });

  // Supporting tests for helper functions
  it('splitAnnouncementAndFooter correctly separates announcement from signature and institutional blocks', () => {
    const text = `Smart Data Solutions PPT (Software Role) is scheduled on 17th September 2026 by 4.30pm @SJT 717
PPT followed by interviews on 18-09-26 9 am onwards at VIT Vellore

Regards,
Centre for Career Development
Centre for Data Science and AI
VIT University - Ranked #8 NIRF, NAAC A++`;

    const split = splitAnnouncementAndFooter(text);
    expect(split.announcementText).toContain('Smart Data Solutions PPT (Software Role)');
    expect(split.announcementText).toContain('PPT followed by interviews');
    expect(split.announcementText).not.toContain('Centre for Data Science and AI');
    expect(split.footerText).toContain('Centre for Data Science and AI');
    expect(split.footerText).toContain('NIRF, NAAC A++');
  });

  it('isAcademicOrInstitutionalContext identifies institutional department and ranking phrases', () => {
    const text1 = 'Centre for Data Science and AI';
    const matchIdx1 = text1.indexOf('Data Science');
    expect(isAcademicOrInstitutionalContext(matchIdx1, 'Data Science'.length, text1)).toBe(true);

    const matchIdx2 = text1.indexOf('AI');
    expect(isAcademicOrInstitutionalContext(matchIdx2, 'AI'.length, text1)).toBe(true);

    const text2 = 'Smart Data Solutions PPT (Software Role) is scheduled';
    const matchIdx3 = text2.indexOf('Software Role');
    expect(isAcademicOrInstitutionalContext(matchIdx3, 'Software Role'.length, text2)).toBe(false);

    const text3 = 'Students of B.Tech in Artificial Intelligence are eligible';
    const matchIdx4 = text3.indexOf('Artificial Intelligence');
    expect(isAcademicOrInstitutionalContext(matchIdx4, 'Artificial Intelligence'.length, text3)).toBe(true);
  });
});
