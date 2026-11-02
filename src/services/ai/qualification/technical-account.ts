/**
 * Compte technique de qualification IA (« compte du corpus ») — lot 103G
 * (ticket P1 « compte technique de qualification »). CDC §11.1, C-Q10.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI CE MODULE
 *
 * Constat du 31/10/2026 (préproduction) : les cas du corpus d'une campagne de
 * non-régression T2 ont tous été refusés par la passerelle (`ACCOUNT_INELIGIBLE`
 * : « compte 8 non éligible aux traitements (compte introuvable) »). La
 * qualification a conclu « non-régression non démontrée » au lieu de dire
 * « prérequis d'exploitation absent », et rien ne relançait l'essai une fois le
 * compte réparé. Par ailleurs, l'exemption C-Q10 et l'exemption du plafond de
 * coût reposaient sur la SEULE égalité `accountId === CORPUS_ACCOUNT_ID` : une
 * variable pointant vers un compte client aurait exempté ce client.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * RÈGLES
 *
 * 1. IDENTITÉ EN BASE (source de vérité) : le compte technique porte le
 *    marqueur `accounts.technical_kind = 'AI_QUALIFICATION_CORPUS'`
 *    (migration 0960, au plus un compte : index unique partiel + verrou
 *    consultatif au provisionnement). Il doit en plus avoir l'identité dédiée :
 *    titulaire `corpus@verebona.local`, utilisateur inactif (connexion
 *    impossible), mot de passe marqueur `!…` (aucun hachage bcrypt ne commence
 *    par `!`), rôle USER, aucun abonnement facturable ni client Stripe,
 *    `subscription_status = NONE`, compte non suspendu ni neutralisé, aucun
 *    autre membre.
 * 2. `CORPUS_ACCOUNT_ID` n'est plus qu'une CONFIRMATION facultative :
 *      · absente → le compte marqué est utilisé ;
 *      · égale au compte marqué → OK ;
 *      · pointant vers un identifiant INEXISTANT alors qu'un compte marqué
 *        valide existe (copie prod → préprod, identifiants changés) → le compte
 *        marqué est utilisé, avertissement « variable obsolète » (aucun risque :
 *        aucun compte réel n'est désigné) ;
 *      · pointant vers un AUTRE compte existant → REFUS (CORPUS_ACCOUNT_MISMATCH)
 *        et, si ce compte est un compte client, ANOMALIE DE SÉCURITÉ.
 * 3. AUCUNE exemption sans le contexte serveur d'une campagne
 *    (`technical-context.ts`) ouvert APRÈS ce contrôle : un `accountId` fourni
 *    par un appelant ne suffit jamais.
 *
 * Motifs stables : CORPUS_ACCOUNT_OK, CORPUS_ACCOUNT_MISSING,
 * CORPUS_ACCOUNT_MISMATCH, CORPUS_ACCOUNT_INVALID.
 *
 * ── PROVISIONNEMENT ────────────────────────────────────────────────────────
 * Un seul mécanisme (`provisionCorpusAccount`), utilisé par le seed
 * `db:seed:corpus-account`, la route `POST /api/cron/ai/corpus-account`
 * (CRON_SECRET), l'action du BO (Configuration IA › Compte technique, auditée)
 * et l'auto-provisionnement de PRÉPRODUCTION (`AI_CORPUS_ACCOUNT_AUTO_PROVISION`,
 * actif par défaut en préproduction, jamais en production). Idempotent : un
 * compte existant à l'identité dédiée est MARQUÉ (jamais dupliqué) ; un compte
 * client n'est jamais requalifié.
 *
 * Aucun secret, aucune adresse e-mail client dans les journaux ou anomalies.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'node:crypto';

/** Adresse du compte technique. Locale et non routable, jamais joignable. */
export const CORPUS_EMAIL = 'corpus@verebona.local';
export const CORPUS_ACCOUNT_NAME = 'Corpus de recette IA';
/** Marqueur de mot de passe impossible à satisfaire (aucun hachage bcrypt ne commence par `!`). */
export const CORPUS_PASSWORD_MARKER = '!corpus-no-login';
/** Valeur du marqueur d'identité technique (`accounts.technical_kind`, migration 0960). */
export const CORPUS_TECHNICAL_KIND = 'AI_QUALIFICATION_CORPUS';

export type CorpusAccountCode = 'CORPUS_ACCOUNT_OK' | 'CORPUS_ACCOUNT_MISSING' | 'CORPUS_ACCOUNT_MISMATCH' | 'CORPUS_ACCOUNT_INVALID';

export const CORPUS_ACCOUNT_LABELS: Readonly<Record<CorpusAccountCode, string>> = Object.freeze({
  CORPUS_ACCOUNT_OK: 'compte technique de qualification utilisable',
  CORPUS_ACCOUNT_MISSING: 'compte technique de qualification absent',
  CORPUS_ACCOUNT_MISMATCH: 'paramétrage du compte technique incohérent (CORPUS_ACCOUNT_ID désigne un autre compte)',
  CORPUS_ACCOUNT_INVALID: 'compte technique de qualification non conforme (identité, statut ou doublon)',
});

/**
 * Paramètres centralisés (aucune règle en dur ailleurs).
 *   · `maxAutoResumes` : reprises AUTOMATIQUES d'une même incompatibilité
 *     bloquée par ce prérequis (une par état réparé du compte, au plus N) ;
 *   · auto-provisionnement : préproduction seulement, coupable.
 */
export const CORPUS_ACCOUNT_PARAMS = Object.freeze({
  maxAutoResumes: 3,
  autoProvisionVar: 'AI_CORPUS_ACCOUNT_AUTO_PROVISION',
});

/** Auto-provisionnement autorisé ? Préproduction : oui sauf `off` ; local : seulement `on` ; production : jamais. */
export function autoProvisionAllowed(env: string, vars: Record<string, string | undefined> = process.env): boolean {
  if (env === 'production') return false;
  const v = (vars[CORPUS_ACCOUNT_PARAMS.autoProvisionVar] ?? '').trim().toLowerCase();
  if (['off', 'false', '0', 'no'].includes(v)) return false;
  if (['on', 'true', '1', 'yes'].includes(v)) return true;
  return env === 'preprod';
}

// ══════════════════════════════════════════════════════════════════════════
// Faits lus en base et évaluation (pure)
// ══════════════════════════════════════════════════════════════════════════

export interface CorpusAccountFacts {
  accountId: number;
  userId: number;
  technicalKind: string | null;
  ownerIsCorpusIdentity: boolean;
  accountActive: boolean;
  archived: boolean;
  subscriptionStatus: string;
  hasStripe: boolean;
  billableSubscription: boolean;
  userActive: boolean;
  passwordLocked: boolean;
  userRole: string;
  ownerPendingDeletion: boolean;
  ownerAccounts: number;
  otherMembers: number;
}

export interface CorpusAccountSnapshot {
  /** Valeur brute de CORPUS_ACCOUNT_ID (jamais un secret ; non journalisée ailleurs que dans le diagnostic). */
  configuredRaw: string | null;
  /** Colonne `technical_kind` présente (migration 0960 appliquée). */
  markerColumn: boolean;
  /** Comptes marqués, comptes à l'identité dédiée, compte désigné par la variable (dédoublonnés). */
  accounts: CorpusAccountFacts[];
}

export interface CorpusAccountStatus {
  ok: boolean;
  code: CorpusAccountCode;
  label: string;
  /** Compte technique à utiliser (seulement si `ok`). */
  accountId: number | null;
  /** Compte marqué trouvé (même s'il est non conforme). */
  markedAccountId: number | null;
  variable: { declared: boolean; value: number | null; readable: boolean; matches: boolean | null; stale: boolean };
  resolvedBy: 'marker' | 'variable' | null;
  /** CORPUS_ACCOUNT_ID désigne un compte CLIENT : refus et anomalie de sécurité. */
  security: boolean;
  reasons: string[];
  warnings: string[];
  /** Prochain geste lisible par le PO (BO, sans accès base). */
  nextAction: string | null;
  /** Empreinte de l'état (change à chaque réparation effective). */
  stateFingerprint: string;
  checkedAt: string;
}

const isMarked = (a: CorpusAccountFacts) => a.technicalKind === CORPUS_TECHNICAL_KIND;

/** Non-conformités d'un compte technique (vide = conforme). Pure. */
export function corpusAccountDefects(a: CorpusAccountFacts): string[] {
  const d: string[] = [];
  if (!a.ownerIsCorpusIdentity) d.push('titulaire différent de l’identité dédiée du corpus');
  if (a.userActive) d.push('utilisateur actif : connexion possible');
  if (!a.passwordLocked) d.push('mot de passe utilisable (marqueur de connexion impossible absent)');
  if (a.userRole !== 'USER') d.push(`rôle ${a.userRole} (USER attendu)`);
  if (a.ownerPendingDeletion) d.push('titulaire en suppression');
  if (!a.accountActive) d.push('compte suspendu');
  if (a.archived) d.push('compte neutralisé');
  if (a.subscriptionStatus !== 'NONE') d.push(`statut d’abonnement ${a.subscriptionStatus} (NONE attendu : jamais facturable)`);
  if (a.hasStripe) d.push('client ou abonnement Stripe rattaché');
  if (a.billableSubscription) d.push('abonnement facturable présent');
  if (a.ownerAccounts > 1) d.push('le titulaire possède plusieurs comptes');
  if (a.otherMembers > 0) d.push('autres membres rattachés');
  return d;
}

/** Un compte « client » au sens de la sécurité : ni marqué, ni à l'identité dédiée. */
function isClientAccount(a: CorpusAccountFacts): boolean {
  return !isMarked(a) && !a.ownerIsCorpusIdentity;
}

const fingerprint = (o: unknown) => createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0, 32);

/** Évaluation PURE (testée) : présent, unique, identité attendue, statut, cohérence de la variable. */
export function assessCorpusAccount(s: CorpusAccountSnapshot, now: Date = new Date()): CorpusAccountStatus {
  const raw = (s.configuredRaw ?? '').trim();
  const declared = raw !== '';
  const n = Number(raw);
  const readable = declared && Number.isSafeInteger(n) && n > 0;
  const value = readable ? n : null;
  const marked = s.accounts.filter(isMarked);
  const identity = s.accounts.filter((a) => a.ownerIsCorpusIdentity);
  const designated = value != null ? s.accounts.find((a) => a.accountId === value) ?? null : null;
  const reasons: string[] = [];
  const warnings: string[] = [];
  let security = false;
  let code: CorpusAccountCode = 'CORPUS_ACCOUNT_OK';
  let accountId: number | null = null;
  let resolvedBy: CorpusAccountStatus['resolvedBy'] = null;
  let nextAction: string | null = null;
  const target = marked.length === 1 ? marked[0] : null;

  if (!s.markerColumn) {
    code = 'CORPUS_ACCOUNT_INVALID';
    reasons.push('migration 0960 non appliquée : marqueur d’identité technique absent, aucune exemption possible');
    nextAction = 'Attendre la fin du déploiement (migration 0960), puis relancer le contrôle.';
  } else if (designated && isClientAccount(designated)) {
    // Le plus grave d'abord : jamais un compte client comme substitut.
    code = 'CORPUS_ACCOUNT_MISMATCH';
    security = true;
    reasons.push(`CORPUS_ACCOUNT_ID=${value} désigne un compte CLIENT : campagne et exemptions refusées (anomalie de sécurité)`);
    nextAction = target
      ? `Corriger CORPUS_ACCOUNT_ID côté hébergeur (valeur attendue ${target.accountId}) ou la supprimer, puis redémarrer.`
      : 'Supprimer CORPUS_ACCOUNT_ID côté hébergeur (ou la corriger), redémarrer, puis provisionner le compte technique depuis le BO.';
  } else if (marked.length > 1 || identity.length > 1) {
    code = 'CORPUS_ACCOUNT_INVALID';
    reasons.push(`compte technique en double (${marked.length} marqué(s), ${identity.length} à l’identité dédiée) : mesure ambiguë`);
    nextAction = 'Signaler au support : un seul compte technique doit subsister (aucune suppression automatique).';
  } else if (!target) {
    const legacy = identity[0] ?? null;
    if (legacy) {
      code = 'CORPUS_ACCOUNT_INVALID';
      reasons.push(`compte ${legacy.accountId} à l’identité dédiée mais sans marqueur technique`);
      nextAction = 'BO › Configuration IA › Compte technique de qualification › « Provisionner / réparer » (marque le compte existant, sans doublon).';
    } else {
      code = 'CORPUS_ACCOUNT_MISSING';
      reasons.push(declared ? `CORPUS_ACCOUNT_ID=${raw} : aucun compte technique correspondant (compte introuvable)` : 'aucun compte technique de qualification en base');
      nextAction = 'BO › Configuration IA › Compte technique de qualification › « Provisionner / réparer ».';
    }
  } else {
    const defects = corpusAccountDefects(target);
    if (defects.length) {
      code = 'CORPUS_ACCOUNT_INVALID';
      reasons.push(...defects.map((d) => `compte ${target.accountId} : ${d}`));
      nextAction = 'Signaler au support : le compte technique ne doit être ni connectable, ni facturable, ni suspendu (aucune correction automatique d’un compte non conforme).';
    } else if (declared && !readable) {
      code = 'CORPUS_ACCOUNT_MISMATCH';
      reasons.push(`CORPUS_ACCOUNT_ID illisible (« ${raw.slice(0, 20)} »)`);
      nextAction = `Corriger CORPUS_ACCOUNT_ID (valeur attendue ${target.accountId}) ou la supprimer, puis redémarrer.`;
    } else if (value != null && value !== target.accountId && designated) {
      code = 'CORPUS_ACCOUNT_MISMATCH';
      reasons.push(`CORPUS_ACCOUNT_ID=${value} désigne un autre compte que le compte technique ${target.accountId}`);
      nextAction = `Corriger CORPUS_ACCOUNT_ID (valeur attendue ${target.accountId}) ou la supprimer, puis redémarrer.`;
    } else {
      accountId = target.accountId;
      resolvedBy = value === target.accountId ? 'variable' : 'marker';
      if (value != null && value !== target.accountId) {
        warnings.push(`CORPUS_ACCOUNT_ID=${value} est obsolète (compte inexistant, ex. après copie de la base) : le compte technique ${target.accountId} est reconnu par son marqueur. Mettre la variable à ${target.accountId} ou la supprimer.`);
      }
      if (!declared) warnings.push(`CORPUS_ACCOUNT_ID non déclarée : compte technique ${target.accountId} reconnu par son marqueur en base.`);
    }
  }
  const ok = code === 'CORPUS_ACCOUNT_OK';
  const stale = value != null && !designated && !!target && ok;
  return {
    ok, code, label: CORPUS_ACCOUNT_LABELS[code], accountId: ok ? accountId : null, markedAccountId: target?.accountId ?? null,
    variable: { declared, value, readable, matches: value == null ? null : target ? value === target.accountId : false, stale },
    resolvedBy, security, reasons, warnings, nextAction,
    stateFingerprint: fingerprint({ code, accountId, marked: target?.accountId ?? null, value, reasons }),
    checkedAt: now.toISOString(),
  };
}

// ══════════════════════════════════════════════════════════════════════════
// Lecture
// ══════════════════════════════════════════════════════════════════════════

type Row = Record<string, unknown>;
export type CorpusQuery = (text: string, params: unknown[]) => Promise<Row[]>;

const defaultQuery: CorpusQuery = async (text, params) => {
  const { pgClient } = await import('@/db');
  return (await pgClient.unsafe(text, params as never[])) as unknown as Row[];
};

const FACTS_SQL = (where: string) => `
  SELECT a.id AS account_id, u.id AS user_id, a.technical_kind, lower(u.email) = $1 AS owner_is_corpus,
         a.is_active IS NOT FALSE AS account_active, a.archived_at IS NOT NULL AS archived, a.subscription_status,
         (a.stripe_customer_id IS NOT NULL OR a.stripe_subscription_id IS NOT NULL) AS has_stripe,
         EXISTS (SELECT 1 FROM account_subscriptions s WHERE s.account_id = a.id AND s.status IN ('trialing', 'active', 'past_due')) AS billable_subscription,
         u.is_active AS user_active, COALESCE(u.password_hash LIKE '!%', false) AS password_locked, u.role,
         (u.status = 'PENDING_DELETION') AS owner_pending_deletion,
         (SELECT count(*) FROM accounts a2 WHERE a2.owner_user_id = u.id)::int AS owner_accounts,
         (SELECT count(*) FROM account_memberships m WHERE m.account_id = a.id AND m.removed_at IS NULL
            AND m.user_id IS DISTINCT FROM a.owner_user_id AND m.status IN ('active', 'pending'))::int AS other_members
    FROM accounts a JOIN users u ON u.id = a.owner_user_id
   WHERE ${where}
   ORDER BY a.id
   LIMIT 20`;

const toFacts = (r: Row): CorpusAccountFacts => ({
  accountId: Number(r.account_id), userId: Number(r.user_id), technicalKind: r.technical_kind == null ? null : String(r.technical_kind),
  ownerIsCorpusIdentity: r.owner_is_corpus === true, accountActive: r.account_active !== false, archived: r.archived === true,
  subscriptionStatus: String(r.subscription_status ?? 'NONE'), hasStripe: r.has_stripe === true, billableSubscription: r.billable_subscription === true,
  userActive: r.user_active === true, passwordLocked: r.password_locked === true, userRole: String(r.role ?? ''),
  ownerPendingDeletion: r.owner_pending_deletion === true, ownerAccounts: Number(r.owner_accounts ?? 0), otherMembers: Number(r.other_members ?? 0),
});

/** Lit l'état (une à deux requêtes, lecture seule). `query` : client lecture seule du diagnostic global, par exemple. */
export async function readCorpusAccountSnapshot(opts: { query?: CorpusQuery; env?: Record<string, string | undefined> } = {}): Promise<CorpusAccountSnapshot> {
  const query = opts.query ?? defaultQuery;
  const configuredRaw = (opts.env ?? process.env).CORPUS_ACCOUNT_ID ?? null;
  const n = Number(configuredRaw);
  const designated = Number.isSafeInteger(n) && n > 0 ? n : 0;
  try {
    const rows = await query(FACTS_SQL(`a.technical_kind = $2 OR lower(u.email) = $1 OR a.id = $3`), [CORPUS_EMAIL, CORPUS_TECHNICAL_KIND, designated]);
    return { configuredRaw, markerColumn: true, accounts: rows.map(toFacts) };
  } catch (e) {
    if (String((e as { code?: unknown })?.code ?? '') !== '42703') throw e;
    // Avant la migration 0960 : identité seule, sans marqueur (aucune exemption possible).
    const rows = await query(FACTS_SQL(`lower(u.email) = $1 OR a.id = $2`).replace('a.technical_kind,', 'NULL::text AS technical_kind,'), [CORPUS_EMAIL, designated]);
    return { configuredRaw, markerColumn: false, accounts: rows.map(toFacts) };
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Supervision (une anomalie regroupée, résolue automatiquement)
// ══════════════════════════════════════════════════════════════════════════

/**
 * Empreintes de Supervision (domaine IA). Le balayage de Supervision
 * (`supervision-sweep.service.ts`) les entretient aussi à partir du même
 * diagnostic : une seule anomalie regroupée par cause, jamais une par
 * incompatibilité ou par campagne.
 */
export const CORPUS_ACCOUNT_FINGERPRINT = 'ai:qualification:corpus-account';
export const CORPUS_ACCOUNT_SECURITY_FINGERPRINT = 'ai:qualification:corpus-account:security';
const FP_PREREQUISITE = CORPUS_ACCOUNT_FINGERPRINT;
const FP_SECURITY = CORPUS_ACCOUNT_SECURITY_FINGERPRINT;

/** Titre et détail de l'anomalie (partagés avec le balayage de Supervision). Aucune donnée client. */
export function corpusAnomalyInputs(st: CorpusAccountStatus, impact: unknown): { prerequisite: { title: string; detail: Record<string, unknown> }; security: { title: string; detail: Record<string, unknown> } | null } {
  const detail = {
    code: st.code, reasons: st.reasons.slice(0, 10), nextAction: st.nextAction, markedAccountId: st.markedAccountId,
    variable: { declared: st.variable.declared, value: st.variable.value }, impact, boLink: '/admin/ai-config',
  };
  return {
    prerequisite: { title: `Qualification IA bloquée : ${st.label} (${st.code}) — campagnes et mises en conformité en attente`, detail },
    security: st.security ? { title: 'Sécurité : CORPUS_ACCOUNT_ID désigne un compte client — aucune exemption accordée, campagnes refusées', detail } : null,
  };
}

/** Production : seul un défaut de SÉCURITÉ est signalé (aucune campagne n'y tourne ; le test de clé du BO répond 503 motivé). */
export function corpusAnomalyReportable(st: CorpusAccountStatus, env: string): boolean {
  return !st.ok && (env !== 'production' || st.security);
}

/** Affectés par le prérequis (informations transmises à l'anomalie, jamais de donnée client). */
export interface CorpusAccountImpact { source: string; operations?: string[]; contracts?: string[]; campaignId?: number | null }

async function superviser(st: CorpusAccountStatus, impact: CorpusAccountImpact | null, env: string): Promise<void> {
  try {
    const anomalies = await import('@/services/admin/anomaly.service');
    if (st.ok || !corpusAnomalyReportable(st, env)) {
      await anomalies.autoResolveAnomaly(FP_PREREQUISITE, { origin: 'corpus_account_check', cause: `compte technique ${st.accountId} de nouveau utilisable` });
      await anomalies.autoResolveAnomaly(FP_SECURITY, { origin: 'corpus_account_check', cause: 'CORPUS_ACCOUNT_ID ne désigne plus un compte client' });
      return;
    }
    const inputs = corpusAnomalyInputs(st, impact);
    await anomalies.reportAnomaly({ domain: 'ai', fingerprint: FP_PREREQUISITE, title: inputs.prerequisite.title, detail: inputs.prerequisite.detail });
    if (inputs.security) {
      console.warn(`[corpus-account] ANOMALIE DE SÉCURITÉ : CORPUS_ACCOUNT_ID=${st.variable.value} désigne un compte client — campagne et exemptions refusées.`);
      await anomalies.reportAnomaly({ domain: 'ai', fingerprint: FP_SECURITY, accountId: st.variable.value, title: inputs.security.title, detail: inputs.security.detail });
    } else {
      await anomalies.autoResolveAnomaly(FP_SECURITY, { origin: 'corpus_account_check', cause: 'CORPUS_ACCOUNT_ID ne désigne plus un compte client' });
    }
  } catch (e) {
    console.error('[corpus-account] supervision impossible (non bloquant) :', (e as Error).message);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Contrôle (précontrôle des campagnes)
// ══════════════════════════════════════════════════════════════════════════

export interface CheckOptions {
  /** Signaler / résoudre l'anomalie de Supervision (défaut : non — lecture seule). */
  report?: boolean;
  /** Auto-provisionner si absent (préproduction seulement, voir `autoProvisionAllowed`). */
  autoProvision?: boolean;
  environment?: string;
  impact?: CorpusAccountImpact | null;
  /** Variables lues (défaut `process.env`) — ex. compte attendu injecté par une campagne de test. */
  env?: Record<string, string | undefined>;
  /** Tests : snapshot injecté (aucune écriture, aucun auto-provisionnement). */
  snapshot?: () => Promise<CorpusAccountSnapshot>;
  now?: Date;
}

/** Contrôle du compte technique (présent, unique, identité attendue, statut, liaison de configuration). */
export async function checkCorpusAccount(opts: CheckOptions = {}): Promise<CorpusAccountStatus> {
  const lire = opts.snapshot ?? (() => readCorpusAccountSnapshot({ env: opts.env }));
  let st = assessCorpusAccount(await lire(), opts.now);
  if (!st.ok && st.code !== 'CORPUS_ACCOUNT_MISMATCH' && opts.autoProvision && !opts.snapshot) {
    const env = opts.environment ?? (await import('../config/environment')).getAiEnvironment();
    // Absent, ou présent à l'identité dédiée mais non marqué : réparation idempotente (jamais un compte client).
    const reparable = st.code === 'CORPUS_ACCOUNT_MISSING' || (st.code === 'CORPUS_ACCOUNT_INVALID' && st.markedAccountId == null && st.reasons.every((r) => r.includes('sans marqueur technique')));
    if (reparable && autoProvisionAllowed(env)) {
      try {
        const r = await provisionCorpusAccount({ actor: 'auto-provision' });
        console.info(`[corpus-account] auto-provisionnement (${env}) : ${r.status}, compte ${r.accountId ?? '—'}.`);
        st = assessCorpusAccount(await lire(), opts.now);
      } catch (e) {
        console.error('[corpus-account] auto-provisionnement impossible :', (e as Error).message);
      }
    }
  }
  if (!st.ok) console.warn(`[corpus-account] ${st.code} : ${st.reasons.join(' ; ').slice(0, 500)}`);
  if (opts.report) await superviser(st, opts.impact ?? null, opts.environment ?? (await import('../config/environment')).getAiEnvironment());
  return st;
}

// ══════════════════════════════════════════════════════════════════════════
// Provisionnement idempotent (mécanisme unique)
// ══════════════════════════════════════════════════════════════════════════

export interface ProvisionResult {
  status: 'created' | 'already_present' | 'marked' | 'refused';
  accountId: number | null;
  userId: number | null;
  message: string;
  check: CorpusAccountStatus;
}

/**
 * Crée (ou marque) le compte technique, sans jamais le dupliquer ni requalifier
 * un compte client. Sérialisé par un verrou consultatif transactionnel (deux
 * instances ne créent jamais deux comptes). Refusé si l'identité dédiée est
 * déjà prise par un utilisateur non conforme (connectable, etc.).
 */
export async function provisionCorpusAccount(p: { actor: string } = { actor: 'unknown' }): Promise<ProvisionResult> {
  const { ensureMigrations, pgClient } = await import('@/db');
  await ensureMigrations();
  const out = await pgClient.begin(async (tx) => {
    const t = tx as unknown as { unsafe: (s: string, p?: never[]) => Promise<Row[]> };
    await t.unsafe(`SELECT pg_advisory_xact_lock(hashtext('verebona:corpus-account'))`);
    const [marque] = await t.unsafe(`SELECT id, owner_user_id FROM accounts WHERE technical_kind = $1 ORDER BY id LIMIT 1`, [CORPUS_TECHNICAL_KIND] as never[]);
    if (marque) return { status: 'already_present' as const, accountId: Number(marque.id), userId: Number(marque.owner_user_id), message: 'Compte technique déjà présent (marqueur en base) : rien créé.' };
    const [u] = await t.unsafe(`SELECT id, is_active, COALESCE(password_hash LIKE '!%', false) AS locked, role FROM users WHERE lower(email) = $1 LIMIT 1`, [CORPUS_EMAIL] as never[]);
    if (u) {
      if (u.is_active === true || u.locked !== true || String(u.role) !== 'USER') {
        return { status: 'refused' as const, accountId: null, userId: Number(u.id), message: 'Identité dédiée déjà utilisée par un utilisateur non conforme (connectable ou rôle non USER) : aucun marquage automatique.' };
      }
      const comptes = await t.unsafe(`SELECT id, subscription_status, stripe_customer_id IS NOT NULL AS stripe FROM accounts WHERE owner_user_id = $1 ORDER BY id`, [u.id] as never[]);
      if (comptes.length > 1) return { status: 'refused' as const, accountId: null, userId: Number(u.id), message: 'Plusieurs comptes pour l’identité dédiée : marquage refusé (ambigu).' };
      if (comptes.length === 1) {
        const c = comptes[0];
        if (String(c.subscription_status) !== 'NONE' || c.stripe === true) {
          return { status: 'refused' as const, accountId: Number(c.id), userId: Number(u.id), message: 'Compte de l’identité dédiée facturable : marquage refusé.' };
        }
        await t.unsafe(`UPDATE accounts SET technical_kind = $2, updated_at = now() WHERE id = $1 AND technical_kind IS NULL`, [c.id, CORPUS_TECHNICAL_KIND] as never[]);
        return { status: 'marked' as const, accountId: Number(c.id), userId: Number(u.id), message: 'Compte existant à l’identité dédiée marqué comme compte technique (aucun doublon).' };
      }
    }
    const userId = u ? Number(u.id) : Number((await t.unsafe(
      `INSERT INTO users (email, password_hash, first_name, last_name, is_active, role, plan_type, accepted_terms_at, terms_version)
       VALUES ($1, $2, 'Corpus', 'Recette', false, 'USER', 'PREMIUM', now(), 'n/a') RETURNING id`,
      [CORPUS_EMAIL, CORPUS_PASSWORD_MARKER] as never[]))[0].id);
    // PREMIUM : la mesure ne bute pas sur un quota d'offre ; NONE : jamais facturable ni compté comme client.
    const [a] = await t.unsafe(
      `INSERT INTO accounts (name, owner_user_id, plan_type, subscription_status, is_active, technical_kind)
       VALUES ($1, $2, 'PREMIUM', 'NONE', true, $3) RETURNING id`,
      [CORPUS_ACCOUNT_NAME, userId, CORPUS_TECHNICAL_KIND] as never[]);
    return { status: 'created' as const, accountId: Number(a.id), userId, message: 'Compte technique créé et marqué.' };
  }) as Omit<ProvisionResult, 'check'>;
  const { invalidateProcessingEligibility } = await import('@/services/account/processing-eligibility');
  invalidateProcessingEligibility();
  const check = assessCorpusAccount(await readCorpusAccountSnapshot());
  console.info(`[corpus-account] provisionnement (${p.actor.slice(0, 60)}) : ${out.status}${out.accountId ? `, compte ${out.accountId}` : ''} → ${check.code}.`);
  return { ...out, check };
}
