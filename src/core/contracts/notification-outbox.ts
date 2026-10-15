import type { Job } from './types';
import type { ApprovalIntentSnap } from './tools';
import type { ToolApprovalConfig } from '../config/tools-config';

export const NOTIFICATION_KINDS = ['callback', 'delivery', 'approval-notification', 'delivery-dlq'] as const;
export type NotificationKind = typeof NOTIFICATION_KINDS[number];
export const NOTIFICATION_STATUSES = ['pending', 'processing', 'completed', 'skipped', 'failed', 'uncertain'] as const;
export type NotificationStatus = typeof NOTIFICATION_STATUSES[number];
export interface ApprovalNotificationDraft {
  job: Job;
  provider_name: string;
  subject: string;
  subject_field?: string;
  snap: ApprovalIntentSnap;
  destination?: ToolApprovalConfig;
  brand_name?: string;
}
export interface ApprovalNotificationPayload extends ApprovalNotificationDraft { approval_id: number }
export interface NotificationEvent {
  event_id: string;
  kind: NotificationKind;
  job_id: string;
  request_id: string;
  payload: { job: Job; brand_name?: string } | ApprovalNotificationPayload;
  status: NotificationStatus;
  attempts: number;
  cycle_attempts: number;
  recovery: 'retry' | 'uncertain';
  available_at: string;
  created_at: string;
  updated_at: string;
  lease_token?: string;
  lease_until?: string;
  lease_owner?: string;
  last_error?: string;
  completed_at?: string;
}
export interface NotificationClaimOptions { owner: string; kinds?: NotificationKind[]; limit?: number; leaseMs?: number; now?: string }
export interface NotificationListOptions { kinds?: NotificationKind[]; statuses?: NotificationStatus[]; limit?: number; offset?: number }
export interface NotificationSnapshot {
  counts: Record<NotificationStatus, number>;
  oldestPendingAgeSeconds: number;
  expiredLeases: number;
}
export interface NotificationOutboxRepository {
  claim(options: NotificationClaimOptions): Promise<NotificationEvent[]>;
  renew(eventId: string, leaseToken: string, leaseMs: number): Promise<boolean>;
  complete(eventId: string, leaseToken: string, outcome?: 'completed' | 'skipped', note?: string): Promise<boolean>;
  fail(eventId: string, leaseToken: string, options: { status: 'pending' | 'failed' | 'uncertain'; error: string; availableAt?: string }): Promise<boolean>;
  retry(eventId: string, options?: { expectedStatus?: 'failed' | 'uncertain'; allowUncertain?: boolean; now?: string }): Promise<boolean>;
  get(eventId: string): Promise<NotificationEvent | null>;
  list(options?: NotificationListOptions): Promise<NotificationEvent[]>;
  snapshot(options?: { kinds?: NotificationKind[]; now?: string }): Promise<NotificationSnapshot>;
}
