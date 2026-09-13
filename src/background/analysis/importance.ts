import { EmailRecord } from '../../shared/types';
import { CategoryResult, EmailSignals, ImportanceResult } from './types';

/**
 * Computes a deterministic, evidence-based Importance Score (0 - 100).
 * Answers: "How much does this email matter to the user?"
 *
 * Design Principles:
 * 1. Strictly evidence-based: built additively from verified signals and contextual combinations.
 * 2. Category only provides a modest contextual contribution; it never dictates high importance alone.
 * 3. Conservative sender/domain reputation: .edu/.gov/corporate provide supporting evidence only.
 * 4. Mass distribution (unsubscribe header) moderates broadcast emails without zeroing them out.
 * 5. Full explainability: every adjustment records a clear, human-readable reason.
 */
export function scoreImportance(
  record: EmailRecord,
  signals: EmailSignals,
  categoryResult: CategoryResult
): ImportanceResult {
  let score = 20; // Modest baseline for incoming correspondence
  const reasons: string[] = [];

  const { sender, content, structural } = signals;
  const primaryCat = categoryResult.category;

  // 1. High-Stakes Milestones & Contextual Combinations (+30 to +50)
  if (content.hasOfferPattern) {
    score += 45;
    reasons.push('High-stakes career milestone (offer or selection confirmed)');
  } else if (content.hasSelectionPattern) {
    score += 35;
    reasons.push('Placement or recruitment selection process');
  } else if (content.hasAssessmentWorkflowPattern) {
    score += 30;
    reasons.push('Scheduled assessment, test round, or interview workflow');
  }

  // Academic High-Stakes Milestones (Exams, Admit Cards, Thesis, Grades)
  const isExamOrGrade = content.academicKeywords.some(kw =>
    ['exam', 'examination', 'hall ticket', 'admit card', 'thesis', 'grade report', 'marksheet'].includes(kw)
  );
  if (isExamOrGrade) {
    score += 30;
    reasons.push('Crucial academic milestone (examination, admit card, or grade report)');
  }

  // Financial Milestones (Transactions, Salary, Invoices, Statements)
  const isFinancialMilestone = content.financeKeywords.some(kw =>
    ['salary', 'account statement', 'transaction', 'payment due', 'invoice', 'account credited', 'account debited', 'tax invoice'].includes(kw)
  );
  if (isFinancialMilestone) {
    score += 25;
    reasons.push('Direct financial transaction, statement, or salary notification');
  }

  // Legal & Government Milestones
  if (content.legalGovKeywords.length > 0) {
    score += 25;
    reasons.push('Official government, legal, or regulatory communication');
  }

  // Healthcare Appointments / Reports
  const isHealthMilestone = content.healthcareKeywords.some(kw =>
    ['appointment', 'lab report', 'diagnostic report', 'prescription'].includes(kw)
  );
  if (isHealthMilestone) {
    score += 25;
    reasons.push('Personal healthcare appointment or medical diagnostic report');
  }

  // Travel Bookings / Itineraries
  const isTravelBooking = content.travelKeywords.some(kw =>
    ['flight booking', 'boarding pass', 'pnr', 'hotel reservation', 'e-ticket', 'train ticket'].includes(kw)
  );
  if (isTravelBooking) {
    score += 25;
    reasons.push('Confirmed travel booking, itinerary, or boarding pass');
  }

  // 2. Direct Conversational Evidence (+15 to +20)
  // Direct reply or forward from a person without mass unsubscribe
  if (structural.hasReplySubject && !structural.hasMailingListUnsubscribe && !sender.isAutomatedSender) {
    score += 20;
    reasons.push('Direct individual reply in an ongoing conversation');
  }

  // 3. Category Contextual Contribution (+5 to +15)
  // Provides modest contextual boost if category is recognized with good evidence
  if (categoryResult.categoryScore >= 35) {
    if (primaryCat === 'career_placement' || primaryCat === 'academic_education') {
      score += 10;
      reasons.push(`Contextual category alignment: ${primaryCat.replace('_', ' ')}`);
    } else if (primaryCat === 'finance_banking' || primaryCat === 'legal_government' || primaryCat === 'travel_transport') {
      score += 10;
      reasons.push(`Contextual category alignment: ${primaryCat.replace('_', ' ')}`);
    } else if (primaryCat === 'events_meetings' || primaryCat === 'shopping_orders') {
      score += 5;
      reasons.push(`Contextual category alignment: ${primaryCat.replace('_', ' ')}`);
    }
  }

  // 4. Institutional Sender / Domain Verification (+5 to +10)
  // Conservative: only adds value if relevant and not promotional
  if (primaryCat !== 'newsletters_promotions') {
    if (sender.isAcademicDomain && (primaryCat === 'academic_education' || primaryCat === 'career_placement' || isExamOrGrade)) {
      score += 10;
      reasons.push('Verified institutional academic domain (.edu / university)');
    } else if (sender.isGovernmentDomain) {
      score += 10;
      reasons.push('Verified official government domain (.gov / nic)');
    }
  }

  // 5. Explicit Formal Action Request (+10)
  if (content.hasExplicitActionRequest && primaryCat !== 'newsletters_promotions') {
    score += 10;
    reasons.push('Explicit action or submission requested');
  }

  // 6. Mass-Distribution & Promotional Moderation (-15 to -40)
  if (structural.hasMailingListUnsubscribe) {
    // If not a high-stakes personal milestone like offer or bank statement, apply moderate broadcast penalty
    if (!content.hasOfferPattern && !isFinancialMilestone) {
      score -= 20;
      reasons.push('Broadcast mailing list / mass distribution (adjusted)');
    } else {
      score -= 10;
      reasons.push('Automated dispatch via distribution list');
    }
  }

  if (sender.isAutomatedSender && !structural.hasReplySubject && !content.hasOfferPattern && !isFinancialMilestone) {
    score -= 5;
  }

  // Promotional or Marketing Suppression
  if (primaryCat === 'newsletters_promotions' || content.promotionalKeywords.length >= 2) {
    score -= 35;
    reasons.push('Promotional or marketing content (suppressed)');
  }

  // Clamp final score strictly between 0 and 100
  const importanceScore = Math.max(0, Math.min(100, Math.round(score)));

  // If no reasons were recorded, state default baseline
  if (reasons.length === 0) {
    reasons.push('Standard informational email with neutral importance evidence');
  }

  return {
    importanceScore,
    importanceReasons: reasons,
  };
}
