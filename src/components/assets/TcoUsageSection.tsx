"use client"

/**
 * Lot 108C (ticket TCO-646 §E) — bloc « Dépenses d'usage » du coût de
 * possession (Bien › Informations › Coût total de possession). Desktop et
 * mobile : un seul composant responsive, charte Sérénité (jetons existants).
 *
 *   · Forfaits (estimations) : catégorie, libellé facultatif, montant, devise,
 *     périodicité, dates d'effet / de fin ; état de chaque forfait (appliqué,
 *     en cours, conflit…) et versions (révisions datées). Modifier le montant
 *     crée une version à partir d'une date d'effet (les périodes écoulées
 *     gardent l'ancien montant) ; « Arrêter » garde les estimations passées,
 *     « Supprimer » efface une saisie erronée.
 *   · Ventilation par catégorie et par période : forfait, dépenses réelles
 *     prises en compte (justificatifs ouvrables, fondement du classement),
 *     complément estimé restant, contribution au TCO ; période en cours
 *     montrée, jamais ajoutée.
 *   · Dépenses à classer : catégorie d'usage incertaine → l'utilisateur la
 *     choisit (jamais devinée), y compris « Pas une dépense d'usage ».
 * AUCUNE règle de calcul ici : tout vient du moteur (`tco/usage-complement`).
 */
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { DatePicker } from '@/components/ui/date-picker';
import { NumberInput } from '@/components/ui/number-input';
import { formatNumberForInput, MONEY_INPUT, parseMoneyInputToCents } from '@/lib/number-input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ChevronDown, ChevronRight, Loader2, Pencil, Plus, StopCircle, Trash2 } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { toast } from 'sonner';
// Types seulement : les libellés viennent de la réponse.
import type { TcoDto } from '@/services/business-operations/tco/dto';
import { TcoJustificatif } from './tco-justificatif';

type Complement = TcoDto['usage']['complement'];
type Window = Complement['windows'][number];
type Budget = TcoDto['usage']['items'][number];

interface Props {
  t: TcoDto;
  assetId: number;
  canEdit: boolean;
  /** Relecture du TCO (après écriture d'un forfait). */
  reload: () => Promise<void>;
  /** TCO recalculé rendu par le serveur (classement d'une dépense). */
  applyTco: (tco: TcoDto) => void;
  /** Écriture propre en cours (n'auto-déclenche pas de relecture). */
  setOwnWrite: (v: boolean) => void;
}

/** Sous-titre EXACT du bloc (décision PO, ticket TCO-646 §E). */
export const TCO_USAGE_SUBTITLE = 'Estimez vos dépenses régulières de carburant, de recharge ou de péage, même sans justificatif. Les dépenses réelles ajoutées viennent progressivement remplacer ces estimations, sans double comptage.';

const PERIODES_VISIBLES = 12;

function eur(cents: number | null | undefined): string {
  if (cents == null) return '—';
  return (cents / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
}
function minor(amountMinor: number, currency: string): string {
  try { return (amountMinor / 100).toLocaleString('fr-FR', { style: 'currency', currency }); } catch { return `${(amountMinor / 100).toFixed(2)} ${currency}`; }
}
function dateNum(d: string | null | undefined): string {
  return d && /^\d{4}-\d{2}-\d{2}/.test(d) ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : '—';
}
const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
/** Libellé d'une période civile (« octobre 2026 », « 4e trimestre 2026 », « année 2026 »). */
function periodeLabel(w: Pick<Window, 'periodicity' | 'periodStart'>): string {
  const y = w.periodStart.slice(0, 4);
  const m = Number(w.periodStart.slice(5, 7));
  if (w.periodicity === 'YEARLY') return `année ${y}`;
  if (w.periodicity === 'QUARTERLY') return `${Math.floor((m - 1) / 3) + 1}${m <= 3 ? 'er' : 'e'} trimestre ${y}`;
  return `${MOIS[m - 1]} ${y}`;
}

type BudgetForm = {
  id: number | null; category: string; label: string; amount: string; currency: string; periodicity: string;
  validFrom: string | null; validTo: string | null; effectiveFrom: string | null; ended: boolean;
};
const VIDE: BudgetForm = { id: null, category: 'FUEL', label: '', amount: '', currency: 'EUR', periodicity: 'MONTHLY', validFrom: null, validTo: null, effectiveFrom: null, ended: false };

function Ligne({ label, value, muted, strong }: { label: string; value: string; muted?: boolean; strong?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 text-sm">
      <span className={`min-w-0 ${muted ? 'text-muted-foreground' : 'text-[color:var(--text-primary)]'}`}>{label}</span>
      <span className={`shrink-0 tabular-nums ${strong ? 'font-semibold text-[color:var(--text-primary)]' : ''}`}>{value}</span>
    </div>
  );
}

export function TcoUsageSection({ t, assetId, canEdit, reload, applyTco, setOwnWrite }: Props) {
  const c = t.usage.complement;
  const catLabels = t.usageLabels.categories;
  const perLabels = t.usageLabels.periodicities;
  const statusLabels = t.usageLabels.budgetStatuses;
  const [form, setForm] = useState<BudgetForm | null>(null);
  const [amountError, setAmountError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [openWindow, setOpenWindow] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [assigning, setAssigning] = useState<string | null>(null);

  const etat = new Map(c.budgets.map((b) => [b.budgetId, b]));
  const autresLibelles = [...new Set(t.usage.items.filter((b) => b.category === 'OTHER' && b.label).map((b) => b.label as string))];
  const nomCle = (key: string, category: string, label: string) => (category === 'OTHER' ? (label || catLabels.OTHER) : catLabels[category as keyof typeof catLabels] ?? key);
  const fenetres = showAll ? c.windows : c.windows.slice(0, PERIODES_VISIBLES);

  const ecrire = async (fn: () => Promise<void>) => {
    setOwnWrite(true);
    try { await fn(); } finally { setOwnWrite(false); }
  };

  const saveBudget = async () => {
    if (!form) return;
    const montant = parseMoneyInputToCents(form.amount);
    if (!montant.ok) { setAmountError(true); toast.error(`Montant : ${montant.error}`); return; }
    if (montant.cents == null) { toast.error('Le montant est requis'); return; }
    const devise = form.currency.trim().toUpperCase() || 'EUR';
    if (!/^[A-Z]{3}$/.test(devise)) { toast.error('Devise : trois lettres (EUR, CHF…)'); return; }
    setSaving(true);
    await ecrire(async () => {
      try {
        const body = {
          category: form.category, label: form.label.trim() || null, amountMinor: montant.cents, currency: devise,
          periodicity: form.periodicity, validFrom: form.validFrom, validTo: form.validTo,
          ...(form.id && form.effectiveFrom ? { effectiveFrom: form.effectiveFrom } : {}),
        };
        if (form.id) {
          const r = await apiClient.patch<{ revised?: boolean; effectiveFrom?: string | null }>(`/api/assets/${assetId}/usage-budgets/${form.id}`, body);
          toast.success(r?.revised ? `Nouveau montant appliqué à partir du ${dateNum(r.effectiveFrom)} : les périodes écoulées gardent l’ancien montant` : 'Forfait enregistré');
        } else {
          await apiClient.post(`/api/assets/${assetId}/usage-budgets`, body);
          toast.success('Forfait enregistré');
        }
        setForm(null);
        setAmountError(false);
        await reload();
      } catch (e) {
        toast.error((e as { serverMessage?: string }).serverMessage ?? 'Erreur lors de l’enregistrement');
      } finally {
        setSaving(false);
      }
    });
  };

  const removeBudget = async (id: number, mode: 'STOP' | 'ERASE_HISTORY') => {
    await ecrire(async () => {
      try {
        await apiClient.delete(`/api/assets/${assetId}/usage-budgets/${id}?mode=${mode}`);
        setConfirmDelete(null);
        await reload();
        toast.success(mode === 'STOP' ? 'Forfait arrêté : les périodes écoulées restent estimées' : 'Forfait supprimé');
      } catch {
        toast.error('Action impossible. Réessayez.');
      }
    });
  };

  const assign = async (lineId: string, decisionKey: string, value: string) => {
    const [category, otherLabel] = value === 'REVERT' ? [null, null] : value.startsWith('OTHER:') ? ['OTHER', value.slice(6)] : [value, null];
    setAssigning(lineId);
    await ecrire(async () => {
      try {
        const r = await apiClient.post<{ tco: TcoDto }>(`/api/assets/${assetId}/tco/usage-assignments`, { lineId, lineKey: decisionKey, category, otherLabel });
        applyTco(r.tco);
        toast.success(category === null ? 'Classement automatique rétabli' : category === 'NONE' ? 'Dépense marquée « pas une dépense d’usage »' : 'Dépense classée : l’estimation de sa période est recalculée');
      } catch (e) {
        const err = e as { code?: string; serverMessage?: string };
        toast.error(err.serverMessage ?? 'Le classement n’a pas pu être enregistré');
        if (err.code === 'LINE_NOT_FOUND') void reload();
      } finally {
        setAssigning(null);
      }
    });
  };

  const choixClassement = (
    <>
      <SelectItem value="FUEL">{catLabels.FUEL}</SelectItem>
      <SelectItem value="CHARGING">{catLabels.CHARGING}</SelectItem>
      <SelectItem value="TOLLS">{catLabels.TOLLS}</SelectItem>
      {autresLibelles.map((l) => <SelectItem key={l} value={`OTHER:${l}`}>{`${catLabels.OTHER} : ${l}`}</SelectItem>)}
      {t.usage.items.some((b) => b.category === 'OTHER' && !b.label) && <SelectItem value="OTHER:">{catLabels.OTHER}</SelectItem>}
      <SelectItem value="NONE">Pas une dépense d’usage</SelectItem>
    </>
  );

  const editer = (b: Budget) => setForm({
    id: b.id, category: b.category, label: b.label ?? '', amount: formatNumberForInput(b.amountMinor / 100), currency: b.currency,
    periodicity: b.periodicity, validFrom: b.validFrom, validTo: b.validTo, effectiveFrom: null,
    ended: !!b.validTo && b.validTo.slice(0, 10) < t.annual.referenceDate,
  });

  return (
    <section className="space-y-3" data-tco-usage>
      <h3 className="vb-app-subsection m-0">Dépenses d’usage</h3>
      <p className="text-xs text-muted-foreground" data-tco-usage-subtitle>{TCO_USAGE_SUBTITLE}</p>

      {/* Synthèse : réel / forfait / complément estimé (périodes écoulées) — prévisionnel à part. */}
      {t.usage.items.length > 0 && (
        <div className="rounded-lg border border-border p-3 divide-y divide-border" data-tco-usage-summary>
          <Ligne label="Forfaits des périodes écoulées (estimé)" value={eur(c.forfaitCents)} muted />
          <Ligne label="Dépenses réelles de ces catégories (justifiées)" value={eur(c.matchedRealCents)} />
          <Ligne label="Complément estimé ajouté au TCO" value={eur(c.estimatedComplementCents)} strong />
          <Ligne label="Budget annuel prévisionnel (forfaits en cours, jamais ajouté pour les mois à venir)" value={eur(t.usage.annualEstimateCents)} muted />
          {t.usage.otherCurrencies.map((o) => <Ligne key={o.currency} label={`Forfaits en ${o.currency} (non ajoutés en euros)`} value={minor(o.annualEquivalentMinor, o.currency)} muted />)}
        </div>
      )}

      {c.warnings.filter((w) => w !== 'USAGE_ESTIMATES_INCLUDED').length > 0 && (
        <ul className="text-xs text-[color:var(--attention-on-soft)] list-disc pl-5 space-y-0.5" data-tco-usage-warnings>
          {c.warnings.filter((w) => w !== 'USAGE_ESTIMATES_INCLUDED').map((w) => <li key={w}>{t.usageLabels.warnings[w]}</li>)}
        </ul>
      )}

      {/* Forfaits (toutes versions). */}
      <div className="divide-y divide-border" data-tco-usage-budgets>
        {t.usage.items.map((b) => {
          const s = etat.get(b.id);
          return (
            <div key={b.id} className="py-2 flex flex-wrap items-start justify-between gap-2 text-sm" data-tco-budget={b.id} data-tco-budget-status={s?.status}>
              <div className="min-w-0 flex-1">
                <p className="text-[color:var(--text-primary)] break-words">{b.label ? `${catLabels[b.category]} — ${b.label}` : catLabels[b.category]}</p>
                <p className="text-xs text-muted-foreground break-words">
                  {minor(b.amountMinor, b.currency)} {perLabels[b.periodicity]}
                  {b.validFrom || b.validTo ? ` · ${b.validFrom ? `du ${dateNum(b.validFrom)}` : 'depuis l’achat'}${b.validTo ? ` au ${dateNum(b.validTo)}` : ''}` : ' · depuis l’achat'}
                  {s ? ` · ${statusLabels[s.status]}` : ''}
                  {s && s.complementCents > 0 ? ` · complément estimé ${eur(s.complementCents)}` : ''}
                </p>
                {b.revisesBudgetId != null && <p className="text-xs text-muted-foreground">Nouvelle version d’un forfait précédent (révision datée).</p>}
                {s?.revisedBy != null && <p className="text-xs text-muted-foreground">Version précédente : conservée pour les périodes déjà écoulées.</p>}
                {s && s.overlapWith.length > 0 && <p className="text-xs text-[color:var(--attention-on-soft)]">Chevauche un autre forfait de même catégorie : seul le plus récent s’applique sur les jours communs.</p>}
              </div>
              {canEdit && s?.revisedBy == null && (
                <div className="flex shrink-0 gap-1">
                  <Button variant="ghost" size="sm" aria-label="Modifier le forfait" onClick={() => editer(b)}><Pencil className="w-3.5 h-3.5" /></Button>
                  <Button variant="ghost" size="sm" aria-label="Arrêter ou supprimer le forfait" onClick={() => setConfirmDelete(confirmDelete === b.id ? null : b.id)}><Trash2 className="w-3.5 h-3.5" /></Button>
                </div>
              )}
              {confirmDelete === b.id && (
                <div className="w-full rounded-lg border border-border p-3 space-y-2 text-xs" data-tco-budget-delete={b.id}>
                  <p className="text-muted-foreground">Arrêter garde les estimations des périodes écoulées ; supprimer efface la saisie (et ses versions précédentes) comme si elle n’avait jamais existé.</p>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <Button variant="outline" size="sm" onClick={() => removeBudget(b.id, 'STOP')} data-tco-budget-stop><StopCircle className="w-3.5 h-3.5 mr-1.5" />Arrêter à la fin de la dernière période écoulée</Button>
                    <Button variant="outline" size="sm" onClick={() => removeBudget(b.id, 'ERASE_HISTORY')} data-tco-budget-erase><Trash2 className="w-3.5 h-3.5 mr-1.5" />Supprimer complètement (saisie erronée)</Button>
                    <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(null)}>Annuler</Button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {canEdit && !form && (
        <Button variant="outline" size="sm" className="w-full" onClick={() => setForm({ ...VIDE })}>
          <Plus className="w-3.5 h-3.5 mr-1.5" /> Ajouter un forfait
        </Button>
      )}
      {form && (
        <div className="rounded-lg border border-border p-4 space-y-3" data-tco-budget-form>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Catégorie</Label>
              <Select value={form.category} onValueChange={(v) => setForm({ ...form, category: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{(Object.keys(catLabels) as Array<keyof typeof catLabels>).map((k) => <SelectItem key={k} value={k}>{catLabels[k]}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Libellé (facultatif)</Label>
              <Input value={form.label} maxLength={120} onChange={(e) => setForm({ ...form, label: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Montant estimé *</Label>
              <NumberInput value={form.amount} onValueChange={(text) => setForm((prev) => (prev ? { ...prev, amount: text } : prev))} parseOptions={MONEY_INPUT} showError={amountError} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Devise</Label>
                <Input value={form.currency} maxLength={3} onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })} aria-label="Devise (EUR, CHF…)" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Périodicité</Label>
                <Select value={form.periodicity} onValueChange={(v) => setForm({ ...form, periodicity: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{(Object.keys(perLabels) as Array<keyof typeof perLabels>).map((p) => <SelectItem key={p} value={p}>{perLabels[p]}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Date d’effet (début)</Label>
              <DatePicker value={form.validFrom ?? undefined} onChange={(v) => setForm({ ...form, validFrom: v ?? null })} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Date de fin (facultative)</Label>
              <DatePicker value={form.validTo ?? undefined} onChange={(v) => setForm({ ...form, validTo: v ?? null })} />
            </div>
            {form.id && !form.ended && (
              <div className="space-y-1 sm:col-span-2" data-tco-budget-effective>
                <Label className="text-xs text-muted-foreground">Nouveau montant applicable à partir du (facultatif)</Label>
                <DatePicker value={form.effectiveFrom ?? undefined} onChange={(v) => setForm({ ...form, effectiveFrom: v ?? null })} />
                <p className="text-xs text-muted-foreground">Par défaut : début de la période en cours. Les périodes déjà écoulées gardent l’ancien montant ; choisissez une date plus ancienne seulement pour corriger une erreur de saisie.</p>
              </div>
            )}
            {form.id && form.ended && (
              <p className="text-xs text-muted-foreground sm:col-span-2">Ce forfait est terminé : la modification s’applique à toute sa période.</p>
            )}
          </div>
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" size="sm" onClick={() => { setForm(null); setAmountError(false); }} disabled={saving}>Annuler</Button>
            <Button size="sm" onClick={saveBudget} disabled={saving}>{saving && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}Enregistrer</Button>
          </div>
        </div>
      )}

      {/* Ventilation par catégorie (périodes écoulées). */}
      {c.byCategory.length > 0 && (
        <div className="space-y-1" data-tco-usage-categories>
          <p className="text-xs font-medium text-muted-foreground">Par catégorie (périodes écoulées)</p>
          <div className="divide-y divide-border">
            {c.byCategory.map((k) => (
              <div key={k.key} className="py-1.5 text-sm" data-tco-usage-category={k.key}>
                <div className="flex items-start justify-between gap-3">
                  <span className="min-w-0 text-[color:var(--text-primary)] break-words">{nomCle(k.key, k.category, k.label)} ({k.periods} période{k.periods > 1 ? 's' : ''})</span>
                  <span className="shrink-0 tabular-nums font-semibold">{eur(k.contributionCents)}</span>
                </div>
                <p className="text-xs text-muted-foreground tabular-nums">Forfait {eur(k.forfaitCents)} · réel {eur(k.realCents)} · complément estimé {eur(k.complementCents)}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Détail par période : forfait, tickets pris en compte, part estimée restante. */}
      {c.windows.length > 0 && (
        <div className="space-y-1" data-tco-usage-periods>
          <p className="text-xs font-medium text-muted-foreground">Par période</p>
          <div className="divide-y divide-border">
            {fenetres.map((w) => {
              const id = `${w.key}|${w.periodStart}`;
              const ouvert = openWindow === id;
              return (
                <div key={id} className="py-1.5" data-tco-usage-period={w.periodStart} data-tco-usage-period-key={w.key} data-tco-usage-period-closed={w.closed}>
                  <button type="button" className="w-full min-h-[44px] md:min-h-0 flex items-start justify-between gap-3 text-left text-sm" onClick={() => setOpenWindow(ouvert ? null : id)} aria-expanded={ouvert}>
                    <span className="min-w-0 flex items-start gap-1.5">
                      {ouvert ? <ChevronDown className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground" />}
                      <span className="min-w-0">
                        <span className="text-[color:var(--text-primary)] break-words">{nomCle(w.key, w.category, w.label)} · {periodeLabel(w)}</span>
                        <span className="block text-xs text-muted-foreground tabular-nums">
                          Forfait {eur(w.forfaitCents)}{w.prorated ? ` (prorata ${w.coveredDays}/${w.periodDays} jours)` : ''} · réel {eur(w.realCents)} ({w.lines.length} dépense{w.lines.length > 1 ? 's' : ''})
                          {w.closed ? ` · complément estimé ${eur(w.complementCents)}` : ' · en cours : estimée à la fin de la période, rien n’est ajouté avant'}
                        </span>
                      </span>
                    </span>
                    <span className={`shrink-0 tabular-nums ${w.closed ? 'font-semibold' : 'text-muted-foreground'}`}>{w.closed ? eur(w.contributionCents) : '—'}</span>
                  </button>
                  {ouvert && (
                    <div className="pl-6 pt-1 space-y-1 text-xs">
                      {w.lines.length === 0 && <p className="text-muted-foreground">Aucune dépense réelle de cette catégorie sur la période : le forfait est entièrement estimé.</p>}
                      {w.lines.map((l) => (
                        <div key={l.lineId} className="flex flex-wrap items-center justify-between gap-2" data-tco-usage-line={l.lineId}>
                          <span className="min-w-0 break-words">
                            {l.label} · {dateNum(l.date)} · <span className="tabular-nums">{eur(l.cents)}</span>
                            <span className="text-muted-foreground"> · {l.basis === 'USER' ? 'classée par vous' : 'reconnue à son libellé'}</span>
                          </span>
                          <span className="flex items-center gap-2">
                            <TcoJustificatif fileId={l.fileId} />
                            {canEdit && (
                              <Select value="" onValueChange={(v) => void assign(l.lineId, l.decisionKey, v)} disabled={assigning === l.lineId}>
                                <SelectTrigger className="h-8 w-[9.5rem]" aria-label="Changer la catégorie d’usage"><SelectValue placeholder="Changer…" /></SelectTrigger>
                                <SelectContent>
                                  {choixClassement}
                                  {l.basis === 'USER' && <SelectItem value="REVERT">Classement automatique</SelectItem>}
                                </SelectContent>
                              </Select>
                            )}
                          </span>
                        </div>
                      ))}
                      {w.closed && (
                        <p className="text-muted-foreground tabular-nums">
                          Contribution au TCO : réel {eur(w.realCents)} + complément estimé {eur(w.complementCents)} = {eur(w.contributionCents)}.
                        </p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {c.windows.length > PERIODES_VISIBLES && (
            <Button variant="ghost" size="sm" className="w-full sm:w-auto" onClick={() => setShowAll((v) => !v)} data-tco-usage-periods-more>
              {showAll ? 'Afficher moins de périodes' : `Afficher toutes les périodes (${c.windows.length})`}
            </Button>
          )}
        </div>
      )}

      {/* Dépenses à classer : catégorie d'usage non certaine (jamais devinée). */}
      {c.unclassified.length > 0 && (
        <div className="space-y-1" data-tco-usage-unclassified>
          <p className="text-xs font-medium text-muted-foreground">Dépenses à classer</p>
          <p className="text-xs text-muted-foreground">Ces dépenses pourraient être des dépenses d’usage. Indiquez leur catégorie pour qu’elles remplacent l’estimation de leur période (elles sont déjà comptées dans le coût réel).</p>
          <div className="divide-y divide-border">
            {c.unclassified.map((u) => (
              <div key={u.lineId} className="py-1.5 flex flex-wrap items-center justify-between gap-2 text-sm" data-tco-usage-unclassified-line={u.lineId}>
                <span className="min-w-0 break-words">
                  {u.label} · {dateNum(u.date)} · <span className="tabular-nums">{eur(u.cents)}</span>
                  {u.ambiguous.length > 1 && <span className="text-xs text-muted-foreground"> · plusieurs catégories possibles ({u.ambiguous.map((x) => catLabels[x]).join(', ')})</span>}
                </span>
                <span className="flex items-center gap-2">
                  <TcoJustificatif fileId={u.fileId} />
                  {canEdit && (
                    <Select value="" onValueChange={(v) => void assign(u.lineId, u.decisionKey, v)} disabled={assigning === u.lineId}>
                      <SelectTrigger className="h-8 w-[9.5rem]" aria-label="Classer la dépense"><SelectValue placeholder="Classer…" /></SelectTrigger>
                      <SelectContent>{choixClassement}</SelectContent>
                    </Select>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {t.usage.items.length > 0 && (
        <p className="text-xs text-muted-foreground" data-tco-usage-limits>
          Une estimation complète les justificatifs manquants : ce n’est ni une facture ni une preuve de paiement, et elle ne prétend pas connaître la dépense réelle exacte.
          Pour chaque période écoulée, le TCO retient le plus élevé du forfait et des dépenses réelles de la catégorie ; vos tickets restent conservés et visibles.
        </p>
      )}
    </section>
  );
}
