import { EmailRecord } from '../../shared/types';
import { extractSignals } from './extractor';
import { classifyCategory } from './classifier';
import { scoreImportance } from './importance';
import { scoreUrgency } from './urgency';
import { analyzeTemporals } from './temporal';
import { AnalysisOutput } from './types';

export * from './types';
export * from './extractor';
export * from './classifier';
export * from './importance';
export * from './urgency';
export * from './temporal';
export * from './change';

/**
 * Executes local, privacy-first signal extraction, deterministic category classification,
 * deadline & temporal understanding, and independent importance & urgency scoring.
 * Strictly local processing — zero external APIs, zero external AI, and zero telemetry.
 */
export function analyzeEmail(
  record: EmailRecord,
  referenceTime: number = Date.now(),
  userTimezone?: string
): AnalysisOutput {
  const signals = extractSignals(record);
  const result = classifyCategory(signals, record);
  const temporal = analyzeTemporals(record, signals, result, referenceTime, userTimezone);
  const importance = scoreImportance(record, signals, result);
  const urgency = scoreUrgency(record, signals, result, temporal);

  return {
    signals,
    result,
    importance,
    urgency,
    temporal,
  };
}


