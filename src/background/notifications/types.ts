/**
 * Phase 5 Attention & Notification Engine Types and Contracts
 *
 * Core Invariant (Adjustment 4):
 * Notification code must NEVER modify factual analysis fields such as category,
 * importance, urgency, temporal facts, venue, deadline, topic, or lifecycle state.
 * It may ONLY modify notification state, scheduled alarms, and user attention state.
 */

import {
  AttentionItem,
  CategoryConfig,
  ChangeAnalysisResult,
  DatePrecision,
  EmailRecord,
  ExtensionSettings,
  ExtractedTemporalEntity,
  TemporalAnalysis,
  TemporalConfidence,
  TimePrecision,
  UserAttentionState,
} from '../../shared/types';

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

/**
 * Returns a clean, safe initial notification state for AttentionItems.
 */
export function createDefaultNotificationState(): ItemNotificationState {
  return {
    lastNotifiedAt: null,
    lastNotificationType: null,
    lastNotificationSeverity: null,
    deliveredNotificationKeys: [],
    activeNotificationId: null,
  };
}

export type ProximityStage = '48h' | '24h' | '3h' | '30m';

export interface ProximityAlarmConfig {
  stage: ProximityStage;
  offsetMs: number;
  minSeverity: NotificationSeverity;
  requiresExactTime: boolean;
  requiresPhysicalPresence?: boolean;
}

export interface NotificationDecision {
  shouldNotify: boolean;
  severity: NotificationSeverity;
  reason: string;
  notificationType: NotificationType | null;
  idempotencyKey: string | null;
}

export interface NotificationButtonConfig {
  title: string;
  action: 'mark_handled' | 'snooze' | 'dismiss' | 'open_dashboard';
}

export interface NotificationPayload {
  id: string; // notif::<attentionItemId>::<key>
  attentionItemId: string;
  title: string;
  message: string;
  contextMessage?: string;
  priority: number; // -2, -1, 0, 1, 2
  requireInteraction: boolean;
  buttons: NotificationButtonConfig[];
  severity: NotificationSeverity;
  notificationType: NotificationType;
}

export interface AttentionEligibilityInput {
  item: AttentionItem;
  email: EmailRecord;
  changeResult: ChangeAnalysisResult;
  settings?: ExtensionSettings;
  categoryConfig?: CategoryConfig;
  referenceTime?: number;
}

export interface AttentionEligibilityResult {
  shouldNotify: boolean;
  severity: NotificationSeverity;
  reason: string;
  notificationType: NotificationType | null;
  idempotencyKey: string | null;
  effectiveScore: number;
  baseScore: number;
  thresholdPassed: boolean;
  overrideTriggered: 'urgency' | 'importance' | null;
  categorySilenced: boolean;
  userAttentionStateAction: 'preserve' | 'reopen_unhandled' | 'suppress';
  nextUserAttentionState: UserAttentionState;
  isMaterialChange: boolean;
}

export interface ResolvedTemporalTarget {
  targetTimestamp: number;
  targetType: 'event' | 'deadline';
  timePrecision: TimePrecision;
  datePrecision: DatePrecision;
  isAmbiguous: boolean;
  confidence: TemporalConfidence;
  label: string;
  venue: string | null;
  venueType: 'physical' | 'virtual' | 'hybrid' | null;
}

export interface ProximityScheduleInput {
  item: AttentionItem;
  email?: EmailRecord | null;
  temporalAnalysis?: TemporalAnalysis | null;
  temporalEntity?: ExtractedTemporalEntity | null;
  referenceTime?: number;
  snoozeUntil?: number | null;
  venueType?: 'physical' | 'virtual' | 'hybrid' | null;
  timezone?: string;
}

export interface SnoozeScheduleInput {
  item: AttentionItem;
  snoozeUntil: number;
  referenceTime?: number;
  emailId?: string | null;
}

export interface ScheduleCalculationInput extends ProximityScheduleInput {}

export interface NotificationDispatchInput {
  item: AttentionItem;
  decision: AttentionEligibilityResult;
  email?: EmailRecord | null;
  referenceTime?: number;
}

export interface NotificationDispatchResult {
  delivered: boolean;
  notificationId: string | null;
  reason: string;
}

export interface ReconciliationReport {
  recreatedAlarms: string[];
  clearedOrphanAlarms: string[];
  clearedInvalidAlarms: string[];
  missedRemindersHandled: string[];
  missedRemindersSuppressed: string[];
  missedSnoozesHandled: string[];
  errors: string[];
}

export interface PipelineNotificationResult {
  eligible: boolean;
  decision: AttentionEligibilityResult;
  dispatchResult: NotificationDispatchResult | null;
  alarmsScheduled: number;
}
