"use client"

/**
 * Tiroir « Transfert et récupération » de l'onglet Exports : export de
 * données brutes (ZIP de fichiers, hors dossiers prêts à l'emploi — EXC-001)
 * et transmission du bien à un autre compte.
 *
 * Repris de l'ancien `ExportPrepareDrawer` : les six dossiers prêts à
 * l'emploi passent désormais par l'écran de préparation
 * (`/assets/{id}/exports/{dossier}`, CDC V12 §5) ; ce tiroir ne sert plus
 * qu'à ces deux usages, sans pré-sélection ni sensibilité (l'utilisateur
 * récupère ou transmet ses propres fichiers).
 */

import { useCallback, useEffect, useState } from 'react';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { CalendarDays, ChevronDown, ChevronRight, Download, FileText, Image, Loader2, Package, Send, Wrench, X } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { toast } from 'sonner';
import { DOCUMENT_TYPE_LABELS } from '@/lib/document-type-constants';
import { displayDocumentTitle } from '@/lib/documents/document-title-rules';

export type TransferUsage = 'EXPORT_BRUT' | 'TRANSMISSION';

interface Row { id: number; name: string; meta?: string | null }

interface Props {
  assetId: number;
  usage: TransferUsage;
  planType: string;
  assetCategory: string;
  thumbnailUrl?: string | null;
  onClose: () => void;
  onSuccess: () => void;
}

const fmtDate = (d: string | null | undefined) =>
  d ? new Date(`${String(d).slice(0, 10)}T12:00:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }) : null;

function Group({ icon: Icon, label, rows, selected, onToggle, onToggleAll, extra, emptyLabel }: {
  icon: React.ElementType; label: string; rows: Row[]; selected: Set<number>;
  onToggle: (id: number) => void; onToggleAll: () => void; extra?: React.ReactNode; emptyLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const all = rows.length > 0 && selected.size === rows.length;
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <div className="flex items-center gap-3 px-3 py-2.5">
        <Checkbox checked={all ? true : selected.size > 0 ? 'indeterminate' : false} onCheckedChange={onToggleAll} aria-label={`Tout sélectionner : ${label}`} />
        <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="flex-1 text-sm font-medium">{label}</span>
          <Badge variant="secondary" className="px-1.5 text-[10px]">{selected.size}</Badge>
          {open ? <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden /> : <ChevronRight className="size-3.5 text-muted-foreground" aria-hidden />}
        </button>
      </div>
      {open && (
        <div className="divide-y border-t">
          {extra}
          {rows.map((r) => (
            <label key={r.id} className="flex cursor-pointer items-start gap-3 px-4 py-2.5 hover:bg-[var(--accent-soft)]">
              <Checkbox checked={selected.has(r.id)} onCheckedChange={() => onToggle(r.id)} className="mt-0.5" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium">{r.name}</span>
                {r.meta && <span className="mt-0.5 block text-[10px] text-muted-foreground">{r.meta}</span>}
              </span>
            </label>
          ))}
          {rows.length === 0 && !extra && <p className="px-4 py-3 text-xs text-muted-foreground">{emptyLabel}</p>}
        </div>
      )}
    </div>
  );
}

const toggleIn = (set: Set<number>, id: number) => { const n = new Set(set); if (n.has(id)) n.delete(id); else n.add(id); return n; };

export function TransferExportDrawer({ assetId, usage, planType, assetCategory, thumbnailUrl, onClose, onSuccess }: Props) {
  const isTransmission = usage === 'TRANSMISSION';
  const showEquips = assetCategory === 'IMMOBILIER';
  const [loading, setLoading] = useState(true);
  const [docs, setDocs] = useState<Row[]>([]);
  const [photos, setPhotos] = useState<Row[]>([]);
  const [equips, setEquips] = useState<Row[]>([]);
  const [agenda, setAgenda] = useState<Row[]>([]);
  const [selDocs, setSelDocs] = useState<Set<number>>(new Set());
  const [selPhotos, setSelPhotos] = useState<Set<number>>(new Set());
  const [selEquips, setSelEquips] = useState<Set<number>>(new Set());
  const [selAgenda, setSelAgenda] = useState<Set<number>>(new Set());
  const [recipientEmail, setRecipientEmail] = useState('');
  const [keepActive, setKeepActive] = useState(false);
  const [includeThumbnail, setIncludeThumbnail] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const safe = <T,>(p: Promise<T>) => p.catch(() => null);
    (async () => {
      const [files, eqs, ag] = await Promise.all([
        safe(apiClient.get<unknown>(`/api/files?assetId=${assetId}&uploadStatus=COMPLETED&limit=500`)),
        showEquips ? safe(apiClient.get<unknown>(`/api/assets/${assetId}/equipments`)) : Promise.resolve(null),
        isTransmission ? safe(apiClient.get<unknown>(`/api/agenda?assetIds=${assetId}&period=all&includeUndated=true&includeCancelled=false`)) : Promise.resolve(null),
      ]);
      if (cancelled) return;
      const list = <T,>(r: unknown, ...keys: string[]): T[] => {
        if (Array.isArray(r)) return r as T[];
        for (const k of keys) { const v = (r as Record<string, unknown> | null)?.[k]; if (Array.isArray(v)) return v as T[]; }
        return [];
      };
      type F = { id: number; mimeType?: string | null; isWebLink?: boolean; retainedTitle?: string | null; originalFilename?: string | null; documentType?: string | null; documentDate?: string | null };
      const all = list<F>(files, 'data');
      const d = all.filter((f) => !f.mimeType?.startsWith('image/')).map((f) => ({
        id: f.id, name: displayDocumentTitle(f, `Document ${f.id}`),
        meta: [DOCUMENT_TYPE_LABELS[f.documentType ?? ''] ?? f.documentType, fmtDate(f.documentDate)].filter(Boolean).join(' · ') || null,
      }));
      const p = all.filter((f) => f.mimeType?.startsWith('image/') && !f.isWebLink).map((f) => ({ id: f.id, name: displayDocumentTitle(f, `Photo ${f.id}`) }));
      const e = list<{ id: number; name: string; category?: string }>(eqs, 'data', 'items').map((x) => ({ id: x.id, name: x.name, meta: x.category ?? null }));
      const a = list<{ id: number; title: string; startDate?: string | null }>(ag, 'items', 'data').map((x) => ({ id: x.id, name: x.title, meta: fmtDate(x.startDate) }));
      setDocs(d); setPhotos(p); setEquips(e); setAgenda(a);
      setSelDocs(new Set(d.map((x) => x.id))); setSelPhotos(new Set(p.map((x) => x.id)));
      setSelEquips(new Set(e.map((x) => x.id))); setSelAgenda(new Set(a.map((x) => x.id)));
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [assetId, showEquips, isTransmission]);

  const submit = useCallback(async () => {
    setBusy(true);
    try {
      if (isTransmission) {
        if (!recipientEmail.trim()) { toast.error('Saisissez l’adresse e-mail du destinataire.'); return; }
        await apiClient.post(`/api/assets/${assetId}/transmission`, {
          recipientEmail: recipientEmail.trim(),
          keepActiveAfterTransmission: keepActive,
          selectedPayload: {
            includeDocuments: selDocs.size > 0, selectedDocIds: [...selDocs],
            includeEquipments: selEquips.size > 0, selectedEquipmentIds: [...selEquips],
            includePhotos: selPhotos.size > 0, selectedPhotoIds: [...selPhotos],
            includeEvents: selAgenda.size > 0, selectedEventIds: [...selAgenda],
            includeThumbnail: !!(thumbnailUrl && includeThumbnail),
          },
        });
        toast.success('Invitation de transmission envoyée');
        onSuccess();
        return;
      }
      // Export brut : une sélection partielle transmet documents ET images,
      // pour que le ZIP contienne exactement ce qui est coché.
      const partial = selDocs.size < docs.length || selPhotos.size < photos.length;
      const res = await apiClient.post<{ status: string; errorMessage?: string; downloadUrl?: string; downloadZipUrl?: string }>(
        `/api/assets/${assetId}/exports`,
        {
          exportType: 'EXPORT_BRUT', requestedOutputs: ['ZIP'],
          options: { includePhotos: selPhotos.size > 0, includeEquipments: selEquips.size > 0, customDocIds: partial ? [...selDocs, ...selPhotos] : undefined },
        },
      );
      if (res.status === 'error') toast.error(res.errorMessage ?? 'L’export n’a pas pu être produit.');
      else {
        toast.success('Export généré');
        const url = res.downloadZipUrl ?? res.downloadUrl;
        if (url) window.open(url, '_blank', 'noopener,noreferrer');
      }
      onSuccess();
    } catch (err) {
      toast.error((err as { serverMessage?: string })?.serverMessage ?? 'Une erreur est survenue. Réessayez.');
    } finally {
      setBusy(false);
    }
  }, [isTransmission, recipientEmail, assetId, keepActive, selDocs, selEquips, selPhotos, selAgenda, thumbnailUrl, includeThumbnail, onSuccess, docs.length, photos.length]);

  const Icon = isTransmission ? Send : Package;
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col p-0 sm:max-w-lg">
        <div className="flex items-center gap-3 border-b px-6 py-5">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10"><Icon className="size-4 text-primary" aria-hidden /></div>
          <div className="min-w-0 flex-1">
            <SheetTitle className="text-base">{isTransmission ? 'Transmission du bien' : 'Export données brutes'}</SheetTitle>
            <SheetDescription className="text-xs">
              {isTransmission ? 'Transférez une copie du bien vers un autre compte Verebona.' : 'Vos fichiers et données en un ZIP téléchargeable.'}
            </SheetDescription>
          </div>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-5 px-6 py-5">
            {loading ? (
              <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden />Chargement du contenu du bien…</div>
            ) : (
              <div className="space-y-2">
                <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Contenu à inclure</p>
                <Group icon={FileText} label="Documents" rows={docs} selected={selDocs} emptyLabel="Aucun document"
                  onToggle={(id) => setSelDocs((s) => toggleIn(s, id))} onToggleAll={() => setSelDocs((s) => (s.size === docs.length ? new Set() : new Set(docs.map((x) => x.id))))} />
                <Group icon={Image} label="Photos" rows={photos} selected={selPhotos} emptyLabel="Aucune photo"
                  onToggle={(id) => setSelPhotos((s) => toggleIn(s, id))} onToggleAll={() => setSelPhotos((s) => (s.size === photos.length ? new Set() : new Set(photos.map((x) => x.id))))}
                  extra={isTransmission && thumbnailUrl ? (
                    <label className="flex cursor-pointer items-center gap-3 px-4 py-2.5 hover:bg-[var(--accent-soft)]">
                      <Checkbox checked={includeThumbnail} onCheckedChange={(v) => setIncludeThumbnail(v === true)} />
                      <span className="min-w-0 flex-1"><span className="block text-xs font-medium">Vignette du bien</span><span className="block text-[10px] text-muted-foreground">Photo principale affichée sur la fiche</span></span>
                    </label>
                  ) : undefined} />
                {showEquips && (
                  <Group icon={Wrench} label="Équipements" rows={equips} selected={selEquips} emptyLabel="Aucun équipement"
                    onToggle={(id) => setSelEquips((s) => toggleIn(s, id))} onToggleAll={() => setSelEquips((s) => (s.size === equips.length ? new Set() : new Set(equips.map((x) => x.id))))} />
                )}
                {isTransmission && (
                  <Group icon={CalendarDays} label="Agenda" rows={agenda} selected={selAgenda} emptyLabel="Aucun élément d’agenda"
                    onToggle={(id) => setSelAgenda((s) => toggleIn(s, id))} onToggleAll={() => setSelAgenda((s) => (s.size === agenda.length ? new Set() : new Set(agenda.map((x) => x.id))))} />
                )}
              </div>
            )}

            {isTransmission ? (
              <div className="space-y-5">
                <div className="space-y-2 rounded-lg border bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
                  <p className="font-medium text-foreground">Comment fonctionne la transmission ?</p>
                  <ol className="list-decimal space-y-1.5 pl-4">
                    <li>Un e-mail est envoyé au destinataire avec un lien sécurisé pour accepter ou refuser.</li>
                    <li>S’il accepte, une copie du bien (données et éléments sélectionnés) est créée dans son espace.</li>
                    <li>Vous suivez le statut de l’invitation depuis cet onglet.</li>
                  </ol>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="transfer-recipient">E-mail du destinataire</Label>
                  <Input id="transfer-recipient" type="email" autoComplete="email" placeholder="nom@exemple.fr" value={recipientEmail} onChange={(e) => setRecipientEmail(e.target.value)} required />
                </div>
                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium">Statut du bien après transmission</legend>
                  <div className="grid grid-cols-2 gap-2 pt-1">
                    {[
                      { v: false, t: 'Passer en Transmis', d: 'Le bien est marqué transmis et quitte votre portefeuille actif.' },
                      { v: true, t: 'Conserver actif', d: 'Le bien reste visible et actif dans votre portefeuille.' },
                    ].map((o) => (
                      <button key={o.t} type="button" aria-pressed={keepActive === o.v} onClick={() => setKeepActive(o.v)}
                        className={`flex flex-col items-start gap-1 rounded-lg border px-3 py-2.5 text-left transition-colors ${keepActive === o.v ? 'border-primary bg-primary/5 text-foreground' : 'border-border text-muted-foreground hover:bg-muted/40'}`}>
                        <span className="text-xs font-semibold">{o.t}</span><span className="text-[11px] leading-snug">{o.d}</span>
                      </button>
                    ))}
                  </div>
                </fieldset>
              </div>
            ) : (
              <div className="rounded-lg bg-muted/50 px-4 py-3 text-xs text-muted-foreground">
                {planType !== 'STANDARD' ? 'ZIP structuré par catégorie documentaire, avec récapitulatif des données du bien.' : 'ZIP brut à plat : tous vos fichiers en un seul téléchargement.'}
              </div>
            )}
          </div>
        </ScrollArea>

        <div className="flex gap-2 border-t px-5 py-4">
          <Button type="button" variant="ghost" className="flex-1" onClick={onClose} disabled={busy}><X aria-hidden />Annuler</Button>
          <Button type="button" className="flex-1" onClick={submit} disabled={busy || loading}>
            {busy ? <Loader2 className="animate-spin" aria-hidden /> : isTransmission ? <Send aria-hidden /> : <Download aria-hidden />}
            {isTransmission ? 'Transmettre' : 'Télécharger'}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
