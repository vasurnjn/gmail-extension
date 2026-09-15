import { db, IGAMDatabase } from '../../../db';
import { storage } from '../../../shared/storage';
import {
  AttentionItem,
  ChangeAnalysisResult,
  EmailRecord,
} from '../../../shared/types';
import { extractInvariants } from './extractor';
import { findAttentionItemCandidate, isTopicCompatible } from './identity';
import { diffAttentionItemState, hasRevisionCue } from './diff';
import { classifyRelation } from './classifier';
import { createAttentionItem, mutateAttentionItem } from './state';
import { InvariantExtractionOutput } from './types';

export interface EmailChangeAnalysis {
  item: AttentionItem;
  result: ChangeAnalysisResult;
  isNew: boolean;
}

/**
 * Pure, in-memory analysis of change and repetition for an incoming email against
 * a pool of existing AttentionItems.
 *
 * Core Safety Rule:
 * "False duplication is strictly preferable to false suppression."
 */
export function analyzeEmailChange(
  email: EmailRecord,
  existingItems: AttentionItem[],
  emailInvariants?: InvariantExtractionOutput
): EmailChangeAnalysis {
  const invariants = emailInvariants || extractInvariants(email);

  // 1. Evaluate existing candidates conservatively
  let candidateResult = findAttentionItemCandidate(email, existingItems, invariants);

  // Fallback for Scenario 14: Reopening previously cancelled item with revision/reschedule cues
  // If no active candidate was found, check if a cancelled item of same category/entity/topic exists
  // and the incoming email contains explicit rescheduling/revision language or new dates.
  if (
    candidateResult.status === 'no_candidate' &&
    existingItems.length > 0
  ) {
    const combinedText = `${email.subject || ''}\n${email.snippet || ''}\n${email.bodyTextPreview || ''}`;
    const hasCue = hasRevisionCue(combinedText);
    const hasNewTemporal = Boolean(
      email.temporalAnalysis?.primaryEvent?.timestamp ||
      email.temporalAnalysis?.primaryDeadline?.timestamp
    );

    if (hasCue || hasNewTemporal) {
      const cancelledCandidate = existingItems.find(
        (it) =>
          it.itemLifecycleState === 'cancelled' &&
          it.category === email.category &&
          ((invariants.entityStatus === 'known' &&
            it.entityStatus === 'known' &&
            invariants.canonicalEntity &&
            it.canonicalEntity &&
            invariants.canonicalEntity.toLowerCase() === it.canonicalEntity.toLowerCase()) ||
            (email.threadId && it.threadIds && it.threadIds.includes(email.threadId))) &&
          (it.topicScope === invariants.topicScope ||
            isTopicCompatible(it.topicScope, invariants.topicScope))
      );

      if (cancelledCandidate) {
        candidateResult = {
          candidateId: cancelledCandidate.id,
          candidateItem: cancelledCandidate,
          status: 'exact_identity',
          confidence: 'HIGH',
          isCrossThread: !(email.threadId && cancelledCandidate.threadIds.includes(email.threadId)),
          reasons: ['Reopening previously cancelled item with rescheduling/revision cue'],
          evaluations: [],
        };
      }
    }
  }

  // 2. State diffing against candidate (if eligible)
  const diffResult = candidateResult.candidateItem
    ? diffAttentionItemState(email, invariants, candidateResult.candidateItem)
    : null;

  // 3. Deterministic relation classification
  const decision = classifyRelation(
    candidateResult,
    diffResult,
    invariants,
    candidateResult.candidateItem
  );

  // 4. Create or Mutate AttentionItem
  let item: AttentionItem;
  let isNew = false;

  if (decision.shouldCreateNewAttentionItem || !candidateResult.candidateItem) {
    item = createAttentionItem(email, invariants, decision.relation, diffResult?.deltas || []);
    isNew = true;
  } else {
    item = mutateAttentionItem(
      candidateResult.candidateItem,
      email,
      invariants,
      decision.relation,
      diffResult?.deltas || [],
      decision.summary
    );
    isNew = false;
  }

  const result: ChangeAnalysisResult = {
    attentionItemId: item.id,
    relation: decision.relation,
    shouldCreateNewAttentionItem: decision.shouldCreateNewAttentionItem,
    deltas: diffResult?.deltas || [],
    summary: decision.summary,
    confidence: decision.confidence,
  };

  return {
    item,
    result,
    isNew,
  };
}

/**
 * Persists change analysis results into Dexie:
 * 1. Loads candidates for the email's category.
 * 2. Runs analyzeEmailChange.
 * 3. Updates email record with attentionItemId and changeRelation.
 * 4. Upserts attention item and email into Dexie.
 *
 * Safe and idempotent against repeated runs.
 */
export async function processEmailChange(
  email: EmailRecord,
  database: IGAMDatabase = db
): Promise<EmailChangeAnalysis> {
  // Idempotency check 1: if message already has an attentionItemId recorded
  if (email.attentionItemId) {
    const existingItem = await database.attentionItems.get(email.attentionItemId);
    if (existingItem && existingItem.messageIds.includes(email.id)) {
      await database.emails.put(email);
      return {
        item: existingItem,
        result: {
          attentionItemId: existingItem.id,
          relation: email.changeRelation || 'REPEAT',
          shouldCreateNewAttentionItem: false,
          deltas: [],
          summary: 'Message already processed in attention item',
          confidence: 'HIGH',
        },
        isNew: false,
      };
    }
  }

  // Fetch active / existing candidates in this category
  const existingItems = email.category
    ? await database.attentionItems.where('category').equals(email.category).toArray()
    : await database.attentionItems.toArray();

  // Idempotency check 2: if message ID already exists in any candidate AttentionItem
  const alreadyProcessedItem = existingItems.find((it) => it.messageIds.includes(email.id));
  if (alreadyProcessedItem) {
    email.attentionItemId = alreadyProcessedItem.id;
    email.changeRelation =
      alreadyProcessedItem.history.find((h) => h.emailId === email.id)?.relation || 'REPEAT';
    await database.emails.put(email);
    return {
      item: alreadyProcessedItem,
      result: {
        attentionItemId: alreadyProcessedItem.id,
        relation: email.changeRelation,
        shouldCreateNewAttentionItem: false,
        deltas: [],
        summary: 'Message already processed in attention item',
        confidence: 'HIGH',
      },
      isNew: false,
    };
  }

  const analysis = analyzeEmailChange(email, existingItems);

  // Link attention item to email record
  email.attentionItemId = analysis.item.id;
  email.changeRelation = analysis.result.relation;

  // Restore account-scoped attention state across reconnects if previously handled/dismissed
  const syncState = await storage.getSyncState().catch(() => null);
  if (syncState?.accountEmail) {
    const restoredState = await storage.lookupAccountAttentionState(syncState.accountEmail, email.id);
    if (restoredState) {
      email.alertStatus = restoredState;
      if (restoredState === 'handled' && !email.handledAt) {
        email.handledAt = Date.now();
      }
      if (analysis.isNew || analysis.item.userAttentionState === 'unhandled') {
        analysis.item.userAttentionState = restoredState;
      }
    }
  }

  // Persist into database
  await database.attentionItems.put(analysis.item);
  await database.emails.put(email);

  return analysis;
}
