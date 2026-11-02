"use client";

/**
 * Fiche Compte (BO) — « Amélioration de Verebona » : opposition de
 * l'utilisateur à l'utilisation des données du compte pour l'amélioration
 * (lot 102D). Consultation seule ; une erreur de chargement est affichée
 * comme telle (ERR-001).
 */
import { useCallback, useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { formatDateTime } from '@/lib/admin/format';

interface DataUseEvent { action: 'OPT_OUT' | 'OPT_IN'; channel: string; userId: number | null; labelShown: string; labelSha256: string; occurredAt: string }
interface DataUsePayload {
  preference: { optOut: boolean; optedOutAt: string | null; optedOutByUserId: number | null; withdrawnAt: string | null; excludedBefore: string | null };
  events: DataUseEvent[];
  totalOptedOut: number;
}

const CHANNEL: Record<string, string> = { web: 'Web', mobile: 'Application mobile', admin: 'Back-office' };

export function AccountDataUse({ accountId }: { accountId: string | number }) {
  const [data, setData] = useState<DataUsePayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/admin/accounts/${accountId}/data-use`, { credentials: 'include' });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.message || `Erreur ${res.status}`);
      setData(payload as DataUsePayload);
    } catch (err) {
      setData(null);
      setError(err instanceof Error ? err.message : 'Erreur inconnue');
    }
  }, [accountId]);

  useEffect(() => { void load(); }, [load]);

  const p = data?.preference;
  return (
    <section className="rounded-xl border bg-card overflow-hidden" data-testid="bo-account-data-use">
      <div className="px-5 py-4 border-b">
        <h2 className="vb-app-section flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" />
          Amélioration de Verebona (utilisation des données)
        </h2>
      </div>
      {error ? (
        <div className="px-5 py-4 text-sm text-[color:var(--text-danger)]">
          {error}{' '}
          <button type="button" className="underline" onClick={() => load()}>Réessayer</button>
        </div>
      ) : !data || !p ? (
        <p className="px-5 py-4 text-xs text-muted-foreground">Chargement…</p>
      ) : (
        <div className="px-5 py-4 space-y-3 text-sm">
          <p>
            {p.optOut
              ? <>Opposition active depuis le {formatDateTime(p.optedOutAt)} : ce compte n’alimente ni la qualification des modèles et des prompts, ni les exports d’exécutions IA.</>
              : p.withdrawnAt
                ? <>Opposition retirée le {formatDateTime(p.withdrawnAt)}. Les données antérieures restent exclues de l’amélioration.</>
                : <>Aucune opposition : usage interne pour la qualité des traitements, selon la politique de confidentialité.</>}
          </p>
          <p className="text-xs text-muted-foreground">Comptes opposés au total : {data.totalOptedOut}. Le support peut consulter une exécution si c’est nécessaire (demande, incident, sécurité).</p>
          {data.events.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="font-semibold text-muted-foreground bg-muted/30">
                  <tr>
                    <th className="px-3 py-2 text-left">Date</th>
                    <th className="px-3 py-2 text-left">Choix</th>
                    <th className="px-3 py-2 text-left">Canal</th>
                    <th className="px-3 py-2 text-left">Utilisateur</th>
                    <th className="px-3 py-2 text-left">Libellé affiché (empreinte)</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {data.events.map((e) => (
                    <tr key={`${e.occurredAt}-${e.action}`}>
                      <td className="px-3 py-2">{formatDateTime(e.occurredAt)}</td>
                      <td className="px-3 py-2">{e.action === 'OPT_OUT' ? 'Opposition' : 'Retrait de l’opposition'}</td>
                      <td className="px-3 py-2">{CHANNEL[e.channel] ?? e.channel}</td>
                      <td className="px-3 py-2">{e.userId ? `#${e.userId}` : '—'}</td>
                      <td className="px-3 py-2 break-words">{e.labelShown} <span className="font-mono text-muted-foreground">({e.labelSha256.slice(0, 12)})</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
