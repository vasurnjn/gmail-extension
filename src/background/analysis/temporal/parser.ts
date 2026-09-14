import {
  IntermediateTemporalCandidate,
  ParsedDateComponent,
  ParsedTimeComponent,
} from './types';

const MONTH_MAP: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

const MONTH_PATTERN =
  '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';

const TIMEZONE_PATTERN =
  '(?:[+-]\\d{2}:?\\d{2}|UTC|GMT|Z|IST|EST|EDT|CST|CDT|PST|PDT|BST|CET|CEST|CT|ET|PT|MT|AT)';

function getScopedPrecedingSlice(text: string, matchIndex: number, maxChars = 70): string {
  const minStart = Math.max(0, matchIndex - maxChars);
  let boundaryIndex = minStart;

  for (let i = matchIndex - 1; i >= minStart; i--) {
    const char = text[i];
    if (char === '\n' || char === '\r') {
      boundaryIndex = i + 1;
      break;
    }
    if (char === '.' || char === '!' || char === '?' || char === ';' || char === '|') {
      // Avoid treating decimal points between digits (e.g. 4.30) as sentence boundaries
      if (char === '.' && i > 0 && i < text.length - 1 && /\d/.test(text[i - 1]) && /\d/.test(text[i + 1])) {
        continue;
      }
      boundaryIndex = i + 1;
      break;
    }
  }

  return text.slice(boundaryIndex, matchIndex);
}

function getScopedFollowingSlice(text: string, fromIndex: number, maxChars = 50): string {
  const maxEnd = Math.min(text.length, fromIndex + maxChars);
  let boundaryIndex = maxEnd;

  for (let i = fromIndex; i < maxEnd; i++) {
    const char = text[i];
    if (char === '\n' || char === '\r') {
      boundaryIndex = i;
      break;
    }
    if (char === '.' || char === '!' || char === '?' || char === ';' || char === '|') {
      if (char === '.' && i > 0 && i < text.length - 1 && /\d/.test(text[i - 1]) && /\d/.test(text[i + 1])) {
        continue;
      }
      boundaryIndex = i + 1;
      break;
    }
  }

  return text.slice(fromIndex, boundaryIndex);
}

function extractSnippet(text: string, index: number, length: number): string {
  const preceding = getScopedPrecedingSlice(text, index, 45);
  const matched = text.slice(index, index + length);
  const following = getScopedFollowingSlice(text, index + length, 45);
  return `${preceding}${matched}${following}`.replace(/\s+/g, ' ').trim();
}

/**
 * Parses numeric timezone offset string (e.g. "+05:30", "+0530", "-04:00", "Z", "UTC", "GMT")
 * into total offset in minutes from UTC.
 */
export function parseTimezoneOffset(raw?: string): { offsetMinutes: number | null; isAmbiguous: boolean } {
  if (!raw) return { offsetMinutes: null, isAmbiguous: false };
  const trimmed = raw.trim().toUpperCase();

  if (trimmed === 'UTC' || trimmed === 'GMT' || trimmed === 'Z') {
    return { offsetMinutes: 0, isAmbiguous: false };
  }

  const offsetMatch = /^([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(trimmed);
  if (offsetMatch) {
    const sign = offsetMatch[1] === '-' ? -1 : 1;
    const hours = parseInt(offsetMatch[2], 10);
    const mins = offsetMatch[3] ? parseInt(offsetMatch[3], 10) : 0;
    return { offsetMinutes: sign * (hours * 60 + mins), isAmbiguous: false };
  }

  // Unrecognized regional abbreviation (e.g. CT, AT, IST, BST)
  return { offsetMinutes: null, isAmbiguous: true };
}

/**
 * Parses time expressions such as "4:30 PM", "10.00 am", "16:30", "4 PM", "@ 4 PM", "by EOD".
 */
export function parseTimeString(timeStr: string): ParsedTimeComponent | null {
  if (!timeStr) return null;
  const lower = timeStr.toLowerCase().replace(/\s+onwards?/i, '').trim();

  // Nominal times
  if (/^(?:eod|end\s+of\s+day)$/i.test(lower)) {
    return { hours: 23, minutes: 59, seconds: 59, isExplicitTime: false };
  }
  if (/^noon$/i.test(lower)) {
    return { hours: 12, minutes: 0, seconds: 0, isExplicitTime: true };
  }
  if (/^midnight$/i.test(lower)) {
    return { hours: 0, minutes: 0, seconds: 0, isExplicitTime: true };
  }

  // Standard 12-hour: "4:30 PM", "10.00 am", "4 PM", "4:30pm", "10am"
  const regex12h = new RegExp(
    `(?:at|by|@)?\\s*(\\d{1,2})(?:[:.](\\d{2}))?\\s*(am|pm|a\\.m\\.|p\\.m\\.)(?:\\s+(${TIMEZONE_PATTERN}))?`,
    'i'
  );
  const match12 = regex12h.exec(lower);
  if (match12) {
    let hours = parseInt(match12[1], 10);
    const minutes = match12[2] ? parseInt(match12[2], 10) : 0;
    const meridiem = match12[3].replace(/\./g, '').toLowerCase();
    const rawTz = match12[4];

    if (hours > 12) return null; // Invalid 12h time
    if (meridiem === 'pm' && hours < 12) hours += 12;
    if (meridiem === 'am' && hours === 12) hours = 0;

    const { offsetMinutes, isAmbiguous } = parseTimezoneOffset(rawTz);

    return {
      hours,
      minutes,
      seconds: 0,
      isExplicitTime: true,
      timezoneOffsetMinutes: offsetMinutes,
      timezoneRaw: rawTz,
      isAmbiguousTimezone: isAmbiguous,
    };
  }

  // 24-hour: "16:30", "09:15 hrs"
  const regex24h = new RegExp(
    `(?:at|by)?\\s*([01]?\\d|2[0-3])[:.]([0-5]\\d)(?:\\s*(?:hrs?|hours?))?(?:\\s+(${TIMEZONE_PATTERN}))?`,
    'i'
  );
  const match24 = regex24h.exec(lower);
  if (match24) {
    const hours = parseInt(match24[1], 10);
    const minutes = parseInt(match24[2], 10);
    const rawTz = match24[3];
    const { offsetMinutes, isAmbiguous } = parseTimezoneOffset(rawTz);

    return {
      hours,
      minutes,
      seconds: 0,
      isExplicitTime: true,
      timezoneOffsetMinutes: offsetMinutes,
      timezoneRaw: rawTz,
      isAmbiguousTimezone: isAmbiguous,
    };
  }

  return null;
}

/**
 * Extracts candidate temporal mentions from clean text using deterministic regex patterns.
 */
export function extractTemporalCandidates(text: string): IntermediateTemporalCandidate[] {
  if (!text) return [];

  const candidates: IntermediateTemporalCandidate[] = [];
  const processedSpans: Array<{ start: number; end: number }> = [];

  function overlaps(start: number, end: number): boolean {
    return processedSpans.some(span => Math.max(start, span.start) < Math.min(end, span.end));
  }

  function markSpan(start: number, end: number) {
    processedSpans.push({ start, end });
  }

  // Check if text has commercial promo language in surrounding context
  const isCommercialText = /\b(discount|% off|promo code|coupon|clearance sale|flash sale|sale ends)\b/i.test(text);

  // Helper to find preceding preposition and action verb in the surrounding clause
  function findPrecedingCues(matchIndex: number): { preposition?: string; actionVerb?: string } {
    const precedingSlice = getScopedPrecedingSlice(text, matchIndex, 70).toLowerCase();

    // Preposition cues - find the closest one preceding the temporal match
    let preposition: string | undefined;
    const prepRegex =
      /\b(on\s+or\s+before|scheduled\s+(?:on|for|at)|latest\s+by|no\s+later\s+than|due\s+(?:date|by)?|deadline\s+(?:is|for)?|closes\s+(?:on|at)?|starts\s+(?:at|on)|held\s+on|taking\s+place\s+on|before|by|until|till|at|on|due|deadline|closes)\b/gi;
    let pMatch: RegExpExecArray | null;
    while ((pMatch = prepRegex.exec(precedingSlice)) !== null) {
      preposition = pMatch[1].trim();
    }

    // Action verb cues - find the closest one preceding the temporal match
    let actionVerb: string | undefined;
    const actionRegex =
      /\b(register|registration|apply|application|submit|submission|upload|pay|payment|attend|attendance|interview|meeting|session|webinar|conference|confirm|complete|verify|fill\s+the\s+form|rsvp)\b/gi;
    let aMatch: RegExpExecArray | null;
    while ((aMatch = actionRegex.exec(precedingSlice)) !== null) {
      actionVerb = aMatch[1].trim();
    }

    return { preposition, actionVerb };
  }

  // =========================================================================
  // 1. DATE RANGES: "open from 15th September to 20th September 2026"
  // =========================================================================
  const rangeRegex = new RegExp(
    `\\b(?:open\\s+)?(?:from|between)\\s+(\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH_PATTERN}(?:,?\\s+(?:\\d{4}|\\d{2}))?)\\s+(?:to|till|until|and)\\s+(\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH_PATTERN}(?:,?\\s+(?:\\d{4}|\\d{2}))?)\\b`,
    'gi'
  );
  let rMatch: RegExpExecArray | null;
  while ((rMatch = rangeRegex.exec(text)) !== null) {
    const startIdx = rMatch.index;
    const endIdx = startIdx + rMatch[0].length;
    if (overlaps(startIdx, endIdx)) continue;
    markSpan(startIdx, endIdx);

    const startPart = parseDateString(rMatch[1]);
    const endPart = parseDateString(rMatch[2]);
    const { preposition, actionVerb } = findPrecedingCues(startIdx);

    candidates.push({
      rawText: rMatch[0].replace(/\s+/g, ' ').trim(),
      contextSnippet: extractSnippet(text, startIdx, rMatch[0].length).replace(/\s+/g, ' ').trim(),
      dateComponent: startPart,
      timeComponent: null,
      prepositionText: preposition || 'from',
      actionVerbText: actionVerb,
      isRelative: false,
      isRange: true,
      rangeEndComponent: {
        date: endPart,
        time: null,
      },
      isOpenEnded: false,
      isCommercial: isCommercialText,
    });
  }

  // =========================================================================
  // 2. DATE-FIRST COMPOUND: "<date> [by|at|@] <time>"
  // Examples:
  // - "16th September 2026 by 10.00 am"
  // - "17th September 2026 by 4.30pm"
  // - "18-09-26 9 am onwards"
  // - "17-09-2026 @ 4 PM"
  // - "September 20, 2026 (10.00 AM)"
  // =========================================================================
  const compoundRegex = new RegExp(
    `\\b(\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH_PATTERN}(?:,?\\s+(?:\\d{4}|\\d{2}))?|${MONTH_PATTERN}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+(?:\\d{4}|\\d{2}))?|\\d{1,2}[-/]\\d{1,2}[-/](?:\\d{4}|\\d{2})|\\d{4}[-/]\\d{1,2}[-/]\\d{1,2})` +
      `\\s*(?:by|at|@|\\(|,\\s*at|,)?\\s*(\\d{1,2}(?:[:.]\\d{2})?\\s*(?:am|pm|a\\.m\\.|p\\.m\\.)(?:\\s+${TIMEZONE_PATTERN})?|\\d{1,2}[:.]\\d{2}(?:\\s*(?:hrs?|hours?))?(?:\\s+${TIMEZONE_PATTERN})?|eod|noon|midnight)(?:\\s+onwards?)?\\)?`,
    'gi'
  );

  let cMatch: RegExpExecArray | null;
  while ((cMatch = compoundRegex.exec(text)) !== null) {
    const startIdx = cMatch.index;
    const endIdx = startIdx + cMatch[0].length;
    if (overlaps(startIdx, endIdx)) continue;
    markSpan(startIdx, endIdx);

    const datePart = parseDateString(cMatch[1]);
    const timePart = parseTimeString(cMatch[2]);
    const { preposition, actionVerb } = findPrecedingCues(startIdx);
    const rawText = cMatch[0].replace(/\s+/g, ' ').trim();
    const isOpenEnded = /\bonwards?\b/i.test(cMatch[0]);

    candidates.push({
      rawText,
      contextSnippet: extractSnippet(text, startIdx, cMatch[0].length).replace(/\s+/g, ' ').trim(),
      dateComponent: datePart,
      timeComponent: timePart,
      prepositionText: preposition,
      actionVerbText: actionVerb,
      isRelative: false,
      isRange: false,
      isOpenEnded,
      isCommercial: isCommercialText,
    });
  }

  // =========================================================================
  // 3. TIME-FIRST COMPOUND: "<time> [on|for|of|scheduled for] <date>"
  // Examples:
  // - "6:30 PM on 18 September 2026"
  // - "at 4 PM on Sep 20"
  // - "interview at 3 PM on 21st September"
  // =========================================================================
  const timeFirstCompoundRegex = new RegExp(
    `\\b((?:at|by|@)?\\s*(?:\\d{1,2}(?:[:.]\\d{2})?\\s*(?:am|pm|a\\.m\\.|p\\.m\\.)(?:\\s+${TIMEZONE_PATTERN})?|(?:[01]?\\d|2[0-3])[:.][0-5]\\d(?:\\s*(?:hrs?|hours?))?(?:\\s+${TIMEZONE_PATTERN})?|noon|midnight))` +
      `\\s*(?:on|for|of|scheduled\\s+for|taking\\s+place\\s+on|,)?\\s*` +
      `(\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH_PATTERN}(?:,?\\s+(?:\\d{4}|\\d{2}))?|${MONTH_PATTERN}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+(?:\\d{4}|\\d{2}))?|\\d{1,2}[-/]\\d{1,2}[-/](?:\\d{4}|\\d{2})|\\d{4}[-/]\\d{1,2}[-/]\\d{1,2})(?:\\s+onwards?)?\\b`,
    'gi'
  );

  let tfcMatch: RegExpExecArray | null;
  while ((tfcMatch = timeFirstCompoundRegex.exec(text)) !== null) {
    const startIdx = tfcMatch.index;
    const endIdx = startIdx + tfcMatch[0].length;
    if (overlaps(startIdx, endIdx)) continue;
    markSpan(startIdx, endIdx);

    const timePart = parseTimeString(tfcMatch[1]);
    const datePart = parseDateString(tfcMatch[2]);
    const { preposition, actionVerb } = findPrecedingCues(startIdx);
    const rawText = tfcMatch[0].replace(/\s+/g, ' ').trim();
    const isOpenEnded = /\bonwards?\b/i.test(tfcMatch[0]);

    candidates.push({
      rawText,
      contextSnippet: extractSnippet(text, startIdx, tfcMatch[0].length).replace(/\s+/g, ' ').trim(),
      dateComponent: datePart,
      timeComponent: timePart,
      prepositionText: preposition || (tfcMatch[1].toLowerCase().startsWith('by') ? 'by' : 'at'),
      actionVerbText: actionVerb,
      isRelative: false,
      isRange: false,
      isOpenEnded,
      isCommercial: isCommercialText,
    });
  }

  // =========================================================================
  // 4. RELATIVE WITH EXPLICIT TIME: "today at 4 PM", "tomorrow by 10 AM"
  // =========================================================================
  const relativeWithTimeRegex = new RegExp(
    `\\b(today|tonight|tomorrow|yesterday)\\s*(?:at|by|@|,)?\\s*(\\d{1,2}(?:[:.]\\d{2})?\\s*(?:am|pm|a\\.m\\.|p\\.m\\.)(?:\\s+${TIMEZONE_PATTERN})?|(?:[01]?\\d|2[0-3])[:.][0-5]\\d(?:\\s*(?:hrs?|hours?))?(?:\\s+${TIMEZONE_PATTERN})?|noon|midnight)\\b`,
    'gi'
  );

  let rwtMatch: RegExpExecArray | null;
  while ((rwtMatch = relativeWithTimeRegex.exec(text)) !== null) {
    const startIdx = rwtMatch.index;
    const endIdx = startIdx + rwtMatch[0].length;
    if (overlaps(startIdx, endIdx)) continue;
    markSpan(startIdx, endIdx);

    const matchedStr = rwtMatch[1].toLowerCase();
    const timePart = parseTimeString(rwtMatch[2]);
    const { preposition, actionVerb } = findPrecedingCues(startIdx);

    let relativeType: IntermediateTemporalCandidate['relativeType'] = 'today';
    if (matchedStr.includes('tomorrow')) relativeType = 'tomorrow';
    else if (matchedStr.includes('yesterday')) relativeType = 'yesterday';
    else if (matchedStr.includes('tonight')) relativeType = 'today';

    candidates.push({
      rawText: rwtMatch[0].replace(/\s+/g, ' ').trim(),
      contextSnippet: extractSnippet(text, startIdx, rwtMatch[0].length).replace(/\s+/g, ' ').trim(),
      dateComponent: null,
      timeComponent: timePart,
      prepositionText: preposition,
      actionVerbText: actionVerb,
      isRelative: true,
      relativeType,
      isRange: false,
      isOpenEnded: false,
      isCommercial: isCommercialText,
    });
  }

  // =========================================================================
  // 5. STANDALONE DATES: "16th September 2026", "September 20"
  // =========================================================================
  const dateRegex = new RegExp(
    `\\b(\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH_PATTERN}(?:,?\\s+(?:\\d{4}|\\d{2}))?|${MONTH_PATTERN}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+(?:\\d{4}|\\d{2}))?|\\d{1,2}[-/]\\d{1,2}[-/](?:\\d{4}|\\d{2})|\\d{4}[-/]\\d{1,2}[-/]\\d{1,2})(?:\\s+onwards?)?\\b`,
    'gi'
  );

  let dMatch: RegExpExecArray | null;
  while ((dMatch = dateRegex.exec(text)) !== null) {
    const startIdx = dMatch.index;
    const endIdx = startIdx + dMatch[0].length;
    if (overlaps(startIdx, endIdx)) continue;
    markSpan(startIdx, endIdx);

    const datePart = parseDateString(dMatch[1]);
    const { preposition, actionVerb } = findPrecedingCues(startIdx);
    const rawText = dMatch[0].replace(/\s+/g, ' ').trim();
    const isOpenEnded = /\bonwards?\b/i.test(dMatch[0]);

    candidates.push({
      rawText,
      contextSnippet: extractSnippet(text, startIdx, dMatch[0].length).replace(/\s+/g, ' ').trim(),
      dateComponent: datePart,
      timeComponent: null, // Time precision unknown or inferred depending on semantics
      prepositionText: preposition,
      actionVerbText: actionVerb,
      isRelative: false,
      isRange: false,
      isOpenEnded,
      isCommercial: isCommercialText,
    });
  }

  // =========================================================================
  // 6. STANDALONE TIMES: "by 4:00 PM", "at 6:30 PM", "16:30"
  // =========================================================================
  const standaloneTimeRegex = new RegExp(
    `\\b((?:at|by|@)?\\s*(?:\\d{1,2}(?:[:.]\\d{2})?\\s*(?:am|pm|a\\.m\\.|p\\.m\\.)(?:\\s+${TIMEZONE_PATTERN})?|(?:[01]?\\d|2[0-3])[:.][0-5]\\d(?:\\s*(?:hrs?|hours?))?(?:\\s+${TIMEZONE_PATTERN})?|noon|midnight))(?:\\s+onwards?)?\\b`,
    'gi'
  );

  let stMatch: RegExpExecArray | null;
  while ((stMatch = standaloneTimeRegex.exec(text)) !== null) {
    const startIdx = stMatch.index;
    const endIdx = startIdx + stMatch[0].length;
    if (overlaps(startIdx, endIdx)) continue;

    const timePart = parseTimeString(stMatch[1]);
    if (!timePart) continue;

    markSpan(startIdx, endIdx);
    const { preposition, actionVerb } = findPrecedingCues(startIdx);
    const rawText = stMatch[0].replace(/\s+/g, ' ').trim();
    const isOpenEnded = /\bonwards?\b/i.test(stMatch[0]);

    candidates.push({
      rawText,
      contextSnippet: extractSnippet(text, startIdx, stMatch[0].length).replace(/\s+/g, ' ').trim(),
      dateComponent: null,
      timeComponent: timePart,
      prepositionText: preposition || (stMatch[1].toLowerCase().startsWith('by') ? 'by' : 'at'),
      actionVerbText: actionVerb,
      isRelative: true,
      relativeType: 'today',
      isRange: false,
      isOpenEnded,
      isCommercial: isCommercialText,
    });
  }

  // =========================================================================
  // 7. RELATIVE EXPRESSIONS: "today", "tonight", "tomorrow", "within 24 hours"
  // =========================================================================
  const relativeRegex =
    /\b(today|tonight|tomorrow|yesterday|within\s+(\d+)\s*(?:hours?|hrs?|days?)|by\s+eod|end\s+of\s+day)\b/gi;

  let relMatch: RegExpExecArray | null;
  while ((relMatch = relativeRegex.exec(text)) !== null) {
    const startIdx = relMatch.index;
    const endIdx = startIdx + relMatch[0].length;
    if (overlaps(startIdx, endIdx)) continue;
    markSpan(startIdx, endIdx);

    const matchedStr = relMatch[1].toLowerCase();
    const { preposition, actionVerb } = findPrecedingCues(startIdx);

    let relativeType: IntermediateTemporalCandidate['relativeType'] = 'today';
    let relativeValue: number | undefined;

    if (matchedStr.includes('tomorrow')) {
      relativeType = 'tomorrow';
    } else if (matchedStr.includes('yesterday')) {
      relativeType = 'yesterday';
    } else if (matchedStr.includes('within')) {
      if (matchedStr.includes('hour') || matchedStr.includes('hr')) {
        relativeType = 'within_hours';
        relativeValue = parseInt(relMatch[2], 10) || 24;
      } else {
        relativeType = 'within_days';
        relativeValue = parseInt(relMatch[2], 10) || 1;
      }
    } else {
      relativeType = 'today';
    }

    candidates.push({
      rawText: relMatch[0].replace(/\s+/g, ' ').trim(),
      contextSnippet: extractSnippet(text, startIdx, relMatch[0].length).replace(/\s+/g, ' ').trim(),
      dateComponent: null,
      timeComponent: null,
      prepositionText: preposition,
      actionVerbText: actionVerb,
      isRelative: true,
      relativeType,
      relativeValue,
      isRange: false,
      isOpenEnded: false,
      isCommercial: isCommercialText,
    });
  }

  return candidates;
}

/**
 * Parses individual date substring into ParsedDateComponent.
 */
export function parseDateString(rawDate: string): ParsedDateComponent | null {
  if (!rawDate) return null;
  const cleaned = rawDate.replace(/(?:st|nd|rd|th)/gi, '').replace(/,/g, ' ').replace(/\s+/g, ' ').trim();

  // 1. "16 September 2026" or "16 September" or "16 September 26"
  const ddMonthMatch = new RegExp(`^(\\d{1,2})\\s+(${MONTH_PATTERN})(?:\\s+(\\d{4}|\\d{2}))?$`, 'i').exec(cleaned);
  if (ddMonthMatch) {
    const day = parseInt(ddMonthMatch[1], 10);
    const monthKey = ddMonthMatch[2].toLowerCase().slice(0, 3);
    const month = MONTH_MAP[monthKey] || 1;
    let year = ddMonthMatch[3] ? parseInt(ddMonthMatch[3], 10) : null;
    if (year !== null && year < 100) year += 2000;
    if (day < 1 || day > 31) return null;

    return {
      day,
      month,
      year,
      isExplicitYear: year !== null,
    };
  }

  // 2. "September 16 2026" or "September 16" or "September 16 26"
  const monthDdMatch = new RegExp(`^(${MONTH_PATTERN})\\s+(\\d{1,2})(?:\\s+(\\d{4}|\\d{2}))?$`, 'i').exec(cleaned);
  if (monthDdMatch) {
    const monthKey = monthDdMatch[1].toLowerCase().slice(0, 3);
    const month = MONTH_MAP[monthKey] || 1;
    const day = parseInt(monthDdMatch[2], 10);
    let year = monthDdMatch[3] ? parseInt(monthDdMatch[3], 10) : null;
    if (year !== null && year < 100) year += 2000;
    if (day < 1 || day > 31) return null;

    return {
      day,
      month,
      year,
      isExplicitYear: year !== null,
    };
  }

  // 3. Numeric ISO "YYYY-MM-DD"
  const isoMatch = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(cleaned);
  if (isoMatch) {
    const year = parseInt(isoMatch[1], 10);
    const month = parseInt(isoMatch[2], 10);
    const day = parseInt(isoMatch[3], 10);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return { day, month, year, isExplicitYear: true };
  }

  // 4. Numeric "DD-MM-YYYY", "DD/MM/YYYY", "DD-MM-YY", "DD/MM/YY"
  const dmyMatch = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4}|\d{2})$/.exec(cleaned);
  if (dmyMatch) {
    const part1 = parseInt(dmyMatch[1], 10);
    const part2 = parseInt(dmyMatch[2], 10);
    let year = parseInt(dmyMatch[3], 10);
    if (year < 100) year += 2000;

    // If part1 > 12, it is unambiguously day (DD/MM/YYYY)
    if (part1 > 12 && part2 <= 12) {
      return { day: part1, month: part2, year, isExplicitYear: true };
    }
    // Default to international DD/MM/YYYY
    if (part1 <= 31 && part2 <= 12) {
      return { day: part1, month: part2, year, isExplicitYear: true };
    }
    // Fallback if part2 > 12 (MM/DD/YYYY)
    if (part1 <= 12 && part2 <= 31) {
      return { day: part2, month: part1, year, isExplicitYear: true };
    }
  }

  return null;
}
