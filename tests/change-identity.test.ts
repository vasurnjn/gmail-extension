import { describe, it, expect } from 'vitest';
import { AttentionItem, EmailRecord } from '../src/shared/types';
import {
  canonicalizeEntity,
  evaluateItemCandidate,
  findAttentionItemCandidate,
  isTopicCompatible,
} from '../src/background/analysis/change/identity';
import { InvariantExtractionOutput } from '../src/background/analysis/change/types';

function createSampleEmail(overrides: Partial<EmailRecord> = {}): EmailRecord {
  return {
    id: 'msg_test_001',
    threadId: 'th_test_001',
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
    evidence: ['Entity: deloitte', 'Topic: recruitment_software_engineer'],
    ...overrides,
  };
}

function createSampleAttentionItem(
  overrides: Partial<AttentionItem> = {}
): AttentionItem {
  return {
    id: 'att_01JMTEST001',
    identityKey: 'career_placement::deloitte::recruitment_software_engineer',
    category: 'career_placement',
    canonicalEntity: 'deloitte',
    entityStatus: 'known',
    topicScope: 'recruitment_software_engineer',
    topicStatus: 'known',
    threadIds: ['th_existing_100'],
    messageIds: ['msg_prior_100'],
    latestEmailId: 'msg_prior_100',
    firstSeenAt: 1726400000000,
    lastSeenAt: 1726400000000,
    itemLifecycleState: 'active',
    userAttentionState: 'unhandled',
    importanceScore: 85,
    urgencyScore: 78,
    currentState: {
      primaryEventTimestamp: 1726573800000,
      primaryDeadlineTimestamp: null,
      venue: 'SJT 717',
      actionRequired: true,
      actionType: 'attend',
      itemLifecycleState: 'active',
      subEvents: [],
    },
    history: [],
    ...overrides,
  };
}

describe('Phase 4C: Identity Matching & Conservative Candidate Selection', () => {
  // Test 1: Same known entity + same known topic -> eligible candidate
  it('Scenario 1: Same known entity + same known topic -> eligible candidate', () => {
    const email = createSampleEmail({ threadId: 'th_different_200' });
    const invariants = createSampleInvariants({
      canonicalEntity: 'deloitte',
      entityStatus: 'known',
      topicScope: 'recruitment_software_engineer',
      topicStatus: 'known',
    });
    const item = createSampleAttentionItem({
      canonicalEntity: 'deloitte',
      entityStatus: 'known',
      topicScope: 'recruitment_software_engineer',
      topicStatus: 'known',
      threadIds: ['th_existing_100'],
    });

    const result = findAttentionItemCandidate(email, [item], invariants);
    expect(result.status).toBe('exact_identity');
    expect(result.candidateId).toBe(item.id);
    expect(result.candidateItem).toBe(item);
    expect(result.confidence).toBe('HIGH');
    expect(result.isCrossThread).toBe(true);
  });

  // Test 2: Company A vs Company B -> no candidate (Hard entity partition)
  it('Scenario 2: Company A vs Company B -> no candidate (Hard entity partition)', () => {
    const email = createSampleEmail({ threadId: 'th_shared_999' });
    const invariants = createSampleInvariants({
      canonicalEntity: 'company a',
      entityStatus: 'known',
      topicScope: 'recruitment_software_engineer',
      topicStatus: 'known',
      venue: 'SJT 717',
    });
    const item = createSampleAttentionItem({
      canonicalEntity: 'company b',
      entityStatus: 'known',
      topicScope: 'recruitment_software_engineer',
      topicStatus: 'known',
      threadIds: ['th_shared_999'], // Even if same thread!
    });

    const result = findAttentionItemCandidate(email, [item], invariants);
    expect(result.status).toBe('no_candidate');
    expect(result.candidateId).toBeNull();
    expect(result.candidateItem).toBeNull();
    expect(result.evaluations?.[0].reasons[0]).toContain('Hard entity partition');
  });

  // Test 3: Same company + different role -> no candidate
  it('Scenario 3: Same company + different role -> no candidate', () => {
    const email = createSampleEmail({ threadId: 'th_shared_999' });
    const invariants = createSampleInvariants({
      canonicalEntity: 'deloitte',
      entityStatus: 'known',
      topicScope: 'software_engineer',
      topicStatus: 'known',
    });
    const item = createSampleAttentionItem({
      canonicalEntity: 'deloitte',
      entityStatus: 'known',
      topicScope: 'data_analyst',
      topicStatus: 'known',
      threadIds: ['th_shared_999'],
    });

    const result = findAttentionItemCandidate(email, [item], invariants);
    expect(result.status).toBe('no_candidate');
    expect(result.candidateId).toBeNull();
    expect(result.evaluations?.[0].reasons[0]).toContain('Explicit topic contradiction');
  });

  // Test 4: Same company + compatible recruitment topic -> eligible candidate
  it('Scenario 4: Same company + compatible recruitment topic -> eligible candidate', () => {
    const email = createSampleEmail();
    const invariants = createSampleInvariants({
      canonicalEntity: 'smart data solutions',
      entityStatus: 'known',
      topicScope: 'recruitment',
      topicStatus: 'known',
    });
    const item = createSampleAttentionItem({
      canonicalEntity: 'smart data solutions',
      entityStatus: 'known',
      topicScope: 'recruitment',
      topicStatus: 'known',
    });

    const result = findAttentionItemCandidate(email, [item], invariants);
    expect(result.status).toBe('exact_identity');
    expect(result.candidateId).toBe(item.id);
  });

  // Test 5: Known entity + unknown topic -> no cross-thread candidate
  it('Scenario 5: Known entity + unknown topic -> no cross-thread candidate', () => {
    const email = createSampleEmail({ threadId: 'th_email_500' });
    const invariants = createSampleInvariants({
      canonicalEntity: 'company a',
      entityStatus: 'known',
      topicScope: null,
      topicStatus: 'unknown',
    });
    const item = createSampleAttentionItem({
      canonicalEntity: 'company a',
      entityStatus: 'known',
      topicScope: 'recruitment',
      topicStatus: 'known',
      threadIds: ['th_item_600'], // cross-thread
    });

    const result = findAttentionItemCandidate(email, [item], invariants);
    expect(result.status).toBe('no_candidate');
    expect(result.candidateId).toBeNull();
  });

  // Test 6: Known entity + ambiguous topic -> no cross-thread candidate
  it('Scenario 6: Known entity + ambiguous topic -> no cross-thread candidate', () => {
    const email = createSampleEmail({ threadId: 'th_email_500' });
    const invariants = createSampleInvariants({
      canonicalEntity: 'company a',
      entityStatus: 'known',
      topicScope: 'consortium_drive',
      topicStatus: 'ambiguous',
    });
    const item = createSampleAttentionItem({
      canonicalEntity: 'company a',
      entityStatus: 'known',
      topicScope: 'recruitment',
      topicStatus: 'known',
      threadIds: ['th_item_600'],
    });

    const result = findAttentionItemCandidate(email, [item], invariants);
    expect(result.status).toBe('no_candidate');
    expect(result.candidateId).toBeNull();
  });

  // Test 7: Unknown entity -> no cross-thread candidate
  it('Scenario 7: Unknown entity -> no cross-thread candidate', () => {
    const email = createSampleEmail({ threadId: 'th_email_700' });
    const invariants = createSampleInvariants({
      canonicalEntity: null,
      entityStatus: 'unknown',
      topicScope: 'recruitment_software_engineer',
      topicStatus: 'known',
    });
    const item = createSampleAttentionItem({
      canonicalEntity: 'deloitte',
      entityStatus: 'known',
      topicScope: 'recruitment_software_engineer',
      topicStatus: 'known',
      threadIds: ['th_item_800'],
    });

    const result = findAttentionItemCandidate(email, [item], invariants);
    expect(result.status).toBe('no_candidate');
    expect(result.candidateId).toBeNull();
  });

  // Test 8: Ambiguous entity -> no cross-thread candidate
  it('Scenario 8: Ambiguous entity -> no cross-thread candidate', () => {
    const email = createSampleEmail({ threadId: 'th_email_800' });
    const invariants = createSampleInvariants({
      canonicalEntity: 'company a, company b',
      entityStatus: 'ambiguous',
      topicScope: 'recruitment',
      topicStatus: 'known',
    });
    const item = createSampleAttentionItem({
      canonicalEntity: 'company a',
      entityStatus: 'known',
      topicScope: 'recruitment',
      topicStatus: 'known',
      threadIds: ['th_item_900'],
    });

    const result = findAttentionItemCandidate(email, [item], invariants);
    expect(result.status).toBe('no_candidate');
    expect(result.candidateId).toBeNull();
  });

  // Test 9: Same venue + different company -> no candidate
  it('Scenario 9: Same venue + different company -> no candidate', () => {
    const email = createSampleEmail();
    const invariants = createSampleInvariants({
      canonicalEntity: 'company a',
      entityStatus: 'known',
      topicScope: 'recruitment',
      topicStatus: 'known',
      venue: 'SJT 717',
    });
    const item = createSampleAttentionItem({
      canonicalEntity: 'company b',
      entityStatus: 'known',
      topicScope: 'recruitment',
      topicStatus: 'known',
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

    const result = findAttentionItemCandidate(email, [item], invariants);
    expect(result.status).toBe('no_candidate');
    expect(result.candidateId).toBeNull();
  });

  // Test 10: Same entity + same topic + different venue -> still eligible candidate
  it('Scenario 10: Same entity + same topic + different venue -> still eligible candidate', () => {
    const email = createSampleEmail();
    const invariants = createSampleInvariants({
      canonicalEntity: 'deloitte',
      entityStatus: 'known',
      topicScope: 'recruitment_software_engineer',
      topicStatus: 'known',
      venue: 'SJT 718', // changed venue!
    });
    const item = createSampleAttentionItem({
      canonicalEntity: 'deloitte',
      entityStatus: 'known',
      topicScope: 'recruitment_software_engineer',
      topicStatus: 'known',
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

    const result = findAttentionItemCandidate(email, [item], invariants);
    expect(result.status).toBe('exact_identity');
    expect(result.candidateId).toBe(item.id);
  });

  // Test 11: Same Gmail thread + explicit topic contradiction -> no candidate
  it('Scenario 11: Same Gmail thread + explicit topic contradiction -> no candidate', () => {
    const email = createSampleEmail({ threadId: 'th_shared_drive' });
    const invariants = createSampleInvariants({
      canonicalEntity: 'company a',
      entityStatus: 'known',
      topicScope: 'hackathon', // Hackathon
      topicStatus: 'known',
    });
    const item = createSampleAttentionItem({
      canonicalEntity: 'company a',
      entityStatus: 'known',
      topicScope: 'recruitment', // Recruitment drive
      topicStatus: 'known',
      threadIds: ['th_shared_drive'], // Same thread cannot override topic contradiction!
    });

    const result = findAttentionItemCandidate(email, [item], invariants);
    expect(result.status).toBe('no_candidate');
    expect(result.candidateId).toBeNull();
  });

  // Test 12: Same Gmail thread + compatible identity -> thread evidence strengthens candidate
  it('Scenario 12: Same Gmail thread + compatible identity -> thread evidence strengthens candidate', () => {
    const email = createSampleEmail({ threadId: 'th_thread_deloitte' });
    const invariants = createSampleInvariants({
      canonicalEntity: 'deloitte',
      entityStatus: 'known',
      topicScope: 'recruitment_software_engineer',
      topicStatus: 'known',
    });
    const item = createSampleAttentionItem({
      canonicalEntity: 'deloitte',
      entityStatus: 'known',
      topicScope: 'recruitment_software_engineer',
      topicStatus: 'known',
      threadIds: ['th_thread_deloitte'],
    });

    const result = findAttentionItemCandidate(email, [item], invariants);
    expect(result.status).toBe('exact_identity');
    expect(result.candidateId).toBe(item.id);
    expect(result.isCrossThread).toBe(false);
    expect(result.reasons.some((r) => r.includes('thread continuity'))).toBe(true);
  });

  // Test 13: Multiple compatible AttentionItems -> unresolved / no arbitrary selection
  it('Scenario 13: Multiple compatible AttentionItems -> unresolved/no arbitrary selection', () => {
    const email = createSampleEmail();
    const invariants = createSampleInvariants({
      canonicalEntity: 'deloitte',
      entityStatus: 'known',
      topicScope: 'recruitment_software_engineer',
      topicStatus: 'known',
    });

    const item1 = createSampleAttentionItem({
      id: 'att_candidate_1',
      canonicalEntity: 'deloitte',
      topicScope: 'recruitment_software_engineer',
    });
    const item2 = createSampleAttentionItem({
      id: 'att_candidate_2',
      canonicalEntity: 'deloitte',
      topicScope: 'recruitment_software_engineer',
    });

    const result = findAttentionItemCandidate(email, [item1, item2], invariants);
    expect(result.status).toBe('unresolved_multiple');
    expect(result.candidateId).toBeNull();
    expect(result.candidateItem).toBeNull();
    expect(result.reasons[0]).toContain('refusing arbitrary selection');
  });

  // Test 14: No existing AttentionItems -> no candidate
  it('Scenario 14: No existing AttentionItems -> no candidate', () => {
    const email = createSampleEmail();
    const invariants = createSampleInvariants();

    const result = findAttentionItemCandidate(email, [], invariants);
    expect(result.status).toBe('no_candidate');
    expect(result.candidateId).toBeNull();
    expect(result.candidateItem).toBeNull();
  });

  // Test 15: Different categories -> conservative no-match
  it('Scenario 15: Different categories -> conservative no-match', () => {
    const email = createSampleEmail({ category: 'academic' });
    const invariants = createSampleInvariants({
      canonicalEntity: 'deloitte',
      topicScope: 'recruitment_software_engineer',
    });
    const item = createSampleAttentionItem({
      category: 'career_placement',
      canonicalEntity: 'deloitte',
      topicScope: 'recruitment_software_engineer',
    });

    const result = findAttentionItemCandidate(email, [item], invariants);
    expect(result.status).toBe('no_candidate');
    expect(result.candidateId).toBeNull();
  });

  // Test 16: Entity casing/canonicalization -> equivalent canonical entities remain equivalent
  it('Scenario 16: Entity casing/canonicalization -> equivalent canonical entities remain equivalent', () => {
    expect(canonicalizeEntity('Deloitte Inc.')).toBe('deloitte');
    expect(canonicalizeEntity('DELOITTE')).toBe('deloitte');
    expect(canonicalizeEntity('deloitte')).toBe('deloitte');
    expect(canonicalizeEntity('Smart_Data_Solutions Corp.')).toBe('smart data solutions');

    const email = createSampleEmail();
    const invariants = createSampleInvariants({
      canonicalEntity: 'Deloitte Inc.',
      entityStatus: 'known',
      topicScope: 'recruitment_software_engineer',
      topicStatus: 'known',
    });
    const item = createSampleAttentionItem({
      canonicalEntity: 'deloitte',
      entityStatus: 'known',
      topicScope: 'recruitment_software_engineer',
      topicStatus: 'known',
    });

    const result = findAttentionItemCandidate(email, [item], invariants);
    expect(result.status).toBe('exact_identity');
    expect(result.candidateId).toBe(item.id);
  });

  // Test 17: Temporal proximity alone -> must NOT create a match
  it('Scenario 17: Temporal proximity alone -> must NOT create a match', () => {
    const email = createSampleEmail({
      threadId: 'th_email_random',
      internalDate: 1726573800000,
    });
    // Unknown entity across threads, even though event dates match exactly
    const invariants = createSampleInvariants({
      canonicalEntity: null,
      entityStatus: 'unknown',
      topicScope: null,
      topicStatus: 'unknown',
    });
    const item = createSampleAttentionItem({
      canonicalEntity: 'company a',
      entityStatus: 'known',
      topicScope: 'recruitment',
      topicStatus: 'known',
      currentState: {
        primaryEventTimestamp: 1726573800000, // Exact same timestamp
        primaryDeadlineTimestamp: null,
        venue: null,
        actionRequired: true,
        actionType: 'attend',
        itemLifecycleState: 'active',
        subEvents: [],
      },
      threadIds: ['th_item_other'],
    });

    const result = findAttentionItemCandidate(email, [item], invariants);
    expect(result.status).toBe('no_candidate');
    expect(result.candidateId).toBeNull();
  });

  // Test 18: Same venue + same date/time + different entity -> no candidate
  it('Scenario 18: Same venue + same date/time + different entity -> no candidate', () => {
    const email = createSampleEmail({
      threadId: 'th_thread_shared',
      internalDate: 1726573800000,
    });
    const invariants = createSampleInvariants({
      canonicalEntity: 'company a',
      entityStatus: 'known',
      topicScope: 'recruitment',
      topicStatus: 'known',
      venue: 'SJT 717',
    });
    const item = createSampleAttentionItem({
      canonicalEntity: 'company b',
      entityStatus: 'known',
      topicScope: 'recruitment',
      topicStatus: 'known',
      currentState: {
        primaryEventTimestamp: 1726573800000,
        primaryDeadlineTimestamp: null,
        venue: 'SJT 717',
        actionRequired: true,
        actionType: 'attend',
        itemLifecycleState: 'active',
        subEvents: [],
      },
      threadIds: ['th_thread_shared'],
    });

    const result = findAttentionItemCandidate(email, [item], invariants);
    expect(result.status).toBe('no_candidate');
    expect(result.candidateId).toBeNull();
  });

  // Additional Scenario 19: Same thread + unknown topic -> exposes thread_uncertain candidate
  it('Scenario 19: Same thread with unknown topic is marked as thread_uncertain', () => {
    const email = createSampleEmail({ threadId: 'th_known_thread' });
    const invariants = createSampleInvariants({
      canonicalEntity: 'deloitte',
      entityStatus: 'known',
      topicScope: null,
      topicStatus: 'unknown',
    });
    const item = createSampleAttentionItem({
      canonicalEntity: 'deloitte',
      entityStatus: 'known',
      topicScope: 'recruitment_software_engineer',
      topicStatus: 'known',
      threadIds: ['th_known_thread'],
    });

    const result = findAttentionItemCandidate(email, [item], invariants);
    expect(result.status).toBe('thread_uncertain');
    expect(result.candidateId).toBe(item.id);
    expect(result.confidence).toBe('LOW');
    expect(result.isCrossThread).toBe(false);
  });

  // Additional Scenario 20: Terminal attention item states do not absorb new messages
  it('Scenario 20: AttentionItem in completed or cancelled state cannot absorb candidates', () => {
    const email = createSampleEmail();
    const invariants = createSampleInvariants({
      canonicalEntity: 'deloitte',
      entityStatus: 'known',
      topicScope: 'recruitment_software_engineer',
      topicStatus: 'known',
    });

    const completedItem = createSampleAttentionItem({
      id: 'att_completed',
      itemLifecycleState: 'completed',
    });
    const cancelledItem = createSampleAttentionItem({
      id: 'att_cancelled',
      itemLifecycleState: 'cancelled',
    });

    const resultCompleted = findAttentionItemCandidate(email, [completedItem], invariants);
    expect(resultCompleted.status).toBe('no_candidate');

    const resultCancelled = findAttentionItemCandidate(email, [cancelledItem], invariants);
    expect(resultCancelled.status).toBe('no_candidate');
  });

  // Additional Scenario 21: Topic compatibility edge cases
  it('Scenario 21: Topic compatibility unit tests', () => {
    expect(isTopicCompatible('recruitment', 'recruitment')).toBe(true);
    expect(isTopicCompatible('software_engineer', 'software_engineer')).toBe(true);
    expect(isTopicCompatible('recruitment_software_engineer', 'recruitment_software_engineer')).toBe(true);
    expect(isTopicCompatible('recruitment_software_engineer', 'software_engineer')).toBe(true);
    expect(isTopicCompatible('software_engineer', 'recruitment_software_engineer')).toBe(true);
    expect(isTopicCompatible('recruitment_software_engineer', 'recruitment_data_analyst')).toBe(false);
    expect(isTopicCompatible('software_engineer', 'data_analyst')).toBe(false);
    expect(isTopicCompatible('recruitment', 'hackathon')).toBe(false);
    expect(isTopicCompatible('order_123', 'order_456')).toBe(false);
    expect(isTopicCompatible('order_123', 'order_123')).toBe(true);
    expect(isTopicCompatible('course_cse1001', 'course_cse1001')).toBe(true);
    expect(isTopicCompatible('course_cse1001', 'course_mat2001')).toBe(false);
    expect(isTopicCompatible(null, 'recruitment')).toBe(false);
  });
});
