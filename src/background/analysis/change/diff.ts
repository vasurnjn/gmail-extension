import {
  AttentionItem,
  EmailRecord,
  FieldDelta,
  ItemLifecycleState,
  StateDiffResult,
  SubEventRecord,
} from '../../../shared/types';
import { canonicalizeEntity, isTopicCompatible } from './identity';
import { InvariantExtractionOutput } from './types';

/**
 * Returns formatted UTC calendar day string "YYYY-MM-DD" from epoch ms timestamp.
 */
export function getCalendarDay(timestamp: number | null): string | null {
  if (timestamp === null || isNaN(timestamp)) return null;
  const d = new Date(timestamp);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Detects explicit cancellation or removal phrasing targeting a venue.
 */
export function isExplicitVenueRemoval(text: string): boolean {
  if (!text) return false;
  return /\b(?:venue\s+(?:has\s+been\s+)?(?:removed|cancelled|canceled)|no\s+longer\s+at|there\s+will\s+be\s+no\s+physical\s+venue|physical\s+venue\s+cancelled|physical\s+venue\s+canceled|event\s+is\s+fully\s+virtual|held\s+online\s+instead)\b/i.test(
    text
  );
}

/**
 * Detects explicit revision/supersession cues (distinguishes updates from unverified conflicts).
 */
export function hasRevisionCue(text: string): boolean {
  if (!text) return false;
  return /\b(?:updated|revised|changed|shifted|instead\s+of|corrected|moved\s+to|rescheduled|new\s+venue|new\s+time|new\s+date|reschedule)\b/i.test(
    text
  );
}

/**
 * Detects explicit lifecycle transition language (cancelled, postponed, completed).
 */
export function detectLifecycleTransition(text: string): ItemLifecycleState | null {
  if (!text) return null;
  if (
    /\b(?:event\s+(?:is|has\s+been)\s+(?:cancelled|canceled)|(?:has\s+been\s+|is\s+|hereby\s+)?(?:cancelled|canceled)|called\s+off)\b/i.test(
      text
    )
  ) {
    return 'cancelled';
  }
  if (
    /\b(?:event\s+(?:is|has\s+been)\s+postponed|(?:has\s+been\s+|is\s+)?postponed(?:\s+until)?|deferred|delayed|held\s+in\s+abeyance)\b/i.test(
      text
    )
  ) {
    return 'postponed';
  }
  if (
    /\b(?:successfully\s+completed|concluded|thank\s+you\s+for\s+attending|event\s+has\s+ended)\b/i.test(
      text
    )
  ) {
    return 'completed';
  }
  return null;
}

/**
 * Detects factual action requirement additions (e.g. bring hall ticket, carry resume).
 * Tone escalation alone ("URGENT", "FINAL NOTICE") does NOT count as a factual action requirement.
 */
export function detectNewActionRequirements(text: string): string[] {
  if (!text) return [];
  const reqs: string[] = [];
  if (/\b(?:bring\s+(?:your\s+)?hall\s*ticket|carry\s+(?:your\s+)?hall\s*ticket|must\s+bring\s+hall\s*ticket)\b/i.test(text)) {
    reqs.push('bring hall ticket');
  }
  if (/\b(?:bring\s+(?:your\s+)?resume|carry\s+(?:your\s+)?resume|bring\s+cv|submit\s+resume)\b/i.test(text)) {
    reqs.push('bring resume');
  }
  if (/\b(?:bring\s+(?:your\s+)?laptop|carry\s+laptop)\b/i.test(text)) {
    reqs.push('bring laptop');
  }
  if (/\b(?:bring\s+(?:your\s+)?id\s+card|carry\s+college\s+id)\b/i.test(text)) {
    reqs.push('bring id card');
  }
  return reqs;
}

/**
 * Constructs structured SubEventRecords from email temporal entities.
 */
export function buildSubEventsFromEmail(
  record: EmailRecord,
  invariants: InvariantExtractionOutput
): SubEventRecord[] {
  const entities = record.temporalAnalysis?.entities || [];
  const subEvents: SubEventRecord[] = [];
  const seenRoles = new Map<string, number>();

  for (const e of entities) {
    if (e.timestamp === null) continue;

    const text = `${e.contextSnippet || ''} ${e.rawText || ''}`.toLowerCase();
    let label = 'Event';
    let role = 'event';

    if (/\b(?:ppt|presentation|pre[- ]placement)\b/i.test(text)) {
      label = 'PPT';
      role = 'ppt';
    } else if (
      /\b(?:interview|gd|group\s+discussion|personal\s+interview|pi|technical\s+round|interviews)\b/i.test(
        text
      )
    ) {
      label = 'Interview';
      role = 'interview';
    } else if (/\b(?:assessment|test|exam|online\s+test|coding\s+round|quiz)\b/i.test(text)) {
      label = 'Assessment';
      role = 'assessment';
    } else if (/\b(?:register|apply|submission|submit|deadline|cutoff)\b/i.test(text)) {
      label = 'Registration Deadline';
      role = 'deadline';
    } else if (e.type === 'deadline') {
      label = 'Deadline';
      role = 'deadline';
    }

    const count = seenRoles.get(role) || 0;
    seenRoles.set(role, count + 1);
    const subEventId = count === 0 ? `sub_${role}` : `sub_${role}_${count + 1}`;

    subEvents.push({
      subEventId,
      label,
      type: e.type === 'deadline' ? 'deadline' : e.type === 'window' ? 'window' : 'event',
      timestamp: e.timestamp,
      endTimestamp: e.endTimestamp || null,
      timePrecision: e.timePrecision,
      venue: invariants.venue,
      status: 'active',
    });
  }

  return subEvents;
}

/**
 * Matches and diffs sub-events between existing AttentionItemState and an incoming email.
 * Order-independent matching: matches by semantic role / label / action, NEVER by array index.
 * Omission rule: Absence from later email is NOT deletion.
 */
export function diffSubEvents(
  oldSubEvents: SubEventRecord[],
  newSubEvents: SubEventRecord[],
  emailText: string,
  primaryEventTimestamp?: number | null
): FieldDelta[] {
  const deltas: FieldDelta[] = [];
  const matchedOldIds = new Set<string>();

  for (const newSub of newSubEvents) {
    // 1. Semantic matching to existing sub-events (order-independent)
    const matchingOld = oldSubEvents.find(
      (old) =>
        old.subEventId === newSub.subEventId ||
        old.label.toLowerCase() === newSub.label.toLowerCase() ||
        (old.type === newSub.type &&
          old.subEventId.split('_')[1] &&
          old.subEventId.split('_')[1] === newSub.subEventId.split('_')[1])
    );

    if (matchingOld) {
      matchedOldIds.add(matchingOld.subEventId);

      // Low-confidence safeguard: do NOT overwrite verified exact state
      const isNewLowConfidence =
        (newSub as any).confidence === 'LOW' || (newSub as any).isAmbiguous;
      if (
        isNewLowConfidence &&
        matchingOld.timestamp !== null &&
        matchingOld.timePrecision === 'exact'
      ) {
        continue;
      }

      // Compare timestamps
      const isOldDateOnly = matchingOld.timePrecision === 'unknown';
      const isNewDateOnly = newSub.timePrecision === 'unknown';

      if (isNewDateOnly) {
        // New email has date-only (time not specified):
        // If calendar day is the same, time omission in a reminder is NOT a change!
        if (getCalendarDay(matchingOld.timestamp) !== getCalendarDay(newSub.timestamp)) {
          deltas.push({
            field: 'subEvent',
            subEventId: matchingOld.subEventId,
            changeType: 'updated',
            oldValue: matchingOld.timestamp,
            newValue: newSub.timestamp,
            description: `Sub-event '${matchingOld.label}' rescheduled from ${getCalendarDay(matchingOld.timestamp)} to ${getCalendarDay(newSub.timestamp)}`,
          });
        }
      } else if (isOldDateOnly && !isNewDateOnly) {
        // Time was specified on previously date-only event
        if (getCalendarDay(matchingOld.timestamp) !== getCalendarDay(newSub.timestamp)) {
          deltas.push({
            field: 'subEvent',
            subEventId: matchingOld.subEventId,
            changeType: 'updated',
            oldValue: matchingOld.timestamp,
            newValue: newSub.timestamp,
            description: `Sub-event '${matchingOld.label}' rescheduled from ${getCalendarDay(matchingOld.timestamp)} to ${getCalendarDay(newSub.timestamp)}`,
          });
        }
      } else if (matchingOld.timestamp !== newSub.timestamp) {
        deltas.push({
          field: 'subEvent',
          subEventId: matchingOld.subEventId,
          changeType: 'updated',
          oldValue: matchingOld.timestamp,
          newValue: newSub.timestamp,
          description: `Sub-event '${matchingOld.label}' timestamp shifted`,
        });
      }

      // Compare venue if both non-null
      if (
        matchingOld.venue &&
        newSub.venue &&
        matchingOld.venue.trim().toLowerCase() !== newSub.venue.trim().toLowerCase()
      ) {
        deltas.push({
          field: 'subEvent',
          subEventId: matchingOld.subEventId,
          changeType: hasRevisionCue(emailText) ? 'updated' : 'conflict',
          oldValue: matchingOld.venue,
          newValue: newSub.venue,
          description: `Sub-event '${matchingOld.label}' venue differs: '${matchingOld.venue}' vs '${newSub.venue}'`,
        });
      }

      // Compare status
      if (matchingOld.status !== newSub.status) {
        deltas.push({
          field: 'subEvent',
          subEventId: matchingOld.subEventId,
          changeType: 'updated',
          oldValue: matchingOld.status,
          newValue: newSub.status,
          description: `Sub-event '${matchingOld.label}' status changed to '${newSub.status}'`,
        });
      }
    } else {
      // If oldSubEvents is empty, check if newSub matches the existing primaryEventTimestamp
      if (
        oldSubEvents.length === 0 &&
        primaryEventTimestamp !== null &&
        primaryEventTimestamp !== undefined &&
        getCalendarDay(newSub.timestamp) === getCalendarDay(primaryEventTimestamp)
      ) {
        // Matches primary event; not an additional sub-event
        continue;
      }

      // New Sub-Event Addition
      deltas.push({
        field: 'subEvent',
        subEventId: newSub.subEventId,
        changeType: 'added',
        oldValue: null,
        newValue: newSub,
        description: `New sub-event '${newSub.label}' added`,
      });
    }
  }

  // Check unmatched old sub-events
  for (const old of oldSubEvents) {
    if (!matchedOldIds.has(old.subEventId)) {
      // OMISSION RULE: Absence in email is NOT deletion
      // Only emit removal if explicit cancellation language targets this sub-event
      const explicitSubEventRemovalRegex = new RegExp(
        `\\b(?:${old.label}|${old.subEventId.replace('sub_', '')})\\s+(?:has\\s+been\\s+)?(?:cancelled|canceled|called\\s+off)\\b`,
        'i'
      );
      if (explicitSubEventRemovalRegex.test(emailText)) {
        deltas.push({
          field: 'subEvent',
          subEventId: old.subEventId,
          changeType: 'removed',
          oldValue: old,
          newValue: null,
          description: `Sub-event '${old.label}' explicitly cancelled/removed`,
        });
      }
    }
  }

  return deltas;
}

/**
 * Compares incoming email against candidate AttentionItem and produces factual field deltas.
 *
 * Core Principles:
 * 1. Compare facts, not wording or emotional tone.
 * 2. Omission != Deletion (missing fields retain previously verified truth).
 * 3. Low-confidence observations must not overwrite verified exact timestamps.
 * 4. Date-only events are calendar-day events, not midnight point-in-time shifts.
 * 5. Does NOT assign final relation (NEW/REPEAT/UPDATE/CONFLICT/CANCELLED) -> Phase 4E boundary.
 */
export function diffAttentionItemState(
  email: EmailRecord,
  invariants: InvariantExtractionOutput,
  item: AttentionItem
): StateDiffResult {
  const deltas: FieldDelta[] = [];
  const unchangedFields: string[] = [];
  const reasons: string[] = [];

  const combinedText = `${email.subject || ''}\n${email.snippet || ''}\n${email.bodyTextPreview || ''}`;

  // 1. Entity Comparison
  const emailEntity = canonicalizeEntity(invariants.canonicalEntity);
  const itemEntity = canonicalizeEntity(item.canonicalEntity);

  if (invariants.entityStatus === 'known' && emailEntity !== null) {
    if (item.entityStatus === 'known' && itemEntity !== null) {
      if (emailEntity !== itemEntity) {
        deltas.push({
          field: 'entity',
          changeType: 'updated',
          oldValue: item.canonicalEntity,
          newValue: invariants.canonicalEntity,
          description: `Entity changed from '${item.canonicalEntity}' to '${invariants.canonicalEntity}'`,
        });
      } else {
        unchangedFields.push('entity');
      }
    }
  } else {
    // Omission: entity not mentioned or unknown in this email -> retains old entity
    unchangedFields.push('entity');
  }

  // 2. Topic Comparison
  if (invariants.topicStatus === 'ambiguous') {
    if (item.topicStatus === 'known' && item.topicScope) {
      const conflictDescription =
        invariants.conflictingTopics && invariants.conflictingTopics.length > 0
          ? invariants.conflictingTopics.join(' vs ')
          : (invariants.rawTopic || 'ambiguous');
      deltas.push({
        field: 'topic',
        changeType: 'conflict',
        oldValue: item.topicScope,
        newValue: conflictDescription,
        description: `Conflicting topic observation asserted in email (${conflictDescription}) against verified topic '${item.topicScope}' without revision cue`,
      });
    } else {
      unchangedFields.push('topic');
    }
  } else if (invariants.topicStatus === 'known' && invariants.topicScope) {
    if (item.topicStatus === 'known' && item.topicScope) {
      if (!isTopicCompatible(invariants.topicScope, item.topicScope)) {
        deltas.push({
          field: 'topic',
          changeType: 'updated',
          oldValue: item.topicScope,
          newValue: invariants.topicScope,
          description: `Topic changed from '${item.topicScope}' to '${invariants.topicScope}'`,
        });
      } else {
        unchangedFields.push('topic');
      }
    } else if (item.topicStatus === 'ambiguous') {
      deltas.push({
        field: 'topic',
        changeType: 'updated',
        oldValue: 'ambiguous',
        newValue: invariants.topicScope,
        description: `Later email in thread provides consistent topic '${invariants.topicScope}' (without explaining earlier contradiction)`,
      });
    }
  } else {
    // Omission: topic not mentioned in this email -> retains old topic
    unchangedFields.push('topic');
  }

  // 3. Lifecycle Transition Check
  const detectedLifecycle = detectLifecycleTransition(combinedText);
  if (detectedLifecycle && detectedLifecycle !== item.currentState.itemLifecycleState) {
    deltas.push({
      field: 'itemLifecycleState',
      changeType: 'updated',
      oldValue: item.currentState.itemLifecycleState,
      newValue: detectedLifecycle,
      description: `Lifecycle state shifted from '${item.currentState.itemLifecycleState}' to '${detectedLifecycle}'`,
    });
  } else {
    unchangedFields.push('itemLifecycleState');
  }

  // 4. Venue Comparison
  const oldVenue = item.currentState.venue;
  const newVenue = invariants.venue;

  if (newVenue === null) {
    if (isExplicitVenueRemoval(combinedText)) {
      if (oldVenue !== null) {
        deltas.push({
          field: 'venue',
          changeType: 'removed',
          oldValue: oldVenue,
          newValue: null,
          description: 'Physical venue explicitly removed/cancelled',
        });
      }
    } else {
      // Omission != Deletion: previous venue remains known
      unchangedFields.push('venue');
    }
  } else {
    if (oldVenue === null) {
      deltas.push({
        field: 'venue',
        changeType: 'added',
        oldValue: null,
        newValue: newVenue,
        description: `Venue added: '${newVenue}'`,
      });
    } else {
      const vOld = oldVenue.trim().toLowerCase();
      const vNew = newVenue.trim().toLowerCase();
      if (vOld === vNew) {
        unchangedFields.push('venue');
      } else {
        const hasCue = hasRevisionCue(combinedText);
        deltas.push({
          field: 'venue',
          changeType: hasCue ? 'updated' : 'conflict',
          oldValue: oldVenue,
          newValue: newVenue,
          description: hasCue
            ? `Venue changed from '${oldVenue}' to '${newVenue}'`
            : `Conflicting venue asserted without revision cue: '${oldVenue}' vs '${newVenue}'`,
        });
      }
    }
  }

  // 5. Primary Event Temporal Comparison
  const oldEventTimestamp = item.currentState.primaryEventTimestamp;
  const newEventEntity = email.temporalAnalysis?.primaryEvent;

  if (newEventEntity && newEventEntity.timestamp !== null) {
    const isLowConfidence = newEventEntity.confidence === 'LOW' || newEventEntity.isAmbiguous;

    if (isLowConfidence && oldEventTimestamp !== null) {
      // Low-confidence safeguard: do NOT overwrite verified exact state!
      reasons.push('Low-confidence or ambiguous temporal observation ignored; exact state preserved');
      unchangedFields.push('primaryEventTimestamp');
    } else if (oldEventTimestamp === null) {
      deltas.push({
        field: 'primaryEventTimestamp',
        changeType: 'added',
        oldValue: null,
        newValue: newEventEntity.timestamp,
        description: 'Event timestamp specified',
      });
    } else {
      const oldCalendarDay = getCalendarDay(oldEventTimestamp);
      const newCalendarDay = getCalendarDay(newEventEntity.timestamp);
      const isDateOnly = newEventEntity.timePrecision === 'unknown';

      if (isDateOnly) {
        // Date-only event: calendar day comparison (do NOT treat midnight as 00:00 exact time)
        if (oldCalendarDay === newCalendarDay) {
          unchangedFields.push('primaryEventTimestamp');
        } else {
          deltas.push({
            field: 'primaryEventTimestamp',
            changeType: 'updated',
            oldValue: oldEventTimestamp,
            newValue: newEventEntity.timestamp,
            description: `Event rescheduled from ${oldCalendarDay} to ${newCalendarDay}`,
          });
        }
      } else {
        // Exact time provided
        if (oldEventTimestamp === newEventEntity.timestamp) {
          unchangedFields.push('primaryEventTimestamp');
        } else if (oldCalendarDay === newCalendarDay) {
          // Same calendar day, but time shifted (e.g. 4:30 PM -> 5:00 PM)
          deltas.push({
            field: 'primaryEventTimestamp',
            changeType: 'updated',
            oldValue: oldEventTimestamp,
            newValue: newEventEntity.timestamp,
            description: `Event time shifted on ${oldCalendarDay}`,
          });
        } else {
          // Rescheduled to a different day and time
          deltas.push({
            field: 'primaryEventTimestamp',
            changeType: 'updated',
            oldValue: oldEventTimestamp,
            newValue: newEventEntity.timestamp,
            description: `Event rescheduled from ${oldCalendarDay} to ${newCalendarDay}`,
          });
        }
      }
    }
  } else {
    // Omission: No event date mentioned in email -> retains old timestamp
    unchangedFields.push('primaryEventTimestamp');
  }

  // 6. Primary Deadline Comparison
  const oldDeadlineTimestamp = item.currentState.primaryDeadlineTimestamp;
  const newDeadlineEntity = email.temporalAnalysis?.primaryDeadline;

  if (newDeadlineEntity && newDeadlineEntity.timestamp !== null) {
    if (oldDeadlineTimestamp === null) {
      deltas.push({
        field: 'primaryDeadlineTimestamp',
        changeType: 'added',
        oldValue: null,
        newValue: newDeadlineEntity.timestamp,
        description: 'Deadline added',
      });
    } else if (oldDeadlineTimestamp !== newDeadlineEntity.timestamp) {
      deltas.push({
        field: 'primaryDeadlineTimestamp',
        changeType: 'updated',
        oldValue: oldDeadlineTimestamp,
        newValue: newDeadlineEntity.timestamp,
        description: `Deadline extended/updated from ${new Date(oldDeadlineTimestamp).toISOString()} to ${new Date(newDeadlineEntity.timestamp).toISOString()}`,
      });
    } else {
      unchangedFields.push('primaryDeadlineTimestamp');
    }
  } else {
    unchangedFields.push('primaryDeadlineTimestamp');
  }

  // 7. Action Requirement Comparison
  const newActionRequirements = detectNewActionRequirements(combinedText);
  if (newActionRequirements.length > 0) {
    deltas.push({
      field: 'actionRequired',
      changeType: 'added',
      oldValue: item.currentState.actionRequired,
      newValue: true,
      description: `New action requirement detected: ${newActionRequirements.join(', ')}`,
    });
  } else {
    unchangedFields.push('actionRequired');
  }

  // 8. Sub-Events Comparison
  const emailSubEvents = buildSubEventsFromEmail(email, invariants);
  const subEventDeltas = diffSubEvents(
    item.currentState.subEvents || [],
    emailSubEvents,
    combinedText,
    item.currentState.primaryEventTimestamp
  );
  deltas.push(...subEventDeltas);

  const hasChanges = deltas.some((d) => d.changeType !== 'unchanged');

  return {
    hasChanges,
    deltas,
    unchangedFields,
    subEventDeltas,
    confidence: 'HIGH',
    reasons,
  };
}
