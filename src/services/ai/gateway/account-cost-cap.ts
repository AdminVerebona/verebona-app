/**
 * Plafond mensuel de coût IA par compte — lot 22, chantier A (revue L16b-3).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUI MANQUAIT
 *
 * Aucun plafond DUR de coût par compte : le crédit d'analyse ne borne que le
 * nombre de documents, les budgets de `cost-evaluator` ne font qu'alerter, et
 * le quota éditable de `/admin/ai-usage/[accountId]` n'avait plus de lecteur.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * RÈGLE
 *
 *   · période : mois civil, Europe/Paris (aucune période mensuelle n'existe
 *     côté crédits : ils sont annuels ou d'essai) ;
 *   · cumul : dépenses MÉTIER enregistrées par la passerelle pour le compte
 *     (`ai_usage_event.cost_micros` des lignes `is_billable`, appels réussis
 *     ET échoués facturés — même périmètre que les budgets de
 *     `cost-evaluator`), hors T5 (administration). ⚠️ Lu dans
 *     `ai_usage_event` seul : si l'archivage (`AI_LOG_ARCHIVE_AFTER_DAYS`)
 *     passait sous 32 jours, le cumul serait sous-estimé ;
 *   · plafond effectif : dérogation du compte (`ai_account_cost_caps`, posée
 *     depuis Suivi IA > compte) si elle existe, sinon la valeur de son offre
 *     (réglages administrés du lot 21, `ai_cost_cap_<offre>_micros`) ;
 *     0 = sans plafond. AUCUNE valeur posée = aucun plafond : comportement
 *     inchangé tant que le PO n'a pas fixé les montants ;
 *   · 80 % : alerte `ai_alerts` (type budget), une fois par compte et par
 *     période ; 100 % : alerte critique, une fois, et refus des appels.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * APPLIQUÉ DANS LA PASSERELLE (point unique)
 *
 * `assertAccountCostCap` est appelée par `AiGateway` après le cache
 * d'idempotence (un résultat déjà payé reste servi) et avant tout contact
 * fournisseur. Exemptés : appels sans compte (sonde, système), T5 (BO admin),
 * le compte technique des campagnes (`CORPUS_ACCOUNT_ID`, opérations comme
 * pipeline) et les appels marqués `costCapExempt`. Chaque appelant traduit
 * le refus `COST_CAP_REACHED` :
 *   · T1 : analyse non lancée, job reporté au 1er du mois suivant (file
 *     durable, une seule reprise, aucune boucle), fichier « en file » avec le
 *     motif ;
 *   · T2 : repli déterministe « sources seules » + message du plafond ;
 *   · T3/T4 (décision PO, revue lot 22) : repli déterministe existant, en
 *     file comme hors file (T3 : conflit ouvert / abstention ; T4 :
 *     proposition / abstention comme en échec modèle) — jamais de report ;
 *   · T6 : texte de secours déterministe.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LECTURE DU CUMUL ET TOLÉRANCE
 *
 * Le cumul est relu en base à CHAQUE appel soumis à un plafond (requête bornée
 * au compte et au mois, index `ai_usage_event_account_created_idx`, 0235) :
 * aucune instance ne peut dépasser sur la foi d'un cache local. Seule la
 * DÉFINITION du plafond (offre, dérogation) est mise en cache par instance,
 * `DEFINITION_TTL_MS` (une nouvelle valeur s'applique partout en ≤ 10 s ;
 * l'instance qui la pose, immédiatement). Tolérance documentée : les appels
 * déjà partis quand le plafond est franchi se terminent — le dépassement est
 * borné au coût des appels en cours. Base illisible : échec OUVERT (journal),
 * comme le plafond de l'assistant.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { AiCostCapReachedError } from './errors';
import { treatmentForUseCase } from '../config/treatments';
import type { AiUseCaseCode } from '../registry/use-cases';

export type CostCapPlan = 'standard' | 'premium' | 'premium_duo' | 'premium_pro';

/** Réglage administré (lot 21) portant le plafond de chaque offre. */
export const COST_CAP_SETTING_KEYS: Readonly<Record<CostCapPlan, string>> = {
  standard: 'ai_cost_cap_standard_micros',
  premium: 'ai_cost_cap_premium_micros',
  premium_duo: 'ai_cost_cap_premium_duo_micros',
  premium_pro: 'ai_cost_cap_premium_pro_micros',
};

/**
 * Borne haute d'un plafond (micro-USD) — la même pour le réglage d'offre et la
 * dérogation par compte (1 000 $ par mois).
 */
export const COST_CAP_MAX_MICROS = 1_000_000_000;

/** Part du plafond à partir de laquelle l'alerte d'exploitation est émise. */
export const COST_CAP_ALERT_RATIO = 0.8;

/** Durée de vie, par instance, de la définition du plafond d'un compte. */
export const DEFINITION_TTL_MS = 10_000;

const TZ = 'Europe/Paris';

// ── Période (pur) ───────────────────────────────────────────────────────────

/** Décalage (ms) de Europe/Paris par rapport à UTC à l'instant `t`. */
function parisOffsetMs(t: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(t));
  const v = (k: string) => Number(parts.find((p) => p.type === k)?.value);
  const mur = Date.UTC(v('year'), v('month') - 1, v('day'), v('hour'), v('minute'), v('second'));
  return mur - Math.floor(t / 1000) * 1000;
}

/** Minuit (Europe/Paris) du 1er du mois `month` (1-12) de `year`, en instant UTC. */
function debutDeMoisParis(year: number, month: number): Date {
  const utc = Date.UTC(year, month - 1, 1);
  // Aucun changement d'heure n'a lieu le 1er à minuit : un seul ajustement suffit.
  return new Date(utc - parisOffsetMs(utc - parisOffsetMs(utc)));
}

export interface CostCapPeriod {
  /** Début inclus (minuit du 1er, Europe/Paris). */
  start: Date;
  /** Fin exclue = début de la période suivante = date de reprise. */
  end: Date;
  /** `AAAA-MM` (Europe/Paris) — clé des alertes. */
  key: string;
}

/** Mois civil Europe/Paris contenant `now`. */
export function costCapPeriod(now: Date = new Date()): CostCapPeriod {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit' }).formatToParts(now);
  const year = Number(parts.find((p) => p.type === 'year')?.value);
  const month = Number(parts.find((p) => p.type === 'month')?.value);
  const next = month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 };
  return {
    start: debutDeMoisParis(year, month),
    end: debutDeMoisParis(next.y, next.m),
    key: `${year}-${String(month).padStart(2, '0')}`,
  };
}

/** « 1er novembre » — date de reprise lisible (Europe/Paris). */
export function resumeLabel(resumeAt: Date): string {
  const mois = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, month: 'long' }).format(resumeAt);
  return `1er ${mois}`;
}

/** Motif affiché sur un fichier dont l'analyse est reportée (bandeau, tiroir). */
export function costCapAnalysisReason(resumeAt: Date): string {
  return `Plafond IA du mois atteint, reprise le ${resumeLabel(resumeAt)} : l’analyse sera lancée automatiquement.`;
}

// ── Résolution (pur) ────────────────────────────────────────────────────────

export interface CostCapDefinition {
  plan: CostCapPlan;
  /** Valeur de l'offre (micro-USD) ; 0 / null = sans plafond. */
  offerCapMicros: number | null;
  /** Dérogation du compte ; `null` = aucune (l'offre s'applique), 0 = sans plafond. */
  overrideMicros: number | null;
}

/** Plafond effectif : dérogation prioritaire, puis offre ; 0 ou absent = aucun. */
export function effectiveCap(d: Pick<CostCapDefinition, 'offerCapMicros' | 'overrideMicros'>): {
  capMicros: number | null; source: 'override' | 'offer' | null;
} {
  if (d.overrideMicros != null) {
    return d.overrideMicros > 0 ? { capMicros: d.overrideMicros, source: 'override' } : { capMicros: null, source: 'override' };
  }
  if (d.offerCapMicros != null && d.offerCapMicros > 0) return { capMicros: d.offerCapMicros, source: 'offer' };
  return { capMicros: null, source: null };
}

export type CostCapLevel = 'none' | 'ok' | 'threshold' | 'reached';

/** Niveau atteint (pur). */
export function costCapLevel(spentMicros: number, capMicros: number | null, ratio = COST_CAP_ALERT_RATIO): CostCapLevel {
  if (!capMicros || capMicros <= 0) return 'none';
  if (spentMicros >= capMicros) return 'reached';
  if (spentMicros >= capMicros * ratio) return 'threshold';
  return 'ok';
}

/**
 * Compte technique des campagnes de mesure et tests du BO
 * (`CORPUS_ACCOUNT_ID`) : jamais plafonné — opérations ou pipeline complet.
 */
export function isTechnicalAccount(accountId: number, env: NodeJS.ProcessEnv = process.env): boolean {
  const n = Number(env.CORPUS_ACCOUNT_ID);
  return Number.isInteger(n) && n > 0 && n === accountId;
}

/** Le traitement de cet usage est-il soumis au plafond du compte ? */
export function isCostCapped(p: { accountId: number | null | undefined; useCaseCode: AiUseCaseCode; exempt?: boolean }): boolean {
  if (p.exempt) return false;
  if (!p.accountId || p.accountId <= 0) return false;
  if (isTechnicalAccount(p.accountId)) return false;
  return treatmentForUseCase(p.useCaseCode) !== 'T5';
}

// ── Accès aux données (remplaçable en test) ─────────────────────────────────

export interface CostCapStore {
  /** Offre commerciale du compte. */
  planOf(accountId: number): Promise<CostCapPlan>;
  /** Dérogation du compte (`null` : aucune). */
  overrideOf(accountId: number): Promise<number | null>;
  /** Plafond de l'offre (réglage administré), `null` / 0 = sans plafond. */
  offerCap(plan: CostCapPlan): Promise<number | null>;
  /** Coût cumulé du compte sur [start, end[, hors T5. */
  spent(accountId: number, start: Date, end: Date): Promise<number>;
  /** Alerte `ai_alerts` (idempotente par clé). */
  raise(a: import('../alerts/alerts.repository').AlertInput): Promise<boolean>;
}

const PLANS: readonly CostCapPlan[] = ['standard', 'premium', 'premium_duo', 'premium_pro'];

export const dbCostCapStore: CostCapStore = {
  async planOf(accountId) {
    const { getCommercialPlanForAccount } = await import('@/services/commercial-model.service');
    const p = await getCommercialPlanForAccount(accountId);
    return (PLANS as readonly string[]).includes(p) ? (p as CostCapPlan) : 'standard';
  },
  async overrideOf(accountId) {
    const { pgClient } = await import('@/db');
    const rows = (await pgClient.unsafe(
      `SELECT monthly_cap_micros FROM ai_account_cost_caps WHERE account_id = $1`, [accountId] as never[],
    )) as unknown as Array<{ monthly_cap_micros: string | number }>;
    return rows[0] ? Number(rows[0].monthly_cap_micros) : null;
  },
  async offerCap(plan) {
    const S = await import('@/services/verebona-assistant/config/assistant-settings');
    await S.refreshAssistantSettings();
    const v = S.effectiveSetting(COST_CAP_SETTING_KEYS[plan]);
    return typeof v === 'number' && v > 0 ? v : null;
  },
  async spent(accountId, start, end) {
    const { pgClient } = await import('@/db');
    const rows = (await pgClient.unsafe(
      `SELECT COALESCE(SUM(cost_micros), 0)::bigint AS spent
         FROM ai_usage_event
        WHERE account_id = $1 AND created_at >= $2 AND created_at < $3 AND is_billable
          AND (use_case_code IS NULL OR use_case_code <> 'AI_GOVERNANCE')`,
      [accountId, start.toISOString(), end.toISOString()] as never[],
    )) as unknown as Array<{ spent: string | number }>;
    return Number(rows[0]?.spent ?? 0);
  },
  async raise(a) {
    return (await import('../alerts/alerts.repository')).raiseAlert(a);
  },
};

let store: CostCapStore | null = null;

/**
 * Réservé aux tests : accès aux données (`null` : défaut). Vide le cache.
 * Sous NODE_ENV=test, sans accès posé, aucun plafond ne s'applique (comme
 * les réglages administrés du lot 21) : les tests existants ne touchent pas
 * la base pour cela.
 */
export function setCostCapStoreForTests(s: CostCapStore | null): void {
  store = s;
  resetCostCapCache();
}

function currentStore(): CostCapStore | null {
  if (store) return store;
  if (process.env.NODE_ENV === 'test') return null;
  return dbCostCapStore;
}

// ── Définition en cache (par instance, courte) ──────────────────────────────

const definitions = new Map<number, { at: number; def: CostCapDefinition }>();
const alertesEcrites = new Set<string>();

export function resetCostCapCache(accountId?: number): void {
  if (accountId === undefined) {
    definitions.clear();
    alertesEcrites.clear();
  } else {
    definitions.delete(accountId);
  }
}

export async function costCapDefinition(accountId: number, now = Date.now()): Promise<CostCapDefinition> {
  const st = currentStore();
  if (!st) return { plan: 'standard', offerCapMicros: null, overrideMicros: null };
  const c = definitions.get(accountId);
  if (c && now - c.at < DEFINITION_TTL_MS) return c.def;
  const [plan, overrideMicros] = await Promise.all([st.planOf(accountId), st.overrideOf(accountId)]);
  const offerCapMicros = await st.offerCap(plan);
  const def = { plan, offerCapMicros, overrideMicros };
  definitions.set(accountId, { at: now, def });
  return def;
}

export interface AccountCostCapStatus extends CostCapDefinition {
  accountId: number;
  capMicros: number | null;
  source: 'override' | 'offer' | null;
  /** Cumul du mois ; `null` si non lu (aucun plafond et lecture non demandée). */
  spentMicros: number | null;
  level: CostCapLevel;
  periodKey: string;
  periodStart: string;
  /** Début de la période suivante : date de reprise. */
  resumeAt: string;
}

/**
 * État du plafond d'un compte. Le cumul n'est lu que si un plafond s'applique
 * (ou si `withSpent`, pour l'affichage BO). Lève si la base est illisible —
 * la passerelle, elle, échoue ouvert (`assertAccountCostCap`).
 */
export async function getAccountCostCapStatus(
  accountId: number, opts: { withSpent?: boolean; now?: Date } = {},
): Promise<AccountCostCapStatus> {
  const now = opts.now ?? new Date();
  const period = costCapPeriod(now);
  const def = await costCapDefinition(accountId, now.getTime());
  const { capMicros, source } = effectiveCap(def);
  const st = currentStore();
  const spentMicros = st && (capMicros || opts.withSpent) ? await st.spent(accountId, period.start, period.end) : null;
  return {
    accountId, ...def, capMicros, source, spentMicros,
    level: costCapLevel(spentMicros ?? 0, capMicros),
    periodKey: period.key, periodStart: period.start.toISOString(), resumeAt: period.end.toISOString(),
  };
}

const usd = (micros: number) => `${(micros / 1_000_000).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;

/** Alerte de seuil ou de plafond, une fois par compte, niveau et période. */
async function signaler(s: AccountCostCapStatus): Promise<void> {
  if (s.level !== 'threshold' && s.level !== 'reached') return;
  const atteint = s.level === 'reached';
  // La valeur du plafond entre dans la clé : un plafond modifié en cours de
  // mois (relevé puis de nouveau franchi) produit une nouvelle alerte.
  const dedupeKey = `account_cost_cap:${atteint ? 'reached' : 'threshold'}:${s.accountId}:${s.periodKey}:${s.capMicros}`;
  if (alertesEcrites.has(dedupeKey)) return;
  const st = currentStore();
  if (!st) return;
  try {
    await st.raise({
      kind: 'budget',
      code: atteint ? 'account_cost_cap_reached' : 'account_cost_cap_threshold',
      accountId: s.accountId,
      severity: atteint ? 'critical' : 'warning',
      message: atteint
        ? `Compte ${s.accountId} : plafond IA du mois ${s.periodKey} atteint (${usd(s.spentMicros ?? 0)} / ${usd(s.capMicros ?? 0)}, `
          + `${s.source === 'override' ? 'dérogation' : `offre ${s.plan}`}). Analyses reportées au 1er, assistant et mascotte sans IA.`
        : `Compte ${s.accountId} : ${Math.round(((s.spentMicros ?? 0) / (s.capMicros || 1)) * 100)} % du plafond IA du mois ${s.periodKey} consommé `
          + `(${usd(s.spentMicros ?? 0)} / ${usd(s.capMicros ?? 0)}, seuil ${Math.round(COST_CAP_ALERT_RATIO * 100)} %).`,
      details: {
        month: s.periodKey, spentMicros: s.spentMicros, capMicros: s.capMicros, source: s.source, plan: s.plan,
        alertRatio: COST_CAP_ALERT_RATIO,
      },
      drilldownHref: `/admin/ai-usage/${s.accountId}`,
      dedupeKey,
    });
    alertesEcrites.add(dedupeKey);
  } catch (e) {
    console.warn(`[ai-cost-cap] compte ${s.accountId} : alerte non enregistrée (${(e as Error).message}).`);
  }
}

/**
 * Contrôle de la passerelle, avant tout appel fournisseur. Lève
 * `AiCostCapReachedError` si le plafond effectif du compte est atteint ;
 * écrit l'alerte de seuil (80 %) au passage. Échec ouvert si la base est
 * illisible.
 */
export async function assertAccountCostCap(p: {
  accountId: number | null | undefined; useCaseCode: AiUseCaseCode; operationCode: string; exempt?: boolean; now?: Date;
}): Promise<void> {
  if (!isCostCapped(p)) return;
  let s: AccountCostCapStatus;
  try {
    s = await getAccountCostCapStatus(p.accountId!, { now: p.now });
  } catch (e) {
    console.warn(`[ai-cost-cap] compte ${p.accountId} : plafond non vérifiable — échec ouvert (${(e as Error).message}).`);
    return;
  }
  if (s.level === 'none' || s.level === 'ok') return;
  await signaler(s);
  if (s.level === 'reached') {
    throw new AiCostCapReachedError(p.operationCode, p.accountId!, s.capMicros!, s.spentMicros ?? 0, new Date(s.resumeAt));
  }
}

/**
 * Plafond atteint pour ce compte (lecture seule, sans lever) — contrôles
 * préalables des appelants (pipeline T1, reprise serveur, assistant). Échec
 * ouvert : `null` si la base est illisible ou s'il n'y a pas de plafond.
 */
export async function costCapReachedFor(accountId: number, now?: Date): Promise<{ resumeAt: Date; capMicros: number; spentMicros: number } | null> {
  if (!accountId || accountId <= 0 || isTechnicalAccount(accountId)) return null;
  try {
    const s = await getAccountCostCapStatus(accountId, { now });
    if (s.level !== 'reached') return null;
    await signaler(s);
    return { resumeAt: new Date(s.resumeAt), capMicros: s.capMicros!, spentMicros: s.spentMicros ?? 0 };
  } catch (e) {
    console.warn(`[ai-cost-cap] compte ${accountId} : plafond non vérifiable — échec ouvert (${(e as Error).message}).`);
    return null;
  }
}

// ── Dérogation par compte (Suivi IA > compte) ───────────────────────────────

/**
 * Pose (`micros` ≥ 0 ; 0 = sans plafond pour ce compte) ou retire (`null`)
 * la dérogation du compte, ET journalise (`ai_admin_audit_log` : auteur,
 * date, avant / après, motif) DANS LA MÊME TRANSACTION : jamais une
 * dérogation sans trace, ni l'inverse. Compte inexistant : `null` (rien
 * écrit). Après validation, les travaux reportés du compte sont remis en
 * file : un plafond relevé ne doit pas attendre le 1er.
 */
export async function setAccountCostCapOverride(
  accountId: number, micros: number | null, admin: { id: number; email?: string | null }, reason: string | null,
): Promise<{ before: number | null } | null> {
  if (micros != null && (!Number.isInteger(micros) || micros < 0 || micros > COST_CAP_MAX_MICROS)) {
    throw new Error(`Plafond invalide : entier de 0 à ${COST_CAP_MAX_MICROS} (micro-USD) attendu.`);
  }
  const { pgClient } = await import('@/db');
  const issue = await pgClient.begin(async (tx) => {
    const [compte] = (await tx.unsafe(`SELECT id FROM accounts WHERE id = $1 FOR UPDATE`, [accountId] as never[])) as unknown as Array<{ id: number }>;
    if (!compte) return null;
    const [avant] = (await tx.unsafe(
      `SELECT monthly_cap_micros FROM ai_account_cost_caps WHERE account_id = $1`, [accountId] as never[],
    )) as unknown as Array<{ monthly_cap_micros: string | number }>;
    const before = avant ? Number(avant.monthly_cap_micros) : null;
    if (micros == null) {
      await tx.unsafe(`DELETE FROM ai_account_cost_caps WHERE account_id = $1`, [accountId] as never[]);
    } else {
      await tx.unsafe(
        `INSERT INTO ai_account_cost_caps (account_id, monthly_cap_micros, reason, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (account_id) DO UPDATE SET monthly_cap_micros = EXCLUDED.monthly_cap_micros,
           reason = EXCLUDED.reason, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [accountId, micros, reason, admin.id] as never[],
      );
    }
    await tx.unsafe(
      `INSERT INTO ai_admin_audit_log (admin_user_id, admin_email, action_type, target_account_id, before_value, after_value, reason)
       VALUES ($1, COALESCE($2, (SELECT email FROM users WHERE id = $1), ''), 'modify_quota', $3, $4::jsonb, $5::jsonb, $6)`,
      [admin.id, admin.email ?? null, accountId, JSON.stringify({ monthlyCostCapMicros: before }),
        JSON.stringify({ monthlyCostCapMicros: micros }), reason] as never[],
    );
    return { before };
  }) as { before: number | null } | null;
  if (!issue) return null;
  resetCostCapCache(accountId);
  try {
    const { releaseCostCapDeferredJobs } = await import('../queue/job-queue.repository');
    await releaseCostCapDeferredJobs(accountId);
  } catch (e) {
    console.warn(`[ai-cost-cap] compte ${accountId} : travaux reportés non remis en file (${(e as Error).message}).`);
  }
  return issue;
}
