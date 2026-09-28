"use client";

/**
 * Documents du compte — CDC Back-Office V1 ACC-D07, ACC-D08, SEC-001/002.
 *
 * Métadonnées seulement : aucun contenu, aucun lien d'ouverture ou de
 * téléchargement, aucun nom de fichier (REC-ACC-07). Statut de traitement,
 * erreur technique, bien rattaché, taille, dates, échéances liées ; exports
 * et transmissions du compte. Pagination classique et tri (GEN-004).
 */
import { useCallback, useEffect, useState } from 'react';
import { FileText, Send } from 'lucide-react';
import { formatBytes, formatDate, formatDateTime } from '@/lib/admin/format';
import { AdminPagination, SortHeader, nextSort } from '../../../subscriptions/_components/list-controls';

type Sort = 'uploaded' | 'size' | 'type' | 'asset' | 'status';

interface DocumentMeta {
  id: number;
  type: string | null;
  extension: string | null;
  sizeBytes: number | null;
  uploadedAt: string | null;
  documentDate: string | null;
  asset: { id: number; name: string } | null;
  status: string;
  statusLabel: string;
  error: string | null;
  linkedDeadlines: number;
}

interface ExportMeta {
  kind: 'export' | 'transmission';
  at: string;
  assetName: string | null;
  type: string;
  status: string;
  error: string | null;
}

interface Payload {
  documents: { items: DocumentMeta[]; page: number; totalPages: number; total: number };
  exports: ExportMeta[];
}

const EXPORT_TYPE_LABELS: Record<string, string> = {
  CIL_REGLEMENTAIRE: 'CIL',
  DOSSIER_VENTE: 'Dossier de vente',
  DOSSIER_COMPLET: 'Dossier complet',
  ASSURANCE_ESTIMATION: 'Assurance — estimation',
  ASSURANCE_INDEMNISATION: 'Assurance — indemnisation',
  EXPORT_BRUT: 'Données brutes',
};

const ERROR_STATUSES = new Set(['analysis_failed', 'upload_failed', 'conflict']);

export function AccountDocuments({ accountId }: { accountId: string | number }) {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<Sort>('uploaded');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ page: String(page), sort, dir });
      const res = await fetch(`/api/admin/accounts/${accountId}/documents?${qs}`, { credentials: 'include' });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.message || `Erreur ${res.status}`);
      setData(payload as Payload);
    } catch (err) {
      setData(null);
      setError(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setLoading(false);
    }
  }, [accountId, page, sort, dir]);

  useEffect(() => { void load(); }, [load]);

  const onSort = (key: Sort) => {
    const n = nextSort(sort, dir, key);
    setSort(n.sort);
    setDir(n.dir);
    setPage(1);
  };

  return (
    <>
      <section className="rounded-xl border bg-card overflow-hidden">
        <div className="px-5 py-4 border-b">
          <h2 className="font-semibold flex items-center gap-2">
            <FileText className="h-4 w-4 text-muted-foreground" />
            Documents {data ? `(${data.documents.total})` : ''}
          </h2>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Métadonnées uniquement : le contenu des documents n’est jamais accessible depuis le back-office.
          </p>
        </div>
        {error ? (
          <div className="px-5 py-4 text-sm text-red-500">
            {error}{' '}
            <button type="button" className="underline" onClick={() => load()}>Réessayer</button>
          </div>
        ) : !data ? (
          <p className="px-5 py-4 text-xs text-muted-foreground">Chargement…</p>
        ) : data.documents.total === 0 ? (
          <p className="px-5 py-6 text-center text-muted-foreground italic text-xs">Aucun document</p>
        ) : (
          <div className="space-y-3 pb-3">
            <div className={`overflow-x-auto ${loading ? 'opacity-60' : ''}`}>
              <table className="w-full text-xs">
                <thead className="text-[11px] text-muted-foreground uppercase bg-muted/30">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium">N°</th>
                    <th className="px-4 py-2 text-left"><SortHeader label="Type" sortKey="type" current={sort} dir={dir} onSort={onSort} /></th>
                    <th className="px-4 py-2 text-left"><SortHeader label="Bien" sortKey="asset" current={sort} dir={dir} onSort={onSort} /></th>
                    <th className="px-4 py-2 text-right"><SortHeader label="Taille" sortKey="size" current={sort} dir={dir} onSort={onSort} align="right" /></th>
                    <th className="px-4 py-2 text-left"><SortHeader label="Dépôt" sortKey="uploaded" current={sort} dir={dir} onSort={onSort} /></th>
                    <th className="px-4 py-2 text-left font-medium">Date du document</th>
                    <th className="px-4 py-2 text-left"><SortHeader label="Traitement" sortKey="status" current={sort} dir={dir} onSort={onSort} /></th>
                    <th className="px-4 py-2 text-right font-medium">Échéances liées</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {data.documents.items.map((d) => (
                    <tr key={d.id}>
                      <td className="px-4 py-2 font-mono text-muted-foreground">#{d.id}</td>
                      <td className="px-4 py-2">{d.type ?? 'Non classé'}{d.extension ? <span className="text-muted-foreground"> · {d.extension}</span> : null}</td>
                      <td className="px-4 py-2">{d.asset?.name ?? '—'}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{d.sizeBytes == null ? '—' : formatBytes(d.sizeBytes)}</td>
                      <td className="px-4 py-2 whitespace-nowrap">{formatDateTime(d.uploadedAt)}</td>
                      <td className="px-4 py-2 whitespace-nowrap">{formatDate(d.documentDate)}</td>
                      <td className="px-4 py-2">
                        <span className={ERROR_STATUSES.has(d.status) ? 'text-red-500 font-medium' : ''}>{d.statusLabel}</span>
                        {d.error && <div className="text-[10px] text-muted-foreground max-w-[18rem] truncate" title={d.error}>{d.error}</div>}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">{d.linkedDeadlines}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="px-5">
              <AdminPagination
                page={data.documents.page}
                totalPages={data.documents.totalPages}
                total={data.documents.total}
                disabled={loading}
                onPage={setPage}
              />
            </div>
          </div>
        )}
      </section>

      <section className="rounded-xl border bg-card overflow-hidden">
        <div className="px-5 py-4 border-b">
          <h2 className="font-semibold flex items-center gap-2">
            <Send className="h-4 w-4 text-muted-foreground" />
            Exports et transmissions
          </h2>
        </div>
        {error ? (
          <p className="px-5 py-4 text-sm text-red-500">Indisponible : {error}</p>
        ) : !data ? (
          <p className="px-5 py-4 text-xs text-muted-foreground">Chargement…</p>
        ) : data.exports.length === 0 ? (
          <p className="px-5 py-6 text-center text-muted-foreground italic text-xs">Aucun export ni transmission</p>
        ) : (
          <div className="overflow-x-auto max-h-80 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="text-[11px] text-muted-foreground uppercase bg-muted/30">
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
                    <td className="px-4 py-2">{e.kind === 'export' ? `Export — ${EXPORT_TYPE_LABELS[e.type] ?? e.type}` : e.type}</td>
                    <td className="px-4 py-2">{e.assetName ?? '—'}</td>
                    <td className="px-4 py-2">
                      <span className={e.error ? 'text-red-500 font-medium' : ''}>{e.status}</span>
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
