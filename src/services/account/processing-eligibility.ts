/**
 * Éligibilité d'un compte aux TRAITEMENTS MÉTIER — lot 82A, décision PO C-Q10
 * et §3.3 (23/10/2026).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * RÈGLE
 *
 * Seuls les comptes ACTIFS et MODIFIABLES reçoivent des traitements métier :
 * T1, T3, T4, T6, contrôles de cohérence, réparations, synchronisation de
 * contenu, campagnes, rattrapages, jobs métier, notifications de contenu.
 *
 *   éligible  ⇔  compte existant
 *              ∧ non suspendu            (`accounts.is_active`, BO ACC-A02)
 *              ∧ non neutralisé          (`accounts.archived_at`, lot 72D)
 *              ∧ droits d'écriture       (`entitlements.canWrite` : essai en
 *                                         cours ou abonnement actif ; PAS
 *                                         essai échu, lecture seule,
 *                                         rétractation, impayé, résilié, sans
 *                                         abonnement)
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN SEUL MÉCANISME, GÉNÉRALISÉ (C-Q10 : « ne pas empiler un second verrou »)
 *
 * Les droits ne sont PAS recalculés ici : `entitlementsFromSubscription`
 * (entitlements.service) est la source unique du mode restreint, déjà
 * appliquée aux routes d'écriture et d'IA (`write-access-guard`). Ce module y
 * ajoute les deux états de cycle de vie qui ne relèvent pas de l'abonnement
 * (suspension, neutralisation) et l'expose aux traitements d'arrière-plan :
 *
 *   · `getAccountProcessingEligibility` / `isAccountProcessingEligible` —
 *     contrôle unitaire, à la mise en file ET à l'exécution ;
 *   · `processingEligibleSql` — même règle en SQL pour les balayages par
 *     lots (sélection des comptes / objets), parité vérifiée par l'e2e L82A ;
 *   · `AccountIneligibleError` (code `ACCOUNT_INELIGIBLE`) — refus d'un
 *     travail déjà lancé (passerelle IA, file durable).
 *
 * Les opérations INDISPENSABLES ne passent jamais par ce contrôle : sécurité,
 * facturation, e-mails légaux et transactionnels, rétractation, suppression
 * de compte, export de données, réactivation, purges techniques.
 *
 * Compte technique des campagnes de mesure (`CORPUS_ACCOUNT_ID`) : toujours
 * éligible (même exemption que le plafond de coût, ce n'est pas un client).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { entitlementsFromSubscription, type SubscriptionRightsRow } from '@/services/entitlements.service';
import {
  __setProcessingEligibilityForTests as setOverride, currentEligibilityOverride, onEligibilityOverrideChange,
} from './processing-eligibility-override';

export type IneligibilityReason =
  | 'ACCOUNT_NOT_FOUND'
  | 'ACCOUNT_SUSPENDED'
  | 'ACCOUNT_ARCHIVED'
  | 'TRIAL_EXPIRED'
  | 'WITHDRAWN'
  | 'UNPAID'
  | 'SUBSCRIPTION_ENDED'
  | 'READ_ONLY'
  | 'NO_SUBSCRIPTION';

export interface ProcessingEligibility {
  eligible: boolean;
  reason: IneligibilityReason | null;
}

export const ELIGIBLE: ProcessingEligibility = Object.freeze({ eligible: true, reason: null });

/** Libellés (journaux, BO) — jamais de donnée personnelle. */
export const INELIGIBILITY_LABELS: Readonly<Record<IneligibilityReason, string>> = Object.freeze({
  ACCOUNT_NOT_FOUND: 'compte introuvable',
  ACCOUNT_SUSPENDED: 'compte suspendu',
  ACCOUNT_ARCHIVED: 'compte neutralisé',
  TRIAL_EXPIRED: 'essai terminé sans souscription',
  WITHDRAWN: 'rétractation exercée (lecture seule)',
  UNPAID: 'impayé (mode restreint)',
  SUBSCRIPTION_ENDED: 'abonnement terminé',
  READ_ONLY: 'compte en lecture seule',
  NO_SUBSCRIPTION: 'aucun abonnement',
});

/** État lu en base pour un compte (une requête). */
export interface AccountProcessingRow {
  accountId: number;
  isActive: boolean | null;
  archivedAt: Date | null;
  /** `accounts.subscription_status` (WITHDRAWN…), seulement pour le motif. */
  accountSubscriptionStatus: string | null;
  subscription: SubscriptionRightsRow | null;
}

/** Compte technique des campagnes de mesure (même règle que `account-cost-cap`). */
function isTechnicalProcessingAccount(accountId: number, env: NodeJS.ProcessEnv = process.env): boolean {
  const n = Number(env.CORPUS_ACCOUNT_ID);
  return Number.isInteger(n) && n > 0 && n === accountId;
}

/**
 * Éligibilité à partir de l'état lu (pure, testée). `row` nul : compte
 * introuvable (supprimé).
 */
export function processingEligibilityOf(row: AccountProcessingRow | null, now: Date = new Date()): ProcessingEligibility {
  if (!row) return { eligible: false, reason: 'ACCOUNT_NOT_FOUND' };
  if (isTechnicalProcessingAccount(row.accountId)) return ELIGIBLE;
  if (row.isActive === false) return { eligible: false, reason: 'ACCOUNT_SUSPENDED' };
  if (row.archivedAt) return { eligible: false, reason: 'ACCOUNT_ARCHIVED' };
  const ent = entitlementsFromSubscription(row.subscription, now);
  if (ent.canWrite) return ELIGIBLE;
  switch (ent.status) {
    case 'none': return { eligible: false, reason: 'NO_SUBSCRIPTION' };
    case 'past_due': return { eligible: false, reason: 'UNPAID' };
    case 'canceled': return { eligible: false, reason: 'SUBSCRIPTION_ENDED' };
    case 'readonly': {
      if ((row.accountSubscriptionStatus ?? '').toUpperCase() === 'WITHDRAWN') return { eligible: false, reason: 'WITHDRAWN' };
      const s = row.subscription;
      if (s && !s.firstBilledAt && s.trialEndsAt) return { eligible: false, reason: 'TRIAL_EXPIRED' };
      return { eligible: false, reason: 'READ_ONLY' };
    }
    default: return { eligible: false, reason: 'READ_ONLY' };
  }
}

/**
 * Même règle, en SQL, pour les sélections par lots (balayages, campagnes,
 * reprises) : expression booléenne vraie si le compte `accountIdExpr` est
 * éligible. `nowExpr` : instant de référence (injecté par les tests).
 *
 * ⚠️ Doit rester l'exacte traduction de `processingEligibilityOf` +
 * `entitlementsFromSubscription` : parité vérifiée par l'e2e
 * `l82a-eligibilite-comptes` (matrice de tous les états).
 */
export function processingEligibleSql(accountIdExpr: string, nowExpr = 'now()'): string {
  const technique = technicalAccountSql(accountIdExpr);
  return `(${technique}EXISTS (SELECT 1 FROM accounts pe_a JOIN account_subscriptions pe_s ON pe_s.account_id = pe_a.id
    WHERE pe_a.id = ${accountIdExpr} AND pe_a.is_active IS NOT FALSE AND pe_a.archived_at IS NULL
      AND pe_s.status NOT IN ('readonly', 'canceled', 'past_due')
      AND NOT (pe_s.status = 'trialing' AND pe_s.first_billed_at IS NULL AND pe_s.trial_ends_at IS NOT NULL
               AND pe_s.trial_ends_at <= ${nowExpr})))`;
}

function technicalAccountSql(accountIdExpr: string): string {
  const n = Number(process.env.CORPUS_ACCOUNT_ID);
  return Number.isInteger(n) && n > 0 ? `${accountIdExpr} = ${n} OR ` : '';
}

/** Motif écrit sur un travail neutralisé (lu au BO › File IA). */
export function neutralizedMessage(reason: IneligibilityReason): string {
  return `Compte non éligible : ${INELIGIBILITY_LABELS[reason]} — travail neutralisé, réexaminé à la réactivation (C-Q10)`;
}

// ── Erreur d'exécution ──────────────────────────────────────────────────────

/**
 * Travail refusé parce que son compte n'est plus éligible. Ni échec ni
 * interruption d'exploitation : le travail est NEUTRALISÉ (file durable :
 * CANCELLED, marqué pour réexamen à la réactivation), sans tentative
 * consommée ni écriture métier.
 */
export class AccountIneligibleError extends Error {
  readonly code = 'ACCOUNT_INELIGIBLE';
  constructor(readonly accountId: number, readonly reason: IneligibilityReason) {
    super(`compte ${accountId} non éligible aux traitements : ${INELIGIBILITY_LABELS[reason]}`);
    this.name = 'AccountIneligibleError';
  }
}

/** L'erreur (ou celle d'une passerelle IA) est-elle un refus d'éligibilité ? */
export function isAccountIneligibleError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'ACCOUNT_INELIGIBLE';
}

/** Motif porté par un refus d'éligibilité, si lisible. */
export function ineligibilityReasonOf(e: unknown): IneligibilityReason | null {
  const r = typeof e === 'object' && e !== null ? (e as { reason?: unknown; details?: { reason?: unknown } }) : null;
  const v = r?.reason ?? r?.details?.reason;
  return typeof v === 'string' && v in INELIGIBILITY_LABELS ? (v as IneligibilityReason) : null;
}

// ── Lecture ─────────────────────────────────────────────────────────────────

type Loader = (accountId: number) => Promise<AccountProcessingRow | null>;

const dbLoader: Loader = async (accountId) => {
  const { pgClient } = await import('@/db');
  const rows = (await pgClient.unsafe(
    `SELECT a.id, a.is_active, a.archived_at, a.subscription_status,
            s.plan_code, s.status, s.trial_ends_at, s.first_billed_at
       FROM accounts a LEFT JOIN account_subscriptions s ON s.account_id = a.id
      WHERE a.id = $1`,
    [accountId] as never[],
  )) as unknown as Array<Record<string, unknown>>;
  const r = rows[0];
  if (!r) return null;
  const date = (v: unknown) => (v == null ? null : v instanceof Date ? v : new Date(String(v)));
  return {
    accountId: Number(r.id),
    isActive: r.is_active == null ? null : Boolean(r.is_active),
    archivedAt: date(r.archived_at),
    accountSubscriptionStatus: (r.subscription_status as string | null) ?? null,
    subscription: r.status == null ? null : {
      planCode: (r.plan_code as string | null) ?? null,
      status: String(r.status),
      trialEndsAt: date(r.trial_ends_at),
      firstBilledAt: date(r.first_billed_at),
    },
  };
};

type Check = (accountId: number, now: Date) => Promise<ProcessingEligibility>;
const surchargeCourante = (): Check | null => currentEligibilityOverride() as Check | null;

/**
 * TESTS UNITAIRES SEULEMENT (`src/test/setup.ts`, via le module sans
 * dépendance `processing-eligibility-override`) : aucun test unitaire n'ouvre
 * de connexion à la base. Les e2e PostgreSQL exercent le contrôle réel.
 * `null` rétablit le contrôle réel.
 */
export function __setProcessingEligibilityForTests(fn: Check | null): void {
  setOverride(fn as never);
}
onEligibilityOverrideChange(() => cache.clear());

/**
 * Éligibilité d'un compte, lue en base AU MOMENT DE L'APPEL (aucun cache).
 * Erreur de lecture : propagée — l'appelant décide (mise en file : refus ;
 * exécution : report technique, jamais un traitement à l'aveugle).
 */
export async function getAccountProcessingEligibility(accountId: number, now: Date = new Date()): Promise<ProcessingEligibility> {
  if (!Number.isSafeInteger(accountId) || accountId <= 0) return { eligible: false, reason: 'ACCOUNT_NOT_FOUND' };
  const surcharge = surchargeCourante();
  if (surcharge) return surcharge(accountId, now);
  return processingEligibilityOf(await dbLoader(accountId), now);
}

// Cache court, réservé au chemin chaud de la passerelle IA (un appel modèle
// peut en enchaîner plusieurs) : la neutralisation des travaux, elle, est
// immédiate (file durable, transitions).
const cache = new Map<number, { at: number; value: ProcessingEligibility }>();

/** Vide le cache local (transition constatée sur cette instance). */
export function invalidateProcessingEligibility(accountId?: number): void {
  if (accountId === undefined) cache.clear();
  else cache.delete(accountId);
}

/**
 * Variante avec cache borné (`maxAgeMs`, défaut 0 = lecture fraîche).
 */
export async function checkAccountProcessingEligibility(
  accountId: number,
  opts: { maxAgeMs?: number; now?: Date } = {},
): Promise<ProcessingEligibility> {
  const maxAge = opts.maxAgeMs ?? 0;
  if (maxAge > 0) {
    const hit = cache.get(accountId);
    if (hit && Date.now() - hit.at < maxAge) return hit.value;
  }
  const value = await getAccountProcessingEligibility(accountId, opts.now ?? new Date());
  if (maxAge > 0) {
    if (cache.size > 5_000) cache.clear();
    cache.set(accountId, { at: Date.now(), value });
  }
  return value;
}

/** Booléen, pour les points de contrôle qui n'ont pas besoin du motif. */
export async function isAccountProcessingEligible(accountId: number, opts: { maxAgeMs?: number; now?: Date } = {}): Promise<boolean> {
  return (await checkAccountProcessingEligibility(accountId, opts)).eligible;
}

/**
 * Lève `AccountIneligibleError` si le compte n'est pas éligible (contrôle
 * d'exécution des traitements qui ne passent pas par la file durable).
 */
export async function assertAccountProcessingEligible(accountId: number, opts: { maxAgeMs?: number; now?: Date } = {}): Promise<void> {
  const e = await checkAccountProcessingEligibility(accountId, opts);
  if (!e.eligible) throw new AccountIneligibleError(accountId, e.reason ?? 'READ_ONLY');
}

/**
 * Sous-ensemble ÉLIGIBLE d'une liste de comptes (une requête, règle SQL).
 * Sert les balayages qui ont déjà leur liste en mémoire.
 */
export async function filterEligibleAccountIds(accountIds: number[], now?: Date): Promise<Set<number>> {
  const ids = [...new Set(accountIds.filter((n) => Number.isSafeInteger(n) && n > 0))];
  if (ids.length === 0) return new Set();
  const surcharge = surchargeCourante();
  if (surcharge) {
    const out = new Set<number>();
    for (const id of ids) if ((await surcharge(id, now ?? new Date())).eligible) out.add(id);
    return out;
  }
  const { pgClient } = await import('@/db');
  const rows = (await pgClient.unsafe(
    `SELECT x.id FROM unnest($1::int[]) AS x(id) WHERE ${processingEligibleSql('x.id', '$2::timestamptz')}`,
    [ids, (now ?? new Date()).toISOString()] as never[],
  )) as unknown as Array<{ id: number }>;
  return new Set(rows.map((r) => Number(r.id)));
}
