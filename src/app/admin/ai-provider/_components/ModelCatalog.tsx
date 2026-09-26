"use client";

/**
 * Catalogue des modèles du fournisseur — CDC BO IA E-04, PROV-UI-06,
 * PROV-UI-07, PROV-UI-08, WF-29, WF-40, SCR-10.
 *
 * « Actualiser le catalogue » interroge réellement le fournisseur avec la clé
 * active (le bouton « Actualiser » de l'écran ne faisait que recharger la
 * page). Un modèle disparu devient indisponible : il n'est plus sélectionnable
 * et bloque la validation d'une version qui l'emploie. En échec, le catalogue
 * précédent reste en place et l'écran le dit.
 */
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Loader2, RefreshCw, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';

interface CatalogState {
  refreshedAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  stale: boolean;
  models: Array<{
    model: string; displayName: string | null; available: boolean;
    inputTokenLimit: number | null; outputTokenLimit: number | null; lastSeenAt: string;
  }>;
}

export function ModelCatalog() {
  const [state, setState] = useState<CatalogState | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await apiClient.get<CatalogState>('/api/admin/ai/provider/catalog'));
    } catch {
      setState(null);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const refresh = async () => {
    setBusy(true);
    try {
      const r = await apiClient.post<{ modelsSeen: number; disappeared: string[]; state: CatalogState }>(
        '/api/admin/ai/provider/catalog', {},
      );
      setState(r.state);
      toast.success(`${r.modelsSeen} modèle(s) listé(s)${r.disappeared.length ? ` — indisponibles : ${r.disappeared.join(', ')}` : ''}.`);
    } catch (e) {
      toast.error((e as Error).message || 'Rafraîchissement impossible : le catalogue précédent est conservé.');
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold text-[color:var(--text-primary)]">Catalogue des modèles</h2>
          <p className="text-xs text-[color:var(--text-muted)]">
            {state?.refreshedAt
              ? `Dernier rafraîchissement : ${new Date(state.refreshedAt).toLocaleString('fr-FR')}.`
              : 'Jamais rafraîchi : la liste de référence du code s’applique.'}
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={refresh} disabled={busy}>
          {busy ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5 mr-1.5" />}
          Actualiser le catalogue
        </Button>
      </div>

      {state?.stale && (
        <p className="text-xs text-amber-500 flex items-start gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          Dernière tentative en échec ({state.lastError ?? 'cause inconnue'}) : le catalogue affiché est le précédent.
        </p>
      )}

      {state && state.models.length > 0 && (
        <div className="divide-y divide-[color:var(--border-subtle)]">
          {state.models.map((m) => (
            <div key={m.model} className="py-1.5 flex flex-wrap items-center gap-2 text-sm">
              <span className={m.available ? 'text-[color:var(--text-primary)]' : 'text-[color:var(--text-muted)] line-through'}>{m.model}</span>
              {!m.available && <span className="text-xs text-red-400">indisponible</span>}
              <span className="flex-1" />
              <span className="text-xs text-[color:var(--text-muted)]">
                {m.inputTokenLimit ? `${m.inputTokenLimit.toLocaleString('fr-FR')} in` : ''}
                {m.outputTokenLimit ? ` · ${m.outputTokenLimit.toLocaleString('fr-FR')} out` : ''}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
