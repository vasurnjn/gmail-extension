import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../src/db';
import { storage } from '../src/shared/storage';
import { analyzeEmail } from '../src/background/analysis';
import { processEmailChange } from '../src/background/analysis/change/pipeline';
import { handleEmailAttentionPipeline } from '../src/background/notifications/reconciler';
import { EmailRecord } from '../src/shared/types';

describe('V1 Bug Fix Pass: Bug 1 & Bug 2 - Temporal Target Separation & Explicit Time Precedence', () => {
  const baseEmailInternalDate = new Date('2026-09-18T10:00:00Z').getTime();

  function makeEmail(subject: string, bodyText: string, date = baseEmailInternalDate): EmailRecord {
    return {
      id: `msg_${Math.random().toString(36).slice(2, 8)}`,
      threadId: `thread_${Math.random().toString(36).slice(2, 8)}`,
      from: 'sender@example.com',
      fromDomain: 'example.com',
      to: ['user@example.com'],
      subject,
      snippet: bodyText.slice(0, 100),
      bodyTextPreview: bodyText,
      internalDate: date,
      processedAt: date,
      isUnread: true,
      category: 'action_deadline',
      confidence: 0.9,
      importanceScore: 80,
      urgencyScore: 80,
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
    };
  }

  // =========================================================================
  // BUG 1: Multiple Temporal Targets Mixed
  // =========================================================================
  describe('Bug 1: Multiple Temporal Targets Handled Independently', () => {
    it('Case 1: Upload documents by 4:00 PM. Interview at 6:30 PM.', () => {
      const email = makeEmail(
        'Next Steps in Selection Process',
        'Upload documents by 4:00 PM.\nInterview at 6:30 PM.'
      );

      const analysis = analyzeEmail(email);
      expect(analysis.temporal.entities.length).toBe(2);

      const deadline = analysis.temporal.entities.find((e) => e.type === 'deadline');
      const event = analysis.temporal.entities.find((e) => e.type === 'event');

      expect(deadline).toBeDefined();
      expect(event).toBeDefined();

      // Deadline verification
      expect(deadline!.type).toBe('deadline');
      expect(deadline!.associatedAction).toBe('submit');
      expect(deadline!.timePrecision).toBe('exact');
      const deadlineDate = new Date(deadline!.timestamp!);
      expect(deadlineDate.getHours()).toBe(16);
      expect(deadlineDate.getMinutes()).toBe(0);

      // Event verification
      expect(event!.type).toBe('event');
      expect(event!.associatedAction).toBe('attend');
      expect(event!.timePrecision).toBe('exact');
      const eventDate = new Date(event!.timestamp!);
      expect(eventDate.getHours()).toBe(18);
      expect(eventDate.getMinutes()).toBe(30);

      // Composite primary targets
      expect(analysis.temporal.primaryDeadline).toBeDefined();
      expect(analysis.temporal.primaryDeadline?.id).toBe(deadline!.id);
      expect(analysis.temporal.primaryEvent).toBeDefined();
      expect(analysis.temporal.primaryEvent?.id).toBe(event!.id);
    });

    it('Case 2: Registration closes Sep 20. Interview Sep 21 at 3 PM.', () => {
      const email = makeEmail(
        'Interview and Registration Details',
        'Registration closes Sep 20. Interview Sep 21 at 3 PM.'
      );

      const analysis = analyzeEmail(email);
      expect(analysis.temporal.entities.length).toBe(2);

      const deadline = analysis.temporal.entities.find((e) => e.type === 'deadline');
      const event = analysis.temporal.entities.find((e) => e.type === 'event');

      expect(deadline).toBeDefined();
      expect(event).toBeDefined();

      // Deadline: Registration on Sep 20
      expect(deadline!.associatedAction).toBe('register');
      const dDate = new Date(deadline!.timestamp!);
      expect(dDate.getMonth()).toBe(8); // September (0-indexed)
      expect(dDate.getDate()).toBe(20);
      expect(deadline!.timePrecision).toBe('inferred'); // Inferred EOD because date-only deadline

      // Event: Interview on Sep 21 at 3 PM
      expect(event!.associatedAction).toBe('attend');
      const eDate = new Date(event!.timestamp!);
      expect(eDate.getMonth()).toBe(8);
      expect(eDate.getDate()).toBe(21);
      expect(eDate.getHours()).toBe(15);
      expect(event!.timePrecision).toBe('exact'); // Explicit 3 PM preserved
    });

    it('Case 3: Unrelated dates/times in separate bullet sections', () => {
      const email = makeEmail(
        'Semester Deadlines & Events',
        '• Application deadline: October 10, 2026\n• Orientation session: October 12, 2026 at 10:00 AM\n• Final project submission: November 1, 2026 by 5 PM'
      );

      const analysis = analyzeEmail(email);
      expect(analysis.temporal.entities.length).toBe(3);

      const appDeadline = analysis.temporal.entities.find((e) => e.rawText.includes('October 10'));
      const orientEvent = analysis.temporal.entities.find((e) => e.rawText.includes('October 12'));
      const projDeadline = analysis.temporal.entities.find((e) => e.rawText.includes('November 1'));

      expect(appDeadline?.type).toBe('deadline');
      expect(appDeadline?.associatedAction).toBe('apply');
      expect(appDeadline?.timePrecision).toBe('inferred');

      expect(orientEvent?.type).toBe('event');
      expect(orientEvent?.associatedAction).toBe('attend');
      expect(orientEvent?.timePrecision).toBe('exact');

      expect(projDeadline?.type).toBe('deadline');
      expect(projDeadline?.associatedAction).toBe('submit');
      expect(projDeadline?.timePrecision).toBe('exact');
    });

    it('Case 4: Date-only deadline + explicit-time event', () => {
      const email = makeEmail(
        'Annual Review and Document Submission',
        'Submit tax forms by 30th September 2026. Annual review meeting at 2:30 PM on 15th October 2026.'
      );

      const analysis = analyzeEmail(email);
      expect(analysis.temporal.entities.length).toBe(2);

      const deadline = analysis.temporal.entities.find((e) => e.type === 'deadline');
      const event = analysis.temporal.entities.find((e) => e.type === 'event');

      expect(deadline).toBeDefined();
      expect(event).toBeDefined();

      expect(deadline!.timePrecision).toBe('inferred');
      expect(event!.timePrecision).toBe('exact');
      const eventDate = new Date(event!.timestamp!);
      expect(eventDate.getHours()).toBe(14);
      expect(eventDate.getMinutes()).toBe(30);
    });
  });

  // =========================================================================
  // BUG 2: Explicit Time Replaced by Inferred 11:59 PM
  // =========================================================================
  describe('Bug 2: Explicit Time Precedence (EXPLICIT > INFERRED > UNKNOWN)', () => {
    it('Case 1: Explicit time preservation (<time> on <date>)', () => {
      const email = makeEmail(
        'Interview Scheduled',
        'Your interview at 6:30 PM on 18 September 2026 has been confirmed.'
      );

      const analysis = analyzeEmail(email);
      const entity = analysis.temporal.entities[0];

      expect(entity).toBeDefined();
      expect(entity.timePrecision).toBe('exact');
      const date = new Date(entity.timestamp!);
      expect(date.getHours()).toBe(18);
      expect(date.getMinutes()).toBe(30);
      expect(entity.evidenceReasons.some((r) => r.includes('Explicit time specified'))).toBe(true);
    });

    it('Case 2: Date-only deadline infers 23:59:59 (inferred time)', () => {
      const email = makeEmail(
        'Application Deadline',
        'The deadline is 20th September 2026.'
      );

      const analysis = analyzeEmail(email);
      const entity = analysis.temporal.entities[0];

      expect(entity).toBeDefined();
      expect(entity.type).toBe('deadline');
      expect(entity.timePrecision).toBe('inferred');
      const date = new Date(entity.timestamp!);
      expect(date.getHours()).toBe(23);
      expect(date.getMinutes()).toBe(59);
      expect(date.getSeconds()).toBe(59);
    });

    it('Case 3: Date-only event treats time as unknown (evaluated at calendar-day level)', () => {
      const email = makeEmail(
        'Annual Conference',
        'The annual conference taking place on 25th September 2026 is approaching.'
      );

      const analysis = analyzeEmail(email);
      const entity = analysis.temporal.entities[0];

      expect(entity).toBeDefined();
      expect(entity.type).toBe('event');
      expect(entity.timePrecision).toBe('unknown');
      const date = new Date(entity.timestamp!);
      expect(date.getHours()).toBe(0);
      expect(date.getMinutes()).toBe(0);
    });

    it('Case 4: Multiple dates with distinct explicit times', () => {
      const email = makeEmail(
        'Two Sessions',
        'Meeting at 9:00 AM on Sep 20. Follow-up discussion at 4:30 PM on Sep 21.'
      );

      const analysis = analyzeEmail(email);
      expect(analysis.temporal.entities.length).toBe(2);

      const session1 = analysis.temporal.entities[0];
      const session2 = analysis.temporal.entities[1];

      expect(session1.timePrecision).toBe('exact');
      expect(new Date(session1.timestamp!).getHours()).toBe(9);

      expect(session2.timePrecision).toBe('exact');
      expect(new Date(session2.timestamp!).getHours()).toBe(16);
      expect(new Date(session2.timestamp!).getMinutes()).toBe(30);
    });

    it('Case 5: Explicit event + date-only deadline', () => {
      const email = makeEmail(
        'Webinar and Registration',
        'Webinar at 11:00 AM on Sep 22. Please register by Sep 20.'
      );

      const analysis = analyzeEmail(email);
      const event = analysis.temporal.entities.find((e) => e.type === 'event');
      const deadline = analysis.temporal.entities.find((e) => e.type === 'deadline');

      expect(event?.timePrecision).toBe('exact');
      expect(new Date(event!.timestamp!).getHours()).toBe(11);

      expect(deadline?.timePrecision).toBe('inferred');
      expect(new Date(deadline!.timestamp!).getHours()).toBe(23);
    });

    it('Case 6: Explicit deadline + date-only event', () => {
      const email = makeEmail(
        'Proposal and Team Day',
        'Submit proposal by 5:00 PM on Sep 19. Team gathering on Sep 25.'
      );

      const analysis = analyzeEmail(email);
      const deadline = analysis.temporal.entities.find((e) => e.type === 'deadline');
      const event = analysis.temporal.entities.find((e) => e.type === 'event');

      expect(deadline?.timePrecision).toBe('exact');
      expect(new Date(deadline!.timestamp!).getHours()).toBe(17);

      expect(event?.timePrecision).toBe('unknown');
      expect(new Date(event!.timestamp!).getHours()).toBe(0);
    });
  });
});

describe('V1 Bug Fix Pass: Bug 3 - Account-Scoped State Persistence Across Reconnect', () => {
  const ACCOUNT_A = 'alice@example.com';
  const ACCOUNT_B = 'bob@example.com';

  beforeEach(async () => {
    await db.emails.clear();
    await db.attentionItems.clear();
    await storage.clearAll();
  });

  function makeEmail(id: string, subject: string, bodyText: string): EmailRecord {
    const ts = Date.now() - 3600000;
    return {
      id,
      threadId: `thread_${id}`,
      from: 'notifications@service.com',
      fromDomain: 'service.com',
      to: ['user@example.com'],
      subject,
      snippet: bodyText,
      bodyTextPreview: bodyText,
      internalDate: ts,
      processedAt: ts,
      isUnread: false,
      alertStatus: 'pending',
      category: 'action_deadline',
      confidence: 0.9,
      importanceScore: 80,
      urgencyScore: 85,
      actionRequired: true,
      actionType: 'submit',
      detectionReasons: [],
      extractedEntities: {
        deadlines: [],
        dates: [],
        organizations: [],
        locations: [],
        ctc: null,
        urls: [],
      },
      snoozeUntil: null,
      handledAt: null,
    };
  }

  it('Case A: Account A -> handle email -> disconnect -> reconnect Account A -> handled state preserved', async () => {
    // 1. Connect Account A
    await storage.setSyncState({ authState: 'connected', accountEmail: ACCOUNT_A });

    // 2. Ingest email for Account A
    const emailA = makeEmail('msg_a1', 'Action Required: Submit Timesheet', 'Please submit by 5 PM today.');
    const analysisA = await processEmailChange(emailA, db);
    expect(analysisA.item.userAttentionState).toBe('unhandled');

    // 3. User handles this email
    analysisA.item.userAttentionState = 'handled';
    await db.attentionItems.put(analysisA.item);
    await db.emails.update(emailA.id, { alertStatus: 'handled' });
    await storage.recordAccountAttentionDecision(ACCOUNT_A, [emailA.id], 'handled');

    // Verify it is recorded in storage
    const recordedState = await storage.lookupAccountAttentionState(ACCOUNT_A, emailA.id);
    expect(recordedState).toBe('handled');

    // 4. Disconnect Account A (clears Dexie DB tables)
    await db.emails.clear();
    await db.attentionItems.clear();
    await storage.setSyncState({ authState: 'not_connected', accountEmail: null });

    expect(await db.emails.count()).toBe(0);
    expect(await db.attentionItems.count()).toBe(0);

    // 5. Reconnect Account A
    await storage.setSyncState({ authState: 'connected', accountEmail: ACCOUNT_A });

    // 6. Sync pulls the same email again
    const emailA_reingest = makeEmail('msg_a1', 'Action Required: Submit Timesheet', 'Please submit by 5 PM today.');
    const reingestAnalysis = await processEmailChange(emailA_reingest, db);

    // 7. Handled state MUST be restored!
    expect(reingestAnalysis.item.userAttentionState).toBe('handled');
    expect(emailA_reingest.alertStatus).toBe('handled');

    // 8. Pipeline evaluation: must NOT notify and must be suppressed
    const pipeRes = await handleEmailAttentionPipeline(emailA_reingest, reingestAnalysis, { isInitialSync: true }, db);
    expect(pipeRes.eligible).toBe(false);
    expect(pipeRes.decision.shouldNotify).toBe(false);
    expect(pipeRes.decision.severity).toBe('silent');
  });

  it('Case B: Account A -> dismiss email -> disconnect -> reconnect Account A -> dismissed state preserved', async () => {
    // 1. Connect Account A
    await storage.setSyncState({ authState: 'connected', accountEmail: ACCOUNT_A });

    // 2. Ingest email for Account A
    const emailA = makeEmail('msg_a2', 'Notice: Terms Updated', 'Review updated terms by next week.');
    const analysisA = await processEmailChange(emailA, db);

    // 3. User dismisses this email
    analysisA.item.userAttentionState = 'dismissed';
    await db.attentionItems.put(analysisA.item);
    await db.emails.update(emailA.id, { alertStatus: 'dismissed' });
    await storage.recordAccountAttentionDecision(ACCOUNT_A, [emailA.id], 'dismissed');

    // 4. Disconnect Account A
    await db.emails.clear();
    await db.attentionItems.clear();
    await storage.setSyncState({ authState: 'not_connected', accountEmail: null });

    // 5. Reconnect Account A
    await storage.setSyncState({ authState: 'connected', accountEmail: ACCOUNT_A });

    // 6. Sync pulls the same email again
    const emailA_reingest = makeEmail('msg_a2', 'Notice: Terms Updated', 'Review updated terms by next week.');
    const reingestAnalysis = await processEmailChange(emailA_reingest, db);

    // 7. Dismissed state MUST be restored!
    expect(reingestAnalysis.item.userAttentionState).toBe('dismissed');
    expect(emailA_reingest.alertStatus).toBe('dismissed');

    // 8. Pipeline evaluation: must be suppressed
    const pipeRes = await handleEmailAttentionPipeline(emailA_reingest, reingestAnalysis, { isInitialSync: true }, db);
    expect(pipeRes.eligible).toBe(false);
    expect(pipeRes.decision.shouldNotify).toBe(false);
    expect(pipeRes.decision.severity).toBe('silent');
  });

  it('Case C: Account A -> disconnect -> connect Account B -> Account B sees zero data and fresh items', async () => {
    // 1. Account A handles msg_1
    await storage.setSyncState({ authState: 'connected', accountEmail: ACCOUNT_A });
    const emailA = makeEmail('msg_1', 'Important Notice', 'Action required.');
    await processEmailChange(emailA, db);
    await storage.recordAccountAttentionDecision(ACCOUNT_A, [emailA.id], 'handled');

    // 2. Disconnect Account A
    await db.emails.clear();
    await db.attentionItems.clear();
    await storage.setSyncState({ authState: 'not_connected', accountEmail: null });

    // 3. Connect Account B
    await storage.setSyncState({ authState: 'connected', accountEmail: ACCOUNT_B });

    // 4. Account B pulls its own messages
    const emailB = makeEmail('msg_b1', 'Account B Email', 'Bob please review.');
    const analysisB = await processEmailChange(emailB, db);

    // Account B should NOT inherit anything from Account A
    expect(analysisB.item.userAttentionState).toBe('unhandled');
    expect(emailB.alertStatus).toBe('pending');

    // Check account history isolation
    const historyB = await storage.getAccountAttentionHistory(ACCOUNT_B);
    expect(Object.keys(historyB).length).toBe(0);

    const historyA = await storage.getAccountAttentionHistory(ACCOUNT_A);
    expect(historyA['msg_1']?.state).toBe('handled');
  });

  it('Case D: Account A reconnect with previous handled email + brand new email', async () => {
    // 1. Account A handled msg_old
    await storage.setSyncState({ authState: 'connected', accountEmail: ACCOUNT_A });
    const oldEmail = makeEmail('msg_old', 'Old Project Task', 'Completed task.');
    await processEmailChange(oldEmail, db);
    await storage.recordAccountAttentionDecision(ACCOUNT_A, [oldEmail.id], 'handled');

    // 2. Disconnect
    await db.emails.clear();
    await db.attentionItems.clear();
    await storage.setSyncState({ authState: 'not_connected', accountEmail: null });

    // 3. Reconnect Account A
    await storage.setSyncState({ authState: 'connected', accountEmail: ACCOUNT_A });

    // 4. Sync pulls both oldEmail AND a brand new email
    const reingestOld = makeEmail('msg_old', 'Old Project Task', 'Completed task.');
    const newEmail = makeEmail('msg_new', 'Urgent Server Alert', 'Check cluster status immediately.');

    const analysisOld = await processEmailChange(reingestOld, db);
    const analysisNew = await processEmailChange(newEmail, db);

    // Old email is restored to handled
    expect(analysisOld.item.userAttentionState).toBe('handled');
    expect(reingestOld.alertStatus).toBe('handled');

    // New email is unhandled (enters Needs Attention)
    expect(analysisNew.item.userAttentionState).toBe('unhandled');
    expect(newEmail.alertStatus).toBe('pending');
  });

  it('Case E: Same message/thread IDs under different accounts are strictly isolated', async () => {
    const COMMON_ID = 'msg_shared_test_123';

    // 1. Account A handles COMMON_ID
    await storage.setSyncState({ authState: 'connected', accountEmail: ACCOUNT_A });
    const emailA = makeEmail(COMMON_ID, 'Company Wide Survey', 'Fill survey by Friday.');
    await processEmailChange(emailA, db);
    await storage.recordAccountAttentionDecision(ACCOUNT_A, [COMMON_ID], 'handled');

    // 2. Disconnect Account A
    await db.emails.clear();
    await db.attentionItems.clear();
    await storage.setSyncState({ authState: 'not_connected', accountEmail: null });

    // 3. Connect Account B with the SAME message ID (e.g. sent to team list)
    await storage.setSyncState({ authState: 'connected', accountEmail: ACCOUNT_B });
    const emailB = makeEmail(COMMON_ID, 'Company Wide Survey', 'Fill survey by Friday.');
    const analysisB = await processEmailChange(emailB, db);

    // For Account B, it MUST be unhandled!
    expect(analysisB.item.userAttentionState).toBe('unhandled');
    expect(emailB.alertStatus).toBe('pending');

    // Now Account B dismisses it
    await storage.recordAccountAttentionDecision(ACCOUNT_B, [COMMON_ID], 'dismissed');

    // Verify both accounts have their own independent states for the same ID
    expect(await storage.lookupAccountAttentionState(ACCOUNT_A, COMMON_ID)).toBe('handled');
    expect(await storage.lookupAccountAttentionState(ACCOUNT_B, COMMON_ID)).toBe('dismissed');
  });
});
