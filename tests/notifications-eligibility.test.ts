import { describe, it, expect } from 'vitest';
import {
  AttentionItem,
  CategoryConfig,
  ChangeAnalysisResult,
  EmailRecord,
  ExtensionSettings,
  FieldDelta,
  UserAttentionState,
} from '../src/shared/types';
import { DEFAULT_CATEGORIES, DEFAULT_SETTINGS } from '../src/shared/constants';
import {
  calculateAttentionScore,
  evaluateAttentionEligibility,
  evaluateSeverity,
  generateIdempotencyKey,
  isMaterialFactualDelta,
  requiresUserReverification,
} from '../src/background/notifications/eligibility';
import {
  CRITICAL_IMPORTANCE_OVERRIDE_THRESHOLD,
  CRITICAL_URGENCY_OVERRIDE_THRESHOLD,
  HIGH_IMPORTANCE_THRESHOLD,
  IMPORTANCE_WEIGHT,
  URGENCY_WEIGHT,
} from '../src/background/notifications/constants';
import { createDefaultNotificationState } from '../src/background/notifications/types';

// Helper to construct test EmailRecord
function createMockEmail(overrides: Partial<EmailRecord> = {}): EmailRecord {
  return {
    id: 'msg_test_001',
    threadId: 'th_test_001',
    subject: 'Amazon Campus Interview Schedule',
    from: 'placement@university.edu',
    fromDomain: 'university.edu',
    snippet: 'Interview on Sep 20 at 10 AM',
    internalDate: 1726500000000,
    processedAt: 1726500000000,
    bodyTextPreview: 'Your interview is scheduled at SJT 101',
    category: 'career_placement',
    confidence: 0.95,
    importanceScore: 60,
    urgencyScore: 50,
    actionRequired: true,
    actionType: 'attend',
    detectionReasons: [],
    extractedEntities: {
      deadlines: [],
      dates: [],
      organizations: ['Amazon'],
      locations: ['SJT 101'],
      ctc: null,
      urls: [],
    },
    alertStatus: 'pending',
    snoozeUntil: null,
    handledAt: null,
    attentionItemId: null,
    changeRelation: null,
    ...overrides,
  };
}

// Helper to construct test AttentionItem
function createMockAttentionItem(
  overrides: Partial<AttentionItem> = {}
): AttentionItem {
  return {
    id: 'att_test_001',
    identityKey: 'career_placement::amazon::role_sde',
    category: 'career_placement',
    canonicalEntity: 'amazon',
    entityStatus: 'known',
    topicScope: 'role_sde',
    topicStatus: 'known',
    threadIds: ['th_test_001'],
    messageIds: ['msg_test_prior'],
    latestEmailId: 'msg_test_prior',
    firstSeenAt: 1726400000000,
    lastSeenAt: 1726400000000,
    itemLifecycleState: 'active',
    userAttentionState: 'unhandled',
    importanceScore: 60,
    urgencyScore: 50,
    currentState: {
      primaryEventTimestamp: 1726573800000,
      primaryDeadlineTimestamp: null,
      venue: 'SJT 101',
      actionRequired: true,
      actionType: 'attend',
      itemLifecycleState: 'active',
      subEvents: [],
    },
    history: [],
    notificationState: createDefaultNotificationState(),
    ...overrides,
  };
}

// Helper to construct test ChangeAnalysisResult
function createMockChangeResult(
  overrides: Partial<ChangeAnalysisResult> = {}
): ChangeAnalysisResult {
  return {
    attentionItemId: 'att_test_001',
    relation: 'NEW',
    shouldCreateNewAttentionItem: true,
    deltas: [],
    summary: 'New engagement detected',
    confidence: 'HIGH',
    ...overrides,
  };
}

describe('Phase 5B: Deterministic Attention Eligibility & Decision Layer', () => {
  // =========================================================================
  // 1. Attention Score Calculation & Named Weights
  // =========================================================================
  describe('calculateAttentionScore', () => {
    it('uses named IMPORTANCE_WEIGHT (0.45) and URGENCY_WEIGHT (0.55)', () => {
      expect(IMPORTANCE_WEIGHT).toBe(0.45);
      expect(URGENCY_WEIGHT).toBe(0.55);
      expect(IMPORTANCE_WEIGHT + URGENCY_WEIGHT).toBeCloseTo(1.0, 5);
    });

    it('calculates expected score for boundary values', () => {
      // 100 & 100 -> 100
      expect(calculateAttentionScore(100, 100)).toEqual({
        baseScore: 100,
        effectiveScore: 100,
      });

      // 0 & 0 -> 0
      expect(calculateAttentionScore(0, 0)).toEqual({
        baseScore: 0,
        effectiveScore: 0,
      });

      // 50 & 50 -> 22.5 + 27.5 = 50
      expect(calculateAttentionScore(50, 50)).toEqual({
        baseScore: 50,
        effectiveScore: 50,
      });
    });

    it('correctly applies category userMultiplier', () => {
      // Base 50 with multiplier 1.2 -> 60
      const boosted = calculateAttentionScore(50, 50, 1.2);
      expect(boosted.baseScore).toBe(50);
      expect(boosted.effectiveScore).toBe(60);

      // Base 50 with multiplier 0.8 -> 40
      const deboosted = calculateAttentionScore(50, 50, 0.8);
      expect(deboosted.baseScore).toBe(50);
      expect(deboosted.effectiveScore).toBe(40);
    });

    it('clamps effectiveScore between 0 and 100', () => {
      const overMax = calculateAttentionScore(90, 90, 1.5);
      expect(overMax.effectiveScore).toBe(100);

      const underMin = calculateAttentionScore(-10, -10, 1.0);
      expect(underMin.effectiveScore).toBe(0);
    });
  });

  // =========================================================================
  // 2. Threshold Boundary Conditions (50 vs 49)
  // =========================================================================
  describe('Score Threshold Boundary Conditions', () => {
    it('passes threshold at exactly 50 (50 >= 50)', () => {
      const email = createMockEmail({ importanceScore: 50, urgencyScore: 50 });
      const item = createMockAttentionItem();
      const changeResult = createMockChangeResult({ relation: 'NEW' });

      const result = evaluateAttentionEligibility({ item, email, changeResult });

      expect(result.effectiveScore).toBe(50);
      expect(result.thresholdPassed).toBe(true);
      expect(result.overrideTriggered).toBeNull();
      expect(result.shouldNotify).toBe(true);
    });

    it('fails threshold at 49 (49 < 50)', () => {
      const email = createMockEmail({ importanceScore: 49, urgencyScore: 49 });
      const item = createMockAttentionItem();
      const changeResult = createMockChangeResult({ relation: 'NEW' });

      const result = evaluateAttentionEligibility({ item, email, changeResult });

      expect(result.effectiveScore).toBe(49);
      expect(result.thresholdPassed).toBe(false);
      expect(result.overrideTriggered).toBeNull();
      expect(result.shouldNotify).toBe(false);
      expect(result.severity).toBe('silent');
    });

    it('properly evaluates weighted score boundary (50*0.45 + 49*0.55 = 49.45 -> 49)', () => {
      const email = createMockEmail({ importanceScore: 50, urgencyScore: 49 });
      const item = createMockAttentionItem();
      const changeResult = createMockChangeResult({ relation: 'NEW' });

      const result = evaluateAttentionEligibility({ item, email, changeResult });

      expect(result.effectiveScore).toBe(49);
      expect(result.thresholdPassed).toBe(false);
      expect(result.shouldNotify).toBe(false);
    });

    it('properly evaluates weighted score boundary (51*0.45 + 50*0.55 = 50.45 -> 50)', () => {
      const email = createMockEmail({ importanceScore: 51, urgencyScore: 50 });
      const item = createMockAttentionItem();
      const changeResult = createMockChangeResult({ relation: 'NEW' });

      const result = evaluateAttentionEligibility({ item, email, changeResult });

      expect(result.effectiveScore).toBe(50);
      expect(result.thresholdPassed).toBe(true);
      expect(result.shouldNotify).toBe(true);
    });

    it('respects custom settings alertThreshold (e.g. 70)', () => {
      const customSettings: ExtensionSettings = {
        ...DEFAULT_SETTINGS,
        alertThreshold: 70,
      };

      // Score 60 fails threshold of 70
      const email60 = createMockEmail({ importanceScore: 60, urgencyScore: 60 });
      const item = createMockAttentionItem();
      const changeResult = createMockChangeResult({ relation: 'NEW' });

      const result60 = evaluateAttentionEligibility({
        item,
        email: email60,
        changeResult,
        settings: customSettings,
      });
      expect(result60.effectiveScore).toBe(60);
      expect(result60.thresholdPassed).toBe(false);
      expect(result60.shouldNotify).toBe(false);

      // Score 70 passes threshold of 70
      const email70 = createMockEmail({ importanceScore: 70, urgencyScore: 70 });
      const result70 = evaluateAttentionEligibility({
        item,
        email: email70,
        changeResult,
        settings: customSettings,
      });
      expect(result70.effectiveScore).toBe(70);
      expect(result70.thresholdPassed).toBe(true);
      expect(result70.shouldNotify).toBe(true);
    });
  });

  // =========================================================================
  // 3. High-Urgency Milestone Override (80 vs 79)
  // =========================================================================
  describe('High-Urgency Milestone Override', () => {
    it('triggers urgency override at urgencyScore = 80 even when effectiveScore < 50', () => {
      // 10 * 0.45 + 80 * 0.55 = 4.5 + 44 = 48.5 -> 49 (< 50)
      const email = createMockEmail({ importanceScore: 10, urgencyScore: 80 });
      const item = createMockAttentionItem();
      const changeResult = createMockChangeResult({ relation: 'NEW' });

      const result = evaluateAttentionEligibility({ item, email, changeResult });

      expect(result.effectiveScore).toBe(49);
      expect(result.overrideTriggered).toBe('urgency');
      expect(result.thresholdPassed).toBe(true);
      expect(result.shouldNotify).toBe(true);
      expect(result.severity).toBe('critical');
    });

    it('does NOT trigger urgency override at urgencyScore = 79 when effectiveScore < 50', () => {
      // 10 * 0.45 + 79 * 0.55 = 4.5 + 43.45 = 47.95 -> 48 (< 50)
      const email = createMockEmail({ importanceScore: 10, urgencyScore: 79 });
      const item = createMockAttentionItem();
      const changeResult = createMockChangeResult({ relation: 'NEW' });

      const result = evaluateAttentionEligibility({ item, email, changeResult });

      expect(result.effectiveScore).toBe(48);
      expect(result.overrideTriggered).toBeNull();
      expect(result.thresholdPassed).toBe(false);
      expect(result.shouldNotify).toBe(false);
      expect(result.severity).toBe('silent');
    });
  });

  // =========================================================================
  // 4. High-Importance Milestone Override (85 vs 84)
  // =========================================================================
  describe('High-Importance Milestone Override', () => {
    it('triggers importance override at importanceScore = 85 even when effectiveScore < 50', () => {
      // 85 * 0.45 + 0 * 0.55 = 38.25 -> 38 (< 50)
      const email = createMockEmail({ importanceScore: 85, urgencyScore: 0 });
      const item = createMockAttentionItem();
      const changeResult = createMockChangeResult({ relation: 'NEW' });

      const result = evaluateAttentionEligibility({ item, email, changeResult });

      expect(result.effectiveScore).toBe(38);
      expect(result.overrideTriggered).toBe('importance');
      expect(result.thresholdPassed).toBe(true);
      expect(result.shouldNotify).toBe(true);
      expect(result.severity).toBe('high');
    });

    it('does NOT trigger importance override at importanceScore = 84 when effectiveScore < 50', () => {
      // 84 * 0.45 + 0 * 0.55 = 37.8 -> 38 (< 50)
      const email = createMockEmail({ importanceScore: 84, urgencyScore: 0 });
      const item = createMockAttentionItem();
      const changeResult = createMockChangeResult({ relation: 'NEW' });

      const result = evaluateAttentionEligibility({ item, email, changeResult });

      expect(result.effectiveScore).toBe(38);
      expect(result.overrideTriggered).toBeNull();
      expect(result.thresholdPassed).toBe(false);
      expect(result.shouldNotify).toBe(false);
      expect(result.severity).toBe('silent');
    });
  });

  // =========================================================================
  // 5. Category Alert Configuration & Silencing
  // =========================================================================
  describe('Category Alert Configuration & Silencing', () => {
    it('suppresses notification when category alertEnabled = false even with score 100', () => {
      const email = createMockEmail({ importanceScore: 100, urgencyScore: 100 });
      const item = createMockAttentionItem();
      const changeResult = createMockChangeResult({ relation: 'NEW' });
      const silencedCategory: CategoryConfig = {
        id: 'career_placement',
        label: 'Career',
        defaultPriority: 'high',
        alertEnabled: false, // silenced
        userMultiplier: 1.0,
        keywords: [],
        color: '#000',
      };

      const result = evaluateAttentionEligibility({
        item,
        email,
        changeResult,
        categoryConfig: silencedCategory,
      });

      expect(result.categorySilenced).toBe(true);
      expect(result.shouldNotify).toBe(false);
      expect(result.severity).toBe('silent');
      expect(result.reason).toContain('disabled or set to silent');
    });

    it('suppresses notification when category defaultPriority = "silent" even with score 100', () => {
      const email = createMockEmail({ importanceScore: 100, urgencyScore: 100 });
      const item = createMockAttentionItem();
      const changeResult = createMockChangeResult({ relation: 'NEW' });
      const silentCategory: CategoryConfig = {
        id: 'career_placement',
        label: 'Career',
        defaultPriority: 'silent', // silenced
        alertEnabled: true,
        userMultiplier: 1.0,
        keywords: [],
        color: '#000',
      };

      const result = evaluateAttentionEligibility({
        item,
        email,
        changeResult,
        categoryConfig: silentCategory,
      });

      expect(result.categorySilenced).toBe(true);
      expect(result.shouldNotify).toBe(false);
      expect(result.severity).toBe('silent');
    });

    it('applies category userMultiplier to elevate sub-threshold score to passing', () => {
      // 45 base * 1.2 = 54 (passes 50)
      const email = createMockEmail({ importanceScore: 45, urgencyScore: 45 });
      const item = createMockAttentionItem();
      const changeResult = createMockChangeResult({ relation: 'NEW' });
      const boostedCategory: CategoryConfig = {
        id: 'career_placement',
        label: 'Career',
        defaultPriority: 'medium',
        alertEnabled: true,
        userMultiplier: 1.2,
        keywords: [],
        color: '#000',
      };

      const result = evaluateAttentionEligibility({
        item,
        email,
        changeResult,
        categoryConfig: boostedCategory,
      });

      expect(result.baseScore).toBe(45);
      expect(result.effectiveScore).toBe(54);
      expect(result.thresholdPassed).toBe(true);
      expect(result.shouldNotify).toBe(true);
    });

    it('applies category userMultiplier to suppress passing base score', () => {
      // 55 base * 0.8 = 44 (below 50)
      const email = createMockEmail({ importanceScore: 55, urgencyScore: 55 });
      const item = createMockAttentionItem();
      const changeResult = createMockChangeResult({ relation: 'NEW' });
      const loweredCategory: CategoryConfig = {
        id: 'career_placement',
        label: 'Career',
        defaultPriority: 'medium',
        alertEnabled: true,
        userMultiplier: 0.8,
        keywords: [],
        color: '#000',
      };

      const result = evaluateAttentionEligibility({
        item,
        email,
        changeResult,
        categoryConfig: loweredCategory,
      });

      expect(result.baseScore).toBe(55);
      expect(result.effectiveScore).toBe(44);
      expect(result.thresholdPassed).toBe(false);
      expect(result.shouldNotify).toBe(false);
    });
  });

  // =========================================================================
  // 6. Lifecycle State Checks
  // =========================================================================
  describe('Lifecycle State Checks', () => {
    it('notifies when itemLifecycleState is active', () => {
      const email = createMockEmail({ importanceScore: 70, urgencyScore: 70 });
      const item = createMockAttentionItem({ itemLifecycleState: 'active' });
      const changeResult = createMockChangeResult({ relation: 'NEW' });

      const result = evaluateAttentionEligibility({ item, email, changeResult });

      expect(result.shouldNotify).toBe(true);
    });

    it('suppresses notification when itemLifecycleState is cancelled (for NEW relation)', () => {
      const email = createMockEmail({ importanceScore: 70, urgencyScore: 70 });
      const item = createMockAttentionItem({ itemLifecycleState: 'cancelled' });
      const changeResult = createMockChangeResult({ relation: 'NEW' });

      const result = evaluateAttentionEligibility({ item, email, changeResult });

      expect(result.shouldNotify).toBe(false);
      expect(result.severity).toBe('silent');
      expect(result.reason).toContain('cancelled');
    });

    it('suppresses notification when itemLifecycleState is completed', () => {
      const email = createMockEmail({ importanceScore: 70, urgencyScore: 70 });
      const item = createMockAttentionItem({ itemLifecycleState: 'completed' });
      const changeResult = createMockChangeResult({ relation: 'NEW' });

      const result = evaluateAttentionEligibility({ item, email, changeResult });

      expect(result.shouldNotify).toBe(false);
      expect(result.severity).toBe('silent');
      expect(result.reason).toContain('completed');
    });

    it('suppresses notification when itemLifecycleState is unknown', () => {
      const email = createMockEmail({ importanceScore: 70, urgencyScore: 70 });
      const item = createMockAttentionItem({ itemLifecycleState: 'unknown' });
      const changeResult = createMockChangeResult({ relation: 'NEW' });

      const result = evaluateAttentionEligibility({ item, email, changeResult });

      expect(result.shouldNotify).toBe(false);
      expect(result.severity).toBe('silent');
      expect(result.reason).toContain('unknown');
    });
  });

  // =========================================================================
  // 7. User Attention State Checks (unhandled, snoozed, handled, dismissed)
  // =========================================================================
  describe('User Attention State Checks', () => {
    it('allows notification when userAttentionState is unhandled', () => {
      const email = createMockEmail({ importanceScore: 70, urgencyScore: 70 });
      const item = createMockAttentionItem({ userAttentionState: 'unhandled' });
      const changeResult = createMockChangeResult({ relation: 'NEW' });

      const result = evaluateAttentionEligibility({ item, email, changeResult });

      expect(result.shouldNotify).toBe(true);
      expect(result.nextUserAttentionState).toBe('unhandled');
    });

    it('defers notification when userAttentionState is snoozed', () => {
      const email = createMockEmail({ importanceScore: 70, urgencyScore: 70 });
      const item = createMockAttentionItem({ userAttentionState: 'snoozed' });
      const changeResult = createMockChangeResult({ relation: 'NEW' });

      const result = evaluateAttentionEligibility({ item, email, changeResult });

      expect(result.shouldNotify).toBe(false);
      expect(result.severity).toBe('silent');
      expect(result.reason).toContain('snoozed');
      expect(result.nextUserAttentionState).toBe('snoozed');
    });

    it('suppresses notification when userAttentionState is handled', () => {
      const email = createMockEmail({ importanceScore: 70, urgencyScore: 70 });
      const item = createMockAttentionItem({ userAttentionState: 'handled' });
      const changeResult = createMockChangeResult({ relation: 'NEW' });

      const result = evaluateAttentionEligibility({ item, email, changeResult });

      expect(result.shouldNotify).toBe(false);
      expect(result.severity).toBe('silent');
      expect(result.reason).toContain('handled');
      expect(result.nextUserAttentionState).toBe('handled');
    });

    it('suppresses notification when userAttentionState is dismissed', () => {
      const email = createMockEmail({ importanceScore: 70, urgencyScore: 70 });
      const item = createMockAttentionItem({ userAttentionState: 'dismissed' });
      const changeResult = createMockChangeResult({ relation: 'NEW' });

      const result = evaluateAttentionEligibility({ item, email, changeResult });

      expect(result.shouldNotify).toBe(false);
      expect(result.severity).toBe('silent');
      expect(result.reason).toContain('dismissed');
      expect(result.nextUserAttentionState).toBe('dismissed');
    });
  });

  // =========================================================================
  // 8. Severity Tier Calculation
  // =========================================================================
  describe('evaluateSeverity', () => {
    it('assigns critical severity when urgencyScore >= 80', () => {
      const email = createMockEmail({ urgencyScore: 80, importanceScore: 50 });
      const changeResult = createMockChangeResult({ relation: 'NEW' });
      expect(evaluateSeverity(email, changeResult, 60)).toBe('critical');
    });

    it('assigns critical severity when temporal tier is imminent and importanceScore >= 60', () => {
      const email = createMockEmail({
        urgencyScore: 65,
        importanceScore: 60,
        temporalAnalysis: {
          entities: [],
          primaryDeadline: null,
          primaryEvent: null,
          hasActiveDeadline: false,
          isOverdue: false,
          hasAmbiguousDates: false,
          temporalUrgencyTier: 'imminent',
          summaryReason: 'Imminent test',
        },
      });
      const changeResult = createMockChangeResult({ relation: 'NEW' });
      expect(evaluateSeverity(email, changeResult, 62)).toBe('critical');
    });

    it('assigns critical severity for CONFLICT with high urgency or importance (>= 70)', () => {
      const email = createMockEmail({ urgencyScore: 70, importanceScore: 50 });
      const changeResult = createMockChangeResult({ relation: 'CONFLICT' });
      expect(evaluateSeverity(email, changeResult, 60)).toBe('critical');
    });

    it('assigns high severity for CANCELLED', () => {
      const email = createMockEmail({ urgencyScore: 50, importanceScore: 50 });
      const changeResult = createMockChangeResult({ relation: 'CANCELLED' });
      expect(evaluateSeverity(email, changeResult, 50)).toBe('high');
    });

    it('assigns high severity for CONFLICT with standard scores', () => {
      const email = createMockEmail({ urgencyScore: 55, importanceScore: 55 });
      const changeResult = createMockChangeResult({ relation: 'CONFLICT' });
      expect(evaluateSeverity(email, changeResult, 55)).toBe('high');
    });

    it('assigns high severity when importanceScore >= 75 (HIGH_IMPORTANCE_THRESHOLD)', () => {
      const email = createMockEmail({ urgencyScore: 50, importanceScore: 75 });
      const changeResult = createMockChangeResult({ relation: 'NEW' });
      expect(evaluateSeverity(email, changeResult, 61)).toBe('high');
    });

    it('assigns high severity for material UPDATE', () => {
      const email = createMockEmail({ urgencyScore: 50, importanceScore: 50 });
      const changeResult = createMockChangeResult({
        relation: 'UPDATE',
        deltas: [
          {
            field: 'venue',
            changeType: 'updated',
            description: 'Venue relocated',
            oldValue: 'SJT 101',
            newValue: 'SJT 717',
            evidence: ['Venue moved to SJT 717'],
          },
        ],
      });
      expect(evaluateSeverity(email, changeResult, 50)).toBe('high');
    });

    it('assigns standard severity when threshold is met without critical/high triggers', () => {
      const email = createMockEmail({ urgencyScore: 50, importanceScore: 50 });
      const changeResult = createMockChangeResult({ relation: 'NEW' });
      expect(evaluateSeverity(email, changeResult, 50)).toBe('standard');
    });
  });

  // =========================================================================
  // 9. Relation Semantics: REPEAT (Requirement 10)
  // =========================================================================
  describe('Relation: REPEAT (Requirement 10)', () => {
    it('NEVER produces an interrupting notification for REPEAT, regardless of high scores', () => {
      const email = createMockEmail({
        importanceScore: 100,
        urgencyScore: 100,
      });
      const item = createMockAttentionItem({
        importanceScore: 100,
        urgencyScore: 100,
        userAttentionState: 'unhandled',
      });
      const changeResult = createMockChangeResult({
        relation: 'REPEAT',
        summary: 'Exact repeat email received',
      });

      const result = evaluateAttentionEligibility({ item, email, changeResult });

      expect(result.shouldNotify).toBe(false);
      expect(result.severity).toBe('silent');
      expect(result.notificationType).toBeNull();
      expect(result.isMaterialChange).toBe(false);
      expect(result.userAttentionStateAction).toBe('preserve');
      expect(result.nextUserAttentionState).toBe('unhandled');
      expect(result.reason).toContain('Factual repetition');
    });

    it('preserves handled state and produces no notification on REPEAT', () => {
      const email = createMockEmail({ importanceScore: 90, urgencyScore: 90 });
      const item = createMockAttentionItem({ userAttentionState: 'handled' });
      const changeResult = createMockChangeResult({ relation: 'REPEAT' });

      const result = evaluateAttentionEligibility({ item, email, changeResult });

      expect(result.shouldNotify).toBe(false);
      expect(result.severity).toBe('silent');
      expect(result.nextUserAttentionState).toBe('handled');
    });
  });

  // =========================================================================
  // 10. Relation Semantics: UPDATE & Adjustment 2 Re-verification
  // =========================================================================
  describe('Relation: UPDATE (Requirements 11, 12)', () => {
    it('suppresses notification for non-material update (e.g. topic clarification only)', () => {
      const email = createMockEmail({ importanceScore: 80, urgencyScore: 70 });
      const item = createMockAttentionItem({ userAttentionState: 'unhandled' });
      const changeResult = createMockChangeResult({
        relation: 'UPDATE',
        deltas: [
          {
            field: 'topic',
            changeType: 'updated',
            description: 'Role clarified',
            oldValue: 'role_generic',
            newValue: 'role_sde',
            evidence: ['Role clarified'],
          },
        ],
      });

      const result = evaluateAttentionEligibility({ item, email, changeResult });

      expect(result.isMaterialChange).toBe(false);
      expect(result.shouldNotify).toBe(false);
      expect(result.severity).toBe('silent');
      expect(result.reason).toContain('Non-material update');
    });

    it('notifies and resets userAttentionState to unhandled when material update requires reverification', () => {
      const email = createMockEmail({ importanceScore: 70, urgencyScore: 60 });
      const item = createMockAttentionItem({
        userAttentionState: 'handled', // Previously handled by user!
      });
      const changeResult = createMockChangeResult({
        relation: 'UPDATE',
        deltas: [
          {
            field: 'venue',
            changeType: 'updated',
            description: 'Venue relocated',
            oldValue: 'SJT 101',
            newValue: 'SJT 717',
            evidence: ['Venue relocated'],
          },
        ],
      });

      const result = evaluateAttentionEligibility({ item, email, changeResult });

      // Venue relocation requires reverification!
      expect(result.isMaterialChange).toBe(true);
      expect(result.userAttentionStateAction).toBe('reopen_unhandled');
      expect(result.nextUserAttentionState).toBe('unhandled');
      expect(result.shouldNotify).toBe(true);
      expect(result.severity).toBe('high');
      expect(result.notificationType).toBe('update');
      expect(result.idempotencyKey).toContain('update_venue');
    });

    it('re-opens handled item when event timing changes', () => {
      const email = createMockEmail({ importanceScore: 70, urgencyScore: 60 });
      const item = createMockAttentionItem({ userAttentionState: 'handled' });
      const changeResult = createMockChangeResult({
        relation: 'UPDATE',
        deltas: [
          {
            field: 'primaryEventTimestamp',
            changeType: 'updated',
            description: 'Time postponed',
            oldValue: 1726573800000,
            newValue: 1726581000000,
            evidence: ['Time postponed to 6:30 PM'],
          },
        ],
      });

      const result = evaluateAttentionEligibility({ item, email, changeResult });

      expect(result.userAttentionStateAction).toBe('reopen_unhandled');
      expect(result.nextUserAttentionState).toBe('unhandled');
      expect(result.shouldNotify).toBe(true);
    });

    it('Adjustment 2: preserves handled state and suppresses notification when material update does NOT require reverification', () => {
      const email = createMockEmail({ importanceScore: 70, urgencyScore: 60 });
      const item = createMockAttentionItem({ userAttentionState: 'handled' });
      // actionType changed, but actionRequired was already true and did not change to true
      const changeResult = createMockChangeResult({
        relation: 'UPDATE',
        deltas: [
          {
            field: 'actionType',
            changeType: 'updated',
            description: 'Form submit requested',
            oldValue: 'attend',
            newValue: 'submit',
            evidence: ['Form submit requested'],
          },
        ],
      });

      expect(isMaterialFactualDelta(changeResult.deltas[0])).toBe(true);
      expect(requiresUserReverification(changeResult.deltas)).toBe(false);

      const result = evaluateAttentionEligibility({ item, email, changeResult });

      expect(result.isMaterialChange).toBe(true);
      expect(result.userAttentionStateAction).toBe('preserve');
      expect(result.nextUserAttentionState).toBe('handled');
      expect(result.shouldNotify).toBe(false);
      expect(result.severity).toBe('silent');
      expect(result.reason).toContain('does not require reverification');
    });

    it('suppresses duplicate material update notifications using idempotencyKey', () => {
      const email = createMockEmail({
        id: 'msg_update_dup',
        importanceScore: 70,
        urgencyScore: 60,
      });
      const changeResult = createMockChangeResult({
        relation: 'UPDATE',
        deltas: [
          {
            field: 'venue',
            changeType: 'updated',
            description: 'Venue relocated',
            oldValue: 'SJT 101',
            newValue: 'SJT 717',
            evidence: ['Venue relocated'],
          },
        ],
      });
      const expectedKey = `notif::att_test_001::update_venue_msg_update_dup`;
      const item = createMockAttentionItem({
        id: 'att_test_001',
        notificationState: {
          lastNotifiedAt: 1726500000000,
          lastNotificationType: 'update',
          lastNotificationSeverity: 'high',
          deliveredNotificationKeys: [expectedKey],
          activeNotificationId: null,
        },
      });

      const result = evaluateAttentionEligibility({ item, email, changeResult });

      expect(result.idempotencyKey).toBe(expectedKey);
      expect(result.shouldNotify).toBe(false);
      expect(result.severity).toBe('silent');
      expect(result.reason).toContain('already delivered');
    });
  });

  // =========================================================================
  // 11. Relation Semantics: CONFLICT (Requirement 13)
  // =========================================================================
  describe('Relation: CONFLICT (Requirement 13)', () => {
    it('produces conflict notification and re-opens userAttentionState to unhandled without modifying factual state', () => {
      const email = createMockEmail({
        id: 'msg_conflict_01',
        importanceScore: 65,
        urgencyScore: 65,
      });
      const item = createMockAttentionItem({
        currentState: {
          primaryEventTimestamp: 1726573800000,
          primaryDeadlineTimestamp: null,
          venue: 'SJT 101',
          actionRequired: true,
          actionType: 'attend',
          itemLifecycleState: 'active',
          subEvents: [],
        },
        userAttentionState: 'handled',
      });
      const changeResult = createMockChangeResult({
        relation: 'CONFLICT',
        summary: 'Subject Software Role contradicts Announcement AI Role',
      });

      const result = evaluateAttentionEligibility({ item, email, changeResult });

      expect(result.shouldNotify).toBe(true);
      expect(result.notificationType).toBe('conflict');
      expect(result.severity).toBe('high');
      expect(result.userAttentionStateAction).toBe('reopen_unhandled');
      expect(result.nextUserAttentionState).toBe('unhandled');
      expect(result.idempotencyKey).toBe('notif::att_test_001::conflict_msg_conflict_01');

      // Factual state of item MUST NOT be modified
      expect(item.currentState.venue).toBe('SJT 101');
      expect(item.currentState.primaryEventTimestamp).toBe(1726573800000);
    });

    it('assigns critical severity to CONFLICT when importance or urgency >= 70', () => {
      const email = createMockEmail({ importanceScore: 75, urgencyScore: 50 });
      const item = createMockAttentionItem();
      const changeResult = createMockChangeResult({ relation: 'CONFLICT' });

      const result = evaluateAttentionEligibility({ item, email, changeResult });

      expect(result.shouldNotify).toBe(true);
      expect(result.severity).toBe('critical');
    });

    it('suppresses duplicate CONFLICT notifications using idempotencyKey', () => {
      const email = createMockEmail({ id: 'msg_conflict_dup' });
      const expectedKey = 'notif::att_test_001::conflict_msg_conflict_dup';
      const item = createMockAttentionItem({
        id: 'att_test_001',
        notificationState: {
          lastNotifiedAt: 1726500000000,
          lastNotificationType: 'conflict',
          lastNotificationSeverity: 'high',
          deliveredNotificationKeys: [expectedKey],
          activeNotificationId: null,
        },
      });
      const changeResult = createMockChangeResult({ relation: 'CONFLICT' });

      const result = evaluateAttentionEligibility({ item, email, changeResult });

      expect(result.shouldNotify).toBe(false);
      expect(result.severity).toBe('silent');
      expect(result.reason).toContain('already delivered');
      expect(result.nextUserAttentionState).toBe('unhandled');
    });
  });

  // =========================================================================
  // 12. Relation Semantics: CANCELLED (Requirement 14)
  // =========================================================================
  describe('Relation: CANCELLED (Requirement 14)', () => {
    it('produces cancellation notification with high severity without calling alarms/notifications API', () => {
      const email = createMockEmail({ importanceScore: 60, urgencyScore: 50 });
      const item = createMockAttentionItem();
      const changeResult = createMockChangeResult({
        relation: 'CANCELLED',
        summary: 'Recruitment process has been cancelled by company',
      });

      const result = evaluateAttentionEligibility({ item, email, changeResult });

      expect(result.shouldNotify).toBe(true);
      expect(result.severity).toBe('high');
      expect(result.notificationType).toBe('cancellation');
      expect(result.idempotencyKey).toBe('notif::att_test_001::cancelled');
      expect(result.isMaterialChange).toBe(true);
      expect(result.userAttentionStateAction).toBe('preserve');
    });

    it('suppresses duplicate cancellation notifications using idempotencyKey', () => {
      const email = createMockEmail();
      const item = createMockAttentionItem({
        id: 'att_test_001',
        notificationState: {
          lastNotifiedAt: 1726500000000,
          lastNotificationType: 'cancellation',
          lastNotificationSeverity: 'high',
          deliveredNotificationKeys: ['notif::att_test_001::cancelled'],
          activeNotificationId: null,
        },
      });
      const changeResult = createMockChangeResult({ relation: 'CANCELLED' });

      const result = evaluateAttentionEligibility({ item, email, changeResult });

      expect(result.shouldNotify).toBe(false);
      expect(result.severity).toBe('silent');
      expect(result.reason).toContain('already delivered');
    });

    it('suppresses cancellation notification when category alerts are silenced', () => {
      const email = createMockEmail();
      const item = createMockAttentionItem();
      const changeResult = createMockChangeResult({ relation: 'CANCELLED' });
      const silencedCategory: CategoryConfig = {
        id: 'career_placement',
        label: 'Career',
        defaultPriority: 'high',
        alertEnabled: false,
        userMultiplier: 1.0,
        keywords: [],
        color: '#000',
      };

      const result = evaluateAttentionEligibility({
        item,
        email,
        changeResult,
        categoryConfig: silencedCategory,
      });

      expect(result.shouldNotify).toBe(false);
      expect(result.categorySilenced).toBe(true);
      expect(result.severity).toBe('silent');
    });
  });

  // =========================================================================
  // 13. Idempotency Key Generation & Immutability
  // =========================================================================
  describe('generateIdempotencyKey & Immutability Invariant', () => {
    it('generates consistent, deterministic idempotency keys for all relations', () => {
      const item = createMockAttentionItem({ id: 'att_idem_1' });
      const email = createMockEmail({ id: 'msg_idem_1' });

      // NEW
      const newKey = generateIdempotencyKey(
        item,
        email,
        createMockChangeResult({ relation: 'NEW' })
      );
      expect(newKey).toBe('notif::att_idem_1::new');

      // REPEAT
      const repeatKey = generateIdempotencyKey(
        item,
        email,
        createMockChangeResult({ relation: 'REPEAT' })
      );
      expect(repeatKey).toBeNull();

      // UPDATE with material fields
      const updateKey = generateIdempotencyKey(
        item,
        email,
        createMockChangeResult({
          relation: 'UPDATE',
          deltas: [
            {
              field: 'venue',
              changeType: 'updated',
              description: 'Venue relocated',
              oldValue: 'A',
              newValue: 'B',
              evidence: ['Venue A to B'],
            },
            {
              field: 'primaryEventTimestamp',
              changeType: 'updated',
              description: 'Time updated',
              oldValue: 1,
              newValue: 2,
              evidence: ['Time updated'],
            },
          ],
        })
      );
      expect(updateKey).toBe(
        'notif::att_idem_1::update_primaryEventTimestamp_venue_msg_idem_1'
      );

      // UPDATE with non-material fields
      const nonMaterialKey = generateIdempotencyKey(
        item,
        email,
        createMockChangeResult({
          relation: 'UPDATE',
          deltas: [
            {
              field: 'topic',
              changeType: 'updated',
              description: 'Topic updated',
              oldValue: 'a',
              newValue: 'b',
              evidence: ['Topic changed'],
            },
          ],
        })
      );
      expect(nonMaterialKey).toBeNull();

      // CONFLICT
      const conflictKey = generateIdempotencyKey(
        item,
        email,
        createMockChangeResult({ relation: 'CONFLICT' })
      );
      expect(conflictKey).toBe('notif::att_idem_1::conflict_msg_idem_1');

      // CANCELLED
      const cancelledKey = generateIdempotencyKey(
        item,
        email,
        createMockChangeResult({ relation: 'CANCELLED' })
      );
      expect(cancelledKey).toBe('notif::att_idem_1::cancelled');
    });

    it('does NOT mutate input item, email, or changeResult (Purity Invariant)', () => {
      const item = createMockAttentionItem();
      const email = createMockEmail();
      const changeResult = createMockChangeResult({
        relation: 'UPDATE',
        deltas: [
          {
            field: 'venue',
            changeType: 'updated',
            description: 'Venue relocated',
            oldValue: 'SJT 101',
            newValue: 'SJT 717',
            evidence: ['Relocated'],
          },
        ],
      });

      const itemSnapshot = JSON.stringify(item);
      const emailSnapshot = JSON.stringify(email);
      const changeResultSnapshot = JSON.stringify(changeResult);

      evaluateAttentionEligibility({ item, email, changeResult });

      expect(JSON.stringify(item)).toBe(itemSnapshot);
      expect(JSON.stringify(email)).toBe(emailSnapshot);
      expect(JSON.stringify(changeResult)).toBe(changeResultSnapshot);
    });
  });
});
