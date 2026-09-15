import { AttentionItem, ChangeRelation, FieldDelta } from '../../../shared/types';
import {
  CandidateMatchStatus,
  IdentityMatchResult,
  InvariantExtractionOutput,
  StateDiffResult,
} from './types';

export interface ClassificationDecision {
  relation: ChangeRelation;
  shouldCreateNewAttentionItem: boolean;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  summary: string;
  reasons: string[];
}

/**
 * Deterministically classifies the relation between an incoming email and candidate AttentionItem:
 * NEW | REPEAT | UPDATE | CONFLICT | CANCELLED
 *
 * Core Safety Rule:
 * "False duplication is strictly preferable to false suppression."
 *
 * Tone alone, aggressive keywords, and wording reformulations NEVER constitute a state change.
 */
export function classifyRelation(
  candidateResult: IdentityMatchResult,
  diffResult: StateDiffResult | null,
  invariants: InvariantExtractionOutput,
  existingItem: AttentionItem | null
): ClassificationDecision {
  const reasons: string[] = [];

  // 1. Case: No valid candidate or multiple ambiguous candidates -> NEW
  if (
    !candidateResult ||
    candidateResult.status === 'no_candidate' ||
    !existingItem ||
    candidateResult.candidateItem === null
  ) {
    reasons.push('No safe existing AttentionItem candidate found; creating new AttentionItem');
    return {
      relation: 'NEW',
      shouldCreateNewAttentionItem: true,
      confidence: 'HIGH',
      summary: 'First occurrence of item or distinct engagement',
      reasons,
    };
  }

  if (candidateResult.status === 'unresolved_multiple') {
    reasons.push(
      'Multiple competing AttentionItem candidates exist; refusing arbitrary selection to prevent false suppression'
    );
    return {
      relation: 'NEW',
      shouldCreateNewAttentionItem: true,
      confidence: 'HIGH',
      summary: 'Unresolved multiple candidates; partitioned into new AttentionItem',
      reasons,
    };
  }

  // 2. Case: Same thread with uncertain identity
  // Must NOT silently become an exact REPEAT if topic or entity was uncertain!
  if (candidateResult.status === 'thread_uncertain') {
    reasons.push('Same thread match with uncertain identity (unknown/ambiguous entity or topic)');
  }

  // 3. Case: Explicit Cancellation
  const isCancelled =
    diffResult?.deltas.some(
      (d) => d.field === 'itemLifecycleState' && d.newValue === 'cancelled'
    ) || false;

  if (isCancelled) {
    reasons.push('Explicit cancellation language detected in message');
    return {
      relation: 'CANCELLED',
      shouldCreateNewAttentionItem: false,
      confidence: 'HIGH',
      summary: 'Event or engagement explicitly cancelled',
      reasons,
    };
  }

  // 4. Case: Previously cancelled item with explicit rescheduling / reopening
  if (existingItem.itemLifecycleState === 'cancelled') {
    const hasRescheduling = diffResult?.deltas.some(
      (d) =>
        d.field === 'primaryEventTimestamp' ||
        d.field === 'subEvent' ||
        (d.field === 'itemLifecycleState' && d.newValue === 'active')
    );

    if (hasRescheduling) {
      reasons.push('Previously cancelled item rescheduled/reopened with new timing');
      return {
        relation: 'UPDATE',
        shouldCreateNewAttentionItem: false,
        confidence: 'HIGH',
        summary: 'Previously cancelled item reopened and rescheduled',
        reasons,
      };
    }
  }

  // 5. Case: Conflicts (contradictory facts without supersession cue)
  const hasConflict = diffResult?.deltas.some((d) => d.changeType === 'conflict') || false;
  if (hasConflict) {
    reasons.push('Conflicting factual assertion detected without revision cue');
    return {
      relation: 'CONFLICT',
      shouldCreateNewAttentionItem: false,
      confidence: 'HIGH',
      summary: 'Contradictory information asserted without supersession language',
      reasons,
    };
  }

  // 6. Case: Meaningful Factual Updates
  // Verified changes to venue, dates, times, deadlines, action requirements, sub-events, or postponement
  if (diffResult && diffResult.hasChanges && diffResult.deltas.length > 0) {
    const changeFields = diffResult.deltas.map((d) => d.field).join(', ');
    reasons.push(`Factual changes detected in fields: ${changeFields}`);
    return {
      relation: 'UPDATE',
      shouldCreateNewAttentionItem: false,
      confidence: 'HIGH',
      summary: `Factual state update: ${changeFields}`,
      reasons,
    };
  }

  // 7. Case: Repeated Communication without factual shifts -> REPEAT
  // Tone escalation, rewritten prose, omitted fields (omission != deletion), date-only same day
  reasons.push('No factual state changes detected; underlying facts are identical');
  return {
    relation: 'REPEAT',
    shouldCreateNewAttentionItem: false,
    confidence: candidateResult.confidence === 'LOW' ? 'LOW' : 'HIGH',
    summary: 'Repeated communication with identical factual information',
    reasons,
  };
}
