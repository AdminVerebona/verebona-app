'use client';

/**
 * En-tête de Configuration IA — lot 35B, ticket « Catalogue IA dynamique
 * Google : modèles, tarifs, Preview et alertes BO ».
 *
 *   · « Nouveau modèle Gemini disponible » : un ou plusieurs modèles apparus
 *     depuis le dernier acquittement, qualifiés et ajoutés aux modèles
 *     utilisables. Une croix le ferme ET acquitte en base, en une action,
 *     tous les modèles affichés (persistant : ne réapparaît pas après une
 *     reconnexion ; un modèle découvert plus tard ouvre un nouveau bandeau).
 *   · « Modèle actif indisponible » : un modèle de la configuration effective
 *     a disparu du catalogue de la clé active, est devenu non opérationnel ou
 *     a échoué à sa qualification. Non masquable : il disparaît quand la
 *     configuration est corrigée. Aucun remplacement automatique.
 *
 * Page réservée aux administrateurs (layout du BO + route garde-fou).
 * Même rendu desktop et mobile : bloc pleine largeur, contenu en `flex-wrap`,
 * cible tactile de la croix ≥ 32 px. Composants et jetons existants.
 */
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Sparkles, X } from 'lucide-react';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';

interface AnnouncedModel { model: string; displayName: string | null; status: string; firstSeenAt: string }
interface Anomaly { treatment: string; rank: string; model: string; message: string; fallbackAvailable: boolean }
interface CatalogStatus {
  newModels: AnnouncedModel[];
  banner: { title: string; body: string } | null;
  anomalies: Anomaly[];
}

export function CatalogBanners({ refreshKey = 0 }: { refreshKey?: number }) {
  const [data, setData] = useState<CatalogStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await apiClient.get<CatalogStatus>('/api/admin/ai/catalog-status'));
    } catch {
      // En-tête informatif : une lecture impossible ne bloque pas la page.
      setData(null);
    }
  }, []);

  useEffect(() => { void load(); }, [load, refreshKey]);

  const fermer = async () => {
    if (!data?.newModels.length) return;
    const affiches = data.newModels.map((m) => m.model);
    setBusy(true);
    try {
      await apiClient.post('/api/admin/ai/catalog-status', { acknowledge: affiches });
      setData({ ...data, newModels: [], banner: null });
    } catch {
      toast.error('Le bandeau n’a pas pu être acquitté. Réessayez.');
    } finally {
      setBusy(false);
    }
  };

  if (!data || (!data.banner && data.anomalies.length === 0)) return null;

  return (
    <div className="space-y-3" data-testid="catalog-banners">
      {data.banner && (
        <div
          role="status"
          data-testid="new-models-banner"
          className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--accent-soft)] p-3 sm:p-4 flex items-start gap-3"
        >
          <Sparkles className="w-4 h-4 mt-0.5 shrink-0 text-[color:var(--text-primary)]" aria-hidden />
          <div className="flex-1 min-w-0 space-y-1">
            <p className="text-sm font-semibold text-[color:var(--text-primary)]">{data.banner.title}</p>
            <p className="text-sm text-[color:var(--text-muted)] break-words">{data.banner.body}</p>
            {data.newModels.some((m) => m.status === 'preview') && (
              <p className="text-xs text-amber-500">
                Preview : {data.newModels.filter((m) => m.status === 'preview').map((m) => m.displayName || m.model).join(', ')} — statut visible dans le registre des modèles.
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={fermer}
            disabled={busy}
            aria-label="Fermer et acquitter"
            title="Fermer et acquitter"
            className="shrink-0 inline-flex items-center justify-center w-8 h-8 rounded-md text-[color:var(--text-muted)] hover:bg-[color:var(--bg-card)] hover:text-[color:var(--text-primary)] disabled:opacity-50"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {data.anomalies.length > 0 && (
        <div role="alert" data-testid="active-model-anomalies" className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 sm:p-4 space-y-1.5">
          <p className="text-sm font-semibold text-amber-500 flex items-center gap-1.5">
            <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden />
            {data.anomalies.length === 1 ? 'Modèle actif indisponible' : `${data.anomalies.length} modèles actifs indisponibles`}
          </p>
          <ul className="space-y-1">
            {data.anomalies.map((a) => (
              <li key={`${a.treatment}-${a.rank}-${a.model}`} className="text-xs text-[color:var(--text-primary)] break-words">{a.message}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
