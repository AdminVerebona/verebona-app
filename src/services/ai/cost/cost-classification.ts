/**
 * Classification UNIQUE du coût d'un appel modèle — lot 113AF (Trello #730,
 * « Fiabiliser la comptabilisation des coûts fournisseur, métier et
 * techniques (T1–T6) »). PUR : aucun import serveur ; partagé par la
 * passerelle (écriture à la source), le rapport des coûts, les budgets, le
 * plafond mensuel par compte, les tableaux de bord et le rattrapage historique.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE DÉFAUT CORRIGÉ
 *
 * Jusqu'ici, le coût « métier » était `ai_usage_event.is_billable`, lui-même
 * égal à `op.billable && !shadow` (registre `operations.ts`). Or `billable` est
 * une POLITIQUE COMMERCIALE (« compte au quota client ? ») : `t1_group_upload`,
 * `t2_understand`, la plupart des branches T3, tout T4 et T6 sont à `false`
 * alors qu'ils sont exécutés POUR un compte. Leur coût fournisseur partait en
 * « Technique et tests » et échappait aux budgets et au plafond du compte.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LA RÈGLE (version `COST_CLASSIFICATION_VERSION`)
 *
 * Deux dimensions, INDÉPENDANTES de la politique de quota :
 *   · ORIGINE de l'appel : service d'un compte (métier, tâches de fond
 *     comprises), technique (sonde, qualification, corpus, AI_GOVERNANCE,
 *     test, compte technique certifié), observation (shadow), ou — pour
 *     l'historique seulement — non déterminable ;
 *   · IMPUTABILITÉ au compte : vraie seulement pour l'origine « service du
 *     compte » (le coût entre dans les budgets et le plafond de CE compte).
 * Règles ordonnées (la première qui s'applique décide) — `COST_RULES` :
 *   1. shadow                         → OBSERVATION
 *   2. aucun compte                   → TECHNIQUE (sonde, système)
 *   3. usage AI_GOVERNANCE            → TECHNIQUE
 *   4. opération technique (sondes, test fournisseur, évaluation, ancien T5)
 *   5. déclencheur de qualification   → TECHNIQUE
 *   6. essai d'amélioration (113I)    → TECHNIQUE
 *   7. compte technique de qualification (marqueur en base ou contexte
 *      serveur vérifié)               → TECHNIQUE
 *   8. campagne de mesure exemptée du plafond (`costCapExempt`) → TECHNIQUE
 *   9. opération du registre appelant un modèle → SERVICE DU COMPTE, quelle
 *      que soit sa valeur `billable`
 *  10. historique hors registre compté métier à l'époque (`is_billable`) →
 *      SERVICE DU COMPTE
 *  11. sinon                          → NON DÉTERMINABLE (historique),
 *      signalé, jamais deviné.
 *
 * Ce que la règle NE fait PAS : elle ne chiffre rien (le coût reste celui
 * figé à l'appel, corrections de régularisation #670/#713 comprises), ne
 * change ni `is_billable` ni `op.billable` (quota et droits commerciaux
 * inchangés), et ne transforme jamais un coût inconnu en zéro (le statut
 * tarifaire de `telemetry/cost-status.ts` reste l'autorité).
 *
 * La même règle existe en SQL (`costOriginSql`) pour les traces écrites avant
 * la colonne `cost_origin` (migration 1610) et pour les agrégats journaliers :
 * elle est GÉNÉRÉE depuis la même table de règles — aucune seconde définition.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { AI_OPERATIONS } from '../registry/operations';

/** Version de la règle (toute évolution de la règle change ce code). */
export const COST_CLASSIFICATION_VERSION = 'couts-ia-v1' as const;

export const COST_ORIGINS = ['ACCOUNT_SERVICE', 'TECHNICAL', 'SHADOW', 'UNDETERMINED'] as const;
export type CostOrigin = (typeof COST_ORIGINS)[number];

export const COST_REASONS = [
  'SHADOW', 'NO_ACCOUNT', 'AI_GOVERNANCE', 'TECHNICAL_OPERATION', 'TECHNICAL_TRIGGER', 'IMPROVEMENT_ATTEMPT',
  'TECHNICAL_ACCOUNT', 'COST_CAP_EXEMPT', 'REGISTRY_OPERATION', 'LEGACY_BILLABLE', 'NOT_CLASSIFIABLE',
] as const;
export type CostReason = (typeof COST_REASONS)[number];

/** Opérations techniques tracées hors registre (sondes, test fournisseur) et évaluation d'un prompt candidat. */
export const TECHNICAL_OPERATIONS: readonly string[] = [
  'evaluate_prompt', 'provider_test', 'model_operational_probe', 'model_qualification_probe', 'circuit_breaker_probe',
];
/** Ancien outil d'administration T5, retiré au lot 49 (traces historiques). */
const RETIRED_TECHNICAL_PREFIX = 't5_';
/** Déclencheurs d'appels techniques (campagnes de qualification, lot 85-103). */
export const TECHNICAL_TRIGGERS: readonly string[] = ['qualification'];
/** Marqueur du compte technique de qualification (`accounts.technical_kind`, migration 0960). */
export const TECHNICAL_ACCOUNT_KIND = 'AI_QUALIFICATION_CORPUS' as const;

/** Opérations du registre qui appellent réellement un modèle (actives ou non). */
export function registryModelOperations(): string[] {
  return Object.values(AI_OPERATIONS).filter((o) => o.provider !== 'none').map((o) => o.operationCode).sort();
}

/** Contexte d'exécution FIABLE d'un appel (serveur), ou relu d'une trace historique. */
export interface CostClassificationInput {
  accountId: number | null | undefined;
  useCaseCode: string | null | undefined;
  operationCode: string | null | undefined;
  shadow?: boolean | null;
  triggerCode?: string | null;
  /** Essai d'amélioration IA (clé d'essai portée par le contexte, lot 113I). */
  improvementAttempt?: boolean | null;
  /**
   * Compte technique de qualification : contexte serveur VÉRIFIÉ d'une
   * campagne (`technical-context.ts`) ou marqueur en base. Jamais la seule
   * variable `CORPUS_ACCOUNT_ID`.
   */
  technicalAccount?: boolean | null;
  /** Campagne de mesure du BO exemptée du plafond (`costCapExempt` de la requête). */
  costCapExempt?: boolean | null;
  /**
   * Ancien booléen de la trace (`is_billable`) : utilisé SEULEMENT pour une
   * opération hors registre (historique), jamais pour une opération connue.
   */
  legacyBillable?: boolean | null;
}

export interface CostClassification {
  origin: CostOrigin;
  reason: CostReason;
  /** Le coût entre dans les budgets métier et dans le plafond de CE compte. */
  imputable: boolean;
  rule: typeof COST_CLASSIFICATION_VERSION;
}

type SqlKind = 'event' | 'rollup';

interface CostRule {
  reason: CostReason;
  origin: CostOrigin;
  applies: (i: CostClassificationInput, ops: ReadonlySet<string>) => boolean;
  /**
   * Prédicat SQL équivalent sur une ligne `ai_usage_event` (`event`) ou
   * `ai_usage_daily_rollup` (`rollup`, sans opération ni métadonnée) ; `null` :
   * information absente de ce support (la règle ne s'y applique pas).
   */
  sql: (a: string, kind: SqlKind) => string | null;
}

const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
const list = (vs: readonly string[]) => vs.map(lit).join(', ');
const opOf = (a: string) => `COALESCE(${a}.operation_code, ${a}.operation_type)`;
const hasAccount = (id: number | null | undefined) => typeof id === 'number' && id > 0;

/** Table de règles UNIQUE (TypeScript et SQL générés d'ici). Ordre significatif. */
const COST_RULES: readonly CostRule[] = [
  {
    reason: 'SHADOW', origin: 'SHADOW',
    applies: (i) => i.shadow === true,
    sql: (a, k) => (k === 'event' ? `COALESCE(${a}.metadata->>'shadow', 'false') = 'true'` : null),
  },
  {
    reason: 'NO_ACCOUNT', origin: 'TECHNICAL',
    applies: (i) => !hasAccount(i.accountId),
    sql: (a) => `${a}.account_id IS NULL`,
  },
  {
    reason: 'AI_GOVERNANCE', origin: 'TECHNICAL',
    applies: (i) => i.useCaseCode === 'AI_GOVERNANCE',
    sql: (a) => `${a}.use_case_code = 'AI_GOVERNANCE'`,
  },
  {
    reason: 'TECHNICAL_OPERATION', origin: 'TECHNICAL',
    applies: (i) => Boolean(i.operationCode && (TECHNICAL_OPERATIONS.includes(i.operationCode) || i.operationCode.startsWith(RETIRED_TECHNICAL_PREFIX))),
    sql: (a, k) => (k === 'event'
      ? `(${opOf(a)} IN (${list(TECHNICAL_OPERATIONS)}) OR ${opOf(a)} LIKE '${RETIRED_TECHNICAL_PREFIX.replace('_', '\\_')}%')`
      : null),
  },
  {
    reason: 'TECHNICAL_TRIGGER', origin: 'TECHNICAL',
    applies: (i) => Boolean(i.triggerCode && TECHNICAL_TRIGGERS.includes(i.triggerCode)),
    sql: (a, k) => (k === 'event' ? `COALESCE(${a}.metadata->>'trigger', '') IN (${list(TECHNICAL_TRIGGERS)})` : null),
  },
  {
    reason: 'IMPROVEMENT_ATTEMPT', origin: 'TECHNICAL',
    applies: (i) => i.improvementAttempt === true,
    sql: (a, k) => (k === 'event' ? `COALESCE(${a}.metadata->>'improvementAttemptKey', '') <> ''` : null),
  },
  {
    reason: 'TECHNICAL_ACCOUNT', origin: 'TECHNICAL',
    applies: (i) => i.technicalAccount === true,
    sql: (a) => `EXISTS (SELECT 1 FROM accounts ta WHERE ta.id = ${a}.account_id AND ta.technical_kind = ${lit(TECHNICAL_ACCOUNT_KIND)})`,
  },
  {
    // Information de la requête seulement : écrite à la source, jamais déductible après coup.
    reason: 'COST_CAP_EXEMPT', origin: 'TECHNICAL',
    applies: (i) => i.costCapExempt === true,
    sql: () => null,
  },
  {
    reason: 'REGISTRY_OPERATION', origin: 'ACCOUNT_SERVICE',
    applies: (i, ops) => Boolean(i.operationCode && ops.has(i.operationCode)),
    sql: (a, k) => (k === 'event' ? `${opOf(a)} IN (${list(registryModelOperations())})` : null),
  },
  {
    reason: 'LEGACY_BILLABLE', origin: 'ACCOUNT_SERVICE',
    applies: (i) => i.legacyBillable === true,
    sql: (a) => `${a}.is_billable`,
  },
];

const DEFAULT_RULE = { reason: 'NOT_CLASSIFIABLE' as const, origin: 'UNDETERMINED' as const };

/** Classe un appel (pur). Une seule règle décide : la première applicable. */
export function classifyCallCost(i: CostClassificationInput): CostClassification {
  const ops = new Set(registryModelOperations());
  const r = COST_RULES.find((x) => x.applies(i, ops)) ?? DEFAULT_RULE;
  return { origin: r.origin, reason: r.reason, imputable: r.origin === 'ACCOUNT_SERVICE', rule: COST_CLASSIFICATION_VERSION };
}

/** Origine d'une raison (pur). */
export function originOfReason(reason: CostReason): CostOrigin {
  return COST_RULES.find((r) => r.reason === reason)?.origin ?? DEFAULT_RULE.origin;
}

/**
 * Exemption du plafond mensuel du compte (`account-cost-cap`), avant appel —
 * mêmes critères techniques que la classification, inchangés depuis le lot
 * 22 / 103G : appel exempté par la requête, sans compte, compte technique
 * VÉRIFIÉ par le contexte serveur, usage AI_GOVERNANCE. `null` : soumis au
 * plafond. Pur.
 */
export function costCapExemption(p: {
  accountId: number | null | undefined; useCaseCode: string; exempt?: boolean; technicalAccountInContext: boolean;
}): CostReason | null {
  if (p.exempt) return 'COST_CAP_EXEMPT';
  if (!hasAccount(p.accountId)) return 'NO_ACCOUNT';
  if (p.technicalAccountInContext) return 'TECHNICAL_ACCOUNT';
  if (p.useCaseCode === 'AI_GOVERNANCE') return 'AI_GOVERNANCE';
  return null;
}

// ── SQL (généré depuis la même table de règles) ─────────────────────────────

interface SqlOptions {
  /** `event` (défaut) ou `rollup`. */
  kind?: SqlKind;
  /**
   * Lire d'abord la classification persistée (`cost_origin`, migration 1610).
   * `false` : déduction seule (schéma sans la migration 1610, simulation).
   */
  persisted?: boolean;
}

function caseOf(a: string, kind: SqlKind, pick: (r: { reason: CostReason; origin: CostOrigin }) => string): string {
  const whens = COST_RULES
    .map((r) => ({ r, p: r.sql(a, kind) }))
    .filter((x): x is { r: CostRule; p: string } => x.p !== null)
    .map(({ r, p }) => `WHEN ${p} THEN ${lit(pick(r))}`);
  return `(CASE ${whens.join(' ')} ELSE ${lit(pick(DEFAULT_RULE))} END)`;
}

/** Origine EFFECTIVE d'une ligne (persistée, sinon déduite par la même règle). */
export function costOriginSql(a: string, o: SqlOptions = {}): string {
  const derived = caseOf(a, o.kind ?? 'event', (r) => r.origin);
  return o.persisted === false ? derived : `COALESCE(${a}.cost_origin, ${derived})`;
}

/** Raison EFFECTIVE d'une ligne (persistée, sinon déduite). */
export function costReasonSql(a: string, o: SqlOptions = {}): string {
  const derived = caseOf(a, o.kind ?? 'event', (r) => r.reason);
  return o.persisted === false ? derived : `COALESCE(${a}.cost_class->>'reason', ${derived})`;
}

/** Prédicat SQL : le coût de la ligne est MÉTIER (service du compte, imputable). */
export function businessCostSql(a: string, o: SqlOptions = {}): string {
  return `(${costOriginSql(a, o)} = 'ACCOUNT_SERVICE')`;
}

/**
 * Origine d'une ligne quand ni la migration 1610 ni la règle ne sont
 * utilisables (lecture historique dégradée) : l'ancien booléen, signalé.
 */
export function legacyCostOriginSql(a: string): string {
  return `(CASE WHEN ${a}.is_billable THEN 'ACCOUNT_SERVICE' ELSE 'TECHNICAL' END)`;
}

// ── Libellés BO (textes nouveaux, à valider par le PO) ─────────────────────

export const COST_ORIGIN_LABELS: Readonly<Record<CostOrigin, string>> = {
  ACCOUNT_SERVICE: 'Métier (service du compte)',
  TECHNICAL: 'Technique et essais',
  SHADOW: 'Observation (mode shadow)',
  UNDETERMINED: 'Origine non déterminable (historique)',
};

export const COST_REASON_LABELS: Readonly<Record<CostReason, string>> = {
  SHADOW: 'Mode observation : résultat non appliqué',
  NO_ACCOUNT: 'Appel sans compte (sonde, tâche système)',
  AI_GOVERNANCE: 'Usage technique Gouvernance IA (sondes, tests, évaluations)',
  TECHNICAL_OPERATION: 'Sonde, test fournisseur ou évaluation d’un prompt',
  TECHNICAL_TRIGGER: 'Campagne de qualification',
  IMPROVEMENT_ATTEMPT: 'Essai d’amélioration IA',
  TECHNICAL_ACCOUNT: 'Compte technique de qualification',
  COST_CAP_EXEMPT: 'Campagne de mesure exemptée du plafond',
  REGISTRY_OPERATION: 'Traitement exécuté pour le compte (y compris en tâche de fond)',
  LEGACY_BILLABLE: 'Historique : étape retirée, comptée comme métier à l’époque',
  NOT_CLASSIFIABLE: 'Historique sans élément fiable : non classable',
};

/** Explications affichées au BO › Coûts IA (textes nouveaux, à valider par le PO). */
export const COST_SEGMENT_HELP = {
  provider: 'Tous les appels réellement chiffrés auprès du fournisseur (métier, tâches de fond, essais, sondes, observation). '
    + 'Estimation d’après les jetons et le tarif figé à l’appel, régularisations comprises : ce n’est pas une facture rapprochée.',
  business: 'Appels nécessaires au service d’un compte, y compris en tâche de fond (T1 regroupement et analyse, T2 compréhension et réponse, '
    + 'T3, T4, T6), même quand l’étape ne compte pas dans le quota de l’offre. C’est cette dépense qui alimente les budgets et le plafond par compte.',
  technical: 'Sondes, campagnes de qualification, corpus technique, Gouvernance IA, tests fournisseur et mode observation : '
    + 'jamais imputés à un compte client, absents des budgets métier et des plafonds.',
  undetermined: 'Appels anciens dont l’origine ne peut pas être établie de façon fiable : comptés à part, jamais devinés.',
  unknown: 'Appels sans tarif applicable ou sans compteur de jetons : leur coût est inconnu (jamais compté zéro). Un total qui en contient est partiel.',
  quota: 'Le quota de documents des offres et les droits commerciaux sont une autre mesure : ils ne servent jamais d’indicateur du coût.',
} as const;
