"use client";

/**
 * Tiroir commun « Données du compte » (lot 75N), basé sur le `Sheet` existant.
 *
 *   · UN seul tiroir : un clic sur une relation REMPLACE son contenu et
 *     empile l'entité précédente dans un historique (« Retour ») ; jamais
 *     deux tiroirs ;
 *   · en-tête : type, nom, identifiant BDD, statut réel ; actions Copier
 *     (texte lisible / JSON), Télécharger (JSON, CSV, TXT — générés par le
 *     serveur, complets), Actualiser, Fermer ;
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
  ENTITY_LABELS, TABS, TAB_LABELS, dossierToJson, dossierToText, exportFileName,
  type EntityDossier, type EntityType, type ExportFormat,
} from '@/services/admin/account-data/model';
import type { OperationDetail } from '@/services/business-operations/diagnostics/service';
import { OperationDetailView } from '@/app/admin/operations/_components/views';
import { CopyButton, SectionCard, copyWithFeedback } from './DossierView';

export interface EntityRefValue { type: EntityType; id: number }

export function entityUrl(accountId: number, ref: EntityRefValue, format?: ExportFormat, section?: string): string {
  const qs = new URLSearchParams();
  if (format) qs.set('format', format);
  if (section) qs.set('section', section);
  const q = qs.toString();
  return `/api/admin/accounts/${accountId}/entities/${ref.type}/${ref.id}${q ? `?${q}` : ''}`;
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

  const download = async (format: ExportFormat) => {
    if (!current) return;
    setDownloading(format);
    try {
      const res = await fetch(entityUrl(accountId, current, format), { credentials: 'include', cache: 'no-store' });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error || `Erreur ${res.status}`);
      }
      const blob = await res.blob();
      const cd = res.headers.get('Content-Disposition') ?? '';
      const name = /filename="([^"]+)"/.exec(cd)?.[1] ?? `verebona-export.${format}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      if (res.headers.get('X-Verebona-Export-Complete') === 'false') toast.warning('Export téléchargé : extraction INCOMPLÈTE (voir les avertissements du fichier).');
      else toast.success(`Fichier ${format.toUpperCase()} téléchargé.`, { duration: 1500 });
    } catch (e) {
      toast.error(`Téléchargement impossible : ${e instanceof Error ? e.message : 'erreur'}`);
    } finally {
      setDownloading(null);
    }
  };

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
                <Button variant="outline" size="sm" disabled={!data} className="gap-1.5"><Copy className="h-3.5 w-3.5" />Copier tout<ChevronDown className="h-3 w-3" /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuLabel>Contenu complet du tiroir</DropdownMenuLabel>
                <DropdownMenuItem onSelect={() => data && void copyWithFeedback(dossierToText(data), 'Texte lisible')}>Texte lisible</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => data && void copyWithFeedback(dossierToJson(data), 'JSON')}>JSON</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" disabled={!current || downloading !== null} className="gap-1.5">
                  {downloading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}Télécharger<ChevronDown className="h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuLabel>Export complet (généré par le serveur)</DropdownMenuLabel>
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
              <p className="font-medium">Extraction incomplète — la copie et les exports le signalent.</p>
              <ul className="list-disc pl-4">{data.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
            </div>
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
                    <SectionCard key={s.id} s={s} onNavigate={navigate} csvName={csvName} />
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
