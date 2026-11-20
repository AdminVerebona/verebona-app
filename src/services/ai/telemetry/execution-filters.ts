/**
 * Filtres d'écran lus depuis l'URL — CDC BO IA COST-009, CST-UI-10,
 * LOG-UI-01 à 03, QUE-UI-04, ALT-01 (liens préfiltrés).
 *
 * Aucune page `ai-*` ne lisait ses paramètres d'URL : les liens
 * `?errorsOnly=1` du tableau de bord, des alertes et des coûts ouvraient un
 * écran non filtré. Ces fonctions pures convertissent l'URL en filtres (et
 * retour) ; les pages les appliquent à l'ouverture et réécrivent l'URL à
 * chaque changement, pour qu'un écran filtré soit partageable.
 *
 * Tolérantes : un paramètre illisible est ignoré, jamais bloquant (un lien
 * ancien montre moins de filtres, il ne casse pas l'écran).
 */
import { historyScopeLabel, type HistoryClass } from '../history-reclassification/rule';

// Lot 49 : T5 retiré du filtre courant (un ancien lien `?treatment=T5` est
// ignoré). Les anciens appels T5 restent consultables par opération
// (`t5_analyze`, `t5_modify`) ou usage (AI_GOVERNANCE), en lecture seule.
const TREATMENTS = ['T1', 'T2', 'T3', 'T4', 'T6'];
const RANKS = ['primary', 'fallback_1', 'fallback_2', 'fallback'];
/**
 * CDC Mascotte BO-009 : génération T6 affichée, pré-génération non affichée,
 * texte de secours (appel en échec ou sortie rejetée).
 */
export const T6_MODES = ['displayed', 'pregeneration', 'fallback'] as const;
export type T6ModeFilter = (typeof T6_MODES)[number];
export const T6_MODE_LABELS: Record<T6ModeFilter, string> = {
  displayed: 'T6 : génération affichée',
  pregeneration: 'T6 : pré-génération',
  fallback: 'T6 : texte de secours',
};
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const INT = /^\d+$/;
const TOKEN = /^[A-Za-z0-9_.:-]{1,80}$/;

export interface ExecutionScreenFilters {
  treatment: string;
  accountId: string;
  userId: string;
  model: string;
  rank: string;
  configVersionId: string;
  operationCode: string;
  jobId: string;
  from: string;
  to: string;
  minDurationMs: string;
  /** LOG-UI-02 : statut, objet (type + id) et déclencheur. */
  status: string;
  objectType: string;
  objectId: string;
  trigger: string;
  /** BO-009 : mode de génération T6 (`displayed`, `pregeneration`, `fallback`). */
  t6Mode: string;
  errorsOnly: boolean;
}

type Params = { get(name: string): string | null };

export function readExecutionFilters(p: Params): ExecutionScreenFilters {
  const pick = (name: string, ok: (v: string) => boolean) => {
    const v = p.get(name) ?? '';
    return v && ok(v) ? v : '';
  };
  return {
    treatment: pick('treatment', (v) => TREATMENTS.includes(v)),
    accountId: pick('accountId', (v) => INT.test(v)),
    userId: pick('userId', (v) => INT.test(v)),
    model: pick('model', (v) => v.length <= 100),
    rank: pick('rank', (v) => RANKS.includes(v)),
    configVersionId: pick('configVersionId', (v) => INT.test(v)),
    operationCode: pick('operationCode', (v) => /^[a-z0-9_]{1,80}$/i.test(v)),
    jobId: pick('jobId', (v) => INT.test(v)),
    from: pick('from', (v) => DAY.test(v)),
    to: pick('to', (v) => DAY.test(v)),
    minDurationMs: pick('minDurationMs', (v) => INT.test(v)),
    status: pick('status', (v) => v === 'success' || v === 'error'),
    objectType: pick('objectType', (v) => TOKEN.test(v)),
    objectId: pick('objectId', (v) => TOKEN.test(v)),
    trigger: pick('trigger', (v) => TOKEN.test(v)),
    t6Mode: pick('t6Mode', (v) => (T6_MODES as readonly string[]).includes(v)),
    errorsOnly: p.get('errorsOnly') === '1',
  };
}

/** Filtres → paramètres d'URL (et d'API), sans les valeurs vides. */
export function executionFiltersToParams(f: ExecutionScreenFilters): URLSearchParams {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) {
    if (k === 'errorsOnly') { if (v) out.set('errorsOnly', '1'); continue; }
    if (typeof v === 'string' && v) out.set(k, v);
  }
  return out;
}

/** Filtres de la liste des appels tels que la route les applique (carte #802 : partagés avec l'export diagnostic). */
export interface ExecutionApiFilters {
  treatment?: 'T1' | 'T2' | 'T3' | 'T4' | 'T6';
  status?: 'success' | 'error';
  accountId?: number;
  model?: string;
  configVersionId?: number;
  operationCode?: string;
  errorsOnly?: boolean;
  since?: Date;
  until?: Date;
  minDurationMs?: number;
  userId?: number;
  rank?: 'primary' | 'fallback_1' | 'fallback_2' | 'fallback';
  jobId?: number;
  objectType?: string;
  objectId?: string;
  trigger?: string;
  t6Mode?: T6ModeFilter;
}

const entier = (v: string | null): number | undefined => (v && INT.test(v) ? Number(v) : undefined);
const instant = (v: string | null): Date | undefined => {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
};
const jeton = (v: string | null): string | undefined => (v && TOKEN.test(v) ? v : undefined);

/**
 * Carte #802 — paramètres d'URL → filtres de la liste des appels (pur).
 * Traduction UNIQUE, utilisée par `GET /api/admin/ai/executions` et par
 * l'export diagnostic lancé depuis l'onglet « Appels modèles » : mêmes bornes
 * (`from` à 00:00 UTC, `to` jusqu'à 23:59:59.999 UTC inclus), mêmes valeurs
 * acceptées. Tolérante (une valeur illisible est ignorée) : l'export, lui,
 * REFUSE en amont toute valeur que cette lecture écarterait
 * (`export-selection.ts`).
 */
export function executionApiFilters(p: Params): ExecutionApiFilters {
  const treatment = p.get('treatment');
  const status = p.get('status');
  const rank = p.get('rank');
  const t6 = p.get('t6Mode');
  const to = p.get('to');
  return {
    treatment: treatment && TREATMENTS.includes(treatment) ? treatment as ExecutionApiFilters['treatment'] : undefined,
    status: status === 'success' || status === 'error' ? status : undefined,
    accountId: entier(p.get('accountId')),
    model: p.get('model') ?? undefined,
    configVersionId: entier(p.get('configVersionId')),
    operationCode: p.get('operationCode') ?? undefined,
    errorsOnly: p.get('errorsOnly') === '1',
    // `from`/`to` (AAAA-MM-JJ) : forme des liens préfiltrés des alertes et
    // des coûts (COST-009) ; `to` couvre toute la journée.
    since: instant(p.get('since')) ?? instant(p.get('from')),
    until: instant(p.get('until')) ?? (to ? instant(DAY.test(to) ? `${to}T23:59:59.999Z` : to) : undefined),
    minDurationMs: entier(p.get('minDurationMs')),
    userId: entier(p.get('userId')),
    rank: rank && RANKS.includes(rank) ? rank as ExecutionApiFilters['rank'] : undefined,
    jobId: entier(p.get('jobId')),
    // LOG-UI-02 : objet et déclencheur.
    objectType: jeton(p.get('objectType')),
    objectId: jeton(p.get('objectId')),
    trigger: jeton(p.get('trigger')),
    // CDC Mascotte BO-009 : affichée / pré-génération / texte de secours.
    t6Mode: t6 && (T6_MODES as readonly string[]).includes(t6) ? t6 as T6ModeFilter : undefined,
  };
}

/** Période nommée (COST-002, CST-UI-01) → bornes AAAA-MM-JJ. */
export type CostPeriod = 'today' | 'week' | 'month30' | 'calendarMonth' | 'year' | 'custom';

export function periodBounds(period: CostPeriod, now: Date = new Date(), custom?: { from?: string; to?: string }): { from: string; to: string } {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const minus = (days: number) => new Date(now.getTime() - days * 86_400_000);
  switch (period) {
    case 'today': return { from: day(now), to: day(now) };
    case 'week': return { from: day(minus(6)), to: day(now) };
    case 'month30': return { from: day(minus(29)), to: day(now) };
    case 'calendarMonth': return { from: `${day(now).slice(0, 7)}-01`, to: day(now) };
    case 'year': return { from: day(minus(364)), to: day(now) };
    case 'custom': return {
      from: custom?.from && DAY.test(custom.from) ? custom.from : day(minus(29)),
      to: custom?.to && DAY.test(custom.to) ? custom.to : day(now),
    };
  }
}

/**
 * Lot 49 (ticket 12, T5-DEL-08) : libellé de la colonne « traitement » d'un
 * appel. L'usage technique AI_GOVERNANCE n'est rattaché à aucun traitement :
 *   · sondes de modèles, qualification, test fournisseur, évaluation de
 *     prompt → « Technique » (jamais « T5 ») ;
 *   · anciens appels `t5_analyze` / `t5_modify` → « T5 (retiré) » (lot 53,
 *     retour PO D24 : libellé « retiré » confirmé dans le BO),
 *     consultables en lecture seule, jamais confondus avec les sondes.
 */
export function executionScopeLabel(row: { treatment: string | null; useCaseCode?: string | null; operationCode?: string | null; history?: HistoryClass | null }): string {
  if (row.treatment) return row.treatment;
  if (row.operationCode && /^t5_(analyze|modify)$/.test(row.operationCode)) return 'T5 (retiré)';
  if (row.useCaseCode === 'AI_GOVERNANCE') return 'Technique';
  // Lot 89A (P8, MIG-03) : appel historique reclassé par la règle versionnée (preuve dans le détail).
  const reclasse = historyScopeLabel(row.history ?? null);
  if (reclasse) return reclasse;
  // Lot 84D (R23, R59, BO-11) : rattachement RÉELLEMENT absent (historique sans preuve) —
  // signalé comme tel, jamais inventé ; une sonde reste « Technique » ci-dessus.
  return 'Non rattaché (historique)';
}
