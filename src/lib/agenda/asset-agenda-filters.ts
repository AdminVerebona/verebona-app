/**
 * Filtres de l'onglet Agenda d'un bien — logique pure (lot 72, 72E).
 *
 * Décision PO du 19/10/2026 : le filtre « Équipement » du lot 71C rejoint
 * l'onglet Agenda de la fiche d'un bien, avec les conventions de
 * présentation de « Mon agenda » (bouton « Filtres », panneau dans la page,
 * pastilles « Filtré par … »). Le bien est fixé par la fiche : aucun filtre
 * Bien, aucune pastille de bien.
 *
 * Les filtres PROPRES à l'onglet sont conservés tels quels (périodes Tout /
 * À venir / Passés, annulés affichés ou non) : seule leur présentation
 * rejoint celle de « Mon agenda ». « Aujourd'hui », propre à « Mon agenda »,
 * n'est pas ajouté ici (hors décision PO).
 */
import { AGENDA_PERIOD_OPTIONS, agendaFilterChips, type AgendaPeriod } from './agenda-filters';

/** Vues partagées avec « Mon agenda » (`AgendaPeriodViews`). */
export type AssetAgendaView = 'list' | 'calendar' | 'year';

/** Périodes de l'onglet : celles de « Mon agenda », sans « Aujourd'hui ». */
export const ASSET_AGENDA_PERIOD_OPTIONS: ReadonlyArray<{ value: AgendaPeriod; label: string }> =
  AGENDA_PERIOD_OPTIONS.filter((o) => o.value !== 'today');

/**
 * Pastilles « Filtré par … » : Période, Équipement, Statut. En vue annuelle,
 * la période ne s'applique pas (toute l'année) : pas de pastille Période.
 */
export function assetAgendaChips(input: {
  view: AssetAgendaView;
  period: AgendaPeriod;
  includeCancelled: boolean;
  equipmentChipLabel: string | null;
  /** Lot 75B : libellé du filtre Pièce actif. */
  roomChipLabel?: string | null;
}): Array<{ key: string; label: string }> {
  return agendaFilterChips({
    roomChipLabel: input.roomChipLabel ?? null,
    period: input.view === 'year' ? 'all' : input.period,
    assetIds: [],
    includeCancelled: input.includeCancelled,
    assetOptions: [],
    equipmentChipLabel: input.equipmentChipLabel,
  });
}

/**
 * Agenda du bien RÉELLEMENT vide : vue Liste, aucun filtre actif. Un filtre
 * trop restrictif ne doit jamais masquer les commandes qui permettent de le
 * retirer (même règle que « Mon agenda »).
 */
export function isAssetAgendaEmpty(input: {
  loading: boolean;
  itemCount: number;
  view: AssetAgendaView;
  activeFilters: number;
}): boolean {
  return !input.loading && input.itemCount === 0 && input.view === 'list' && input.activeFilters === 0;
}
