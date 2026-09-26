'use client';

/**
 * Mon compte → « Mes données » : export RGPD — CDC Back-Office V1 GDP-020 à
 * GDP-022.
 *
 * Distinct des exports fonctionnels des biens : il rassemble TOUTES les
 * données du compte et de l'utilisateur (droit d'accès et portabilité), au
 * format JSON, avec les documents déposés, dans une archive ZIP.
 *
 * Génération immédiate quand elle tient dans la requête ; sinon asynchrone :
 * le bloc interroge l'état toutes les 5 s tant qu'il est affiché, et une
 * notification prévient quand l'archive est prête. Le lien de
 * téléchargement exige la session et expire (GDP-022).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { CollapsibleCard } from '@/components/ui/collapsible-card';
import { Button } from '@/components/ui/button';
import { Database, Download, Loader2, RefreshCw } from 'lucide-react';

type ExportStatus = 'pending' | 'generating' | 'ready' | 'error' | 'expired';

interface ExportState {
  id: number;
  status: ExportStatus;
  createdAt: string;
  completedAt: string | null;
  expiresAt: string | null;
  sizeBytes: number | null;
  error: string | null;
}

const ENDPOINT = '/api/users/me/gdpr-export';

function parisDateTime(iso: string): string {
  return new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'long', timeStyle: 'short' })
    .format(new Date(iso));
}

function size(bytes: number | null): string {
  if (!bytes) return '';
  const mo = bytes / (1024 * 1024);
  return mo >= 1 ? `${mo.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Mo` : `${Math.ceil(bytes / 1024)} Ko`;
}

export function MyDataCard() {
  const [state, setState] = useState<ExportState | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const poll = useRef<ReturnType<typeof setTimeout> | null>(null);

  const apply = (data: { export: ExportState | null; downloadUrl: string | null }) => {
    setState(data.export);
    setDownloadUrl(data.downloadUrl);
  };

  const load = useCallback(async () => {
    try {
      setLoadError(null);
      const res = await fetch(ENDPOINT, { credentials: 'include', cache: 'no-store' });
      if (!res.ok) throw new Error();
      apply(await res.json());
    } catch {
      setLoadError('Impossible de charger l’état de votre export.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Suivi d'une génération asynchrone (ERR-003 : l'état vient du serveur).
  const inProgress = state?.status === 'pending' || state?.status === 'generating';
  useEffect(() => {
    if (!inProgress) return;
    poll.current = setTimeout(() => { void load(); }, 5000);
    return () => { if (poll.current) clearTimeout(poll.current); };
  }, [inProgress, state, load]);

  const requestExport = async () => {
    setSubmitting(true);
    setActionError(null);
    try {
      const res = await fetch(ENDPOINT, { method: 'POST', credentials: 'include' });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) {
        setActionError(data?.message ?? 'Votre demande n’a pas pu être enregistrée. Réessayez.');
        return;
      }
      apply(data);
    } catch {
      setActionError('Erreur réseau : votre demande n’a pas pu être envoyée.');
    } finally {
      setSubmitting(false);
    }
  };

  const expired = state?.status === 'expired'
    || (state?.status === 'ready' && state.expiresAt !== null && new Date(state.expiresAt) <= new Date());

  return (
    <div id="mes-donnees" className="scroll-mt-24">
      <CollapsibleCard
        icon={<Database className="w-5 h-5" />}
        title="Mes données"
        description="Téléchargez une copie de toutes vos données personnelles (RGPD)."
        contentClassName="space-y-4"
        // État visible tiroir fermé : l'utilisateur arrive souvent ici depuis
        // la notification « export prêt ».
        headerExtra={
          state?.status === 'ready' && !expired && downloadUrl ? (
            <a href={downloadUrl} className="inline-flex items-center text-sm text-primary hover:underline">
              <Download className="w-4 h-4 mr-1" /> Télécharger mon archive
            </a>
          ) : inProgress ? (
            <span className="inline-flex items-center text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 mr-1 animate-spin" /> Archive en préparation
            </span>
          ) : undefined
        }
      >
        <p className="text-sm text-muted-foreground">
          L’archive (ZIP) contient les données de votre compte utilisateur et de votre espace Verebona
          au format JSON — biens, documents, échéances, notifications, abonnement… — ainsi que les
          documents que vous avez déposés. Elle est distincte des exports de vos biens.
        </p>

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" /> Chargement…
          </div>
        ) : loadError ? (
          <div className="text-sm">
            <p className="text-destructive">{loadError}</p>
            <button type="button" onClick={() => { setLoading(true); void load(); }} className="mt-1 underline text-xs">
              Réessayer
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {inProgress && (
              <div className="flex items-start gap-2 rounded-lg border border-[color:var(--border-subtle)] p-3 text-sm">
                <Loader2 className="w-4 h-4 mt-0.5 animate-spin shrink-0" />
                <p>
                  Préparation de votre archive en cours. Vous pouvez quitter cette page :
                  une notification vous préviendra dès qu’elle sera prête.
                </p>
              </div>
            )}

            {state?.status === 'ready' && !expired && downloadUrl && (
              <div className="rounded-lg border border-[color:var(--border-subtle)] p-3 text-sm space-y-2">
                <p>
                  Archive prête{state.completedAt ? ` depuis le ${parisDateTime(state.completedAt)}` : ''}
                  {state.sizeBytes ? ` (${size(state.sizeBytes)})` : ''}.
                  {state.expiresAt && <> Disponible jusqu’au {parisDateTime(state.expiresAt)}.</>}
                </p>
                <Button size="sm" asChild>
                  {/* Route authentifiée : redirige vers un lien de stockage à durée courte. */}
                  <a href={downloadUrl} rel="noopener">
                    <Download className="w-4 h-4 mr-1.5" />
                    Télécharger l’archive
                  </a>
                </Button>
              </div>
            )}

            {state?.status === 'error' && (
              <p className="text-sm text-destructive">
                La préparation de votre dernière archive a échoué. Vous pouvez relancer la demande.
              </p>
            )}
            {expired && (
              <p className="text-sm text-muted-foreground">
                Votre dernière archive a expiré. Demandez-en une nouvelle si besoin.
              </p>
            )}

            {actionError && <p className="text-sm text-destructive">{actionError}</p>}

            <Button
              variant={state?.status === 'ready' && !expired ? 'outline' : 'default'}
              size="sm"
              onClick={requestExport}
              disabled={submitting || inProgress}
            >
              {submitting ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-1.5" />}
              {state?.status === 'ready' && !expired ? 'Générer une nouvelle archive' : 'Exporter mes données'}
            </Button>
          </div>
        )}
      </CollapsibleCard>
    </div>
  );
}
