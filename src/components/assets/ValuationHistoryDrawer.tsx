"use client"

import { useState, useEffect, useCallback } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DatePicker } from '@/components/ui/date-picker';
import { NumberInput } from '@/components/ui/number-input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, Plus, Sparkles, TrendingUp } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { toast } from 'sonner';
import type { ValuationEntry } from '@/app/api/assets/[id]/valuations/route';

const MODE_LABELS: Record<string, string> = {
  ESTIMATION_AGENCE:       'Estimation agence',
  EXPERTISE_NOTARIALE:     'Expertise notariale',
  EXPERTISE_INDEPENDANTE:  'Expertise indépendante',
  AVIS_VALEUR:             'Avis de valeur',
  SIMULATION_OUTIL:        'Simulation outil en ligne',
  ESTIMATION_PERSONNELLE:  'Estimation personnelle',
};

const MODE_OPTIONS = Object.entries(MODE_LABELS).map(([value, label]) => ({ value, label }));

interface Props {
  open: boolean;
  onClose: () => void;
  assetId: number;
  assetName: string;
  onSaved?: () => void;
}

function formatCurrency(v: number | null): string {
  if (v == null) return '—';
  return v.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
}

function formatDate(d: string | null): string {
  if (!d) return '—';
  try {
    return new Date(d).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  } catch { return d; }
}

export function ValuationHistoryDrawer({ open, onClose, assetId, assetName, onSaved }: Props) {
  const [history, setHistory] = useState<ValuationEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);

  const [formValue, setFormValue] = useState<number | null>(null);
  const [formDate, setFormDate] = useState<string | null>(null);
  const [formMode, setFormMode] = useState<string | null>(null);

  const loadHistory = useCallback(async () => {
    if (!open) return;
    setLoading(true);
    try {
      const data = await apiClient.get<{ history: ValuationEntry[] }>(`/api/assets/${assetId}/valuations`);
      setHistory((data.history ?? []).slice().reverse()); // newest first
    } catch {
      toast.error('Impossible de charger l\'historique');
    } finally {
      setLoading(false);
    }
  }, [assetId, open]);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  const handleSave = async () => {
    if (formValue == null) { toast.error('La valeur estimée est requise'); return; }
    setSaving(true);
    try {
      await apiClient.post(`/api/assets/${assetId}/valuations`, {
        value: formValue,
        date: formDate,
        mode: formMode,
        source: 'USER',
      });
      setFormValue(null);
      setFormDate(null);
      setFormMode(null);
      setShowForm(false);
      await loadHistory();
      onSaved?.();
      toast.success('Estimation enregistrée');
    } catch {
      toast.error('Erreur lors de l\'enregistrement');
    } finally {
      setSaving(false);
    }
  };

  const sorted = history; // already reversed (newest first)
  const latest = sorted[0];

  return (
    <Sheet open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <SheetContent side="right" className="w-full sm:max-w-lg flex flex-col gap-0 p-0">
        <SheetHeader className="px-6 py-5 border-b border-border">
          <div className="flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-primary" />
            <SheetTitle className="text-base font-semibold">Historique de valorisation</SheetTitle>
          </div>
          <p className="text-sm text-muted-foreground mt-0.5">{assetName}</p>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          {/* Current value summary */}
          {latest && (
            <div className="rounded-xl border border-primary/20 bg-primary/5 p-4">
              <p className="text-xs font-semibold uppercase tracking-widest text-primary mb-2">Dernière estimation</p>
              <p className="text-2xl font-bold text-[color:var(--text-primary)]">{formatCurrency(latest.value)}</p>
              <div className="flex items-center gap-3 mt-1 text-sm text-muted-foreground">
                {latest.date && <span>{formatDate(latest.date)}</span>}
                {latest.mode && <span>·</span>}
                {latest.mode && <span>{MODE_LABELS[latest.mode] ?? latest.mode}</span>}
                {latest.source === 'AI' && (
                  <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold bg-violet-500/15 text-violet-400 px-1.5 py-0.5 rounded">
                    <Sparkles className="w-2.5 h-2.5" />
                    Auto
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Add new valuation */}
          {!showForm ? (
            <Button variant="outline" size="sm" className="w-full" onClick={() => setShowForm(true)}>
              <Plus className="w-3.5 h-3.5 mr-1.5" />
              Ajouter une estimation
            </Button>
          ) : (
            <div className="rounded-xl border border-border p-4 space-y-4">
              <p className="text-sm font-semibold">Nouvelle estimation</p>

              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Valeur estimée (€) *</Label>
                <NumberInput
                  value={formValue ?? ''}
                  onChange={e => setFormValue(e.target.value === '' ? null : Number(e.target.value))}
                  placeholder="ex: 250000"
                />
              </div>

              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Date de l'estimation</Label>
                <DatePicker value={formDate ?? undefined} onChange={v => setFormDate(v ?? null)} />
              </div>

              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Mode de valorisation</Label>
                <Select value={formMode ?? ''} onValueChange={v => setFormMode(v || null)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Choisir…" />
                  </SelectTrigger>
                  <SelectContent>
                    {MODE_OPTIONS.map(o => (
                      <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex gap-2 justify-end pt-1">
                <Button variant="ghost" size="sm" onClick={() => setShowForm(false)} disabled={saving}>Annuler</Button>
                <Button size="sm" onClick={handleSave} disabled={saving}>
                  {saving ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : null}
                  Enregistrer
                </Button>
              </div>
            </div>
          )}

          {/* History list */}
          {loading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          ) : sorted.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">Aucune estimation enregistrée</p>
          ) : (
            <div className="space-y-1">
              <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-3">Toutes les estimations</p>
              <div className="divide-y divide-border">
                {sorted.map((entry, i) => (
                  <div key={entry.id} className="py-3 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm text-[color:var(--text-primary)]">
                          {formatCurrency(entry.value)}
                        </span>
                        {i === 0 && (
                          <span className="text-[10px] font-semibold bg-primary/15 text-primary px-1.5 py-0.5 rounded">
                            Actuelle
                          </span>
                        )}
                        {entry.source === 'AI' && (
                          <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold bg-violet-500/10 text-violet-400 px-1 py-0.5 rounded">
                            <Sparkles className="w-2.5 h-2.5" />
                            Auto
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-2">
                        {entry.date && <span>{formatDate(entry.date)}</span>}
                        {entry.mode && <span>· {MODE_LABELS[entry.mode] ?? entry.mode}</span>}
                      </div>
                    </div>
                    <span className="text-xs text-muted-foreground shrink-0 mt-0.5">
                      {new Date(entry.addedAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' })}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
