/**
 * Lot 113I — POLITIQUE ADMINISTRÉE DE L'AMÉLIORATION AUTOMATIQUE (CDC V2 §13,
 * §16.2 BO-05, §36 ; DEC-08, EVA-006, INV-12, BUD-01).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * Paramètres de l'amélioration automatique en PRÉPRODUCTION, en un seul
 * endroit, versionnés (`ai_improvement_policy_revisions` : révision, auteur,
 * date, motif, empreinte ; append-only). Seul un administrateur les modifie
 * (route BO, authentification serveur) : le moteur ne possède AUCUNE fonction
 * d'écriture (`savePolicy` exige un auteur humain).
 *
 * Décisions acquises (valeurs de départ, §36.1) : budget 100 € / mois dont
 * 80 € d'expérimentations et 20 € de surveillance, alertes 50 € / 75 €,
 * 3 variantes au plus par objectif, ordre qualité > coût > latence.
 *
 * « À DÉFINIR PAR ADMINISTRATEUR » (§36.2) : JAMAIS inventés. Tant qu'ils sont
 * absents, la fonction qui en dépend est refusée avec un code stable :
 *   · taux USD→EUR, source, date, marge → aucun appel payant (FX_UNAVAILABLE) ;
 *   · marge de sécurité de la borne de coût → aucun appel (COST_UNKNOWN) ;
 *   · jetons maximum par pièce jointe → cas multimodaux non financés ;
 *   · hausse de coût admissible, plafond de latence par traitement →
 *     POLICY_NOT_CONFIGURED pour les promotions qui en dépendent ;
 *   · seuil de gain sémantique, juges → aucune promotion « gain de qualité ».
 * La politique n'est PAS exportée vers la production (PRD-04 : table hors du
 * fichier global de configuration).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'node:crypto';
import { TREATMENTS, type Treatment } from '../config/treatments';
import { getAiEnvironment } from '../config/environment';

export interface TreatmentEconomics {
  /** Hausse ABSOLUE admissible du coût moyen par appel (micro-USD, unité de la grille) ; null = À DÉFINIR. */
  maxExtraCostMicrosPerCall: number | null;
  /** Plafond de latence P95 du traitement (ms) ; null = À DÉFINIR. */
  maxP95Ms: number | null;
}

export interface VerifiedStableModel {
  model: string;
  /** Version effective attestée (identifiant immuable) ; null = l'identifiant demandé EST la version. */
  version: string | null;
  /** Source officielle consultée (URL ou référence). */
  source: string;
  verifiedAt: string;
}

export interface ImprovementPolicy {
  /** Numéro de révision (0 = valeurs de départ, aucune révision enregistrée). */
  version: number;
  sha256: string;
  updatedAt: string | null;
  updatedBy: number | null;
  budget: { monthlyEur: number; experimentEur: number; monitorEur: number; infoAlertEur: number; vigilanceAlertEur: number };
  fx: { usdToEur: number | null; source: string | null; date: string | null; marginRatio: number | null };
  costBound: { safetyMultiplier: number | null; attachmentMaxTokens: number | null };
  variants: { maxPerObjective: number };
  economics: Partial<Record<Treatment, TreatmentEconomics>>;
  usage: { minCallsValidated: number };
  verifiedStableModels: VerifiedStableModel[];
  /** Juges sémantiques (QUA-05..08) : non livrés — toujours `null` tant qu'un administrateur ne les a pas configurés. */
  judges: { primary: null; secondary: null };
  /** Seuil de gain sémantique significatif : À DÉFINIR. */
  semanticGainThreshold: number | null;
}

export const POLICY_DEFAULTS: Omit<ImprovementPolicy, 'version' | 'sha256' | 'updatedAt' | 'updatedBy'> = Object.freeze({
  budget: { monthlyEur: 100, experimentEur: 80, monitorEur: 20, infoAlertEur: 50, vigilanceAlertEur: 75 },
  fx: { usdToEur: null, source: null, date: null, marginRatio: null },
  costBound: { safetyMultiplier: null, attachmentMaxTokens: null },
  variants: { maxPerObjective: 3 },
  economics: {},
  usage: { minCallsValidated: 20 },
  verifiedStableModels: [],
  judges: { primary: null, secondary: null },
  semanticGainThreshold: null,
}) as Omit<ImprovementPolicy, 'version' | 'sha256' | 'updatedAt' | 'updatedBy'>;

/** Suggestions AFFICHÉES au BO pour les paramètres à définir (jamais appliquées sans enregistrement). */
export const POLICY_SUGGESTIONS = Object.freeze({ fxMarginRatio: 0.1, safetyMultiplier: 1.5 });

/** Bornes de saisie (refus au-delà ; aucune valeur hors bornes acceptée silencieusement). */
export const POLICY_BOUNDS = Object.freeze({
  eur: [0, 10_000] as const,
  usdToEur: [0.01, 10] as const,
  marginRatio: [0, 1] as const,
  safetyMultiplier: [1, 10] as const,
  attachmentMaxTokens: [1, 2_000_000] as const,
  maxPerObjective: [1, 3] as const,
  maxExtraCostMicrosPerCall: [0, 100_000_000] as const,
  maxP95Ms: [100, 3_600_000] as const,
  minCallsValidated: [5, 10_000] as const,
});

export class PolicyRefused extends Error {
  constructor(readonly code: 'POLICY_INVALID' | 'POLICY_CONFLICT' | 'POLICY_ACTOR_REQUIRED', message: string) { super(message); this.name = 'PolicyRefused'; }
}

type Row = Record<string, unknown>;
type Body = Omit<ImprovementPolicy, 'version' | 'sha256' | 'updatedAt' | 'updatedBy'>;

function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}

export function policySha256(b: Body): string {
  return createHash('sha256').update(canonical(b), 'utf8').digest('hex');
}

const numIn = (v: unknown, [min, max]: readonly [number, number], label: string, nullable: boolean): number | null => {
  if (v == null || v === '') {
    if (nullable) return null;
    throw new PolicyRefused('POLICY_INVALID', `${label} : valeur obligatoire.`);
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new PolicyRefused('POLICY_INVALID', `${label} : valeur de ${min} à ${max} attendue.`);
  return n;
};

/** Normalise et VALIDE une politique (saisie BO ou base). Lève `PolicyRefused` si invalide. */
export function normalizePolicy(raw: unknown): Body {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const d = POLICY_DEFAULTS;
  const b = o.budget ?? {};
  const budget = {
    monthlyEur: numIn(b.monthlyEur ?? d.budget.monthlyEur, POLICY_BOUNDS.eur, 'Budget mensuel', false)!,
    experimentEur: numIn(b.experimentEur ?? d.budget.experimentEur, POLICY_BOUNDS.eur, 'Sous-budget expérimentation', false)!,
    monitorEur: numIn(b.monitorEur ?? d.budget.monitorEur, POLICY_BOUNDS.eur, 'Sous-budget surveillance', false)!,
    infoAlertEur: numIn(b.infoAlertEur ?? d.budget.infoAlertEur, POLICY_BOUNDS.eur, 'Alerte d’information', false)!,
    vigilanceAlertEur: numIn(b.vigilanceAlertEur ?? d.budget.vigilanceAlertEur, POLICY_BOUNDS.eur, 'Alerte de vigilance', false)!,
  };
  if (budget.experimentEur + budget.monitorEur > budget.monthlyEur + 1e-9) {
    throw new PolicyRefused('POLICY_INVALID', `Expérimentation (${budget.experimentEur} €) + surveillance (${budget.monitorEur} €) dépassent le budget mensuel (${budget.monthlyEur} €).`);
  }
  const f = o.fx ?? {};
  const fx = {
    usdToEur: numIn(f.usdToEur, POLICY_BOUNDS.usdToEur, 'Taux USD → EUR', true),
    source: typeof f.source === 'string' && f.source.trim() ? f.source.trim().slice(0, 300) : null,
    date: typeof f.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(f.date) ? f.date : null,
    marginRatio: numIn(f.marginRatio, POLICY_BOUNDS.marginRatio, 'Marge de prudence du taux', true),
  };
  if (fx.usdToEur != null && (!fx.source || !fx.date)) {
    throw new PolicyRefused('POLICY_INVALID', 'Taux USD → EUR : la source et la date du taux sont obligatoires (BUD-06).');
  }
  const c = o.costBound ?? {};
  const costBound = {
    safetyMultiplier: numIn(c.safetyMultiplier, POLICY_BOUNDS.safetyMultiplier, 'Marge de sécurité de la borne de coût', true),
    attachmentMaxTokens: numIn(c.attachmentMaxTokens, POLICY_BOUNDS.attachmentMaxTokens, 'Jetons maximum par pièce jointe', true),
  };
  const variants = { maxPerObjective: numIn(o.variants?.maxPerObjective ?? d.variants.maxPerObjective, POLICY_BOUNDS.maxPerObjective, 'Variantes par objectif', false)! };
  const economics: Partial<Record<Treatment, TreatmentEconomics>> = {};
  for (const t of TREATMENTS) {
    const e = o.economics?.[t];
    if (!e) continue;
    economics[t] = {
      maxExtraCostMicrosPerCall: numIn(e.maxExtraCostMicrosPerCall, POLICY_BOUNDS.maxExtraCostMicrosPerCall, `${t} · hausse de coût admissible`, true),
      maxP95Ms: numIn(e.maxP95Ms, POLICY_BOUNDS.maxP95Ms, `${t} · plafond de latence P95`, true),
    };
  }
  const usage = { minCallsValidated: numIn(o.usage?.minCallsValidated ?? d.usage.minCallsValidated, POLICY_BOUNDS.minCallsValidated, 'Appels minimum pour « validée en usage »', false)! };
  const verifiedStableModels = (Array.isArray(o.verifiedStableModels) ? o.verifiedStableModels : []).map((m: any) => {
    if (!m || typeof m.model !== 'string' || !m.model.trim() || typeof m.source !== 'string' || !m.source.trim()) {
      throw new PolicyRefused('POLICY_INVALID', 'Modèle stable attesté : identifiant et source officielle obligatoires (C-004).');
    }
    return {
      model: m.model.trim().slice(0, 200), version: typeof m.version === 'string' && m.version.trim() ? m.version.trim().slice(0, 200) : null,
      source: m.source.trim().slice(0, 500), verifiedAt: typeof m.verifiedAt === 'string' && /^\d{4}-\d{2}-\d{2}/.test(m.verifiedAt) ? m.verifiedAt.slice(0, 10) : new Date().toISOString().slice(0, 10),
    };
  });
  return {
    budget, fx, costBound, variants, economics, usage, verifiedStableModels,
    // Non administrables tant que les juges ne sont pas livrés : jamais lus depuis la saisie (aucun faux réglage, UI-003).
    judges: { primary: null, secondary: null },
    semanticGainThreshold: null,
  };
}

function withMeta(body: Body, meta: { version: number; updatedAt: string | null; updatedBy: number | null }): ImprovementPolicy {
  return { ...body, ...meta, sha256: policySha256(body) };
}

export function defaultPolicy(): ImprovementPolicy {
  return withMeta(normalizePolicy(POLICY_DEFAULTS), { version: 0, updatedAt: null, updatedBy: null });
}

type Query = (text: string, params?: unknown[]) => Promise<Row[]>;
const dbQuery: Query = async (text, params = []) => {
  const { pgClient } = await import('@/db');
  return (await pgClient.unsafe(text, params as never[])) as unknown as Row[];
};

/** Politique effective (dernière révision de l'environnement ; aucune → valeurs de départ). Table absente → départ. */
export async function loadPolicy(environment: string = getAiEnvironment(), query: Query = dbQuery): Promise<ImprovementPolicy> {
  try {
    const [r] = await query(
      `SELECT revision, policy, created_at, created_by FROM ai_improvement_policy_revisions WHERE environment = $1 ORDER BY revision DESC LIMIT 1`, [environment]);
    if (!r) return defaultPolicy();
    return withMeta(normalizePolicy(r.policy), { version: Number(r.revision), updatedAt: new Date(String(r.created_at)).toISOString(), updatedBy: r.created_by == null ? null : Number(r.created_by) });
  } catch (e) {
    if (['42P01', '42703'].includes(String((e as { code?: string })?.code))) return defaultPolicy();
    throw e;
  }
}

/** Historique (BO). */
export async function policyHistory(environment: string = getAiEnvironment(), limit = 20): Promise<Array<{ revision: number; sha256: string; createdAt: string; createdBy: number | null; reason: string }>> {
  try {
    return (await dbQuery(`SELECT revision, sha256, created_at, created_by, reason FROM ai_improvement_policy_revisions WHERE environment = $1 ORDER BY revision DESC LIMIT $2`, [environment, limit]))
      .map((r) => ({ revision: Number(r.revision), sha256: String(r.sha256), createdAt: new Date(String(r.created_at)).toISOString(), createdBy: r.created_by == null ? null : Number(r.created_by), reason: String(r.reason ?? '') }));
  } catch { return []; }
}

/**
 * Enregistre une nouvelle révision (administrateur SEULEMENT). Conflit de révision : refus (APIX-001). Sans
 * changement effectif : rien n'est écrit. Rend la politique effective et les impacts (preuves rendues obsolètes).
 */
export async function savePolicy(p: { input: unknown; expectedVersion: number; userId: number; reason: string; environment?: string }): Promise<{ policy: ImprovementPolicy; changed: boolean; impacts: string[] }> {
  if (!Number.isInteger(p.userId) || p.userId <= 0) throw new PolicyRefused('POLICY_ACTOR_REQUIRED', 'Seul un administrateur authentifié modifie la politique d’amélioration (le moteur n’a aucun droit d’écriture).');
  if (!p.reason || p.reason.trim().length < 3) throw new PolicyRefused('POLICY_INVALID', 'Motif de la modification obligatoire (audit).');
  const environment = p.environment ?? getAiEnvironment();
  const body = normalizePolicy(p.input);
  const { pgClient } = await import('@/db');
  return pgClient.begin(async (tx) => {
    const q = async (t: string, params: unknown[] = []) => (await tx.unsafe(t, params as never[])) as unknown as Row[];
    await q(`SELECT pg_advisory_xact_lock(hashtext('ai_improvement_policy:' || $1))`, [environment]);
    const [cur] = await q(`SELECT revision, policy FROM ai_improvement_policy_revisions WHERE environment = $1 ORDER BY revision DESC LIMIT 1`, [environment]);
    const curVersion = cur ? Number(cur.revision) : 0;
    if (curVersion !== p.expectedVersion) {
      throw new PolicyRefused('POLICY_CONFLICT', `Conflit de révision : la politique a été modifiée entre-temps (révision ${curVersion}, vous éditiez la révision ${p.expectedVersion}). Rechargez la page.`);
    }
    const before = cur ? normalizePolicy(cur.policy) : normalizePolicy(POLICY_DEFAULTS);
    const sha = policySha256(body);
    if (cur && policySha256(before) === sha) {
      return { policy: withMeta(body, { version: curVersion, updatedAt: null, updatedBy: p.userId }), changed: false, impacts: [] };
    }
    const [ins] = await q(
      `INSERT INTO ai_improvement_policy_revisions (environment, revision, policy, sha256, created_by, reason)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6) RETURNING created_at`,
      [environment, curVersion + 1, JSON.stringify(body), sha, p.userId, p.reason.trim().slice(0, 1000)]);
    return {
      policy: withMeta(body, { version: curVersion + 1, updatedAt: new Date(String(ins.created_at)).toISOString(), updatedBy: p.userId }),
      changed: true, impacts: policyImpacts(before, body),
    };
  }) as Promise<{ policy: ImprovementPolicy; changed: boolean; impacts: string[] }>;
}

/** Conséquences lisibles d'un changement (UI-003) : les preuves et décisions futures concernées, jamais un retest global. */
export function policyImpacts(a: Body, b: Body): string[] {
  const out: string[] = [];
  if (canonical(a.budget) !== canonical(b.budget)) out.push('Budget : s’applique aux prochaines réservations ; les engagements existants conservent leur mois et leur montant.');
  if (canonical(a.fx) !== canonical(b.fx) || canonical(a.costBound) !== canonical(b.costBound)) out.push('Borne de coût : s’applique aux prochains appels ; aucun coût passé n’est recalculé.');
  if (a.variants.maxPerObjective !== b.variants.maxPerObjective) out.push('Variantes par objectif : s’applique aux objectifs ouverts pour leurs prochaines variantes.');
  if (canonical(a.economics) !== canonical(b.economics)) out.push('Bornes économiques / latence : les décisions de promotion FUTURES utilisent les nouvelles bornes ; aucune requalification rétroactive.');
  if (canonical(a.verifiedStableModels) !== canonical(b.verifiedStableModels)) out.push('Modèles stables attestés : conditionnent les prochaines promotions de modèle.');
  if (a.usage.minCallsValidated !== b.usage.minCallsValidated) out.push('Volume « validée en usage » : s’applique aux prochains contrôles de surveillance.');
  return out;
}

/**
 * C-004 / MOD-03 / MOD-04 : stabilité OFFICIELLE prouvée — statut structuré du fournisseur ou attestation
 * administrative. Une stabilité déduite de l'absence de « preview » dans le nom n'est PAS une preuve.
 */
export function stabilityProof(model: string, catalog: { lifecycle: string | null; basis: 'structured' | 'name_rule' | null } | null, policy: ImprovementPolicy):
  { verified: boolean; status: 'STABLE_STRUCTURED' | 'STABLE_ATTESTED' | 'UNVERIFIED' | 'NOT_STABLE'; detail: string } {
  if (catalog && catalog.lifecycle && catalog.lifecycle !== 'stable') return { verified: false, status: 'NOT_STABLE', detail: `${model} : statut fournisseur « ${catalog.lifecycle} »` };
  if (catalog?.lifecycle === 'stable' && catalog.basis === 'structured') return { verified: true, status: 'STABLE_STRUCTURED', detail: `${model} : statut stable fourni par l’API du fournisseur` };
  const a = policy.verifiedStableModels.find((m) => m.model === model);
  if (a) return { verified: true, status: 'STABLE_ATTESTED', detail: `${model} : stabilité attestée par un administrateur (${a.source}, ${a.verifiedAt})` };
  return { verified: false, status: 'UNVERIFIED', detail: `${model} : stabilité présumée (convention de nommage), non prouvée — promotion autonome interdite (C-004)` };
}
