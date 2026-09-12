import { EmailRecord } from '../../shared/types';
import { ContentSignals, EmailSignals, SenderSignals, StructuralSignals } from './types';

// Word-boundary helper to avoid partial substring matching (e.g. "exam" matching "example")
function findMatchingKeywords(text: string, keywords: string[]): string[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  const matched: string[] = [];

  for (const kw of keywords) {
    const kwLower = kw.toLowerCase();
    // Escape any regex special characters in the keyword
    const escaped = kwLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // If keyword contains special characters (like % or symbols), boundary \b might need flexible handling
    const pattern = /\w/.test(kwLower.charAt(0)) && /\w/.test(kwLower.charAt(kwLower.length - 1))
      ? new RegExp(`\\b${escaped}\\b`, 'i')
      : new RegExp(escaped, 'i');

    if (pattern.test(lower)) {
      matched.push(kw);
    }
  }

  return matched;
}

const ACTION_VERBS = [
  'register', 'apply', 'submit', 'pay', 'confirm', 'attend', 'verify',
  'complete', 'review', 'download', 'schedule', 'rsvp', 'renew', 'respond'
];

const RECRUITMENT_KEYWORDS = [
  'placement', 'recruitment', 'campus drive', 'interview', 'assessment',
  'eligibility', 'shortlist', 'job offer', 'internship', 'hiring',
  'aptitude test', 'selection process', 'ctc', 'job description',
  'career opportunity', 'application status', 'coding round', 'online assessment',
  'recruitment drive', 'placement drive', 'offer letter', 'dream offer',
  'super dream offer', 'stipend', 'pre-placement talk'
];

const FINANCE_KEYWORDS = [
  'bank', 'account statement', 'transaction', 'credit card', 'debit card',
  'payment due', 'invoice', 'receipt', 'salary', 'tax invoice', 'emi',
  'otp', 'account balance', 'wire transfer', 'direct deposit', 'billing',
  'remittance', 'net banking', 'fund transfer', 'account credited', 'account debited'
];

const ACADEMIC_KEYWORDS = [
  'exam', 'examination', 'hall ticket', 'admit card', 'assignment',
  'course enrollment', 'syllabus', 'semester', 'thesis', 'scholarship',
  'grade report', 'marksheet', 'tuition fee', 'faculty', 'professor',
  'lecture notes', 'university notice', 'curriculum', 'grade'
];

const EVENT_KEYWORDS = [
  'calendar invite', 'webinar', 'conference', 'rsvp', 'meeting agenda',
  'zoom link', 'google meet', 'scheduled call', 'invitation', 'meeting invite',
  'team sync', 'virtual event'
];

const HEALTHCARE_KEYWORDS = [
  'appointment', 'doctor', 'clinic', 'hospital', 'prescription',
  'lab test', 'lab report', 'health checkup', 'diagnostic report',
  'patient', 'medical examination', 'vaccination'
];

const LEGAL_GOV_KEYWORDS = [
  'passport', 'visa application', 'tax filing', 'court notice',
  'kyc verification', 'government portal', 'affidavit', 'consulate',
  'legal notice', 'notary', 'statutory', 'income tax department'
];

const TRAVEL_KEYWORDS = [
  'flight booking', 'boarding pass', 'pnr', 'airline', 'train ticket',
  'hotel reservation', 'web check-in', 'itinerary', 'e-ticket', 'departure'
];

const SHOPPING_KEYWORDS = [
  'order confirmed', 'order placed', 'shipped', 'out for delivery',
  'package delivered', 'track package', 'dispatch', 'tracking number',
  'return request', 'replacement order', 'delivery status'
];

const PROMOTIONAL_KEYWORDS = [
  'unsubscribe', 'promo code', 'discount', 'percent off', '% off',
  'sale ends', 'limited time offer', 'weekly digest', 'newsletter',
  'special deal', 'coupon code', 'clearance sale', 'black friday',
  'exclusive offer', 'flash sale'
];

const FREE_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com',
  'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'icloud.com', 'me.com', 'mac.com', 'proton.me', 'protonmail.com',
  'aol.com', 'zoho.com', 'mail.com', 'gmx.com'
]);

const AUTOMATED_PREFIXES = [
  'no-reply', 'noreply', 'do-not-reply', 'donotreply',
  'mailer-daemon', 'notifications', 'notification',
  'alerts', 'alert', 'updates', 'update', 'info',
  'support', 'billing', 'news', 'newsletter', 'orders',
  'system', 'automated', 'service', 'team'
];

export function extractSenderSignals(fromHeader: string, fromDomain: string): SenderSignals {
  const emailMatch = fromHeader.match(/<([^>]+)>/) || fromHeader.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
  const senderEmail = emailMatch ? emailMatch[1].toLowerCase().trim() : fromHeader.toLowerCase().trim();

  let senderName = '';
  if (fromHeader.includes('<')) {
    senderName = fromHeader.split('<')[0].replace(/["']/g, '').trim();
  } else {
    senderName = fromHeader.trim();
  }

  const domain = (fromDomain || (senderEmail.includes('@') ? senderEmail.split('@')[1] : '')).toLowerCase().trim();

  const userPart = senderEmail.includes('@') ? senderEmail.split('@')[0].toLowerCase() : '';

  const isAutomatedSender = AUTOMATED_PREFIXES.some(prefix =>
    userPart === prefix || userPart.startsWith(`${prefix}-`) || userPart.startsWith(`${prefix}.`) || userPart.startsWith(`${prefix}_`)
  );

  const isAcademicDomain = /\.(edu|ac\.[a-z]{2}|edu\.[a-z]{2})$/i.test(domain);
  const isGovernmentDomain = /\.(gov|gov\.[a-z]{2}|nic\.in|mil)$/i.test(domain);
  const isMajorFreeMail = FREE_MAIL_DOMAINS.has(domain);

  return {
    senderEmail,
    senderName,
    domain,
    isAutomatedSender,
    isAcademicDomain,
    isGovernmentDomain,
    isMajorFreeMail,
  };
}

export function extractContentSignals(combinedText: string): ContentSignals {
  // Check for commercial discount context to guard against promotional offers
  const hasCommercialDiscount = /\b(discount|% off|promo code|coupon|clearance sale|sale ends)\b/i.test(combinedText);

  // 1. Offer patterns: "super dream offer", "dream offer", "job offer", "offer letter", or "congratulations" + "offer/selection"
  const hasExplicitOfferPhrase = /\b(super\s+dream|dream|job|placement|internship|employment)\s+offer\b/i.test(combinedText) ||
    /\boffer\s+letter\b/i.test(combinedText);
  const hasCongratsWithOfferOrSelect = /\b(congratulations|congrats)\b/i.test(combinedText) &&
    /\b(offer|selected|selection|placed|shortlisted|shortlist)\b/i.test(combinedText);
  const hasOfferPattern = (hasExplicitOfferPhrase || hasCongratsWithOfferOrSelect) && !hasCommercialDiscount;

  // 2. Selection patterns: "selection process", "selection list", "final selection", "selected candidates", "shortlisted for"
  const hasSelectionPattern = /\b(selection\s+(process|list|results|round)|final\s+selection|selected\s+(candidates|students|for)|shortlisted\s+(candidates|students|for))\b/i.test(combinedText);

  // 3. Campus drive patterns: "campus drive", "recruitment drive", "placement drive", "pre-placement talk", or "PPT" + hiring context
  const hasExplicitDrivePhrase = /\b(campus\s+drive|recruitment\s+drive|placement\s+drive|hiring\s+drive|pool\s+campus|on-campus\s+drive)\b/i.test(combinedText) ||
    /\bpre-placement\s+talk\b/i.test(combinedText);
  const hasPptWithHiring = /\bppt\b/i.test(combinedText) && /\b(selection|placement|drive|interview|hiring|company|recruitment)\b/i.test(combinedText);
  const hasCampusDrivePattern = hasExplicitDrivePhrase || hasPptWithHiring;

  // 4. Assessment workflow patterns: "coding round", "online assessment", "aptitude test", "technical round", "interview schedule"
  const hasAssessmentWorkflowPattern = /\b(coding\s+round|online\s+assessment|aptitude\s+test|technical\s+(round|interview)|interview\s+(schedule|slot|round)|eligibility\s+criteria)\b/i.test(combinedText);

  // 5. Phase 2 Urgency & temporal patterns
  const hasImminentDeadline = /\b(today|tonight|immediately|urgent\s+action\s+required|within\s+(?:[1-9]|1[0-9]|2[0-4])\s*(?:hours?|hrs?)|by\s+(?:end\s+of\s+day|eod)|closes\s+today|expiring\s+today|last\s+day\s+today|few\s+hours\s+left)\b/i.test(combinedText);

  const hasUpcomingDeadline = /\b(tomorrow|deadline\s+is|due\s+date|last\s+date\s+to|registration\s+closes|submission\s+deadline|application\s+deadline|latest\s+by|respond\s+by|complete\s+by|submit\s+before|valid\s+until|within\s+(?:48\s*hours?|2\s*days?|3\s*days?))\b/i.test(combinedText);

  const hasDisruptionLanguage = /\b(flight\s+cancelled|cancelled|delayed|rescheduled|postponed|security\s+alert|unauthorized\s+access|suspicious\s+activity|service\s+disruption|password\s+reset\s+request|account\s+locked)\b/i.test(combinedText);

  // Scheduled-event language without arbitrary date parsing (e.g. "scheduled on 17th September", "interview on Friday", "PPT scheduled on...")
  const hasScheduledEvent = /\b(?:(?:is\s+)?scheduled\s+(?:on|for|at)|(?:interview|assessment|test|round|drive|ppt|session|webinar|meeting|presentation|call)\s+(?:is\s+)?(?:scheduled|to\s+be\s+held|taking\s+place)|(?:interview|assessment|test|round|drive|ppt|session|webinar|meeting|presentation)\s+on\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}(?:st|nd|rd|th)?\s+[a-z]+|[a-z]+\s+\d{1,2}(?:st|nd|rd|th)?))\b/i.test(combinedText);

  // Actionable requirement context (registration required, application submission, assessment instructions, attendance, response)
  const hasActionableContext = /\b(?:action\s+(?:required|needed)|(?:registration|application|submission|confirmation|response|attendance)\s+(?:is\s+)?(?:required|mandatory|needed|requested)|mandatory\s+(?:registration|attendance|submission|application)|(?:internship|drive|process|webinar|session|event|round):\s*(?:registration|application)|please\s+(?:register|apply|submit|confirm|attend|fill|verify|upload|respond|complete|pay)|(?:students\s+|all\s+|candidates\s+)?must\s+(?:register|apply|submit|attend|fill|confirm|complete|verify)|required\s+to\s+(?:attend|submit|register|fill|apply|confirm)|fill\s+(?:out\s+)?(?:the|this)\s+form|confirm\s+(?:your\s+)?(?:attendance|participation)|verify\s+your\s+account|sign\s+and\s+return|registration\s+(?:link|form|details|is\s+open)|link\s+to\s+(?:register|apply|submit)|application\s+(?:link|form|deadline|details)|instructions\s+for\s+(?:assessment|test|interview)|instructions\s+to\s+(?:join|attend|complete|submit))\b/i.test(combinedText) ||
    (hasAssessmentWorkflowPattern && /\b(?:link|portal|platform|login|start|join|complete\s+your)\b/i.test(combinedText));

  const hasExplicitActionRequest = hasActionableContext;

  const hasCommercialUrgency = /\b(hurry|hurry\s+up|limited\s+time\s+offer|sale\s+ends|flash\s+sale|while\s+supplies\s+last|don'?t\s+miss\s+out|deals\s+end|offer\s+expires\s+soon|prices\s+going\s+up|act\s+fast|last\s+chance\s+to\s+save|discount\s+ends|shop\s+now\s+before)\b/i.test(combinedText);

  return {
    actionVerbs: findMatchingKeywords(combinedText, ACTION_VERBS),
    recruitmentKeywords: findMatchingKeywords(combinedText, RECRUITMENT_KEYWORDS),
    financeKeywords: findMatchingKeywords(combinedText, FINANCE_KEYWORDS),
    academicKeywords: findMatchingKeywords(combinedText, ACADEMIC_KEYWORDS),
    eventKeywords: findMatchingKeywords(combinedText, EVENT_KEYWORDS),
    healthcareKeywords: findMatchingKeywords(combinedText, HEALTHCARE_KEYWORDS),
    legalGovKeywords: findMatchingKeywords(combinedText, LEGAL_GOV_KEYWORDS),
    travelKeywords: findMatchingKeywords(combinedText, TRAVEL_KEYWORDS),
    shoppingKeywords: findMatchingKeywords(combinedText, SHOPPING_KEYWORDS),
    promotionalKeywords: findMatchingKeywords(combinedText, PROMOTIONAL_KEYWORDS),
    hasOfferPattern,
    hasSelectionPattern,
    hasCampusDrivePattern,
    hasAssessmentWorkflowPattern,
    hasImminentDeadline,
    hasUpcomingDeadline,
    hasDisruptionLanguage,
    hasExplicitActionRequest,
    hasCommercialUrgency,
    hasScheduledEvent,
    hasActionableContext,
  };
}

export function extractStructuralSignals(
  subject: string,
  bodyPreview: string,
  labels: string[] = []
): StructuralSignals {
  const combined = `${subject}\n${bodyPreview}`.toLowerCase();

  const hasMailingListUnsubscribe = /unsubscribe|opt[ -]?out|manage (preferences|subscription)/i.test(combined);
  const hasAutomatedDisclaimer = /do not reply|automated (message|email|system)|system generated|please do not reply/i.test(combined);
  const hasReplySubject = /^(re|fwd|fw):\s*/i.test(subject.trim());
  const hasUrls = /https?:\/\/|www\./i.test(bodyPreview);

  return {
    hasMailingListUnsubscribe,
    hasAutomatedDisclaimer,
    hasReplySubject,
    hasUrls,
    gmailLabels: labels,
  };
}

/**
 * Extracts structured signals from an EmailRecord without calling external services.
 */
export function extractSignals(record: EmailRecord): EmailSignals {
  const sender = extractSenderSignals(record.from, record.fromDomain);
  const combinedContent = `${record.from}\n${record.subject}\n\n${record.snippet}\n\n${record.bodyTextPreview}`;
  const content = extractContentSignals(combinedContent);
  const structural = extractStructuralSignals(record.subject, record.bodyTextPreview, record.labels || []);

  return {
    sender,
    content,
    structural,
    extractedAt: Date.now(),
  };
}
