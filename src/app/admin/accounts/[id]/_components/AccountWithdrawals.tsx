"use client";

/**
 * Rétractations du compte — CDC Back-Office V1 SUB-015.
 *
 * Intégrées à la fiche Compte (plus d'onglet « Rétractations » séparé).
 * Consultation seule ; une erreur de chargement est affichée comme telle
 * (ERR-001), jamais comme une liste vide.
 */
import { useCallback, useEffect, useState } from 'react';
import { Undo2 } from 'lucide-react';
import { formatDateTime, formatMoney } from '@/lib/admin/format';

interface Withdrawal {
  id: number;
  reference: string;
  requestedAt: string;
  effectiveAt: string | null;
  statusLabel: string;
  amountRefundedCents: number;
  currency: string;
}

export function AccountWithdrawals({ accountId }: { accountId: string | number }) {
  const [rows, setRows] = useState<Withdrawal[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/admin/subscriptions/withdrawals?accountId=${accountId}`, { credentials: 'include' });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.message || `Erreur ${res.status}`);
      setRows(payload.withdrawals ?? []);
    } catch (err) {
      setRows(null);
      setError(err instanceof Error ? err.message : 'Erreur inconnue');
    }
  }, [accountId]);

  useEffect(() => { void load(); }, [load]);

  return (
    <section className="rounded-xl border bg-card overflow-hidden">
      <div className="px-5 py-4 border-b">
        <h2 className="font-semibold flex items-center gap-2">
          <Undo2 className="h-4 w-4 text-muted-foreground" />
          Rétractations
        </h2>
      </div>
      {error ? (
        <div className="px-5 py-4 text-sm text-red-500">
          {error}{' '}
          <button type="button" className="underline" onClick={() => load()}>Réessayer</button>
        </div>
      ) : rows === null ? (
        <p className="px-5 py-4 text-xs text-muted-foreground">Chargement…</p>
      ) : rows.length === 0 ? (
        <p className="px-5 py-6 text-center text-muted-foreground italic text-xs">Aucune rétractation</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-[11px] text-muted-foreground uppercase bg-muted/30">
              <tr>
                <th className="px-5 py-2.5 font-medium text-left">Référence</th>
                <th className="px-5 py-2.5 font-medium text-left">Demande</th>
                <th className="px-5 py-2.5 font-medium text-left">Statut</th>
                <th className="px-5 py-2.5 font-medium text-left">Effet</th>
                <th className="px-5 py-2.5 font-medium text-right">Remboursé</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((w) => (
                <tr key={w.id}>
                  <td className="px-5 py-2.5 text-xs font-mono">{w.reference}</td>
                  <td className="px-5 py-2.5 text-xs">{formatDateTime(w.requestedAt)}</td>
                  <td className="px-5 py-2.5 text-xs">{w.statusLabel}</td>
                  <td className="px-5 py-2.5 text-xs">{formatDateTime(w.effectiveAt)}</td>
                  <td className="px-5 py-2.5 text-xs text-right tabular-nums">{formatMoney(w.amountRefundedCents, w.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
