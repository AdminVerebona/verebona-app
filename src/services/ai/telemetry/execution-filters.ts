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
const TREATMENTS = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6'];
const RANKS = ['primary', 'fallback_1', 'fallback_2', 'fallback'];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const INT = /^\d+$/;

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
  errorsOnly: boolean;
}

export const EMPTY_EXECUTION_FILTERS: ExecutionScreenFilters = {
  treatment: '', accountId: '', userId: '', model: '', rank: '', configVersionId: '',
  operationCode: '', jobId: '', from: '', to: '', minDurationMs: '', errorsOnly: false,
};

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
