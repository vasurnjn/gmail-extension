import {
  DEFAULT_CATEGORIES,
  DEFAULT_SETTINGS,
} from '../../shared/constants';
import {
  AttentionItem,
  CategoryConfig,
  ChangeAnalysisResult,
  EmailRecord,
  ExtensionSettings,
  FieldDelta,
  UserAttentionState,
} from '../../shared/types';
import {
  CRITICAL_IMPORTANCE_OVERRIDE_THRESHOLD,
  CRITICAL_URGENCY_OVERRIDE_THRESHOLD,
  HIGH_IMPORTANCE_THRESHOLD,
  IMPORTANCE_WEIGHT,
  URGENCY_WEIGHT,
} from './constants';
import {
  AttentionEligibilityInput,
  AttentionEligibilityResult,
  NotificationSeverity,
  NotificationType,
} from './types';

/**
 * Computes deterministic attention score from importance, urgency, and category userMultiplier.
 *
 * Formula:
 * baseScore = Math.round(importance * IMPORTANCE_WEIGHT + urgency * URGENCY_WEIGHT)
 * effectiveScore = Math.min(100, Math.max(0, Math.round(baseScore * userMultiplier)))
 */
export function calculateAttentionScore(
  importanceScore: number,
  urgencyScore: number,
  userMultiplier = 1.0
): { baseScore: number; effectiveScore: number } {
  const baseScore = Math.round(
    importanceScore * IMPORTANCE_WEIGHT + urgencyScore * URGENCY_WEIGHT
  );
  const effectiveScore = Math.min(
    100,
    Math.max(0, Math.round(baseScore * userMultiplier))
  );
  return { baseScore, effectiveScore };
}

/**
 * Identifies whether a factual delta constitutes a material change.
 *
 * Material fields:
 * - primaryEventTimestamp (event moved or rescheduled)
 * - primaryDeadlineTimestamp (deadline extended or shortened)
 * - venue (venue relocated, added, or removed)
 * - subEvent (interview/exam round added or timing updated)
 * - actionRequired (action requirement added)
 * - actionType (type of required action changed)
 * - itemLifecycleState (lifecycle status transitioned)
 *
 * Non-material fields:
 * - entity, topic (semantic clarifications that do not change scheduling or logistics)
 */
export function isMaterialFactualDelta(delta: FieldDelta): boolean {
  if (delta.changeType === 'unchanged') return false;
  switch (delta.field) {
    case 'primaryEventTimestamp':
    case 'primaryDeadlineTimestamp':
    case 'venue':
    case 'subEvent':
    case 'actionRequired':
    case 'actionType':
    case 'itemLifecycleState':
      return true;
    case 'topic':
    case 'entity':
    default:
      return false;
  }
}

/**
 * Checks whether factual deltas require user re-verification.
 *
 * Adjustment 2:
 * A material UPDATE should only reset userAttentionState to unhandled when the factual
 * change requires user re-verification. Otherwise preserve the existing user attention state.
 */
export function requiresUserReverification(deltas: FieldDelta[]): boolean {
  return deltas.some((d) => {
    if (!isMaterialFactualDelta(d)) return false;
    // Core logistical and temporal changes require active user re-verification
    return (
      d.field === 'primaryEventTimestamp' ||
      d.field === 'primaryDeadlineTimestamp' ||
      d.field === 'venue' ||
      d.field === 'subEvent' ||
      d.field === 'itemLifecycleState' ||
      (d.field === 'actionRequired' && d.newValue === true)
    );
  });
}

/**
 * Evaluates the appropriate notification severity tier for an eligible item.
 */
export function evaluateSeverity(
  email: EmailRecord,
  changeResult: ChangeAnalysisResult,
  effectiveScore: number
): NotificationSeverity {
  const relation = changeResult.relation;

  // 1. Critical Tier
  if (email.urgencyScore >= CRITICAL_URGENCY_OVERRIDE_THRESHOLD) {
    return 'critical';
  }
  if (
    email.temporalAnalysis?.temporalUrgencyTier === 'imminent' &&
    email.importanceScore >= 60
  ) {
    return 'critical';
  }
  if (
    relation === 'CONFLICT' &&
    (email.urgencyScore >= 70 || email.importanceScore >= 70)
  ) {
    return 'critical';
  }

  // 2. High Tier
  if (relation === 'CANCELLED') {
    return 'high';
  }
  if (relation === 'CONFLICT') {
    return 'high';
  }
  if (email.importanceScore >= HIGH_IMPORTANCE_THRESHOLD) {
    return 'high';
  }
  if (
    email.temporalAnalysis?.temporalUrgencyTier === 'upcoming' &&
    email.importanceScore >= 50
  ) {
    return 'high';
  }
  if (relation === 'UPDATE' && changeResult.deltas.some(isMaterialFactualDelta)) {
    return 'high';
  }

  // 3. Standard Tier (Met threshold, actionable)
  return 'standard';
}

/**
 * Generates an idempotency key for preventing duplicate desktop notifications.
 */
export function generateIdempotencyKey(
  item: AttentionItem,
  email: EmailRecord,
  changeResult: ChangeAnalysisResult
): string | null {
  const relation = changeResult.relation;
  switch (relation) {
    case 'NEW':
      return `notif::${item.id}::new`;
    case 'UPDATE': {
      const materialFields = changeResult.deltas
        .filter(isMaterialFactualDelta)
        .map((d) => d.field)
        .sort();
      if (materialFields.length === 0) return null;
      return `notif::${item.id}::update_${materialFields.join('_')}_${email.id}`;
    }
    case 'CONFLICT':
      return `notif::${item.id}::conflict_${email.id}`;
    case 'CANCELLED':
      return `notif::${item.id}::cancelled`;
    case 'REPEAT':
    default:
      return null;
  }
}

/**
 * Pure, deterministic evaluation of attention eligibility and notification decisions.
 *
 * Evaluates:
 * 1. Category alert configuration and priority.
 * 2. Attention score threshold and high-urgency / high-importance overrides.
 * 3. Lifecycle state (active vs cancelled vs completed).
 * 4. User attention state (unhandled vs snoozed vs handled vs dismissed).
 * 5. Relation semantics (NEW, REPEAT, UPDATE, CONFLICT, CANCELLED).
 * 6. Material change verification and safe state transitions.
 * 7. Delivery idempotency.
 *
 * Core Invariant:
 * Notification code NEVER modifies factual analysis fields (category, importance,
 * urgency, temporal facts, venue, deadline, topic, lifecycle).
 */
export function evaluateAttentionEligibility(
  input: AttentionEligibilityInput
): AttentionEligibilityResult {
  const {
    item,
    email,
    changeResult,
    settings = DEFAULT_SETTINGS,
    categoryConfig,
  } = input;

  // 1. Resolve Category Config
  const resolvedCategoryConfig: CategoryConfig =
    categoryConfig ||
    DEFAULT_CATEGORIES.find((c) => c.id === item.category) || {
      id: item.category,
      label: item.category,
      defaultPriority: 'medium',
      alertEnabled: true,
      userMultiplier: 1.0,
      keywords: [],
      color: '#6366f1',
    };

  // 2. Compute Attention Score
  const { baseScore, effectiveScore } = calculateAttentionScore(
    email.importanceScore,
    email.urgencyScore,
    resolvedCategoryConfig.userMultiplier
  );

  // 3. Evaluate Threshold and Overrides
  // Boundary conditions: exactly 50, 80, 85
  const isUrgencyOverride =
    email.urgencyScore >= CRITICAL_URGENCY_OVERRIDE_THRESHOLD;
  const isImportanceOverride =
    email.importanceScore >= CRITICAL_IMPORTANCE_OVERRIDE_THRESHOLD;

  let overrideTriggered: 'urgency' | 'importance' | null = null;
  if (isUrgencyOverride) {
    overrideTriggered = 'urgency';
  } else if (isImportanceOverride) {
    overrideTriggered = 'importance';
  }

  const thresholdPassed =
    effectiveScore >= settings.alertThreshold ||
    isUrgencyOverride ||
    isImportanceOverride;

  // 4. Category Silencing Check
  const categorySilenced =
    resolvedCategoryConfig.alertEnabled === false ||
    resolvedCategoryConfig.defaultPriority === 'silent';

  // 5. Evaluate Materiality of Deltas
  const isMaterialChange = changeResult.deltas.some(isMaterialFactualDelta);
  const needsReverification = requiresUserReverification(changeResult.deltas);

  // 6. User Attention State Transitions & Relation Handling
  const relation = changeResult.relation;

  // Default assumption: preserve current user attention state
  let userAttentionStateAction: 'preserve' | 'reopen_unhandled' | 'suppress' =
    'preserve';
  let nextUserAttentionState: UserAttentionState = item.userAttentionState;

  // --- CASE: REPEAT ---
  // Requirement 10: REPEAT must NEVER produce an interrupting notification
  if (relation === 'REPEAT') {
    return {
      shouldNotify: false,
      severity: 'silent',
      reason: 'Factual repetition: interrupting notification suppressed',
      notificationType: null,
      idempotencyKey: null,
      effectiveScore,
      baseScore,
      thresholdPassed,
      overrideTriggered,
      categorySilenced,
      userAttentionStateAction: 'preserve',
      nextUserAttentionState: item.userAttentionState,
      isMaterialChange: false,
    };
  }

  // --- CASE: CANCELLED ---
  // Requirement 14: CANCELLED must produce a cancellation decision without alarm API behavior
  if (relation === 'CANCELLED') {
    if (categorySilenced) {
      return {
        shouldNotify: false,
        severity: 'silent',
        reason: 'Cancellation received but category alerts are silenced',
        notificationType: 'cancellation',
        idempotencyKey: null,
        effectiveScore,
        baseScore,
        thresholdPassed,
        overrideTriggered,
        categorySilenced,
        userAttentionStateAction: 'preserve',
        nextUserAttentionState: item.userAttentionState,
        isMaterialChange: true,
      };
    }

    const idempotencyKey = generateIdempotencyKey(item, email, changeResult);
    const alreadyDelivered =
      idempotencyKey !== null &&
      item.notificationState?.deliveredNotificationKeys.includes(idempotencyKey);

    if (alreadyDelivered) {
      return {
        shouldNotify: false,
        severity: 'silent',
        reason: 'Cancellation notification already delivered',
        notificationType: 'cancellation',
        idempotencyKey,
        effectiveScore,
        baseScore,
        thresholdPassed,
        overrideTriggered,
        categorySilenced,
        userAttentionStateAction: 'preserve',
        nextUserAttentionState: item.userAttentionState,
        isMaterialChange: true,
      };
    }

    return {
      shouldNotify: true,
      severity: 'high',
      reason: 'Engagement has been cancelled',
      notificationType: 'cancellation',
      idempotencyKey,
      effectiveScore,
      baseScore,
      thresholdPassed,
      overrideTriggered,
      categorySilenced,
      userAttentionStateAction: 'preserve',
      nextUserAttentionState: item.userAttentionState,
      isMaterialChange: true,
    };
  }

  // --- CASE: CONFLICT ---
  // Requirement 13: CONFLICT must produce an appropriate attention decision without corrupting state
  if (relation === 'CONFLICT') {
    if (categorySilenced) {
      return {
        shouldNotify: false,
        severity: 'silent',
        reason: 'Conflict detected but category alerts are silenced',
        notificationType: 'conflict',
        idempotencyKey: null,
        effectiveScore,
        baseScore,
        thresholdPassed,
        overrideTriggered,
        categorySilenced,
        userAttentionStateAction: 'reopen_unhandled',
        nextUserAttentionState: 'unhandled',
        isMaterialChange: false,
      };
    }

    const idempotencyKey = generateIdempotencyKey(item, email, changeResult);
    const alreadyDelivered =
      idempotencyKey !== null &&
      item.notificationState?.deliveredNotificationKeys.includes(idempotencyKey);

    const severity =
      email.urgencyScore >= 70 || email.importanceScore >= 70
        ? 'critical'
        : 'high';

    return {
      shouldNotify: !alreadyDelivered,
      severity: alreadyDelivered ? 'silent' : severity,
      reason: alreadyDelivered
        ? 'Conflict notification already delivered'
        : 'Contradictory factual state detected: user disambiguation required',
      notificationType: 'conflict',
      idempotencyKey,
      effectiveScore,
      baseScore,
      thresholdPassed,
      overrideTriggered,
      categorySilenced,
      userAttentionStateAction: 'reopen_unhandled',
      nextUserAttentionState: 'unhandled',
      isMaterialChange: false,
    };
  }

  // --- CASE: UPDATE ---
  // Requirement 11 & 12: Material update requirements & reverification check
  if (relation === 'UPDATE') {
    if (!isMaterialChange) {
      return {
        shouldNotify: false,
        severity: 'silent',
        reason: 'Non-material update: no actionable factual change',
        notificationType: null,
        idempotencyKey: null,
        effectiveScore,
        baseScore,
        thresholdPassed,
        overrideTriggered,
        categorySilenced,
        userAttentionStateAction: 'preserve',
        nextUserAttentionState: item.userAttentionState,
        isMaterialChange: false,
      };
    }

    // Adjustment 2: Only reset userAttentionState to unhandled if reverification is required
    if (needsReverification) {
      userAttentionStateAction = 'reopen_unhandled';
      nextUserAttentionState = 'unhandled';
    } else {
      userAttentionStateAction = 'preserve';
      nextUserAttentionState = item.userAttentionState;
    }

    // If item was handled or dismissed and DOES NOT require reverification, suppress
    if (
      (item.userAttentionState === 'handled' ||
        item.userAttentionState === 'dismissed') &&
      !needsReverification
    ) {
      return {
        shouldNotify: false,
        severity: 'silent',
        reason: `Item is ${item.userAttentionState}; update does not require reverification`,
        notificationType: null,
        idempotencyKey: null,
        effectiveScore,
        baseScore,
        thresholdPassed,
        overrideTriggered,
        categorySilenced,
        userAttentionStateAction: 'preserve',
        nextUserAttentionState: item.userAttentionState,
        isMaterialChange: true,
      };
    }

    // If item was snoozed and does NOT require reverification, suppress/defer
    if (item.userAttentionState === 'snoozed' && !needsReverification) {
      return {
        shouldNotify: false,
        severity: 'silent',
        reason: 'Item is snoozed; notification deferred until snooze expiry',
        notificationType: null,
        idempotencyKey: null,
        effectiveScore,
        baseScore,
        thresholdPassed,
        overrideTriggered,
        categorySilenced,
        userAttentionStateAction: 'preserve',
        nextUserAttentionState: 'snoozed',
        isMaterialChange: true,
      };
    }

    // Category silenced check
    if (categorySilenced) {
      return {
        shouldNotify: false,
        severity: 'silent',
        reason: 'Material update received but category alerts are silenced',
        notificationType: 'update',
        idempotencyKey: null,
        effectiveScore,
        baseScore,
        thresholdPassed,
        overrideTriggered,
        categorySilenced,
        userAttentionStateAction,
        nextUserAttentionState,
        isMaterialChange: true,
      };
    }

    // Threshold check for material updates
    if (!thresholdPassed) {
      return {
        shouldNotify: false,
        severity: 'silent',
        reason: 'Material update attention score below alert threshold',
        notificationType: 'update',
        idempotencyKey: null,
        effectiveScore,
        baseScore,
        thresholdPassed: false,
        overrideTriggered,
        categorySilenced: false,
        userAttentionStateAction,
        nextUserAttentionState,
        isMaterialChange: true,
      };
    }

    // Check delivery idempotency
    const idempotencyKey = generateIdempotencyKey(item, email, changeResult);
    if (
      idempotencyKey &&
      item.notificationState?.deliveredNotificationKeys.includes(idempotencyKey)
    ) {
      return {
        shouldNotify: false,
        severity: 'silent',
        reason: 'Material update notification already delivered',
        notificationType: 'update',
        idempotencyKey,
        effectiveScore,
        baseScore,
        thresholdPassed: true,
        overrideTriggered,
        categorySilenced: false,
        userAttentionStateAction,
        nextUserAttentionState,
        isMaterialChange: true,
      };
    }

    const severity = evaluateSeverity(email, changeResult, effectiveScore);
    return {
      shouldNotify: true,
      severity,
      reason: 'Material update: actionable factual change requires user attention',
      notificationType: 'update',
      idempotencyKey,
      effectiveScore,
      baseScore,
      thresholdPassed: true,
      overrideTriggered,
      categorySilenced: false,
      userAttentionStateAction,
      nextUserAttentionState,
      isMaterialChange: true,
    };
  }

  // --- CASE: NEW ---
  // Requirement 6: Lifecycle state checks
  if (item.itemLifecycleState !== 'active') {
    return {
      shouldNotify: false,
      severity: 'silent',
      reason: `New item lifecycle is ${item.itemLifecycleState}; notifications suppressed`,
      notificationType: null,
      idempotencyKey: null,
      effectiveScore,
      baseScore,
      thresholdPassed,
      overrideTriggered,
      categorySilenced,
      userAttentionStateAction: 'preserve',
      nextUserAttentionState: item.userAttentionState,
      isMaterialChange: true,
    };
  }

  // Requirement 7: User attention state checks
  if (item.userAttentionState === 'handled') {
    return {
      shouldNotify: false,
      severity: 'silent',
      reason: 'Item is marked handled; notification suppressed',
      notificationType: null,
      idempotencyKey: null,
      effectiveScore,
      baseScore,
      thresholdPassed,
      overrideTriggered,
      categorySilenced,
      userAttentionStateAction: 'preserve',
      nextUserAttentionState: 'handled',
      isMaterialChange: true,
    };
  }

  if (item.userAttentionState === 'dismissed') {
    return {
      shouldNotify: false,
      severity: 'silent',
      reason: 'Item is dismissed; notification suppressed',
      notificationType: null,
      idempotencyKey: null,
      effectiveScore,
      baseScore,
      thresholdPassed,
      overrideTriggered,
      categorySilenced,
      userAttentionStateAction: 'preserve',
      nextUserAttentionState: 'dismissed',
      isMaterialChange: true,
    };
  }

  if (item.userAttentionState === 'snoozed') {
    return {
      shouldNotify: false,
      severity: 'silent',
      reason: 'Item is snoozed; notification deferred',
      notificationType: null,
      idempotencyKey: null,
      effectiveScore,
      baseScore,
      thresholdPassed,
      overrideTriggered,
      categorySilenced,
      userAttentionStateAction: 'preserve',
      nextUserAttentionState: 'snoozed',
      isMaterialChange: true,
    };
  }

  // Check category silencing
  if (categorySilenced) {
    return {
      shouldNotify: false,
      severity: 'silent',
      reason: 'Category alerts are disabled or set to silent',
      notificationType: 'new',
      idempotencyKey: null,
      effectiveScore,
      baseScore,
      thresholdPassed,
      overrideTriggered,
      categorySilenced: true,
      userAttentionStateAction: 'preserve',
      nextUserAttentionState: 'unhandled',
      isMaterialChange: true,
    };
  }

  // Check score threshold
  if (!thresholdPassed) {
    return {
      shouldNotify: false,
      severity: 'silent',
      reason: `Attention score (${effectiveScore}) below alert threshold (${settings.alertThreshold})`,
      notificationType: 'new',
      idempotencyKey: null,
      effectiveScore,
      baseScore,
      thresholdPassed: false,
      overrideTriggered: null,
      categorySilenced: false,
      userAttentionStateAction: 'preserve',
      nextUserAttentionState: 'unhandled',
      isMaterialChange: true,
    };
  }

  // Idempotency check for NEW
  const idempotencyKey = generateIdempotencyKey(item, email, changeResult);
  if (
    idempotencyKey &&
    item.notificationState?.deliveredNotificationKeys.includes(idempotencyKey)
  ) {
    return {
      shouldNotify: false,
      severity: 'silent',
      reason: 'Notification for new item already delivered',
      notificationType: 'new',
      idempotencyKey,
      effectiveScore,
      baseScore,
      thresholdPassed: true,
      overrideTriggered,
      categorySilenced: false,
      userAttentionStateAction: 'preserve',
      nextUserAttentionState: 'unhandled',
      isMaterialChange: true,
    };
  }

  const severity = evaluateSeverity(email, changeResult, effectiveScore);
  return {
    shouldNotify: true,
    severity,
    reason: overrideTriggered
      ? `Attention-eligible: ${overrideTriggered} override triggered`
      : `Attention-eligible: score (${effectiveScore}) meets threshold (${settings.alertThreshold})`,
    notificationType: 'new',
    idempotencyKey,
    effectiveScore,
    baseScore,
    thresholdPassed: true,
    overrideTriggered,
    categorySilenced: false,
    userAttentionStateAction: 'preserve',
    nextUserAttentionState: 'unhandled',
    isMaterialChange: true,
  };
}
