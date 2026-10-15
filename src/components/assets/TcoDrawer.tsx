"use client"

/**
 * Tiroir « Coût de possession » (TCO) — Informations du bien (lot 54D,
 * ticket §3.6). Même structure et mêmes jetons que le tiroir de
 * valorisation (Sheet plein écran sur mobile, `sm:max-w-lg` sur desktop) :
 * un seul composant pour les deux.
 *
 *   · Synthèse : coût cumulé, valeur actuelle fiable, coût net estimé /
 *     final, période de possession ;
 *   · Détail : acquisition, entretien, contrats, financement, sinistres,
 *     cession, réductions et remboursements, indemnités ;
 *   · Budget d'usage : forfaits ESTIMÉS, séparés du réel (ajout,
 *     modification, suppression par l'utilisateur autorisé) ;
 *   · Fiabilité : éléments pris en compte, justificatifs ouvrables, montants
 *     exclus, devises non converties, couverture incomplète ;
 *   · Cession : prix souhaité, valeur estimée, prix réalisé, résultat
 *     provisoire ou définitif clairement différenciés.
 *
 * Standard : fonction verrouillée, aucun montant reçu (403 côté serveur).
 */
import { useCallback, useEffect, useState } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { DatePicker } from '@/components/ui/date-picker';
import { NumberInput } from '@/components/ui/number-input';
import { formatNumberForInput, MONEY_INPUT, parseMoneyInputToCents } from '@/lib/number-input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Calculator, FileText, Loader2, Lock, Pencil, Plus, Trash2 } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { toast } from 'sonner';
import type { TcoDto } from '@/services/business-operations/tco/dto';
import { USAGE_BUDGET_CATEGORIES, USAGE_BUDGET_CATEGORY_LABELS, USAGE_BUDGET_PERIODICITIES, USAGE_BUDGET_PERIODICITY_LABELS } from '@/services/business-operations/tco/model';

interface Props {
  open: boolean;
  onClose: () => void;
  assetId: number;
  assetName: string;
  readOnly?: boolean;
  /** Ouvre un justificatif (tiroir document de la fiche), si disponible. */
  onOpenDocument?: (fileId: number) => void;
}

function eur(cents: number | null | undefined): string {
  if (cents == null) return '—';
  return (cents / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
}

function minor(amountMinor: number, currency: string): string {
  if (currency === 'XXX') return `${(amountMinor / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2 })} (devise à confirmer)`;
  try { return (amountMinor / 100).toLocaleString('fr-FR', { style: 'currency', currency }); } catch { return `${(amountMinor / 100).toFixed(2)} ${currency}`; }
}

function dateFr(d: string | null | undefined): string {
  if (!d) return '—';
  try { return new Date(`${d.slice(0, 10)}T00:00:00Z`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }); } catch { return d; }
}

const KIND_LABELS: Record<string, string> = {
  REALIZED_COST: 'Coût', REDUCTION: 'Avoir', REFUND: 'Remboursement', INDEMNITY: 'Indemnité', PROCEED: 'Prix de cession', FORECAST_COST: 'Prévu',
};

type BudgetForm = { id: number | null; category: string; label: string; /** Texte saisi en euros (lot 58A). */ amount: string; periodicity: string; validFrom: string | null; validTo: string | null };
const VIDE: BudgetForm = { id: null, category: 'FUEL', label: '', amount: '', periodicity: 'MONTHLY', validFrom: null, validTo: null };

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">{title}</p>
      {children}
    </section>
  );
}

function Ligne({ label, value, muted, strong }: { label: string; value: string; muted?: boolean; strong?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 text-sm">
      <span className={muted ? 'text-muted-foreground' : 'text-[color:var(--text-primary)]'}>{label}</span>
      <span className={`shrink-0 tabular-nums ${strong ? 'font-semibold text-[color:var(--text-primary)]' : ''}`}>{value}</span>
    </div>
  );
}

export function TcoDrawer({ open, onClose, assetId, assetName, readOnly, onOpenDocument }: Props) {
  const [data, setData] = useState<TcoDto | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState<BudgetForm | null>(null);
  const [amountError, setAmountError] = useState(false);
  useEffect(() => { if (!form) setAmountError(false); }, [form]);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!open) return;
    setLoading(true);
    setError(false);
    try {
      const r = await apiClient.get<{ tco: TcoDto; canEdit: boolean }>(`/api/assets/${assetId}/tco`);
      setData(r.tco);
      setCanEdit(!!r.canEdit && !readOnly);
      setLocked(false);
    } catch (e) {
      if ((e as { code?: string }).code === 'PREMIUM_REQUIRED') { setLocked(true); setData(null); }
      else setError(true);
    } finally {
      setLoading(false);
    }
  }, [assetId, open, readOnly]);

  useEffect(() => { load(); }, [load]);

  const saveBudget = async () => {
    if (!form) return;
    const montant = parseMoneyInputToCents(form.amount);
    if (!montant.ok) { setAmountError(true); toast.error(`Montant : ${montant.error}`); return; }
    if (montant.cents == null) { toast.error('Le montant est requis'); return; }
    setSaving(true);
    try {
      const body = {
        category: form.category, label: form.label.trim() || null, amountMinor: montant.cents, currency: 'EUR',
        periodicity: form.periodicity, validFrom: form.validFrom, validTo: form.validTo,
      };
      if (form.id) await apiClient.patch(`/api/assets/${assetId}/usage-budgets/${form.id}`, body);
      else await apiClient.post(`/api/assets/${assetId}/usage-budgets`, body);
      setForm(null);
      await load();
      toast.success('Forfait enregistré');
    } catch (e) {
      toast.error((e as { serverMessage?: string }).serverMessage ?? 'Erreur lors de l’enregistrement');
    } finally {
      setSaving(false);
    }
  };

  const removeBudget = async (id: number) => {
    try {
      await apiClient.delete(`/api/assets/${assetId}/usage-budgets/${id}`);
      await load();
      toast.success('Forfait supprimé');
    } catch {
      toast.error('Suppression impossible');
    }
  };

  const t = data;
  return (
    <Sheet open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <SheetContent side="right" className="w-full sm:max-w-lg flex flex-col gap-0 p-0" data-tco-drawer>
        <SheetHeader className="px-6 py-5 border-b border-border">
          <div className="flex items-center gap-2">
            <Calculator className="w-4 h-4 text-primary" />
            <SheetTitle className="text-base font-semibold">Coût de possession</SheetTitle>
          </div>
          <p className="text-sm text-muted-foreground mt-0.5">{assetName}</p>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          {loading && !t ? (
            <div className="flex justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
          ) : locked ? (
            <div className="rounded-xl border border-border p-4 text-sm space-y-2" data-tco-locked>
              <div className="flex items-center gap-2 font-semibold"><Lock className="w-4 h-4" /> Fonction Premium</div>
              <p className="text-muted-foreground">Le coût de possession (coûts documentés, valeur, résultat de cession) est disponible avec Premium et Premium Duo. Vos données sont conservées.</p>
            </div>
          ) : error || !t ? (
            <p className="text-sm text-muted-foreground text-center py-8" data-tco-error>Le coût de possession n’a pas pu être calculé. Réessayez plus tard.</p>
          ) : (
            <>
              {/* ── Synthèse ── */}
              <div className="rounded-xl border border-primary/20 bg-primary/5 p-4" data-tco-summary>
                <p className="text-xs font-semibold uppercase tracking-widest text-primary mb-2">Coût cumulé documenté</p>
                <p className="text-2xl font-bold text-[color:var(--text-primary)] tabular-nums">{eur(t.summary.cumulativeCostCents)}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {t.period.start ? `Du ${dateFr(t.period.start)} ` : 'Date d’acquisition non renseignée — '}
                  {t.period.endSource === 'TODAY' ? 'à aujourd’hui' : `au ${dateFr(t.period.end)} (cession)`}
                </p>
                <div className="mt-3 divide-y divide-border">
                  {!t.disposed && <Ligne label="Valeur actuelle" value={t.summary.currentValue ? `${eur(t.summary.currentValue.cents)} · ${dateFr(t.summary.currentValue.date)}` : 'non disponible'} muted />}
                  {!t.disposed && <Ligne label="Coût net estimé" value={t.summary.netEstimatedCents != null ? eur(t.summary.netEstimatedCents) : '—'} strong />}
                  {t.disposed && <Ligne label="Coût net final" value={t.summary.netFinalCents != null ? eur(t.summary.netFinalCents) : 'non établi'} strong />}
                </div>
                {t.status !== 'COMPLETE' && (
                  <p className="text-xs mt-2 text-amber-600 dark:text-amber-400" data-tco-incomplete>
                    {t.status === 'PARTIAL' ? 'Résultat partiel.' : 'Couverture incomplète : voir « Fiabilité ».'}
                  </p>
                )}
              </div>

              {/* ── Détail ── */}
              <Section title="Détail des coûts réalisés">
                <div className="divide-y divide-border" data-tco-breakdown>
                  {t.breakdown.length === 0 && <p className="text-sm text-muted-foreground py-1.5">Aucun coût documenté.</p>}
                  {t.breakdown.map((b) => <Ligne key={b.category} label={`${b.label} (${b.count})`} value={eur(b.costsCents)} />)}
                  {t.reductionsCents > 0 && <Ligne label="Avoirs et réductions" value={`− ${eur(t.reductionsCents)}`} />}
                  {t.refundsCents > 0 && <Ligne label="Remboursements" value={`− ${eur(t.refundsCents)}`} />}
                  {t.indemnitiesCents > 0 && <Ligne label="Indemnités reçues" value={`− ${eur(t.indemnitiesCents)}`} />}
                  <Ligne label="Coût cumulé" value={eur(t.summary.cumulativeCostCents)} strong />
                </div>
              </Section>

              {/* ── Cession ── */}
              {(t.disposed || t.disposal.desiredPriceCents != null) && (
                <Section title="Cession">
                  <div className="divide-y divide-border" data-tco-disposal>
                    <Ligne label="Prix souhaité" value={eur(t.disposal.desiredPriceCents)} muted />
                    <Ligne label="Valeur estimée" value={eur(t.disposal.estimatedValueCents)} muted />
                    <Ligne label="Prix réalisé" value={eur(t.disposal.realizedPriceCents)} />
                    {t.disposal.feesCents > 0 && <Ligne label="Frais de cession (inclus dans les coûts)" value={eur(t.disposal.feesCents)} muted />}
                    {t.disposal.resultKind === 'FINAL' && <Ligne label="Résultat définitif (coût net final)" value={eur(t.summary.netFinalCents)} strong />}
                    {t.disposal.resultKind === 'PROVISIONAL' && <Ligne label="Simulation provisoire au prix souhaité" value={eur(t.disposal.provisionalNetCents)} />}
                  </div>
                  {t.disposal.resultKind === 'PROVISIONAL' && <p className="text-xs text-muted-foreground">Simulation : le prix souhaité n’est pas un prix de vente réalisé.</p>}
                </Section>
              )}

              {/* ── Budget d'usage ── */}
              <Section title="Budget d’usage (estimation)">
                <p className="text-xs text-muted-foreground">Forfaits estimés, distincts des coûts réels : ils ne sont jamais ajoutés au coût cumulé.</p>
                <div className="divide-y divide-border" data-tco-usage>
                  {t.usage.items.map((b) => (
                    <div key={b.id} className="py-2 flex items-start justify-between gap-3 text-sm">
                      <div className="min-w-0">
                        <p className="text-[color:var(--text-primary)]">{b.label || USAGE_BUDGET_CATEGORY_LABELS[b.category]}</p>
                        <p className="text-xs text-muted-foreground">
                          {minor(b.amountMinor, b.currency)} {USAGE_BUDGET_PERIODICITY_LABELS[b.periodicity]}
                          {b.validFrom || b.validTo ? ` · ${b.validFrom ? `du ${dateFr(b.validFrom)}` : ''}${b.validTo ? ` au ${dateFr(b.validTo)}` : ''}` : ''}
                          {!b.activeNow ? ' · hors validité' : ''}
                        </p>
                      </div>
                      {canEdit && (
                        <div className="flex shrink-0 gap-1">
                          <Button variant="ghost" size="sm" aria-label="Modifier" onClick={() => setForm({ id: b.id, category: b.category, label: b.label ?? '', amount: formatNumberForInput(b.amountMinor / 100), periodicity: b.periodicity, validFrom: b.validFrom, validTo: b.validTo })}><Pencil className="w-3.5 h-3.5" /></Button>
                          <Button variant="ghost" size="sm" aria-label="Supprimer" onClick={() => removeBudget(b.id)}><Trash2 className="w-3.5 h-3.5" /></Button>
                        </div>
                      )}
                    </div>
                  ))}
                  {t.usage.items.length > 0 && <Ligne label="Estimation annuelle (forfaits en cours)" value={eur(t.usage.annualEstimateCents)} muted />}
                </div>
                {canEdit && !form && (
                  <Button variant="outline" size="sm" className="w-full" onClick={() => setForm({ ...VIDE })}>
                    <Plus className="w-3.5 h-3.5 mr-1.5" /> Ajouter un forfait
                  </Button>
                )}
                {form && (
                  <div className="rounded-xl border border-border p-4 space-y-3" data-tco-budget-form>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">Objet</Label>
                      <Select value={form.category} onValueChange={(v) => setForm({ ...form, category: v })}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>{USAGE_BUDGET_CATEGORIES.map((c) => <SelectItem key={c} value={c}>{USAGE_BUDGET_CATEGORY_LABELS[c]}</SelectItem>)}</SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">Libellé (facultatif)</Label>
                      <Input value={form.label} maxLength={120} onChange={(e) => setForm({ ...form, label: e.target.value })} />
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">Montant (€) *</Label>
                        <NumberInput value={form.amount} onValueChange={(text) => setForm((prev) => (prev ? { ...prev, amount: text } : prev))} parseOptions={MONEY_INPUT} showError={amountError} />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">Périodicité</Label>
                        <Select value={form.periodicity} onValueChange={(v) => setForm({ ...form, periodicity: v })}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>{USAGE_BUDGET_PERIODICITIES.map((p) => <SelectItem key={p} value={p}>{USAGE_BUDGET_PERIODICITY_LABELS[p]}</SelectItem>)}</SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">Début de validité</Label>
                        <DatePicker value={form.validFrom ?? undefined} onChange={(v) => setForm({ ...form, validFrom: v ?? null })} />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">Fin de validité</Label>
                        <DatePicker value={form.validTo ?? undefined} onChange={(v) => setForm({ ...form, validTo: v ?? null })} />
                      </div>
                    </div>
                    <div className="flex gap-2 justify-end">
                      <Button variant="ghost" size="sm" onClick={() => setForm(null)} disabled={saving}>Annuler</Button>
                      <Button size="sm" onClick={saveBudget} disabled={saving}>{saving && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}Enregistrer</Button>
                    </div>
                  </div>
                )}
              </Section>

              {/* ── Fiabilité ── */}
              <Section title="Fiabilité">
                <div className="text-sm space-y-2" data-tco-reliability>
                  <p className="text-muted-foreground">{t.reliability.operationsCounted} élément{t.reliability.operationsCounted > 1 ? 's' : ''} pris en compte (achats, interventions, contrats, sinistres, cession).</p>
                  {t.warningLabels.map((w) => <p key={w} className="text-amber-600 dark:text-amber-400 text-xs">{w}</p>)}
                  {t.reliability.unconverted.length > 0 && (
                    <p className="text-xs text-muted-foreground">Non converti : {t.reliability.unconverted.map((u) => `${KIND_LABELS[u.kind] ?? u.kind} ${minor(u.amountMinor, u.currency)}`).join(', ')}.</p>
                  )}
                  {t.reliability.excluded.length > 0 && (
                    <div className="space-y-1">
                      <p className="text-xs font-semibold text-muted-foreground">Montants exclus</p>
                      {t.reliability.excluded.slice(0, 30).map((x) => (
                        <p key={x.componentId} className="text-xs text-muted-foreground">
                          {x.label} · {KIND_LABELS[x.kind] ?? x.kind} {minor(x.amountMinor, x.currency)} — {t.excludedLabels[x.reason]}
                        </p>
                      ))}
                    </div>
                  )}
                  {t.reliability.documents.length > 0 && (
                    <div className="space-y-1">
                      <p className="text-xs font-semibold text-muted-foreground">Justificatifs</p>
                      {t.reliability.documents.slice(0, 30).map((d) => (
                        <button key={d.fileId} type="button" className="flex items-center gap-1.5 text-xs text-primary hover:underline text-left disabled:no-underline disabled:text-muted-foreground"
                          disabled={!onOpenDocument} onClick={() => onOpenDocument?.(d.fileId)}>
                          <FileText className="w-3 h-3 shrink-0" /><span className="truncate">{d.title}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </Section>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
