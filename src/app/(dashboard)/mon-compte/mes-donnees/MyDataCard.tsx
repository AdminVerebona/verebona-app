'use client';

/**
 * Mon compte → « Mes données » : export RGPD — CDC Back-Office V1 GDP-020 à
 * GDP-022.
 *
 * Distinct des exports fonctionnels des biens : il rassemble TOUTES les
 * données du compte et de l'utilisateur (droit d'accès et portabilité), au
 * format JSON, avec les documents déposés, dans une archive ZIP.
 *
 * Lot 103C (ticket P1 « Fiabilisation de l'export », §3 C et F) :
 *  · client HTTP commun (`apiClient`) : renouvellement de session sécurisé
 *    (jeton d'accès de 15 min expiré pendant que l'écran est ouvert — iOS
 *    comme Web), en-têtes de plateforme, budgets, codes d'erreur. Un POST
 *    n'est jamais rejoué implicitement ; la clé d'idempotence
 *    (`Idempotency-Key`) est CONSERVÉE après un échec réseau ou une réponse
 *    illisible : la nouvelle tentative de l'utilisateur renvoie la même
 *    demande au lieu d'en créer une seconde ;
 *  · après un échec de la demande, l'état est RELU : une demande
 *    enregistrée malgré une réponse perdue s'affiche « en cours » ;
 *  · UN seul message (calculé par le serveur, `export-state.ts`) et le
 *    bouton seulement quand il peut servir ; jamais l'ancien échec et
 *    l'erreur de relance à la fois ; référence à donner au support.
 *
 * Génération asynchrone : le bloc interroge l'état toutes les 5 s tant qu'il
 * est affiché, et une notification prévient quand l'archive est prête. Le
 * lien de téléchargement exige la session et expire (GDP-022).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { CollapsibleCard } from '@/components/ui/collapsible-card';
import { Button } from '@/components/ui/button';
import { Database, Download, Loader2, RefreshCw } from 'lucide-react';
import { apiClient, ApiClientError } from '@/lib/api-client';
import { publicSiteUrl } from '@/lib/external-urls';
import { requestErrorMessage, type GdprExportView } from '@/services/gdpr/export-state';

type ExportStatus = 'pending' | 'generating' | 'ready' | 'error' | 'expired';

interface ExportState {
  id: number;
  status: ExportStatus;
  createdAt: string;
  completedAt: string | null;
  expiresAt: string | null;
  sizeBytes: number | null;
  error: string | null;
  completeness?: 'complete' | 'partial' | null;
  missing?: Array<{ label: string; reason: string }>;
  missingCount?: number;
  view?: GdprExportView;
}

/** Lot 102C : partie téléchargeable de l'archive. */
interface ExportPart {
  number: number;
  sizeBytes: number | null;
  documents: number;
  downloadUrl: string;
}

interface ExportResponse {
  export: ExportState | null;
  downloadUrl: string | null;
  parts?: ExportPart[];
  view?: GdprExportView | null;
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

function newRequestKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return `mes-donnees-${c?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`}`;
}

function errorOf(e: unknown): { status: number; code: string | null; message: string | null; requestId: string | null } {
  if (e instanceof ApiClientError) return { status: e.status, code: e.code, message: e.serverMessage ?? null, requestId: e.requestId ?? null };
  return { status: 0, code: 'NETWORK_ERROR', message: null, requestId: null };
}

/** `defaultOpen` : tiroir ouvert d'emblée (page « Compte en cours de suppression »). */
export function MyDataCard({ defaultOpen = false }: { defaultOpen?: boolean } = {}) {
  const [state, setState] = useState<ExportState | null>(null);
  const [view, setView] = useState<GdprExportView | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [parts, setParts] = useState<ExportPart[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const poll = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Clé de la demande en cours d'envoi : gardée tant que la réponse n'a pas été lue. */
  const pendingKey = useRef<string | null>(null);

  const apply = (data: ExportResponse) => {
    setState(data.export);
    setView(data.view ?? data.export?.view ?? null);
    setDownloadUrl(data.downloadUrl);
    setParts(Array.isArray(data.parts) ? data.parts : []);
  };

  const load = useCallback(async (): Promise<ExportResponse | null> => {
    try {
      setLoadError(null);
      const data = await apiClient.fetch<ExportResponse>(ENDPOINT, { cache: 'no-store' });
      if (!data || typeof data !== 'object' || !('export' in data)) throw new ApiClientError(0, 'INVALID_RESPONSE');
      apply(data);
      return data;
    } catch (e) {
      const err = errorOf(e);
      if (err.code !== 'REQUEST_ABORTED') setLoadError(`Impossible de charger l’état de votre export.${err.requestId ? ` (référence ${err.requestId.slice(0, 8).toUpperCase()})` : ''}`);
      return null;
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
    pendingKey.current ??= newRequestKey();
    try {
      const data = await apiClient.fetch<ExportResponse>(ENDPOINT, {
        method: 'POST',
        headers: { 'Idempotency-Key': pendingKey.current },
      });
      if (!data || typeof data !== 'object' || !('export' in data)) throw new ApiClientError(0, 'INVALID_RESPONSE');
      pendingKey.current = null;
      apply(data);
    } catch (e) {
      const err = errorOf(e);
      // Refus définitif (ni réseau ni réponse illisible) : la clé peut être renouvelée.
      const uncertain = err.status === 0 || err.status >= 500 || err.code === 'INVALID_RESPONSE' || err.code === 'UNKNOWN_ERROR';
      if (!uncertain) pendingKey.current = null;
      // La demande a-t-elle été enregistrée malgré tout ? L'état fait foi.
      const fresh = uncertain ? await load() : null;
      const recorded = fresh?.export && (fresh.export.status === 'pending' || fresh.export.status === 'generating');
      if (recorded) pendingKey.current = null;
      else if (err.code !== 'REQUEST_ABORTED') setActionError(requestErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const kind = view?.kind ?? (inProgress ? 'in_progress' : state ? null : 'none');
  const readyLike = (kind === 'ready' || kind === 'partial') && downloadUrl && state?.status === 'ready';
  // Un seul message d'alerte à la fois : l'erreur de la demande remplace l'ancien échec.
  const showViewMessage = !(actionError && (kind === 'interrupted' || kind === 'needs_support' || kind === 'none' || kind === 'expired'));

  return (
    <div>
      <CollapsibleCard
        anchorId="mes-donnees"
        defaultOpen={defaultOpen}
        icon={<Database className="w-5 h-5" />}
        title="Mes données"
        description="Téléchargez une copie de toutes vos données personnelles (RGPD)."
        contentClassName="space-y-4"
        // Pas de bouton hors du tiroir (modèle « Informations légales ») : le
        // lien « export prêt » des notifications (#mes-donnees) ouvre le
        // tiroir, où se trouve le téléchargement.
      >
        <p className="text-sm text-muted-foreground">
          L’archive (ZIP) contient les données de votre compte utilisateur et de votre espace Verebona
          au format JSON — biens, documents, échéances, notifications, abonnement… — ainsi que les
          documents que vous avez déposés. Elle est distincte des exports de vos biens.
          Tous vos documents sont inclus : une archive volumineuse est découpée en plusieurs parties.
          Ce téléchargement reste disponible même si votre compte est en lecture seule ou en cours de suppression.
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
          <div className="space-y-3" data-testid="mes-donnees-etat" data-etat={kind ?? ''}>
            {kind === 'in_progress' && view && (
              <div className="flex items-start gap-2 rounded-lg border border-[color:var(--border-subtle)] p-3 text-sm" role="status">
                <Loader2 className="w-4 h-4 mt-0.5 animate-spin shrink-0" />
                <p>{view.message}</p>
              </div>
            )}

            {readyLike && state && (
              <div className="rounded-lg border border-[color:var(--border-subtle)] p-3 text-sm space-y-2">
                <p>
                  {kind === 'partial' ? 'Archive prête mais incomplète' : 'Archive prête'}
                  {state.completedAt ? ` depuis le ${parisDateTime(state.completedAt)}` : ''}
                  {state.sizeBytes ? ` (${size(state.sizeBytes)})` : ''}.
                  {state.expiresAt && <> Disponible jusqu’au {parisDateTime(state.expiresAt)}.</>}
                </p>
                {kind === 'partial' && view && (
                  <div className="space-y-1" role="status">
                    <p>{view.message}</p>
                    {state.missing && state.missing.length > 0 && (
                      <details className="text-xs text-muted-foreground">
                        <summary className="cursor-pointer">Voir les éléments non inclus</summary>
                        <ul className="mt-1 list-disc pl-5 space-y-0.5">
                          {state.missing.map((m, i) => <li key={i}>{m.label} : {m.reason}</li>)}
                          {(state.missingCount ?? 0) > state.missing.length && (
                            <li>… et {(state.missingCount ?? 0) - state.missing.length} autre(s), listés dans manifest.json.</li>
                          )}
                        </ul>
                      </details>
                    )}
                  </div>
                )}
                {parts.length > 1 ? (
                  <div className="space-y-2">
                    <p>
                      Votre archive est découpée en {parts.length} parties pour contenir tous vos documents.
                      Téléchargez chaque partie : la partie 1 contient vos données et l’inventaire complet.
                    </p>
                    <ul className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                      {parts.map((p) => (
                        <li key={p.number}>
                          <Button size="sm" variant={p.number === 1 ? 'default' : 'outline'} asChild className="w-full sm:w-auto">
                            {/* Route authentifiée : redirige vers un lien de stockage à durée courte. */}
                            <a href={p.downloadUrl} rel="noopener">
                              <Download className="w-4 h-4 mr-1.5" />
                              Partie {p.number} sur {parts.length}
                              {p.sizeBytes ? ` (${size(p.sizeBytes)})` : ''}
                            </a>
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <Button size="sm" asChild className="w-full sm:w-auto">
                    {/* Route authentifiée : redirige vers un lien de stockage à durée courte. */}
                    <a href={downloadUrl!} rel="noopener">
                      <Download className="w-4 h-4 mr-1.5" />
                      Télécharger l’archive
                    </a>
                  </Button>
                )}
              </div>
            )}

            {showViewMessage && view && (kind === 'interrupted' || kind === 'needs_support') && (
              <div className="text-sm space-y-1" role="alert">
                <p className="text-destructive">{view.message}</p>
                {kind === 'needs_support' && (
                  <a href={publicSiteUrl('/contact')} className="text-primary underline text-xs" target="_blank" rel="noopener noreferrer">
                    Contacter l’assistance
                  </a>
                )}
              </div>
            )}
            {showViewMessage && view && (kind === 'expired' || kind === 'none') && (
              <p className="text-sm text-muted-foreground">{view.message}</p>
            )}

            {actionError && <p className="text-sm text-destructive" role="alert">{actionError}</p>}

            {(view ? view.canRequest : !inProgress) && (
              <Button
                variant={kind === 'ready' ? 'outline' : 'default'}
                size="sm"
                onClick={requestExport}
                disabled={submitting || inProgress}
                className="w-full sm:w-auto"
              >
                {submitting ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-1.5" />}
                {view?.requestLabel ?? 'Exporter mes données'}
              </Button>
            )}
          </div>
        )}
      </CollapsibleCard>
    </div>
  );
}
