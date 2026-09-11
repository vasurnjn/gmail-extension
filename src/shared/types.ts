export type ConfidenceLevel = 'HIGH' | 'MEDIUM' | 'LOW';

export type ActionType =
  | 'register'
  | 'apply'
  | 'confirm'
  | 'pay'
  | 'submit'
  | 'attend'
  | 'reply'
  | 'review'
  | 'other';

export type AlertStatus =
  | 'pending'
  | 'notified'
  | 'snoozed'
  | 'handled'
  | 'dismissed';

export type ItemLifecycleState =
  | 'active'
  | 'postponed'
  | 'cancelled'
  | 'completed'
  | 'unknown';

export type UserAttentionState =
  | 'unhandled'
  | 'handled'
  | 'snoozed'
  | 'dismissed';

export type ChangeRelation =
  | 'NEW'
  | 'REPEAT'
  | 'UPDATE'
  | 'CONFLICT'
  | 'CANCELLED';

export type TemporalType =
  | 'deadline'    // Must be completed by this cutoff (e.g. "submit on or before 20th Sept")
  | 'event'       // Happens at this point (e.g. "PPT scheduled on 17th Sept at 4:30 PM")
  | 'window'      // Valid across an interval (e.g. "open from 15th to 20th September")
  | 'relative'    // Relative temporal expression (e.g. "within 24 hours", "tomorrow")
  | 'unresolved'; // Ambiguous or unparseable temporal text

export type TemporalStatus =
  | 'imminent'    // Due/occurring within 24 hours of reference clock (or today)
  | 'upcoming'    // Due/occurring within 1 to 7 days of reference clock
  | 'distant'     // Future date beyond 7 days of reference clock
  | 'passed'      // Resolved timestamp or event calendar day is in the past relative to reference clock
  | 'unresolved'; // Cannot determine status safely (timestamp is null)

export type DatePrecision =
  | 'exact'       // Specific calendar day/month/(year) provided
  | 'relative'    // Relative day anchored to email date (e.g. "today", "tomorrow")
  | 'unresolved'; // Date could not be safely resolved

export type TimePrecision =
  | 'exact'       // Hour and minute explicitly provided (e.g. "4:30 PM", "10.00 am")
  | 'inferred'    // Inferred boundary for deadlines only (e.g. EOD 23:59:59)
  | 'unknown';    // Time was not provided in email (MUST NOT be treated as exact event time)

export type TemporalConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

export interface ExtractedTemporalEntity {
  id: string;                       // e.g. "temp_0"
  rawText: string;                  // Verbatim matched text, e.g. "on or before 20th September 2026 (10.00 AM)"
  type: TemporalType;               // 'deadline' | 'event' | 'window' | 'relative' | 'unresolved'
  status: TemporalStatus;           // 'imminent' | 'upcoming' | 'distant' | 'passed' | 'unresolved'
  
  // Resolution details (anchored to email internalDate)
  timestamp: number | null;         // Epoch ms (null if unresolvable/ambiguous)
  endTimestamp?: number | null;     // Epoch ms for windows/ranges
  datePrecision: DatePrecision;     // 'exact' | 'relative' | 'unresolved'
  timePrecision: TimePrecision;     // 'exact' | 'inferred' | 'unknown'
  isAmbiguous: boolean;             // True if multiple interpretations exist or year was uncertain
  
  // Semantic associations & explainability
  associatedAction: ActionType | null; // e.g. 'register', 'submit', 'attend', 'pay'
  associatedVerbText?: string;      // e.g. "register", "submit application"
  contextSnippet: string;           // Excerpt surrounding the match for UI and auditability
  confidence: TemporalConfidence;   // 'HIGH' | 'MEDIUM' | 'LOW'
  evidenceReasons: string[];        // Audit log of why this interpretation was assigned
}

export interface TemporalAnalysis {
  entities: ExtractedTemporalEntity[];
  primaryDeadline: ExtractedTemporalEntity | null; // Earliest active actionable deadline
  primaryEvent: ExtractedTemporalEntity | null;    // Earliest active scheduled event
  hasActiveDeadline: boolean;
  isOverdue: boolean;                              // True if actionable deadline has passed
  hasAmbiguousDates: boolean;
  temporalUrgencyTier: 'imminent' | 'upcoming' | 'distant' | 'passed' | 'none';
  summaryReason: string;                           // Concise human-readable explanation
}

export interface ExtractedDeadline {
  text: string;
  parsedTimestamp: number;
  confidence: ConfidenceLevel;
}

export interface ExtractedDate {
  text: string;
  parsedTimestamp: number;
}

export interface ExtractedEntities {
  deadlines: ExtractedDeadline[];
  dates: ExtractedDate[];
  organizations: string[];
  locations: string[];
  ctc: string | null;
  urls: string[];
}

export interface ClassificationResult {
  category: string;
  confidence: number; // 0.0 to 1.0
  actionRequired: boolean;
  actionType: ActionType | null;
  detectionReasons: string[];
  extractedEntities: ExtractedEntities;
}

export interface AttentionScore {
  importance: number; // 0 to 100 ("How much it matters")
  urgency: number;    // 0 to 100 ("How soon user must act")
}

export interface EmailRecord {
  id: string; // Gmail message ID (primary key)
  threadId: string;
  subject: string;
  from: string;
  fromDomain: string;
  to?: string[];
  snippet: string;
  internalDate: number; // message timestamp (ms)
  processedAt: number;  // analysis timestamp (ms)
  bodyTextPreview: string; // limited to 2000 chars max, never store unnecessary raw body
  labels?: string[];
  isUnread?: boolean;

  // Classification, scoring & temporal analysis
  analysisVersion?: number; // Tracks analysis pipeline version (e.g. 4 for Phase 4)
  category: string;
  confidence: number; // Retained for backward-compatibility with existing interface
  categoryScore?: number; // Evidence score (0 to 100) for primary category
  categoryScores?: Record<string, number>; // Multi-category evidence scores for explainability
  signals?: unknown; // Structured extracted signals (EmailSignals)
  importanceScore: number;
  urgencyScore: number;
  importanceReasons?: string[];
  urgencyReasons?: string[];
  actionRequired: boolean;
  actionType: ActionType | null;
  detectionReasons: string[];
  extractedEntities: ExtractedEntities;
  temporalAnalysis?: TemporalAnalysis;

  // Local alert state
  alertStatus: AlertStatus;
  snoozeUntil: number | null;
  handledAt: number | null;

  // Information change & repetition detection (Phase 4)
  attentionItemId?: string | null;
  changeRelation?: ChangeRelation | null;
}

export interface SubEventRecord {
  subEventId: string;                  // e.g. "sub_ppt", "sub_interview"
  label: string;                       // e.g. "PPT", "Interview", "Registration Deadline"
  type: 'event' | 'deadline' | 'window';
  timestamp: number | null;
  endTimestamp: number | null;
  timePrecision: TimePrecision;
  venue: string | null;
  status: 'active' | 'cancelled' | 'postponed';
}

export type FieldDeltaType = 'updated' | 'added' | 'removed' | 'conflict' | 'unchanged';

export interface FieldDelta {
  field:
    | 'primaryEventTimestamp'
    | 'primaryDeadlineTimestamp'
    | 'venue'
    | 'actionRequired'
    | 'actionType'
    | 'itemLifecycleState'
    | 'subEvent'
    | 'entity'
    | 'topic';
  subEventId?: string;
  oldValue: unknown;
  newValue: unknown;
  changeType: FieldDeltaType;
  description: string;
  confidence?: 'HIGH' | 'MEDIUM' | 'LOW';
  evidence?: string[];
}

export interface StateDiffResult {
  hasChanges: boolean;
  deltas: FieldDelta[];
  unchangedFields: string[];
  subEventDeltas: FieldDelta[];
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  reasons: string[];
}

export interface AttentionItemState {
  primaryEventTimestamp: number | null;
  primaryDeadlineTimestamp: number | null;
  venue: string | null;
  actionRequired: boolean;
  actionType: ActionType | null;
  itemLifecycleState: ItemLifecycleState;
  subEvents: SubEventRecord[];
}

export interface StateHistoryEntry {
  emailId: string;
  internalDate: number;
  recordedAt: number;
  relation: ChangeRelation;
  deltas: FieldDelta[];
  summary: string;
}

export interface AttentionItem {
  id: string;                               // e.g. "att_01JMABC..."
  identityKey: string | null;               // Canonical hash: "cat::entity::topic" (null if identity incomplete)
  category: string;
  canonicalEntity: string | null;
  entityStatus: 'known' | 'unknown' | 'ambiguous';
  topicScope: string | null;
  topicStatus: 'known' | 'unknown' | 'ambiguous';

  // Communication references
  threadIds: string[];
  messageIds: string[];
  latestEmailId: string;

  // Timestamps
  firstSeenAt: number;
  lastSeenAt: number;

  // Decoupled states
  itemLifecycleState: ItemLifecycleState;
  userAttentionState: UserAttentionState;

  // Scoring snapshots
  importanceScore: number;
  urgencyScore: number;

  // State payloads
  currentState: AttentionItemState;
  previousState?: AttentionItemState;
  history: StateHistoryEntry[];

  // Phase 5 Notification State
  notificationState?: ItemNotificationState;
}

export interface ChangeAnalysisResult {
  attentionItemId: string;
  relation: ChangeRelation;
  shouldCreateNewAttentionItem: boolean;
  deltas: FieldDelta[];
  summary: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

export interface SenderProfile {
  email: string; // primary key
  domain: string;
  displayName: string;
  positiveInteractions: number; // handled
  negativeInteractions: number; // dismissed / not important
  reputationScore: number;      // 0.0 to 1.0
  isMailingList: boolean;
  lastSeen: number;
  firstSeen: number;
}

export interface UserFeedback {
  id?: number; // auto-increment
  emailId: string;
  timestamp: number;
  action: 'handled' | 'dismissed' | 'snoozed' | 'opened';
  category: string;
  importanceScoreAtTime: number;
}

export interface CategoryWeight {
  categoryId: string; // primary key
  userMultiplier: number;
  recentFeedbackCount: number;
  lastUpdated: number;
}

export type NotificationSeverity = 'critical' | 'high' | 'standard' | 'silent';

export type NotificationType =
  | 'new'
  | 'update'
  | 'conflict'
  | 'cancellation'
  | 'reminder'
  | 'snooze_expired';

export interface ItemNotificationState {
  lastNotifiedAt: number | null;
  lastNotificationType: NotificationType | null;
  lastNotificationSeverity: NotificationSeverity | null;
  deliveredNotificationKeys: string[];
  activeNotificationId: string | null;
}

export interface ScheduledAlarmRecord {
  alarmName: string; // primary key
  attentionItemId?: string | null;
  emailId?: string | null;
  alarmType: 'immediate' | 'reminder' | 'snooze' | 'proximity';
  scheduledAt: number;
  purpose: string;
  stage?: '48h' | '24h' | '3h' | '30m' | 'snooze' | 'immediate' | null;
  createdAt?: number;
}

export interface CategoryConfig {
  id: string;
  label: string;
  description?: string;
  defaultPriority: 'high' | 'medium' | 'low' | 'silent';
  alertEnabled: boolean;
  userMultiplier: number;
  keywords: string[];
  color: string;
}

export type ThemeMode = 'system' | 'light' | 'dark';

export interface ExtensionSettings {
  alertThreshold: number; // 0-100, default 50
  pollingIntervalMinutes: number; // default 2
  showBadge: boolean;
  defaultSnoozeMinutes: number; // default 60
  timezone: string;
  useBuiltInAI: boolean; // progressive enhancement opt-in
  theme: ThemeMode; // 'system' | 'light' | 'dark'
}

export type AuthState = 'not_connected' | 'connecting' | 'connected' | 'error';

export interface LocalSyncState {
  historyId: string | null;
  lastPollTime: number | null;
  lastSafetyScanTime: number | null;
  lastSyncTime: number | null;
  isSyncing: boolean;
  authState: AuthState;
  accountEmail: string | null;
  lastError: string | null;
}
