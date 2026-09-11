import Dexie, { type Table } from 'dexie';
import {
  AttentionItem,
  CategoryWeight,
  EmailRecord,
  ScheduledAlarmRecord,
  SenderProfile,
  UserFeedback,
} from '../shared/types';

export class IGAMDatabase extends Dexie {
  emails!: Table<EmailRecord, string>;
  senderProfiles!: Table<SenderProfile, string>;
  userFeedback!: Table<UserFeedback, number>;
  categoryWeights!: Table<CategoryWeight, string>;
  scheduledAlarms!: Table<ScheduledAlarmRecord, string>;
  attentionItems!: Table<AttentionItem, string>;

  constructor(databaseName = 'igam_db') {
    super(databaseName);

    // Schema definition for version 1
    this.version(1).stores({
      emails: 'id, threadId, category, alertStatus, importanceScore, urgencyScore, processedAt, internalDate, snoozeUntil',
      senderProfiles: 'email, domain, reputationScore, lastSeen',
      userFeedback: '++id, emailId, timestamp, category, action',
      categoryWeights: 'categoryId, lastUpdated',
      scheduledAlarms: 'alarmName, emailId, scheduledAt, alarmType',
    });

    // Schema definition for version 2 (Phase 3: analysisVersion index for automatic stale migration)
    this.version(2).stores({
      emails: 'id, threadId, category, alertStatus, importanceScore, urgencyScore, analysisVersion, processedAt, internalDate, snoozeUntil',
    });

    // Schema definition for version 3 (Phase 4: attentionItems table and attentionItemId foreign index on emails)
    this.version(3)
      .stores({
        emails:
          'id, threadId, attentionItemId, category, alertStatus, importanceScore, urgencyScore, analysisVersion, processedAt, internalDate, snoozeUntil',
        attentionItems:
          'id, identityKey, category, canonicalEntity, itemLifecycleState, userAttentionState, firstSeenAt, lastSeenAt, latestEmailId',
      })
      .upgrade(async (tx) => {
        await tx
          .table('emails')
          .toCollection()
          .modify((email: any) => {
            if (email.attentionItemId === undefined) {
              email.attentionItemId = null;
            }
            if (email.changeRelation === undefined) {
              email.changeRelation = null;
            }
          });
      });

    // Schema definition for version 4 (Phase 5: notificationState on attentionItems and attentionItemId index on scheduledAlarms)
    this.version(4)
      .stores({
        scheduledAlarms: 'alarmName, attentionItemId, emailId, scheduledAt, alarmType',
      })
      .upgrade(async (tx) => {
        // 1. Initialize safe default notificationState on any existing attentionItems
        await tx
          .table('attentionItems')
          .toCollection()
          .modify((item: any) => {
            if (item.notificationState === undefined) {
              item.notificationState = {
                lastNotifiedAt: null,
                lastNotificationType: null,
                lastNotificationSeverity: null,
                deliveredNotificationKeys: [],
                activeNotificationId: null,
              };
            }
          });

        // 2. Initialize attentionItemId on any existing scheduledAlarms
        await tx
          .table('scheduledAlarms')
          .toCollection()
          .modify((alarm: any) => {
            if (alarm.attentionItemId === undefined) {
              alarm.attentionItemId = null;
            }
          });
      });
  }
}

export const db = new IGAMDatabase();
