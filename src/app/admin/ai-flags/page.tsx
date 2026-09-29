'use client';

/**
 * Admin — Drapeaux et commutateurs — CDC 15 décision D-01, HC-01.
 *
 * Le PO ne connaît pas les valeurs réellement déployées des drapeaux `AI_*`.
 * Cette page les affiche pour l'environnement qui la sert : chaque
 * environnement (préproduction, production) est un déploiement distinct, avec
 * ses propres variables — ouvrir la page sur chacun donne ses valeurs.
 *
 * Lecture seule : ces valeurs se changent chez l'hébergeur (variables
 * d'environnement), jamais d'ici. La colonne « appliqué » montre ce que le
 * code en fait réellement : une valeur mal orthographiée y apparaît `legacy`.
 */
import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EcranEnErreur } from '@/components/admin/EcranEnErreur';
import { apiClient } from '@/lib/api-client';
import { AiEnvBanner } from '../ai-dashboard/_components/AiEnvBanner';

interface FlagEntry {
  name: string;
  raw: string | null;
  mode: 'legacy' | 'shadow' | 'enabled';
  invalid: boolean;
  description: string;
}

interface RolloutEntry {
  name: string;
  env: string;
  lot: string;
  description: string;
  wired: boolean;
  mode: 'legacy' | 'shadow' | 'enabled';
  raw: string | null;
  invalid: boolean;
}

interface Snapshot {
  environment: { appEnv: string | null; aiEnvironment: string | null };
  aiFlags: FlagEntry[];
  technical: FlagEntry[];
  rollout: RolloutEntry[];
  generatedAt: string;
  /** CDC 15 D-04 : master déclaré par la configuration mais non appliqué. */
  promptArchitectureWarnings?: Array<{ treatment: string; switchName: string; switchMode: string; message: string }>;
}

const MODE_STYLE: Record<string, string> = {
  legacy: 'border-[color:var(--border-subtle)] text-[color:var(--text-secondary)]',
  shadow: 'border-amber-500/40 bg-amber-500/10 text-amber-500',
  enabled: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500',
};

function Mode({ mode }: { mode: string }) {
  return (
    <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${MODE_STYLE[mode] ?? ''}`}>
      {mode}
    </span>
  );
}

function Brut({ raw, invalid }: { raw: string | null; invalid: boolean }) {
  if (raw === null) return <span className="text-[color:var(--text-muted)]">absente (défaut du code)</span>;
  return (
    <span className={invalid ? 'text-red-400' : 'text-[color:var(--text-secondary)]'}>
      <code>{raw}</code>{invalid && ' — valeur non reconnue, lue legacy'}
    </span>
  );
}

function Tableau({ titre, lignes, colonneLot }: {
  titre: string;
  lignes: Array<{ name: string; raw: string | null; mode: string; invalid: boolean; description: string; lot?: string; wired?: boolean }>;
  colonneLot?: boolean;
}) {
  return (
    <section className="space-y-2">
      <h2 className="text-base font-semibold text-[color:var(--text-primary)]">{titre}</h2>
      <div className="overflow-x-auto rounded-xl border border-[color:var(--border-subtle)]">
        <table className="w-full text-sm">
          <thead className="bg-[color:var(--bg-card)] text-left text-xs text-[color:var(--text-muted)]">
            <tr>
              <th className="px-3 py-2">Variable</th>
              <th className="px-3 py-2">Appliqué</th>
              <th className="px-3 py-2">Valeur brute</th>
              {colonneLot && <th className="px-3 py-2">Lot</th>}
              <th className="px-3 py-2">Rôle</th>
            </tr>
          </thead>
          <tbody>
            {lignes.map((l) => (
              <tr key={l.name} className="border-t border-[color:var(--border-subtle)] align-top">
                <td className="px-3 py-2 font-mono text-xs text-[color:var(--text-primary)]">{l.name}</td>
                <td className="px-3 py-2"><Mode mode={l.mode} /></td>
                <td className="px-3 py-2 text-xs"><Brut raw={l.raw} invalid={l.invalid} /></td>
                {colonneLot && (
                  <td className="px-3 py-2 text-xs text-[color:var(--text-secondary)]">
                    {l.lot}{l.wired === false && <span className="text-[color:var(--text-muted)]"> · pas encore branché</span>}
                  </td>
                )}
                <td className="px-3 py-2 text-xs text-[color:var(--text-secondary)]">{l.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function AiFlagsPage() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setErreur(null);
    try {
      setData(await apiClient.get<Snapshot>('/api/admin/ai/flags'));
    } catch (e) {
      setErreur((e as Error).message || 'Lecture impossible.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (erreur) return <EcranEnErreur titre="Drapeaux indisponibles" message={erreur} onRetry={load} />;
  if (loading && !data) {
    return (
      <div className="flex items-center justify-center py-20 text-[color:var(--text-muted)]">
        <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Chargement…
      </div>
    );
  }
  if (!data) return null;

  const anomalies = [...data.aiFlags, ...data.technical, ...data.rollout].filter((l) => l.invalid).length;

  return (
    <div className="space-y-6 max-w-5xl">
      <AiEnvBanner />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[color:var(--text-primary)]">Drapeaux et commutateurs</h1>
          <p className="text-sm text-[color:var(--text-secondary)]">
            Valeurs effectives de cet environnement :{' '}
            <strong>{data.environment.aiEnvironment ?? 'illisible'}</strong>
            {' '}(<code>NEXT_PUBLIC_APP_ENV={data.environment.appEnv ?? '∅'}</code>). Lecture seule — ces variables se
            modifient chez l&apos;hébergeur. Ouvrez cette page sur chaque environnement pour en connaître les valeurs.
          </p>
          <p className="text-xs text-[color:var(--text-muted)]">Lu le {new Date(data.generatedAt).toLocaleString('fr-FR')}</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={`w-4 h-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} /> Relire
        </Button>
      </div>

      {anomalies > 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-red-500/40 bg-red-500/5 px-3 py-2 text-sm text-red-400">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          {anomalies} valeur(s) non reconnue(s) : le code les applique comme « legacy ».
        </div>
      )}

      {(data.promptArchitectureWarnings ?? []).map((w) => (
        <div key={w.treatment}
          className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm text-amber-500">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{w.message}</span>
        </div>
      ))}

      <Tableau titre="Drapeaux IA (un par usage)" lignes={data.aiFlags} />
      <Tableau titre="Bascules techniques" lignes={data.technical} />
      <Tableau titre="Commutateurs de déploiement (CDC 15)" lignes={data.rollout.map((r) => ({ ...r, name: r.env }))} colonneLot />
    </div>
  );
}
