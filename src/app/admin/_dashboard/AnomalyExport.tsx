"use client";

/**
 * Lot 113AI (Trello #733) — anomalies du BO copiables / exportables pour une
 * analyse externe (Supervision).
 *
 *  · `AnomalyListExportBar` (au-dessus de chaque liste : ouvertes,
 *    historique) : « Copier la page » (Markdown de la page affichée, mêmes
 *    tri et page que l'écran), « Exporter JSON » et « Exporter CSV » (liste
 *    filtrée COMPLÈTE, toutes pages, fichier daté remis par le parcours
 *    commun des exports du BO, `ExportFileButton`) ;
 *  · `AnomalyCopyButtons` (écran de traitement) : « Copier » (Markdown de
 *    l'anomalie et de ses occurrences récentes) et « Exporter JSON ».
 *
 * Le texte et les fichiers sont construits CÔTÉ SERVEUR (masquage, aucune
 * donnée personnelle, journal d'audit) ; le navigateur ne fait que copier ou
 * enregistrer. Textes à valider par le PO : `ANOMALY_EXPORT_TEXTS`.
 */
import { useState } from 'react';
import { Check, Copy, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ExportFileButton } from '@/components/admin/ExportFileButton';
import { copyText } from '@/app/admin/ai-executions/_components/CopyJson';
import { EXPORT_MESSAGES } from '@/lib/files/export-delivery';
import { exportFileName } from '@/lib/files/export-file-name';

/** Textes nouveaux — À VALIDER PAR LE PO (lot 113AI). */
export const ANOMALY_EXPORT_TEXTS = {
  copyPage: 'Copier la page',
  copyOne: 'Copier',
  copied: 'Copié',
  exportJson: 'Exporter JSON',
  exportCsv: 'Exporter CSV',
  hint: 'Pour une analyse externe : la copie reprend la page affichée ; l’export JSON / CSV reprend toute la liste (toutes les pages, même tri). Ni nom de compte ni e-mail : identifiants internes seulement.',
  copiedPage: 'Page copiée (Markdown) : prête à coller dans un outil d’analyse.',
  copiedOne: 'Anomalie copiée (Markdown) : prête à coller dans un outil d’analyse.',
  copyUnsupported: 'Copie impossible dans ce navigateur : utilisez « Exporter JSON ».',
} as const;

type Status = 'open' | 'resolved';

class CopyFailure extends Error {}

async function loadText(url: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'include', cache: 'no-store', headers: { Accept: 'text/markdown' } });
  } catch {
    throw new CopyFailure(EXPORT_MESSAGES.NETWORK);
  }
  if (res.status === 401) throw new CopyFailure(EXPORT_MESSAGES.SESSION_EXPIRED);
  if (res.status === 403) throw new CopyFailure(EXPORT_MESSAGES.FORBIDDEN);
  if (res.status === 404) throw new CopyFailure('Anomalie introuvable.');
  if (!res.ok || !/^text\/markdown\b/i.test(res.headers.get('content-type') ?? '')) throw new CopyFailure(EXPORT_MESSAGES.SERVER_ERROR);
  return res.text();
}

/**
 * Copie d'un texte servi par une route : presse-papiers asynchrone avec
 * promesse dans le `ClipboardItem` (Safari exige le geste), sinon copie
 * classique (`copyText`). Vrai si copié.
 */
async function copyFromUrl(url: string): Promise<boolean> {
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    let failure: unknown = null;
    const text = loadText(url).catch((e) => { failure = e; throw e; });
    void text.catch(() => undefined);
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': text.then((t) => new Blob([t], { type: 'text/plain' })) })]);
      return true;
    } catch {
      if (failure) throw failure;
      return copyText(await text);
    }
  }
  return copyText(await loadText(url));
}

function CopyButton({ url, label, success, testId }: { url: string; label: string; success: string; testId: string }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const run = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (await copyFromUrl(url)) {
        setDone(true);
        setTimeout(() => setDone(false), 2000);
        toast.success(success);
      } else toast.error(ANOMALY_EXPORT_TEXTS.copyUnsupported);
    } catch (e) {
      toast.error(e instanceof CopyFailure ? e.message : EXPORT_MESSAGES.SERVER_ERROR);
    } finally { setBusy(false); }
  };
  return (
    <Button size="sm" variant="outline" type="button" onClick={run} disabled={busy} aria-busy={busy} data-testid={testId}>
      {busy ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" aria-hidden /> : done ? <Check className="w-3.5 h-3.5 mr-1.5" aria-hidden /> : <Copy className="w-3.5 h-3.5 mr-1.5" aria-hidden />}
      {done ? ANOMALY_EXPORT_TEXTS.copied : label}
    </Button>
  );
}

export function anomalyExportUrl(status: Status, sort: string, dir: string, format: 'json' | 'csv' | 'md', page?: number): string {
  const q = new URLSearchParams({ status, sort, dir, format });
  if (page) q.set('page', String(page));
  return `/api/admin/anomalies/export?${q.toString()}`;
}

/** Barre d'export d'une liste (ouvertes ou historique), mêmes paramètres que le tableau. */
export function AnomalyListExportBar({ status, sort, dir, page, total }: { status: Status; sort: string; dir: string; page: number; total: number }) {
  const kind = status === 'open' ? 'ouvertes' : 'resolues';
  return (
    <div className="flex flex-wrap items-start justify-between gap-2" data-testid={`anomaly-export-${status}`}>
      <p className="text-xs text-muted-foreground max-w-3xl">{ANOMALY_EXPORT_TEXTS.hint}</p>
      <div className="flex flex-wrap items-start gap-1.5">
        <CopyButton url={anomalyExportUrl(status, sort, dir, 'md', page)} label={ANOMALY_EXPORT_TEXTS.copyPage}
          success={ANOMALY_EXPORT_TEXTS.copiedPage} testId={`anomaly-copy-page-${status}`} />
        <ExportFileButton url={anomalyExportUrl(status, sort, dir, 'json')} kind="json" label={`${ANOMALY_EXPORT_TEXTS.exportJson} (${total})`}
          fallbackName={exportFileName('anomalies', kind, new Date(), { ext: 'json' })} testId={`anomaly-export-json-${status}`} />
        <ExportFileButton url={anomalyExportUrl(status, sort, dir, 'csv')} kind="csv" label={`${ANOMALY_EXPORT_TEXTS.exportCsv} (${total})`}
          fallbackName={exportFileName('anomalies', kind, new Date(), { ext: 'csv' })} testId={`anomaly-export-csv-${status}`} />
      </div>
    </div>
  );
}

/** Écran de traitement : copie Markdown et export JSON de l'anomalie. */
export function AnomalyCopyButtons({ id }: { id: number }) {
  return (
    <div className="flex flex-wrap items-start gap-1.5" data-testid="anomaly-copy">
      <CopyButton url={`/api/admin/anomalies/${id}/export?format=md`} label={ANOMALY_EXPORT_TEXTS.copyOne}
        success={ANOMALY_EXPORT_TEXTS.copiedOne} testId="anomaly-copy-one" />
      <ExportFileButton url={`/api/admin/anomalies/${id}/export?format=json&download=1`} kind="json" label={ANOMALY_EXPORT_TEXTS.exportJson}
        fallbackName={exportFileName('anomalie', id, new Date(), { ext: 'json' })} testId="anomaly-export-one" />
    </div>
  );
}
