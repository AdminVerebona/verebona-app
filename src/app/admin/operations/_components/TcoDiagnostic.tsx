"use client";

/**
 * BO › Opérations › « Coût de possession » (lot 61, ticket P1 TCO §6) —
 * diagnostic LECTURE SEULE du TCO d'un bien : chaque ligne examinée
 * (composante consolidée, justificatif, prix de la fiche), retenue ou
 * écartée, avec son motif. Permet d'expliquer chaque euro sans accès SQL ni
 * création d'Opération. Desktop : tableau ; mobile : cartes empilées.
 */
import Link from 'next/link';
import type { TcoEconomicLine, TcoResult } from '@/services/business-operations/tco/model';

export interface TcoDiagnosticResponse {
  accountId: number;
  assetId: number;
  tco: Omit<TcoResult, 'entries'>;
  componentsExamined: number;
  labels: { status: Record<string, string>; reason: Record<string, string>; warning: Record<string, string> };
}

const eur = (c: number | null | undefined) => (c == null ? '—' : (c / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' }));
const minor = (m: number, cur: string) => `${(m / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur}`;
const RETENUE = new Set(['RETAINED_DIRECT', 'RETAINED_CONSOLIDATED']);
const SOURCE: Record<string, string> = { OPERATION: 'Composante', DOCUMENT: 'Justificatif', ASSET_DATA: 'Fiche' };

function Badge({ l, labels }: { l: TcoEconomicLine; labels: TcoDiagnosticResponse['labels'] }) {
  const ok = RETENUE.has(l.status);
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-medium ${ok ? 'bg-[color:var(--bg-success)] text-[color:var(--text-success)]' : 'bg-muted text-muted-foreground'}`}>
      {labels.status[l.status] ?? l.status}
    </span>
  );
}

export function TcoDiagnosticView({ data }: { data: TcoDiagnosticResponse }) {
  const t = data.tco;
  const { labels } = data;
  return (
    <div className="space-y-4" data-bo-tco>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-sm">
        <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">Coût cumulé documenté</p><p className="text-lg font-semibold tabular-nums">{eur(t.summary.cumulativeCostCents)}</p></div>
        <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">Acquisition / complémentaires</p><p className="tabular-nums">{eur(t.summary.acquisitionCents)} / {eur(t.summary.additionalCostsCents)}</p></div>
        <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">Statut du calcul</p><p>{t.status}</p></div>
        <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">Lignes examinées</p><p>{t.lines.length} ({t.reliability.operationsCounted} opération(s), {t.reliability.documentsCounted} justificatif(s) direct(s) comptés)</p></div>
      </div>
      {t.reliability.warnings.length > 0 && (
        <ul className="text-xs text-[color:var(--text-warning-soft)] list-disc pl-5 space-y-0.5">
          {t.reliability.warnings.map((w) => <li key={w}>{labels.warning[w] ?? w}</li>)}
        </ul>
      )}
      {t.reliability.anomalies.length > 0 && (
        <p className="text-xs text-[color:var(--text-danger)]">Anomalies de contrôle : {t.reliability.anomalies.map((a) => `${a.code}${a.detail ? ` (${a.detail})` : ''}`).join(', ')}</p>
      )}

      {/* Mobile : cartes */}
      <div className="space-y-2 md:hidden">
        {t.lines.map((l) => (
          <div key={l.id} className="rounded-lg border p-3 text-sm space-y-1" data-bo-tco-line={l.id}>
            <div className="flex items-start justify-between gap-2"><span className="font-medium break-words min-w-0">{l.label}</span><Badge l={l} labels={labels} /></div>
            <p className="text-xs text-muted-foreground break-all">{l.id} · {SOURCE[l.source]} · {l.provenance}{l.category ? ` · ${l.category}` : ''}</p>
            <p className="text-xs tabular-nums">{minor(l.amountMinor, l.currency)} → retenu {eur(l.includedCents)}</p>
            {l.reason && <p className="text-xs text-muted-foreground">{labels.reason[l.reason] ?? l.reason}</p>}
            {l.note && <p className="text-xs text-muted-foreground">{l.note}</p>}
            <p className="text-xs">
              {l.fileId ? <span>doc #{l.fileId}</span> : null}
              {l.operationId ? <> · <Link className="underline" href={`/admin/operations/${l.operationId}?accountId=${data.accountId}`}>Opération #{l.operationId}</Link></> : null}
            </p>
          </div>
        ))}
      </div>

      {/* Desktop : tableau */}
      <div className="hidden md:block overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
            <tr>
              <th className="p-2">Ligne</th><th className="p-2">Source</th><th className="p-2">Document</th><th className="p-2">Opération</th>
              <th className="p-2">Catégorie</th><th className="p-2 text-right">Montant</th><th className="p-2 text-right">Retenu</th><th className="p-2">Statut et motif</th>
            </tr>
          </thead>
          <tbody>
            {t.lines.map((l) => (
              <tr key={l.id} className="border-t align-top" data-bo-tco-line={l.id}>
                <td className="p-2"><p className="font-medium">{l.label}</p><p className="text-xs text-muted-foreground">{l.id}{l.date ? ` · ${l.date}` : ''}</p></td>
                <td className="p-2 text-xs">{SOURCE[l.source]} · {l.provenance}</td>
                <td className="p-2 text-xs">{l.fileId ? `#${l.fileId}` : '—'}{l.relatedFileId ? ` (lié à #${l.relatedFileId})` : ''}</td>
                <td className="p-2 text-xs">{l.operationId ? <Link className="underline" href={`/admin/operations/${l.operationId}?accountId=${data.accountId}`}>#{l.operationId}</Link> : '—'}</td>
                <td className="p-2 text-xs">{l.category ?? '—'}</td>
                <td className="p-2 text-right tabular-nums text-xs">{minor(l.amountMinor, l.currency)}</td>
                <td className="p-2 text-right tabular-nums">{eur(l.includedCents)}</td>
                <td className="p-2 text-xs"><Badge l={l} labels={labels} />{l.reason && <p className="mt-1 text-muted-foreground">{labels.reason[l.reason] ?? l.reason}</p>}{l.note && <p className="text-muted-foreground">{l.note}</p>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
