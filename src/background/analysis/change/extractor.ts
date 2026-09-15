import { EmailRecord } from '../../../shared/types';
import { extractSenderSignals } from '../extractor';
import { EmailSignals } from '../types';
import { isTopicCompatible } from './compatibility';
import {
  EntityExtractionResult,
  ExtractionStatus,
  InvariantExtractionOutput,
  ReminderToneSignals,
  TopicExtractionResult,
  VenueExtractionResult,
} from './types';

// Free mail providers where domain must NEVER be used as company entity
const FREE_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com',
  'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'icloud.com', 'me.com', 'mac.com', 'proton.me', 'protonmail.com',
  'aol.com', 'zoho.com', 'mail.com', 'gmx.com',
]);

// Aggregator / bulk mailing / platform domains that act as couriers rather than company identity
const AGGREGATOR_DOMAIN_REGEX =
  /(?:mailchimp|sendgrid|sendinblue|amazonses|constantcontact|hubspot|salesforce|mailerlite|zoom|eventbrite|google|substack|medium|aggregator)\./i;

// Intermediary local-part keywords indicating campus placement or dispatch offices
const INTERMEDIARY_USER_REGEX =
  /^(?:placement|cdc|tpo|careers?|career[-_]?center|students?|admissions?|admin|noreply|no-reply|notifications?|updates?|mailer[-_]?daemon|support|info|news)$/i;

// Intermediary domain names that are generic dispatch services, not target companies
const INTERMEDIARY_DOMAINS = new Set([
  'aggregator', 'notifications', 'notification', 'mailer', 'dispatch',
  'system', 'updates', 'update', 'portal', 'services', 'service',
  'noreply', 'support', 'broadcast', 'mail', 'email', 'mailerdaemon',
]);

/**
 * Checks if a candidate word sequence is an invalid generic term rather than a company name.
 */
function isInvalidEntityName(name: string): boolean {
  if (!name) return true;
  const cleaned = name.toLowerCase().replace(/['’]s$/i, '').replace(/[^a-z0-9]/g, '');
  if (cleaned.length < 2) return true;

  const invalidRoots = new Set([
    'tomorrow', 'today', 'yesterday', 'day', 'week', 'month', 'year',
    'dear', 'urgent', 'reminder', 'important', 'notice', 'announcement',
    'update', 'schedule', 'please', 'all', 'students', 'candidates',
    'final', 'last', 'warning', 'attention', 're', 'fwd', 'fw',
    'super', 'dream', 'internship', 'placement', 'recruitment', 'ppt',
    'notification', 'portal', 'session', 'event', 'general', 'drive',
    'interview', 'assessment', 'test', 'exam', 'examination', 'hallticket',
    'course', 'details', 'link', 'form', 'info', 'information', 'online',
    'virtual', 'meeting', 'presentation', 'call', 'class', 'lecture',
    'report', 'immediately', 'action', 'required', 'mandatory', 'immediate',
    'selection', 'process', 'cdc', 'tpo', 'office', 'room', 'venue', 'hall',
    'batch', 'cohort', 'reg', 'regarding', 'note', 'kindly', 'attend',
    'participate', 'join', 'register', 'greetings', 'hello',
  ]);

  if (invalidRoots.has(cleaned)) return true;

  // Words list
  const words = name.toLowerCase().split(/\s+/).map(w => w.replace(/[^a-z0-9]/g, '')).filter(Boolean);
  if (words.length === 0) return true;

  // If candidate begins with action verbs or conversational words like "Kindly attend", "Please register"
  const leadingInvalidWords = new Set([
    'kindly', 'attend', 'please', 'join', 'register', 'participate', 'report',
    'note', 'regarding', 'reg', 'about', 'information', 'dear', 'hello', 'greetings',
    'urgent', 'important', 'immediate', 'mandatory', 'warning', 'attention',
  ]);
  if (leadingInvalidWords.has(words[0])) {
    return true;
  }

  // If every individual word in the candidate is an invalid root
  if (words.every(w => invalidRoots.has(w))) {
    return true;
  }

  // Intermediary office names like "CDC Office", "Placement Office"
  if (/^(?:cdc|placement|tpo|career[- ]?center)\s+office$/i.test(name.trim())) {
    return true;
  }

  return false;
}

/**
 * Normalizes an entity name into a clean canonical string.
 */
function canonicalizeEntity(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/^(?:the|a|an)\s+/i, '')
    .replace(/['.]/g, '')
    .replace(/\s+(?:inc|llc|ltd|pvt\s+ltd|corp|corporation)$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Strips leading forward/reply/reminder prefixes from a subject string.
 */
function stripSubjectPrefixes(subject: string): string {
  let cleaned = (subject || '').trim();
  let prev = '';
  while (cleaned !== prev) {
    prev = cleaned;
    cleaned = cleaned
      // Strip leading brackets like [CDC], [Placement], [Urgent], [External]
      .replace(/^\[[^\]]*\]\s*/i, '')
      // Strip Fwd/Re prefixes: Re:, Fwd:, Fw:, 1:, etc.
      .replace(/^(?:(?:re|fwd|fw|\d+)\s*[:\-]\s*)+/i, '')
      // Strip action/urgency prefixes before a colon or hyphen (e.g. "Report immediately: ", "Action required: ")
      .replace(/^(?:report\s+immediately|report\s+now|action\s+required(?:\s+immediately)?|immediate(?:\s+attention)?|mandatory(?:\s+update)?|urgent(?:\s+update)?|important(?:\s+update)?)\s*[:\-]\s*/i, '')
      // Strip standard reminder/notice/alert prefixes
      .replace(/^(?:urgent\s+|gentle\s+|last\s+|final\s+|important\s+)?(?:reminder|notice|alert|announcement|update)\s*[:\-#]?\s*/i, '')
      .trim();
  }
  return cleaned;
}

/**
 * Extracts canonical organization/company entity from email.
 * Conservative safety rule: "When identity is uncertain, do not suppress."
 * Never invents an entity name; returns 'unknown' or 'ambiguous' when unsure.
 */
export function extractCanonicalEntity(
  record: EmailRecord,
  signals?: EmailSignals
): EntityExtractionResult {
  const evidence: string[] = [];
  const senderSignals = signals?.sender || extractSenderSignals(record.from, record.fromDomain);

  const subjectClean = stripSubjectPrefixes(record.subject);
  const primaryText = `${subjectClean}\n${record.snippet || ''}\n${record.bodyTextPreview || ''}`;

  // 1. Check for multiple generic company mentions (e.g. "Company A, Company B, and Company C")
  const genericCompanies = subjectClean.match(/\bCompany\s+[A-Z0-9]+\b/gi) || [];
  if (genericCompanies.length > 1) {
    evidence.push(`Multiple companies detected in subject: ${genericCompanies.join(', ')}`);
    return {
      canonicalEntity: null,
      entityStatus: 'ambiguous',
      rawEntity: genericCompanies.join(', '),
      evidence,
    };
  }

  // Check for consortium / joint drive / comma-separated entities in subject
  const competingMatch = /\b(?:consortium|joint\s+(?:drive|recruitment)|companies)\s*[:\-]\s*([A-Za-z0-9&.,\s]+)/i.exec(subjectClean);
  if (competingMatch && (competingMatch[1].includes(',') || /\band\b/i.test(competingMatch[1]))) {
    evidence.push(`Multiple competing entities in subject: '${competingMatch[1].trim()}'`);
    return {
      canonicalEntity: null,
      entityStatus: 'ambiguous',
      rawEntity: competingMatch[1].trim(),
      evidence,
    };
  }

  // 2. Explicit Subject Patterns (e.g. "Smart Data Solutions PPT...", "Ujjivan Small Finance Bank PPT and selection process...")
  // In recruitment/corporate emails, the organization name precedes event/drive keywords.
  const subjectOrgPattern =
    /(?:^|[:\-]\s+)([A-Z0-9][A-Za-z0-9&.'-]{1,35}(?:\s+[A-Z0-9][A-Za-z0-9&.'-]{1,35}){0,4}?)\s+(?:[-:]\s+)?(?:PPT|Pre[- ]Placement Talk|Super Dream|Dream Offer|Offer Letter|Selection List|Selection Process|Recruitment Drive|Placement Drive|Campus Drive|Hiring Drive|Internship|Recruitment|Assessment|Interview Schedule|Interview|Hackathon|Drive|Order\s*#|Flight\s+[A-Z0-9]+)\b/i;

  const subjectMatch = subjectOrgPattern.exec(subjectClean);
  if (subjectMatch) {
    const rawCandidate = subjectMatch[1].trim();
    if (!isInvalidEntityName(rawCandidate)) {
      const canonical = canonicalizeEntity(rawCandidate);
      evidence.push(`Subject leading entity match: '${rawCandidate}'`);
      return {
        canonicalEntity: canonical,
        entityStatus: 'known',
        rawEntity: rawCandidate,
        evidence,
      };
    }
  }

  // 3. Body/Snippet Organization Match (when subject has generic title like "Selection Process Schedule")
  const bodyText = `${record.snippet || ''}\n${record.bodyTextPreview || ''}`;
  const bodyOrgMatch = subjectOrgPattern.exec(bodyText);
  if (bodyOrgMatch) {
    const rawCandidate = bodyOrgMatch[1].trim();
    if (!isInvalidEntityName(rawCandidate)) {
      const canonical = canonicalizeEntity(rawCandidate);
      evidence.push(`Body organization match: '${rawCandidate}'`);
      return {
        canonicalEntity: canonical,
        entityStatus: 'known',
        rawEntity: rawCandidate,
        evidence,
      };
    }
  }

  // 4. Colon separator pattern: "McKinsey: Registration for Internship" or "Amazon - Order Confirmed"
  const colonPattern =
    /^([A-Z0-9][A-Za-z0-9&.'-]{1,35}(?:\s+[A-Z0-9][A-Za-z0-9&.'-]{1,35}){0,3}?)\s*[:\-]\s*(?:Registration|Schedule|Selection|Internship|PPT|Interview|Update|Announcement|Hackathon|Drive|Order)\b/i;
  const colonMatch = colonPattern.exec(subjectClean);
  if (colonMatch) {
    const rawCandidate = colonMatch[1].trim();
    if (!isInvalidEntityName(rawCandidate)) {
      const canonical = canonicalizeEntity(rawCandidate);
      evidence.push(`Subject colon prefix entity match: '${rawCandidate}'`);
      return {
        canonicalEntity: canonical,
        entityStatus: 'known',
        rawEntity: rawCandidate,
        evidence,
      };
    }
  }

  // 4. Explicit "Company A", "Company B", "Company 1" test/generic single patterns
  const genericCompanyMatch = /\b(Company\s+[A-Z0-9]+)\b/i.exec(subjectClean) ||
    /\b(Company\s+[A-Z0-9]+)\b/i.exec(record.snippet || '') ||
    /\b(Company\s+[A-Z0-9]+)\b/i.exec(record.bodyTextPreview || '');
  if (genericCompanyMatch) {
    const rawCandidate = genericCompanyMatch[1].trim();
    const canonical = canonicalizeEntity(rawCandidate);
    evidence.push(`Explicit generic company token match: '${rawCandidate}'`);
    return {
      canonicalEntity: canonical,
      entityStatus: 'known',
      rawEntity: rawCandidate,
      evidence,
    };
  }

  // 5. Explicit Event 'of' Entity or 'regarding' Entity Patterns in Subject or Body
  // e.g. "pre-placement talk of Smart Data Solutions", "PPT of Smart Data Solutions", "regarding Smart Data Solutions"
  const eventOfPattern =
    /\b(?:PPT|Pre[- ]Placement Talk|Campus Drive|Recruitment Drive|Placement Drive|Super Dream|Hiring Drive|drive|recruitment|presentation|session|talk|selection\s+process)\s+of\s+([A-Z0-9][A-Za-z0-9&.'-]{1,35}(?:\s+[A-Z0-9][A-Za-z0-9&.'-]{1,35}){0,4})\b/;
  const eventOfMatch = eventOfPattern.exec(subjectClean) || eventOfPattern.exec(primaryText);
  if (eventOfMatch) {
    const rawCandidate = eventOfMatch[1].trim();
    if (!isInvalidEntityName(rawCandidate)) {
      const canonical = canonicalizeEntity(rawCandidate);
      evidence.push(`Event 'of' entity match: '${rawCandidate}'`);
      return {
        canonicalEntity: canonical,
        entityStatus: 'known',
        rawEntity: rawCandidate,
        evidence,
      };
    }
  }

  const regardingPattern =
    /\b(?:regarding|reg\.?|about)\s+([A-Z0-9][A-Za-z0-9&.'-]{1,35}(?:\s+[A-Z0-9][A-Za-z0-9&.'-]{1,35}){0,4})\b/;
  const regardingMatch = regardingPattern.exec(subjectClean) || regardingPattern.exec(primaryText);
  if (regardingMatch) {
    const rawCandidate = regardingMatch[1].trim();
    if (!isInvalidEntityName(rawCandidate)) {
      const canonical = canonicalizeEntity(rawCandidate);
      evidence.push(`Regarding entity match: '${rawCandidate}'`);
      return {
        canonicalEntity: canonical,
        entityStatus: 'known',
        rawEntity: rawCandidate,
        evidence,
      };
    }
  }

  // 6. Content "for / with / at / by <Company>" pattern
  const prepositionPattern =
    /\b(?:for|with|at|by)\s+([A-Z0-9][A-Za-z0-9&.'-]{1,35}(?:\s+[A-Z0-9][A-Za-z0-9&.'-]{1,35}){0,4})(?:[.,\n]|\s+(?:PPT|drive|recruitment|interview|hackathon|session|presentation|scheduled|on\s+\d|at\s+\d))\b/;
  const prepositionMatch = prepositionPattern.exec(subjectClean) || prepositionPattern.exec(primaryText);
  if (prepositionMatch) {
    const rawCandidate = prepositionMatch[1].trim();
    if (!isInvalidEntityName(rawCandidate)) {
      const canonical = canonicalizeEntity(rawCandidate);
      evidence.push(`Preposition company cue in content: '${rawCandidate}'`);
      return {
        canonicalEntity: canonical,
        entityStatus: 'known',
        rawEntity: rawCandidate,
        evidence,
      };
    }
  }

  // 7. Authoritative Corporate Sender Domain (when not free-mail, aggregator, or academic)
  const domain = (senderSignals.domain || '').toLowerCase().trim();
  const isFree = FREE_MAIL_DOMAINS.has(domain);
  const isAggregator = AGGREGATOR_DOMAIN_REGEX.test(domain);
  const isIntermediaryUser = INTERMEDIARY_USER_REGEX.test(
    senderSignals.senderEmail.split('@')[0] || ''
  );

  if (
    domain &&
    !isFree &&
    !isAggregator &&
    !senderSignals.isAcademicDomain &&
    !senderSignals.isGovernmentDomain &&
    !isIntermediaryUser
  ) {
    // Extract base domain name (e.g. "recruiting.mckinsey.com" -> "mckinsey")
    const parts = domain.split('.');
    let baseName = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
    if (baseName === 'co' || baseName === 'com' || baseName === 'org' || baseName === 'ac' || baseName === 'edu') {
      baseName = parts.length >= 3 ? parts[parts.length - 3] : baseName;
    }
    if (
      baseName &&
      baseName.length >= 2 &&
      !INTERMEDIARY_DOMAINS.has(baseName.toLowerCase()) &&
      !isInvalidEntityName(baseName)
    ) {
      evidence.push(`Corporate sender domain evidence: '${domain}' -> '${baseName}'`);
      return {
        canonicalEntity: canonicalizeEntity(baseName),
        entityStatus: 'known',
        rawEntity: domain,
        evidence,
      };
    }
  }

  // 8. Fallback: No identifiable entity found
  evidence.push('No confident organization or corporate entity extracted');
  return {
    canonicalEntity: null,
    entityStatus: 'unknown',
    rawEntity: null,
    evidence,
  };
}

/**
 * Detects if a candidate token or string looks like a venue/room/building identifier.
 */
export function isVenueToken(token: string): boolean {
  if (!token) return false;
  const cleaned = token.trim();
  // Campus building codes with numbers (e.g. SJT706, SJT 706, TT302, MB101)
  if (/^(?:SJT|TT|MB|PRP|CDMM|SMV|GDN|CB|AB|TIFAC)\s*[-:]?\s*\d{3,4}[A-Za-z]?$/i.test(cleaned)) {
    return true;
  }
  // Room / Hall / Lab / Auditorium / Office
  if (/^(?:room|hall|lab|cabin|auditorium|block|venue|cdc\s+office|placement\s+office)\b/i.test(cleaned)) {
    return true;
  }
  return false;
}

/**
 * Detects if a candidate token or string is a generic non-course token
 * (cohort batch, rank/shortlist, standalone year, etc.).
 */
export function isGenericNonCourseToken(token: string): boolean {
  if (!token) return false;
  const cleaned = token.trim();
  // Batch 2027, Batch 2026, Class of 2027
  if (/^(?:batch|class\s+of)\s*\d{2,4}$/i.test(cleaned) || /^\d{4}\s*batch$/i.test(cleaned)) {
    return true;
  }
  // TOP100, TOP 100, TOP50, Rank 10
  if (/^(?:top|rank|score|shortlist|grade)\s*\d+$/i.test(cleaned)) {
    return true;
  }
  // Standalone 4-digit year (1990-2099)
  if (/^(?:19|20)\d{2}$/.test(cleaned)) {
    return true;
  }
  return false;
}

/**
 * Extracts a course identifier ONLY when contextual evidence confirms it is actually a course.
 * Conservative rule: Generic tokens, room numbers, building codes, batch years, and ranks
 * must NEVER become course identifiers without explicit course context.
 */
function extractCourseIdentifier(
  combinedText: string,
  subject: string,
  detectedVenue?: string | null
): string | null {
  // 1. Explicit Prefix Context: "Course CSE1001", "Course Code: CSE1001", "Subject: MAT2001", "Module: ECE2002"
  const prefixPattern =
    /\b(?:course(?:\s+code|\s+id|\s+no|\s+number)?|subject(?:\s+code)?|module)\s*[:\-#]?\s*([A-Za-z]{2,4}\s*\d{3,4}[A-Za-z]?)\b/i;
  const prefixMatch = prefixPattern.exec(subject) || prefixPattern.exec(combinedText);
  if (prefixMatch) {
    const candidate = prefixMatch[1].trim();
    if (!isVenueToken(candidate) && !isGenericNonCourseToken(candidate)) {
      if (!detectedVenue || !detectedVenue.toLowerCase().includes(candidate.toLowerCase())) {
        return `course_${candidate.replace(/\s+/g, '').toLowerCase()}`;
      }
    }
  }

  // 2. Explicit Postfix Course Title / Academic Descriptor Context:
  // e.g. "CSE1001 - Database Management Systems", "CSE1001: Database Management Systems"
  const titlePattern =
    /\b([A-Za-z]{2,4}\s*\d{3,4}[A-Za-z]?)\s*[:\-]\s*([A-Za-z][A-Za-z0-9\s]{3,35})\b/i;
  const titleMatches = [titlePattern.exec(subject), titlePattern.exec(combinedText)];
  for (const match of titleMatches) {
    if (match) {
      const candidate = match[1].trim();
      const descriptor = match[2].trim();
      if (!isVenueToken(candidate) && !isGenericNonCourseToken(candidate)) {
        if (
          !isVenueToken(descriptor) &&
          !/^(?:report|scheduled|tomorrow|today|venue|room|hall|held|conducted|starting|at\s+\d|on\s+\d)/i.test(descriptor) &&
          /\b(?:database|systems|structures|programming|algorithms|networks|management|calculus|physics|chemistry|engineering|computing|science|theory|lab|design)\b/i.test(descriptor)
        ) {
          return `course_${candidate.replace(/\s+/g, '').toLowerCase()}`;
        }
      }
    }
  }

  // 3. Academic Event Context: e.g. "CSE1001 Final Examination Schedule", "CSE1001 Midterm Exam"
  const examPattern =
    /\b([A-Za-z]{2,4}\s*\d{3,4}[A-Za-z]?)\s+(?:Final\s+Examination|Final\s+Exam|Examination|Exam|Midterm|Quiz|Theory\s+Exam|Lab\s+Exam)\b/i;
  const examMatch = examPattern.exec(subject) || examPattern.exec(combinedText);
  if (examMatch) {
    const candidate = examMatch[1].trim();
    if (!isVenueToken(candidate) && !isGenericNonCourseToken(candidate)) {
      return `course_${candidate.replace(/\s+/g, '').toLowerCase()}`;
    }
  }

  return null;
}

/**
 * Extracts explicit venue / location information conservatively.
 * Supports physical venues (SJT 706, SJT 717, TT 302, Room 101, Hall A, Auditorium)
 * and virtual venues (Zoom, Google Meet).
 */
export function extractVenue(record: EmailRecord): VenueExtractionResult {
  const evidence: string[] = [];
  const text = `${record.subject}\n${record.snippet || ''}\n${record.bodyTextPreview || ''}`;

  let physicalVenue: string | null = null;
  let virtualVenue: string | null = null;

  // 1. Campus Building + Room Codes:
  // SJT706, SJT 706, SJT-706, SJT717, SJT 717, TT302, TT 302, MB 101, PRP 204
  const buildingRoomPattern =
    /\b((?:SJT|TT|MB|PRP|CDMM|SMV|GDN|CB|AB|TIFAC)\s*[-:]?\s*\d{3,4}[A-Za-z]?)\b/i;
  const buildingMatch = buildingRoomPattern.exec(text);
  if (buildingMatch) {
    const raw = buildingMatch[1].trim();
    physicalVenue = raw.replace(/^([A-Za-z]+)\s*[-:]?\s*(\d+.*)$/, '$1 $2').toUpperCase();
    evidence.push(`Building/room match: '${physicalVenue}'`);
  }

  // 2. Room / Hall / Lab / Facility Patterns:
  // Room 101, Room SJT717, Hall A, Main Lab, Auditorium
  const roomPattern = /\b(Room\s*(?:no\.?|number)?\s*[-:]?\s*[A-Za-z0-9\s-]{1,15})\b/i;
  const roomMatch = roomPattern.exec(text);
  if (roomMatch && !physicalVenue) {
    const raw = roomMatch[1].trim();
    const bldgInner = buildingRoomPattern.exec(raw);
    if (bldgInner) {
      physicalVenue = bldgInner[1].replace(/^([A-Za-z]+)\s*[-:]?\s*(\d+.*)$/, '$1 $2').toUpperCase();
    } else {
      physicalVenue = raw;
    }
    evidence.push(`Room label match: '${physicalVenue}'`);
  }

  const hallPattern = /\b(Hall\s+[A-Za-z0-9]+|Main\s+Lab|Lab\s+\d+|Auditorium|Amphitheatre)\b/i;
  const hallMatch = hallPattern.exec(text);
  if (hallMatch && !physicalVenue) {
    physicalVenue = hallMatch[1].trim();
    evidence.push(`Hall/facility match: '${physicalVenue}'`);
  }

  // 3. Campus office / venue (e.g. "CDC Office", "Placement Office")
  const officePattern = /\b((?:CDC|Placement|TPO)\s+Office)\b/i;
  const officeMatch = officePattern.exec(text);
  if (officeMatch && !physicalVenue) {
    physicalVenue = officeMatch[1].trim();
    evidence.push(`Office facility match: '${physicalVenue}'`);
  }

  // 4. Explicit "venue: <Name>", "location: <Name>"
  const venueExplicitPattern = /\b(?:venue|location)\s*[:\-]\s*([A-Za-z0-9\s-]{2,25}?)(?:[.,\n]|$)/i;
  const venueExplicitMatch = venueExplicitPattern.exec(text);
  if (venueExplicitMatch && !physicalVenue) {
    const rawCandidate = venueExplicitMatch[1].trim();
    if (!/^(?:tba|tbd|to be announced|unknown|later)$/i.test(rawCandidate)) {
      physicalVenue = rawCandidate;
      evidence.push(`Explicit venue label match: '${physicalVenue}'`);
    }
  }

  // 5. Virtual / Online Venues
  if (/\b(?:Zoom(?:\s+(?:Meeting|Call|Webinar))?)\b/i.test(text)) {
    virtualVenue = 'Zoom';
    evidence.push("Virtual platform identified: 'Zoom'");
  } else if (/\b(?:Google\s+Meet|GMeet)\b/i.test(text)) {
    virtualVenue = 'Google Meet';
    evidence.push("Virtual platform identified: 'Google Meet'");
  } else if (/\b(?:MS\s+Teams|Microsoft\s+Teams)\b/i.test(text)) {
    virtualVenue = 'Microsoft Teams';
    evidence.push("Virtual platform identified: 'Microsoft Teams'");
  } else if (/\b(?:Webex)\b/i.test(text)) {
    virtualVenue = 'Webex';
    evidence.push("Virtual platform identified: 'Webex'");
  } else if (/\b(?:held\s+online|conducted\s+virtually|virtual\s+meeting|online\s+session)\b/i.test(text)) {
    virtualVenue = 'Online (Virtual)';
    evidence.push("Virtual online phrasing identified");
  }

  // 6. Resolve Composite Venue
  if (physicalVenue && virtualVenue) {
    return {
      venue: `${physicalVenue} / ${virtualVenue}`,
      venueType: 'hybrid',
      evidence,
    };
  }

  if (physicalVenue) {
    return {
      venue: physicalVenue,
      venueType: 'physical',
      evidence,
    };
  }

  if (virtualVenue) {
    return {
      venue: virtualVenue,
      venueType: 'virtual',
      evidence,
    };
  }

  evidence.push('No explicit physical or virtual venue detected');
  return {
    venue: null,
    venueType: null,
    evidence,
  };
}

/**
 * Result of splitting an email body into its primary announcement text
 * and its trailing footer / signature / institutional metadata.
 */
export interface BodySplitResult {
  announcementText: string;
  footerText: string;
}

/**
 * Determines whether a matched phrase (like "data science", "ai", "software engineer")
 * appears within an academic, institutional, or educational department/degree/ranking context
 * rather than denoting a professional job role.
 */
export function isAcademicOrInstitutionalContext(
  matchIndex: number,
  matchLength: number,
  fullText: string
): boolean {
  if (!fullText || matchIndex < 0) return false;

  // Context window before match (up to 80 chars)
  const windowStart = Math.max(0, matchIndex - 80);
  const prefix = fullText.slice(windowStart, matchIndex);

  // 1. Academic division / center / school / department prefixes:
  // e.g. "Centre for Data Science and AI", "School of AI", "Department of Computer Science"
  if (
    /(?:centre|center|school|department|division|institute|faculty|college)\s+(?:for|of)\s+[^.\n,;:]{0,50}$/i.test(
      prefix
    )
  ) {
    return true;
  }

  // 2. Academic degree / curriculum / branch / student cohort prefixes:
  // e.g. "B.Tech in ...", "M.Tech in ...", "students of ...", "branch: ...", "specialization in ..."
  if (
    /(?:b\.?tech|m\.?tech|b\.?e\.?|m\.?e\.?|b\.?sc|m\.?sc|bachelor|master|degree|specialization|specialisation|minor|major|students?\s+of|branch(?:\s*[:\-])?|discipline(?:\s*[:\-])?|curriculum)\s*(?:in|\(|:|-|\/|\band\b)?\s*[^.\n,;:]{0,50}$/i.test(
      prefix
    )
  ) {
    return true;
  }

  // 3. Surrounding window check for accreditation / ranking context:
  const windowEnd = Math.min(fullText.length, matchIndex + matchLength + 80);
  const surrounding = fullText.slice(windowStart, windowEnd);

  if (
    /\b(?:nirf|naac(?:\s+[a-z+]+)?|qs\s+rankings?|qs\s+world|ranked\s+among\s+top\s+(?:universities|institutions)|ranked\s+#\d+\s+(?:by|in)\s+(?:nirf|mhrd|qs|the)|accredited\s+by\s+naac)\b/i.test(
      surrounding
    )
  ) {
    return true;
  }

  return false;
}

/**
 * Splits email body text into primary announcement and trailing institutional / signature footer.
 * Footers include RFC signatures (--), sign-offs (Regards, Sincerely), placement cell / administrative
 * blocks, and university ranking / accreditation boilerplate (NIRF, NAAC, QS).
 *
 * Footers have ZERO authority over recruitment topic or role scope.
 */
export function splitAnnouncementAndFooter(text: string): BodySplitResult {
  if (!text || !text.trim()) {
    return { announcementText: '', footerText: '' };
  }

  // Regex patterns matching line beginnings that start a footer / signature / institutional block
  const footerDelimiters = [
    // RFC signature delimiter (--\n or ---\n or ___\n)
    /(?:^|\n)(?:--|---|___|===)\s*(?:\n|$)/g,
    // Standard valedictions / sign-offs at line start
    /(?:^|\n)(?:with\s+)?(?:warm\s+|best\s+|kind\s+)?regards\s*[,:-]?(?:\s*\n|\s+[A-Za-z]|$)/gi,
    /(?:^|\n)(?:thanks\s+(?:&|and)\s+regards|thanking\s+you|sincerely|cheers|yours\s+(?:faithfully|truly))\s*[,:-]?(?:\s*\n|\s+[A-Za-z]|$)/gi,
    // Administrative / Placement office signatures
    /(?:^|\n)(?:centre\s+for\s+career\s+(?:planning|development|services)|career\s+development\s+centre|placement\s+office|pat\s+office|placement\s+cell|office\s+of\s+placements?)\b/gi,
    // University ranking / accreditation / disclaimer blocks
    /(?:^|\n)(?:nirf|naac(?:\s+[a-z+]+)?|qs\s+(?:world\s+)?(?:university\s+)?rankings?|times\s+higher\s+education|disclaimer\s*[:\-])\b/gi,
    /(?:^|\n)(?:ranked\s+(?:among|#|\d+)|top\s+\d+\s+(?:institution|university))\b/gi,
    // Standard university / center signature lines
    /(?:^|\n)(?:vellore\s+institute\s+of\s+technology|vit\s+university|(?:centre\s+for\s+)?data\s+science\s+(?:and|&)\s+ai)\b/gi,
  ];

  let earliestSplitIndex = -1;

  for (const pattern of footerDelimiters) {
    let match: RegExpExecArray | null;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(text)) !== null) {
      const matchIndex = match.index;
      // Guardrail: Ensure there is substantial announcement content preceding the footer match (>= 10 chars).
      // This prevents false splits on leading letterheads or top-level headers.
      const textBefore = text.slice(0, matchIndex).trim();
      if (textBefore.length >= 10) {
        if (earliestSplitIndex === -1 || matchIndex < earliestSplitIndex) {
          earliestSplitIndex = matchIndex;
        }
        break; // found the earliest valid split point for this pattern
      }
    }
  }

  if (earliestSplitIndex !== -1) {
    const announcementText = text.slice(0, earliestSplitIndex).trim();
    const footerText = text.slice(earliestSplitIndex).trim();
    return { announcementText, footerText };
  }

  return { announcementText: text.trim(), footerText: '' };
}

interface ExtractedTopicDetails {
  roleOrProfile: string | null;
  processType: string | null;
  identifier: string | null;
  rolesFound: string[];
  evidence: string[];
}

/**
 * Parses topic components (identifiers, career roles, process types) from a given text string.
 */
function extractTopicDetailsFromText(
  text: string,
  subjectForCourse: string,
  detectedVenue?: string | null
): ExtractedTopicDetails {
  const evidence: string[] = [];
  let identifier: string | null = null;
  let processType: string | null = null;
  const rolesFound: string[] = [];

  if (!text) {
    return { roleOrProfile: null, processType: null, identifier: null, rolesFound: [], evidence: [] };
  }

  // 1. Transactional / Unique Identifiers
  // Order #112-987654
  const orderMatch = /\border\s*(?:#|id|number|no)?\s*[:.-]?\s*([A-Za-z0-9-]{5,25})\b/i.exec(text);
  if (orderMatch) {
    identifier = `order_${orderMatch[1].trim().toLowerCase()}`;
    evidence.push(`Order identifier extracted: '${identifier}'`);
  }

  // Course codes (CSE1001, CS 101, MAT2001) - ONLY with explicit contextual evidence
  if (!identifier) {
    const courseId = extractCourseIdentifier(text, subjectForCourse, detectedVenue);
    if (courseId) {
      identifier = courseId;
      evidence.push(`Course identifier extracted: '${identifier}'`);
    }
  }

  // PNR / Booking reference (PNR: ABC123)
  const pnrMatch = /\b(?:pnr|booking\s+reference|booking\s+id)\s*[:#.-]?\s*([A-Za-z0-9]{6,8})\b/i.exec(text);
  if (pnrMatch && !identifier) {
    identifier = `pnr_${pnrMatch[1].trim().toLowerCase()}`;
    evidence.push(`PNR identifier extracted: '${identifier}'`);
  }

  // Flight numbers (Flight DL1234, AI 101)
  const flightMatch = /\b(?:flight\s+([A-Za-z0-9]{2,8}))\b/i.exec(text);
  if (flightMatch && !identifier) {
    identifier = `flight_${flightMatch[1].replace(/\s+/g, '').trim().toLowerCase()}`;
    evidence.push(`Flight identifier extracted: '${identifier}'`);
  }

  // 2. Role / Profile Phrases
  // Check canonical industry roles FIRST (with institutional context filtering):
  const sweRegex = /\b(?:software\s+engineer(?:ing)?|software\s+development\s+engineer|sde[- ]?[123i]?)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = sweRegex.exec(text)) !== null) {
    if (!isAcademicOrInstitutionalContext(m.index, m[0].length, text)) {
      if (!rolesFound.includes('software_engineer')) {
        rolesFound.push('software_engineer');
        evidence.push("Role scope identified: 'software_engineer'");
      }
      break;
    }
  }

  const daRegex = /\b(?:data\s+analyst|data\s+analytics\s+(?:role|profile|engineer|intern(?:ship)?|position|job)|(?:role|profile|position)\s*[:\-]\s*data\s+analytics)\b/gi;
  while ((m = daRegex.exec(text)) !== null) {
    if (!isAcademicOrInstitutionalContext(m.index, m[0].length, text)) {
      if (!rolesFound.includes('data_analyst')) {
        rolesFound.push('data_analyst');
        evidence.push("Role scope identified: 'data_analyst'");
      }
      break;
    }
  }

  const dsRegex = /\b(?:data\s+scientist|data\s+science\s+(?:role|profile|engineer|intern(?:ship)?|position|job|associate|consultant|specialist)|(?:role|profile|position)\s*[:\-]\s*data\s+science)\b/gi;
  while ((m = dsRegex.exec(text)) !== null) {
    if (!isAcademicOrInstitutionalContext(m.index, m[0].length, text)) {
      if (!rolesFound.includes('data_scientist')) {
        rolesFound.push('data_scientist');
        evidence.push("Role scope identified: 'data_scientist'");
      }
      break;
    }
  }

  const pmRegex = /\b(?:product\s+manager|associate\s+product\s+manager|apm)\b/gi;
  while ((m = pmRegex.exec(text)) !== null) {
    if (!isAcademicOrInstitutionalContext(m.index, m[0].length, text)) {
      if (!rolesFound.includes('product_manager')) {
        rolesFound.push('product_manager');
        evidence.push("Role scope identified: 'product_manager'");
      }
      break;
    }
  }

  const baRegex = /\b(?:business\s+analyst)\b/gi;
  while ((m = baRegex.exec(text)) !== null) {
    if (!isAcademicOrInstitutionalContext(m.index, m[0].length, text)) {
      if (!rolesFound.includes('business_analyst')) {
        rolesFound.push('business_analyst');
        evidence.push("Role scope identified: 'business_analyst'");
      }
      break;
    }
  }

  const internRegex = /\b(?:internship|summer\s+intern(?:ship)?)\b/gi;
  while ((m = internRegex.exec(text)) !== null) {
    if (!isAcademicOrInstitutionalContext(m.index, m[0].length, text)) {
      if (!rolesFound.includes('internship')) {
        rolesFound.push('internship');
        evidence.push("Role scope identified: 'internship'");
      }
      break;
    }
  }

  // If not already detected, check explicit role markers: (AI Role), (Software Role), Role: AI, Profile: Software, etc.
  const aiRoleRegex = /\b(?:ai\s+role|role\s*[:\-]\s*ai\b|profile\s*[:\-]\s*ai\b|artificial\s+intelligence\s+role)\b/gi;
  while ((m = aiRoleRegex.exec(text)) !== null) {
    if (!isAcademicOrInstitutionalContext(m.index, m[0].length, text)) {
      if (!rolesFound.includes('role_ai')) {
        rolesFound.push('role_ai');
        evidence.push("Explicit role scope identified: 'role_ai'");
      }
      break;
    }
  }

  const softRoleRegex = /\b(?:software\s+role|role\s*[:\-]\s*software\b|profile\s*[:\-]\s*software\b)\b/gi;
  while ((m = softRoleRegex.exec(text)) !== null) {
    if (!isAcademicOrInstitutionalContext(m.index, m[0].length, text)) {
      if (!rolesFound.includes('role_software')) {
        rolesFound.push('role_software');
        evidence.push("Explicit role scope identified: 'role_software'");
      }
      break;
    }
  }

  // Generic role pattern: "role: <word>" or "<word> role"
  const explicitRolePattern = /\b(?:role|profile)\s*[:\-]\s*([A-Za-z0-9+/]{2,20})\b/gi;
  let em: RegExpExecArray | null;
  while ((em = explicitRolePattern.exec(text)) !== null) {
    if (isAcademicOrInstitutionalContext(em.index, em[0].length, text)) continue;
    const rawRole = em[1].trim().toLowerCase();
    const invalidRoleWords = new Set([
      'super', 'dream', 'internship', 'placement', 'recruitment', 'selection',
      'important', 'urgent', 'mandatory', 'process', 'active', 'test', 'exam',
      'key', 'lead', 'head', 'new', 'each', 'this', 'that', 'same', 'engineer', 'analyst',
    ]);
    if (!invalidRoleWords.has(rawRole)) {
      const cand = `role_${rawRole}`;
      if (!rolesFound.includes(cand)) {
        rolesFound.push(cand);
        evidence.push(`Explicit role scope identified: '${cand}'`);
      }
    }
  }
  const roleKeywordPattern = /\b([A-Za-z0-9+/]{2,20})\s+role\b/gi;
  while ((em = roleKeywordPattern.exec(text)) !== null) {
    if (isAcademicOrInstitutionalContext(em.index, em[0].length, text)) continue;
    const rawRole = em[1].trim().toLowerCase();
    const invalidRoleWords = new Set([
      'super', 'dream', 'internship', 'placement', 'recruitment', 'selection',
      'important', 'urgent', 'mandatory', 'process', 'active', 'test', 'exam',
      'key', 'lead', 'head', 'new', 'each', 'this', 'that', 'same', 'engineer', 'analyst',
    ]);
    if (!invalidRoleWords.has(rawRole)) {
      const cand = `role_${rawRole}`;
      if (!rolesFound.includes(cand)) {
        rolesFound.push(cand);
        evidence.push(`Explicit role scope identified: '${cand}'`);
      }
    }
  }

  // 3. Process / Engagement Types
  if (/\b(?:hackathon)\b/i.test(text)) {
    processType = 'hackathon';
    evidence.push("Process type identified: 'hackathon'");
  } else if (/\b(?:symposium|conference|summit)\b/i.test(text)) {
    processType = 'symposium';
    evidence.push("Process type identified: 'symposium'");
  } else if (/\b(?:webinar|workshop)\b/i.test(text)) {
    processType = 'webinar';
    evidence.push("Process type identified: 'webinar'");
  } else if (
    /\b(?:recruitment(?:\s+drive)?|placement(?:\s+drive)?|campus\s+drive|hiring\s+drive|selection\s+process|super\s+dream|dream\s+offer)\b/i.test(text)
  ) {
    processType = 'recruitment';
    evidence.push("Process type identified: 'recruitment'");
  }

  const roleOrProfile = rolesFound.length > 0 ? rolesFound[0] : null;

  return {
    roleOrProfile,
    processType,
    identifier,
    rolesFound,
    evidence,
  };
}

/**
 * Extracts deterministic topic scope (role, process type, transactional identifier).
 * When insufficient info exists, topicStatus = 'unknown'.
 * When subject and body contain contradictory factual topics, topicStatus = 'ambiguous'
 * and both observations are preserved in evidence without guessing intent.
 */
export function extractTopicScope(
  record: EmailRecord,
  signals?: EmailSignals,
  venueResult?: VenueExtractionResult
): TopicExtractionResult {
  const evidence: string[] = [];
  const detectedVenue = (venueResult || extractVenue(record)).venue;

  const subjectClean = stripSubjectPrefixes(record.subject);
  // Prioritize structured bodyTextPreview; fall back to snippet only if bodyTextPreview is absent.
  // Avoid prepending flat snippet onto formatted bodyTextPreview as it collapses newlines and breaks line-boundary patterns.
  const rawBody = (record.bodyTextPreview && record.bodyTextPreview.trim().length > 0
    ? record.bodyTextPreview
    : (record.snippet || '')).trim();
  const { announcementText, footerText } = splitAnnouncementAndFooter(rawBody);

  if (footerText) {
    evidence.push('Quarantined institutional/signature footer from topic extraction');
  }

  // Extract from subject and announcement body separately to detect factual contradictions
  const resSubject = extractTopicDetailsFromText(subjectClean, subjectClean, detectedVenue);
  const resBody = extractTopicDetailsFromText(announcementText, subjectClean, detectedVenue);

  // Check 1: Check for internal role contradiction within subject itself or body itself
  const hasSubjectInternalConflict =
    resSubject.rolesFound.length > 1 &&
    resSubject.rolesFound.some((r: string, idx: number, arr: string[]) =>
      arr.some((other: string, oIdx: number) => idx !== oIdx && !isTopicCompatible(r, other))
    );
  const hasBodyInternalConflict =
    resBody.rolesFound.length > 1 &&
    resBody.rolesFound.some((r: string, idx: number, arr: string[]) =>
      arr.some((other: string, oIdx: number) => idx !== oIdx && !isTopicCompatible(r, other))
    );

  if (hasSubjectInternalConflict) {
    evidence.push(...resSubject.evidence);
    evidence.push(`Internal role contradiction in subject: ${resSubject.rolesFound.join(' vs ')}`);
    return {
      topicScope: null,
      topicStatus: 'ambiguous',
      rawTopic: resSubject.rolesFound.join(' vs '),
      roleOrProfile: null,
      processType: null,
      identifier: null,
      subjectTopic: resSubject.rolesFound.join(' vs '),
      bodyTopic: resBody.roleOrProfile,
      conflictingTopics: resSubject.rolesFound,
      evidence,
    };
  }

  if (hasBodyInternalConflict) {
    evidence.push(...resBody.evidence);
    evidence.push(`Internal role contradiction in body: ${resBody.rolesFound.join(' vs ')}`);
    return {
      topicScope: null,
      topicStatus: 'ambiguous',
      rawTopic: resBody.rolesFound.join(' vs '),
      roleOrProfile: null,
      processType: null,
      identifier: null,
      subjectTopic: resSubject.roleOrProfile,
      bodyTopic: resBody.rolesFound.join(' vs '),
      conflictingTopics: resBody.rolesFound,
      evidence,
    };
  }

  // Check 2: Check for role contradiction between Subject and Body
  const subjectRole = resSubject.roleOrProfile;
  const bodyRole = resBody.roleOrProfile;

  if (subjectRole && bodyRole && !isTopicCompatible(subjectRole, bodyRole)) {
    evidence.push(...resSubject.evidence);
    evidence.push(...resBody.evidence);
    evidence.push(`Subject topic: '${subjectRole}'`);
    evidence.push(`Body topic: '${bodyRole}'`);
    evidence.push(
      `Internal topic contradiction: subject asserts '${subjectRole}' while body asserts '${bodyRole}'`
    );
    return {
      topicScope: null,
      topicStatus: 'ambiguous',
      rawTopic: `${subjectRole} vs ${bodyRole}`,
      roleOrProfile: null,
      processType: null,
      identifier: null,
      subjectTopic: subjectRole,
      bodyTopic: bodyRole,
      conflictingTopics: [subjectRole, bodyRole],
      evidence,
    };
  }

  // Check 3: Check for identifier contradiction between Subject and Body
  if (
    resSubject.identifier &&
    resBody.identifier &&
    resSubject.identifier !== resBody.identifier
  ) {
    evidence.push(...resSubject.evidence);
    evidence.push(...resBody.evidence);
    evidence.push(
      `Internal identifier contradiction: subject asserts '${resSubject.identifier}' while body asserts '${resBody.identifier}'`
    );
    return {
      topicScope: null,
      topicStatus: 'ambiguous',
      rawTopic: `${resSubject.identifier} vs ${resBody.identifier}`,
      roleOrProfile: null,
      processType: null,
      identifier: null,
      subjectTopic: resSubject.identifier,
      bodyTopic: resBody.identifier,
      conflictingTopics: [resSubject.identifier, resBody.identifier],
      evidence,
    };
  }

  // Check 4: Check for process contradiction between Subject and Body
  if (
    resSubject.processType &&
    resBody.processType &&
    resSubject.processType !== resBody.processType
  ) {
    evidence.push(...resSubject.evidence);
    evidence.push(...resBody.evidence);
    evidence.push(
      `Internal process contradiction: subject asserts '${resSubject.processType}' while body asserts '${resBody.processType}'`
    );
    return {
      topicScope: null,
      topicStatus: 'ambiguous',
      rawTopic: `${resSubject.processType} vs ${resBody.processType}`,
      roleOrProfile: null,
      processType: null,
      identifier: null,
      subjectTopic: resSubject.processType,
      bodyTopic: resBody.processType,
      conflictingTopics: [resSubject.processType, resBody.processType],
      evidence,
    };
  }

  // No contradiction between Subject and Body!
  evidence.push(...resSubject.evidence);
  for (const ev of resBody.evidence) {
    if (!evidence.includes(ev)) evidence.push(ev);
  }

  const roleOrProfile = subjectRole || bodyRole;
  const processType = resSubject.processType || resBody.processType;
  const identifier = resSubject.identifier || resBody.identifier;

  const subjectTopic =
    resSubject.identifier ||
    (resSubject.processType && resSubject.roleOrProfile
      ? `${resSubject.processType}_${resSubject.roleOrProfile}`
      : resSubject.roleOrProfile || resSubject.processType);
  const bodyTopic =
    resBody.identifier ||
    (resBody.processType && resBody.roleOrProfile
      ? `${resBody.processType}_${resBody.roleOrProfile}`
      : resBody.roleOrProfile || resBody.processType);

  // Construct Composite Topic Scope
  if (identifier) {
    return {
      topicScope: identifier,
      topicStatus: 'known',
      rawTopic: identifier,
      roleOrProfile,
      processType,
      identifier,
      evidence,
      subjectTopic,
      bodyTopic,
    };
  }

  // Explicit roles like role_ai and role_software take direct priority
  if (roleOrProfile && roleOrProfile.startsWith('role_')) {
    return {
      topicScope: roleOrProfile,
      topicStatus: 'known',
      rawTopic: roleOrProfile,
      roleOrProfile,
      processType,
      identifier,
      evidence,
      subjectTopic,
      bodyTopic,
    };
  }

  if (processType && roleOrProfile) {
    const composite = `${processType}_${roleOrProfile}`;
    return {
      topicScope: composite,
      topicStatus: 'known',
      rawTopic: composite,
      roleOrProfile,
      processType,
      identifier,
      evidence,
      subjectTopic,
      bodyTopic,
    };
  }

  if (roleOrProfile) {
    return {
      topicScope: roleOrProfile,
      topicStatus: 'known',
      rawTopic: roleOrProfile,
      roleOrProfile,
      processType,
      identifier,
      evidence,
      subjectTopic,
      bodyTopic,
    };
  }

  if (processType) {
    return {
      topicScope: processType,
      topicStatus: 'known',
      rawTopic: processType,
      roleOrProfile,
      processType,
      identifier,
      evidence,
      subjectTopic,
      bodyTopic,
    };
  }

  evidence.push('Insufficient topic signals; topicScope unresolved');
  return {
    topicScope: null,
    topicStatus: 'unknown',
    rawTopic: null,
    roleOrProfile: null,
    processType: null,
    identifier: null,
    evidence,
    subjectTopic: null,
    bodyTopic: null,
  };
}

/**
 * Detects reminder/tone signals without altering factual identity.
 */
export function extractReminderSignals(record: EmailRecord): ReminderToneSignals {
  const cues: string[] = [];
  const text = `${record.subject}\n${record.snippet || ''}\n${record.bodyTextPreview || ''}`.toLowerCase();

  let isReminder = false;
  let isUrgentTone = false;
  let isFinalNotice = false;

  // Reminder patterns
  if (/\bgentle\s+reminder\b/i.test(text)) {
    isReminder = true;
    cues.push('gentle reminder');
  }
  if (/\burgent\s+reminder\b/i.test(text)) {
    isReminder = true;
    isUrgentTone = true;
    cues.push('urgent reminder');
  }
  if (/\b(?:final|last)\s+reminder\b/i.test(text)) {
    isReminder = true;
    isFinalNotice = true;
    cues.push('final reminder');
  }
  if (/\b(?:reminder|this\s+is\s+a\s+reminder|reminding\s+all\s+candidates|kindly\s+treat\s+this\s+as\s+reminder)\b/i.test(text)) {
    isReminder = true;
    if (!cues.some(c => c.includes('reminder'))) cues.push('reminder');
  }

  // Urgent tone without explicit "reminder"
  if (/\b(report\s+immediately|report\s+now|action\s+required\s+immediately)\b/i.test(text)) {
    isUrgentTone = true;
    cues.push('report immediately');
  }
  if (/\b(urgent\b|urgently)\b/i.test(record.subject)) {
    isUrgentTone = true;
    if (!cues.includes('urgent')) cues.push('urgent');
  }

  // Final notice patterns
  if (/\b(final\s+notice|last\s+and\s+final\s+call|last\s+chance)\b/i.test(text)) {
    isFinalNotice = true;
    cues.push('final notice');
  }

  return {
    isReminder,
    isUrgentTone,
    isFinalNotice,
    cues,
  };
}

/**
 * Master Phase 4A extractor function.
 * Deterministically extracts invariant entity, topic scope, venue, and reminder signals.
 */
export function extractInvariants(
  record: EmailRecord,
  signals?: EmailSignals
): InvariantExtractionOutput {
  const entityResult = extractCanonicalEntity(record, signals);
  const venueResult = extractVenue(record);
  const topicResult = extractTopicScope(record, signals, venueResult);
  const reminderSignals = extractReminderSignals(record);

  const evidence = [
    ...entityResult.evidence,
    ...venueResult.evidence,
    ...topicResult.evidence,
  ];

  return {
    canonicalEntity: entityResult.canonicalEntity,
    entityStatus: entityResult.entityStatus,
    topicScope: topicResult.topicScope,
    topicStatus: topicResult.topicStatus,
    rawTopic: topicResult.rawTopic,
    venue: venueResult.venue,
    venueType: venueResult.venueType,
    reminderSignals,
    evidence,
    subjectTopic: topicResult.subjectTopic,
    bodyTopic: topicResult.bodyTopic,
    conflictingTopics: topicResult.conflictingTopics,
  };
}
