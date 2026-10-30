"use client"

import { useState, useEffect, useId } from 'react';
import { EFFECTIVE_STATUS_LABELS, attentionFlagLabel, visibleAttentionFlags, type AgendaEffectiveStatus } from '@/lib/agenda/effective-status';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyStateCard } from '@/components/ui/empty-state-card';
import { Plus, CalendarDays, AlertCircle } from 'lucide-react';
import dynamic from 'next/dynamic';
import { apiClient } from '@/lib/api-client';
import { toast } from 'sonner';
import type { AgendaItemFull } from '@/services/agenda/AgendaQueryService';
import { useWriteGuard } from '@/contexts/WriteGuardContext';
import { AgendaViewControls, CalendarView, YearView, currentMonth, type AgendaView } from '@/components/agenda/AgendaPeriodViews';
import { ActiveFilterChips, FiltersToggleButton } from '@/components/filters/FilterControls';
import { AssetAgendaFilterPanel } from '@/components/assets/AssetAgendaFilters';
import {
  buildEquipmentFilterModel, equipmentFilterParam, type EquipmentFacet,
} from '@/lib/filters/equipment-filter';
import { periodOnExplicitChoice, periodOnSearchChange, type AgendaPeriod } from '@/lib/agenda/agenda-filters';
import { AgendaSearchPeriodNotice } from '@/components/agenda/AgendaSearchPeriodNotice';
import { buildRoomFilterModel, roomFilterParam, type RoomFacet } from '@/lib/filters/room-filter';
import { assetAgendaChips, isAssetAgendaEmpty } from '@/lib/agenda/asset-agenda-filters';
import { undatedLabel } from '@/lib/agenda/no-deadline';
import { LocalSearchField } from '@/components/search/LocalSearchField';
import { LOCAL_SEARCH_PARAM, localSearchNoResult, readLocalQuery, searchWithLocalQuery } from '@/lib/search/local-search';

const AgendaItemDrawer = dynamic(
  () => import('@/components/agenda/AgendaItemDrawer').then(m => ({ default: m.AgendaItemDrawer })),
  { ssr: false }
);
const CreateAgendaItemDrawer = dynamic(
  () => import('@/components/agenda/CreateAgendaItemDrawer').then(m => ({ default: m.CreateAgendaItemDrawer })),
  { ssr: false }
);

// Lot 53 (D17) : libellés partagés — « Statut à confirmer » n'est ni réalisé, ni masqué.
type EffectiveStatus = AgendaEffectiveStatus;

const STATUS_LABELS: Record<EffectiveStatus, string> = EFFECTIVE_STATUS_LABELS;

const STATUS_COLORS: Record<EffectiveStatus, string> = {
  a_venir: 'bg-[color:var(--accent-soft)] text-[color:var(--accent)]',
  en_retard: 'bg-[color:var(--danger-soft)] text-[color:var(--danger)]',
  a_confirmer: 'bg-[color:var(--attention-soft)] text-[color:var(--attention-on-soft)]',
  realise: 'bg-[color:var(--bg-success)] text-[color:var(--text-success)]',
  annule: 'bg-[color:var(--bg-subtle)] text-[color:var(--text-secondary)]',
};

function formatShortDate(d: string | null): string {
  if (!d) return 'Sans date';
  return new Date(d + 'T12:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
}

interface Props {
  assetId: number;
}

/**
 * Onglet Agenda d'un bien. Lot 59 (point 5) : mêmes vues que « Mon agenda »
 * — Liste / Mensuel / Annuel, même sélecteur, même grille (composants
 * partagés `AgendaPeriodViews`), desktop et mobile —, limitées au bien.
 *
 * Lot 72 (72E, décision PO du 19/10/2026) : filtre « Équipement » du lot
 * 71C, avec les conventions de « Mon agenda » — bouton « Filtres », panneau
 * dans la page (un seul pour tous les écrans), pastilles « Filtré par … ».
 * Le bien est fixé par la fiche ; la section Équipement n'apparaît que s'il
 * porte des équipements (facette `equipmentFacet=1` de `/api/agenda`).
 */
export function AssetAgendaTab({ assetId }: Props) {
  const [items, setItems] = useState<AgendaItemFull[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [view, setView] = useState<AgendaView>('list');
  const [month, setMonth] = useState<string>(() => currentMonth());
  const [year, setYear] = useState<number>(() => new Date().getFullYear());
  const [refreshKey, setRefreshKey] = useState(0);
  const [period, setPeriod] = useState<AgendaPeriod>('all');
  // Lot 100E (A8) : période suspendue le temps d'une recherche (rétablie à l'effacement).
  const [periodeSuspendue, setPeriodeSuspendue] = useState<AgendaPeriod | null>(null);
  const [includeCancelled, setIncludeCancelled] = useState(false);
  // Lot 72 (72E) : `null` = « Tous (bien et équipements) », jamais transmis.
  const [equipment, setEquipment] = useState<string | null>(null);
  const [equipmentFacet, setEquipmentFacet] = useState<EquipmentFacet | null>(null);
  // Lot 75B : filtre Pièce ; `null` = « Toutes les pièces ».
  const [piece, setPiece] = useState<string | null>(null);
  const [roomFacet, setRoomFacet] = useState<RoomFacet | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Lot 97C : recherche locale de l'onglet (`?tab=agenda&q=`), limitée au bien.
  // Lue à l'ouverture de l'onglet : une recherche des Documents n'est jamais reprise.
  const [q, setQ] = useState<string>(() => (typeof window === 'undefined' ? '' : readLocalQuery(new URLSearchParams(window.location.search))));
  const filtersPanelId = `${useId()}-filtres-agenda-bien`;
  const [selectedItem, setSelectedItem] = useState<AgendaItemFull | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  // Garde au clic (en plus de celle du tiroir) : le chargement dynamique du
  // tiroir ne doit pas précéder la fenêtre de fin d'essai.
  const { garder } = useWriteGuard();
  const ouvrirCreation = () => garder(() => setShowCreate(true));

  // Autre bien (navigation d'une fiche à l'autre sans démontage) : le
  // filtre Équipement revient à « Tous ».
  useEffect(() => { setEquipment(null); setPiece(null); }, [assetId]);

  // Recherche validée (300 ms sans frappe, ou Entrée) : URL de l'onglet mise à
  // jour sans nouvelle entrée d'historique ; une recherche nouvelle ou modifiée
  // passe en vue Liste (toutes périodes, Q3-B). Filtres explicites conservés.
  const changerRecherche = (next: string) => {
    if (next && next !== q) setView('list');
    // Lot 100E (A8) : lancement → « Tous » visible, période mémorisée ; effacement → période d'avant.
    const p = periodOnSearchChange({ period, suspended: periodeSuspendue }, q, next);
    setPeriod(p.period);
    setPeriodeSuspendue(p.suspended);
    setQ(next);
    const { pathname, search, hash } = window.location;
    window.history.replaceState(null, '', `${pathname}${searchWithLocalQuery(search, next)}${hash}`);
  };

  useEffect(() => {
    setLoading(true);
    // Mêmes paramètres que « Mon agenda » : le mois pour la vue mensuelle,
    // l'année (toutes périodes) pour la vue annuelle.
    const params = new URLSearchParams({
      assetIds: String(assetId),
      period: view === 'year' ? 'all' : period,
      includeCancelled: String(includeCancelled),
      includeUndated: 'true',
    });
    if (view === 'calendar') params.set('month', month);
    if (view === 'year') params.set('year', String(year));
    // Équipements du bien (options et compteurs du filtre), et filtre actif.
    params.set('equipmentFacet', '1');
    if (equipment) params.set('equipment', equipment);
    if (piece) params.set('piece', piece);
    if (q) params.set(LOCAL_SEARCH_PARAM, q);

    // Filtres enchaînés au clavier, saisies successives de la recherche : seule
    // la DERNIÈRE réponse est appliquée.
    let actuel = true;
    apiClient.get<{ items: AgendaItemFull[]; equipmentFacet?: EquipmentFacet | null; roomFacet?: RoomFacet | null }>(`/api/agenda?${params}`)
      .then(data => {
        if (!actuel) return;
        setItems(data.items ?? []);
        setEquipmentFacet(data.equipmentFacet ?? null);
        setRoomFacet(data.roomFacet ?? null);
      })
      .catch(() => { if (actuel) toast.error('Erreur lors du chargement'); })
      .finally(() => { if (actuel) { setLoading(false); setLoadedOnce(true); } });
    return () => { actuel = false; };
  }, [assetId, period, includeCancelled, equipment, piece, q, refreshKey, view, month, year]);

  const onMutated = () => {
    setRefreshKey(k => k + 1);
    setSelectedItem(null);
  };

  // Refresh when any agenda mutation happens elsewhere (e.g. from DocumentDrawer)
  useEffect(() => {
    const handler = () => setRefreshKey(k => k + 1);
    window.addEventListener('agenda-mutated', handler);
    return () => window.removeEventListener('agenda-mutated', handler);
  }, []);

  // Bien fixé par la fiche : un seul bien retenu pour le modèle.
  const equipmentModel = buildEquipmentFilterModel(equipmentFacet, equipment, 1);
  // Le bien n'a (plus) aucun équipement proposé : un filtre resté actif
  // n'aurait plus de commande pour le retirer — il est abandonné.
  useEffect(() => {
    if (loadedOnce && !loading && equipment && !equipmentModel.visible) setEquipment(null);
  }, [loadedOnce, loading, equipment, equipmentModel.visible]);
  const roomModel = buildRoomFilterModel(roomFacet, piece, 1);
  useEffect(() => {
    if (loadedOnce && !loading && piece && !roomModel.chipLabel) setPiece(null);
  }, [loadedOnce, loading, piece, roomModel.chipLabel]);
  const chips = assetAgendaChips({
    view, period, includeCancelled,
    equipmentChipLabel: equipment ? (equipmentModel.chipLabel ?? (loading ? null : 'Équipement indisponible')) : null,
    roomChipLabel: piece ? roomModel.chipLabel : null,
  });
  const activeFiltersCount = chips.length;
  // Choix EXPLICITE d'une période (panneau, pastille, ligne d'état) : appliqué, conservé pendant la recherche.
  const choisirPeriode = (v: AgendaPeriod) => {
    const p = periodOnExplicitChoice(v);
    setPeriod(p.period);
    setPeriodeSuspendue(p.suspended);
  };
  const removeChip = (key: string) => {
    if (key === 'period') choisirPeriode('all');
    else if (key === 'cancelled') setIncludeCancelled(false);
    else if (key === 'equipment') setEquipment(null);
    else if (key === 'piece') setPiece(null);
  };
  const clearFilters = () => { choisirPeriode('all'); setIncludeCancelled(false); setEquipment(null); setPiece(null); };

  // Comme « Mon agenda » : commandes masquées seulement si l'agenda du bien
  // est RÉELLEMENT vide (vue Liste, aucun filtre) — un mois vide n'est pas un
  // agenda vide, et un filtre trop restrictif doit rester retirable.
  const agendaVide = isAssetAgendaEmpty({ loading, itemCount: items.length, view, activeFilters: activeFiltersCount + (q ? 1 : 0) });
  const masquerFiltres = !loadedOnce || agendaVide;

  return (
    <div className="space-y-4">
      {/* Toolbar — lot 72 (72E) : bouton « Filtres » de « Mon agenda » ; il
          déplie le panneau ci-dessous, jamais un tiroir (téléphone compris). */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {!masquerFiltres && (
          <FiltersToggleButton
            count={activeFiltersCount}
            open={filtersOpen}
            panelId={filtersPanelId}
            onToggle={() => setFiltersOpen(v => !v)}
          />
        )}
        {(items.length > 0 || view !== 'list' || activeFiltersCount > 0 || !!q) && (
          <Button variant="secondary" size="sm" onClick={ouvrirCreation} className="btn-add">
            <Plus className="h-4 w-4 btn-add-plus-icon" /> Ajouter
          </Button>
        )}
      </div>

      {filtersOpen && !masquerFiltres && (
        <AssetAgendaFilterPanel
          id={filtersPanelId}
          view={view}
          period={period}
          includeCancelled={includeCancelled}
          equipment={equipmentModel}
          onPeriod={choisirPeriode}
          onToggleCancelled={() => setIncludeCancelled(v => !v)}
          onEquipment={(v) => setEquipment(equipmentFilterParam(v))}
          room={roomModel}
          onRoom={(v) => setPiece(roomFilterParam(v))}
        />
      )}
      {!masquerFiltres && <ActiveFilterChips chips={chips} onRemove={removeChip} onClear={clearFilters} />}

      {/* Lot 97C : recherche locale limitée au bien — toujours accessible. */}
      <LocalSearchField
        kind="agenda"
        value={q}
        onCommit={changerRecherche}
        busy={!!q && loading}
        resultCount={q && !loading ? items.length : null}
      />
      {/* Lot 100E (A8) : période réellement appliquée à la recherche — « Tous » ou la période choisie. */}
      <AgendaSearchPeriodNotice q={q} state={{ period, suspended: periodeSuspendue }} onChoose={choisirPeriode} />
      {q && !loading && view !== 'list' && (
        <p className="-mt-3 text-xs text-muted-foreground" data-testid="recherche-agenda-periode">
          Seuls les résultats de la période affichée sont présentés. La vue Liste montre toutes les périodes.
        </p>
      )}

      {/* Lot 59 (point 5) : Liste / Mensuel / Annuel, comme « Mon agenda ». */}
      <AgendaViewControls
        view={view}
        month={month}
        year={year}
        hidden={!loadedOnce || agendaVide}
        label="Affichage de l’agenda du bien"
        onView={setView}
        onMonth={setMonth}
        onYear={setYear}
      />

      {/* Content */}
      {loading ? (
        view === 'year' ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {[...Array(12)].map((_, i) => <Skeleton key={i} className="h-48 w-full rounded-2xl" />)}
          </div>
        ) : (
          <div className="space-y-2">
            {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}
          </div>
        )
      ) : view === 'year' ? (
        // Lot 75H : en-tête d'un mois → vue mensuelle de ce mois (filtres conservés).
        <YearView items={items} year={year} onItemClick={setSelectedItem} onOpenMonth={(m) => { setMonth(m); setView('calendar'); }} />
      ) : view === 'calendar' ? (
        <CalendarView items={items} month={month} onItemClick={setSelectedItem} onNew={ouvrirCreation} />
      ) : items.length === 0 && q ? (
        <div className="text-center py-12 text-muted-foreground" data-testid="recherche-locale-aucun-resultat">
          <CalendarDays className="h-10 w-10 mx-auto mb-3 opacity-30" />
          <p className="font-medium">{localSearchNoResult('agenda', q, activeFiltersCount > 0)}</p>
          <Button size="sm" variant="outline" className="mt-3" onClick={() => changerRecherche('')}>Effacer la recherche</Button>
        </div>
      ) : items.length === 0 && activeFiltersCount > 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <CalendarDays className="h-10 w-10 mx-auto mb-3 opacity-30" />
          <p className="font-medium">Aucun élément</p>
          <p className="text-sm mt-1">Aucun résultat avec ces filtres.</p>
        </div>
      ) : items.length === 0 ? (
        <EmptyStateCard
          icon={<CalendarDays className="w-4 h-4 text-[color:var(--text-success)]" />}
          iconClassName="bg-[color:var(--bg-success)]"
          title="Aucun élément pour le moment"
          description="Créez votre premier élément d'agenda"
          actionLabel="Ajouter un élément"
          onAction={ouvrirCreation}
        />
      ) : (
        <div className="rounded-lg border overflow-hidden">
          {items.map(item => (
            <div
              key={item.id}
              className="flex items-start gap-3 px-4 py-3 hover:bg-muted/40 cursor-pointer border-b last:border-b-0"
              onClick={() => setSelectedItem(item)}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium truncate">{item.title}</span>
                  {item.isAutomatic && !item.isAutomaticModified && (
                    <Badge variant="secondary" className="text-xs shrink-0">Auto</Badge>
                  )}
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-xs text-muted-foreground">{!item.startDate ? undatedLabel(item) : item.occurrenceNature === 'FORECAST' ? `prévu le ${formatShortDate(item.startDate)}` : formatShortDate(item.startDate)}</span>
                  {visibleAttentionFlags(item.attentionFlags).map(f => (
                    <span key={f} className="inline-flex items-center rounded-full px-1.5 py-0.5 text-xs bg-[color:var(--attention-soft)] text-[color:var(--attention-on-soft)]">
                      <AlertCircle className="h-2.5 w-2.5 mr-0.5" />
                      {attentionFlagLabel(f)}
                    </span>
                  ))}
                </div>
              </div>
              <span className={`shrink-0 mt-0.5 inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[item.effectiveStatus]}`}>
                {STATUS_LABELS[item.effectiveStatus]}
              </span>
            </div>
          ))}
        </div>
      )}

      <AgendaItemDrawer
        item={selectedItem}
        open={!!selectedItem}
        onClose={() => setSelectedItem(null)}
        onMutated={onMutated}
        onOpenDocument={(fileId) => {
          setSelectedItem(null);
          window.dispatchEvent(new CustomEvent('open-document-drawer', { detail: { docId: fileId } }));
        }}
      />

      <CreateAgendaItemDrawer
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onMutated={() => setRefreshKey(k => k + 1)}
        prefilledAssetId={assetId}
      />
    </div>
  );
}
