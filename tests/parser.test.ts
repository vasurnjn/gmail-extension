import { describe, it, expect } from 'vitest';
import {
  decodeBase64Url,
  extractBodyText,
  getHeaderValue,
  normalizeGmailMessage,
  parseSender,
  stripHtml,
} from '../src/background/gmail/parser';

describe('Gmail Message Parser & Normalizer', () => {
  it('decodes standard and URL-safe Base64 strings with missing padding', () => {
    // "Hello World" in base64 is "SGVsbG8gV29ybGQ="
    // without padding: "SGVsbG8gV29ybGQ"
    expect(decodeBase64Url('SGVsbG8gV29ybGQ')).toBe('Hello World');

    // Test URL-safe replacements: '-' -> '+' and '_' -> '/'
    // Text: "subjects? > test"
    const standard = Buffer.from('subjects? > test').toString('base64');
    const urlSafe = standard.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(decodeBase64Url(urlSafe)).toBe('subjects? > test');

    expect(decodeBase64Url('')).toBe('');
  });

  it('strips HTML tags and entities cleanly into plain text', () => {
    const html = `
      <html>
        <head><style>.test { color: red; }</style></head>
        <body>
          <script>console.log('ignore');</script>
          <h3>Campus Recruitment Drive</h3>
          <p>Eligible candidates should register <strong>before Friday</strong>.&nbsp;Details below:</p>
          <ul>
            <li>CTC: &#8377;12 LPA</li>
            <li>Role: SDE-1</li>
          </ul>
        </body>
      </html>
    `;

    const cleaned = stripHtml(html);
    expect(cleaned).not.toContain('<style>');
    expect(cleaned).not.toContain('<script>');
    expect(cleaned).not.toContain('console.log');
    expect(cleaned).toContain('Campus Recruitment Drive');
    expect(cleaned).toContain('Eligible candidates should register before Friday.');
    expect(cleaned).toContain('• CTC:');
  });

  it('extracts text from plain text payload', () => {
    const payload = {
      mimeType: 'text/plain',
      body: {
        data: Buffer.from('Interview scheduled for Monday at 10 AM.').toString('base64'),
      },
    };

    const text = extractBodyText(payload);
    expect(text).toBe('Interview scheduled for Monday at 10 AM.');
  });

  it('extracts and cleans text from HTML-only payload', () => {
    const payload = {
      mimeType: 'text/html',
      body: {
        data: Buffer.from('<p>Your OTP is <strong>482910</strong>. Do not share.</p>').toString('base64'),
      },
    };

    const text = extractBodyText(payload);
    expect(text).toBe('Your OTP is 482910. Do not share.');
  });

  it('handles multipart/alternative payload prioritizing text/plain over HTML', () => {
    const payload = {
      mimeType: 'multipart/alternative',
      parts: [
        {
          mimeType: 'text/plain',
          body: {
            data: Buffer.from('Plain text version of email').toString('base64'),
          },
        },
        {
          mimeType: 'text/html',
          body: {
            data: Buffer.from('<p>HTML version of email</p>').toString('base64'),
          },
        },
      ],
    };

    const text = extractBodyText(payload);
    expect(text).toBe('Plain text version of email');
  });

  it('handles nested multipart/mixed payload structure', () => {
    const payload = {
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [
            {
              mimeType: 'text/plain',
              body: {
                data: Buffer.from('Nested plain content').toString('base64'),
              },
            },
          ],
        },
        {
          mimeType: 'application/pdf',
          filename: 'application_form.pdf',
          body: {
            size: 1048576,
          },
        },
      ],
    };

    const text = extractBodyText(payload);
    expect(text).toBe('Nested plain content');
  });

  it('parses sender header into display name, email, and domain', () => {
    const res1 = parseSender('Deloitte Recruitment <campus@deloitte.com>');
    expect(res1.from).toBe('Deloitte Recruitment <campus@deloitte.com>');
    expect(res1.fromDomain).toBe('deloitte.com');

    const res2 = parseSender('recruiter@google.com');
    expect(res2.from).toBe('recruiter@google.com');
    expect(res2.fromDomain).toBe('google.com');

    const res3 = parseSender('');
    expect(res3.from).toBe('Unknown Sender');
    expect(res3.fromDomain).toBe('');
  });

  it('extracts case-insensitive header values correctly', () => {
    const headers = [
      { name: 'Subject', value: 'Quarterly Financial Statement' },
      { name: 'FROM', value: 'bank@hdfc.com' },
      { name: 'to', value: 'user@example.com, other@example.com' },
    ];

    expect(getHeaderValue(headers, 'subject')).toBe('Quarterly Financial Statement');
    expect(getHeaderValue(headers, 'from')).toBe('bank@hdfc.com');
    expect(getHeaderValue(headers, 'To')).toBe('user@example.com, other@example.com');
    expect(getHeaderValue(headers, 'Missing-Header')).toBe('');
  });

  it('normalizes full raw Gmail message into EmailRecord and caps preview length', () => {
    const longText = 'A'.repeat(3000);
    const raw = {
      id: 'msg_101',
      threadId: 'th_101',
      labelIds: ['INBOX', 'UNREAD', 'CATEGORY_PERSONAL'],
      snippet: 'Short snippet preview',
      internalDate: '1726400000000',
      payload: {
        mimeType: 'text/plain',
        headers: [
          { name: 'Subject', value: 'Amazon Campus Hiring 2026' },
          { name: 'From', value: 'Amazon Student Programs <apply@amazon.com>' },
          { name: 'To', value: 'student@university.edu' },
        ],
        body: {
          data: Buffer.from(longText).toString('base64'),
        },
      },
    };

    const normalized = normalizeGmailMessage(raw);

    expect(normalized.id).toBe('msg_101');
    expect(normalized.threadId).toBe('th_101');
    expect(normalized.subject).toBe('Amazon Campus Hiring 2026');
    expect(normalized.from).toContain('Amazon Student Programs');
    expect(normalized.fromDomain).toBe('amazon.com');
    expect(normalized.to).toEqual(['student@university.edu']);
    expect(normalized.snippet).toBe('Short snippet preview');
    expect(normalized.internalDate).toBe(1726400000000);
    expect(normalized.isUnread).toBe(true);
    expect(normalized.labels).toEqual(['INBOX', 'UNREAD', 'CATEGORY_PERSONAL']);

    // Verify preview is capped at 2000 chars
    expect(normalized.bodyTextPreview.length).toBe(2000);

    // Verify neutral defaults for Phase 1B
    expect(normalized.category).toBe('uncategorized');
    expect(normalized.importanceScore).toBe(0);
    expect(normalized.urgencyScore).toBe(0);
    expect(normalized.alertStatus).toBe('pending');
  });

  it('falls back to snippet if message body is empty', () => {
    const raw = {
      id: 'msg_102',
      threadId: 'th_102',
      snippet: 'Only snippet is present in this minimal message',
      payload: {
        mimeType: 'text/plain',
        headers: [{ name: 'Subject', value: 'Quick Alert' }],
      },
    };

    const normalized = normalizeGmailMessage(raw);
    expect(normalized.bodyTextPreview).toBe('Only snippet is present in this minimal message');
  });
});
