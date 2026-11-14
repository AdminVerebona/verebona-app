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
 *     Lot 49 (ticket 11) : REGROUPÉ par modèle — « 1 modèle actif
 *     indisponible — 5 usages impactés » — avec, pour chaque modèle, ses
 *     usages (traitement, rang) et le diagnostic du dernier contrôle :
 *     statut (ok | inconclusive | suspect | failed_confirmed), message
 *     Google nettoyé (aucun secret), date et source. La cause se lit sans
 *     consultation SQL.
 *     Lot 114 (carte #771) : code HTTP et code Google, accès concerné
 *     (pseudonymisé), prochaine sonde ; et, à part, la « Surveillance des
 *     sondes » : incident global du fournisseur, modèles `suspect` et
 *     `inconclusive` (qui restent appelables), décompte des contrôles.
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
interface ModelUsage {
  treatment: string; rank: string; rankLabel: string; source: string; fallbackAvailable: boolean;
  /** Lot 87A (INV-10) : secours que la passerelle choisira (absent : état de qualification non lu). */
  secours?: { model: string | null; decision: 'QUALIFIED' | 'MANUAL_UNTESTED' | 'NONE'; label: string };
}
interface ModelDiagnostic {
  status: 'ok' | 'inconclusive' | 'suspect' | 'failed_confirmed' | 'unknown';
  operational: boolean | null;
  error: string | null;
  errorKindLabel: string | null;
  checkedAt: string | null;
  sourceLabel: string | null;
  /** Lot 114 (#771) — absents : serveur ou schéma antérieur. */
  httpStatus?: number | null;
  providerCode?: string | null;
  access?: string | null;
  nextProbeAt?: string | null;
}
interface WatchEntry {
  model: string; status: 'suspect' | 'inconclusive'; error: string | null; errorKindLabel: string | null;
  httpStatus: number | null; providerCode: string | null; checkedAt: string; sourceLabel: string; operational: boolean | null;
}
export interface OperationalWatchView {
  providerIncident: { kindLabel: string; error: string | null; checkedAt: string; access: string | null; models: string[] } | null;
  suspect: WatchEntry[];
  inconclusive: WatchEntry[];
  summary: string;
}
interface UnavailableModelGroupView {
  model: string;
  usages: ModelUsage[];
  reasonText: string;
  severity: 'critical' | 'warning';
  diagnostic: ModelDiagnostic;
}
interface CatalogStatus {
  newModels: AnnouncedModel[];
  banner: { title: string; body: string } | null;
  anomalies: Anomaly[];
  /** Lot 49 : anomalies regroupées par modèle (absent : serveur antérieur). */
  unavailableModels?: UnavailableModelGroupView[];
  unavailableTitle?: string | null;
  /** Lot 114 (#771) : états suspect / inconclusive et incident global (absent : serveur antérieur). */
  operationalWatch?: OperationalWatchView;
}

const STATUT_CONTROLE: Record<ModelDiagnostic['status'], string> = {
  ok: 'ok — le modèle répond',
  inconclusive: 'inconclusive — contrôle non concluant, état conservé',
  suspect: 'suspect — échec à confirmer par un second contrôle',
  failed_confirmed: 'failed_confirmed — indisponibilité confirmée',
  unknown: 'inconnu — jamais contrôlé avec la clé active',
};

function dateCourte(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
}

/** Bloc d'un modèle indisponible : usages et diagnostic (même rendu desktop / mobile). */
export function UnavailableModelCard({ group }: { group: UnavailableModelGroupView }) {
  const d = group.diagnostic;
  return (
    <li data-testid="unavailable-model" className="rounded-lg border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-2.5 sm:p-3 space-y-1.5 min-w-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <code className="text-xs font-semibold text-[color:var(--text-primary)] break-all">{group.model}</code>
        <span className={`text-[11px] px-1.5 py-0.5 rounded-full border ${group.severity === 'critical'
          ? 'border-[color:var(--border-danger)] text-[color:var(--text-danger)]' : 'border-[color:var(--border-warning)] text-[color:var(--text-warning-soft)]'}`}>
          {group.severity === 'critical' ? 'critique' : 'avertissement'}
        </span>
        <span className="text-xs text-[color:var(--text-muted)]">
          {group.usages.length} usage{group.usages.length > 1 ? 's' : ''} impacté{group.usages.length > 1 ? 's' : ''}
        </span>
      </div>
      <ul className="flex flex-wrap gap-1.5" aria-label={`Usages de ${group.model}`}>
        {group.usages.map((u) => (
          <li key={`${u.treatment}-${u.rank}`} className="text-[11px] px-1.5 py-0.5 rounded border border-[color:var(--border-subtle)] text-[color:var(--text-secondary)] max-w-full break-words">
            {u.treatment} {u.rankLabel}{u.rank === 'primaryModel' && u.secours
              ? (u.secours.model ? ` · ${u.secours.label} : ${u.secours.model}` : ' · aucun secours admissible (suspendu)')
              : u.rank === 'primaryModel' && !u.fallbackAvailable ? ' · sans repli' : ''}
          </li>
        ))}
      </ul>
      <dl className="grid grid-cols-1 sm:grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        <dt className="text-[color:var(--text-muted)]">Motif</dt>
        <dd className="text-[color:var(--text-primary)] break-words">{group.reasonText}</dd>
        <dt className="text-[color:var(--text-muted)]">Dernier contrôle</dt>
        <dd className="text-[color:var(--text-primary)] break-words" data-testid="unavailable-model-status">{STATUT_CONTROLE[d.status] ?? d.status}</dd>
        {d.error && (
          <>
            <dt className="text-[color:var(--text-muted)]">Réponse Google</dt>
            <dd className="text-[color:var(--text-primary)] break-words" data-testid="unavailable-model-error">
              {d.error}{d.errorKindLabel ? ` (${d.errorKindLabel})` : ''}
            </dd>
          </>
        )}
        {(d.httpStatus != null || d.providerCode) && (
          <>
            <dt className="text-[color:var(--text-muted)]">Code</dt>
            <dd className="text-[color:var(--text-primary)] break-words" data-testid="unavailable-model-code">
              {[d.httpStatus != null ? `HTTP ${d.httpStatus}` : null, d.providerCode].filter(Boolean).join(' · ')}
            </dd>
          </>
        )}
        <dt className="text-[color:var(--text-muted)]">Date · source</dt>
        <dd className="text-[color:var(--text-primary)] break-words">{dateCourte(d.checkedAt)} · {d.sourceLabel ?? '—'}</dd>
        {d.access && (
          <>
            <dt className="text-[color:var(--text-muted)]">Accès concerné</dt>
            <dd className="text-[color:var(--text-primary)] break-words" data-testid="unavailable-model-access">{d.access}</dd>
          </>
        )}
        {d.status === 'failed_confirmed' && d.nextProbeAt && (
          <>
            <dt className="text-[color:var(--text-muted)]">Prochaine sonde</dt>
            <dd className="text-[color:var(--text-primary)] break-words" data-testid="unavailable-model-next-probe">au plus tôt le {dateCourte(d.nextProbeAt)}</dd>
          </>
        )}
      </dl>
    </li>
  );
}

function codeDe(e: Pick<WatchEntry, 'httpStatus' | 'providerCode'>): string {
  const c = [e.httpStatus != null ? `HTTP ${e.httpStatus}` : null, e.providerCode].filter(Boolean).join(' · ');
  return c ? ` — ${c}` : '';
}

/**
 * Lot 114 (carte #771, B01 / B04) — surveillance des sondes : incident global du fournisseur et contrôles
 * non concluants ou à confirmer, À PART des indisponibilités confirmées. Aucun de ces modèles n'est écarté.
 * Même rendu desktop et mobile (bloc pleine largeur, textes repliables).
 */
export function OperationalWatchPanel({ watch }: { watch: OperationalWatchView }) {
  const lignes = [...watch.suspect, ...watch.inconclusive];
  if (!watch.providerIncident && lignes.length === 0) return null;
  return (
    <div role="status" data-testid="operational-watch" className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-3 sm:p-4 space-y-2 min-w-0">
      <p className="text-sm font-semibold text-[color:var(--text-primary)] break-words">Surveillance des sondes de modèles</p>
      <p className="text-xs text-[color:var(--text-muted)] break-words">{watch.summary}</p>
      {watch.providerIncident && (
        <div data-testid="provider-incident" className="rounded-lg border border-[color:var(--border-danger)] p-2.5 space-y-0.5 min-w-0">
          <p className="text-xs font-semibold text-[color:var(--text-danger)] break-words">
            Incident global du fournisseur — {watch.providerIncident.kindLabel}
          </p>
          <p className="text-xs text-[color:var(--text-primary)] break-words">
            {watch.providerIncident.error ?? '—'} · {dateCourte(watch.providerIncident.checkedAt)}{watch.providerIncident.access ? ` · ${watch.providerIncident.access}` : ''}
          </p>
          <p className="text-xs text-[color:var(--text-muted)] break-words">
            Aucun modèle n’est déclaré indisponible pour ce motif ({watch.providerIncident.models.length} sonde{watch.providerIncident.models.length > 1 ? 's' : ''} sans conclusion).
          </p>
        </div>
      )}
      {lignes.length > 0 && (
        <ul className="space-y-1.5">
          {lignes.map((e) => (
            <li key={`${e.status}-${e.model}`} data-testid={`watch-${e.status}`} className="text-xs text-[color:var(--text-primary)] break-words">
              <code className="font-semibold break-all">{e.model}</code>{' '}
              <span className="text-[color:var(--text-muted)]">
                {e.status === 'suspect' ? 'suspect — échec à confirmer, modèle toujours appelable' : 'inconclusive — rien n’est conclu, état conservé'}
              </span>
              {e.error ? ` : ${e.error}` : ''}{e.errorKindLabel ? ` (${e.errorKindLabel})` : ''}{codeDe(e)} · {dateCourte(e.checkedAt)} · {e.sourceLabel}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
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

  const veille = data?.operationalWatch;
  const veilleVisible = Boolean(veille && (veille.providerIncident || veille.suspect.length > 0 || veille.inconclusive.length > 0));
  if (!data || (!data.banner && data.anomalies.length === 0 && !veilleVisible)) return null;

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
              <p className="text-xs text-[color:var(--text-warning-soft)]">
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
        <div role="alert" data-testid="active-model-anomalies" className="rounded-xl border border-[color:var(--border-warning)] bg-[color:var(--bg-warning)] p-3 sm:p-4 space-y-2">
          <p className="text-sm font-semibold text-[color:var(--text-warning-soft)] flex items-start gap-1.5">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden />
            <span className="break-words">
              {data.unavailableTitle
                ?? (data.anomalies.length === 1 ? 'Modèle actif indisponible' : `${data.anomalies.length} usages de modèles actifs indisponibles`)}
            </span>
          </p>
          {data.unavailableModels?.length ? (
            <ul className="space-y-2">
              {data.unavailableModels.map((g) => <UnavailableModelCard key={g.model} group={g} />)}
            </ul>
          ) : (
            <ul className="space-y-1">
              {data.anomalies.map((a) => (
                <li key={`${a.treatment}-${a.rank}-${a.model}`} className="text-xs text-[color:var(--text-primary)] break-words">{a.message}</li>
              ))}
            </ul>
          )}
          <p className="text-xs text-[color:var(--text-muted)]">
            Aucun remplacement automatique : les chaînes de repli restent appliquées. Pour changer de modèle, créez une nouvelle version de configuration.
          </p>
        </div>
      )}

      {veille && veilleVisible && <OperationalWatchPanel watch={veille} />}
    </div>
  );
}
