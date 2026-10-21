"use client";

/**
 * Exports et transmissions du compte — CDC Back-Office V1 ACC-D08.
 *
 * Lot 75N : la liste des DOCUMENTS (ACC-D07) est désormais dans la section
 * « Données du compte » (catégorie Documents, tiroir commun) — elle n'est plus
 * dupliquée ici. Seuls les exports et transmissions restent affichés, sans
 * lien de téléchargement.
 */
import { useCallback, useEffect, useState } from 'react';
import { Send } from 'lucide-react';
import { formatDateTime } from '@/lib/admin/format';
import { exportCodeLabel } from '@/services/exports/catalog';

interface ExportMeta {
  kind: 'export' | 'transmission';
  at: string;
  assetName: string | null;
  type: string;
  status: string;
  error: string | null;
}

interface Payload {
  exports: ExportMeta[];
}

// Libellés des dossiers : catalogue V12 (anciens codes compris), forme courte.
const exportLabel = (code: string) => exportCodeLabel(code, true);

export function AccountDocuments({ accountId }: { accountId: string | number }) {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/admin/accounts/${accountId}/documents?page=1`, { credentials: 'include' });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.message || `Erreur ${res.status}`);
      setData(payload as Payload);
    } catch (err) {
      setData(null);
      setError(err instanceof Error ? err.message : 'Erreur inconnue');
    }
  }, [accountId]);

  useEffect(() => { void load(); }, [load]);

  return (
    <>
      <section className="rounded-xl border bg-card overflow-hidden">
        <div className="px-5 py-4 border-b">
          <h2 className="vb-app-section flex items-center gap-2">
            <Send className="h-4 w-4 text-muted-foreground" />
            Exports et transmissions
          </h2>
        </div>
        {error ? (
          <p className="px-5 py-4 text-sm text-[color:var(--text-danger)]">Indisponible : {error}</p>
        ) : !data ? (
          <p className="px-5 py-4 text-xs text-muted-foreground">Chargement…</p>
        ) : data.exports.length === 0 ? (
          <p className="px-5 py-6 text-center text-muted-foreground italic text-xs">Aucun export ni transmission</p>
        ) : (
          <div className="overflow-x-auto max-h-80 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="text-[12.5px] font-semibold text-muted-foreground bg-muted/30">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Date</th>
                  <th className="px-4 py-2 text-left font-medium">Nature</th>
                  <th className="px-4 py-2 text-left font-medium">Bien</th>
                  <th className="px-4 py-2 text-left font-medium">Statut</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {data.exports.map((e, i) => (
                  <tr key={i}>
                    <td className="px-4 py-2 whitespace-nowrap">{formatDateTime(e.at)}</td>
                    <td className="px-4 py-2">{e.kind === 'export' ? `Export — ${exportLabel(e.type)}` : e.type}</td>
                    <td className="px-4 py-2">{e.assetName ?? '—'}</td>
                    <td className="px-4 py-2">
                      <span className={e.error ? 'text-[color:var(--text-danger)] font-medium' : ''}>{e.status}</span>
                      {e.error && <div className="text-[10px] text-muted-foreground max-w-[18rem] truncate" title={e.error}>{e.error}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
