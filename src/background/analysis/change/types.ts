import { AttentionItem } from '../../../shared/types';

export type ExtractionStatus = 'known' | 'unknown' | 'ambiguous';

export interface EntityExtractionResult {
  canonicalEntity: string | null;
  entityStatus: ExtractionStatus;
  rawEntity: string | null;
  evidence: string[];
}

export interface TopicExtractionResult {
  topicScope: string | null;
  topicStatus: ExtractionStatus;
  rawTopic: string | null;
  roleOrProfile: string | null;
  processType: string | null;
  identifier: string | null;
  evidence: string[];
  subjectTopic?: string | null;
  bodyTopic?: string | null;
  conflictingTopics?: string[];
}

export interface VenueExtractionResult {
  venue: string | null;
  venueType: 'physical' | 'virtual' | 'hybrid' | null;
  evidence: string[];
}

export interface ReminderToneSignals {
  isReminder: boolean;
  isUrgentTone: boolean;
  isFinalNotice: boolean;
  cues: string[];
}

export interface InvariantExtractionOutput {
  canonicalEntity: string | null;
  entityStatus: ExtractionStatus;
  topicScope: string | null;
  topicStatus: ExtractionStatus;
  rawTopic?: string | null;
  venue: string | null;
  venueType: 'physical' | 'virtual' | 'hybrid' | null;
  reminderSignals: ReminderToneSignals;
  evidence: string[];
  subjectTopic?: string | null;
  bodyTopic?: string | null;
  conflictingTopics?: string[];
}

export type CandidateMatchStatus =
  | 'exact_identity'       // Confident semantic match: same category, known entity, compatible known topic
  | 'thread_uncertain'     // Same threadId, but entity or topic is unknown/ambiguous
  | 'no_candidate'         // Incompatible, hard conflict, unknown cross-thread, or no match found
  | 'unresolved_multiple'; // Multiple competing candidates exist; refusing arbitrary selection

export interface CandidateEvaluation {
  itemId: string;
  isEligible: boolean;
  matchStatus: 'exact_identity' | 'thread_uncertain' | 'incompatible';
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  sameThread: boolean;
  reasons: string[];
}

export interface IdentityMatchResult {
  candidateId: string | null;
  candidateItem: AttentionItem | null;
  status: CandidateMatchStatus;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';
  isCrossThread: boolean;
  reasons: string[];
  evaluations?: CandidateEvaluation[];
}

export type {
  AttentionItem,
  AttentionItemState,
  ChangeAnalysisResult,
  ChangeRelation,
  FieldDelta,
  FieldDeltaType,
  ItemLifecycleState,
  StateDiffResult,
  StateHistoryEntry,
  SubEventRecord,
  UserAttentionState,
} from '../../../shared/types';
