/**
 * Règles métier des demandes RGPD — CDC Back-Office V1 §12.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * MODULE PUR : aucune base, aucun réseau.
 *
 * Tout ce qui décide (échéance, jours restants, transitions de statut,
 * recevabilité d'une modification ou d'une réouverture) est ici, pour être
 * vérifiable sans infrastructure. Les routes et le dépôt ne font qu'appliquer
 * le plan renvoyé.
 * ══════════════════════════════════════════════════════════════════════════
 */

export const GDPR_ORIGINS = ['system', 'manual'] as const;
export type GdprOrigin = (typeof GDPR_ORIGINS)[number];

/** GDP-012 : trois statuts, aucun « Rejetée / non recevable ». */
export const GDPR_STATUSES = ['received', 'in_progress', 'done'] as const;
export type GdprStatus = (typeof GDPR_STATUSES)[number];

export const GDPR_RIGHT_TYPES = [
  'access', 'rectification', 'erasure', 'restriction', 'portability', 'objection', 'other',
] as const;
export type GdprRightType = (typeof GDPR_RIGHT_TYPES)[number];

export const GDPR_CHANNELS = ['app', 'email', 'postal_mail', 'phone', 'other'] as const;
export type GdprChannel = (typeof GDPR_CHANNELS)[number];

export const STATUS_LABELS: Record<GdprStatus, string> = {
  received: 'Reçue',
  in_progress: 'En cours',
  done: 'Traitée',
};

export const RIGHT_LABELS: Record<GdprRightType, string> = {
  access: 'Accès',
  rectification: 'Rectification',
  erasure: 'Effacement',
  restriction: 'Limitation',
  portability: 'Portabilité',
  objection: 'Opposition',
  other: 'Autre',
};

export const CHANNEL_LABELS: Record<GdprChannel, string> = {
  app: 'Application',
  email: 'E-mail',
  postal_mail: 'Courrier',
  phone: 'Téléphone',
  other: 'Autre',
};

export const ORIGIN_LABELS: Record<GdprOrigin, string> = {
  system: 'Système',
  manual: 'Manuelle',
};

export function isStatus(v: unknown): v is GdprStatus {
  return typeof v === 'string' && (GDPR_STATUSES as readonly string[]).includes(v);
}
export function isRightType(v: unknown): v is GdprRightType {
  return typeof v === 'string' && (GDPR_RIGHT_TYPES as readonly string[]).includes(v);
}
export function isChannel(v: unknown): v is GdprChannel {
  return typeof v === 'string' && (GDPR_CHANNELS as readonly string[]).includes(v);
}

/* ── Dates calendaires (Europe/Paris) ─────────────────────────────────── */

export const GDPR_TIME_ZONE = 'Europe/Paris';
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Date calendaire « AAAA-MM-JJ » valide ? */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1) return false;
  return d <= daysInMonth(y, mo);
}

function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Date calendaire à Paris de l'instant donné (« AAAA-MM-JJ »). */
export function parisDateOf(instant: Date): string {
  // en-CA formate en AAAA-MM-JJ.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: GDPR_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(instant);
}

/**
 * Ajoute un mois calendaire à une date « AAAA-MM-JJ ».
 *
 * Règle de computation des délais exprimés en mois (règlement CEE/Euratom
 * 1182/71, art. 3.2.c, applicable au délai d'un mois de l'art. 12.3 RGPD) :
 * le délai expire le jour du mois suivant portant le même quantième ; si ce
 * jour n'existe pas, le dernier jour de ce mois. 31 janvier → 28/29 février,
 * 31 mars → 30 avril, 31 décembre → 31 janvier.
 */
export function addOneMonth(isoDate: string): string {
  if (!isIsoDate(isoDate)) throw new RangeError(`Date invalide : ${isoDate}`);
  const [y, m, d] = isoDate.split('-').map(Number);
  const year = m === 12 ? y + 1 : y;
  const month = m === 12 ? 1 : m + 1;
  const day = Math.min(d, daysInMonth(year, month));
  return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * Échéance réglementaire d'une demande (GDP-011) : un mois à compter de la
 * réception (art. 12.3 RGPD), quel que soit le droit exercé en V1.
 *
 * Le type de droit est un paramètre du calcul pour que les règles
 * applicables puissent évoluer (prolongation de deux mois pour une demande
 * complexe, par exemple) sans changer les appelants : c'est la donnée qui
 * déclenche le recalcul en édition (GDP-014).
 */
export function computeDueDate(receivedDate: string, _rightType?: GdprRightType): string {
  return addOneMonth(receivedDate);
}

/** Échéance à partir d'un instant de réception (demandes système). */
export function computeDueDateFromInstant(receivedAt: Date, rightType?: GdprRightType): string {
  return computeDueDate(parisDateOf(receivedAt), rightType);
}

/**
 * Jours restants avant l'échéance (GDP-003), en jours calendaires à Paris.
 * 0 = échéance aujourd'hui ; négatif = dépassée. Aucun seuil d'alerte.
 */
export function daysRemaining(dueDate: string, now: Date = new Date()): number {
  const today = parisDateOf(now);
  const toUtc = (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toUtc(dueDate) - toUtc(today)) / 86_400_000);
}

/* ── Transitions de statut ─────────────────────────────────────────────── */

/**
 * Transitions MANUELLES admises (GDP-012) : uniquement vers l'avant.
 * « Traitée » est terminale ; en sortir passe par la réouverture (GDP-015).
 */
const FORWARD: Record<GdprStatus, readonly GdprStatus[]> = {
  received: ['in_progress', 'done'],
  in_progress: ['done'],
  done: [],
};

export function canTransition(from: GdprStatus, to: GdprStatus): boolean {
  return from === to || FORWARD[from].includes(to);
}

/* ── Modification d'une demande manuelle ──────────────────────────────── */

export interface GdprRequestState {
  origin: GdprOrigin;
  status: GdprStatus;
  rightType: GdprRightType;
  channel: GdprChannel;
  receivedDate: string;
  dueDate: string;
  internalComment: string | null;
  result: string | null;
  userId: number | null;
  accountId: number | null;
}

export type GdprRuleError =
  | 'SYSTEM_REQUEST_READ_ONLY'
  | 'REQUEST_DONE_FROZEN'
  | 'NOT_DONE'
  | 'INVALID_TRANSITION'
  | 'DUE_DATE_NOT_ACCEPTED'
  | 'INVALID_FIELD'
  | 'RECEIVED_IN_FUTURE'
  | 'SUBJECT_REQUIRED'
  | 'NOTHING_TO_UPDATE';

export const RULE_ERROR_MESSAGES: Record<GdprRuleError, string> = {
  SYSTEM_REQUEST_READ_ONLY: 'Demande générée par le système : son statut est piloté automatiquement et elle ne peut pas être modifiée depuis le back-office.',
  REQUEST_DONE_FROZEN: 'Demande traitée : elle est figée. Rouvrez-la pour la modifier.',
  NOT_DONE: 'Seule une demande traitée peut être rouverte.',
  INVALID_TRANSITION: 'Changement de statut non autorisé (Reçue → En cours → Traitée).',
  DUE_DATE_NOT_ACCEPTED: 'L’échéance est calculée automatiquement à partir de la date de réception ; elle ne peut pas être saisie.',
  INVALID_FIELD: 'Donnée invalide.',
  RECEIVED_IN_FUTURE: 'La date de réception ne peut pas être dans le futur.',
  SUBJECT_REQUIRED: 'Indiquez l’utilisateur ou le compte concerné.',
  NOTHING_TO_UPDATE: 'Aucune modification.',
};

/** Champs acceptés en entrée d'une création / modification manuelle. */
export interface ManualRequestInput {
  userId?: number | null;
  accountId?: number | null;
  rightType?: unknown;
  channel?: unknown;
  receivedDate?: unknown;
  status?: unknown;
  internalComment?: unknown;
  result?: unknown;
}

/** Champs interdits en entrée : l'échéance n'est jamais saisie (GDP-011). */
const FORBIDDEN_KEYS = ['dueDate', 'due_date', 'dueAt', 'due_at'];

export type Plan<T> = { ok: true; value: T } | { ok: false; error: GdprRuleError; field?: string };

function textOrNull(v: unknown, max = 5000): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

export interface CreatePlan {
  userId: number | null;
  accountId: number | null;
  rightType: GdprRightType;
  channel: GdprChannel;
  receivedDate: string;
  dueDate: string;
  status: GdprStatus;
  internalComment: string | null;
  result: string | null;
}

/** Création manuelle (GDP-010, GDP-011). */
export function planManualCreate(
  raw: ManualRequestInput & Record<string, unknown>,
  now: Date = new Date(),
): Plan<CreatePlan> {
  if (FORBIDDEN_KEYS.some((k) => k in raw)) return { ok: false, error: 'DUE_DATE_NOT_ACCEPTED' };
  const userId = raw.userId ?? null;
  const accountId = raw.accountId ?? null;
  if (userId === null && accountId === null) return { ok: false, error: 'SUBJECT_REQUIRED' };
  for (const [field, v] of [['userId', userId], ['accountId', accountId]] as const) {
    if (v !== null && !(Number.isSafeInteger(v) && v > 0)) return { ok: false, error: 'INVALID_FIELD', field };
  }
  if (!isRightType(raw.rightType)) return { ok: false, error: 'INVALID_FIELD', field: 'rightType' };
  if (!isChannel(raw.channel)) return { ok: false, error: 'INVALID_FIELD', field: 'channel' };
  if (!isIsoDate(raw.receivedDate)) return { ok: false, error: 'INVALID_FIELD', field: 'receivedDate' };
  if (raw.receivedDate > parisDateOf(now)) return { ok: false, error: 'RECEIVED_IN_FUTURE' };
  const status = raw.status === undefined ? 'received' : raw.status;
  if (!isStatus(status)) return { ok: false, error: 'INVALID_FIELD', field: 'status' };
  const internalComment = textOrNull(raw.internalComment);
  const result = textOrNull(raw.result);
  if (raw.internalComment !== undefined && internalComment === undefined) return { ok: false, error: 'INVALID_FIELD', field: 'internalComment' };
  if (raw.result !== undefined && result === undefined) return { ok: false, error: 'INVALID_FIELD', field: 'result' };

  return {
    ok: true,
    value: {
      userId, accountId,
      rightType: raw.rightType,
      channel: raw.channel,
      receivedDate: raw.receivedDate,
      dueDate: computeDueDate(raw.receivedDate, raw.rightType),
      status,
      internalComment: internalComment ?? null,
      result: result ?? null,
    },
  };
}

export interface UpdatePlan {
  changes: Partial<Omit<GdprRequestState, 'origin'>>;
  /** L'échéance a été recalculée (GDP-014). */
  dueDateRecomputed: boolean;
  /** La demande passe à « Traitée » : horodater le traitement. */
  becomesDone: boolean;
}

/**
 * Modification d'une demande (GDP-014) : refusée pour une demande système
 * (GDP-007, GDP-008) ou traitée (GDP-015) ; échéance recalculée si la date
 * de réception ou le type de droit change ; statut vers l'avant uniquement.
 */
export function planManualUpdate(
  current: GdprRequestState,
  raw: ManualRequestInput & Record<string, unknown>,
  now: Date = new Date(),
): Plan<UpdatePlan> {
  if (current.origin !== 'manual') return { ok: false, error: 'SYSTEM_REQUEST_READ_ONLY' };
  if (current.status === 'done') return { ok: false, error: 'REQUEST_DONE_FROZEN' };
  if (FORBIDDEN_KEYS.some((k) => k in raw)) return { ok: false, error: 'DUE_DATE_NOT_ACCEPTED' };

  const changes: UpdatePlan['changes'] = {};

  if (raw.userId !== undefined || raw.accountId !== undefined) {
    const userId = raw.userId !== undefined ? raw.userId : current.userId;
    const accountId = raw.accountId !== undefined ? raw.accountId : current.accountId;
    if (userId === null && accountId === null) return { ok: false, error: 'SUBJECT_REQUIRED' };
    for (const [field, v] of [['userId', userId], ['accountId', accountId]] as const) {
      if (v !== null && !(Number.isSafeInteger(v) && (v as number) > 0)) return { ok: false, error: 'INVALID_FIELD', field };
    }
    if (userId !== current.userId) changes.userId = userId;
    if (accountId !== current.accountId) changes.accountId = accountId;
  }
  if (raw.rightType !== undefined) {
    if (!isRightType(raw.rightType)) return { ok: false, error: 'INVALID_FIELD', field: 'rightType' };
    if (raw.rightType !== current.rightType) changes.rightType = raw.rightType;
  }
  if (raw.channel !== undefined) {
    if (!isChannel(raw.channel)) return { ok: false, error: 'INVALID_FIELD', field: 'channel' };
    if (raw.channel !== current.channel) changes.channel = raw.channel;
  }
  if (raw.receivedDate !== undefined) {
    if (!isIsoDate(raw.receivedDate)) return { ok: false, error: 'INVALID_FIELD', field: 'receivedDate' };
    if (raw.receivedDate > parisDateOf(now)) return { ok: false, error: 'RECEIVED_IN_FUTURE' };
    if (raw.receivedDate !== current.receivedDate) changes.receivedDate = raw.receivedDate;
  }
  if (raw.status !== undefined) {
    if (!isStatus(raw.status)) return { ok: false, error: 'INVALID_FIELD', field: 'status' };
    if (!canTransition(current.status, raw.status)) return { ok: false, error: 'INVALID_TRANSITION' };
    if (raw.status !== current.status) changes.status = raw.status;
  }
  for (const key of ['internalComment', 'result'] as const) {
    if (raw[key] === undefined) continue;
    const v = textOrNull(raw[key]);
    if (v === undefined) return { ok: false, error: 'INVALID_FIELD', field: key };
    if (v !== current[key]) changes[key] = v;
  }

  // Recalcul de l'échéance si une donnée du calcul change (GDP-014).
  let dueDateRecomputed = false;
  if (changes.receivedDate !== undefined || changes.rightType !== undefined) {
    const due = computeDueDate(changes.receivedDate ?? current.receivedDate, changes.rightType ?? current.rightType);
    if (due !== current.dueDate) {
      changes.dueDate = due;
      dueDateRecomputed = true;
    }
  }

  if (Object.keys(changes).length === 0) return { ok: false, error: 'NOTHING_TO_UPDATE' };
  return { ok: true, value: { changes, dueDateRecomputed, becomesDone: changes.status === 'done' } };
}

/**
 * Réouverture (GDP-015 à GDP-017) : demande manuelle traitée uniquement ;
 * aucun motif ; l'échéance réglementaire initiale est CONSERVÉE — le plan ne
 * la touche pas.
 */
export function planReopen(current: Pick<GdprRequestState, 'origin' | 'status'>): Plan<{ status: GdprStatus }> {
  if (current.origin !== 'manual') return { ok: false, error: 'SYSTEM_REQUEST_READ_ONLY' };
  if (current.status !== 'done') return { ok: false, error: 'NOT_DONE' };
  return { ok: true, value: { status: 'in_progress' } };
}

/* ── Listes (GDP-001, GDP-005, GDP-006, GDP-019) ───────────────────────── */

export type GdprView = 'open' | 'history';

/** Tris proposés, par vue. Clé publique → expression SQL (liste fermée). */
export const SORTS: Record<GdprView, Record<string, string>> = {
  open: {
    due: 'r.due_date',
    received: 'r.received_at',
    right: 'r.right_type',
    status: 'r.status',
    origin: 'r.origin',
    user: "lower(coalesce(u.email, r.subject_email, ''))",
    account: "lower(coalesce(a.name, r.subject_account_name, ''))",
  },
  history: {
    processed: 'r.processed_at',
    received: 'r.received_at',
    right: 'r.right_type',
    user: "lower(coalesce(u.email, r.subject_email, ''))",
    account: "lower(coalesce(a.name, r.subject_account_name, ''))",
  },
};

export const DEFAULT_SORT: Record<GdprView, { sort: string; dir: 'asc' | 'desc' }> = {
  open: { sort: 'due', dir: 'asc' },
  history: { sort: 'processed', dir: 'desc' },
};

export interface ListQuery {
  view: GdprView;
  sort: string;
  dir: 'asc' | 'desc';
  page: number;
  pageSize: number;
  /** Période du compteur « traitées » (GDP-002), bornes incluses (dates Paris). */
  from: string;
  to: string;
}

/** Lecture tolérante des paramètres de liste : toute valeur inconnue retombe sur le défaut. */
export function parseListQuery(params: URLSearchParams, now: Date = new Date()): ListQuery {
  const view: GdprView = params.get('view') === 'history' ? 'history' : 'open';
  const sortParam = params.get('sort') ?? '';
  const sort = sortParam in SORTS[view] ? sortParam : DEFAULT_SORT[view].sort;
  const dirParam = params.get('dir');
  const dir = dirParam === 'asc' || dirParam === 'desc' ? dirParam : DEFAULT_SORT[view].dir;
  const page = Math.max(1, Math.floor(Number(params.get('page')) || 1));
  const pageSize = Math.min(100, Math.max(5, Math.floor(Number(params.get('pageSize')) || 25)));
  const today = parisDateOf(now);
  const defaultFrom = parisDateOf(new Date(now.getTime() - 29 * 86_400_000));
  let from = isIsoDate(params.get('from')) ? (params.get('from') as string) : defaultFrom;
  let to = isIsoDate(params.get('to')) ? (params.get('to') as string) : today;
  if (from > to) [from, to] = [to, from];
  return { view, sort, dir, page, pageSize, from, to };
}
