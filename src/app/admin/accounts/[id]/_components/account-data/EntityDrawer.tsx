"use client";

/**
 * Tiroir commun « Données du compte » (lot 75N), basé sur le `Sheet` existant.
 *
 *   · UN seul tiroir : un clic sur une relation REMPLACE son contenu et
 *     empile l'entité précédente dans un historique (« Retour ») ; jamais
 *     deux tiroirs ;
 *   · en-tête : type, nom, identifiant BDD, statut réel ; actions Copier
 *     (texte lisible / JSON), Télécharger (JSON, CSV, TXT), Actualiser,
 *     Fermer ;
 *   · lot 81C — CONSULTATION PAGINÉE / EXPORT INTÉGRAL : le tiroir affiche
 *     une page par section avec son total réel (navigation et recherche par
 *     le serveur) ; « Copier tout » et « Télécharger » récupèrent l'EXPORT
 *     INTÉGRAL généré par le serveur (jamais les lignes affichées), dont le
 *     statut (COMPLETE / PARTIAL / FAILED) est lu en fin de fichier et
 *     affiché ; au-delà de `COPY_MAX_ROWS` lignes, la copie propose
 *     l'export intégral (fichier) au lieu du presse-papiers ;
 *   · onglets Synthèse, Données BDD, Relations, Preuves et historique ;
 *     Opération : vue de diagnostic existante (`OperationDetailView`) ;
 *   · lecture seule : uniquement des GET ; copier ne ferme pas le tiroir.
 *
 * Desktop : panneau latéral large ; mobile : pleine largeur, boutons d'au
 * moins 28 px, en-tête qui passe à la ligne.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ChevronDown, Copy, Download, Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  COPY_MAX_ROWS, ENTITY_LABELS, TABS, TAB_LABELS, exportFileName, exportStatusFromTail,
  type DossierSection, type EntityDossier, type EntityType, type ExportFormat, type ExtractionStatus,
} from '@/services/admin/account-data/model';
import type { OperationDetail } from '@/services/business-operations/diagnostics/service';
import { OperationDetailView } from '@/app/admin/operations/_components/views';
import { CopyButton, SectionCard, fmtInt, type SectionActions } from './DossierView';
import { copyText } from '@/app/admin/ai-executions/_components/CopyJson';

export interface EntityRefValue { type: EntityType; id: number }

export function entityUrl(accountId: number, ref: EntityRefValue, format?: ExportFormat, section?: string, page?: { offset: number; q: string | null }): string {
  const qs = new URLSearchParams();
  if (format) qs.set('format', format);
  if (section) qs.set('section', section);
  if (page) {
    qs.set('offset', String(page.offset));
    if (page.q) qs.set('q', page.q);
  }
  const q = qs.toString();
  return `/api/admin/accounts/${accountId}/entities/${ref.type}/${ref.id}${q ? `?${q}` : ''}`;
}

/** Lot 81C — éléments d'un dossier en base (total réel des sections paginées + champs) : seuil de la copie. */
export function dossierRowCount(d: Pick<EntityDossier, 'sections'>): number {
  return d.sections.reduce((n, s) => n + (s.window?.total ?? s.table?.rows.length ?? s.relations?.length ?? 0) + (s.fields?.length ?? 0), 0);
}

/** Statut d'un export lu en fin de fichier (marque écrite en dernier par le serveur). */
async function statusOf(blob: Blob, format: ExportFormat): Promise<ExtractionStatus | null> {
  if (format === 'csv' && blob.size === 0) return null;
  const tail = await blob.slice(Math.max(0, blob.size - 16_384)).text();
  return exportStatusFromTail(format, tail);
}

/** Historique de navigation du tiroir (pur, testé). */
export function pushHistory(stack: EntityRefValue[], current: EntityRefValue | null, next: EntityRefValue): EntityRefValue[] {
  if (!current || (current.type === next.type && current.id === next.id)) return stack;
  return [...stack, current].slice(-50);
}

export function EntityDrawer({ accountId, current, openSeq, onChange, onClose }: {
  accountId: number;
  current: EntityRefValue | null;
  /** Incrémenté à chaque ouverture depuis la liste : l'historique repart de zéro. */
  openSeq: number;
  /** Remplace l'entité affichée (navigation dans le même tiroir). */
  onChange: (ref: EntityRefValue | null) => void;
  onClose: () => void;
}) {
  const [history, setHistory] = useState<EntityRefValue[]>([]);
  const [data, setData] = useState<EntityDossier | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<string>('synthese');
  const [downloading, setDownloading] = useState<ExportFormat | null>(null);
  const [copying, setCopying] = useState(false);
  /** Dernier export intégral : format, statut lu en fin de fichier, génération. */
  const [lastExport, setLastExport] = useState<{ format: ExportFormat; status: ExtractionStatus | 'INTERROMPU'; id: string | null; section: string | null } | null>(null);

  const load = useCallback(async (ref: EntityRefValue) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(entityUrl(accountId, ref), { credentials: 'include', cache: 'no-store' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || body.message || `Erreur ${res.status}`);
      setData(body as EntityDossier);
    } catch (e) {
      setData(null);
      setError(e instanceof Error ? e.message : 'Chargement impossible.');
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => { setHistory([]); setTab('synthese'); }, [openSeq]);

  useEffect(() => {
    if (current) void load(current);
    else { setData(null); setHistory([]); }
  }, [current, load]);

  const navigate = useCallback((type: EntityType, id: number) => {
    const next = { type, id };
    setHistory((h) => pushHistory(h, current, next));
    setTab('synthese');
    onChange(next);
  }, [current, onChange]);

  const back = () => {
    const prev = history[history.length - 1];
    if (!prev) return;
    setHistory(history.slice(0, -1));
    onChange(prev);
  };

  /** Export intégral généré par le serveur (dossier ou section) : contenu, statut, génération. */
  const fetchExport = useCallback(async (format: ExportFormat, section?: string) => {
    if (!current) throw new Error('aucune entité');
    const res = await fetch(entityUrl(accountId, current, format, section), { credentials: 'include', cache: 'no-store' });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      throw new Error(b.error || `Erreur ${res.status}`);
    }
    const id = res.headers.get('X-Verebona-Export-Id');
    let blob: Blob;
    try {
      blob = await res.blob();
    } catch {
      setLastExport({ format, status: 'INTERROMPU', id, section: section ?? null });
      throw new Error('export interrompu avant la fin : fichier incomplet, non enregistré');
    }
    // CSV d'une section : pas de marque (un échec interrompt le flux) — reçu en entier = complet.
    const status = format === 'csv' && section ? 'COMPLETE' : await statusOf(blob, format);
    if (!status) {
      setLastExport({ format, status: 'INTERROMPU', id, section: section ?? null });
      throw new Error('fin de fichier absente : export interrompu, non enregistré');
    }
    setLastExport({ format, status, id, section: section ?? null });
    const cd = res.headers.get('Content-Disposition') ?? '';
    return { blob, status, name: /filename="([^"]+)"/.exec(cd)?.[1] ?? `verebona-export.${format}` };
  }, [accountId, current]);

  const download = async (format: ExportFormat) => {
    if (!current) return;
    setDownloading(format);
    try {
      const { blob, status, name } = await fetchExport(format);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      if (status !== 'COMPLETE') toast.warning(`Export ${format.toUpperCase()} téléchargé : statut ${status} — le fichier le signale (complétude en fin de fichier).`);
      else toast.success(`Export intégral ${format.toUpperCase()} téléchargé (COMPLETE).`, { duration: 2000 });
    } catch (e) {
      toast.error(`Téléchargement impossible : ${e instanceof Error ? e.message : 'erreur'}`);
    } finally {
      setDownloading(null);
    }
  };

  /**
   * « Copier tout » / copie de section : export INTÉGRAL du serveur copié dans
   * le presse-papiers ; au-delà de `COPY_MAX_ROWS`, l'export intégral
   * (fichier) est proposé à la place — jamais de copie partielle.
   */
  const copyExport = async (format: 'txt' | 'json', rows: number, section?: DossierSection) => {
    const what = section ? `la section « ${section.title} »` : 'le dossier';
    if (rows > COPY_MAX_ROWS) {
      toast.warning(`${fmtInt(rows)} éléments : trop volumineux pour le presse-papiers. Utilisez l’export intégral (fichier).`, {
        duration: 8000,
        action: { label: 'Télécharger', onClick: () => { if (section) window.location.assign(entityUrl(accountId, current!, 'csv', section.id)); else void download(format); } },
      });
      return;
    }
    setCopying(true);
    try {
      let status: ExtractionStatus = 'COMPLETE';
      const text = async () => { const r = await fetchExport(format, section?.id); status = r.status; return r.blob.text(); };
      let ok = false;
      // Presse-papiers asynchrone (Safari exige le geste : promesse dans le ClipboardItem).
      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
        try {
          await navigator.clipboard.write([new ClipboardItem({ 'text/plain': text().then((t) => new Blob([t], { type: 'text/plain' })) })]);
          ok = true;
        } catch (e) {
          if (e instanceof Error && /interrompu|absente|Erreur/.test(e.message)) throw e;
        }
      }
      if (!ok) ok = await copyText(await text());
      if (!ok) { toast.error('Copie impossible dans ce navigateur : utilisez « Télécharger ».'); return; }
      if (status !== 'COMPLETE') toast.warning(`Copié : ${what} — statut ${status} (le texte copié le signale).`);
      else toast.success(`Copié : ${what} en entier (${format === 'txt' ? 'texte' : 'JSON'}).`, { duration: 1800 });
    } catch (e) {
      toast.error(`Copie impossible : ${e instanceof Error ? e.message : 'erreur'}`);
    } finally {
      setCopying(false);
    }
  };

  /** Page d'une section (navigation, recherche) : remplace la section dans le dossier affiché. */
  const loadPage = useCallback(async (sectionId: string, offset: number, q: string | null) => {
    if (!current) return;
    const res = await fetch(entityUrl(accountId, current, undefined, sectionId, { offset, q }), { credentials: 'include', cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Erreur ${res.status}`);
    const sec = body.section as DossierSection;
    setData((d) => (d ? { ...d, sections: d.sections.map((x) => (x.id === sec.id ? sec : x)) } : d));
  }, [accountId, current]);

  const actions: SectionActions | undefined = current ? {
    loadPage,
    exportUrl: (sid, format) => entityUrl(accountId, current, format, sid),
    copySection: (sec) => copyExport('json', (sec.window?.total ?? 0) + (sec.fields?.length ?? 0), sec),
  } : undefined;

  const csvName = useMemo(() => (sid: string) => (data ? exportFileName(data, 'csv', sid) : `${sid}.csv`), [data]);
  const op = data?.entity.type === 'operation' ? (data.operationDetail as OperationDetail | undefined) : undefined;

  return (
    <Sheet open={current !== null} onOpenChange={(o) => { if (!o) { setHistory([]); onClose(); } }}>
      <SheetContent side="right" className="w-full sm:max-w-3xl lg:max-w-4xl p-0 gap-0 overflow-hidden" data-account-data-drawer>
        {/* En-tête */}
        <div className="border-b px-4 pt-3 pb-2.5 pr-12 space-y-2">
          <div className="flex items-start gap-2 min-w-0">
            {history.length > 0 && (
              <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={back} aria-label="Revenir à l’entité précédente" title="Revenir à l’entité précédente">
                <ArrowLeft className="h-4 w-4" />
              </Button>
            )}
            <div className="min-w-0">
              <p className="text-[11px] text-muted-foreground">
                {current ? ENTITY_LABELS[current.type] : ''}{data ? ` · table ${data.entity.table}` : ''}
              </p>
              <SheetTitle className="break-words">{data?.entity.name ?? (current ? `${ENTITY_LABELS[current.type]} #${current.id}` : '')}</SheetTitle>
              <SheetDescription className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                {current && (
                  <span className="inline-flex items-center gap-1 font-mono">id {current.id}<CopyButton text={String(current.id)} label="l’identifiant BDD" /></span>
                )}
                {data && <span>Statut réel : <span className="font-medium text-foreground">{data.entity.statusLabel ?? data.entity.status ?? 'NULL'}</span></span>}
                {data && <span>Extraction : {data.extractedAt}</span>}
              </SheetDescription>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" disabled={!data || copying} className="gap-1.5">
                  {copying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Copy className="h-3.5 w-3.5" />}Copier tout<ChevronDown className="h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuLabel>Dossier entier (export intégral du serveur{data ? ` — ${fmtInt(dossierRowCount(data))} éléments` : ''})</DropdownMenuLabel>
                <DropdownMenuItem onSelect={() => data && void copyExport('txt', dossierRowCount(data))}>Texte lisible</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => data && void copyExport('json', dossierRowCount(data))}>JSON</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="font-normal text-[11px] text-muted-foreground">Au-delà de {fmtInt(COPY_MAX_ROWS)} éléments : export intégral (fichier)</DropdownMenuLabel>
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" disabled={!current || downloading !== null} className="gap-1.5">
                  {downloading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}Télécharger<ChevronDown className="h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuLabel>Export intégral (généré par le serveur, toutes les lignes)</DropdownMenuLabel>
                <DropdownMenuItem onSelect={() => void download('json')}>JSON — format de référence</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void download('csv')}>CSV — toutes les sections</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void download('txt')}>TXT — lecture humaine</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="font-normal text-[11px] text-muted-foreground">CSV d’une section : bouton de la section</DropdownMenuLabel>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button variant="outline" size="sm" onClick={() => current && void load(current)} disabled={loading || !current} className="gap-1.5">
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />Actualiser
            </Button>
          </div>
          {data && !data.complete && (
            <div role="alert" className="rounded-lg border border-[color:var(--border-warning)] bg-[color:var(--bg-warning)] px-3 py-2 text-xs">
              <p className="font-medium">Sections non chargées — la copie et les exports le signalent.</p>
              <ul className="list-disc pl-4">{data.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
            </div>
          )}
          {data && (
            <p className="text-[11px] text-muted-foreground" data-consultation-note>
              Consultation paginée ({fmtInt(dossierRowCount(data))} éléments en base, instantané {data.snapshot?.at ?? data.extractedAt}) ; « Copier tout » et « Télécharger » produisent l’export intégral.
            </p>
          )}
          {lastExport && (
            <p role="status" data-last-export className={`text-[11px] ${lastExport.status === 'COMPLETE' ? 'text-muted-foreground' : 'text-[color:var(--text-danger)] font-medium'}`}>
              Dernier export {lastExport.format.toUpperCase()}{lastExport.section ? ` (section ${lastExport.section})` : ''} : {lastExport.status === 'INTERROMPU' ? 'INTERROMPU — fichier non enregistré' : lastExport.status}
              {lastExport.id ? ` · génération ${lastExport.id.slice(0, 8)}` : ''}
            </p>
          )}
        </div>

        {/* Corps */}
        <div className="flex-1 overflow-y-auto px-4 py-3" aria-busy={loading}>
          {error ? (
            <div role="alert" className="rounded-lg border border-[color:var(--border-danger)] bg-[color:var(--bg-danger)] p-3 text-sm text-[color:var(--text-danger)]">
              {error} <button type="button" className="underline" onClick={() => current && void load(current)}>Réessayer</button>
            </div>
          ) : !data ? (
            <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
          ) : (
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList className="flex-wrap h-auto w-full sm:w-fit">
                {TABS.map((t) => (
                  <TabsTrigger key={t} value={t} className="text-xs sm:text-[13px]">
                    {TAB_LABELS[t]} <span className="opacity-70">({data.sections.filter((s) => s.tab === t).length})</span>
                  </TabsTrigger>
                ))}
              </TabsList>
              {TABS.map((t) => (
                <TabsContent key={t} value={t} className="space-y-3 mt-2">
                  {t === 'synthese' && op && (
                    <div className="rounded-xl border bg-card p-3 text-sm">
                      <OperationDetailView d={op} onNavigate={(type, id) => navigate(type, id)} />
                    </div>
                  )}
                  {data.sections.filter((s) => s.tab === t).map((s) => (
                    <SectionCard key={s.id} s={s} onNavigate={navigate} csvName={csvName} actions={actions} />
                  ))}
                </TabsContent>
              ))}
            </Tabs>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
