import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { db } from '../src/db';
import { reclassifyStoredEmails } from '../src/background/gmail/sync';
import { CURRENT_ANALYSIS_VERSION } from '../src/shared/constants';
import type { EmailRecord, AttentionItem } from '../src/shared/types';

function createDummyRecord(overrides: Partial<EmailRecord>): EmailRecord {
  return {
    id: 'msg_default',
    threadId: 'th_default',
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

describe('Analysis Versioning and Stale Record Migration', () => {
  beforeEach(async () => {
    await db.emails.clear();
    await db.attentionItems.clear();
  });

  it('automatically migrates legacy records (analysisVersion undefined or < 3) to CURRENT_ANALYSIS_VERSION with temporalAnalysis', async () => {
    // 1. Insert a legacy Phase 2 record (analysisVersion: 2, no temporalAnalysis)
    const legacyRecord = createDummyRecord({
      id: 'legacy_msg_1',
      threadId: 'th_1',
      subject: 'Interview scheduled on September 20, 2026 at 10:00 AM',
      from: 'Tech Recruitment <recruitment@techcorp.com>',
      fromDomain: 'techcorp.com',
      to: ['student@college.edu'],
      snippet: 'Please be present for your interview round.',
      internalDate: new Date('2026-09-15T10:00:00Z').getTime(),
      processedAt: new Date('2026-09-15T10:05:00Z').getTime(),
      bodyTextPreview: 'Your technical interview is scheduled on September 20, 2026 at 10:00 AM via Google Meet.',
      category: 'career_placement',
      confidence: 0.9,
      categoryScore: 85,
      categoryScores: { career_placement: 85 },
      detectionReasons: ['Job interview invitation'],
      importanceScore: 80,
      importanceReasons: ['Career placement event'],
      urgencyScore: 40,
      urgencyReasons: ['Scheduled event mentioned'],
      actionRequired: true,
      actionType: 'attend',
      analysisVersion: 2, // Legacy Phase 2
      // temporalAnalysis is intentionally undefined
    });

    // 2. Insert a Phase 1 legacy record (analysisVersion missing entirely)
    const phase1Record = createDummyRecord({
      id: 'legacy_msg_2',
      threadId: 'th_2',
      subject: 'Registration deadline: Submit response by 18 September 2026 5:00 PM',
      from: 'College Placement Cell <placement@college.edu>',
      fromDomain: 'college.edu',
      to: ['student@college.edu'],
      snippet: 'Important: Submit form before the deadline.',
      internalDate: new Date('2026-09-10T08:00:00Z').getTime(),
      processedAt: new Date('2026-09-10T08:05:00Z').getTime(),
      bodyTextPreview: 'Ensure your registration is completed. Deadline: 18 September 2026 5:00 PM.',
      category: 'career_placement',
      confidence: 0.85,
      categoryScore: 80,
      categoryScores: { career_placement: 80 },
      detectionReasons: ['Career placement deadline'],
      importanceScore: 75,
      importanceReasons: ['Placement deadline'],
      urgencyScore: 45,
      urgencyReasons: ['Deadline mentioned'],
      actionRequired: true,
      actionType: 'register',
      // analysisVersion omitted
    });

    // 3. Insert an already up-to-date record (analysisVersion: 3 with temporalAnalysis)
    const currentRecord = createDummyRecord({
      id: 'current_msg_3',
      threadId: 'th_3',
      subject: 'Weekly Newsletter',
      from: 'Newsletter Team <news@campus.edu>',
      fromDomain: 'campus.edu',
      to: ['student@college.edu'],
      snippet: 'Here is your weekly update.',
      internalDate: new Date('2026-09-16T09:00:00Z').getTime(),
      processedAt: new Date('2026-09-16T09:01:00Z').getTime(),
      bodyTextPreview: 'Just some weekly announcements. Nothing urgent.',
      category: 'newsletters',
      confidence: 0.95,
      categoryScore: 90,
      categoryScores: { newsletters: 90 },
      detectionReasons: ['Campus newsletter'],
      importanceScore: 10,
      importanceReasons: ['Informational broadcast'],
      urgencyScore: 5,
      urgencyReasons: ['No temporal cues'],
      actionRequired: false,
      actionType: null,
      analysisVersion: CURRENT_ANALYSIS_VERSION,
      temporalAnalysis: {
        entities: [],
        primaryDeadline: null,
        primaryEvent: null,
        hasActiveDeadline: false,
        isOverdue: false,
        hasAmbiguousDates: false,
        temporalUrgencyTier: 'none',
        summaryReason: 'No temporal cues or dates detected',
      },
    });

    await db.emails.bulkPut([legacyRecord, phase1Record, currentRecord]);

    // Execute reclassifyStoredEmails()
    const updatedCount = await reclassifyStoredEmails();

    // Exactly 2 records should have been reclassified (the legacy ones)
    expect(updatedCount).toBe(2);

    // Verify legacy_msg_1 is upgraded
    const updatedMsg1 = await db.emails.get('legacy_msg_1');
    expect(updatedMsg1).toBeDefined();
    expect(updatedMsg1?.analysisVersion).toBe(CURRENT_ANALYSIS_VERSION);
    expect(updatedMsg1?.temporalAnalysis).toBeDefined();
    expect(updatedMsg1?.temporalAnalysis?.primaryEvent).toBeDefined();
    expect(updatedMsg1?.temporalAnalysis?.primaryEvent?.type).toBe('event');
    expect(updatedMsg1?.temporalAnalysis?.primaryEvent?.timePrecision).toBe('exact');
    // Verify extracted entities updated
    expect(updatedMsg1?.extractedEntities.dates.length).toBeGreaterThan(0);

    // Verify legacy_msg_2 is upgraded
    const updatedMsg2 = await db.emails.get('legacy_msg_2');
    expect(updatedMsg2).toBeDefined();
    expect(updatedMsg2?.analysisVersion).toBe(CURRENT_ANALYSIS_VERSION);
    expect(updatedMsg2?.temporalAnalysis).toBeDefined();
    expect(updatedMsg2?.temporalAnalysis?.primaryDeadline).toBeDefined();
    expect(updatedMsg2?.temporalAnalysis?.primaryDeadline?.type).toBe('deadline');
    expect(updatedMsg2?.extractedEntities.deadlines.length).toBeGreaterThan(0);

    // Verify current_msg_3 was untouched
    const untouchedMsg3 = await db.emails.get('current_msg_3');
    expect(untouchedMsg3?.processedAt).toBe(currentRecord.processedAt);
  });

  it('handles empty database cleanly', async () => {
    const updatedCount = await reclassifyStoredEmails();
    expect(updatedCount).toBe(0);
  });

  it('does not re-process emails that already have CURRENT_ANALYSIS_VERSION and temporalAnalysis', async () => {
    const currentRecord = createDummyRecord({
      id: 'current_msg',
      threadId: 'th_c',
      subject: 'Test Record',
      from: 'Sender <sender@example.com>',
      fromDomain: 'example.com',
      to: ['user@example.com'],
      snippet: 'Test',
      internalDate: Date.now(),
      processedAt: 12345678,
      bodyTextPreview: 'Test body',
      category: 'general',
      confidence: 0.8,
      actionRequired: false,
      actionType: null,
      importanceScore: 20,
      urgencyScore: 10,
      detectionReasons: [],
      analysisVersion: CURRENT_ANALYSIS_VERSION,
      temporalAnalysis: {
        entities: [],
        primaryDeadline: null,
        primaryEvent: null,
        hasActiveDeadline: false,
        isOverdue: false,
        hasAmbiguousDates: false,
        temporalUrgencyTier: 'none',
        summaryReason: 'No temporal cues or dates detected',
      },
    });
    await db.emails.put(currentRecord);

    const count = await reclassifyStoredEmails();
    expect(count).toBe(0);

    const fetched = await db.emails.get('current_msg');
    expect(fetched?.processedAt).toBe(12345678);
  });

  it('proves analysis version 3 records are reprocessed when current version is 4', async () => {
    expect(CURRENT_ANALYSIS_VERSION).toBe(4);

    const v3Record = createDummyRecord({
      id: 'v3_msg_test',
      threadId: 'th_v3',
      subject: 'Smart Data Solutions PPT (Software Role) is scheduled on 17th September 2026 by 4.30pm @SJT 717',
      from: 'Placement Cell <placement@vit.ac.in>',
      fromDomain: 'vit.ac.in',
      to: ['student@vit.ac.in'],
      snippet: 'Smart Data Solutions PPT announcement',
      internalDate: new Date('2026-09-16T14:00:00Z').getTime(),
      processedAt: 100000,
      bodyTextPreview: 'Smart Data Solutions PPT (Software Role) is scheduled on 17th September 2026 by 4.30pm @SJT 717',
      category: 'career_placement',
      confidence: 0.9,
      categoryScore: 85,
      categoryScores: { career_placement: 85 },
      importanceScore: 80,
      urgencyScore: 70,
      actionRequired: true,
      actionType: 'attend',
      analysisVersion: 3, // Stale version 3 record
      temporalAnalysis: {
        entities: [],
        primaryDeadline: null,
        primaryEvent: null,
        hasActiveDeadline: false,
        isOverdue: false,
        hasAmbiguousDates: false,
        temporalUrgencyTier: 'none',
        summaryReason: 'Prior v3 temporal run',
      },
    });

    await db.emails.put(v3Record);

    const updatedCount = await reclassifyStoredEmails();
    expect(updatedCount).toBe(1);

    const updated = await db.emails.get('v3_msg_test');
    expect(updated).toBeDefined();
    expect(updated?.analysisVersion).toBe(4);
    expect(updated?.processedAt).toBeGreaterThan(100000);
    expect(updated?.temporalAnalysis?.primaryEvent).toBeDefined();
    expect(updated?.temporalAnalysis?.primaryEvent?.type).toBe('event');
  });

  it('proves analysis version 4 records are not unnecessarily reprocessed', async () => {
    expect(CURRENT_ANALYSIS_VERSION).toBe(4);

    const v4Record = createDummyRecord({
      id: 'v4_msg_test',
      threadId: 'th_v4',
      subject: 'Already Processed Event Record',
      from: 'Placement Cell <placement@vit.ac.in>',
      fromDomain: 'vit.ac.in',
      to: ['student@vit.ac.in'],
      snippet: 'Already processed',
      internalDate: new Date('2026-09-16T14:00:00Z').getTime(),
      processedAt: 99999999,
      bodyTextPreview: 'Already processed',
      category: 'career_placement',
      confidence: 0.9,
      analysisVersion: 4,
      temporalAnalysis: {
        entities: [],
        primaryDeadline: null,
        primaryEvent: null,
        hasActiveDeadline: false,
        isOverdue: false,
        hasAmbiguousDates: false,
        temporalUrgencyTier: 'none',
        summaryReason: 'No temporal cues or dates detected',
      },
    });

    await db.emails.put(v4Record);

    const count = await reclassifyStoredEmails();
    expect(count).toBe(0);

    const fetched = await db.emails.get('v4_msg_test');
    expect(fetched?.processedAt).toBe(99999999);
    expect(fetched?.analysisVersion).toBe(4);
  });

  it('proves existing email data is strictly preserved during reanalysis', async () => {
    const existingAttentionItem: AttentionItem = {
      id: 'att_preserve_existing',
      identityKey: 'career_placement::microsoft::null',
      category: 'career_placement',
      canonicalEntity: 'microsoft',
      entityStatus: 'known',
      topicScope: null,
      topicStatus: 'unknown',
      threadIds: ['preserve_th_202'],
      messageIds: ['preserve_msg_101'],
      latestEmailId: 'preserve_msg_101',
      firstSeenAt: 1726500000000,
      lastSeenAt: 1726500000000,
      itemLifecycleState: 'active',
      userAttentionState: 'unhandled',
      importanceScore: 80,
      urgencyScore: 70,
      currentState: {
        primaryEventTimestamp: 1727024400000,
        primaryDeadlineTimestamp: null,
        venue: 'SJT 706',
        actionRequired: true,
        actionType: 'attend',
        itemLifecycleState: 'active',
        subEvents: [],
      },
      history: [
        {
          emailId: 'preserve_msg_101',
          internalDate: 1726500000000,
          recordedAt: 1726500000000,
          relation: 'UPDATE',
          deltas: [],
          summary: 'Original entry',
        },
      ],
    };
    await db.attentionItems.put(existingAttentionItem);

    const originalRecord = createDummyRecord({
      id: 'preserve_msg_101',
      threadId: 'preserve_th_202',
      subject: 'Preserved Subject Line - Microsoft PPT on 22 September 2026 5:00 PM',
      from: 'University Placement <cdc@vit.ac.in>',
      fromDomain: 'vit.ac.in',
      to: ['student1@vit.ac.in', 'student2@vit.ac.in'],
      snippet: 'Original Snippet Preserved',
      internalDate: 1726500000000,
      processedAt: 50,
      bodyTextPreview: 'Original body preview Microsoft PPT on 22 September 2026 5:00 PM @ SJT 706',
      labels: ['INBOX', 'IMPORTANT', 'CUSTOM_LABEL'],
      isUnread: true,
      alertStatus: 'pending',
      snoozeUntil: 1726600000000,
      handledAt: null,
      attentionItemId: 'att_preserve_existing',
      changeRelation: 'UPDATE',
      analysisVersion: 3, // Old version to trigger reanalysis
    });

    await db.emails.put(originalRecord);

    const updatedCount = await reclassifyStoredEmails();
    expect(updatedCount).toBe(1);

    const afterReanalysis = await db.emails.get('preserve_msg_101');
    expect(afterReanalysis).toBeDefined();

    // Critical invariant checks: Core email identity & user metadata are preserved
    expect(afterReanalysis?.id).toBe(originalRecord.id);
    expect(afterReanalysis?.threadId).toBe(originalRecord.threadId);
    expect(afterReanalysis?.subject).toBe(originalRecord.subject);
    expect(afterReanalysis?.from).toBe(originalRecord.from);
    expect(afterReanalysis?.fromDomain).toBe(originalRecord.fromDomain);
    expect(afterReanalysis?.to).toEqual(originalRecord.to);
    expect(afterReanalysis?.snippet).toBe(originalRecord.snippet);
    expect(afterReanalysis?.internalDate).toBe(originalRecord.internalDate);
    expect(afterReanalysis?.bodyTextPreview).toBe(originalRecord.bodyTextPreview);
    expect(afterReanalysis?.labels).toEqual(originalRecord.labels);
    expect(afterReanalysis?.isUnread).toBe(originalRecord.isUnread);
    expect(afterReanalysis?.alertStatus).toBe(originalRecord.alertStatus);
    expect(afterReanalysis?.snoozeUntil).toBe(originalRecord.snoozeUntil);
    expect(afterReanalysis?.handledAt).toBe(originalRecord.handledAt);
    expect(afterReanalysis?.attentionItemId).toBe(originalRecord.attentionItemId);

    // Analysis version is updated to current (4)
    expect(afterReanalysis?.analysisVersion).toBe(4);
    expect(afterReanalysis?.processedAt).toBeGreaterThan(50);
  });
});
