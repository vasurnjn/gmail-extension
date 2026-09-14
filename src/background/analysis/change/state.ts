import {
  AttentionItem,
  ChangeRelation,
  EmailRecord,
  FieldDelta,
  ItemLifecycleState,
  SubEventRecord,
} from '../../../shared/types';
import { createDefaultNotificationState } from '../../notifications/types';
import { buildSubEventsFromEmail, detectLifecycleTransition } from './diff';
import { canonicalizeEntity } from './identity';
import { InvariantExtractionOutput } from './types';

/**
 * Creates a brand new AttentionItem instance for an incoming email.
 * Guarantees that identityKey is never fabricated when identity is uncertain.
 */
export function createAttentionItem(
  email: EmailRecord,
  invariants: InvariantExtractionOutput,
  relation: ChangeRelation = 'NEW',
  deltas: FieldDelta[] = []
): AttentionItem {
  const combinedText = `${email.subject || ''}\n${email.snippet || ''}\n${email.bodyTextPreview || ''}`;
  const detectedLifecycle = detectLifecycleTransition(combinedText);
  const itemLifecycleState: ItemLifecycleState = detectedLifecycle || 'active';

  // Construct identityKey only when both entity and topic are known
  let identityKey: string | null = null;
  const canonicalEntity = canonicalizeEntity(invariants.canonicalEntity);

  if (
    invariants.entityStatus === 'known' &&
    canonicalEntity !== null &&
    invariants.topicStatus === 'known' &&
    invariants.topicScope !== null
  ) {
    identityKey = `${email.category}::${canonicalEntity}::${invariants.topicScope}`;
  }

  const subEvents = buildSubEventsFromEmail(email, invariants);

  const id = `att_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const timestamp = email.internalDate || Date.now();

  return {
    id,
    identityKey,
    category: email.category,
    canonicalEntity: invariants.canonicalEntity,
    entityStatus: invariants.entityStatus,
    topicScope: invariants.topicScope,
    topicStatus: invariants.topicStatus,
    threadIds: email.threadId ? [email.threadId] : [],
    messageIds: [email.id],
    latestEmailId: email.id,
    firstSeenAt: timestamp,
    lastSeenAt: timestamp,
    itemLifecycleState,
    userAttentionState: 'unhandled',
    importanceScore: email.importanceScore,
    urgencyScore: email.urgencyScore,
    currentState: {
      primaryEventTimestamp: email.temporalAnalysis?.primaryEvent?.timestamp ?? null,
      primaryDeadlineTimestamp: email.temporalAnalysis?.primaryDeadline?.timestamp ?? null,
      venue: invariants.venue,
      actionRequired: email.actionRequired,
      actionType: email.actionType,
      itemLifecycleState,
      subEvents,
    },
    history: [
      {
        emailId: email.id,
        internalDate: timestamp,
        recordedAt: Date.now(),
        relation,
        deltas,
        summary: `Initial creation of attention item from email '${email.subject}'`,
      },
    ],
    notificationState: createDefaultNotificationState(),
  };
}

/**
 * Mutates an existing AttentionItem instance based on relation and factual deltas.
 *
 * Safety Invariants:
 * 1. Duplicate email safety: idempotently ignores re-processing of already registered email IDs.
 * 2. Omission != Deletion: unmentioned fields are NEVER wiped.
 * 3. Independent States: real-world lifecycle state and user attention state are decoupled.
 * 4. Conflicts are recorded in history without corrupting current verified state.
 */
export function mutateAttentionItem(
  item: AttentionItem,
  email: EmailRecord,
  invariants: InvariantExtractionOutput,
  relation: ChangeRelation,
  deltas: FieldDelta[],
  summary: string
): AttentionItem {
  // Idempotency: prevent duplicate processing of the same Gmail message ID
  if (item.messageIds.includes(email.id) || item.history.some((h) => h.emailId === email.id)) {
    return item;
  }

  // Deep clone to prevent unintended shared mutations
  const updated: AttentionItem = JSON.parse(JSON.stringify(item));

  // Ensure notificationState is safely defaulted if missing from legacy records
  if (!updated.notificationState) {
    updated.notificationState = createDefaultNotificationState();
  }

  // Update communication references
  if (!updated.messageIds.includes(email.id)) {
    updated.messageIds.push(email.id);
  }
  if (email.threadId && !updated.threadIds.includes(email.threadId)) {
    updated.threadIds.push(email.threadId);
  }

  updated.latestEmailId = email.id;
  const emailTimestamp = email.internalDate || Date.now();
  updated.lastSeenAt = Math.max(updated.lastSeenAt, emailTimestamp);
  updated.importanceScore = Math.max(updated.importanceScore, email.importanceScore);
  updated.urgencyScore = email.urgencyScore;

  switch (relation) {
    case 'REPEAT': {
      // Real-world state is completely preserved (no changes)
      // User attention state remains as the user left it (handled remains handled, snoozed remains snoozed)
      updated.history.push({
        emailId: email.id,
        internalDate: emailTimestamp,
        recordedAt: Date.now(),
        relation: 'REPEAT',
        deltas: [],
        summary,
      });
      break;
    }

    case 'UPDATE': {
      // Save snapshot of previous state for auditability
      updated.previousState = JSON.parse(JSON.stringify(updated.currentState));

      // Apply factual updates
      for (const delta of deltas) {
        if (delta.field === 'venue') {
          if (delta.changeType === 'removed') {
            updated.currentState.venue = null;
          } else if (delta.changeType === 'updated' || delta.changeType === 'added') {
            updated.currentState.venue = invariants.venue;
          }
        } else if (delta.field === 'primaryEventTimestamp') {
          if (email.temporalAnalysis?.primaryEvent?.timestamp !== null) {
            updated.currentState.primaryEventTimestamp =
              email.temporalAnalysis?.primaryEvent?.timestamp ??
              updated.currentState.primaryEventTimestamp;
          }
        } else if (delta.field === 'primaryDeadlineTimestamp') {
          if (email.temporalAnalysis?.primaryDeadline?.timestamp !== null) {
            updated.currentState.primaryDeadlineTimestamp =
              email.temporalAnalysis?.primaryDeadline?.timestamp ??
              updated.currentState.primaryDeadlineTimestamp;
          }
        } else if (delta.field === 'actionRequired') {
          updated.currentState.actionRequired = true;
        } else if (delta.field === 'itemLifecycleState') {
          const newLife = delta.newValue as ItemLifecycleState;
          if (newLife) {
            updated.currentState.itemLifecycleState = newLife;
            updated.itemLifecycleState = newLife;
          }
        } else if (delta.field === 'subEvent') {
          if (delta.changeType === 'added' && delta.newValue) {
            updated.currentState.subEvents.push(delta.newValue as SubEventRecord);
          } else if (delta.changeType === 'updated') {
            const sub = updated.currentState.subEvents.find(
              (s) => s.subEventId === delta.subEventId
            );
            if (sub && typeof delta.newValue === 'number') {
              sub.timestamp = delta.newValue;
            }
          }
        } else if (delta.field === 'topic') {
          if (delta.changeType === 'updated' && typeof delta.newValue === 'string') {
            updated.topicScope = delta.newValue;
            updated.topicStatus = 'known';
            if (!updated.identityKey && updated.canonicalEntity && updated.topicScope) {
              const canonical = canonicalizeEntity(updated.canonicalEntity);
              if (canonical) {
                updated.identityKey = `${updated.category}::${canonical}::${updated.topicScope}`;
              }
            }
          }
        }
      }

      // Reopening check: If previously cancelled and now rescheduled, set to active
      if (
        updated.itemLifecycleState === 'cancelled' &&
        deltas.some((d) => d.field === 'primaryEventTimestamp' || d.field === 'subEvent')
      ) {
        updated.itemLifecycleState = 'active';
        updated.currentState.itemLifecycleState = 'active';
      }

      // Preserve user attention state independently, ready for downstream alerting
      updated.history.push({
        emailId: email.id,
        internalDate: emailTimestamp,
        recordedAt: Date.now(),
        relation: 'UPDATE',
        deltas,
        summary,
      });
      break;
    }

    case 'CONFLICT': {
      // Preserve verified current state non-destructively; record discrepancy in history
      updated.history.push({
        emailId: email.id,
        internalDate: emailTimestamp,
        recordedAt: Date.now(),
        relation: 'CONFLICT',
        deltas,
        summary,
      });
      break;
    }

    case 'CANCELLED': {
      updated.previousState = JSON.parse(JSON.stringify(updated.currentState));
      updated.itemLifecycleState = 'cancelled';
      updated.currentState.itemLifecycleState = 'cancelled';

      // User attention state remains independent (never equate cancelled with handled)
      updated.history.push({
        emailId: email.id,
        internalDate: emailTimestamp,
        recordedAt: Date.now(),
        relation: 'CANCELLED',
        deltas,
        summary,
      });
      break;
    }
  }

  return updated;
}
