"use client";

/**
 * Admin — Tableau de bord IA — CDC BO IA SCR-01.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * QUATRE CRITÈRES D'ACCEPTATION, ET CE QU'ILS IMPOSENT
 *
 * « L'administrateur identifie en moins d'un écran la version réellement active
 * et l'état T1–T5. » Bandeau et cartes de santé sont donc au-dessus de tout le
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
import { EmergencyStopControl } from './_components/AiEnvBanner';

type Treatment = 'T1' | 'T2' | 'T3' | 'T4' | 'T5' | 'T6';
type State = 'ENABLED' | 'DISABLED' | 'SUSPENDED';

interface Health {
  treatment: Treatment; label: string; batch: boolean;
  state: State; suspendedReason: string | null; nextProbeAt: string | null;
  primaryModel: string | null; pending: number; running: number; failed: number;
  /** MOD-008 : modèles à dix échecs consécutifs ou plus pour ce traitement. */
  alertingModels?: Array<{ model: string; consecutiveFailures: number }>;
  /** HLT-01 / PER-01 / VOL-01 : activité (appels modèle), `null` si indisponible. */
  activity?: {
    calls24h: number; calls7d: number; calls30d: number;
    successRate7d: number | null; lastCallAt: string | null; lastErrorAt: string | null;
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

interface Dashboard {
  environment: string;
  isProduction: boolean;
  emergencyStop: { active: boolean; reason: string | null };
  activeVersion: { id: number; visibleNumber: number | null; label: string | null } | null;
  effectiveVersion: { id: number; status: string; visibleNumber: number | null } | null;
  health: Health[];
  versions: Version[];
  packages: Package[];
  alerts: Alert[];
  /** Sources qui n'ont pas répondu : l'écran s'affiche sans elles, en le disant. */
  degraded?: Degraded[];
  costs7d: { functionalMicros: number; technicalMicros: number; calls: number; failedCalls: number };
}

const STATE_STYLE: Record<State, string> = {
  ENABLED: 'text-emerald-500',
  DISABLED: 'text-[color:var(--text-muted)]',
  SUSPENDED: 'text-amber-500',
};

const STATE_LABEL: Record<State, string> = {
  ENABLED: 'Actif', DISABLED: 'Désactivé', SUSPENDED: 'Suspendu',
};

const SEVERITY_STYLE = {
  critical: 'border-red-500/30 bg-red-500/5 text-red-400',
  warning: 'border-amber-500/30 bg-amber-500/5 text-amber-500',
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

  const load = useCallback(async () => {
    try {
      setData(await apiClient.get<Dashboard>('/api/admin/ai/dashboard'));
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
  }, []);

  useEffect(() => { load(); }, [load]);

  const createDraft = async () => {
    setBusy(true);
    try {
      await apiClient.post('/api/admin/ai/config-versions', {});
      toast.success('Brouillon créé');
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

  const drafts = data.versions.filter((v) => v.status === 'DRAFT');
  const toTest = data.versions.find((v) => v.status === 'TO_TEST');

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Bandeau environnement — production non masquable */}
      <div className={`rounded-xl border p-4 ${data.isProduction
        ? 'border-red-500/40 bg-red-500/5'
        : 'border-[color:var(--border-subtle)] bg-[color:var(--bg-card)]'}`}>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl font-bold text-[color:var(--text-primary)]">
              Configuration IA — {data.environment}
            </h1>
            <p className="text-sm text-[color:var(--text-secondary)]">
              {data.activeVersion
                ? `Version active : v${data.activeVersion.visibleNumber}`
                  + (data.activeVersion.label ? ` — ${data.activeVersion.label}` : '')
                : 'Aucune version active.'}
              {data.effectiveVersion && (
                <span className="text-amber-500">
                  {' '}· une version à l&apos;essai s&apos;applique actuellement
                </span>
              )}
            </p>
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
          <p className="text-xs text-red-400 mt-2">
            Environnement de production. Toute activation s&apos;applique aux comptes réels.
          </p>
        )}
      </div>

      {/* Sources indisponibles — nommées, pas tues : sans cela, des zéros se
          liraient comme des mesures. */}
      {(data.degraded?.length ?? 0) > 0 && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 space-y-1">
          <p className="text-sm font-medium text-amber-500">
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
                {h.failed > 0 && <span className="text-red-400"> · {h.failed} en échec</span>}
              </p>
            ) : (
              <p className="text-xs text-[color:var(--text-muted)]">Répond en direct</p>
            )}
            {/* HLT-01 / PER-01 / VOL-01 : volumes, succès, dernière exécution —
                lien préfiltré vers les exécutions du traitement (ALT-01). */}
            {h.activity && (
              <Link href={`/admin/ai-executions?treatment=${h.treatment}`} className="block text-xs text-[color:var(--text-muted)] hover:underline">
                Appels 24 h / 7 j / 30 j : {h.activity.calls24h} / {h.activity.calls7d} / {h.activity.calls30d}
                {h.activity.successRate7d !== null && (
                  <span className={h.activity.successRate7d < 0.9 ? ' text-amber-500' : ''}>
                    {' '}· succès 7 j {Math.round(h.activity.successRate7d * 100)} %
                  </span>
                )}
                {h.activity.lastCallAt && (
                  <span className="block">
                    Dernier appel : {new Date(h.activity.lastCallAt).toLocaleString('fr-FR')}
                  </span>
                )}
              </Link>
            )}
            {h.suspendedReason && (
              <p className="text-xs text-amber-500 line-clamp-2">{h.suspendedReason}</p>
            )}
            {/* WF-09 étape 53 : prochaine tentative de recovery (sonde). */}
            {h.state === 'SUSPENDED' && h.nextProbeAt && (
              <p className="text-xs text-[color:var(--text-muted)]">
                Prochaine sonde : {new Date(h.nextProbeAt).toLocaleTimeString('fr-FR')}
              </p>
            )}
            {/* MOD-008 / OPS-019 : alerte modèle informationnelle, sans arrêt. */}
            {(h.alertingModels ?? []).map((m) => (
              <p key={m.model} className="text-xs text-amber-500 flex items-center gap-1" title="Alerte modèle (MOD-008) : se résout au premier succès de ce modèle.">
                <AlertTriangle className="w-3 h-3 shrink-0" />
                <span className="font-mono truncate">{m.model}</span>
                <span className="shrink-0">· {m.consecutiveFailures} échecs</span>
              </p>
            ))}
          </div>
        ))}
      </div>

      {/* Versions */}
      <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-[color:var(--text-primary)]">Versions</h2>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={createDraft} disabled={busy}>
              <Plus className="w-3.5 h-3.5 mr-1.5" /> Brouillon
            </Button>
            <Link href="/admin/ai-config">
              <Button size="sm" variant="ghost">Ouvrir</Button>
            </Link>
          </div>
        </div>

        <p className="text-sm text-[color:var(--text-secondary)]">
          {drafts.length} brouillon{drafts.length > 1 ? 's' : ''}
          {toTest && ' · une version à l’essai'}
          {drafts.some((d) => d.isStale) && (
            <span className="text-amber-500">
              {' '}· certains brouillons reposent sur une version dépassée
            </span>
          )}
        </p>

        {!data.activeVersion && (
          <p className="text-sm text-amber-500">
            Aucune configuration active : les traitements utilisent les valeurs du code.
            Créez un brouillon, puis validez-le pour amorcer le versioning.
          </p>
        )}
      </div>

      {/* Mise en production */}
      <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 space-y-2">
        <h2 className="text-sm font-semibold text-[color:var(--text-primary)]">
          Mise en production
        </h2>
        {data.packages.length === 0 ? (
          <p className="text-sm text-[color:var(--text-muted)]">
            Aucun package préparé. Un package se prépare depuis une version validée.
          </p>
        ) : (
          data.packages.map((p) => (
            <p key={p.id} className="text-sm text-[color:var(--text-secondary)]">
              v{p.visibleNumber}{p.label ? ` — ${p.label}` : ''}
              <span className="text-[color:var(--text-muted)]">
                {' '}· depuis {p.sourceEnvironment}
                {p.importedAt
                  ? ` · importé le ${new Date(p.importedAt).toLocaleDateString('fr-FR')}`
                  : ' · pas encore importé'}
              </span>
            </p>
          ))
        )}
      </div>

      {/* Coûts */}
      <Link href="/admin/ai-costs"
        className="block rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 hover:opacity-80 transition-opacity">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-semibold text-[color:var(--text-primary)]">
            Dépense des sept derniers jours
          </h2>
          <ArrowRight className="w-3.5 h-3.5 text-[color:var(--text-muted)]" />
        </div>
        <p className="text-sm text-[color:var(--text-secondary)]">
          {usd(data.costs7d.functionalMicros)} métier · {usd(data.costs7d.technicalMicros)} technique
          <span className="text-[color:var(--text-muted)]">
            {' '}· {data.costs7d.calls} appels, {data.costs7d.failedCalls} en échec
          </span>
        </p>
      </Link>
    </div>
  );
}
