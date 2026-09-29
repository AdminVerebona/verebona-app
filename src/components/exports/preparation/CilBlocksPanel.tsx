"use client"

/**
 * État des blocs du CIL dans l'écran de préparation — CDC V12 §20, §8,
 * CIL-RULE-002 : B1 (identification), B3 (plans) et B8 (DPE) bloquent la
 * génération tant qu'ils sont à compléter ; les autres blocs sont signalés
 * sans bloquer. Chaque bloc incomplet propose l'action pour le compléter
 * (fiche du bien, documents, équipements, agenda, matériaux) et, quand le
 * CDC le permet, « Marquer comme non applicable ».
 *
 * Présentation reprise de la page « État des informations disponibles » du
 * PDF validé : quatre compteurs, puis la liste B1 à B9.
 */

import { useState } from 'react';
import NextLink from 'next/link';
import { AlertTriangle, ChevronDown, ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import type { CilBlockDto, PreparationDto } from '@/services/exports/v12/preparation/types';
import type { PreparationApi } from './api';
import { Callout, Pill, TONE, type Tone } from './ui';

const STATUS: Record<CilBlockDto['status'], { label: string; tone: Tone }> = {
  complete: { label: 'Renseigné', tone: 'success' },
  not_applicable: { label: 'Non applicable', tone: 'neutral' },
  missing: { label: 'À compléter', tone: 'warning' },
  invalid: { label: 'À corriger', tone: 'warning' },
  unknown: { label: 'À compléter', tone: 'warning' },
};

/** Lien d'action d'un élément manquant (onglet de la fiche du bien). */
export function cilActionHref(assetId: number, target: { type: string; filter?: string }): string | null {
  switch (target.type) {
    case 'details': return `/assets/${assetId}?tab=details&highlight=${encodeURIComponent(target.filter ?? 'address')}`;
    case 'documents': return `/assets/${assetId}?tab=documents`;
    case 'equipments': return `/assets/${assetId}?tab=equipments`;
    case 'agenda': case 'energy_works': return `/assets/${assetId}?tab=agenda`;
    default: return null;
  }
}

function MaterialForm({ api, onDone, onCancel }: { api: PreparationApi; onDone: () => void; onCancel: () => void }) {
  const [category, setCategory] = useState('');
  const [nature, setNature] = useState('');
  const [brand, setBrand] = useState('');
  const [r, setR] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="mt-3 space-y-3 rounded-xl border border-border bg-background/40 p-3">
      <p className="text-xs font-semibold">Ajouter un matériau isolant</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor="cil-mat-cat" className="text-xs">Poste isolé</Label>
          <Select value={category} onValueChange={(v) => { setCategory(v); setError(null); }}>
            <SelectTrigger id="cil-mat-cat" className="h-9 text-sm" aria-invalid={!!error} aria-describedby={error ? 'cil-mat-err' : undefined}><SelectValue placeholder="Choisir…" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="toiture">Toiture / combles</SelectItem>
              <SelectItem value="murs_exterieurs">Murs extérieurs</SelectItem>
              <SelectItem value="parois_vitrees">Parois vitrées / portes</SelectItem>
              <SelectItem value="planchers_bas">Planchers bas</SelectItem>
            </SelectContent>
          </Select>
          {error && <p id="cil-mat-err" className="text-xs text-[color:var(--text-danger)]">{error}</p>}
        </div>
        <div className="space-y-1"><Label htmlFor="cil-mat-nature" className="text-xs">Nature du matériau</Label><Input id="cil-mat-nature" value={nature} onChange={(e) => setNature(e.target.value)} placeholder="Ex. : laine de verre" /></div>
        <div className="space-y-1"><Label htmlFor="cil-mat-brand" className="text-xs">Marque</Label><Input id="cil-mat-brand" value={brand} onChange={(e) => setBrand(e.target.value)} /></div>
        <div className="space-y-1"><Label htmlFor="cil-mat-r" className="text-xs">Résistance R (m²·K/W)</Label><Input id="cil-mat-r" inputMode="decimal" value={r} onChange={(e) => setR(e.target.value)} placeholder="Ex. : 6" /></div>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Annuler</Button>
        <Button
          type="button" size="sm" disabled={saving}
          onClick={async () => {
            if (!category) { setError('Choisissez le poste isolé.'); return; }
            setSaving(true);
            try {
              const rv = Number.parseFloat(r.replace(',', '.'));
              await api.addEnergyMaterial({ category, materialNature: nature || null, brand: brand || null, thermalResistanceR: Number.isFinite(rv) ? rv : null });
              toast.success('Matériau enregistré');
              onDone();
            } catch {
              toast.error('Le matériau n’a pas pu être enregistré.');
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving && <Loader2 className="animate-spin" aria-hidden />}Enregistrer
        </Button>
      </div>
    </div>
  );
}

export function CilBlocksPanel({ cil, assetId, api, disabled, onChanged }: {
  cil: NonNullable<PreparationDto['cil']>;
  assetId: number;
  api: PreparationApi;
  disabled: boolean;
  onChanged: () => Promise<void> | void;
}) {
  const [open, setOpen] = useState<string | null>(() => cil.blocks.find((b) => b.blocksGeneration)?.id ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  const [materialForm, setMaterialForm] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const counts = {
    complete: cil.blocks.filter((b) => b.status === 'complete').length,
    todo: cil.blocks.filter((b) => (b.status === 'missing' || b.status === 'unknown' || b.status === 'invalid') && !b.blocksGeneration).length,
    blocking: cil.blocks.filter((b) => b.blocksGeneration).length,
    na: cil.blocks.filter((b) => b.status === 'not_applicable').length,
  };
  const blocking = cil.blocks.filter((b) => b.blocksGeneration);

  const resolve = async (blockId: string, resolution: 'not_applicable' | null) => {
    setBusy(blockId);
    try {
      await api.setCilResolution(blockId, resolution);
      await onChanged();
    } catch {
      toast.error('Le bloc n’a pas pu être mis à jour.');
    } finally {
      setBusy(null);
    }
  };

  const stats: Array<{ n: number; label: string; tone: Tone }> = [
    { n: counts.complete, label: 'Blocs renseignés', tone: 'success' },
    { n: counts.todo, label: 'À compléter', tone: 'warning' },
    { n: counts.blocking, label: 'Bloquants manquants', tone: 'danger' },
    { n: counts.na, label: 'Non applicables', tone: 'neutral' },
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className={cn('rounded-xl border px-3 py-2.5', TONE[s.tone])}>
            <p className="text-2xl font-semibold tabular-nums leading-none">{s.n}</p>
            <p className="mt-1.5 text-[11px] font-medium">{s.label}</p>
          </div>
        ))}
      </div>

      {blocking.length > 0 && (
        <Callout tone="danger" role="alert" icon={<AlertTriangle />}>
          <p className="font-semibold">Action requise avant de générer le CIL</p>
          <p className="mt-0.5">
            Complétez {blocking.map((b) => `${b.id} (${b.label.toLowerCase()})`).join(', ')}. Les autres blocs à compléter n’empêchent pas la génération.
          </p>
        </Callout>
      )}

      <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
        {cil.blocks.map((b) => {
          const st = b.blocksGeneration ? { label: 'Bloquant', tone: 'danger' as Tone } : STATUS[b.status];
          const expandable = b.status !== 'complete' && (b.missingItems.length > 0 || b.canMarkNotApplicable);
          const isOpen = open === b.id && expandable;
          const panelId = `cil-block-${b.id}`;
          return (
            <li key={b.id} className={cn(b.blocksGeneration && 'border-l-4 border-l-[color:var(--border-danger)]')}>
              <button
                type="button"
                className="flex w-full items-center gap-3 px-3.5 py-3 text-left outline-none hover:bg-[var(--accent-soft)] focus-visible:bg-[var(--accent-soft)] disabled:cursor-default"
                onClick={() => expandable && setOpen(isOpen ? null : b.id)}
                aria-expanded={expandable ? isOpen : undefined}
                aria-controls={expandable ? panelId : undefined}
                disabled={!expandable}
              >
                <span className="w-6 shrink-0 font-mono text-[11px] text-muted-foreground">{b.id}</span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{b.label}</span>
                <Pill tone={st.tone}>{st.label}</Pill>
                {expandable && <ChevronDown className={cn('size-4 shrink-0 text-muted-foreground transition-transform', isOpen && 'rotate-180')} aria-hidden />}
              </button>
              {isOpen && (
                <div id={panelId} className="space-y-2 bg-[var(--accent-soft)]/50 px-3.5 pb-3.5 pt-1 pl-[3.25rem]">
                  {b.missingItems.map((m) => {
                    const href = cilActionHref(assetId, m.target);
                    return (
                      <div key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                        <span className="flex-1 text-xs text-muted-foreground">{m.label}</span>
                        {href ? (
                          <Button asChild size="sm" variant="outline" className="h-8">
                            <NextLink href={href} target="_blank" rel="noopener">{m.actionLabel}<ExternalLink aria-hidden /></NextLink>
                          </Button>
                        ) : m.target.type === 'energy_materials' ? (
                          <Button size="sm" variant="outline" className="h-8" onClick={() => setMaterialForm(true)} disabled={disabled}>{m.actionLabel}</Button>
                        ) : null}
                      </div>
                    );
                  })}
                  {b.id === 'B5' && materialForm && (
                    <MaterialForm api={api} onCancel={() => setMaterialForm(false)} onDone={async () => { setMaterialForm(false); await onChanged(); }} />
                  )}
                  {b.canMarkNotApplicable && b.status !== 'not_applicable' && (
                    <button type="button" disabled={disabled || busy === b.id} onClick={() => resolve(b.id, 'not_applicable')} className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50">
                      {busy === b.id ? 'Mise à jour…' : 'Marquer comme non applicable pour ce logement'}
                    </button>
                  )}
                  {b.status === 'not_applicable' && (
                    <button type="button" disabled={disabled || busy === b.id} onClick={() => resolve(b.id, null)} className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50">
                      Annuler « non applicable » et recalculer ce bloc
                    </button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>Les liens s’ouvrent dans un nouvel onglet ; revenez ensuite actualiser l’état des blocs.</span>
        <Button
          type="button" variant="outline" size="sm" className="h-8" disabled={disabled || refreshing}
          onClick={async () => { setRefreshing(true); try { await onChanged(); } finally { setRefreshing(false); } }}
        >
          <RefreshCw className={cn(refreshing && 'animate-spin')} aria-hidden />Actualiser l’état
        </Button>
      </div>
    </div>
  );
}
