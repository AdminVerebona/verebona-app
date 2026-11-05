"use client"

import { useState, useEffect, useCallback } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { DatePicker } from '@/components/ui/date-picker';
import { NumberInput } from '@/components/ui/number-input';
import { MONEY_INPUT, parseNumberInput } from '@/lib/number-input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, Plus, Sparkles, TrendingUp } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { toast } from 'sonner';
import type { ValuationEntryView as ValuationEntry } from '@/services/business-operations/tco/valuation-history';
// Lot 111F : date du jour à Paris (préremplissage de la date de valorisation) — fonction pure du moteur partagé.
import { civilDateParis } from '@/services/business-operations/finance/engine';

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

  // Texte saisi (lot 58A) : converti à l'enregistrement.
  const [formValue, setFormValue] = useState('');
  const [valueError, setValueError] = useState(false);
  const [formDate, setFormDate] = useState<string | null>(null);
  const [formMode, setFormMode] = useState<string | null>(null);

  const loadHistory = useCallback(async () => {
    if (!open) return;
    setLoading(true);
    try {
      // Lot 111F : ordre fourni par le serveur — date de valorisation la plus récente d'abord (jamais l'ordre d'ajout).
      const data = await apiClient.get<{ history: ValuationEntry[] }>(`/api/assets/${assetId}/valuations`);
      setHistory(data.history ?? []);
    } catch {
      toast.error('Impossible de charger l\'historique');
    } finally {
      setLoading(false);
    }
  }, [assetId, open]);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  const handleSave = async () => {
    const lu = parseNumberInput(formValue, MONEY_INPUT);
    if (!lu.ok) { setValueError(true); toast.error(`Valeur estimée : ${lu.error}`); return; }
    if (lu.value == null) { toast.error('La valeur estimée est requise'); return; }
    if (!formDate) { toast.error('La date de valorisation est requise'); return; }
    setSaving(true);
    try {
      await apiClient.post(`/api/assets/${assetId}/valuations`, {
        value: lu.value,
        date: formDate,
        mode: formMode,
        source: 'USER',
      });
      setFormValue('');
      setValueError(false);
      setFormDate(null);
      setFormMode(null);
      setShowForm(false);
      await loadHistory();
      onSaved?.();
      toast.success('Estimation enregistrée');
    } catch (e) {
      const m = (e as { message?: string })?.message;
      toast.error(m && /date de valorisation/i.test(m) ? m : 'Erreur lors de l\'enregistrement');
    } finally {
      setSaving(false);
    }
  };

  const sorted = history; // trié par date de valorisation (serveur)
  // Lot 111F : estimation retenue pour le coût net (datée, postérieure à l'achat, non future) — décidée par le serveur.
  const latest = sorted.find((e) => e.retained) ?? null;

  return (
    <Sheet open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <SheetContent side="right" className="w-full sm:max-w-lg flex flex-col gap-0 p-0">
        <SheetHeader className="px-6 py-5 border-b border-border">
          <div className="flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-primary" />
            <SheetTitle>Historique de valorisation</SheetTitle>
          </div>
          <p className="text-sm text-muted-foreground mt-0.5">{assetName}</p>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          {/* Current value summary */}
          {latest && (
            <div className="rounded-xl border border-primary/20 bg-primary/5 p-4">
              <p className="vb-app-subsection mb-2">Estimation retenue pour le coût net</p>
              <p className="text-2xl font-extrabold tracking-[-.02em] vb-tabular text-[color:var(--text-primary)]">{formatCurrency(latest.value)}</p>
              <div className="flex items-center gap-3 mt-1 text-sm text-muted-foreground">
                {latest.date && <span>{formatDate(latest.date)}</span>}
                {latest.mode && <span>·</span>}
                {latest.mode && <span>{MODE_LABELS[latest.mode] ?? latest.mode}</span>}
                {latest.source === 'AI' && (
                  <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold bg-[color:var(--accent-soft)] text-[color:var(--accent)] px-1.5 py-0.5 rounded">
                    <Sparkles className="w-2.5 h-2.5" />
                    Auto
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Add new valuation */}
          {!showForm ? (
            <Button variant="outline" size="sm" className="w-full" onClick={() => { setFormDate(civilDateParis()); setShowForm(true); }}>
              <Plus className="w-3.5 h-3.5 mr-1.5" />
              Ajouter une estimation
            </Button>
          ) : (
            <div className="rounded-xl border border-border p-4 space-y-4">
              <p className="text-sm font-semibold">Nouvelle estimation</p>

              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Valeur estimée (€) *</Label>
                <NumberInput
                  value={formValue}
                  onValueChange={setFormValue}
                  parseOptions={MONEY_INPUT}
                  showError={valueError}
                  placeholder="ex: 250000"
                />
              </div>

              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Date de valorisation *</Label>
                <DatePicker value={formDate ?? undefined} onChange={v => setFormDate(v ?? null)} />
                <p className="text-[11px] text-muted-foreground">Date à laquelle la valeur a été estimée (aujourd’hui par défaut), distincte de la date d’ajout.</p>
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
                <Button size="sm" onClick={handleSave} disabled={saving || !formDate}>
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
              <p className="vb-app-subsection mb-3">Toutes les estimations</p>
              <div className="divide-y divide-border">
                {sorted.map((entry) => (
                  <div key={entry.id} className="py-3 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm vb-tabular text-[color:var(--text-primary)]">
                          {formatCurrency(entry.value)}
                        </span>
                        {entry.retained && (
                          <span className="text-[10px] font-semibold bg-primary/15 text-primary px-1.5 py-0.5 rounded">
                            Retenue
                          </span>
                        )}
                        {entry.source === 'AI' && (
                          <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold bg-[color:var(--accent-soft)] text-[color:var(--accent)] px-1 py-0.5 rounded">
                            <Sparkles className="w-2.5 h-2.5" />
                            Auto
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-2">
                        <span>{entry.date ? `Valorisation du ${formatDate(entry.date)}` : 'Date de valorisation inconnue'}</span>
                        {entry.mode && <span>· {MODE_LABELS[entry.mode] ?? entry.mode}</span>}
                      </div>
                      {entry.rejectionLabel && <p className="text-[11px] text-muted-foreground mt-0.5" data-valuation-rejection={entry.rejection ?? ''}>{entry.rejectionLabel}</p>}
                    </div>
                    <span className="text-xs text-muted-foreground shrink-0 mt-0.5 text-right">
                      Ajoutée le {new Date(entry.addedAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/Paris' })}
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
