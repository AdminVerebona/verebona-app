/**
 * Modèles ACTIFS devenus inutilisables — lot 35B, ticket « Catalogue IA
 * dynamique Google » (« Dépréciation / disparition automatique »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * NE JAMAIS REMPLACER UN MODÈLE ACTIF
 *
 * Quand un modèle employé par la configuration EFFECTIVE (principal ou
 * repli) disparaît du catalogue de la clé active, devient non opérationnel,
 * échoue à sa qualification ou est déclaré retiré :
 *   · rien n'est modifié dans la configuration (aucune bascule automatique,
 *     encore moins vers un nouveau modèle) ;
 *   · la passerelle continue d'appliquer la chaîne de repli si le principal
 *     échoue (comportement existant) ;
 *   · une ALERTE D'EXPLOITATION est levée (`ai_alerts`) — lot 49 (ticket
 *     11) : UNE par MODÈLE et fenêtre (jour), quel que soit le nombre de
 *     traitements et de rangs qui l'emploient ; `details.usages` les liste
 *     tous ; sévérité agrégée (critique si au moins un principal n'a aucun
 *     repli utilisable) ;
 *   · l'anomalie est rendue visible en tête de Configuration IA, REGROUPÉE
 *     par modèle (« 1 modèle actif indisponible — 5 usages impactés »), avec
 *     le diagnostic du dernier contrôle (message fournisseur nettoyé, date,
 *     source, statut ok | inconclusive | failed_confirmed).
 *
 * `detectActiveModelAnomalies` est PURE (chaînes et contexte injectés).
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { Treatment } from '../config/treatments';
import { evaluateModelForTreatment, type UnusableReason, type UsableModelsContext } from '../registry/usable-models';
import type { OperationalDiagnostic } from './model-operational.service';
import { PROBE_ERROR_KIND_LABELS } from './probe-classification';
import type { CoupleQualification } from '../gateway/fallback-policy';

export type ChainRank = 'primaryModel' | 'fallback1' | 'fallback2';

export interface ActiveChainEntry {
  treatment: Treatment;
  rank: ChainRank;
  model: string;
  /** `version` : version de configuration effective ; `code` : référentiel. */
  source: 'version' | 'code';
}

export interface ActiveModelAnomaly extends ActiveChainEntry {
  reasons: UnusableReason[];
  reasonText: string;
  /** Un repli utilisable existe-t-il plus bas dans la chaîne ? (Lot 87A : ET admissible comme secours, si l'état de qualification est connu.) */
  fallbackAvailable: boolean;
  /**
   * Lot 87A (P7, INV-10) — secours que la passerelle choisira pour cet usage
   * (même règle que `fallback-policy`) : qualifié, non testé (choix de
   * l'administrateur), ou aucun (exécutions suspendues sans écriture).
   * Absent : état de qualification non lu.
   */
  secours?: AnomalySecours;
}

/** Lot 87A — secours relié à une anomalie de modèle actif (INV-10). */
export interface AnomalySecours {
  model: string | null;
  decision: 'QUALIFIED' | 'MANUAL_UNTESTED' | 'NONE';
  label: string;
}

/** Lot 87A — état de qualification des couples de la configuration active, par usage. */
export interface SecoursContext {
  qualificationOf(treatment: Treatment, model: string): CoupleQualification;
  origin: 'manual' | 'auto' | null;
}

const SECOURS_LABELS: Readonly<Record<AnomalySecours['decision'], string>> = {
  QUALIFIED: 'secours qualifié',
  MANUAL_UNTESTED: 'secours non testé (choix de l’administrateur)',
  NONE: 'aucun secours admissible : exécutions suspendues sans écriture, reprise automatique au rétablissement',
};

/** Le modèle de rang inférieur serait-il admis comme secours (même règle que la passerelle) ? Pur. */
function secoursDecision(treatment: Treatment, model: string, secours: SecoursContext): 'QUALIFIED' | 'MANUAL_UNTESTED' | null {
  const q = secours.qualificationOf(treatment, model);
  if (q === 'ADMISSIBLE') return 'QUALIFIED';
  if (q === 'REFUSED' || secours.origin === 'auto') return null;
  return 'MANUAL_UNTESTED';
}

/**
 * Motifs qui traduisent une PERTE du modèle (et non une préférence de
 * sélection) : seuls ceux-là font une anomalie d'exploitation. « Déprécié »
 * sans date atteinte n'en est pas une (le modèle répond encore — signalé au
 * registre des modèles et par l'alerte de dépréciation existante) ; s'il
 * cesse de répondre, la sonde le rend NOT_OPERATIONAL.
 */
const PERTE: ReadonlySet<UnusableReason> = new Set<UnusableReason>([
  'NOT_LISTED', 'PROVIDER_UNAVAILABLE', 'NO_GENERATE_CONTENT', 'NOT_OPERATIONAL', 'NOT_QUALIFIED',
  'CAPABILITY_MISSING', 'RETIRED', 'FORBIDDEN', 'EXPERIMENTAL',
]);

export const RANK_LABELS: Readonly<Record<ChainRank, string>> = {
  primaryModel: 'principal', fallback1: 'repli 1', fallback2: 'repli 2',
};

/** Anomalies des chaînes actives (pure). Lot 87A : `secours` relie chaque anomalie au secours admissible (INV-10). */
export function detectActiveModelAnomalies(chains: readonly ActiveChainEntry[], ctx: UsableModelsContext, secours?: SecoursContext): ActiveModelAnomaly[] {
  const out: ActiveModelAnomaly[] = [];
  const ordre: ChainRank[] = ['primaryModel', 'fallback1', 'fallback2'];
  for (const c of chains) {
    const e = evaluateModelForTreatment(c.treatment, c.model, ctx);
    const pertes = e.reasons.filter((r) => PERTE.has(r));
    if (pertes.length === 0) continue;
    const suivants = chains.filter((x) => x.treatment === c.treatment && ordre.indexOf(x.rank) > ordre.indexOf(c.rank));
    const utilisables = suivants.filter((x) => evaluateModelForTreatment(x.treatment, x.model, ctx).usable);
    if (!secours) {
      out.push({ ...c, reasons: e.reasons, reasonText: e.reasonText, fallbackAvailable: utilisables.length > 0 });
      continue;
    }
    const choisi = utilisables.map((x) => ({ x, d: secoursDecision(x.treatment, x.model, secours) })).find((y) => y.d !== null) ?? null;
    const decision = choisi?.d ?? 'NONE';
    out.push({
      ...c, reasons: e.reasons, reasonText: e.reasonText, fallbackAvailable: choisi !== null,
      secours: { model: choisi?.x.model ?? null, decision, label: SECOURS_LABELS[decision] },
    });
  }
  return out;
}

/** Chaînes de la configuration EFFECTIVE (version active, sinon référentiel). Lecture seule. */
export async function loadActiveChains(): Promise<ActiveChainEntry[]> {
  const [{ TREATMENTS, TREATMENT_DEFINITIONS }, { resolveTreatmentConfig }, { listOperationsByUseCase }] = await Promise.all([
    import('../config/treatments'),
    import('../config/config-resolver'),
    import('../registry/operations'),
  ]);
  const out: ActiveChainEntry[] = [];
  for (const t of TREATMENTS) {
    const entry = await resolveTreatmentConfig(t).catch(() => null);
    if (entry?.primaryModel) {
      for (const rank of ['primaryModel', 'fallback1', 'fallback2'] as const) {
        const model = entry[rank];
        if (model) out.push({ treatment: t, rank, model, source: 'version' });
      }
      continue;
    }
    const op = listOperationsByUseCase(TREATMENT_DEFINITIONS[t].useCaseCode).find((o) => o.provider !== 'none' && o.active);
    if (!op) continue;
    const chaine = [op.primaryModel, ...op.fallbackModels].slice(0, 3);
    chaine.forEach((model, i) => {
      if (model) out.push({ treatment: t, rank: (['primaryModel', 'fallback1', 'fallback2'] as const)[i], model, source: 'code' });
    });
  }
  return out;
}

/** Message d'exploitation d'une anomalie (alerte et BO). */
export function anomalyMessage(a: ActiveModelAnomaly): string {
  return `${a.treatment} : le modèle ${RANK_LABELS[a.rank]} « ${a.model} » n’est plus utilisable (${a.reasonText}). `
    + (a.rank === 'primaryModel'
      ? (a.secours ? `${secoursText(a.secours)} `
        : a.fallbackAvailable ? 'La chaîne de repli prend le relais. ' : 'Aucun repli utilisable : le traitement risque d’échouer. ')
      : '')
    + 'Aucun remplacement automatique : choisissez un autre modèle dans une nouvelle version de configuration.';
}

/** Lot 87A — phrase d'exploitation du secours relié (INV-10). */
export function secoursText(s: AnomalySecours): string {
  if (s.decision === 'QUALIFIED') return `Le secours qualifié « ${s.model} » prend le relais.`;
  if (s.decision === 'MANUAL_UNTESTED') return `Le secours « ${s.model} » prend le relais (non testé, choix de l’administrateur).`;
  return 'Aucun secours admissible : les exécutions sont suspendues sans écriture et reprises automatiquement au rétablissement.';
}

// ── Regroupement par modèle (lot 49, ticket 11) ─────────────────────────────

/** Un usage (traitement × rang) d'un modèle indisponible. */
export interface ModelUsage {
  treatment: Treatment;
  rank: ChainRank;
  rankLabel: string;
  source: 'version' | 'code';
  fallbackAvailable: boolean;
  /** Lot 87A : secours relié (INV-10), si l'état de qualification est connu. */
  secours?: AnomalySecours;
}

/** Diagnostic du dernier contrôle du modèle, tel qu'affiché au BO (sans secret). */
export interface ModelDiagnosticView {
  /** ok | inconclusive | suspect | failed_confirmed ; `unknown` : jamais contrôlé avec la clé active. */
  status: OperationalDiagnostic['checkStatus'] | 'unknown';
  /** État retenu : `true` sain, `false` indisponible confirmé, `null` inconnu. */
  operational: boolean | null;
  error: string | null;
  errorKind: string | null;
  errorKindLabel: string | null;
  checkedAt: string | null;
  source: string | null;
  sourceLabel: string | null;
}

/** Un modèle actif indisponible, avec TOUS ses usages (BO, alerte). */
export interface UnavailableModelGroup {
  model: string;
  usages: ModelUsage[];
  reasons: UnusableReason[];
  reasonText: string;
  /** Critique si au moins un principal n'a aucun repli utilisable. */
  severity: 'critical' | 'warning';
  diagnostic: ModelDiagnosticView;
}

const SOURCE_LABELS: Readonly<Record<string, string>> = {
  provider_test: 'test de la clé fournisseur',
  catalog_refresh: 'actualisation du catalogue (sonde)',
  qualification: 'qualification technique',
};

/** Vue BO d'un diagnostic (pure). */
export function diagnosticView(d: OperationalDiagnostic | undefined | null): ModelDiagnosticView {
  if (!d) {
    return { status: 'unknown', operational: null, error: null, errorKind: null, errorKindLabel: null, checkedAt: null, source: null, sourceLabel: null };
  }
  return {
    status: d.checkStatus, operational: d.ok, error: d.error, errorKind: d.errorKind,
    errorKindLabel: d.errorKind ? PROBE_ERROR_KIND_LABELS[d.errorKind] ?? d.errorKind : null,
    checkedAt: d.checkedAt, source: d.source, sourceLabel: SOURCE_LABELS[d.source] ?? d.source,
  };
}

/**
 * Regroupe les anomalies PAR MODÈLE (pure) : un modèle employé à cinq
 * endroits est UN modèle indisponible avec cinq usages impactés. Ordre :
 * critiques d'abord, puis identifiant.
 */
export function groupAnomaliesByModel(
  anomalies: readonly ActiveModelAnomaly[],
  diagnostics: ReadonlyMap<string, OperationalDiagnostic> = new Map(),
): UnavailableModelGroup[] {
  const parModele = new Map<string, ActiveModelAnomaly[]>();
  for (const a of anomalies) parModele.set(a.model, [...(parModele.get(a.model) ?? []), a]);
  return [...parModele.entries()].map(([model, liste]): UnavailableModelGroup => {
    const reasons = [...new Set(liste.flatMap((a) => a.reasons))];
    return {
      model,
      usages: liste.map((a) => ({
        treatment: a.treatment, rank: a.rank, rankLabel: RANK_LABELS[a.rank], source: a.source, fallbackAvailable: a.fallbackAvailable,
        ...(a.secours ? { secours: a.secours } : {}),
      })),
      reasons,
      reasonText: [...new Set(liste.map((a) => a.reasonText))].join(' ; '),
      severity: liste.some((a) => a.rank === 'primaryModel' && !a.fallbackAvailable) ? 'critical' : 'warning',
      diagnostic: diagnosticView(diagnostics.get(model)),
    };
  }).sort((a, b) => Number(b.severity === 'critical') - Number(a.severity === 'critical') || a.model.localeCompare(b.model));
}

const pluriel = (n: number, un: string, plusieurs: string) => `${n} ${n > 1 ? plusieurs : un}`;

/** Titre du bandeau : modèles DISTINCTS et occurrences comptés séparément. */
export function unavailableBannerTitle(groups: readonly UnavailableModelGroup[]): string | null {
  if (groups.length === 0) return null;
  const usages = groups.reduce((n, g) => n + g.usages.length, 0);
  return `${pluriel(groups.length, 'modèle actif indisponible', 'modèles actifs indisponibles')} — ${pluriel(usages, 'usage impacté', 'usages impactés')}`;
}

/** Libellé d'un usage : « T1 principal ». */
export function usageLabel(u: Pick<ModelUsage, 'treatment' | 'rank'>): string {
  return `${u.treatment} ${RANK_LABELS[u.rank]}`;
}

/** Message d'exploitation d'un modèle (alerte), tous usages compris. */
export function groupMessage(g: UnavailableModelGroup): string {
  const sansRepli = g.usages.filter((u) => u.rank === 'primaryModel' && !u.fallbackAvailable).map((u) => u.treatment);
  const relies = g.usages.filter((u) => u.rank === 'primaryModel' && u.secours);
  return `Le modèle « ${g.model} » n’est plus utilisable (${g.reasonText}) — `
    + `${pluriel(g.usages.length, 'usage impacté', 'usages impactés')} : ${g.usages.map(usageLabel).join(', ')}. `
    + (relies.length
      // Lot 87A (INV-10) : secours réellement choisis par la passerelle.
      ? `${relies.map((u) => `${u.treatment} — ${secoursText(u.secours!)}`).join(' ')} `
      : sansRepli.length
        ? `Aucun repli utilisable pour ${sansRepli.join(', ')} : le traitement risque d’échouer. `
        : 'Les chaînes de repli prennent le relais. ')
    + 'Aucun remplacement automatique : choisissez un autre modèle dans une nouvelle version de configuration.';
}

type RaiseFn = (a: import('../alerts/alerts.repository').AlertInput) => Promise<boolean>;

/**
 * Lève l'alerte d'exploitation (`ai_alerts`) : UNE par modèle et fenêtre
 * (jour), quel que soit le nombre d'usages ; `details.usages` les porte
 * tous (traitement, rang, source, fallbackAvailable). Sévérité agrégée.
 */
export async function raiseActiveModelAlerts(
  anomalies: readonly ActiveModelAnomaly[],
  now: Date = new Date(),
  raise?: RaiseFn,
  diagnostics?: ReadonlyMap<string, OperationalDiagnostic>,
): Promise<number> {
  if (anomalies.length === 0) return 0;
  const lever: RaiseFn = raise ?? (await import('../alerts/alerts.repository')).raiseAlert;
  let n = 0;
  for (const g of groupAnomaliesByModel(anomalies, diagnostics)) {
    const ok = await lever({
      kind: 'anomaly',
      code: 'ai_active_model_unavailable',
      treatment: null,
      severity: g.severity,
      message: groupMessage(g),
      details: {
        model: g.model,
        reasons: g.reasons,
        usages: g.usages.map((u) => ({ treatment: u.treatment, rank: u.rank, source: u.source, fallbackAvailable: u.fallbackAvailable, ...(u.secours ? { secours: u.secours } : {}) })),
        diagnostic: { status: g.diagnostic.status, error: g.diagnostic.error, checkedAt: g.diagnostic.checkedAt, source: g.diagnostic.source },
      },
      drilldownHref: '/admin/ai-config',
      dedupeKey: `ai:active-model:${g.model}:${now.toISOString().slice(0, 10)}`,
    }).catch(() => false);
    if (ok) n++;
  }
  return n;
}

/**
 * Lot 87A (P7, INV-10) — état de qualification des couples de la
 * configuration ACTIVE, par usage (traitement × modèle) : refusé si un couple
 * de l'usage est refusé, qualifié si tous sont admissibles, sinon l'état du
 * premier. `undefined` : lecture impossible (aucune base en test unitaire,
 * table absente) — l'anomalie garde alors le libellé historique.
 */
export async function loadSecoursContext(): Promise<SecoursContext | undefined> {
  if (process.env.NODE_ENV === 'test') return undefined;
  try {
    const [{ getActiveVersion }, { couplesWithState, defaultMasterReader }] = await Promise.all([
      import('../config/config-version.repository'), import('../qualification/context'),
    ]);
    const active = await getActiveVersion();
    if (!active) return undefined;
    const couples = await couplesWithState(active, { readMasterFile: await defaultMasterReader() });
    const par = new Map<string, CoupleQualification[]>();
    for (const c of couples) par.set(`${c.treatment}|${c.model}`, [...(par.get(`${c.treatment}|${c.model}`) ?? []), c.state.state]);
    return {
      origin: active.origin ?? 'manual',
      qualificationOf: (treatment, model) => {
        const etats = par.get(`${treatment}|${model}`) ?? [];
        if (etats.length === 0) return 'UNKNOWN';
        if (etats.includes('REFUSED')) return 'REFUSED';
        if (etats.every((x) => x === 'ADMISSIBLE')) return 'ADMISSIBLE';
        return etats.find((x) => x !== 'ADMISSIBLE') ?? 'UNKNOWN';
      },
    };
  } catch {
    return undefined;
  }
}
