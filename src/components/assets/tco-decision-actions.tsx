"use client"

/**
 * Lot 111V — gestes CONTEXTUELS d'une ligne du coût de possession (ticket
 * « TCO — rendre chaque anomalie corrigeable »). Aucune règle ici : les gestes
 * possibles, leurs libellés et leur effet viennent du serveur
 * (`tcoLineDecisionOptions`, DTO `actions.options` / diagnostics
 * `source.actions`). Le même composant sert dans « Points à vérifier » et dans
 * les listes de dépenses (desktop et mobile).
 *
 *   · arbitrage (Confirmer le même fait, Dépenses distinctes, Confirmer
 *     l'exclusion, C'est une dépense du bien, Garder mon choix) et « Annuler
 *     mon choix » : confirmation légère dans le contexte (pas de fenêtre),
 *     phrase d'effet exacte, catégorie à choisir pour une nature confirmée ;
 *   · « Corriger le document » / « Indiquer le montant » : ouvre le tiroir du
 *     document existant (formulaire de correction), jamais une page en
 *     lecture seule ;
 *   · lot 113N : « Conserver dans le TCO sans date » / « Annuler mon choix »
 *     (décision sur la date, confirmée dans le contexte) et « Renseigner la
 *     date » (tiroir du justificatif, ou champ « date d'achat » de la fiche).
 * Accessibilité : boutons nommés, groupe de confirmation étiqueté, message
 * d'avertissement en `role="alert"`, cibles de 44 px sur mobile ; jamais la
 * couleur seule (jetons de la charte Sérénité, aucune couleur brute).
 */
import { useId, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { drawerHref } from '@/lib/drawers';
import type { TcoDecisionOption, TcoDecisionOptionAction, TcoDecisionSubmitAction } from '@/services/business-operations/tco/user-decisions';
import { openTcoJustificatif } from './tco-justificatif';

/** Geste envoyé au serveur (`POST /api/assets/[id]/tco/decisions`). */
export type TcoArbitrate = (x: { lineId: string; lineKey: string | null; action: TcoDecisionSubmitAction; category?: string | null; confirmDuplicate?: boolean;
  /** Carte 769 : version des propriétés matérielles affichées (le serveur refuse une dépense qui a changé). */
  lineVersion?: string | null })
  => Promise<{ ok: true } | { ok: false; duplicateWarning?: string }>;

interface Props {
  lineId: string;
  lineKey: string | null;
  /** Carte 769 : version de la ligne affichée, renvoyée avec le geste. */
  lineVersion?: string | null;
  options: readonly TcoDecisionOption[];
  onDecide: TcoArbitrate;
  /** Libellés des catégories (DTO) et catégories proposées pour une nature confirmée. */
  categoryLabels?: Readonly<Record<string, string>>;
  categories?: readonly string[];
  /** Gestes déjà rendus ailleurs (ex. « Ajouter / Retirer du TCO » de la ligne). */
  exclude?: readonly TcoDecisionOptionAction[];
}

/** Lot 113N : geste envoyé au serveur (les autres ouvrent un formulaire existant). */
const soumis = (a: TcoDecisionOptionAction): a is TcoDecisionSubmitAction => a !== 'EDIT_DOCUMENT' && a !== 'EDIT_ASSET_FIELD';

export function TcoDecisionActions({ lineId, lineKey, lineVersion = null, options, onDecide, categoryLabels = {}, categories = [], exclude = [] }: Props) {
  const [choix, setChoix] = useState<TcoDecisionOption | null>(null);
  const [categorie, setCategorie] = useState<string>('');
  const [avertissement, setAvertissement] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const idCat = useId();
  const visibles = options.filter((o) => !exclude.includes(o.action));
  if (!visibles.length) return null;

  const valider = async () => {
    if (!choix || !soumis(choix.action)) return;
    setBusy(true);
    try {
      const r = await onDecide({
        lineId, lineKey, action: choix.action, ...(lineVersion ? { lineVersion } : {}),
        ...(choix.needsCategory && categorie ? { category: categorie } : {}),
        ...(avertissement ? { confirmDuplicate: true } : {}),
      });
      if (r.ok) { setChoix(null); setAvertissement(null); }
      else if (r.duplicateWarning) setAvertissement(r.duplicateWarning);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-1 space-y-1.5" data-tco-decision-actions={lineId}>
      {!choix && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1" role="group" aria-label="Que faire de cette ligne ?">
          {visibles.map((o, i) => (o.action === 'EDIT_ASSET_FIELD' ? (
            <a
              key={`${o.action}:${i}`}
              href={`?tab=details&highlight=${encodeURIComponent(o.field ?? 'acquisitionDate')}`}
              onClick={(e) => {
                // Même page : section « Informations » de la fiche (champ à renseigner), sinon lien profond.
                const el = document.getElementById('asset-section-common');
                if (!el || e.metaKey || e.ctrlKey || e.shiftKey) return;
                e.preventDefault();
                el.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }}
              className="inline-flex min-h-[44px] md:min-h-0 items-center text-xs font-medium text-primary hover:underline"
              data-tco-arbitration="EDIT_ASSET_FIELD"
              data-tco-date-entry={o.field ?? ''}
            >
              {o.label}
            </a>
          ) : o.action === 'EDIT_DOCUMENT' ? (
            o.fileId ? (
              <a
                key={`${o.action}:${i}`}
                href={drawerHref({ kind: 'document', id: o.fileId }, '/documents')}
                onClick={(e) => { void openTcoJustificatif(e, o.fileId!); }}
                className="inline-flex min-h-[44px] md:min-h-0 items-center text-xs font-medium text-primary hover:underline"
                data-tco-arbitration="EDIT_DOCUMENT"
                {...(o.dateEntry ? { 'data-tco-date-entry': 'document' } : {})}
              >
                {o.label}
              </a>
            ) : null
          ) : (
            <button
              key={`${o.action}:${i}`}
              type="button"
              onClick={() => { setChoix(o); setAvertissement(o.duplicateWarning ?? null); setCategorie(''); }}
              className="inline-flex min-h-[44px] md:min-h-0 items-center text-xs font-medium text-primary hover:underline"
              data-tco-arbitration={o.action}
            >
              {o.label}
            </button>
          )))}
        </div>
      )}
      {choix && soumis(choix.action) && (
        <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-2" role="group" aria-label={choix.label} data-tco-arbitration-confirm={choix.action}>
          {avertissement && (
            <p className="text-xs text-[color:var(--attention-on-soft)]" role="alert" data-tco-arbitration-warning>{avertissement}</p>
          )}
          <p className="text-xs text-[color:var(--text-primary)]">{choix.confirm}</p>
          {choix.needsCategory && categories.length > 0 && (
            <div className="flex flex-col gap-1">
              <label htmlFor={idCat} className="text-xs text-muted-foreground">Catégorie de la dépense</label>
              <select
                id={idCat}
                value={categorie}
                onChange={(e) => setCategorie(e.target.value)}
                className="min-h-[44px] md:min-h-[32px] rounded-md border border-border bg-background px-2 text-sm text-[color:var(--text-primary)]"
                data-tco-arbitration-category
              >
                <option value="">Catégorie proposée par Verebona</option>
                {categories.map((c) => <option key={c} value={c}>{categoryLabels[c] ?? c}</option>)}
              </select>
            </div>
          )}
          <div className="flex flex-wrap gap-2 justify-end">
            <Button type="button" variant="ghost" size="sm" onClick={() => { setChoix(null); setAvertissement(null); }} disabled={busy}>Annuler</Button>
            <Button type="button" size="sm" onClick={() => void valider()} disabled={busy} data-tco-arbitration-submit>
              {busy && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" aria-hidden />}
              {avertissement && choix.action === 'INCLUDE' ? 'Ajouter quand même' : choix.label}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
