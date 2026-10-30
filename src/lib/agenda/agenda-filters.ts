/**
 * Filtres de « Mon agenda » — logique pure (lot 71, 71C).
 *
 * Les filtres PROPRES à l'agenda sont conservés tels quels : période (Tout,
 * À venir, Aujourd'hui, Passés), annulés affichés ou non, et les vues Liste /
 * Mensuel / Annuel (hors panneau, `AgendaViewControls`). Seule la
 * présentation change : panneau intégré et pastilles « Filtré par … »,
 * comme « Mes documents ». Aucune règle métier de l'agenda n'est modifiée.
 */

export type AgendaPeriod = 'all' | 'past' | 'today' | 'upcoming';

/**
 * Mêmes valeurs et même ordre que l'ancien tiroir de filtres. Lot 100E (A8) :
 * « Tous » (libellé de la décision PO) remplace « Tout ».
 */
export const AGENDA_PERIOD_OPTIONS: ReadonlyArray<{ value: AgendaPeriod; label: string }> = [
  { value: 'all', label: 'Tous' },
  { value: 'upcoming', label: 'À venir' },
  { value: 'today', label: "Aujourd'hui" },
  { value: 'past', label: 'Passés' },
];

/** Lecture défensive du paramètre d'URL : une valeur inconnue retombe sur « Tout ». */
export function parseAgendaPeriod(raw: string | null | undefined): AgendaPeriod {
  return AGENDA_PERIOD_OPTIONS.some((o) => o.value === raw) ? (raw as AgendaPeriod) : 'all';
}

/**
 * Pastilles « Filtré par … », dans l'ordre Période, Bien, Pièce,
 * Équipement, Statut. Clés : `period`, `bien:<id>`, `piece`, `equipment`,
 * `cancelled` (Pièce : lot 75B, même ordre que « Mes documents »).
 */
export function agendaFilterChips(input: {
  period: AgendaPeriod;
  assetIds: readonly number[];
  includeCancelled: boolean;
  assetOptions: ReadonlyArray<{ id: number; name: string }>;
  /** Libellé du filtre Équipement actif, `null` s'il n'agit pas. */
  equipmentChipLabel: string | null;
  /** Lot 75B : libellé du filtre Pièce actif, `null` (ou absent) s'il n'agit pas. */
  roomChipLabel?: string | null;
}): Array<{ key: string; label: string }> {
  const noms = new Map(input.assetOptions.map((a) => [a.id, a.name]));
  return [
    ...(input.period !== 'all'
      ? [{ key: 'period', label: AGENDA_PERIOD_OPTIONS.find((o) => o.value === input.period)?.label ?? input.period }]
      : []),
    ...input.assetIds.map((id) => ({ key: `bien:${id}`, label: noms.get(id) ?? 'Bien' })),
    ...(input.roomChipLabel ? [{ key: 'piece', label: input.roomChipLabel }] : []),
    ...(input.equipmentChipLabel ? [{ key: 'equipment', label: input.equipmentChipLabel }] : []),
    ...(input.includeCancelled ? [{ key: 'cancelled', label: 'Annulés affichés' }] : []),
  ];
}

// ══════════════════════════════════════════════════════════════════════════
// Lot 100E (décision PO A8 du 27/10/2026) — RECHERCHE ET PÉRIODE
//
// « Toute recherche sans critère temporel couvre les événements passés,
// futurs et sans date. » Choix retenus (pures, partagées par « Mon agenda »
// et l'onglet Agenda d'un bien, desktop et mobile) :
//   · LANCER une recherche alors qu'une période restreint la liste (« À
//     venir »…) : la période passe VISIBLEMENT à « Tous » (choix « Tous »
//     actif dans le panneau, ligne d'état sous le champ) ; la période
//     précédente est MÉMORISÉE (suspendue), avec un bouton pour la rétablir ;
//   · CHOISIR ensuite une période (panneau, pastille, bouton « rétablir ») :
//     choix explicite, conservé pendant la recherche (aucune remise à zéro
//     silencieuse), et la période suspendue est oubliée ;
//   · MODIFIER la recherche : rien ne change ;
//   · EFFACER la recherche : retour à la période d'avant la recherche si elle
//     avait été suspendue ; sinon la période en vigueur (choisie pendant la
//     recherche, ou « Tous ») est conservée — le dernier choix explicite de
//     l'utilisateur fait foi.
// ══════════════════════════════════════════════════════════════════════════

/** Paramètre d'URL de « Mon agenda » : période suspendue le temps d'une recherche. */
export const SUSPENDED_PERIOD_PARAM = 'periodeAvantRecherche';

/** Période active et période suspendue par la recherche (`null` : aucune). */
export interface AgendaSearchPeriod { period: AgendaPeriod; suspended: AgendaPeriod | null }

const libellePeriode = (p: AgendaPeriod) => AGENDA_PERIOD_OPTIONS.find((o) => o.value === p)?.label ?? p;

/** Recherche validée (avant → après) : nouvelle période (pure). */
export function periodOnSearchChange(state: AgendaSearchPeriod, before: string, after: string): AgendaSearchPeriod {
  const avant = before.trim();
  const apres = after.trim();
  if (!avant && apres) {
    // Lancement : une période restrictive est neutralisée, visiblement, et mémorisée.
    return state.period === 'all' ? { period: 'all', suspended: null } : { period: 'all', suspended: state.period };
  }
  if (avant && !apres) {
    // Effacement : retour à la période d'avant la recherche, si elle avait été suspendue.
    return state.suspended ? { period: state.suspended, suspended: null } : { period: state.period, suspended: null };
  }
  return state;
}

/** Choix EXPLICITE d'une période par l'utilisateur (pure) : appliqué et conservé, la suspension est oubliée. */
export function periodOnExplicitChoice(period: AgendaPeriod): AgendaSearchPeriod {
  return { period, suspended: null };
}

/**
 * Ligne d'état sous le champ de recherche (pure) — ce qui est réellement
 * cherché, jamais une restriction cachée. `null` sans recherche.
 */
export function searchPeriodNotice(q: string, s: AgendaSearchPeriod): { text: string; action: { label: string; period: AgendaPeriod } | null } | null {
  if (!q.trim()) return null;
  if (s.period === 'all') {
    return {
      text: s.suspended
        ? `Recherche sur toutes les dates (passées, à venir et sans date) : période « ${libellePeriode('all')} ». Le filtre « ${libellePeriode(s.suspended)} » est suspendu pendant la recherche.`
        : `Recherche sur toutes les dates (passées, à venir et sans date) : période « ${libellePeriode('all')} ».`,
      action: s.suspended ? { label: `Limiter à « ${libellePeriode(s.suspended)} »`, period: s.suspended } : null,
    };
  }
  return {
    text: `Recherche limitée à la période « ${libellePeriode(s.period)} », choisie dans les filtres.`,
    action: { label: `Chercher sur toutes les dates`, period: 'all' },
  };
}

/**
 * « Mon agenda » — nouvelle chaîne de requête après une recherche validée
 * (pure) : la recherche (vue Liste, `searchWithLocalQuery` du lot 97C) et la
 * période (A8) dans la même URL.
 */
export function agendaSearchParams(search: string, nextQ: string, withLocalQuery: (search: string, q: string) => string): string {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const avant = params.get('q') ?? '';
  const etat: AgendaSearchPeriod = { period: parseAgendaPeriod(params.get('period')), suspended: parseSuspended(params.get(SUSPENDED_PERIOD_PARAM)) };
  const suivant = periodOnSearchChange(etat, avant, nextQ);
  const apres = new URLSearchParams(withLocalQuery(params.toString(), nextQ).replace(/^\?/, ''));
  if (suivant.period === 'all') apres.delete('period'); else apres.set('period', suivant.period);
  if (suivant.suspended) apres.set(SUSPENDED_PERIOD_PARAM, suivant.suspended); else apres.delete(SUSPENDED_PERIOD_PARAM);
  const s = apres.toString();
  return s ? `?${s}` : '';
}

/** Période suspendue lue dans l'URL (`null` si absente, « Tous » ou inconnue). */
export function parseSuspended(raw: string | null | undefined): AgendaPeriod | null {
  const p = parseAgendaPeriod(raw);
  return raw && p !== 'all' ? p : null;
}
