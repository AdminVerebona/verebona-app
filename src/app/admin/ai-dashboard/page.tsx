"use client";

/**
 * Admin — Tableau de bord IA — CDC BO IA SCR-01.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * QUATRE CRITÈRES D'ACCEPTATION, ET CE QU'ILS IMPOSENT
 *
 * « L'administrateur identifie en moins d'un écran la version réellement active
 * et l'état des traitements » (T1, T2, T3, T4, T6 — T5 retiré au lot 49). Bandeau et cartes de santé sont donc au-dessus de tout le
 * reste, et tiennent sans défilement.
 *
 * « Emergency Stop accessible sans navigation secondaire. » Il est dans
 * l'en-tête, visible en permanence — engagé comme relâché.
 *
 * « Chaque alerte ouvre directement la vue détaillée pertinente. » Chaque
 * alerte est un lien, et sa destination vient du serveur : la calculer ici
 * ferait diverger l'écran du jour où un type d'alerte s'ajoute.
 *
 * « Le Dashboard ne propose pas de bouton d'activation/désactivation local d'un
 * traitement. » Les cartes affichent l'état, sans le commander. C'est la
 * décision UI du §3 : l'activation se fait depuis l'onglet du traitement, et
 * dupliquer la commande ferait douter de laquelle fait foi.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LA VERSION ACTIVE N'EST PAS TOUJOURS CELLE QUI S'EXÉCUTE
 *
 * En préproduction, le VER-004 fait primer une version « À tester ». Afficher
 * la seule Active laisserait lire une configuration en croyant lire celle qui
 * tourne — et diagnostiquer un comportement à partir du mauvais texte.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CHAMPS DU §28 (SCR-01)
 *
 * · VER-01 : vN, libellé, UID abrégé et date d'activation de la version
 *   active (et de la version effective quand une « À tester » prime).
 * · GST-01 : pastille « Opérationnel » / « Arrêt d'urgence », sans état
 *   « dégradé » inventé.
 * · PER-01 : sélecteur 24 h / 7 j / 30 j — ne change que la lecture des
 *   métriques (activité, erreurs, coûts), jamais les données.
 * · DRF-01 : liste des brouillons (libellé, base, obsolète, date, auteur),
 *   chacun ouvrable dans la Configuration IA ; création sur place.
 */

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import {
  Loader2, RefreshCw, AlertTriangle, Info, ArrowRight, Plus,
} from 'lucide-react';
import { toast } from 'sonner';
import { EcranEnErreur } from '@/components/admin/EcranEnErreur';
import { apiClient } from '@/lib/api-client';
import { formatDateTime } from '@/lib/admin/format';
import {
  DASHBOARD_WINDOWS,
  DASHBOARD_WINDOW_LABELS,
  DEFAULT_DASHBOARD_WINDOW,
  type DashboardWindow,
} from '@/lib/admin/ai-dashboard';
import { EmergencyStopControl } from './_components/AiEnvBanner';
import { ObservabilityPanel } from './_components/ObservabilityPanel';
import { CachesPanel } from './_components/CachesPanel';
import type { TreatmentSummary } from '@/services/ai/business-execution/types';

type Treatment = 'T1' | 'T2' | 'T3' | 'T4' | 'T6';
type State = 'ENABLED' | 'DISABLED' | 'SUSPENDED';

interface Health {
  treatment: Treatment; label: string; batch: boolean;
  state: State; suspendedReason: string | null; nextProbeAt: string | null;
  primaryModel: string | null; pending: number; running: number; failed: number;
  /** MOD-008 : modèles à dix échecs consécutifs ou plus pour ce traitement. */
  alertingModels?: Array<{ model: string; consecutiveFailures: number }>;
  /** Lot 83C : issues MÉTIER de la fenêtre (chaque exécution comptée une fois). */
  executions?: TreatmentSummary | null;
  /** HLT-01 / PER-01 / VOL-01 : activité (appels modèle), `null` si indisponible. */
  activity?: {
    calls24h: number; calls7d: number; calls30d: number;
    successRate7d: number | null; lastCallAt: string | null; lastErrorAt: string | null;
    /** PER-01 : chiffres de la fenêtre choisie. */
    window?: { calls: number; failed: number; successRate: number | null };
  } | null;
}

interface Alert { severity: 'critical' | 'warning' | 'info'; message: string; href: string }

interface Version {
  id: number; status: string; visibleNumber: number | null;
  label: string | null; isStale: boolean; createdAt: string;
}

interface Package {
  id: number; uid: string; visibleNumber: number; label: string | null;
  sourceEnvironment: string; importedAt: string | null;
}

interface Degraded { source: string; message: string }

/** DRF-01 / lot 54 : version non active détaillée. */
interface Draft {
  id: number; uid: string; visibleNumber?: number | null; revisionNumber?: number | null; label: string | null; isStale: boolean; createdAt: string;
  base: { id: number; visibleNumber: number | null; label: string | null } | null;
  author: string | null;
}

interface VersionRef {
  id: number; visibleNumber: number | null; label: string | null;
  uid?: string; shortUid?: string; activatedAt?: string | null;
  /** Lot 54 : révision courante de la version active. */
  revisionNumber?: number | null;
}

interface Dashboard {
  environment: string;
  isProduction: boolean;
  emergencyStop: { active: boolean; reason: string | null };
  /** GST-01 */
  globalStatus?: { key: 'operational' | 'emergency_stop'; label: string };
  windowDays?: number;
  activeVersion: VersionRef | null;
  effectiveVersion: (VersionRef & { status: string; validatedAt?: string | null }) | null;
  drafts?: Draft[];
  health: Health[];
  versions: Version[];
  packages: Package[];
  alerts: Alert[];
  /** Sources qui n'ont pas répondu : l'écran s'affiche sans elles, en le disant. */
  degraded?: Degraded[];
  costs: { functionalMicros: number; technicalMicros: number; calls: number; failedCalls: number };
}

/** VER-01 : « v3 — Libellé · UID 1a2b3c4d · activée le … ». */
function versionLine(v: VersionRef, dateLabel: string, date: string | null | undefined): string {
  return [
    `v${v.visibleNumber ?? '?'}${v.revisionNumber ? ` · r${v.revisionNumber}` : ''}${v.label ? ` — ${v.label}` : ''}`,
    v.shortUid ? `UID ${v.shortUid}` : null,
    date ? `${dateLabel} ${formatDateTime(date)}` : null,
  ].filter(Boolean).join(' · ');
}

const STATE_STYLE: Record<State, string> = {
  ENABLED: 'text-[color:var(--text-success)]',
  DISABLED: 'text-[color:var(--text-muted)]',
  SUSPENDED: 'text-[color:var(--text-warning-soft)]',
};

const STATE_LABEL: Record<State, string> = {
  ENABLED: 'Actif', DISABLED: 'Désactivé', SUSPENDED: 'Suspendu',
};

const SEVERITY_STYLE = {
  critical: 'border-[color:var(--border-danger)] bg-[color:var(--bg-danger)] text-[color:var(--text-danger)]',
  warning: 'border-[color:var(--border-warning)] bg-[color:var(--bg-warning)] text-[color:var(--text-warning-soft)]',
  info: 'border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] text-[color:var(--text-secondary)]',
};

function usd(micros: number): string {
  return micros === 0 ? '0 $' : `${(micros / 1_000_000).toFixed(2)} $`;
}

export default function AiDashboardPage() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [erreur, setErreur] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // PER-01 : fenêtre de lecture des métriques.
  const [days, setDays] = useState<DashboardWindow>(DEFAULT_DASHBOARD_WINDOW);

  const load = useCallback(async () => {
    try {
      setData(await apiClient.get<Dashboard>(`/api/admin/ai/dashboard?days=${days}`));
      setErreur(null);
    } catch (e) {
      // Message ET code du serveur. Le code — VERSION_NOT_FOUND,
      // CONFIG_OPERATION_FAILED — est stable et cherchable dans le dépôt ;
      // le message seul obligerait à ouvrir les outils de développement.
      const err = e as { message?: string; code?: string; status?: number };
      setErreur([err.message, err.code && `(${err.code}${err.status ? ` — ${err.status}` : ''})`]
        .filter(Boolean).join(' ') || null);
      toast.error('Chargement impossible.');
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => { load(); }, [load]);

  const createDraft = async () => {
    setBusy(true);
    try {
      await apiClient.post('/api/admin/ai/config-versions', {});
      toast.success('Version créée (non active)');
      await load();
    } catch {
      toast.error('Création impossible.');
    } finally { setBusy(false); }
  };


  if (erreur) {
    return <EcranEnErreur titre="Tableau de bord indisponible" message={erreur} onRetry={load} />;
  }

  if (loading || !data) {
    return (
      <div className="flex items-center justify-center py-20 text-[color:var(--text-muted)]">
        <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Chargement…
      </div>
    );
  }

  // DRF-01 / lot 54 : versions NON actives (plus de brouillons) ; à défaut
  // (source dégradée), celles de la liste des versions, sans base ni auteur.
  const drafts: Draft[] = data.drafts ?? data.versions
    .filter((v) => v.status !== 'ACTIVE')
    .map((v) => ({ id: v.id, uid: '', visibleNumber: v.visibleNumber, label: v.label, isStale: false, createdAt: v.createdAt, base: null, author: null }));
  const status = data.globalStatus
    ?? (data.emergencyStop.active
      ? { key: 'emergency_stop' as const, label: 'Arrêt d’urgence' }
      : { key: 'operational' as const, label: 'Opérationnel' });
  const windowLabel = DASHBOARD_WINDOW_LABELS[days];

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Bandeau environnement — production non masquable */}
      <div className={`rounded-xl border p-4 ${data.isProduction
        ? 'border-[color:var(--border-danger)] bg-[color:var(--bg-danger)]'
        : 'border-[color:var(--border-subtle)] bg-[color:var(--bg-card)]'}`}>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="vb-app-title">
                Configuration IA — {data.environment}
              </h1>
              {/* GST-01 : état global, deux valeurs seulement. */}
              <span
                role="status"
                data-testid="ai-global-status"
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${
                  status.key === 'emergency_stop'
                    ? 'border-[color:var(--border-danger)] bg-[color:var(--bg-danger)] text-[color:var(--text-danger)]'
                    : 'border-[color:var(--border-success)] bg-[color:var(--bg-success)] text-[color:var(--text-success)]'}`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${status.key === 'emergency_stop' ? 'bg-[color:var(--danger)]' : 'bg-[color:var(--accent)]'}`} />
                {status.label}
              </span>
            </div>
            {/* VER-01 : vN, libellé, UID abrégé, date d'activation. */}
            <p className="text-sm text-[color:var(--text-secondary)]">
              {data.activeVersion
                ? <>Version active : {versionLine(data.activeVersion, 'activée le', data.activeVersion.activatedAt)}</>
                : 'Aucune version active.'}
            </p>
            {data.effectiveVersion && (
              <p className="text-sm text-[color:var(--text-warning-soft)]">
                Version effective (à l&apos;essai) :{' '}
                {versionLine(data.effectiveVersion, 'validée le', data.effectiveVersion.validatedAt)}
              </p>
            )}
          </div>

          {/* EST-01 : engagement (motif obligatoire) et relâchement (confirmé)
              directement ici, sans passer par la File IA. */}
          <EmergencyStopControl
            stop={{ active: data.emergencyStop.active, reason: data.emergencyStop.reason, engagedAt: null }}
            onChange={load}
          />
          <Button size="sm" variant="ghost" onClick={load} disabled={busy}>
            <RefreshCw className="w-3.5 h-3.5" />
          </Button>
        </div>

        {data.isProduction && (
          <p className="text-xs text-[color:var(--text-danger)] mt-2">
            Environnement de production. Toute activation s&apos;applique aux comptes réels.
          </p>
        )}
      </div>

      {/* Sources indisponibles — nommées, pas tues : sans cela, des zéros se
          liraient comme des mesures. */}
      {(data.degraded?.length ?? 0) > 0 && (
        <div className="rounded-xl border border-[color:var(--border-warning)] bg-[color:var(--bg-warning)] p-3 space-y-1">
          <p className="text-sm font-medium text-[color:var(--text-warning-soft)]">
            Tableau de bord partiel
          </p>
          {data.degraded!.map((d, i) => (
            <p key={i} className="text-xs text-[color:var(--text-secondary)]">
              {d.source} : {d.message}
            </p>
          ))}
          <p className="text-xs text-[color:var(--text-muted)]">
            Les chiffres de ces sections sont absents, pas nuls.
          </p>
        </div>
      )}

      {/* Alertes — chacune mène à sa vue */}
      {data.alerts.length > 0 && (
        <div className="space-y-2">
          {data.alerts.map((a, i) => (
            <Link key={i} href={a.href}
              className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 text-sm hover:opacity-80 transition-opacity ${SEVERITY_STYLE[a.severity]}`}>
              {a.severity === 'info'
                ? <Info className="w-4 h-4 shrink-0" />
                : <AlertTriangle className="w-4 h-4 shrink-0" />}
              <span className="flex-1">{a.message}</span>
              <ArrowRight className="w-3.5 h-3.5 shrink-0" />
            </Link>
          ))}
        </div>
      )}

      {/* PER-01 : fenêtre de supervision — lecture seule des métriques */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="vb-app-section">Santé des traitements</h2>
        <div role="group" aria-label="Fenêtre de supervision" className="inline-flex rounded-lg border border-[color:var(--border-subtle)] p-0.5">
          {DASHBOARD_WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              aria-pressed={days === w}
              onClick={() => setDays(w)}
              className={`px-2.5 py-1 text-xs rounded-md transition-colors ${days === w
                ? 'bg-[color:var(--accent-soft)] text-[color:var(--text-primary)] font-medium'
                : 'text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)]'}`}
            >
              {DASHBOARD_WINDOW_LABELS[w]}
            </button>
          ))}
        </div>
      </div>

      {/* Santé des cinq traitements — état affiché, jamais commandé */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {data.health.map((h) => (
          <div key={h.treatment}
            className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-3 space-y-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-sm font-semibold text-[color:var(--text-primary)]">
                {h.treatment}
              </span>
              <span className={`text-xs ${STATE_STYLE[h.state]}`}>{STATE_LABEL[h.state]}</span>
            </div>
            <p className="text-xs text-[color:var(--text-muted)] truncate">{h.label}</p>
            <p className="text-xs text-[color:var(--text-muted)] font-mono truncate">
              {h.primaryModel ?? 'aucun modèle'}
            </p>
            {h.batch ? (
              <p className="text-xs text-[color:var(--text-secondary)]">
                {h.pending} en attente · {h.running} en cours
                {h.failed > 0 && <span className="text-[color:var(--text-danger)]"> · {h.failed} en échec</span>}
              </p>
            ) : (
              <p className="text-xs text-[color:var(--text-muted)]">Répond en direct</p>
            )}
            {/* Lot 83C (BO-04, SEM-05) : issue MÉTIER — réussies et en cours. Lot 84D (BO-11,
                C-Q9, décision PO 12) : les échecs et incomplètes ne sont NI comptés NI signalés
                ici — leur source unique est la carte d'Exécutions & logs, à laquelle on renvoie. */}
            {h.executions && (
              <p className="text-xs" data-testid="dashboard-business-executions">
                <span className="text-[color:var(--text-secondary)]">Exécutions {windowLabel} : </span>
                <span className="text-[color:var(--text-success)]">{h.executions.succeeded} réussie{h.executions.succeeded > 1 ? 's' : ''}</span>
                {h.executions.notFinal > 0 && <span className="text-[color:var(--text-muted)]"> · {h.executions.notFinal} en cours</span>}
                {h.executions.failed + h.executions.incomplete > 0 && (
                  <Link href={`/admin/ai-executions?treatment=${h.treatment}`} className="block text-[color:var(--accent)] hover:underline" data-testid="dashboard-executions-pointer">
                    Échecs ou incomplètes : voir Exécutions &amp; logs
                  </Link>
                )}
              </p>
            )}
            {/* HLT-01 / PER-01 / VOL-01 : volumes, succès, dernière exécution —
                lien préfiltré vers les exécutions du traitement (ALT-01). */}
            {h.activity && (
              <Link href={`/admin/ai-executions?treatment=${h.treatment}`} className="block text-xs text-[color:var(--text-muted)] hover:underline">
                {(() => {
                  const w = h.activity.window
                    ?? { calls: h.activity.calls7d, failed: 0, successRate: h.activity.successRate7d };
                  return (
                    <>
                      {/* Lot 83C (SEM-05) : statut FOURNISSEUR des appels, pas l'issue métier. */}
                      Appels modèle {windowLabel} : {w.calls}
                      {w.failed > 0 && <span className="text-[color:var(--text-warning-soft)]"> · {w.failed} en échec</span>}
                      {w.successRate !== null && (
                        <span className={w.successRate < 0.9 ? ' text-[color:var(--text-warning-soft)]' : ''}>
                          {' '}· {Math.round(w.successRate * 100)} % d’appels aboutis
                        </span>
                      )}
                    </>
                  );
                })()}
                {h.activity.lastCallAt && (
                  <span className="block">
                    Dernier appel : {formatDateTime(h.activity.lastCallAt)}
                  </span>
                )}
              </Link>
            )}
            {h.suspendedReason && (
              <p className="text-xs text-[color:var(--text-warning-soft)] line-clamp-2">{h.suspendedReason}</p>
            )}
            {/* WF-09 étape 53 : prochaine tentative de recovery (sonde). */}
            {h.state === 'SUSPENDED' && h.nextProbeAt && (
              <p className="text-xs text-[color:var(--text-muted)]">
                Prochaine sonde : {new Date(h.nextProbeAt).toLocaleTimeString('fr-FR')}
              </p>
            )}
            {/* MOD-008 / OPS-019 : alerte modèle informationnelle, sans arrêt. */}
            {(h.alertingModels ?? []).map((m) => (
              <p key={m.model} className="text-xs text-[color:var(--text-warning-soft)] flex items-center gap-1" title="Alerte modèle (MOD-008) : se résout au premier succès de ce modèle.">
                <AlertTriangle className="w-3 h-3 shrink-0" />
                <span className="font-mono truncate">{m.model}</span>
                <span className="shrink-0">· {m.consecutiveFailures} échecs</span>
              </p>
            ))}
          </div>
        ))}
      </div>

      {/* §18 (CDC 15, lot 17) : indicateurs par traitement, même fenêtre,
          filtre de version et d'environnement — section repliée, chargée à
          l'ouverture. */}
      <ObservabilityPanel days={days} versions={data.versions} environment={data.environment} />

      {/* Lot 23 (§32.6) : état et invalidation des caches, export CSV des
          métriques agrégées — section repliée, chargée à l'ouverture. */}
      <CachesPanel />

      {/* Versions */}
      <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="vb-app-section">Versions</h2>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={createDraft} disabled={busy}>
              <Plus className="w-3.5 h-3.5 mr-1.5" /> Nouvelle version
            </Button>
            <Link href="/admin/ai-config">
              <Button size="sm" variant="ghost">Ouvrir</Button>
            </Link>
          </div>
        </div>

        <p className="text-sm text-[color:var(--text-secondary)]">
          {drafts.length} version{drafts.length > 1 ? 's' : ''} non active{drafts.length > 1 ? 's' : ''}
        </p>

        {/* DRF-01 / lot 54 : numéro, nom, origine, date, auteur ; ouvrir. */}
        {drafts.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="ai-drafts">
              <thead>
                <tr className="text-left text-xs text-[color:var(--text-muted)]">
                  <th className="py-1.5 pr-3 font-medium">Version</th>
                  <th className="py-1.5 pr-3 font-medium">Origine</th>
                  <th className="py-1.5 pr-3 font-medium">Créé le</th>
                  <th className="py-1.5 pr-3 font-medium">Auteur</th>
                  <th className="py-1.5" />
                </tr>
              </thead>
              <tbody>
                {drafts.map((d) => (
                  <tr key={d.id} className="border-t border-[color:var(--border-subtle)]">
                    <td className="py-1.5 pr-3 text-[color:var(--text-primary)]">
                      {`v${d.visibleNumber ?? d.id}${d.revisionNumber ? ` · r${d.revisionNumber}` : ''}`}{d.label ? ` — ${d.label}` : ''}
                    </td>
                    <td className="py-1.5 pr-3 text-[color:var(--text-secondary)]">
                      {d.base
                        ? `v${d.base.visibleNumber ?? '?'}${d.base.label ? ` — ${d.base.label}` : ''}`
                        : '—'}
                    </td>
                    <td className="py-1.5 pr-3 text-xs text-[color:var(--text-secondary)]">{formatDateTime(d.createdAt)}</td>
                    <td className="py-1.5 pr-3 text-xs text-[color:var(--text-secondary)]">{d.author ?? '—'}</td>
                    <td className="py-1.5 text-right">
                      <Link href={`/admin/ai-config?version=${d.id}`} className="text-xs text-[color:var(--accent)] hover:underline">
                        Ouvrir
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!data.activeVersion && (
          <p className="text-sm text-[color:var(--text-warning-soft)]">
            Aucune configuration active : les traitements utilisent les valeurs du code.
            Créez une version, puis activez-la en préproduction.
          </p>
        )}
      </div>

      {/* Lot 54 : plus de mise en production depuis le BO — export du fichier
          de configuration (Configuration IA), packages antérieurs en historique. */}
      <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 space-y-2">
        <h2 className="vb-app-section">
          Export de la configuration
        </h2>
        <p className="text-sm text-[color:var(--text-muted)]">
          Le paramétrage de la production se fait séparément, à partir du fichier « Exporter la configuration »
          (<Link href="/admin/ai-config" className="text-[color:var(--accent)] hover:underline">Configuration IA</Link>).
          Aucune publication en production n’est faite depuis le back-office.
        </p>
        {data.packages.length > 0 && data.packages.map((p) => (
          <p key={p.id} className="text-xs text-[color:var(--text-muted)]">
            Ancien package v{p.visibleNumber}{p.label ? ` — ${p.label}` : ''} · depuis {p.sourceEnvironment}
            {p.importedAt ? ` · importé le ${formatDateTime(p.importedAt)}` : ''}
          </p>
        ))}
      </div>

      {/* Coûts */}
      <Link href="/admin/ai-costs"
        className="block rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 hover:opacity-80 transition-opacity">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="vb-app-section">
            Dépense — {windowLabel === '24 h' ? 'dernières 24 h' : `${windowLabel.replace(' j', '')} derniers jours`}
          </h2>
          <ArrowRight className="w-3.5 h-3.5 text-[color:var(--text-muted)]" />
        </div>
        <p className="text-sm text-[color:var(--text-secondary)]">
          {usd(data.costs.functionalMicros)} métier · {usd(data.costs.technicalMicros)} technique
          <span className="text-[color:var(--text-muted)]">
            {' '}· {data.costs.calls} appels modèle, dont {data.costs.failedCalls} en échec (technique)
          </span>
        </p>
      </Link>
    </div>
  );
}
