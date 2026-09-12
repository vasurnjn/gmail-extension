import { EmailRecord } from '../../shared/types';
import { CURRENT_ANALYSIS_VERSION } from '../../shared/constants';

export interface GmailMessagePartHeader {
  name: string;
  value: string;
}

export interface GmailMessagePartBody {
  size?: number;
  data?: string;
  attachmentId?: string;
}

export interface GmailMessagePayload {
  partId?: string;
  mimeType: string;
  filename?: string;
  headers?: GmailMessagePartHeader[];
  body?: GmailMessagePartBody;
  parts?: GmailMessagePayload[];
}

export interface GmailRawMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  internalDate?: string;
  payload?: GmailMessagePayload;
  sizeEstimate?: number;
}

/**
 * Decodes Gmail's URL-safe Base64 string into UTF-8 text.
 * Handles `-` and `_` replacement and missing `=` padding.
 * Works seamlessly in both browser/service worker and Node test environments.
 */
export function decodeBase64Url(data: string): string {
  if (!data) return '';

  let base64 = data.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }

  try {
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(base64, 'base64').toString('utf-8');
    }
    const binaryStr = atob(base64);
    const bytes = Uint8Array.from(binaryStr, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch (err) {
    console.warn('[IGAM Parser] Base64 decode failed:', err);
    return '';
  }
}

/**
 * Strips HTML tags into clean, human-readable text.
 * DOM-free implementation ensuring safety and high performance inside Service Workers.
 */
export function stripHtml(html: string): string {
  if (!html) return '';

  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '')
    .replace(/<br\s*[\/]?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\r\n|\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s+([.,!?:;])/g, '$1')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

/**
 * Recursively extracts plain text and/or HTML text from Gmail message payload MIME parts.
 * Prioritizes text/plain; falls back to stripped text/html.
 */
export function extractBodyText(payload?: GmailMessagePayload): string {
  if (!payload) return '';

  let plainText = '';
  let htmlText = '';

  function traverse(part: GmailMessagePayload) {
    const mimeType = part.mimeType ? part.mimeType.toLowerCase() : '';
    const bodyData = part.body?.data;

    if (mimeType === 'text/plain' && bodyData && !plainText) {
      plainText = decodeBase64Url(bodyData);
    } else if (mimeType === 'text/html' && bodyData && !htmlText) {
      htmlText = stripHtml(decodeBase64Url(bodyData));
    }

    if (part.parts && part.parts.length > 0) {
      for (const subPart of part.parts) {
        traverse(subPart);
        // If we found plain text, we can stop traversing further
        if (plainText) break;
      }
    }
  }

  traverse(payload);

  return (plainText || htmlText || '').trim();
}

/**
 * Extracts a specific header value by case-insensitive name.
 */
export function getHeaderValue(headers: GmailMessagePartHeader[] | undefined, name: string): string {
  if (!headers || !Array.isArray(headers)) return '';
  const target = name.toLowerCase();
  const found = headers.find((h) => h.name.toLowerCase() === target);
  return found ? found.value.trim() : '';
}

/**
 * Parses a sender string (e.g. "Deloitte Recruitment <campus@deloitte.com>")
 * into a formatted sender string and domain.
 */
export function parseSender(fromHeader: string): { from: string; fromDomain: string } {
  if (!fromHeader) {
    return { from: 'Unknown Sender', fromDomain: '' };
  }

  const emailMatch = fromHeader.match(/<([^>]+)>/) || fromHeader.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
  const email = emailMatch ? emailMatch[1].trim() : fromHeader.trim();

  let domain = '';
  if (email.includes('@')) {
    domain = email.split('@')[1].toLowerCase().trim();
  }

  return {
    from: fromHeader.trim(),
    fromDomain: domain,
  };
}

/**
 * Normalizes a raw Gmail API message response into our internal EmailRecord.
 * Capped at 2000 chars for body preview to respect storage and privacy requirements.
 */
export function normalizeGmailMessage(raw: GmailRawMessage): EmailRecord {
  const headers = raw.payload?.headers || [];
  const subject = getHeaderValue(headers, 'Subject') || '(No Subject)';
  const fromHeader = getHeaderValue(headers, 'From');
  const toHeader = getHeaderValue(headers, 'To');
  const { from, fromDomain } = parseSender(fromHeader);

  const to = toHeader
    ? toHeader.split(',').map((t) => t.trim()).filter(Boolean)
    : [];

  const rawSnippet = raw.snippet || '';
  const extractedBody = extractBodyText(raw.payload);
  const bodyTextPreview = (extractedBody || rawSnippet).slice(0, 2000);

  let internalDate = Date.now();
  if (raw.internalDate) {
    const parsed = parseInt(raw.internalDate, 10);
    if (!isNaN(parsed) && parsed > 0) {
      internalDate = parsed;
    }
  }

  const labels = Array.isArray(raw.labelIds) ? raw.labelIds : [];
  const isUnread = labels.includes('UNREAD');

  return {
    id: raw.id,
    threadId: raw.threadId || raw.id,
    subject,
    from,
    fromDomain,
    to,
    snippet: rawSnippet,
    internalDate,
    processedAt: Date.now(),
    bodyTextPreview,
    labels,
    isUnread,

    // Classification, scoring & temporal analysis fields
    analysisVersion: CURRENT_ANALYSIS_VERSION,
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

    // Phase 4 additions
    attentionItemId: null,
    changeRelation: null,
  };
}
