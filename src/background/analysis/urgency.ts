import { ActionType, EmailRecord, TemporalAnalysis } from '../../shared/types';
import { CategoryResult, EmailSignals, UrgencyResult } from './types';

/**
 * Computes a deterministic, evidence-based Urgency Score (0 - 100).
 * Answers: "How strongly does this email require attention soon?"
 *
 * Design Principles:
 * 1. Strictly independent from Importance.
 * 2. Driven by explicit temporal anchors (today, tomorrow, deadline) and disruption alerts.
 * 3. Commercial guardrail: marketing urgency (sales, hurry, countdowns) is strictly capped <= 20.
 * 4. Conservative action resolution: requires clear contextual action evidence.
 * 5. Full explainability: every adjustment records a clear, human-readable reason.
 */
export function scoreUrgency(
  record: EmailRecord,
  signals: EmailSignals,
  categoryResult: CategoryResult,
  temporal?: TemporalAnalysis
): UrgencyResult {
  let score = 5; // Modest baseline for incoming correspondence
  const reasons: string[] = [];

  const { content, structural } = signals;
  const primaryCat = categoryResult.category;


  // 1. Critical Disruptions & Immediate Alerts (+40 to +45)
  if (content.hasDisruptionLanguage) {
    score += 45;
    reasons.push('Time-sensitive alert or schedule disruption (e.g. cancellation, reschedule, security)');
  }

  // 2. Imminent Deadlines (+50)
  if (content.hasImminentDeadline) {
    score += 50;
    reasons.push('Imminent deadline or immediate action required (today / within hours / EOD)');
  } else if (content.hasUpcomingDeadline) {
    // 3. Upcoming Deadlines (+30)
    score += 30;
    reasons.push('Upcoming deadline, due date, or approaching time horizon');
  }

  // 4. Scheduled Event / Session Timing (+20 to +25)
  // Recognizes scheduled event language without arbitrary date parsing
  if (content.hasScheduledEvent) {
    if (!content.hasImminentDeadline && !content.hasUpcomingDeadline) {
      score += 25;
      reasons.push('Scheduled event, session, or interview timing specified');
    } else if (content.hasUpcomingDeadline) {
      score += 10;
      reasons.push('Specific scheduled event timing confirmed');
    }
  }

  // 5. Genuine Actionable Context (+20)
  // Meaningful urgency contribution without automatically jumping to high panic
  if (content.hasActionableContext || content.hasExplicitActionRequest) {
    score += 20;
    reasons.push('Actionable requirement or response requested (registration, submission, attendance)');
  }

  // 6. Contextual Event / Meeting Timing (+5)
  if (primaryCat === 'events_meetings' && (content.hasScheduledEvent || content.hasUpcomingDeadline || content.hasImminentDeadline)) {
    score += 5;
    reasons.push('Imminent event or calendar meeting schedule');
  }

  // 7. COMMERCIAL URGENCY GUARDRAIL
  // Promotional marketing hooks ("Hurry! 50% off ends today!", "Sale ends in 2 hours") must NOT yield high urgency.
  const isCommercialOrPromo =
    content.hasCommercialUrgency ||
    primaryCat === 'newsletters_promotions' ||
    (structural.hasMailingListUnsubscribe && content.promotionalKeywords.length > 0);

  if (isCommercialOrPromo) {
    if (score > 20) {
      score = 20;
    }
    reasons.push('Commercial urgency suppressed (marketing or promotional context)');
  }

  // Clamp final score strictly between 0 and 100
  const urgencyScore = Math.max(0, Math.min(100, Math.round(score)));

  // If no reasons were recorded, state default baseline
  if (reasons.length === 0) {
    reasons.push('No immediate time sensitivity or deadline detected');
  }

  // 8. Resolve Action Required & Action Type (Conservative)
  const { actionRequired, actionType } = resolveAction(record, signals, categoryResult, isCommercialOrPromo);

  return {
    urgencyScore,
    urgencyReasons: reasons,
    actionRequired,
    actionType,
  };
}

/**
 * Conservatively resolves whether an action is truly required and what type.
 * Never triggers on a bare verb alone. Leaves actionType as null when uncertain.
 */
function resolveAction(
  record: EmailRecord,
  signals: EmailSignals,
  categoryResult: CategoryResult,
  isCommercialOrPromo: boolean
): { actionRequired: boolean; actionType: ActionType | null } {
  // If promotional/marketing, suppress action required
  if (isCommercialOrPromo) {
    return { actionRequired: false, actionType: null };
  }

  const { content, structural } = signals;

  // Meaningful action criteria:
  // Must have genuine actionable context, an assessment workflow with action verbs, or a clear deadline with an action verb
  const hasStrongActionContext =
    content.hasActionableContext ||
    content.hasExplicitActionRequest ||
    (content.hasAssessmentWorkflowPattern && content.actionVerbs.length > 0) ||
    ((content.hasImminentDeadline || content.hasUpcomingDeadline) && content.actionVerbs.length > 0);

  if (!hasStrongActionContext) {
    return { actionRequired: false, actionType: null };
  }

  // Resolve specific ActionType confidently; if uncertain, keep null
  const combined = `${record.subject}\n${record.snippet}\n${record.bodyTextPreview}`.toLowerCase();
  let actionType: ActionType | null = null;

  if (/\b(?:register|registration|enroll|enrollment|sign[- ]up)\b/i.test(combined)) {
    actionType = 'register';
  } else if (/\b(?:apply|application)\b/i.test(combined)) {
    actionType = 'apply';
  } else if (/\b(?:submit|submission|upload)\b/i.test(combined)) {
    actionType = 'submit';
  } else if (/\b(?:pay|payment|fee|invoice|bill)\b/i.test(combined)) {
    actionType = 'pay';
  } else if (/\b(?:attend|attendance|join|webinar|session|ppt|meeting)\b/i.test(combined)) {
    actionType = 'attend';
  } else if (/\b(?:confirm|confirmation|rsvp|acceptance)\b/i.test(combined)) {
    actionType = 'confirm';
  } else if (structural.hasReplySubject || /\b(?:reply|respond|response)\b/i.test(combined)) {
    actionType = 'reply';
  } else if (/\b(?:review|verify|verification)\b/i.test(combined)) {
    actionType = 'review';
  } else {
    // If action is required but specific type cannot be determined with confidence, leave null
    actionType = null;
  }

  return {
    actionRequired: true,
    actionType,
  };
}
