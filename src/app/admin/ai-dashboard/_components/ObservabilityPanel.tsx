'use client';

/**
 * Observabilité §18 (CDC 15, lot 17) — dans le tableau de bord IA existant.
 *
 * Un onglet par domaine (T1, T2, T3, T4, configuration IA, exports), la
 * fenêtre du tableau de bord (PER-01), un filtre de version et
 * d'environnement. Rendu par le composant de supervision des onglets de
 * traitement (`ai-config/_components/Supervision`) : même grille, mêmes
 * tables, même « pas encore mesuré ». Aucune entrée de menu ajoutée.
 *
 * Chargé à l'ouverture de la section seulement : le tableau de bord doit
 * rester lisible « en moins d'un écran » même si une requête traîne.
 */

import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { Supervision, type Metric, type MetricTable } from '../../ai-config/_components/Supervision';

const DOMAINS = [
  { code: 'T1', label: 'T1 — Sources', treatment: 'T1' },
  { code: 'T2', label: 'T2 — Assistant', treatment: 'T2' },
  { code: 'T3', label: 'T3 — Rationalisation', treatment: 'T3' },
  { code: 'T4', label: 'T4 — Échéances', treatment: 'T4' },
  { code: 'CONFIG', label: 'Configuration IA', treatment: '' },
  { code: 'EXPORTS', label: 'Exports', treatment: '' },
] as const;

type Domain = (typeof DOMAINS)[number]['code'];

const ENVIRONMENTS = ['local', 'preprod', 'production'] as const;

const SELECT = 'rounded-lg border border-[color:var(--border-subtle)] bg-[color:var(--bg-input)] px-2 py-1 text-xs text-[color:var(--text-primary)]';

interface Report {
  windowDays: number;
  environment: { current: string | null; requested: string | null; readable: boolean };
  version: { id: number; label: string; scope: string; period: { from: string; to: string } | null } | null;
  metrics: Metric[];
  tables: MetricTable[];
  notes: string[];
  cached: boolean;
  /** Dernier résultat connu, rendu pendant un autre calcul. */
  stale?: boolean;
  /** Un autre calcul occupe l'instance : nouvel essai automatique. */
  busy?: boolean;
}

export interface ObservabilityVersion {
  id: number; status: string; visibleNumber: number | null; label: string | null;
}

export function ObservabilityPanel({ days, versions, environment }: {
  days: number;
  versions: ObservabilityVersion[];
  environment: string;
}) {
  const [open, setOpen] = useState(false);
  const [domain, setDomain] = useState<Domain>('T1');
  const [versionId, setVersionId] = useState('');
  const [env, setEnv] = useState('');
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [essais, setEssais] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ days: String(days) });
      if (versionId) qs.set('configVersionId', versionId);
      if (env) qs.set('environment', env);
      const r = await apiClient.get<Report>(`/api/admin/ai/observability/${domain}?${qs}`);
      setReport(r);
      setErreur(null);
      // Un seul calcul à la fois par instance : « en cours » ou résultat
      // précédent → nouvel essai, trois fois au plus.
      setEssais((n) => (r.busy || r.stale ? n + 1 : 0));
    } catch (e) {
      const err = e as { message?: string; code?: string };
      setErreur([err.message, err.code && `(${err.code})`].filter(Boolean).join(' ') || 'Chargement impossible.');
    } finally {
      setLoading(false);
    }
  }, [days, domain, versionId, env]);

  useEffect(() => { if (open) load(); }, [open, load]);
  useEffect(() => {
    if (!open || essais === 0 || essais > 3) return;
    const t = setTimeout(load, 2_000);
    return () => clearTimeout(t);
  }, [open, essais, load]);

  const courant = DOMAINS.find((d) => d.code === domain)!;
  // Versions numérotées seulement : un brouillon ne s'exécute jamais.
  const numbered = versions.filter((v) => v.visibleNumber !== null);

  return (
    <details
      className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 space-y-3"
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
      data-testid="ai-observability"
    >
      <summary className="cursor-pointer text-sm font-semibold text-[color:var(--text-primary)]">
        Observabilité par traitement
      </summary>

      <div className="flex flex-wrap items-center justify-between gap-2 pt-3">
        <div role="tablist" aria-label="Domaine observé" className="inline-flex flex-wrap rounded-lg border border-[color:var(--border-subtle)] p-0.5">
          {DOMAINS.map((d) => (
            <button
              key={d.code}
              type="button"
              role="tab"
              aria-selected={domain === d.code}
              onClick={() => setDomain(d.code)}
              className={`px-2.5 py-1 text-xs rounded-md transition-colors ${domain === d.code
                ? 'bg-[color:var(--accent-soft)] text-[color:var(--text-primary)] font-medium'
                : 'text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)]'}`}
            >
              {d.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <select value={versionId} onChange={(e) => setVersionId(e.target.value)} className={SELECT} aria-label="Version de configuration">
            <option value="">Toutes les versions</option>
            {numbered.map((v) => (
              <option key={v.id} value={String(v.id)}>
                v{v.visibleNumber}{v.label ? ` — ${v.label}` : ''} ({v.status})
              </option>
            ))}
          </select>
          <select value={env} onChange={(e) => setEnv(e.target.value)} className={SELECT} aria-label="Environnement">
            <option value="">Environnement courant ({environment})</option>
            {ENVIRONMENTS.map((e) => <option key={e} value={e}>{e}</option>)}
          </select>
        </div>
      </div>

      {erreur && <p className="text-xs text-red-400">{erreur}</p>}
      {loading && !report && (
        <p className="flex items-center text-xs text-[color:var(--text-muted)]">
          <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> Chargement…
        </p>
      )}
      {report && (
        <div className={loading ? 'opacity-60' : ''}>
          <Supervision
            treatment={courant.treatment}
            title={`${courant.label}${report.version ? ` · ${report.version.label}` : ''}`}
            metrics={report.metrics}
            tables={report.tables}
            windowDays={report.windowDays}
            showWindow={false}
            href={courant.treatment ? undefined : null}
            notes={report.notes}
          />
        </div>
      )}
    </details>
  );
}
