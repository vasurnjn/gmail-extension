import { ActionType } from '../../../shared/types';
import {
  DatePrecision,
  ExtractedTemporalEntity,
  IntermediateTemporalCandidate,
  ParsedDateComponent,
  ParsedTimeComponent,
  TemporalAnalysis,
  TemporalConfidence,
  TemporalStatus,
  TemporalType,
  TimePrecision,
} from './types';

/**
 * Checks if two timestamps represent the same calendar day in local user timezone.
 */
function isSameCalendarDay(t1: number, t2: number, timezone?: string): boolean {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || undefined,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
    });
    return formatter.format(new Date(t1)) === formatter.format(new Date(t2));
  } catch {
    const d1 = new Date(t1);
    const d2 = new Date(t2);
    return (
      d1.getFullYear() === d2.getFullYear() &&
      d1.getMonth() === d2.getMonth() &&
      d1.getDate() === d2.getDate()
    );
  }
}

/**
 * Returns the epoch timestamp representing the end of that calendar day (23:59:59.999)
 * for a given base timestamp in the specified timezone (or runtime local timezone if omitted).
 */
export function getEndOfCalendarDay(timestamp: number, timezone?: string): number {
  if (!timezone) {
    const date = new Date(timestamp);
    date.setHours(23, 59, 59, 999);
    return date.getTime();
  }

  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hour12: false,
    });

    const parts = formatter.formatToParts(new Date(timestamp));
    let year = 0, month = 0, day = 0;
    for (const p of parts) {
      if (p.type === 'year') year = parseInt(p.value, 10);
      else if (p.type === 'month') month = parseInt(p.value, 10);
      else if (p.type === 'day') day = parseInt(p.value, 10);
    }

    if (!year || !month || !day) {
      const date = new Date(timestamp);
      date.setHours(23, 59, 59, 999);
      return date.getTime();
    }

    // Target is year-month-day 23:59:59.999 in target timezone.
    // Iteratively adjust UTC timestamp to match target wall-clock time in timezone.
    let guess = Date.UTC(year, month - 1, day, 23, 59, 59, 999);
    for (let i = 0; i < 3; i++) {
      const gParts = formatter.formatToParts(new Date(guess));
      let gYear = 0, gMonth = 0, gDay = 0, gHour = 0, gMinute = 0, gSecond = 0;
      for (const p of gParts) {
        if (p.type === 'year') gYear = parseInt(p.value, 10);
        else if (p.type === 'month') gMonth = parseInt(p.value, 10);
        else if (p.type === 'day') gDay = parseInt(p.value, 10);
        else if (p.type === 'hour') gHour = parseInt(p.value, 10);
        else if (p.type === 'minute') gMinute = parseInt(p.value, 10);
        else if (p.type === 'second') gSecond = parseInt(p.value, 10);
      }

      const diffMs =
        Date.UTC(year, month - 1, day, 23, 59, 59) -
        Date.UTC(gYear, gMonth - 1, gDay, gHour, gMinute, gSecond);

      if (diffMs === 0) break;
      guess += diffMs;
    }

    return guess;
  } catch {
    const date = new Date(timestamp);
    date.setHours(23, 59, 59, 999);
    return date.getTime();
  }
}

/**
 * Evaluates dynamic temporal status relative to referenceTime (defaulting to Date.now()).
 * CRITICAL: Treats date-only events as CALENDAR-DAY events that do not expire until the day ends.
 */
export function evaluateTemporalStatus(
  entity: {
    type: TemporalType;
    timePrecision: TimePrecision;
    timestamp: number | null;
  },
  referenceTime: number = Date.now(),
  timezone?: string
): TemporalStatus {
  if (entity.timestamp === null || isNaN(entity.timestamp)) {
    return 'unresolved';
  }

  const ts = entity.timestamp;

  // For date-only events (timePrecision === 'unknown'), status evaluation treats the entity
  // as an entire CALENDAR-DAY event. Effective cutoff is the end of that day (23:59:59.999).
  const effectiveCutoff =
    entity.type === 'event' && entity.timePrecision === 'unknown'
      ? getEndOfCalendarDay(ts, timezone)
      : ts;

  // If referenceTime is strictly past the cutoff, it is passed
  if (referenceTime > effectiveCutoff) {
    return 'passed';
  }

  // If referenceTime is on the exact same calendar day, it is imminent (happening today)
  if (isSameCalendarDay(ts, referenceTime, timezone)) {
    return 'imminent';
  }

  const diffMs = ts - referenceTime;
  const oneDayMs = 24 * 60 * 60 * 1000;
  const sevenDaysMs = 7 * oneDayMs;

  if (diffMs <= oneDayMs) {
    return 'imminent';
  } else if (diffMs <= sevenDaysMs) {
    return 'upcoming';
  } else {
    return 'distant';
  }
}

/**
 * Conservative year resolution:
 * Resolves year without manufactured guesses.
 */
export function resolveConservativeYear(
  dateComp: ParsedDateComponent,
  emailInternalDate: number,
  contextSnippet: string
): { resolvedYear: number | null; isAmbiguous: boolean; reason?: string } {
  if (dateComp.isExplicitYear && dateComp.year !== null) {
    return { resolvedYear: dateComp.year, isAmbiguous: false };
  }

  const emailDate = new Date(emailInternalDate);
  const emailYear = emailDate.getFullYear();
  const emailMonth = emailDate.getMonth() + 1; // 1-12

  // 1. Target month is current or future month in email's sent year
  if (dateComp.month >= emailMonth) {
    return {
      resolvedYear: emailYear,
      isAmbiguous: false,
      reason: 'Year inferred from email sent year (target month >= email month)',
    };
  }

  // 2. Target month precedes email sent month (e.g. Email received March 5, 2026: "Deadline February 28")
  // Check for explicit contextual confirmation of next year
  const hasExplicitNextYearContext = /\b(next\s+year|upcoming\s+year|next\s+cycle|upcoming\s+batch)\b/i.test(contextSnippet);
  if (hasExplicitNextYearContext) {
    return {
      resolvedYear: emailYear + 1,
      isAmbiguous: false,
      reason: 'Year inferred from explicit contextual next-year phrasing',
    };
  }

  // Otherwise, without explicit year or context, month preceding email sent month is ambiguous
  return {
    resolvedYear: null,
    isAmbiguous: true,
    reason: 'Target month precedes email sent month without explicit year disambiguation; year is ambiguous',
  };
}

/**
 * Converts parsed date & time components into a concrete epoch timestamp.
 * If explicit numeric UTC offset is present, uses UTC offset math.
 * If timezone is provided, constructs timestamp matching target wall-clock time in timezone.
 * Otherwise defaults to runtime local timezone.
 */
export function constructTimestamp(
  dateComp: ParsedDateComponent,
  timeComp: ParsedTimeComponent | null,
  year: number,
  timezone?: string
): number {
  const monthIdx = dateComp.month - 1;
  const day = dateComp.day;
  const hours = timeComp ? timeComp.hours : 0;
  const minutes = timeComp ? timeComp.minutes : 0;
  const seconds = timeComp && timeComp.seconds !== undefined ? timeComp.seconds : 0;

  // 1. If explicit numeric UTC offset is present, construct UTC Date with offset
  if (timeComp && timeComp.timezoneOffsetMinutes !== null && timeComp.timezoneOffsetMinutes !== undefined) {
    const utcMs = Date.UTC(year, monthIdx, day, hours, minutes, seconds);
    // Subtract offset minutes (e.g. +05:30 means local is ahead, so UTC is local - offset)
    return utcMs - timeComp.timezoneOffsetMinutes * 60 * 1000;
  }

  // 2. If target timezone is specified, construct epoch timestamp matching wall-clock time in timezone
  if (timezone) {
    try {
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
        hour12: false,
      });

      let guess = Date.UTC(year, monthIdx, day, hours, minutes, seconds);
      for (let i = 0; i < 3; i++) {
        const gParts = formatter.formatToParts(new Date(guess));
        let gYear = 0, gMonth = 0, gDay = 0, gHour = 0, gMinute = 0, gSecond = 0;
        for (const p of gParts) {
          if (p.type === 'year') gYear = parseInt(p.value, 10);
          else if (p.type === 'month') gMonth = parseInt(p.value, 10);
          else if (p.type === 'day') gDay = parseInt(p.value, 10);
          else if (p.type === 'hour') gHour = parseInt(p.value, 10);
          else if (p.type === 'minute') gMinute = parseInt(p.value, 10);
          else if (p.type === 'second') gSecond = parseInt(p.value, 10);
        }

        const diffMs =
          Date.UTC(year, monthIdx, day, hours, minutes, seconds) -
          Date.UTC(gYear, gMonth - 1, gDay, gHour, gMinute, gSecond);

        if (diffMs === 0) break;
        guess += diffMs;
      }
      return guess;
    } catch {
      // Fallback to local
    }
  }

  // 3. Default to local/runtime timezone
  const localDate = new Date(year, monthIdx, day, hours, minutes, seconds, 0);
  return localDate.getTime();
}

/**
 * Classifies an intermediate temporal candidate into a fully-qualified ExtractedTemporalEntity.
 */
export function resolveTemporalEntity(
  candidate: IntermediateTemporalCandidate,
  index: number,
  emailInternalDate: number,
  referenceTime: number = Date.now(),
  userTimezone?: string
): ExtractedTemporalEntity {
  const evidenceReasons: string[] = [];
  const id = `temp_${index}`;

  const prep = (candidate.prepositionText || '').toLowerCase();
  const verb = (candidate.actionVerbText || '').toLowerCase();
  const rawLower = candidate.rawText.toLowerCase();

  // 1. Determine Semantic Type (Deadline vs Event vs Window vs Relative)
  let type: TemporalType = 'deadline';
  const hasActionVerb =
    Boolean(candidate.actionVerbText && /^(submit|submission|register|registration|apply|application|pay|confirm|upload|complete)$/i.test(candidate.actionVerbText)) ||
    /\b(submit|submission|register|registration|apply|application|pay|rsvp)\b/i.test(candidate.contextSnippet);

  const isEventPrep =
    Boolean(candidate.isOpenEnded) ||
    /\bonwards?\b/i.test(prep) ||
    /\bonwards?\b/i.test(candidate.rawText) ||
    /\bonwards?\b/i.test(candidate.contextSnippet) ||
    /\b(scheduled\s+(?:on|for|at)|held\s+on|taking\s+place\s+on|at\s+\d|starts\s+at)\b/i.test(prep) ||
    /\b(scheduled|held|ppt|interview|meeting|webinar|conference|session|workshop|gathering|event|call)\b/i.test(candidate.contextSnippet) ||
    Boolean(candidate.actionVerbText && /^(interview|meeting|session|webinar|conference|workshop|gathering|event|call|attend|attendance)$/i.test(candidate.actionVerbText));

  const isDeadlinePrep =
    /\b(on\s+or\s+before|by|before|until|till|latest\s+by|no\s+later\s+than|due\s+(?:date|by)?|deadline|closes)\b/i.test(prep) ||
    /\b(deadline|closes|submit|submission|register|registration|apply|application|due|cutoff|last\s+date)\b/i.test(rawLower) ||
    /\b(deadline|closes|due\s+date|last\s+date|cutoff|no\s+later\s+than)\b/i.test(candidate.contextSnippet) ||
    (hasActionVerb && !isEventPrep);

  if (candidate.isRange) {
    type = 'window';
    evidenceReasons.push('Date range expression (from ... to / between ... and)');
  } else if (isDeadlinePrep && !isEventPrep) {
    type = 'deadline';
    evidenceReasons.push(`Deadline cue identified: ${prep ? `preposition '${prep}'` : 'deadline phrasing'}`);
  } else if (isEventPrep && !isDeadlinePrep) {
    type = 'event';
    evidenceReasons.push(`Event cue identified: ${prep ? `preposition '${prep}'` : 'event context'}`);
  } else if (isDeadlinePrep && isEventPrep) {
    if (/\b(by|before|until|till|closes|deadline|due|latest)\b/i.test(prep) || /\b(deadline|closes|due)\b/i.test(candidate.contextSnippet)) {
      type = 'deadline';
      evidenceReasons.push(`Deadline cue takes precedence over event context: preposition '${prep}'`);
    } else {
      type = 'event';
      evidenceReasons.push(`Event cue takes precedence: ${prep ? `preposition '${prep}'` : 'event context'}`);
    }
  } else if (candidate.isRelative) {
    type = 'relative';
    evidenceReasons.push('Relative temporal expression');
  } else {
    type = 'deadline';
    evidenceReasons.push('Defaulted to deadline based on actionable correspondence context');
  }

  // 2. Associated Action Resolution
  let associatedAction: ActionType | null = null;
  if (verb.includes('register') || /\b(?:register|registration|enroll|enrollment|sign[- ]up)\b/i.test(candidate.contextSnippet)) {
    associatedAction = 'register';
  } else if (verb.includes('apply') || /\b(?:apply|application)\b/i.test(candidate.contextSnippet)) {
    associatedAction = 'apply';
  } else if (verb.includes('submit') || verb.includes('upload') || /\b(?:submit|submission|upload)\b/i.test(candidate.contextSnippet)) {
    associatedAction = 'submit';
  } else if (verb.includes('attend') || verb.includes('interview') || verb.includes('meeting') || /\b(?:attend|attendance|ppt|meeting|interview|session|webinar)\b/i.test(candidate.contextSnippet)) {
    associatedAction = 'attend';
  } else if (verb.includes('pay') || /\b(?:pay|payment|fee|invoice|bill)\b/i.test(candidate.contextSnippet)) {
    associatedAction = 'pay';
  } else if (verb.includes('confirm') || /\b(?:confirm|confirmation|rsvp|acceptance)\b/i.test(candidate.contextSnippet)) {
    associatedAction = 'confirm';
  }

  // 3. Date & Time Precision
  let datePrecision: DatePrecision = 'exact';
  let timePrecision: TimePrecision = 'unknown';

  if (candidate.isRelative) {
    datePrecision = 'relative';
  } else if (!candidate.dateComponent) {
    datePrecision = 'unresolved';
  }

  if (candidate.timeComponent && candidate.timeComponent.isExplicitTime) {
    timePrecision = 'exact';
    evidenceReasons.push(`Explicit time specified (${candidate.timeComponent.hours}:${candidate.timeComponent.minutes < 10 ? '0' : ''}${candidate.timeComponent.minutes})`);
  } else if (type === 'deadline') {
    timePrecision = 'inferred';
    evidenceReasons.push('Date-only deadline; cutoff inferred as end of day (23:59:59)');
  } else {
    timePrecision = 'unknown';
    evidenceReasons.push('Date-only event; time is unknown (evaluated at calendar-day level)');
  }

  // 4. Timestamp Resolution (Anchored to internalDate)
  let timestamp: number | null = null;
  let endTimestamp: number | null = null;
  let isAmbiguous = false;
  let confidence: TemporalConfidence = 'HIGH';

  // Handle open-ended events or ranges for endTimestamp
  if (candidate.isOpenEnded || /\bonwards?\b/i.test(candidate.rawText)) {
    endTimestamp = null;
    evidenceReasons.push("Open-ended temporal cue ('onwards') detected; no end time assumed");
  } else if (candidate.isRange && candidate.rangeEndComponent?.date) {
    const endYearResult = resolveConservativeYear(
      candidate.rangeEndComponent.date,
      emailInternalDate,
      candidate.contextSnippet
    );
    if (!endYearResult.isAmbiguous && endYearResult.resolvedYear !== null) {
      const endTimeForConstruction = candidate.rangeEndComponent.time || {
        hours: 23,
        minutes: 59,
        seconds: 59,
        isExplicitTime: false,
      };
      endTimestamp = constructTimestamp(
        candidate.rangeEndComponent.date,
        endTimeForConstruction,
        endYearResult.resolvedYear,
        userTimezone
      );
    }
  }

  // Timezone check
  if (candidate.timeComponent?.timezoneOffsetMinutes !== null && candidate.timeComponent?.timezoneOffsetMinutes !== undefined) {
    evidenceReasons.push(`Explicit numeric timezone offset parsed: ${candidate.timeComponent.timezoneRaw}`);
  } else if (candidate.timeComponent?.isAmbiguousTimezone) {
    isAmbiguous = true;
    confidence = 'MEDIUM';
    evidenceReasons.push(`Unresolved timezone abbreviation '${candidate.timeComponent.timezoneRaw}'; evaluated using local user timezone with ambiguous status`);
  }

  if (candidate.isRelative) {
    const anchorDate = new Date(emailInternalDate);
    const year = anchorDate.getFullYear();
    const month = anchorDate.getMonth();
    const date = anchorDate.getDate();

    let targetDate = date;
    if (candidate.relativeType === 'tomorrow') {
      targetDate = date + 1;
    } else if (candidate.relativeType === 'yesterday') {
      targetDate = date - 1;
    }

    if (candidate.timeComponent && candidate.timeComponent.isExplicitTime) {
      const dateComp: ParsedDateComponent = {
        year,
        month: month + 1,
        day: targetDate,
        isExplicitYear: true,
      };
      timestamp = constructTimestamp(dateComp, candidate.timeComponent, year, userTimezone);
      evidenceReasons.push(`Resolved explicit time '${candidate.rawText}' on ${candidate.relativeType || 'email sent date'}`);
    } else if (candidate.relativeType === 'today') {
      const eod = new Date(year, month, date, 23, 59, 59, 999);
      timestamp = eod.getTime();
      evidenceReasons.push('Resolved "today" relative to email sent date');
    } else if (candidate.relativeType === 'tomorrow') {
      const eodTomorrow = new Date(year, month, date + 1, 23, 59, 59, 999);
      timestamp = eodTomorrow.getTime();
      evidenceReasons.push('Resolved "tomorrow" statically to day after email sent date');
    } else if (candidate.relativeType === 'yesterday') {
      const eodYesterday = new Date(year, month, date - 1, 23, 59, 59, 999);
      timestamp = eodYesterday.getTime();
      evidenceReasons.push('Resolved "yesterday" statically relative to email sent date');
    } else if (candidate.relativeType === 'within_hours' && candidate.relativeValue) {
      timestamp = emailInternalDate + candidate.relativeValue * 60 * 60 * 1000;
      evidenceReasons.push(`Resolved "within ${candidate.relativeValue} hours" relative to email sent timestamp`);
    } else if (candidate.relativeType === 'within_days' && candidate.relativeValue) {
      timestamp = emailInternalDate + candidate.relativeValue * 24 * 60 * 60 * 1000;
      evidenceReasons.push(`Resolved "within ${candidate.relativeValue} days" relative to email sent timestamp`);
    }
  } else if (candidate.dateComponent) {
    const yearResult = resolveConservativeYear(
      candidate.dateComponent,
      emailInternalDate,
      candidate.contextSnippet
    );

    if (yearResult.isAmbiguous || yearResult.resolvedYear === null) {
      isAmbiguous = true;
      confidence = 'LOW';
      datePrecision = 'unresolved';
      timestamp = null;
      evidenceReasons.push(yearResult.reason || 'Year could not be safely resolved');
    } else {
      let timeForConstruction = candidate.timeComponent;
      if (!timeForConstruction && type === 'deadline') {
        timeForConstruction = { hours: 23, minutes: 59, seconds: 59, isExplicitTime: false };
      } else if (!timeForConstruction && type === 'event') {
        timeForConstruction = { hours: 0, minutes: 0, seconds: 0, isExplicitTime: false };
      }

      timestamp = constructTimestamp(
        candidate.dateComponent,
        timeForConstruction,
        yearResult.resolvedYear,
        userTimezone
      );
      if (yearResult.reason) evidenceReasons.push(yearResult.reason);
    }
  }

  // 5. Evaluate Current Status against referenceTime (Calendar-Day semantics enforced)
  const status = evaluateTemporalStatus(
    { type, timePrecision, timestamp },
    referenceTime,
    userTimezone
  );

  return {
    id,
    rawText: candidate.rawText,
    type,
    status,
    timestamp,
    endTimestamp,
    datePrecision,
    timePrecision,
    isAmbiguous,
    associatedAction,
    associatedVerbText: candidate.actionVerbText,
    contextSnippet: candidate.contextSnippet,
    confidence,
    evidenceReasons,
  };
}

/**
 * Semantically deduplicates temporal entities.
 * Merges entities that share the same timestamp, type, endTimestamp, and compatible associatedAction.
 * Normalizes raw text, combines evidence reasons, and re-indexes IDs sequentially.
 */
export function deduplicateTemporalEntities(
  entities: ExtractedTemporalEntity[]
): ExtractedTemporalEntity[] {
  const deduplicated: ExtractedTemporalEntity[] = [];

  for (const entity of entities) {
    const matchIndex = deduplicated.findIndex(existing => {
      // 1. If timestamps are both non-null, they must match
      if (existing.timestamp !== null && entity.timestamp !== null) {
        if (existing.timestamp !== entity.timestamp) return false;
      } else if (existing.timestamp !== entity.timestamp) {
        return false;
      } else {
        // Both timestamps are null (unresolved) -> check rawText equality
        if (existing.rawText.toLowerCase() !== entity.rawText.toLowerCase()) {
          return false;
        }
      }

      // 2. Type must match
      if (existing.type !== entity.type) return false;

      // 3. endTimestamp must match
      const existingEnd = existing.endTimestamp ?? null;
      const entityEnd = entity.endTimestamp ?? null;
      if (existingEnd !== entityEnd) return false;

      // 4. Action must be compatible (same action or at least one is null)
      if (
        existing.associatedAction !== null &&
        entity.associatedAction !== null &&
        existing.associatedAction !== entity.associatedAction
      ) {
        return false;
      }

      return true;
    });

    if (matchIndex === -1) {
      deduplicated.push({ ...entity });
    } else {
      const existing = deduplicated[matchIndex];

      // Prefer non-null action
      if (!existing.associatedAction && entity.associatedAction) {
        existing.associatedAction = entity.associatedAction;
      }
      if (!existing.associatedVerbText && entity.associatedVerbText) {
        existing.associatedVerbText = entity.associatedVerbText;
      }

      // Prefer cleaner rawText (no newlines)
      if (existing.rawText.includes('\n') && !entity.rawText.includes('\n')) {
        existing.rawText = entity.rawText;
      }

      // Prefer exact precision over inferred/unknown
      if (existing.timePrecision !== 'exact' && entity.timePrecision === 'exact') {
        existing.timePrecision = 'exact';
      }
      if (existing.datePrecision !== 'exact' && entity.datePrecision === 'exact') {
        existing.datePrecision = 'exact';
      }

      // Merge confidence (prefer HIGH over MEDIUM over LOW)
      if (entity.confidence === 'HIGH' || (entity.confidence === 'MEDIUM' && existing.confidence === 'LOW')) {
        existing.confidence = entity.confidence;
      }

      // Merge ambiguity
      existing.isAmbiguous = existing.isAmbiguous || entity.isAmbiguous;

      // Merge evidence reasons
      existing.evidenceReasons = Array.from(
        new Set([...existing.evidenceReasons, ...entity.evidenceReasons])
      );
    }
  }

  // Re-index IDs sequentially
  return deduplicated.map((e, idx) => ({
    ...e,
    id: `temp_${idx}`,
  }));
}

/**
 * Builds the composite TemporalAnalysis output from all resolved entities.
 */
export function buildTemporalAnalysis(
  entities: ExtractedTemporalEntity[],
  referenceTime: number = Date.now()
): TemporalAnalysis {
  if (entities.length === 0) {
    return {
      entities: [],
      primaryDeadline: null,
      primaryEvent: null,
      hasActiveDeadline: false,
      isOverdue: false,
      hasAmbiguousDates: false,
      temporalUrgencyTier: 'none',
      summaryReason: 'No temporal cues or dates detected',
    };
  }

  // Sort deadlines: active first, then closest timestamp
  const deadlines = entities.filter(e => e.type === 'deadline' && e.timestamp !== null);
  const activeDeadlines = deadlines.filter(e => e.status !== 'passed');
  activeDeadlines.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

  const primaryDeadline = activeDeadlines[0] || deadlines[0] || null;

  // Sort events: active first, then closest timestamp
  const events = entities.filter(e => e.type === 'event' && e.timestamp !== null);
  const activeEvents = events.filter(e => e.status !== 'passed');
  activeEvents.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

  const primaryEvent = activeEvents[0] || events[0] || null;

  const hasActiveDeadline = activeDeadlines.length > 0;
  const isOverdue = deadlines.length > 0 && !hasActiveDeadline;
  const hasAmbiguousDates = entities.some(e => e.isAmbiguous || e.status === 'unresolved');

  // Determine temporal urgency tier based on active deadlines/events
  let temporalUrgencyTier: TemporalAnalysis['temporalUrgencyTier'] = 'none';
  if (entities.some(e => (e.status === 'imminent') && e.type !== 'unresolved')) {
    temporalUrgencyTier = 'imminent';
  } else if (entities.some(e => (e.status === 'upcoming') && e.type !== 'unresolved')) {
    temporalUrgencyTier = 'upcoming';
  } else if (entities.some(e => (e.status === 'distant') && e.type !== 'unresolved')) {
    temporalUrgencyTier = 'distant';
  } else if (isOverdue || (entities.every(e => e.status === 'passed'))) {
    temporalUrgencyTier = 'passed';
  }

  let summaryReason = 'Temporal entities evaluated';
  if (primaryDeadline && hasActiveDeadline) {
    summaryReason = `Active deadline: ${primaryDeadline.rawText} (${primaryDeadline.status})`;
  } else if (primaryEvent && primaryEvent.status !== 'passed') {
    summaryReason = `Scheduled event: ${primaryEvent.rawText} (${primaryEvent.status})`;
  } else if (isOverdue) {
    summaryReason = 'Action deadline has passed';
  }

  return {
    entities,
    primaryDeadline,
    primaryEvent,
    hasActiveDeadline,
    isOverdue,
    hasAmbiguousDates,
    temporalUrgencyTier,
    summaryReason,
  };
}
