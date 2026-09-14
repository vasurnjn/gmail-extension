import { AttentionItem, EmailRecord } from '../../../shared/types';
import { extractInvariants } from './extractor';
import { isTopicCompatible } from './compatibility';
import {
  CandidateEvaluation,
  CandidateMatchStatus,
  IdentityMatchResult,
  InvariantExtractionOutput,
} from './types';

export { isTopicCompatible } from './compatibility';

/**
 * Normalizes an organization or company entity name into a clean canonical string.
 * Strips common corporate entity suffixes, punctuation, and multiple spaces.
 */
export function canonicalizeEntity(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw
    .toLowerCase()
    .replace(/['.]/g, '')
    .replace(/[_\s]+/g, ' ')
    .replace(/\s+(?:inc|llc|ltd|pvt\s+ltd|corp|corporation)$/i, '')
    .trim();
  return cleaned || null;
}

/**
 * Evaluates a single existing AttentionItem candidate against an incoming email.
 * Adheres strictly to the core safety rule:
 * "False duplication is strictly preferable to false suppression."
 */
export function evaluateItemCandidate(
  email: EmailRecord,
  emailInvariants: InvariantExtractionOutput,
  item: AttentionItem
): CandidateEvaluation {
  // 1. Category check: Cross-category semantic match is strictly prohibited
  if (email.category !== item.category) {
    return {
      itemId: item.id,
      isEligible: false,
      matchStatus: 'incompatible',
      confidence: 'LOW',
      sameThread: false,
      reasons: [`Category mismatch: email '${email.category}' vs item '${item.category}'`],
    };
  }

  // 2. Lifecycle state check: Terminal states (completed / cancelled) cannot absorb new messages
  if (item.itemLifecycleState === 'completed' || item.itemLifecycleState === 'cancelled') {
    return {
      itemId: item.id,
      isEligible: false,
      matchStatus: 'incompatible',
      confidence: 'LOW',
      sameThread: false,
      reasons: [
        `AttentionItem is in terminal state '${item.itemLifecycleState}' and cannot absorb new messages`,
      ],
    };
  }

  // 3. Thread continuity check
  const sameThread = Boolean(
    email.threadId && item.threadIds && item.threadIds.includes(email.threadId)
  );

  const emailEntity = canonicalizeEntity(emailInvariants.canonicalEntity);
  const itemEntity = canonicalizeEntity(item.canonicalEntity);

  const isEmailEntityKnown = emailInvariants.entityStatus === 'known' && emailEntity !== null;
  const isItemEntityKnown = item.entityStatus === 'known' && itemEntity !== null;

  // 4. Hard Entity Partition: Different known entities must NEVER match
  // Even if same thread, same venue, same date, entity contradiction NEVER matches!
  if (isEmailEntityKnown && isItemEntityKnown) {
    if (emailEntity !== itemEntity) {
      return {
        itemId: item.id,
        isEligible: false,
        matchStatus: 'incompatible',
        confidence: 'HIGH',
        sameThread,
        reasons: [
          `Explicit entity contradiction: '${emailEntity}' vs '${itemEntity}'. Hard entity partition prevents match.`,
        ],
      };
    }
  }

  // 5. Unknown / Ambiguous Entity Safety: Forbids cross-thread matching
  if (!isEmailEntityKnown || !isItemEntityKnown) {
    if (!sameThread) {
      return {
        itemId: item.id,
        isEligible: false,
        matchStatus: 'incompatible',
        confidence: 'HIGH',
        sameThread: false,
        reasons: [
          `Unknown or ambiguous entity (email: '${emailInvariants.entityStatus}', item: '${item.entityStatus}') forbids cross-thread match`,
        ],
      };
    }
  }

  // 6. Topic Scope Check
  const isEmailTopicKnown =
    emailInvariants.topicStatus === 'known' && Boolean(emailInvariants.topicScope);
  const isItemTopicKnown =
    item.topicStatus === 'known' && Boolean(item.topicScope);

  if (isEmailTopicKnown && isItemTopicKnown) {
    const topicsCompatible = isTopicCompatible(
      emailInvariants.topicScope,
      item.topicScope
    );

    if (!topicsCompatible) {
      // Explicit topic contradiction: Even within the same thread, different known topics must not merge
      return {
        itemId: item.id,
        isEligible: false,
        matchStatus: 'incompatible',
        confidence: 'HIGH',
        sameThread,
        reasons: [
          `Explicit topic contradiction: '${emailInvariants.topicScope}' vs '${item.topicScope}'. Cannot match.`,
        ],
      };
    }

    // Known entities match and topics are compatible: Confident semantic candidate
    if (isEmailEntityKnown && isItemEntityKnown) {
      const reasons = [
        `Known entity '${emailEntity}' and compatible topic '${emailInvariants.topicScope}' match`,
      ];
      if (sameThread) {
        reasons.push(`Supported by same thread continuity ('${email.threadId}')`);
      }
      return {
        itemId: item.id,
        isEligible: true,
        matchStatus: 'exact_identity',
        confidence: 'HIGH',
        sameThread,
        reasons,
      };
    }
  }

  // 7. Unknown / Ambiguous Topic Scope Safety: Forbids cross-thread matching
  if (!isEmailTopicKnown || !isItemTopicKnown) {
    if (!sameThread) {
      return {
        itemId: item.id,
        isEligible: false,
        matchStatus: 'incompatible',
        confidence: 'HIGH',
        sameThread: false,
        reasons: [
          `Unknown or ambiguous topic scope (email: '${emailInvariants.topicStatus}', item: '${item.topicStatus}') forbids cross-thread match`,
        ],
      };
    }
  }

  // 8. Same-Thread fallback with uncertain identity
  // ThreadId matches, and there is no explicit entity or topic contradiction
  const uncertainReasons = [
    `Same thread continuity ('${email.threadId}'), but identity is uncertain (entity: email=${emailInvariants.entityStatus}/item=${item.entityStatus}, topic: email=${emailInvariants.topicStatus}/item=${item.topicStatus})`,
  ];
  return {
    itemId: item.id,
    isEligible: true,
    matchStatus: 'thread_uncertain',
    confidence: 'LOW',
    sameThread: true,
    reasons: uncertainReasons,
  };
}

/**
 * Finds and selects an existing AttentionItem candidate for an incoming email.
 * Evaluates all existing items deterministically and conservatively.
 *
 * Rules:
 * - 0 eligible -> 'no_candidate'
 * - 1 eligible -> returns candidate with exact_identity or thread_uncertain status
 * - >1 eligible -> 'unresolved_multiple' (never arbitrarily picks one or uses date proximity)
 */
export function findAttentionItemCandidate(
  email: EmailRecord,
  existingItems: AttentionItem[],
  emailInvariants?: InvariantExtractionOutput
): IdentityMatchResult {
  if (!existingItems || existingItems.length === 0) {
    return {
      candidateId: null,
      candidateItem: null,
      status: 'no_candidate',
      confidence: 'NONE',
      isCrossThread: false,
      reasons: ['No existing attention items to evaluate'],
      evaluations: [],
    };
  }

  const invariants = emailInvariants || extractInvariants(email);
  const evaluations: CandidateEvaluation[] = existingItems.map((item) =>
    evaluateItemCandidate(email, invariants, item)
  );

  const eligible = evaluations.filter((e) => e.isEligible);

  // Case: No eligible candidates
  if (eligible.length === 0) {
    return {
      candidateId: null,
      candidateItem: null,
      status: 'no_candidate',
      confidence: 'NONE',
      isCrossThread: false,
      reasons: ['No eligible attention item candidates found'],
      evaluations,
    };
  }

  // Case: Exactly one eligible candidate
  if (eligible.length === 1) {
    const winner = eligible[0];
    const candidateItem =
      existingItems.find((item) => item.id === winner.itemId) || null;

    return {
      candidateId: winner.itemId,
      candidateItem,
      status: winner.matchStatus as 'exact_identity' | 'thread_uncertain',
      confidence: winner.confidence,
      isCrossThread: !winner.sameThread,
      reasons: winner.reasons,
      evaluations,
    };
  }

  // Case: Multiple eligible candidates exist
  // Conservative safety rule: Refuse arbitrary selection to prevent false suppression
  return {
    candidateId: null,
    candidateItem: null,
    status: 'unresolved_multiple',
    confidence: 'NONE',
    isCrossThread: false,
    reasons: [
      `Multiple compatible attention items found (${eligible.length}); refusing arbitrary selection to prevent false suppression: ${eligible.map((e) => e.itemId).join(', ')}`,
    ],
    evaluations,
  };
}
