/**
 * Phase 5 Attention & Notification Engine Constants
 */

import { ProximityAlarmConfig, ProximityStage } from './types';

// Configurable weights for combined attention score formula
export const IMPORTANCE_WEIGHT = 0.45;
export const URGENCY_WEIGHT = 0.55;

// Proximity reminder stages in milliseconds
export const PROXIMITY_MS_48H = 48 * 60 * 60 * 1000;
export const PROXIMITY_MS_24H = 24 * 60 * 60 * 1000;
export const PROXIMITY_MS_3H = 3 * 60 * 60 * 1000;
export const PROXIMITY_MS_30M = 30 * 60 * 1000;

export const PROXIMITY_STAGES: ProximityStage[] = ['48h', '24h', '3h', '30m'];

export const PROXIMITY_STAGE_CONFIGS: Record<ProximityStage, ProximityAlarmConfig> = {
  '48h': {
    stage: '48h',
    offsetMs: PROXIMITY_MS_48H,
    minSeverity: 'high',
    requiresExactTime: false,
    requiresPhysicalPresence: false,
  },
  '24h': {
    stage: '24h',
    offsetMs: PROXIMITY_MS_24H,
    minSeverity: 'standard',
    requiresExactTime: false,
    requiresPhysicalPresence: false,
  },
  '3h': {
    stage: '3h',
    offsetMs: PROXIMITY_MS_3H,
    minSeverity: 'critical',
    requiresExactTime: true,
    requiresPhysicalPresence: false,
  },
  '30m': {
    stage: '30m',
    offsetMs: PROXIMITY_MS_30M,
    minSeverity: 'critical',
    requiresExactTime: true,
    requiresPhysicalPresence: true,
  },
};

// High-urgency and high-importance score overrides
export const CRITICAL_URGENCY_OVERRIDE_THRESHOLD = 80;
export const CRITICAL_IMPORTANCE_OVERRIDE_THRESHOLD = 85;
export const HIGH_IMPORTANCE_THRESHOLD = 70;

// Default snooze duration in milliseconds (60 minutes)
export const DEFAULT_SNOOZE_MS = 60 * 60 * 1000;

// Maximum grace period for evaluating missed proximity alarms upon worker recovery (15 minutes)
export const MISSED_ALARM_GRACE_MS = 15 * 60 * 1000;
