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

/** Mêmes libellés et même ordre que l'ancien tiroir de filtres. */
export const AGENDA_PERIOD_OPTIONS: ReadonlyArray<{ value: AgendaPeriod; label: string }> = [
  { value: 'all', label: 'Tout' },
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
