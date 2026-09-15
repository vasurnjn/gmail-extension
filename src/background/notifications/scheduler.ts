/**
 * Phase 5C: Proximity Reminder & Alarm Scheduling Calculation
 *
 * Core Invariant:
 * Scheduling calculations are pure and deterministic.
 * They NEVER call Chrome APIs (chrome.alarms, chrome.notifications)
 * and NEVER mutate AttentionItems, EmailRecords, or Dexie database tables.
 */

import {
  DatePrecision,
  ExtractedTemporalEntity,
  ScheduledAlarmRecord,
  SubEventRecord,
  TemporalAnalysis,
  TemporalConfidence,
  TimePrecision,
} from '../../shared/types';
import {
  PROXIMITY_STAGE_CONFIGS,
  PROXIMITY_STAGES,
} from './constants';
import {
  ProximityScheduleInput,
  ProximityStage,
  ResolvedTemporalTarget,
  ScheduleCalculationInput,
  SnoozeScheduleInput,
} from './types';

// =========================================================================
// 1. Alarm Naming Conventions & Round-trip Helpers
// =========================================================================

/**
 * Formats a deterministic proximity alarm name.
 * Format: `remind::<attentionItemId>::<stage>` (e.g. `remind::att_101::24h`)
 */
export function formatProximityAlarmName(
  attentionItemId: string,
  stage: ProximityStage
): string {
  return `remind::${attentionItemId}::${stage}`;
}

/**
 * Formats a deterministic snooze alarm name.
 * Format: `snooze::<attentionItemId>::<timestamp>` (e.g. `snooze::att_101::1726500000000`)
 */
export function formatSnoozeAlarmName(
  attentionItemId: string,
  snoozeUntil: number
): string {
  return `snooze::${attentionItemId}::${snoozeUntil}`;
}

/**
 * Parses an alarm name into its constituent parts.
 */
export function parseAlarmName(alarmName: string): {
  type: 'remind' | 'snooze' | 'unknown';
  attentionItemId: string | null;
  stage: ProximityStage | null;
  snoozeUntil: number | null;
} {
  const parts = alarmName.split('::');
  if (parts[0] === 'remind' && parts.length === 3) {
    const stage = parts[2] as ProximityStage;
    if (PROXIMITY_STAGES.includes(stage)) {
      return {
        type: 'remind',
        attentionItemId: parts[1],
        stage,
        snoozeUntil: null,
      };
    }
  }
  if (parts[0] === 'snooze' && parts.length === 3) {
    const ts = parseInt(parts[2], 10);
    return {
      type: 'snooze',
      attentionItemId: parts[1],
      stage: null,
      snoozeUntil: isNaN(ts) ? null : ts,
    };
  }
  return {
    type: 'unknown',
    attentionItemId: null,
    stage: null,
    snoozeUntil: null,
  };
}

// =========================================================================
// 2. Physical Venue Detection Helper
// =========================================================================

/**
 * Evaluates whether venue information provides evidence of physical in-person attendance.
 */
export function isPhysicalVenue(
  venue: string | null,
  venueType?: 'physical' | 'virtual' | 'hybrid' | null
): boolean {
  if (venueType === 'physical' || venueType === 'hybrid') {
    return true;
  }
  if (venueType === 'virtual') {
    return false;
  }
  if (!venue || !venue.trim()) {
    return false;
  }

  const v = venue.trim().toLowerCase();

  // If it's a composite or hybrid string (e.g. "SJT 717 / Zoom"), physical attendance is present
  if (
    (v.includes('/') || v.includes(' and ') || v.includes('&')) &&
    (/\b(?:sjt|tt|smv|mb|gd|hall|room|audi|campus|office)\b/i.test(v) ||
      /\b\d{3}\b/.test(v))
  ) {
    return true;
  }

  // Check pure virtual indicators
  const isPureVirtual =
    v === 'online' ||
    v.startsWith('online') ||
    v.includes('zoom') ||
    v.includes('google meet') ||
    v.includes('ms teams') ||
    v.includes('microsoft teams') ||
    v.includes('webex') ||
    v.includes('virtual meeting') ||
    v.includes('virtual session') ||
    v.includes('held online');

  return !isPureVirtual;
}

// =========================================================================
// 3. Temporal Target Resolution
// =========================================================================

/**
 * Resolves the primary temporal target (deadline or event) for proximity reminders.
 *
 * When multiple entities exist:
 * Prioritizes the earliest active cutoff so the user is alerted to the immediate
 * next action, while avoiding duplicate alarms with identical names.
 */
export function resolvePrimaryTemporalTarget(
  input: ProximityScheduleInput
): ResolvedTemporalTarget | null {
  const {
    item,
    email,
    temporalAnalysis: directAnalysis,
    temporalEntity: directEntity,
    referenceTime = Date.now(),
    venueType: directVenueType,
  } = input;

  // 1. If an explicit temporalEntity was injected, use it directly
  if (directEntity && directEntity.timestamp !== null) {
    const venue = item.currentState.venue ?? null;
    const venueType = directVenueType ?? (isPhysicalVenue(venue) ? 'physical' : null);
    return {
      targetTimestamp: directEntity.timestamp,
      targetType: directEntity.type === 'deadline' ? 'deadline' : 'event',
      timePrecision: directEntity.timePrecision,
      datePrecision: directEntity.datePrecision,
      isAmbiguous: directEntity.isAmbiguous,
      confidence: directEntity.confidence,
      label: directEntity.rawText || (directEntity.type === 'deadline' ? 'Deadline' : 'Event'),
      venue,
      venueType,
    };
  }

  // 2. If TemporalAnalysis is available (from direct input or email)
  const analysis: TemporalAnalysis | null =
    directAnalysis || email?.temporalAnalysis || null;

  if (analysis) {
    const deadline = analysis.primaryDeadline;
    const event = analysis.primaryEvent;

    const isDeadlineActive =
      deadline !== null &&
      deadline.timestamp !== null &&
      deadline.timestamp > referenceTime &&
      deadline.status !== 'passed';

    const isEventActive =
      event !== null &&
      event.timestamp !== null &&
      event.timestamp > referenceTime &&
      event.status !== 'passed';

    // If both are active, choose the earlier cutoff
    if (isDeadlineActive && isEventActive) {
      const chosen =
        deadline!.timestamp! <= event!.timestamp! ? deadline! : event!;
      const venue = item.currentState.venue ?? null;
      const venueType = directVenueType ?? (isPhysicalVenue(venue) ? 'physical' : null);
      return {
        targetTimestamp: chosen.timestamp!,
        targetType: chosen.type === 'deadline' ? 'deadline' : 'event',
        timePrecision: chosen.timePrecision,
        datePrecision: chosen.datePrecision,
        isAmbiguous: chosen.isAmbiguous,
        confidence: chosen.confidence,
        label: chosen.rawText || (chosen.type === 'deadline' ? 'Deadline' : 'Event'),
        venue,
        venueType,
      };
    }

    if (isDeadlineActive) {
      const venue = item.currentState.venue ?? null;
      const venueType = directVenueType ?? (isPhysicalVenue(venue) ? 'physical' : null);
      return {
        targetTimestamp: deadline!.timestamp!,
        targetType: 'deadline',
        timePrecision: deadline!.timePrecision,
        datePrecision: deadline!.datePrecision,
        isAmbiguous: deadline!.isAmbiguous,
        confidence: deadline!.confidence,
        label: deadline!.rawText || 'Registration Deadline',
        venue,
        venueType,
      };
    }

    if (isEventActive) {
      const venue = item.currentState.venue ?? null;
      const venueType = directVenueType ?? (isPhysicalVenue(venue) ? 'physical' : null);
      return {
        targetTimestamp: event!.timestamp!,
        targetType: 'event',
        timePrecision: event!.timePrecision,
        datePrecision: event!.datePrecision,
        isAmbiguous: event!.isAmbiguous,
        confidence: event!.confidence,
        label: event!.rawText || 'Scheduled Event',
        venue,
        venueType,
      };
    }

    // If both exist but have passed relative to referenceTime, return null
    if (deadline?.timestamp !== null || event?.timestamp !== null) {
      return null;
    }
  }

  // 3. Fallback to AttentionItem.currentState
  const deadlineTs = item.currentState.primaryDeadlineTimestamp;
  const eventTs = item.currentState.primaryEventTimestamp;

  const isDeadlineActive = deadlineTs !== null && deadlineTs > referenceTime;
  const isEventActive = eventTs !== null && eventTs > referenceTime;

  if (!isDeadlineActive && !isEventActive) {
    return null;
  }

  // Find sub-events matching timestamps to preserve precision
  const subEvents = item.currentState.subEvents || [];
  const findSubEvent = (ts: number, type: 'deadline' | 'event') =>
    subEvents.find((s) => s.timestamp === ts) ||
    subEvents.find((s) => s.type === type);

  if (isDeadlineActive && isEventActive) {
    if (deadlineTs! <= eventTs!) {
      const sub = findSubEvent(deadlineTs!, 'deadline');
      const venue = sub?.venue ?? item.currentState.venue;
      return {
        targetTimestamp: deadlineTs!,
        targetType: 'deadline',
        timePrecision: sub?.timePrecision ?? 'inferred',
        datePrecision: 'exact',
        isAmbiguous: false,
        confidence: 'HIGH',
        label: sub?.label || 'Deadline',
        venue,
        venueType: directVenueType ?? (isPhysicalVenue(venue) ? 'physical' : null),
      };
    } else {
      const sub = findSubEvent(eventTs!, 'event');
      const venue = sub?.venue ?? item.currentState.venue;
      return {
        targetTimestamp: eventTs!,
        targetType: 'event',
        timePrecision: sub?.timePrecision ?? 'exact',
        datePrecision: 'exact',
        isAmbiguous: false,
        confidence: 'HIGH',
        label: sub?.label || 'Event',
        venue,
        venueType: directVenueType ?? (isPhysicalVenue(venue) ? 'physical' : null),
      };
    }
  }

  if (isDeadlineActive) {
    const sub = findSubEvent(deadlineTs!, 'deadline');
    const venue = sub?.venue ?? item.currentState.venue;
    return {
      targetTimestamp: deadlineTs!,
      targetType: 'deadline',
      timePrecision: sub?.timePrecision ?? 'inferred',
      datePrecision: 'exact',
      isAmbiguous: false,
      confidence: 'HIGH',
      label: sub?.label || 'Deadline',
      venue,
      venueType: directVenueType ?? (isPhysicalVenue(venue) ? 'physical' : null),
    };
  }

  // isEventActive
  const sub = findSubEvent(eventTs!, 'event');
  const venue = sub?.venue ?? item.currentState.venue;
  return {
    targetTimestamp: eventTs!,
    targetType: 'event',
    timePrecision: sub?.timePrecision ?? 'exact',
    datePrecision: 'exact',
    isAmbiguous: false,
    confidence: 'HIGH',
    label: sub?.label || 'Event',
    venue,
    venueType: directVenueType ?? (isPhysicalVenue(venue) ? 'physical' : null),
  };
}

/**
 * Resolves active physical event target specifically for the 30-minute reminder stage.
 * Used when the primary temporal target is an online deadline, but an in-person event also exists.
 */
export function resolvePhysicalEventTarget(
  input: ProximityScheduleInput
): ResolvedTemporalTarget | null {
  const {
    item,
    email,
    temporalAnalysis: directAnalysis,
    referenceTime = Date.now(),
    venueType: directVenueType,
  } = input;

  const analysis = directAnalysis || email?.temporalAnalysis || null;

  // Check analysis primaryEvent
  if (analysis?.primaryEvent) {
    const e = analysis.primaryEvent;
    if (
      typeof e.timestamp === 'number' &&
      e.timestamp > referenceTime &&
      e.status !== 'passed'
    ) {
      const venue = item.currentState.venue ?? null;
      const venueType = directVenueType ?? (isPhysicalVenue(venue) ? 'physical' : null);
      return {
        targetTimestamp: e.timestamp,
        targetType: 'event',
        timePrecision: e.timePrecision,
        datePrecision: e.datePrecision,
        isAmbiguous: e.isAmbiguous,
        confidence: e.confidence,
        label: e.rawText || 'Scheduled Event',
        venue,
        venueType,
      };
    }
  }

  // Check currentState.primaryEventTimestamp
  const eventTs = item.currentState.primaryEventTimestamp;
  if (eventTs !== null && eventTs > referenceTime) {
    const sub = (item.currentState.subEvents || []).find(
      (s) => s.timestamp === eventTs && s.type === 'event'
    );
    const venue = sub?.venue ?? item.currentState.venue;
    return {
      targetTimestamp: eventTs,
      targetType: 'event',
      timePrecision: sub?.timePrecision ?? 'exact',
      datePrecision: 'exact',
      isAmbiguous: false,
      confidence: 'HIGH',
      label: sub?.label || 'Event',
      venue,
      venueType: directVenueType ?? (isPhysicalVenue(venue) ? 'physical' : null),
    };
  }

  return null;
}

// =========================================================================
// 4. Pure Proximity Alarms Calculation
// =========================================================================

/**
 * Calculates deterministic proximity alarm configurations for an AttentionItem.
 *
 * Requirements enforced:
 * 1. Reminder timestamps calculated from primary event/deadline timestamps.
 * 2. Does not invent exact event time when timePrecision === 'unknown'.
 * 3. Respects datePrecision, timePrecision, isAmbiguous, and temporal confidence.
 * 4. Suppresses rigid proximity reminders for ambiguous or LOW-confidence temporal entities.
 * 5. Does not schedule reminders for passed temporal events.
 * 6. Does not schedule reminders for cancelled/completed/unknown lifecycle states.
 * 7. Does not schedule reminders for handled or dismissed items.
 * 8. Snoozed items defer notifications until snoozeUntil.
 * 9. The 30-minute stage requires: exact event timing, physical attendance, actionable event,
 *    sufficient temporal confidence, and unhandled state.
 * 10. Preserves deadline vs event semantics in purpose strings.
 * 11. Prevents duplicate reminders when multiple temporal entities exist.
 * 12. Suppresses stages whose scheduled time has already passed.
 * 13. Returns deterministic ScheduledAlarmRecord objects.
 * 14. Uses stable `remind::<attentionItemId>::<stage>` naming.
 * 15. Pure calculation without Chrome API calls or database mutations.
 */
export function calculateProximityAlarms(
  input: ProximityScheduleInput
): ScheduledAlarmRecord[] {
  const { item, referenceTime = Date.now() } = input;

  // Requirement 6: Lifecycle state check
  // Never schedule reminders for cancelled, completed, or unknown lifecycle states
  if (
    item.itemLifecycleState !== 'active' ||
    item.currentState.itemLifecycleState !== 'active'
  ) {
    return [];
  }

  // Requirement 7: User attention state check
  // Suppress reminders for handled or dismissed items
  if (
    item.userAttentionState === 'handled' ||
    item.userAttentionState === 'dismissed'
  ) {
    return [];
  }

  // Resolve primary target
  const primaryTarget = resolvePrimaryTemporalTarget(input);
  if (!primaryTarget) {
    return [];
  }

  // Requirement 5: Do not schedule reminders for passed temporal events
  if (primaryTarget.targetTimestamp <= referenceTime) {
    return [];
  }

  // Requirement 3 & 4: Suppress rigid proximity reminders for ambiguous or LOW-confidence temporal info
  if (
    primaryTarget.isAmbiguous ||
    primaryTarget.confidence === 'LOW' ||
    primaryTarget.datePrecision === 'unresolved'
  ) {
    return [];
  }

  // Requirement 8: Snooze deferral timestamp
  const effectiveSnoozeUntil =
    input.snoozeUntil ??
    input.email?.snoozeUntil ??
    null;

  const alarms: ScheduledAlarmRecord[] = [];

  for (const stage of PROXIMITY_STAGES) {
    const config = PROXIMITY_STAGE_CONFIGS[stage];

    // Determine target entity for this stage
    // For 30m, if primaryTarget is not an in-person event, check if a separate physical event exists
    let stageTarget = primaryTarget;
    if (stage === '30m' && stageTarget.targetType !== 'event') {
      const physicalEvent = resolvePhysicalEventTarget(input);
      if (physicalEvent) {
        stageTarget = physicalEvent;
      } else {
        // No physical event available for 30m stage
        continue;
      }
    }

    // Requirement 9: The 30-minute stage strict prerequisites:
    // - exact event timing
    // - physical-attendance evidence
    // - actionable event
    // - sufficient temporal confidence
    // - unhandled state
    if (stage === '30m') {
      const isActionable =
        item.currentState.actionRequired || input.email?.actionRequired === true;
      const isPhysical = isPhysicalVenue(stageTarget.venue, stageTarget.venueType);
      const isExactTime = stageTarget.timePrecision === 'exact';
      const isConfident =
        stageTarget.confidence !== 'LOW' && !stageTarget.isAmbiguous;
      const isUnhandled = item.userAttentionState === 'unhandled';

      if (
        stageTarget.targetType !== 'event' ||
        !isExactTime ||
        !isPhysical ||
        !isActionable ||
        !isConfident ||
        !isUnhandled
      ) {
        continue;
      }
    }

    // Requirement 2: Do not invent exact event time when timePrecision === 'unknown'
    // For events, 3h stage requires known time (cannot guess intra-day 3 hours before unknown time)
    if (
      stage === '3h' &&
      stageTarget.targetType === 'event' &&
      stageTarget.timePrecision === 'unknown'
    ) {
      continue;
    }

    // Calculate scheduled time
    const scheduledAt = stageTarget.targetTimestamp - config.offsetMs;

    // Requirement 12: Do not create reminders for stages whose scheduled time has already passed
    if (scheduledAt <= referenceTime) {
      continue;
    }

    // Requirement 8: Snoozed items must defer notification until snoozeUntil
    if (
      item.userAttentionState === 'snoozed' &&
      effectiveSnoozeUntil !== null &&
      scheduledAt <= effectiveSnoozeUntil
    ) {
      continue;
    }

    // Requirement 10: Preserve distinction between deadline and event semantics in purpose
    const purpose =
      stageTarget.targetType === 'deadline'
        ? `Proximity reminder (${stage} before deadline: ${stageTarget.label})`
        : `Proximity reminder (${stage} before event: ${stageTarget.label}${
            stageTarget.venue ? ' at ' + stageTarget.venue : ''
          })`;

    alarms.push({
      alarmName: formatProximityAlarmName(item.id, stage),
      attentionItemId: item.id,
      emailId: input.email?.id ?? item.latestEmailId ?? null,
      alarmType: 'proximity',
      scheduledAt,
      purpose,
      stage,
      createdAt: referenceTime,
    });
  }

  // Sort chronologically ascending
  return alarms.sort((a, b) => a.scheduledAt - b.scheduledAt);
}

// =========================================================================
// 5. Pure Snooze Alarm Calculation
// =========================================================================

/**
 * Calculates a deterministic snooze expiration alarm.
 */
export function calculateSnoozeAlarm(
  input: SnoozeScheduleInput
): ScheduledAlarmRecord | null {
  const { item, snoozeUntil, referenceTime = Date.now(), emailId } = input;

  // Cannot schedule snooze alarm for inactive items
  if (
    item.itemLifecycleState !== 'active' ||
    item.currentState.itemLifecycleState !== 'active'
  ) {
    return null;
  }

  // If snooze time has already passed relative to referenceTime, do not schedule
  if (snoozeUntil <= referenceTime) {
    return null;
  }

  return {
    alarmName: formatSnoozeAlarmName(item.id, snoozeUntil),
    attentionItemId: item.id,
    emailId: emailId ?? item.latestEmailId ?? null,
    alarmType: 'snooze',
    scheduledAt: snoozeUntil,
    purpose: `Snooze expiration alarm for attention item '${
      item.canonicalEntity ?? item.id
    }'`,
    stage: 'snooze',
    createdAt: referenceTime,
  };
}

// =========================================================================
// 6. Composite Alarm Calculation
// =========================================================================

/**
 * Calculates all applicable alarms (proximity and snooze expiration) for an AttentionItem.
 */
export function calculateItemAlarms(
  input: ScheduleCalculationInput
): ScheduledAlarmRecord[] {
  const alarms: ScheduledAlarmRecord[] = [];

  // 1. Proximity alarms
  const proximityAlarms = calculateProximityAlarms(input);
  alarms.push(...proximityAlarms);

  // 2. Snooze alarm if item is snoozed
  const effectiveSnoozeUntil =
    input.snoozeUntil ??
    input.email?.snoozeUntil ??
    null;

  if (input.item.userAttentionState === 'snoozed' && effectiveSnoozeUntil !== null) {
    const snoozeAlarm = calculateSnoozeAlarm({
      item: input.item,
      snoozeUntil: effectiveSnoozeUntil,
      referenceTime: input.referenceTime,
      emailId: input.email?.id,
    });
    if (snoozeAlarm) {
      alarms.push(snoozeAlarm);
    }
  }

  return alarms.sort((a, b) => a.scheduledAt - b.scheduledAt);
}
