'use client';

/**
 * Lot 111M (ticket « budgets IA », §5) — LIMITES APPLICATIVES EFFECTIVES, en
 * lecture seule, dans Configuration IA (écran existant) : par traitement et
 * opération, valeur réellement utilisée, ORIGINE (surcharge explicite,
 * défaut du code, résolue automatiquement, fixe) et rôle. Aucun nouveau
 * réglage : ce qui se résout automatiquement (capacités du modèle, prompt
 * actif) n'est pas administrable. Les plafonds MODÈLE (sortie transmise,
 * entrée disponible) sont dans les profils effectifs de chaque opération.
 * Desktop et mobile : tableau défilant dans son cadre sous `sm`.
 */
import { useCallback, useState } from 'react';
import { apiClient } from '@/lib/api-client';

interface Limit {
  treatment: string; operation: string; name: string; value: number | string; unit: string;
  origin: 'explicit_override' | 'default' | 'resolved' | 'fixed'; variable: string | null; role: string;
}
const ORIGINE: Record<Limit['origin'], string> = {
  explicit_override: 'surcharge explicite', default: 'défaut du code', resolved: 'résolue (modèle / prompt actif)', fixed: 'fixe (contrat)',
};

export function ApplicationLimits() {
  const [limits, setLimits] = useState<Limit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    setError(null);
    apiClient.get<{ applicationLimits?: Limit[] }>('/api/admin/ai/model-capabilities')
      .then((r) => setLimits(r.applicationLimits ?? []))
      .catch((e: Error) => setError(e.message || 'Lecture impossible'));
  }, []);
  return (
    <details className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)]" data-testid="application-limits"
      onToggle={(e) => { if ((e.target as HTMLDetailsElement).open && limits === null) load(); }}>
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-[color:var(--text-primary)]">
        Limites applicatives effectives
        <span className="ml-1 text-xs font-normal text-[color:var(--text-muted)]">· valeurs réellement utilisées et leur origine</span>
      </summary>
      <div className="px-4 pb-4 space-y-2">
        <p className="text-xs text-[color:var(--text-muted)]">
          Un plafond est une limite haute de sécurité, pas une consommation cible. Les plafonds de sortie et l’entrée disponible
          de chaque modèle figurent dans les profils effectifs de chaque opération.
        </p>
        {error && <p className="text-xs text-[color:var(--text-danger)]">{error}</p>}
        {limits === null && !error && <p className="text-xs text-[color:var(--text-muted)]">Chargement…</p>}
        {limits && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-xs text-[color:var(--text-primary)]">
              <thead className="text-left text-[color:var(--text-secondary)]">
                <tr><th className="py-1 pr-2">Traitement</th><th className="py-1 pr-2">Opération</th><th className="py-1 pr-2">Limite</th>
                  <th className="py-1 pr-2">Valeur</th><th className="py-1 pr-2">Origine</th><th className="py-1">Rôle</th></tr>
              </thead>
              <tbody>
                {limits.map((l) => (
                  <tr key={`${l.operation}-${l.name}`} className="border-t border-[color:var(--border-subtle)] align-top">
                    <td className="py-1 pr-2">{l.treatment}</td>
                    <td className="py-1 pr-2 font-mono">{l.operation}</td>
                    <td className="py-1 pr-2">{l.name}{l.variable ? <span className="block font-mono text-[color:var(--text-muted)]">{l.variable}</span> : null}</td>
                    <td className="py-1 pr-2">{typeof l.value === 'number' ? l.value.toLocaleString('fr-FR') : l.value} {typeof l.value === 'number' ? l.unit : ''}</td>
                    <td className="py-1 pr-2">{ORIGINE[l.origin]}</td>
                    <td className="py-1 text-[color:var(--text-muted)]">{l.role}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </details>
  );
}
