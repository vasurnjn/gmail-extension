import { EmailRecord } from '../../shared/types';
import { CategoryEvidence, CategoryResult, EmailSignals } from './types';

// Minimum qualifying evidence threshold for a category to be selected
const DEFAULT_QUALIFYING_THRESHOLD = 40;

function evaluateCareerPlacement(signals: EmailSignals, record: EmailRecord): CategoryEvidence {
  let score = 0;
  const reasons: string[] = [];
  const subjectLower = record.subject.toLowerCase();

  // 1. Contextual Pattern: Job Offer & Celebratory Selection (Super Dream Offer, Dream Offer, Offer Letter)
  if (signals.content.hasOfferPattern) {
    score += 55;
    if (/super\s+dream\s+offer/i.test(subjectLower)) {
      reasons.push('Job offer notification: Super Dream Offer selection');
    } else if (/\bdream\s+offer/i.test(subjectLower)) {
      reasons.push('Job offer notification: Dream Offer selection');
    } else if (/\boffer\s+letter/i.test(subjectLower)) {
      reasons.push('Official offer letter correspondence');
    } else {
      reasons.push('Job offer announcement or celebratory selection detected');
    }
  }

  // 2. Contextual Pattern: Candidate Selection & Shortlisting
  if (signals.content.hasSelectionPattern) {
    score += 35;
    reasons.push('Candidate selection or shortlisting results indicated');
  }

  // 3. Contextual Pattern: Campus Recruitment Drive & Pre-Placement Talk (PPT)
  if (signals.content.hasCampusDrivePattern) {
    score += 35;
    if (/\bppt\b/i.test(subjectLower)) {
      reasons.push('Pre-placement talk (PPT) and campus recruitment schedule');
    } else {
      reasons.push('Campus recruitment or placement drive process');
    }
  }

  // 4. Contextual Pattern: Assessment Workflow & Technical/Interview Rounds
  if (signals.content.hasAssessmentWorkflowPattern) {
    score += 30;
    reasons.push('Recruitment assessment or interview workflow scheduled');
  }

  // 5. Subject line keywords (recruitment, placement, interview, assessment, internship, hiring, etc.)
  const subjectMatches = signals.content.recruitmentKeywords.filter((kw) =>
    subjectLower.includes(kw.toLowerCase())
  );
  if (subjectMatches.length > 0) {
    score += 35 + Math.min(20, (subjectMatches.length - 1) * 10);
    reasons.push(`Subject contains recruitment keywords: ${subjectMatches.slice(0, 3).join(', ')}`);
  }

  // 6. Additional body content keywords
  const totalKeywords = signals.content.recruitmentKeywords;
  if (totalKeywords.length > 0) {
    const additional = totalKeywords.filter((kw) => !subjectMatches.includes(kw));
    if (additional.length > 0) {
      const boost = Math.min(25, additional.length * 8);
      score += boost;
      reasons.push(`Content matches career terms: ${additional.slice(0, 3).join(', ')}`);
    } else if (totalKeywords.length >= 2 && subjectMatches.length === 0) {
      score += 15;
      reasons.push(`Multiple recruitment signals detected: ${totalKeywords.slice(0, 3).join(', ')}`);
    }
  }

  // 7. Action verb synergy (e.g. "complete your assessment", "apply for role", "attend drive")
  const relevantActions = signals.content.actionVerbs.filter((v) =>
    ['apply', 'register', 'attend', 'complete', 'submit'].includes(v)
  );
  const hasCareerContext =
    totalKeywords.length > 0 ||
    signals.content.hasOfferPattern ||
    signals.content.hasSelectionPattern ||
    signals.content.hasCampusDrivePattern ||
    signals.content.hasAssessmentWorkflowPattern;

  if (relevantActions.length > 0 && hasCareerContext) {
    score += 15;
    reasons.push(`Action request combined with recruitment context: ${relevantActions.join(', ')}`);
  }

  return { category: 'career_placement', score: Math.min(100, score), reasons };
}

function evaluateFinanceBanking(signals: EmailSignals, record: EmailRecord): CategoryEvidence {
  let score = 0;
  const reasons: string[] = [];
  const subjectLower = record.subject.toLowerCase();
  const domainLower = signals.sender.domain.toLowerCase();

  // Banking / Financial domain hint
  if (/bank|pay|finance|card|invest|credit/i.test(domainLower)) {
    score += 15;
    reasons.push(`Sender domain suggests financial service: ${signals.sender.domain}`);
  }

  // Subject finance keywords
  const subjectMatches = signals.content.financeKeywords.filter((kw) =>
    subjectLower.includes(kw.toLowerCase())
  );
  if (subjectMatches.length > 0) {
    score += 40;
    reasons.push(`Subject highlights financial transaction or statement: ${subjectMatches.slice(0, 3).join(', ')}`);
  }

  // Content finance terms
  const bodyMatches = signals.content.financeKeywords.filter((kw) => !subjectMatches.includes(kw));
  if (bodyMatches.length > 0) {
    const boost = Math.min(30, bodyMatches.length * 10);
    score += boost;
    reasons.push(`Content references banking/billing terms: ${bodyMatches.slice(0, 3).join(', ')}`);
  }

  // Financial action synergy (e.g. "pay your bill", "verify transaction", "download statement")
  const hasFinanceAction = signals.content.actionVerbs.some((v) =>
    ['pay', 'verify', 'download', 'confirm'].includes(v)
  );
  if (hasFinanceAction && (subjectMatches.length > 0 || bodyMatches.length >= 2)) {
    score += 20;
    reasons.push('Action verb paired with financial context');
  }

  return { category: 'finance_banking', score: Math.min(100, score), reasons };
}

function evaluateAcademicEducation(signals: EmailSignals, record: EmailRecord): CategoryEvidence {
  let score = 0;
  const reasons: string[] = [];
  const subjectLower = record.subject.toLowerCase();

  // Academic domain booster (.edu, .ac.in, etc.)
  if (signals.sender.isAcademicDomain) {
    score += 30;
    reasons.push(`Sender from educational institution: ${signals.sender.domain}`);
  }

  // Subject academic terms
  const subjectMatches = signals.content.academicKeywords.filter((kw) =>
    subjectLower.includes(kw.toLowerCase())
  );
  if (subjectMatches.length > 0) {
    score += 40;
    reasons.push(`Subject contains academic update: ${subjectMatches.slice(0, 3).join(', ')}`);
  }

  // Content academic keywords
  const bodyMatches = signals.content.academicKeywords.filter((kw) => !subjectMatches.includes(kw));
  if (bodyMatches.length > 0) {
    const boost = Math.min(25, bodyMatches.length * 8);
    score += boost;
    reasons.push(`Content matches course/academic terms: ${bodyMatches.slice(0, 3).join(', ')}`);
  }

  // Academic deadlines / submissions
  const hasSubmissionAction = signals.content.actionVerbs.some((v) =>
    ['submit', 'register', 'complete', 'download'].includes(v)
  );
  if (hasSubmissionAction && (subjectMatches.length > 0 || bodyMatches.length > 0)) {
    score += 15;
    reasons.push('Actionable academic submission or requirement');
  }

  return { category: 'academic_education', score: Math.min(100, score), reasons };
}

function evaluateEventsMeetings(signals: EmailSignals, record: EmailRecord): CategoryEvidence {
  let score = 0;
  const reasons: string[] = [];
  const subjectLower = record.subject.toLowerCase();

  const subjectMatches = signals.content.eventKeywords.filter((kw) =>
    subjectLower.includes(kw.toLowerCase())
  );
  if (subjectMatches.length > 0) {
    score += 40;
    reasons.push(`Subject indicates event or meeting: ${subjectMatches.join(', ')}`);
  }

  const bodyMatches = signals.content.eventKeywords.filter((kw) => !subjectMatches.includes(kw));
  if (bodyMatches.length > 0) {
    const boost = Math.min(30, bodyMatches.length * 10);
    score += boost;
    reasons.push(`Content details scheduled meeting/event: ${bodyMatches.slice(0, 3).join(', ')}`);
  }

  // Direct video meet links or calendar RSVP indicators
  if (
    signals.content.eventKeywords.some((k) =>
      ['zoom link', 'google meet', 'calendar invite', 'rsvp'].includes(k)
    )
  ) {
    score += 25;
    reasons.push('Contains virtual conference link or calendar RSVP');
  }

  // If calendar invite / meet is explicitly within a recruitment/interview drive context,
  // event score remains high (multi-category evidence) but doesn't override career category
  if (signals.content.recruitmentKeywords.length >= 2) {
    score = Math.min(60, score);
  }

  return { category: 'events_meetings', score: Math.min(100, score), reasons };
}

function evaluateHealthcare(signals: EmailSignals, record: EmailRecord): CategoryEvidence {
  let score = 0;
  const reasons: string[] = [];
  const subjectLower = record.subject.toLowerCase();

  const subjectMatches = signals.content.healthcareKeywords.filter((kw) =>
    subjectLower.includes(kw.toLowerCase())
  );
  if (subjectMatches.length > 0) {
    score += 40;
    reasons.push(`Subject contains medical/health terms: ${subjectMatches.join(', ')}`);
  }

  const bodyMatches = signals.content.healthcareKeywords.filter((kw) => !subjectMatches.includes(kw));
  if (bodyMatches.length > 0) {
    const boost = Math.min(30, bodyMatches.length * 10);
    score += boost;
    reasons.push(`Content matches healthcare references: ${bodyMatches.slice(0, 3).join(', ')}`);
  }

  // Combination requirement: "appointment" alone is ambiguous. Must be paired with medical terms!
  const hasMedicalSpecifics = [...subjectMatches, ...bodyMatches].some((k) =>
    ['doctor', 'clinic', 'hospital', 'prescription', 'lab test', 'lab report', 'health checkup', 'diagnostic report', 'patient', 'medical examination', 'vaccination'].includes(k)
  );

  if (hasMedicalSpecifics) {
    score += 25;
    reasons.push('Verified specific medical/clinical context');
  } else if (score > 0 && !hasMedicalSpecifics) {
    // Penalize isolated "appointment" if no medical context exists
    score = Math.min(20, score);
  }

  return { category: 'healthcare', score: Math.min(100, score), reasons };
}

function evaluateLegalGovernment(signals: EmailSignals, record: EmailRecord): CategoryEvidence {
  let score = 0;
  const reasons: string[] = [];
  const subjectLower = record.subject.toLowerCase();

  // Government domain (.gov, .nic.in, etc.)
  if (signals.sender.isGovernmentDomain) {
    score += 40;
    reasons.push(`Sender from official government domain: ${signals.sender.domain}`);
  }

  const subjectMatches = signals.content.legalGovKeywords.filter((kw) =>
    subjectLower.includes(kw.toLowerCase())
  );
  if (subjectMatches.length > 0) {
    score += 40;
    reasons.push(`Subject contains official legal or statutory notice: ${subjectMatches.join(', ')}`);
  }

  const bodyMatches = signals.content.legalGovKeywords.filter((kw) => !subjectMatches.includes(kw));
  if (bodyMatches.length > 0) {
    const boost = Math.min(25, bodyMatches.length * 10);
    score += boost;
    reasons.push(`Content references legal/governmental procedures: ${bodyMatches.slice(0, 3).join(', ')}`);
  }

  return { category: 'legal_government', score: Math.min(100, score), reasons };
}

function evaluateTravelTransport(signals: EmailSignals, record: EmailRecord): CategoryEvidence {
  let score = 0;
  const reasons: string[] = [];
  const subjectLower = record.subject.toLowerCase();

  const subjectMatches = signals.content.travelKeywords.filter((kw) =>
    subjectLower.includes(kw.toLowerCase())
  );
  if (subjectMatches.length > 0) {
    score += 45;
    reasons.push(`Subject specifies travel itinerary: ${subjectMatches.join(', ')}`);
  }

  const bodyMatches = signals.content.travelKeywords.filter((kw) => !subjectMatches.includes(kw));
  if (bodyMatches.length > 0) {
    const boost = Math.min(30, bodyMatches.length * 10);
    score += boost;
    reasons.push(`Content mentions travel booking details: ${bodyMatches.slice(0, 3).join(', ')}`);
  }

  // PNR, boarding pass or e-ticket
  if (
    signals.content.travelKeywords.some((k) =>
      ['pnr', 'boarding pass', 'e-ticket', 'web check-in'].includes(k)
    )
  ) {
    score += 25;
    reasons.push('Contains passenger reservation code or boarding credential');
  }

  return { category: 'travel_transport', score: Math.min(100, score), reasons };
}

function evaluateShoppingOrders(signals: EmailSignals, record: EmailRecord): CategoryEvidence {
  let score = 0;
  const reasons: string[] = [];
  const subjectLower = record.subject.toLowerCase();

  const subjectMatches = signals.content.shoppingKeywords.filter((kw) =>
    subjectLower.includes(kw.toLowerCase())
  );
  if (subjectMatches.length > 0) {
    score += 45;
    reasons.push(`Subject details order fulfillment: ${subjectMatches.join(', ')}`);
  }

  const bodyMatches = signals.content.shoppingKeywords.filter((kw) => !subjectMatches.includes(kw));
  if (bodyMatches.length > 0) {
    const boost = Math.min(30, bodyMatches.length * 10);
    score += boost;
    reasons.push(`Content contains delivery/shipping updates: ${bodyMatches.slice(0, 3).join(', ')}`);
  }

  // Order tracking specific
  if (
    signals.content.shoppingKeywords.some((k) =>
      ['track package', 'tracking number', 'out for delivery', 'package delivered'].includes(k)
    )
  ) {
    score += 25;
    reasons.push('Direct package tracking status');
  }

  return { category: 'shopping_orders', score: Math.min(100, score), reasons };
}

function evaluateNewslettersPromotions(signals: EmailSignals, record: EmailRecord): CategoryEvidence {
  let score = 0;
  const reasons: string[] = [];
  const subjectLower = record.subject.toLowerCase();

  // Promotional keywords in subject (e.g. "20% off", "Sale ends")
  const subjectMatches = signals.content.promotionalKeywords.filter((kw) =>
    subjectLower.includes(kw.toLowerCase())
  );
  if (subjectMatches.length > 0) {
    score += 40;
    reasons.push(`Subject highlights promotional offer: ${subjectMatches.join(', ')}`);
  }

  const bodyMatches = signals.content.promotionalKeywords.filter((kw) => !subjectMatches.includes(kw));
  if (bodyMatches.length > 0) {
    const boost = Math.min(25, bodyMatches.length * 8);
    score += boost;
    reasons.push(`Content includes marketing terms: ${bodyMatches.slice(0, 3).join(', ')}`);
  }

  // Unsubscribe / mailing list header
  if (signals.structural.hasMailingListUnsubscribe) {
    score += 25;
    reasons.push('Contains mass-mailing unsubscribe or preference management link');
  }

  // Gmail Label (evidence only, not ground truth)
  if (signals.structural.gmailLabels.includes('CATEGORY_PROMOTIONS')) {
    score += 20;
    reasons.push('Gmail label flagged as promotional');
  }

  return { category: 'newsletters_promotions', score: Math.min(100, score), reasons };
}

function evaluatePersonalDirect(signals: EmailSignals, record: EmailRecord): CategoryEvidence {
  let score = 0;
  const reasons: string[] = [];

  // Personal emails cannot be automated or have mailing list footers
  if (signals.sender.isAutomatedSender) {
    return { category: 'personal', score: 0, reasons };
  }

  if (signals.structural.hasMailingListUnsubscribe || signals.structural.hasAutomatedDisclaimer) {
    return { category: 'personal', score: 0, reasons };
  }

  // Cannot have strong promotional keywords
  if (signals.content.promotionalKeywords.length > 0) {
    return { category: 'personal', score: 0, reasons };
  }

  // Conversational reply (Re:, Fwd:) from a standard mail provider
  if (signals.structural.hasReplySubject) {
    score += 35;
    reasons.push('Direct conversational reply thread (Re:/Fwd:)');
  }

  // Major consumer mail provider or direct private domain
  if (signals.sender.isMajorFreeMail) {
    score += 25;
    reasons.push(`Sender from consumer mail provider: ${signals.sender.domain}`);
  }

  // Small recipient count
  const recipientCount = Array.isArray(record.to) ? record.to.length : 1;
  if (recipientCount <= 2) {
    score += 20;
    reasons.push('Direct communication to individual recipient');
  }

  // Informal or direct greeting/sign-off signals
  const body = record.bodyTextPreview.toLowerCase();
  if (/^(hi|hello|hey|dear)\s+[a-z]+/im.test(body) || /(thanks|regards|cheers|best),\s*$/im.test(body)) {
    score += 15;
    reasons.push('Direct interpersonal greeting or signoff');
  }

  return { category: 'personal', score: Math.min(100, score), reasons };
}

/**
 * Deterministic Category Classifier.
 * Evaluates combination-based evidence across all categories, preserves competing scores,
 * and identifies the primary category or marks as 'uncategorized'.
 */
export function classifyCategory(
  signals: EmailSignals,
  record: EmailRecord,
  qualifyingThreshold = DEFAULT_QUALIFYING_THRESHOLD
): CategoryResult {
  const evaluations: CategoryEvidence[] = [
    evaluateCareerPlacement(signals, record),
    evaluateFinanceBanking(signals, record),
    evaluateAcademicEducation(signals, record),
    evaluateEventsMeetings(signals, record),
    evaluateHealthcare(signals, record),
    evaluateLegalGovernment(signals, record),
    evaluateTravelTransport(signals, record),
    evaluateShoppingOrders(signals, record),
    evaluateNewslettersPromotions(signals, record),
    evaluatePersonalDirect(signals, record),
  ];

  const categoryScores: Record<string, number> = {};
  const allEvidence: Record<string, string[]> = {};

  for (const ev of evaluations) {
    categoryScores[ev.category] = ev.score;
    allEvidence[ev.category] = ev.reasons;
  }

  // Sort descending by evidence score
  const sorted = [...evaluations].sort((a, b) => b.score - a.score);
  const best = sorted[0];

  // If no category reaches the qualifying evidence threshold, mark as uncategorized
  if (!best || best.score < qualifyingThreshold) {
    return {
      category: 'uncategorized',
      categoryScore: best ? best.score : 0,
      confidence: 0,
      detectionReasons: ['Insufficient distinct evidence to assign a definitive category'],
      categoryScores,
      allEvidence,
    };
  }

  // Category with highest evidence score qualifies as primary
  const confidence = Math.min(1, Math.round((best.score / 100) * 100) / 100);

  return {
    category: best.category,
    categoryScore: best.score,
    confidence,
    detectionReasons: best.reasons,
    categoryScores,
    allEvidence,
  };
}
