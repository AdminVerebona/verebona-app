'use client';

/**
 * Section de filtre temporel — « Date du document » et « Date d'ajout » de
 * « Mes documents » (lot 103F). Voir `lib/filters/date-filter.ts`.
 *
 * Choix unique en pastilles (même groupe radio que « Pièce » / « Équipement »,
 * flèches du clavier) : « Toutes les dates » par défaut — aucune restriction
 * temporelle tant que l'utilisateur n'en choisit pas —, puis les raccourcis
 * calendaires, la période personnalisée et, pour la date du document,
 * « Sans date ».
 *
 * Période personnalisée : « Du » et « Au » avec le sélecteur de date commun
 * (format français, utilisable au doigt et au clavier) ; une seule borne
 * suffit ; une période dont le début suit la fin est REFUSÉE (message, filtre
 * inchangé), jamais corrigée en silence. La période retenue s'affiche en
 * clair sous les choix et dans la synthèse « Filtré par … ».
 */
import { useEffect, useRef, useState } from 'react';
import { DatePicker } from '@/components/ui/date-picker';
import {
  DATE_PRESETS,
  DATE_RANGE_ERROR_TEXT,
  dateFilterSummary,
  isDateFilterActive,
  makeDateFilter,
  todayIn,
  validateDateRange,
  type DateFilterValue,
  type DatePreset,
} from '@/lib/filters/date-filter';
import { FilterChoiceGroup, FilterSection, type SectionCollapse } from './FilterControls';

const ALL = 'all';

export function DateFilterSection({
  id,
  title,
  value,
  onChange,
  allowNone,
  collapse,
  className = '',
  now,
}: {
  id: string;
  title: string;
  value: DateFilterValue | undefined;
  /** `null` : aucune restriction. */
  onChange: (value: DateFilterValue | null) => void;
  /** Propose « Sans date » (date du document seulement). */
  allowNone: boolean;
  collapse?: SectionCollapse;
  className?: string;
  /** Horloge injectable (tests). */
  now?: () => Date;
}) {
  const actif = isDateFilterActive(value) ? value : undefined;
  // Mode affiché : « Période personnalisée » peut être choisie avant toute
  // borne saisie (aucun filtre encore appliqué).
  const [custom, setCustom] = useState(actif?.preset === 'custom');
  const [from, setFrom] = useState(actif?.preset === 'custom' ? actif.from ?? '' : '');
  const [to, setTo] = useState(actif?.preset === 'custom' ? actif.to ?? '' : '');
  const [error, setError] = useState<string | null>(null);
  // Bornes vidées DEPUIS cette section : la période personnalisée reste
  // ouverte pour la saisie (seul un retrait venu d'ailleurs la referme).
  const videeIci = useRef(false);

  // Filtre retiré ailleurs (synthèse, « Réinitialiser les filtres ») ou
  // restauré : l'affichage suit, sans rien appliquer.
  const cle = actif ? `${actif.preset}:${actif.from ?? ''}:${actif.to ?? ''}` : '';
  useEffect(() => {
    if (!actif) {
      if (videeIci.current) { videeIci.current = false; return; }
      setCustom(false);
      setFrom('');
      setTo('');
      setError(null);
      return;
    }
    setCustom(actif.preset === 'custom');
    if (actif.preset === 'custom') {
      setFrom(actif.from ?? '');
      setTo(actif.to ?? '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cle]);

  const selected: string = custom ? 'custom' : actif?.preset ?? ALL;
  const presets = DATE_PRESETS.filter((p) => allowNone || p.value !== 'none');
  const options = [{ value: ALL, label: 'Toutes les dates' }, ...presets].map((p) => ({
    value: p.value,
    label: p.label,
    active: p.value === selected,
  }));
  const today = () => todayIn(now ? now() : new Date());

  const choisir = (v: string) => {
    setError(null);
    if (v === ALL) {
      setCustom(false);
      onChange(null);
      return;
    }
    if (v === 'custom') {
      setCustom(true);
      // Reprend les bornes du raccourci en cours, modifiables ensuite.
      if (actif && actif.preset !== 'none') {
        setFrom(actif.from ?? '');
        setTo(actif.to ?? '');
        onChange(makeDateFilter('custom', today(), { from: actif.from, to: actif.to }));
      }
      return;
    }
    setCustom(false);
    onChange(makeDateFilter(v as DatePreset, today()));
  };

  const appliquer = (nextFrom: string, nextTo: string) => {
    setFrom(nextFrom);
    setTo(nextTo);
    const refus = validateDateRange(nextFrom || null, nextTo || null);
    if (refus) {
      setError(DATE_RANGE_ERROR_TEXT[refus]);
      return;
    }
    setError(null);
    const next = makeDateFilter('custom', today(), { from: nextFrom, to: nextTo });
    if (!next && actif) videeIci.current = true;
    onChange(next);
  };

  const errorId = `${id}-erreur`;
  return (
    <FilterSection id={id} title={title} className={className} collapse={collapse}>
      <div data-testid={`filtre-${id}`} className="flex min-w-0 flex-col gap-2.5">
        <FilterChoiceGroup labelledBy={id} groups={[{ key: 'periodes', options }]} onSelect={choisir} />
        {custom && (
          <div className="grid grid-cols-1 gap-2.5 min-[380px]:grid-cols-2" role="group" aria-label={`${title} : période personnalisée`}>
            <div className="flex min-w-0 flex-col gap-1">
              <label htmlFor={`${id}-du`} className="text-xs font-medium text-[color:var(--text-muted)]">Du</label>
              <DatePicker
                id={`${id}-du`}
                value={from}
                max={to || undefined}
                placeholder="jj/mm/aaaa"
                onChange={(v) => appliquer(v, to)}
              />
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <label htmlFor={`${id}-au`} className="text-xs font-medium text-[color:var(--text-muted)]">Au</label>
              <DatePicker
                id={`${id}-au`}
                value={to}
                min={from || undefined}
                placeholder="jj/mm/aaaa"
                onChange={(v) => appliquer(from, v)}
              />
            </div>
          </div>
        )}
        {error && (
          <p id={errorId} role="alert" className="m-0 text-xs text-[color:var(--text-danger)]">{error}</p>
        )}
        {actif && (
          <p className="m-0 text-xs text-[color:var(--text-muted)]" data-slot="date-filter-summary">
            {dateFilterSummary(actif)}
          </p>
        )}
      </div>
    </FilterSection>
  );
}
