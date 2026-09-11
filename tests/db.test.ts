import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IGAMDatabase } from '../src/db/schema';
import { EmailRecord } from '../src/shared/types';

describe('Dexie Database Schema (IGAMDatabase)', () => {
  let testDb: IGAMDatabase;

  beforeEach(() => {
    testDb = new IGAMDatabase(`test_db_${Date.now()}_${Math.random()}`);
  });

  afterEach(async () => {
    await testDb.delete();
  });

  it('initializes all required tables', () => {
    expect(testDb.emails).toBeDefined();
    expect(testDb.senderProfiles).toBeDefined();
    expect(testDb.userFeedback).toBeDefined();
    expect(testDb.categoryWeights).toBeDefined();
    expect(testDb.scheduledAlarms).toBeDefined();
    expect(testDb.attentionItems).toBeDefined();
  });

  it('stores and queries email records indexed by importance and category', async () => {
    const sampleRecord: EmailRecord = {
      id: 'msg_001',
      threadId: 'th_001',
      subject: 'Campus Recruitment - Deloitte Application Deadline',
      from: 'campus@deloitte.com',
      fromDomain: 'deloitte.com',
      snippet: 'Eligible students must register before 16 September at 5 PM.',
      internalDate: 1726400000000,
      processedAt: Date.now(),
      bodyTextPreview: 'Eligible students must register before 16 September at 5 PM...',
      category: 'career_placement',
      confidence: 0.95,
      importanceScore: 88,
      urgencyScore: 75,
      actionRequired: true,
      actionType: 'apply',
      detectionReasons: ['Recruitment detected', 'Deadline detected', 'CTC mentioned'],
      extractedEntities: {
        deadlines: [
          {
            text: '16 September at 5 PM',
            parsedTimestamp: 1726486200000,
            confidence: 'HIGH',
          },
        ],
        dates: [],
        organizations: ['Deloitte'],
        locations: [],
        ctc: null,
        urls: ['https://deloitte.com/apply'],
      },
      alertStatus: 'notified',
      snoozeUntil: null,
      handledAt: null,
    };

    await testDb.emails.add(sampleRecord);

    const fetched = await testDb.emails.get('msg_001');
    expect(fetched).toBeDefined();
    expect(fetched?.subject).toContain('Deloitte');
    expect(fetched?.importanceScore).toBe(88);
    expect(fetched?.category).toBe('career_placement');
    expect(fetched?.extractedEntities.deadlines.length).toBe(1);

    // Query via indexed field: importanceScore >= 80
    const highImportance = await testDb.emails
      .where('importanceScore')
      .aboveOrEqual(80)
      .toArray();
    expect(highImportance.length).toBe(1);
    expect(highImportance[0].id).toBe('msg_001');

    // Query by category
    const careerEmails = await testDb.emails
      .where('category')
      .equals('career_placement')
      .toArray();
    expect(careerEmails.length).toBe(1);
  });

  it('records sender reputation profiles and feedback', async () => {
    await testDb.senderProfiles.add({
      email: 'recruiter@techcorp.com',
      domain: 'techcorp.com',
      displayName: 'TechCorp Recruiter',
      positiveInteractions: 2,
      negativeInteractions: 0,
      reputationScore: 0.85,
      isMailingList: false,
      lastSeen: Date.now(),
      firstSeen: Date.now() - 86400000,
    });

    const profile = await testDb.senderProfiles.get('recruiter@techcorp.com');
    expect(profile?.reputationScore).toBe(0.85);

    // Log feedback
    const feedbackId = await testDb.userFeedback.add({
      emailId: 'msg_001',
      timestamp: Date.now(),
      action: 'handled',
      category: 'career_placement',
      importanceScoreAtTime: 88,
    });
    expect(feedbackId).toBeDefined();

    const feedbacks = await testDb.userFeedback.where('action').equals('handled').toArray();
    expect(feedbacks.length).toBe(1);
  });
});
