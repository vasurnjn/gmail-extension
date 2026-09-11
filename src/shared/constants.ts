import { CategoryConfig, ExtensionSettings, LocalSyncState } from './types';

export const ALARM_GMAIL_POLL = 'gmailPoll';
export const ALARM_SAFETY_SCAN = 'gmailSafetyScan';

export const CURRENT_ANALYSIS_VERSION = 4;

// Phase 5 Attention & Notification weights
export const IMPORTANCE_WEIGHT = 0.45;
export const URGENCY_WEIGHT = 0.55;

export const DEFAULT_POLL_INTERVAL_MINUTES = 2;
export const DEFAULT_SAFETY_SCAN_INTERVAL_MINUTES = 30;

export const STORAGE_KEY_SETTINGS = 'igam_settings';
export const STORAGE_KEY_SYNC_STATE = 'igam_sync_state';
export const STORAGE_KEY_CATEGORIES = 'igam_categories';

export const DEFAULT_SETTINGS: ExtensionSettings = {
  alertThreshold: 50,
  pollingIntervalMinutes: DEFAULT_POLL_INTERVAL_MINUTES,
  showBadge: true,
  defaultSnoozeMinutes: 60,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  useBuiltInAI: true,
  theme: 'system',
};

export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const GMAIL_PROFILE_ENDPOINT = 'https://gmail.googleapis.com/gmail/v1/users/me/profile';
export const GMAIL_MESSAGES_ENDPOINT = 'https://gmail.googleapis.com/gmail/v1/users/me/messages';
export const GMAIL_HISTORY_ENDPOINT = 'https://gmail.googleapis.com/gmail/v1/users/me/history';

export const DEFAULT_SYNC_STATE: LocalSyncState = {
  historyId: null,
  lastPollTime: null,
  lastSafetyScanTime: null,
  lastSyncTime: null,
  isSyncing: false,
  authState: 'not_connected',
  accountEmail: null,
  lastError: null,
};

/**
 * Default categories.
 * The 3 primary target categories receive the highest base priorities:
 * 1. Career & Placement
 * 2. Finance & Banking
 * 3. Academic & Education
 */
export const DEFAULT_CATEGORIES: CategoryConfig[] = [
  {
    id: 'career_placement',
    label: 'Career & Placement',
    description: 'Jobs, internships, recruitment and assessments',
    defaultPriority: 'high',
    alertEnabled: true,
    userMultiplier: 1.0,
    keywords: [
      'placement', 'recruitment', 'campus drive', 'interview', 'assessment',
      'eligibility', 'ctc', 'job offer', 'shortlist', 'internship', 'hiring',
      'aptitude test', 'selection process', 'registration link'
    ],
    color: '#3b82f6', // blue
  },
  {
    id: 'finance_banking',
    label: 'Finance & Banking',
    description: 'Banking, payments, bills and financial activity',
    defaultPriority: 'high',
    alertEnabled: true,
    userMultiplier: 1.0,
    keywords: [
      'bank', 'otp', 'transaction', 'due date', 'statement', 'credit card',
      'payment due', 'invoice', 'salary', 'tax', 'emi', 'refund'
    ],
    color: '#10b981', // green
  },
  {
    id: 'academic_education',
    label: 'Academic & Education',
    description: 'Classes, assignments, exams and university updates',
    defaultPriority: 'high',
    alertEnabled: true,
    userMultiplier: 1.0,
    keywords: [
      'exam', 'hall ticket', 'course enrollment', 'assignment deadline',
      'grade', 'fee payment', 'semester', 'thesis', 'admit card', 'scholarship'
    ],
    color: '#8b5cf6', // purple
  },
  {
    id: 'events_meetings',
    label: 'Events & Meetings',
    description: 'Invitations, meetings and scheduled events',
    defaultPriority: 'medium',
    alertEnabled: true,
    userMultiplier: 1.0,
    keywords: ['calendar invite', 'webinar', 'conference', 'rsvp', 'meeting agenda', 'zoom link', 'google meet'],
    color: '#f59e0b', // amber
  },
  {
    id: 'healthcare',
    label: 'Healthcare',
    description: 'Doctor appointments, prescriptions and health reports',
    defaultPriority: 'high',
    alertEnabled: true,
    userMultiplier: 1.0,
    keywords: ['appointment', 'doctor', 'lab test', 'prescription', 'health checkup', 'clinic'],
    color: '#ef4444', // red
  },
  {
    id: 'legal_government',
    label: 'Legal & Government',
    description: 'Official notices, government portals, taxes and legal documents',
    defaultPriority: 'high',
    alertEnabled: true,
    userMultiplier: 1.0,
    keywords: ['passport', 'visa', 'tax filing', 'court notice', 'kyc', 'government verification'],
    color: '#6366f1', // indigo
  },
  {
    id: 'travel_transport',
    label: 'Travel & Transport',
    description: 'Flights, trains, hotel bookings and itineraries',
    defaultPriority: 'medium',
    alertEnabled: true,
    userMultiplier: 1.0,
    keywords: ['flight booking', 'pnr', 'boarding pass', 'train ticket', 'hotel reservation', 'check-in'],
    color: '#06b6d4', // cyan
  },
  {
    id: 'shopping_orders',
    label: 'Shopping & Orders',
    description: 'Order confirmations, package tracking and receipts',
    defaultPriority: 'low',
    alertEnabled: false,
    userMultiplier: 0.5,
    keywords: ['order confirmed', 'shipped', 'out for delivery', 'package delivered', 'track package'],
    color: '#64748b', // slate
  },
  {
    id: 'newsletters_promotions',
    label: 'Newsletters & Promotions',
    description: 'Marketing updates, newsletters, sales and discounts',
    defaultPriority: 'silent',
    alertEnabled: false,
    userMultiplier: 0.0,
    keywords: ['unsubscribe', 'promo', 'discount', 'newsletter', 'weekly digest', 'sale ends'],
    color: '#94a3b8', // light slate
  },
  {
    id: 'personal',
    label: 'Personal & Direct',
    description: 'Direct personal emails and conversations',
    defaultPriority: 'medium',
    alertEnabled: true,
    userMultiplier: 1.0,
    keywords: [],
    color: '#ec4899', // pink
  },
];
