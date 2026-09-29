"use client"

/**
 * Sélecteurs de pièces et de photos DU BIEN pour les listes structurées des
 * informations complémentaires (dommages, actions, échanges, éléments à
 * assurer). Les identifiants proposés viennent de `GET …/additional-infos
 * ?include=references` : ce sont ceux que le moteur de dossiers retrouvera.
 *
 * Une pièce sensible peut être liée : elle n'apparaîtra dans le PDF que si
 * elle est retenue à la préparation du dossier — le sélecteur le signale.
 * Une pièce portant des données d'occupant n'est jamais proposée (elle n'est
 * jamais incluse dans un dossier).
 */
import { useEffect, useMemo, useState } from 'react';
import { Check, FileText, ImageIcon, Paperclip, ShieldAlert, X } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Input } from '@/components/ui/input';
import type { AdditionalInfoReferencesDto } from '@/lib/assets/additional-infos';

type Doc = AdditionalInfoReferencesDto['documents'][number];
type Photo = AdditionalInfoReferencesDto['photos'][number];

const frDate = (d: string | null) => (d ? d.slice(0, 10).split('-').reverse().join('/') : '');

/** Vignettes : URL signée demandée à l'ouverture du sélecteur, une fois par fichier. */
const thumbCache = new Map<number, string | null>();

function useThumbnails(fileIds: number[], enabled: boolean): Record<number, string | null> {
  const [urls, setUrls] = useState<Record<number, string | null>>({});
  const key = fileIds.join(',');
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const missing = fileIds.filter((id) => !thumbCache.has(id));
    void Promise.all(missing.map(async (id) => {
      try {
        const r = await fetch(`/api/files/${id}/view`, { credentials: 'include' });
        thumbCache.set(id, r.ok ? ((await r.json()) as { viewUrl?: string }).viewUrl ?? null : null);
      } catch {
        thumbCache.set(id, null);
      }
    })).then(() => {
      if (!cancelled) setUrls(Object.fromEntries(fileIds.map((id) => [id, thumbCache.get(id) ?? null])));
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);
  return urls;
}

interface MultiProps {
  kind: 'photos' | 'documents';
  value: number[];
  onChange: (ids: number[]) => void;
  documents: Doc[];
  photos: Photo[];
  max: number;
  disabled?: boolean;
  label: string;
  invalid?: boolean;
  id?: string;
}

/** Multi-sélection (photos ou pièces), pastilles retirables sous le bouton. */
export function AdditionalInfosRefPicker({ kind, value, onChange, documents, photos, max, disabled, label, invalid, id }: MultiProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const isPhoto = kind === 'photos';
  const options = useMemo(() => (isPhoto
    ? photos.map((p) => ({ id: p.id, title: p.caption || `Photo du ${frDate(p.date)}` || 'Photo', meta: frDate(p.date), fileId: p.fileId, flag: null as string | null }))
    : documents.filter((d) => !d.occupantData).map((d) => ({ id: d.id, title: d.title, meta: [d.typeLabel, frDate(d.date)].filter(Boolean).join(' · '), fileId: null, flag: d.sensitive ? 'Sensible : incluse seulement si vous la cochez' : null }))),
  [isPhoto, photos, documents]);
  const thumbs = useThumbnails(isPhoto ? options.map((o) => o.fileId).filter((x): x is number => x != null) : [], open && isPhoto);
  const byId = new Map(options.map((o) => [o.id, o]));
  const q = query.trim().toLowerCase();
  const shown = q ? options.filter((o) => `${o.title} ${o.meta}`.toLowerCase().includes(q)) : options;
  const selected = value.filter((v) => byId.has(v));
  const missing = value.length - selected.length;

  const toggle = (optId: number) => {
    if (value.includes(optId)) onChange(value.filter((v) => v !== optId));
    else if (value.length < max) onChange([...value, optId]);
  };

  return (
    <div className="space-y-1.5">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            id={id}
            type="button"
            disabled={disabled}
            data-invalid={invalid ? 'true' : undefined}
            className="w-full h-9 inline-flex items-center gap-2 rounded-md border border-border bg-transparent px-3 text-sm text-left text-muted-foreground hover:bg-muted/40 disabled:opacity-50 data-[invalid=true]:border-destructive"
          >
            {isPhoto ? <ImageIcon className="w-3.5 h-3.5 shrink-0" /> : <Paperclip className="w-3.5 h-3.5 shrink-0" />}
            <span className="truncate flex-1">
              {selected.length ? `${selected.length} ${isPhoto ? 'photo' : 'pièce'}${selected.length > 1 ? 's' : ''} liée${selected.length > 1 ? 's' : ''}` : `Lier ${isPhoto ? 'des photos' : 'des pièces'}`}
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-[min(92vw,380px)] p-0" align="start">
          <div className="p-2 border-b border-border">
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={isPhoto ? 'Rechercher une photo' : 'Rechercher une pièce'} className="h-8 text-sm" aria-label={label} />
            <p className="mt-1.5 text-[11px] text-muted-foreground">{value.length} / {max} sélectionnée{value.length > 1 ? 's' : ''}</p>
          </div>
          <div className="max-h-72 overflow-y-auto p-1" role="listbox" aria-multiselectable="true" aria-label={label}>
            {shown.length === 0 && (
              <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                {options.length === 0 ? (isPhoto ? 'Aucune photo dans la galerie de ce bien.' : 'Aucune pièce dans les documents de ce bien.') : 'Aucun résultat.'}
              </p>
            )}
            {shown.map((o) => {
              const on = value.includes(o.id);
              const full = !on && value.length >= max;
              return (
                <button
                  key={o.id}
                  type="button"
                  role="option"
                  aria-selected={on}
                  disabled={full}
                  onClick={() => toggle(o.id)}
                  className={`w-full flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted/50 disabled:opacity-40 ${on ? 'bg-primary/10' : ''}`}
                >
                  {isPhoto ? (
                    <span className="w-10 h-10 rounded bg-muted/60 overflow-hidden shrink-0 flex items-center justify-center">
                      {o.fileId != null && thumbs[o.fileId]
                        // eslint-disable-next-line @next/next/no-img-element
                        ? <img src={thumbs[o.fileId]!} alt="" className="w-full h-full object-cover" />
                        : <ImageIcon className="w-4 h-4 text-muted-foreground" />}
                    </span>
                  ) : (
                    <FileText className="w-4 h-4 text-muted-foreground shrink-0" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{o.title}</span>
                    {(o.meta || o.flag) && (
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {o.flag ? <span className="inline-flex items-center gap-1 text-amber-400"><ShieldAlert className="w-3 h-3" />{o.flag}</span> : o.meta}
                      </span>
                    )}
                  </span>
                  {on && <Check className="w-4 h-4 text-primary shrink-0" />}
                </button>
              );
            })}
          </div>
        </PopoverContent>
      </Popover>
      {(selected.length > 0 || missing > 0) && (
        <div className="flex flex-wrap gap-1">
          {selected.map((v) => (
            <span key={v} className="inline-flex max-w-full items-center gap-1 rounded-full bg-muted/60 px-2 py-0.5 text-[11px]">
              <span className="truncate max-w-[180px]">{byId.get(v)!.title}</span>
              {!disabled && (
                <button type="button" onClick={() => onChange(value.filter((x) => x !== v))} aria-label={`Retirer ${byId.get(v)!.title}`} className="text-muted-foreground hover:text-foreground">
                  <X className="w-3 h-3" />
                </button>
              )}
            </span>
          ))}
          {missing > 0 && <span className="text-[11px] text-muted-foreground">{missing} élément{missing > 1 ? 's' : ''} supprimé{missing > 1 ? 's' : ''} du bien, ignoré{missing > 1 ? 's' : ''} dans le dossier</span>}
        </div>
      )}
    </div>
  );
}
