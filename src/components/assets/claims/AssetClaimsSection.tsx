"use client"

/**
 * Rubrique « Sinistres » de la fiche bien (lot 44, O5 ; CDC Opérations V1
 * ch. 15.2 ; décisions PO Q2, Q3, Q11).
 *
 *   · liste des sinistres du bien (plusieurs par bien) — ajout, ouverture,
 *     modification, suppression ; un sinistre peut concerner plusieurs biens ;
 *   · ouverte à TOUTES les offres (Q3), Standard compris : seules les règles
 *     d'écriture de la fiche s'appliquent (garde commune `useWriteGuard`,
 *     refus serveur affiché) ; l'export du dossier reste Premium ;
 *   · ancienne saisie non reprise affichée avec « Reprendre en sinistre »
 *     (compatibilité Q11).
 *
 * Desktop et mobile : même composant, mise en page responsive (une colonne
 * sur mobile) ; tiroir repliable comme les autres rubriques de la fiche.
 */
import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, ChevronDown, ChevronUp } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { apiClient } from '@/lib/api-client';
import { parseWriteBlocked } from '@/lib/write-blocked';
import { useWriteGuard } from '@/contexts/WriteGuardContext';
import { ClaimEditor, type ClaimResponse } from './ClaimEditor';
import { ClaimsListView, type ClaimSummary, type LegacyClaim } from './ClaimViews';

interface ListResponse {
  claims: ClaimSummary[];
  legacy: LegacyClaim | null;
  assetOptions: Array<{ id: number; name: string }>;
}

interface Props {
  assetId: number;
  category: string;
  readOnly?: boolean;
  defaultOpen?: boolean;
  /**
   * Lot 45 (O6) : sinistre à ouvrir d'emblée — lien profond
   * `?tab=details&highlight=claims&claim=<id>` (source « sinistre » de
   * l'assistant). Ignoré s'il n'appartient pas aux sinistres du bien.
   */
  initialClaimId?: number | null;
}

export function AssetClaimsSection({ assetId, category, readOnly = false, defaultOpen = false, initialClaimId = null }: Props) {
  const { garder, signalerRefus } = useWriteGuard();
  const [open, setOpen] = useState(defaultOpen);
  const [data, setData] = useState<ListResponse | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(false);
    try {
      setData(await apiClient.get<ListResponse>(`/api/assets/${assetId}/claims`));
    } catch {
      setLoadError(true);
    }
  }, [assetId]);

  useEffect(() => { void load(); }, [load]);

  // Lien profond (lot 45) : la rubrique est amenée à l'écran une fois, et le
  // sinistre demandé ouvert s'il fait partie de la liste du bien.
  const [lienApplique, setLienApplique] = useState(false);
  useEffect(() => {
    if (lienApplique || !defaultOpen || !data) return;
    setLienApplique(true);
    if (initialClaimId && data.claims.some((c) => c.id === initialClaimId)) setSelected(initialClaimId);
    if (typeof document !== 'undefined') {
      setTimeout(() => document.getElementById('asset-section-claims')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 150);
    }
  }, [lienApplique, defaultOpen, data, initialClaimId]);

  const refus = useCallback((err: unknown) => {
    const e = err as { status?: number; code?: string; serverMessage?: string };
    const blocked = e?.status === 403 ? parseWriteBlocked({ code: e.code, message: e.serverMessage }) : null;
    if (blocked) signalerRefus(blocked);
    else setMessage('L’enregistrement a échoué. Réessayez dans un instant.');
  }, [signalerRefus]);

  const add = useCallback(() => garder(() => {
    setBusy(true);
    setMessage(null);
    apiClient.post<ClaimResponse>(`/api/assets/${assetId}/claims`, {})
      .then(async (c) => { await load(); setSelected(c.id); })
      .catch(refus)
      .finally(() => setBusy(false));
  }), [garder, assetId, load, refus]);

  const resume = useCallback(() => garder(() => {
    setBusy(true);
    setMessage(null);
    apiClient.post<ClaimResponse>(`/api/assets/${assetId}/claims`, { resumeLegacy: true })
      .then(async (c) => { await load(); setSelected(c.id); })
      .catch(refus)
      .finally(() => setBusy(false));
  }), [garder, assetId, load, refus]);

  const count = data?.claims.length ?? 0;
  return (
    <div id="asset-section-claims" className="border border-border rounded-lg overflow-hidden" data-asset-claims>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 bg-muted/30 text-left"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2 min-w-0">
          <span className="font-medium text-sm">Sinistres</span>
          {count > 0 && (
            <span className="text-[10px] font-medium text-primary bg-primary/10 rounded-full px-1.5 py-0.5 shrink-0">{count}</span>
          )}
        </span>
        {open ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
      </button>
      {open && (
        <div className="p-4 space-y-3">
          {message && <p className="text-xs text-amber-700 dark:text-amber-200" role="status">{message}</p>}
          {loadError ? (
            <div className="text-sm text-muted-foreground flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-red-400" />
              Les sinistres n&apos;ont pas pu être chargés.
              <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => void load()}>Réessayer</button>
            </div>
          ) : !data ? (
            <div className="space-y-2">{[1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
          ) : selected !== null ? (
            <ClaimEditor
              key={selected}
              assetId={assetId}
              claimId={selected}
              category={category}
              assetOptions={data.assetOptions}
              readOnly={readOnly}
              onBack={() => { setSelected(null); void load(); }}
              onDeleted={(remains) => {
                setSelected(null);
                setMessage(remains ? 'Vos informations ont été retirées. Ce sinistre reste visible car il figure dans vos documents (constat, courrier de l’assureur…).' : 'Sinistre supprimé.');
                void load();
              }}
            />
          ) : (
            <ClaimsListView
              claims={data.claims}
              legacy={data.legacy}
              readOnly={readOnly}
              busy={busy}
              onAdd={add}
              onOpen={(id) => { setMessage(null); setSelected(id); }}
              onResumeLegacy={resume}
            />
          )}
        </div>
      )}
    </div>
  );
}
