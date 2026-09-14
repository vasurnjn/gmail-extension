import { EmailRecord } from '../../../shared/types';
import { CategoryResult, EmailSignals } from '../types';
import { sanitizeEmailContent } from './sanitizer';
import { extractTemporalCandidates } from './parser';
import { buildTemporalAnalysis, deduplicateTemporalEntities, resolveTemporalEntity } from './semantics';
import { ExtractedTemporalEntity, TemporalAnalysis } from './types';

export * from './types';
export * from './sanitizer';
export * from './parser';
export * from './semantics';

/**
 * Main entry point for Phase 3 Temporal Analysis.
 * Runs deterministic date/time extraction, conservative year inference,
 * precision tracking, and calendar-day status evaluation.
 *
 * @param record EmailRecord being analyzed
 * @param signals Extracted EmailSignals
 * @param categoryResult Primary Category classification result
 * @param referenceTime Deterministic reference clock (defaults to Date.now())
 * @param userTimezone Optional user timezone override
 */
export function analyzeTemporals(
  record: EmailRecord,
  signals?: EmailSignals,
  categoryResult?: CategoryResult,
  referenceTime: number = Date.now(),
  userTimezone?: string
): TemporalAnalysis {
  // 1. Sanitize text to quarantine historical thread blocks and legal disclaimers
  const sanitized = sanitizeEmailContent(record.subject, record.bodyTextPreview);

  // 2. Extract raw intermediate temporal candidates
  const candidates = extractTemporalCandidates(sanitized.primaryText);

  // 3. Resolve candidates into fully typed ExtractedTemporalEntities
  const isCommercial =
    categoryResult?.category === 'newsletters_promotions' ||
    signals?.content?.hasCommercialUrgency ||
    signals?.structural?.hasMailingListUnsubscribe;

  const entities: ExtractedTemporalEntity[] = candidates.map((candidate, idx) => {
    const entity = resolveTemporalEntity(
      candidate,
      idx,
      record.internalDate,
      referenceTime,
      userTimezone
    );

    // Commercial Promotion Guardrail:
    // Dates inside marketing newsletters are tagged as commercial and prevented from acting as hard deadlines
    if (isCommercial && entity.type === 'deadline') {
      entity.type = 'event';
      entity.evidenceReasons.push('Commercial promo guardrail: promotional deadline downgraded to event');
    }

    return entity;
  });

  // 4. Semantically deduplicate entities across subject/body or newline wraps
  const deduplicatedEntities = deduplicateTemporalEntities(entities);

  // 5. Build consolidated TemporalAnalysis
  return buildTemporalAnalysis(deduplicatedEntities, referenceTime);
}
