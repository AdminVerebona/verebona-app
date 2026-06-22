export type DuoSubscriptionStatus = 'ACTIVE' | 'PAST_DUE_GRACE' | 'UNPAID_RECOVERY' | 'CANCELED';
export type DuoMembershipStatus = 'INVITED' | 'ACTIVE' | 'LEFT';
export type DuoRole = 'BILLING_OWNER' | 'MEMBER';
export type AssetLockState = 'NONE' | 'PENDING_MOVE' | 'PENDING_DELETE';
export type MoveRequestStatus = 'PENDING' | 'ACCEPTED' | 'REFUSED' | 'CANCELLED';
export type DeleteRequestStatus = 'PENDING' | 'ACCEPTED' | 'REFUSED' | 'CANCELLED';
export type ResolutionMode = 'MOVE_ONLY' | 'MOVE_AND_COPY';
export type CopyJobStatus = 'NONE' | 'PENDING' | 'RUNNING' | 'FAILED' | 'SUCCEEDED';
export type ResolvedByType = 'USER' | 'SYSTEM';
export type DunningStage = 'T0' | 'D14' | 'D7' | 'D1' | 'RECOVERY';

export interface DuoAccount {
  id: number;
  billingOwnerUserId: number;
  subscriptionStatus: DuoSubscriptionStatus;
  activatedAt: string | null;
  firstPaymentFailedAt: string | null;
  graceDeadlineAt: string | null;
  stripeSubscriptionId: string | null;
  stripeCustomerId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DuoMembership {
  id: number;
  duoId: number;
  userId: number;
  status: DuoMembershipStatus;
  slot: number | null;
  invitedAt: string;
  joinedAt: string | null;
  leftAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AssetMoveRequest {
  id: number;
  assetId: number;
  duoId: number;
  targetAccountId: number;
  initiatorUserId: number;
  validatorUserId: number;
  status: MoveRequestStatus;
  resolutionMode: ResolutionMode | null;
  copyJobStatus: CopyJobStatus;
  copiedAssetId: number | null;
  copyErrorCode: string | null;
  copyErrorMessage: string | null;
  resolvedAt: string | null;
  resolvedByUserId: number | null;
  resolvedByType: ResolvedByType | null;
  assetLabelSnapshot: string;
  targetUserSnapshot: string;
  initiatorUserSnapshot: string;
  createdAt: string;
}

export interface AssetDeleteRequest {
  id: number;
  assetId: number;
  duoId: number;
  initiatorUserId: number;
  validatorUserId: number;
  status: DeleteRequestStatus;
  resolvedAt: string | null;
  resolvedByUserId: number | null;
  resolvedByType: ResolvedByType | null;
  assetLabelSnapshot: string;
  initiatorUserSnapshot: string;
  createdAt: string;
}

export interface Notification {
  id: number;
  userId: number;
  type: string;
  payloadJson: string | null;
  dedupeKey: string | null;
  mustDeliver: boolean;
  createdAt: string;
  readAt: string | null;
}

export interface DuoUserInfo {
  duoId: number | null;
  duoStatus: DuoSubscriptionStatus | null;
  duoRole: DuoRole | null;
  duoActivatedAt: string | null;
  graceDeadlineAt: string | null;
  isInRecovery: boolean;
  duoEntitlement: boolean;
}

export interface InboxRequestDTO {
  request_id: number;
  type: 'MOVE' | 'DELETE';
  asset_id: number;
  asset_label_snapshot: string;
  initiator_display: string;
  target_display: string | null;
  created_at: string;
  actions_allowed: ('ACCEPT' | 'REFUSE')[];
}

export interface RecoveryAssetDTO {
  id: number;
  label: string;
  lock_state: AssetLockState;
}
