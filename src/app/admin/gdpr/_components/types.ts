import type { GdprChannel, GdprOrigin, GdprRightType, GdprStatus } from '@/services/gdpr/rules';

export interface GdprRequestItem {
  id: number;
  origin: GdprOrigin;
  status: GdprStatus;
  rightType: GdprRightType;
  channel: GdprChannel;
  receivedAt: string;
  receivedDate: string;
  dueDate: string;
  processedAt: string | null;
  result: string | null;
  lastError: string | null;
  reopenedAt: string | null;
  reopenCount: number;
  userId: number | null;
  accountId: number | null;
  subjectUserRef: number | null;
  subjectAccountRef: number | null;
  subjectEmail: string | null;
  subjectName: string | null;
  accountName: string | null;
  /** Suppression planifiée liée (demande système), en lecture seule — GDP-008. */
  deletion?: {
    status: 'SCHEDULED' | 'CANCELLED' | 'EXECUTED' | 'FAILED';
    reason: string;
    scheduledAt: string;
    executedAt: string | null;
    cancelledAt: string | null;
  } | null;
}

const DELETION_STATUS_LABELS: Record<string, string> = {
  SCHEDULED: 'Suppression programmée',
  CANCELLED: 'Suppression annulée',
  EXECUTED: 'Suppression exécutée',
  FAILED: 'Suppression en échec',
};

/** « Suppression programmée le 28/10/2026 » — état et date de la suppression liée. */
export function deletionLabel(d: GdprRequestItem['deletion']): string | null {
  if (!d) return null;
  const at = d.status === 'EXECUTED' && d.executedAt ? d.executedAt
    : d.status === 'CANCELLED' && d.cancelledAt ? d.cancelledAt
    : d.scheduledAt;
  const date = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'short' }).format(new Date(at));
  const label = DELETION_STATUS_LABELS[d.status] ?? d.status;
  return d.status === 'SCHEDULED' || d.status === 'FAILED' ? `${label} — prévue le ${date}` : `${label} le ${date}`;
}

export interface GdprRequestDetail extends GdprRequestItem {
  internalComment: string | null;
  reopenedByEmail: string | null;
  createdByEmail: string | null;
  updatedByEmail: string | null;
  sourceRef: string | null;
}

export interface Subject {
  userId: number;
  email: string;
  name: string;
  accountId: number | null;
  accountName: string | null;
}

/** Libellé de la personne concernée, y compris après suppression du compte. */
export function subjectLabel(r: Pick<GdprRequestItem, 'subjectEmail' | 'subjectName' | 'userId' | 'subjectUserRef'>): string {
  if (r.subjectEmail) return r.subjectEmail;
  if (r.subjectUserRef) return `Utilisateur #${r.subjectUserRef}${r.userId ? '' : ' (supprimé)'}`;
  return '—';
}

export function accountLabel(r: Pick<GdprRequestItem, 'accountName' | 'accountId' | 'subjectAccountRef'>): string {
  if (r.accountName) return r.accountName;
  if (r.subjectAccountRef) return `Compte #${r.subjectAccountRef}${r.accountId ? '' : ' (supprimé)'}`;
  return '—';
}

/** « JJ/MM/AAAA » d'une date calendaire « AAAA-MM-JJ » (UX-006). */
export function formatIsoDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}
