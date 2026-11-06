"use client"

/**
 * Lot 112H — « Conditions du prêt » : saisie manuelle des conditions d'un prêt
 * (fiche du bien › Coût total de possession › Financement), une feuille par
 * prêt. Desktop : tiroir à droite ; mobile : feuille plein écran (`Sheet`,
 * `w-full`), champs et boutons ≥ 44 px, clavier numérique, formats français.
 *
 *   · Chaque champ dit d'où vient sa valeur : « Lu sur « titre du justificatif » »
 *     ou « Saisi par vous le … » (la saisie prime) ; « Revenir à la valeur du
 *     document » efface la saisie (la lecture documentaire reprend) ;
 *   · Enregistrer : SEULS les champs modifiés sont envoyés à la route existante
 *     `PUT /api/assets/[id]/tco/financing/[operationId]` (lot 112D, mêmes
 *     validations côté client, la route reste l'autorité : son message est
 *     rattaché au champ) ; le serveur rend le TCO recalculé → capital restant
 *     dû mis à jour immédiatement (« établi » ou « non établi : il manque … »).
 *   · Lecture seule (`canEdit` faux) : valeurs et origines, aucune édition.
 *     Standard : la section est verrouillée (403 avant toute lecture), cette
 *     feuille n'est jamais proposée.
 */
import { useEffect, useId, useState } from 'react';
import { Check, Loader2, RotateCcw, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { FooterPrimaryAction } from '@/components/ui/footer-primary-action';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { apiClient } from '@/lib/api-client';
import type { TcoDto } from '@/services/business-operations/tco/dto';
import {
  buildLoanTermsPatch, deferralOf, effectivePeriodicity, fieldOfServerMessage, formatLoanValue, LOAN_DEFERRAL_OPTIONS, LOAN_FORM_FIELDS,
  LOAN_FORM_LABELS, LOAN_PERIODICITY_OPTIONS, loanFieldOrigin, outstandingSummary, textOf,
  type LoanDeferralChoice, type LoanFieldStates, type LoanFormDraft, type LoanFormErrors, type LoanFormField,
} from './tco-loan-terms-model';
import { LOAN_PERIOD_MONTHS, type LoanPeriodicity } from '@/services/business-operations/tco/loan-amortization';

export type TcoLoan = NonNullable<TcoDto['indicators']>['financing']['loans'][number];

const FORM_ID = 'tco-loan-terms-form';
const CIBLE = 'min-h-[44px]';

/** Nom du prêt affiché (jamais le mot « Opération »). */
export function loanDisplayName(loan: Pick<TcoLoan, 'label' | 'lender' | 'reference'>): string {
  return [loan.label, loan.lender, loan.reference].filter(Boolean).join(' · ') || 'Prêt';
}

const draftKeys = (f: LoanFormField): Array<keyof LoanFormDraft> => (f === 'deferral' ? ['deferralKind', 'deferralMonths'] : [f as keyof LoanFormDraft]);

interface FieldsProps {
  states: LoanFieldStates;
  draft: LoanFormDraft;
  errors: LoanFormErrors;
  canEdit: boolean;
  /** Champ en cours de retour à la valeur du document. */
  reverting?: LoanFormField | null;
  disabled?: boolean;
  onDraft?: (patch: Partial<LoanFormDraft>) => void;
  onRevert?: (f: LoanFormField) => void;
  idPrefix?: string;
}

/**
 * Champs du formulaire (présentation seule : rendu testable sans DOM). Chaque champ : libellé relié, origine
 * (`…-origin`) et erreur (`…-error`) reliées par `aria-describedby`.
 */
export function TcoLoanTermsFields({ states, draft, errors, canEdit, reverting = null, disabled = false, onDraft, onRevert, idPrefix = 'tco-loan' }: FieldsProps) {
  const per = effectivePeriodicity(states, draft);
  const set = (p: Partial<LoanFormDraft>) => onDraft?.(p);
  return (
    <div className="space-y-5">
      {LOAN_FORM_FIELDS.map((f) => {
        const id = `${idPrefix}-${f}`;
        const origin = loanFieldOrigin(f, states[f], per);
        const err = errors[f];
        const describedBy = [err ? `${id}-error` : null, `${id}-origin`, f === 'durationMonths' ? `${id}-hint` : null].filter(Boolean).join(' ');
        let control: React.ReactNode;
        if (!canEdit) {
          control = <p id={id} className="text-sm font-medium text-[color:var(--text-primary)] tabular-nums" data-loan-value>{formatLoanValue(f, states[f]?.value ?? null, per)}</p>;
        } else if (f === 'periodicity') {
          const v = draft.periodicity !== undefined ? draft.periodicity : (per ?? '');
          control = (
            <Select value={v || undefined} onValueChange={(x) => set({ periodicity: x as LoanPeriodicity })} disabled={disabled}>
              <SelectTrigger id={id} className={`w-full ${CIBLE}`} aria-invalid={err ? true : undefined} aria-describedby={describedBy}>
                <SelectValue placeholder="Choisir la périodicité" />
              </SelectTrigger>
              <SelectContent>
                {LOAN_PERIODICITY_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value} className={CIBLE}>{o.label}</SelectItem>)}
              </SelectContent>
            </Select>
          );
        } else if (f === 'firstInstallmentDate') {
          control = (
            <div role="group" aria-labelledby={`${id}-label`} aria-describedby={describedBy} data-invalid={err ? true : undefined}>
              <DatePicker id={id} value={textOf(states, draft, f) || undefined} onChange={(d) => set({ firstInstallmentDate: d })} disabled={disabled} placeholder="JJ/MM/AAAA" className={CIBLE} />
            </div>
          );
        } else if (f === 'deferral') {
          const d = deferralOf(states, draft);
          control = (
            <div className="space-y-3">
              <Select value={d.kind || undefined} onValueChange={(x) => set({ deferralKind: x as LoanDeferralChoice })} disabled={disabled}>
                <SelectTrigger id={id} className={`w-full ${CIBLE}`} aria-invalid={err ? true : undefined} aria-describedby={describedBy}>
                  <SelectValue placeholder="Choisir" />
                </SelectTrigger>
                <SelectContent>
                  {LOAN_DEFERRAL_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value} className={CIBLE}>{o.label}</SelectItem>)}
                </SelectContent>
              </Select>
              {(d.kind === 'PARTIAL' || d.kind === 'TOTAL') && (
                <div className="space-y-1.5">
                  <Label htmlFor={`${id}-months`}>Durée du différé (en mois)</Label>
                  <Input
                    id={`${id}-months`} inputMode="numeric" pattern="[0-9]*" autoComplete="off" enterKeyHint="next" disabled={disabled}
                    className={`${CIBLE} text-right tabular-nums`} value={d.months} onChange={(e) => set({ deferralMonths: e.target.value })}
                    aria-invalid={err ? true : undefined} aria-describedby={describedBy}
                  />
                </div>
              )}
            </div>
          );
        } else {
          const money = f === 'principalCents' || f === 'installmentCents' || f === 'insuranceCents';
          const suffix = money ? '€' : f === 'ratePct' ? '%' : null;
          control = (
            <div className="relative">
              <Input
                id={id}
                inputMode={f === 'durationMonths' ? 'numeric' : 'decimal'}
                pattern={f === 'durationMonths' ? '[0-9]*' : undefined}
                autoComplete="off" enterKeyHint="next" disabled={disabled}
                placeholder={money ? '0,00' : f === 'ratePct' ? '3,25' : '240'}
                className={`${CIBLE} text-right tabular-nums ${suffix ? 'pr-9' : ''}`}
                value={textOf(states, draft, f)}
                onChange={(e) => set({ [f]: e.target.value } as Partial<LoanFormDraft>)}
                aria-invalid={err ? true : undefined}
                aria-describedby={describedBy}
              />
              {suffix && <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground" aria-hidden>{suffix}</span>}
            </div>
          );
        }
        const duree = f === 'durationMonths' ? durationHint(states, draft, per) : null;
        return (
          <div key={f} className="space-y-1.5" data-loan-field={f} data-loan-origin={origin.kind}>
            <Label id={`${id}-label`} htmlFor={canEdit ? id : undefined}>{LOAN_FORM_LABELS[f]}</Label>
            {control}
            {err && <p id={`${id}-error`} className="text-xs text-destructive" data-loan-error>{err}</p>}
            {f === 'durationMonths' && <p id={`${id}-hint`} className="text-xs text-muted-foreground">{duree}</p>}
            <p id={`${id}-origin`} className="text-xs text-muted-foreground" data-loan-origin-text>
              {origin.text}{origin.documentText ? ` ${origin.documentText}` : ''}
            </p>
            {canEdit && (origin.canRevertToDocument || origin.canClear) && (
              <Button
                type="button" variant="ghost" size="sm" disabled={disabled || reverting != null}
                className={`${CIBLE} -ml-2 px-2 text-[color:var(--accent)]`} onClick={() => onRevert?.(f)}
                data-loan-revert={f}
              >
                {reverting === f ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RotateCcw className="h-4 w-4" aria-hidden />}
                {origin.canRevertToDocument ? 'Revenir à la valeur du document' : 'Effacer ma saisie'}
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Aide de la durée : équivalence en mois, ou durée connue en mois quand la périodicité manque. */
function durationHint(states: LoanFieldStates, draft: LoanFormDraft, per: LoanPeriodicity | null): string {
  const t = textOf(states, draft, 'durationMonths').trim();
  const opt = LOAN_PERIODICITY_OPTIONS.find((o) => o.value === per);
  const moisParEcheance = per ? LOAN_PERIOD_MONTHS[per] : null;
  if (/^\d{1,4}$/.test(t) && opt && moisParEcheance) return `Échéances ${opt.unit} : soit ${Number(t) * moisParEcheance} mois.`;
  const m = states.durationMonths?.value;
  if (typeof m === 'number' && draft.durationMonths === undefined) return `Durée connue : ${m} mois${per ? '' : ' (choisissez la périodicité pour l’exprimer en échéances)'}.`;
  return per ? `Nombre total d’échéances ${opt!.unit} du prêt.` : 'Choisissez d’abord la périodicité des échéances.';
}

/** Résumé du capital restant dû (mis à jour à chaque enregistrement, annoncé aux lecteurs d'écran). */
export function TcoLoanOutstandingStatus({ loan, id }: { loan: TcoLoan; id?: string }) {
  const s = outstandingSummary(loan.outstanding);
  if (!s) return null;
  return (
    <div
      id={id} role="status" aria-live="polite" data-tco-loan-outstanding={s.established ? 'ESTABLISHED' : 'NOT_ESTABLISHED'}
      className={`rounded-[12px] border p-3 space-y-1 ${s.established ? 'border-border bg-card' : 'border-[color:var(--attention-edge)] bg-[color:var(--attention-soft)]'}`}
    >
      <p className="text-sm font-semibold text-[color:var(--text-primary)] tabular-nums">{s.title}</p>
      <p className={`text-xs ${s.established ? 'text-muted-foreground' : 'text-[color:var(--attention-on-soft)]'}`}>{s.detail}</p>
    </div>
  );
}

interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  assetId: number;
  loan: TcoLoan | null;
  canEdit: boolean;
  /** TCO recalculé rendu par la route (mise à jour immédiate de la fiche). */
  onSaved: (tco: TcoDto) => void;
  /** Écriture propre en cours (la fiche ignore son propre événement de mutation). */
  onOwnWrite?: (writing: boolean) => void;
}

export function TcoLoanTermsSheet({ open, onOpenChange, assetId, loan, canEdit, onSaved, onOwnWrite }: SheetProps) {
  const [draft, setDraft] = useState<LoanFormDraft>({});
  const [errors, setErrors] = useState<LoanFormErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reverting, setReverting] = useState<LoanFormField | null>(null);
  const prefix = `tco-loan-${useId().replace(/:/g, '')}`;
  const states: LoanFieldStates = loan?.outstanding?.fields ?? {};
  const loanKey = loan?.key ?? null;

  // Nouvelle ouverture ou autre prêt : formulaire vierge.
  useEffect(() => { if (open) { setDraft({}); setErrors({}); setFormError(null); } }, [open, loanKey]);

  const pending = buildLoanTermsPatch(states, draft);
  const dirty = !pending.ok || pending.changed.length > 0;

  const envoyer = async (body: { terms: Record<string, unknown> }) => {
    if (!loan?.operationId) return null;
    onOwnWrite?.(true);
    try {
      return await apiClient.put<{ tco: TcoDto }>(`/api/assets/${assetId}/tco/financing/${loan.operationId}`, body);
    } finally {
      onOwnWrite?.(false);
    }
  };
  const erreurServeur = (e: unknown) => {
    const err = e as { code?: string; serverMessage?: string };
    const msg = err.serverMessage ?? 'Les conditions du prêt n’ont pas pu être enregistrées. Réessayez.';
    const champ = err.code === 'VALIDATION' ? fieldOfServerMessage(msg) : null;
    if (champ) { setErrors({ [champ]: msg }); focusField(prefix, champ); } else setFormError(msg);
  };

  const enregistrer = async (ev?: React.FormEvent) => {
    ev?.preventDefault();
    if (!canEdit || busy) return;
    setFormError(null);
    const r = buildLoanTermsPatch(states, draft);
    if (!r.ok) { setErrors(r.errors); focusField(prefix, LOAN_FORM_FIELDS.find((f) => r.errors[f])!); return; }
    setErrors({});
    if (!r.changed.length) return;
    setBusy(true);
    try {
      const res = await envoyer(r.body);
      if (res) {
        onSaved(res.tco); setDraft({}); toast.success('Conditions du prêt enregistrées');
        // Capital restant dû recalculé : ramené en vue (annoncé par la zone `role="status"`).
        setTimeout(() => document.getElementById(`${prefix}-status`)?.scrollIntoView({ block: 'nearest' }), 0);
      }
    } catch (e) {
      erreurServeur(e);
    } finally {
      setBusy(false);
    }
  };

  const revenir = async (f: LoanFormField) => {
    if (!canEdit || reverting) return;
    setFormError(null);
    setReverting(f);
    try {
      const res = await envoyer({ terms: { [f]: null } });
      if (res) {
        onSaved(res.tco);
        setDraft((d) => { const n = { ...d }; for (const k of draftKeys(f)) delete n[k]; return n; });
        setErrors((e) => { const n = { ...e }; delete n[f]; return n; });
        toast.success(states[f]?.document ? 'Valeur du document rétablie' : 'Saisie effacée');
      }
    } catch (e) {
      erreurServeur(e);
    } finally {
      setReverting(null);
    }
  };

  const erreurs = LOAN_FORM_FIELDS.filter((f) => errors[f]);
  return (
    <Sheet open={open} onOpenChange={(v) => { if (!busy) onOpenChange(v); }}>
      <SheetContent side="right" className="w-full sm:max-w-md flex flex-col gap-0 p-0" data-tco-loan-sheet={canEdit ? 'edit' : 'read'}>
        <SheetHeader className="px-5 pt-5 pb-3">
          <SheetTitle>Conditions du prêt</SheetTitle>
          <SheetDescription>{loan ? loanDisplayName(loan) : ''}</SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-5 pb-6 space-y-4">
          {loan && <TcoLoanOutstandingStatus loan={loan} id={`${prefix}-status`} />}
          {canEdit ? (
            <p className="text-xs text-muted-foreground">Complétez ou corrigez les conditions : votre saisie prime sur les documents et reste réversible. Le capital restant dû est recalculé dès l’enregistrement.</p>
          ) : (
            <p className="text-xs text-muted-foreground" data-tco-loan-readonly>Consultation seule : les conditions ne peuvent pas être modifiées ici.</p>
          )}
          {loan?.outstanding?.variableRateMentioned && (
            <p className="text-xs text-muted-foreground" data-tco-loan-variable>Un document mentionne un taux variable ou révisable : le capital restant dû n’est calculé qu’avec un taux saisi.</p>
          )}
          {(formError || erreurs.length > 0) && (
            <div role="alert" className="rounded-[12px] border border-destructive/40 p-3 text-sm text-destructive" data-tco-loan-errors>
              {formError ?? (erreurs.length === 1 ? 'Un champ est à corriger :' : `${erreurs.length} champs sont à corriger :`)}
              {!formError && (
                <ul className="mt-1 list-disc pl-5">
                  {erreurs.map((f) => <li key={f}><a href={`#${prefix}-${f}`} className="underline" onClick={(e) => { e.preventDefault(); focusField(prefix, f); }}>{LOAN_FORM_LABELS[f]}</a></li>)}
                </ul>
              )}
            </div>
          )}
          <form id={FORM_ID} noValidate onSubmit={enregistrer} aria-label="Conditions du prêt">
            <TcoLoanTermsFields
              states={states} draft={draft} errors={errors} canEdit={canEdit} reverting={reverting} disabled={busy} idPrefix={prefix}
              onDraft={(p) => { setDraft((d) => ({ ...d, ...p })); setFormError(null); }}
              onRevert={revenir}
            />
          </form>
        </div>
        <div className="px-5 py-4 border-t">
          {canEdit ? (
            <div className="flex items-stretch rounded-xl border border-border bg-muted/30 overflow-hidden">
              <button
                type="button"
                className="flex-1 flex flex-col items-center justify-center gap-1.5 min-h-[44px] py-3 px-2 hover:bg-muted/60 transition-colors text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
                onClick={() => onOpenChange(false)} disabled={busy}
              >
                <X className="w-4 h-4" aria-hidden />
                <span className="text-[12px] font-semibold">{dirty ? 'Annuler' : 'Fermer'}</span>
              </button>
              <div className="w-px bg-border" />
              <FooterPrimaryAction
                type="submit" form={FORM_ID} icon={Check} label="Enregistrer" busy={busy} busyLabel="Enregistrement…"
                disabled={!dirty || reverting != null} disabledReasonId={`${prefix}-nochange`}
              />
              <span id={`${prefix}-nochange`} className="sr-only">Aucune modification à enregistrer.</span>
            </div>
          ) : (
            <Button type="button" variant="outline" className={`w-full ${CIBLE}`} onClick={() => onOpenChange(false)}>Fermer</Button>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function focusField(prefix: string, f: LoanFormField | undefined) {
  if (!f || typeof document === 'undefined') return;
  setTimeout(() => document.getElementById(`${prefix}-${f}`)?.focus(), 0);
}
