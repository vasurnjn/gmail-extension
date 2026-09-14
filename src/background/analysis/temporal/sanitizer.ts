/**
 * Sanitizes and splits email body text to isolate fresh message content
 * from historical reply threads, forwarded blocks, and boilerplate footers.
 */

export interface SanitizedContent {
  primaryText: string;
  quotedText: string;
  hasQuotedHistory: boolean;
}

const QUOTE_HEADER_PATTERNS = [
  /\n\s*On\s+.+?at\s+.+?,\s*.+?\s+wrote:\s*\n/i,
  /\n\s*On\s+.+?,\s*.+?\s+wrote:\s*\n/i,
  /\n\s*-{3,}\s*(?:Original Message|Forwarded message)\s*-{3,}/i,
  /\n\s*From:\s*.+?\n(?:Sent|Date):\s*.+?\n/i,
  /\n\s*_{10,}\s*\n/,
];

const DISCLAIMER_PATTERNS = [
  /\n\s*(?:This email and any files transmitted|The information contained in this (?:e-?mail|message)|CONFIDENTIALITY NOTICE|DISCLAIMER:)[\s\S]*$/i,
  /\n\s*Copyright\s+(?:©|\(c\))\s*\d{4}[\s\S]*$/i,
];

export function sanitizeEmailContent(subject: string, bodyText: string): SanitizedContent {
  if (!bodyText) {
    return { primaryText: subject || '', quotedText: '', hasQuotedHistory: false };
  }

  let earliestQuoteIndex = -1;

  for (const pattern of QUOTE_HEADER_PATTERNS) {
    const match = pattern.exec(bodyText);
    if (match && match.index !== undefined) {
      if (earliestQuoteIndex === -1 || match.index < earliestQuoteIndex) {
        earliestQuoteIndex = match.index;
      }
    }
  }

  // Also check for blocks of lines starting with '>'
  const gtMatch = /\n\s*>[^\n]+(?:\n\s*>[^\n]+)+/.exec(bodyText);
  if (gtMatch && gtMatch.index !== undefined) {
    if (earliestQuoteIndex === -1 || gtMatch.index < earliestQuoteIndex) {
      earliestQuoteIndex = gtMatch.index;
    }
  }

  let primaryText = '';
  let quotedText = '';
  let hasQuotedHistory = false;

  if (earliestQuoteIndex !== -1) {
    primaryText = bodyText.slice(0, earliestQuoteIndex).trim();
    quotedText = bodyText.slice(earliestQuoteIndex).trim();
    hasQuotedHistory = true;
  } else {
    primaryText = bodyText.trim();
  }

  // If primary text is empty (e.g. forward with no top comment), retain body as primary
  if (!primaryText && quotedText) {
    primaryText = quotedText;
    quotedText = '';
    hasQuotedHistory = false;
  }

  // Strip trailing legal disclaimers and footers from primary text
  for (const disclaimerPattern of DISCLAIMER_PATTERNS) {
    primaryText = primaryText.replace(disclaimerPattern, '').trim();
  }

  // Include subject at the top of primary text for unified temporal scanning
  const fullPrimaryText = subject ? `${subject}\n\n${primaryText}` : primaryText;

  return {
    primaryText: fullPrimaryText,
    quotedText,
    hasQuotedHistory,
  };
}
