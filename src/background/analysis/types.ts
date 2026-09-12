import { ActionType, TemporalAnalysis } from '../../shared/types';

export interface SenderSignals {
  senderEmail: string;
  senderName: string;
  domain: string;
  isAutomatedSender: boolean;
  isAcademicDomain: boolean;
  isGovernmentDomain: boolean;
  isMajorFreeMail: boolean;
}

export interface ContentSignals {
  actionVerbs: string[];
  recruitmentKeywords: string[];
  financeKeywords: string[];
  academicKeywords: string[];
  eventKeywords: string[];
  healthcareKeywords: string[];
  legalGovKeywords: string[];
  travelKeywords: string[];
  shoppingKeywords: string[];
  promotionalKeywords: string[];
  // Contextual combination patterns
  hasOfferPattern: boolean;
  hasSelectionPattern: boolean;
  hasCampusDrivePattern: boolean;
  hasAssessmentWorkflowPattern: boolean;
  // Urgency & temporal signals (Phase 2)
  hasImminentDeadline: boolean;
  hasUpcomingDeadline: boolean;
  hasDisruptionLanguage: boolean;
  hasExplicitActionRequest: boolean;
  hasCommercialUrgency: boolean;
  hasScheduledEvent: boolean;
  hasActionableContext: boolean;
}

export interface StructuralSignals {
  hasMailingListUnsubscribe: boolean;
  hasAutomatedDisclaimer: boolean;
  hasReplySubject: boolean;
  hasUrls: boolean;
  gmailLabels: string[];
}

export interface EmailSignals {
  sender: SenderSignals;
  content: ContentSignals;
  structural: StructuralSignals;
  extractedAt: number;
}

export interface CategoryEvidence {
  category: string;
  score: number; // 0 to 100 evidence score
  reasons: string[];
}

export interface CategoryResult {
  category: string; // primary category ID or 'uncategorized'
  categoryScore: number; // 0 to 100 evidence score for primary category
  confidence: number; // 0.0 to 1.0 for backward compatibility
  detectionReasons: string[]; // reasons for the selected category
  categoryScores: Record<string, number>; // evidence scores for all evaluated categories
  allEvidence: Record<string, string[]>; // evidence reasons for each evaluated category
}

export interface ImportanceResult {
  importanceScore: number; // 0 to 100 evidence score
  importanceReasons: string[];
}

export interface UrgencyResult {
  urgencyScore: number; // 0 to 100 evidence score
  urgencyReasons: string[];
  actionRequired: boolean;
  actionType: ActionType | null;
}

export interface AnalysisOutput {
  signals: EmailSignals;
  result: CategoryResult;
  importance: ImportanceResult;
  urgency: UrgencyResult;
  temporal: TemporalAnalysis;
}

