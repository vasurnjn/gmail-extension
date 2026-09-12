import { describe, it, expect } from 'vitest';
import {
  extractSignals,
  extractSenderSignals,
  extractContentSignals,
  extractStructuralSignals,
} from '../src/background/analysis/extractor';
import { EmailRecord } from '../src/shared/types';

function createDummyRecord(overrides: Partial<EmailRecord>): EmailRecord {
  return {
    id: 'msg_test_1',
    threadId: 'th_test_1',
    subject: 'Test Subject',
    from: 'Sender <sender@example.com>',
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

describe('Signal Extractor (Phase 1C.1)', () => {
  it('identifies automated senders by standard prefix patterns', () => {
    const s1 = extractSenderSignals('Acme Alerts <no-reply@acme.com>', 'acme.com');
    expect(s1.isAutomatedSender).toBe(true);
    expect(s1.domain).toBe('acme.com');
    expect(s1.senderEmail).toBe('no-reply@acme.com');

    const s2 = extractSenderSignals('System Notifications <notifications@service.org>', 'service.org');
    expect(s2.isAutomatedSender).toBe(true);

    const s3 = extractSenderSignals('Jane Doe <jane.doe@gmail.com>', 'gmail.com');
    expect(s3.isAutomatedSender).toBe(false);
    expect(s3.isMajorFreeMail).toBe(true);
  });

  it('detects educational and government domains generically without hardcoding', () => {
    const edu1 = extractSenderSignals('Registrar <registrar@stanford.edu>', 'stanford.edu');
    expect(edu1.isAcademicDomain).toBe(true);
    expect(edu1.isGovernmentDomain).toBe(false);

    const edu2 = extractSenderSignals('Exam Cell <exams@iitd.ac.in>', 'iitd.ac.in');
    expect(edu2.isAcademicDomain).toBe(true);

    const edu3 = extractSenderSignals('University Admin <admin@oxford.ac.uk>', 'oxford.ac.uk');
    expect(edu3.isAcademicDomain).toBe(true);

    const gov1 = extractSenderSignals('Passport Office <passport@passportindia.gov.in>', 'passportindia.gov.in');
    expect(gov1.isGovernmentDomain).toBe(true);
    expect(gov1.isAcademicDomain).toBe(false);

    const gov2 = extractSenderSignals('IRS Alerts <notices@irs.gov>', 'irs.gov');
    expect(gov2.isGovernmentDomain).toBe(true);
  });

  it('extracts action verbs and content keywords with boundary matching', () => {
    const text = 'Please submit your assignment and review the syllabus before the exam. Do not miss this example.';
    const signals = extractContentSignals(text);

    expect(signals.actionVerbs).toContain('submit');
    expect(signals.actionVerbs).toContain('review');
    expect(signals.academicKeywords).toContain('assignment');
    expect(signals.academicKeywords).toContain('syllabus');
    expect(signals.academicKeywords).toContain('exam');
    // "example" should NOT trigger false positive for "exam" if boundary check is correct
    const examMatches = signals.academicKeywords.filter((k) => k === 'exam');
    expect(examMatches.length).toBe(1);
  });

  it('detects structural mailing list unsubscribe and automated disclaimers', () => {
    const struct = extractStructuralSignals(
      'Weekly Tech Digest',
      'Here are your top stories. To stop receiving these, please unsubscribe here: https://example.com/opt-out',
      ['CATEGORY_PROMOTIONS']
    );

    expect(struct.hasMailingListUnsubscribe).toBe(true);
    expect(struct.hasUrls).toBe(true);
    expect(struct.gmailLabels).toContain('CATEGORY_PROMOTIONS');
    expect(struct.hasReplySubject).toBe(false);
  });

  it('detects direct conversational reply threads', () => {
    const struct = extractStructuralSignals('Re: Weekend project plans', 'Hey, sounds good to me!', [
      'CATEGORY_PERSONAL',
    ]);
    expect(struct.hasReplySubject).toBe(true);
    expect(struct.hasMailingListUnsubscribe).toBe(false);
  });

  it('extracts comprehensive signals bundle from EmailRecord', () => {
    const record = createDummyRecord({
      from: 'Campus Hiring Team <recruitment@globaltech.com>',
      fromDomain: 'globaltech.com',
      subject: 'Interview Schedule & Coding Assessment',
      bodyTextPreview: 'Dear Candidate, please complete your online assessment before tomorrow.',
      labels: ['INBOX'],
    });

    const signals = extractSignals(record);
    expect(signals.sender.isAutomatedSender).toBe(false);
    expect(signals.content.recruitmentKeywords).toContain('recruitment');
    expect(signals.content.recruitmentKeywords).toContain('interview');
    expect(signals.content.recruitmentKeywords).toContain('assessment');
    expect(signals.content.actionVerbs).toContain('complete');
  });
});
