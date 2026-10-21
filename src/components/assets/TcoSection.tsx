"use client"

/**
 * Section « Coût total de possession » — Bien › Informations (lot 61, ticket
 * P1 TCO §5 ; remplace le tiroir latéral ouvert depuis « Valorisation », lot
 * 54D). Section dépliable AUTONOME, au même niveau que « Valorisation » et
 * « Assurance », pour toutes les familles (immobilier, véhicule, objet) ;
 * même en-tête et mêmes jetons que les autres sections de l'onglet (cf.
 * `AssetClaimsSection`). Desktop et mobile : un seul composant responsive.
 *
 *   · Synthèse : coût cumulé documenté, coût d'acquisition, dépenses
 *     complémentaires, coût net estimé / final, complétude ;
 *   · Détail : ventilation par catégorie (montant, nombre), dépenses
 *     retenues (intitulé, date, montant, justificatif ouvrable, dépense
 *     consolidée éventuelle), avoirs / remboursements / indemnités ;
 *   · Valeur et cession, budget d'usage (estimation, séparé du réalisé) ;
 *   · Dépenses non retenues ou non attribuées, avec leur motif ; alertes.
 *     Lot 68 : seulement ce qui est utile pour CE bien (non qualifiée, devise,
 *     non ventilée, prévision…) ; les justificatifs repris par une dépense
 *     consolidée s'ouvrent depuis la ligne retenue.
 *   · Lot 75D : détail paginé — nombre de lignes présentées / total TOUJOURS
 *     affiché quand la liste est abrégée, « Afficher les lignes suivantes »
 *     (chargement complémentaire ; totaux toujours exacts) ; montant inconnu
 *     jamais affiché « 0 € » ; rapprochement incertain signalé « à vérifier » ;
 *     coût d'acquisition « non renseigné » ou « sans objet ».
 *   · Lot 76G : trois indicateurs distincts — TCO total (cumulatif), TCO
 *     moyen annuel (coût annualisé, achat initial inclus) et dépenses de
 *     l'année (réellement constatées, sélecteur d'année) — DÉRIVÉS par le
 *     moteur (`tco/annual.ts`), jamais recalculés ici. « Dépenses retenues
 *     (N) » est un déclencheur fermé par défaut qui ouvre un SOUS-TIROIR à
 *     droite (mécanisme `Sheet` des autres sous-tiroirs de l'app ; pleine
 *     largeur sur mobile) : liste cumulée, ou filtrée sur l'année choisie.
 *
 * Aucun bouton « Modifier » du total : les corrections se font sur les
 * sources (fiche, document). Standard : présentation verrouillée, AUCUN
 * montant reçu (403 serveur avant toute lecture). Lecture seule : aucune
 * écriture (forfaits non modifiables).
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { DatePicker } from '@/components/ui/date-picker';
import { NumberInput } from '@/components/ui/number-input';
import { formatNumberForInput, MONEY_INPUT, parseMoneyInputToCents } from '@/lib/number-input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { AlertCircle, ArrowLeft, ChevronDown, ChevronRight, ChevronUp, FileText, Loader2, Lock, Pencil, Plus, Trash2 } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { toast } from 'sonner';
// Types seulement : les libellés viennent de la réponse (aucun module serveur ni registre dans le paquet client).
import type { TcoDto } from '@/services/business-operations/tco/dto';

interface Props {
  assetId: number;
  readOnly?: boolean;
  defaultOpen?: boolean;
}

type Line = TcoDto['lines'][number];
type Annual = TcoDto['annual'];

/** Lot 76G : années de possession, au dixième (« 2,8 ans »). */
function ansFr(n: number): string {
  const v = n.toLocaleString('fr-FR', { maximumFractionDigits: 1 });
  return `${v} an${n >= 2 ? 's' : ''}`;
}

/** Lot 76G : explication du TCO moyen annuel (calculé ou motif de non-calcul). */
function moyenneExplication(a: Annual['average'], endSource: string): string {
  switch (a.status) {
    case 'COMPUTED': {
      const fin = endSource === 'TODAY' ? 'à aujourd’hui' : `au ${dateFr(a.end)}`;
      return `Sur ${ansFr(a.years ?? 0)} de possession (du ${dateFr(a.start)} ${fin}).${a.extrapolated ? ' Moins d’un an de possession : valeur extrapolée.' : ''}`;
    }
    case 'ACQUISITION_DATE_MISSING': return 'Date d’achat inconnue : moyenne non calculée. Renseignez la date d’achat de la fiche.';
    case 'ACQUISITION_DATE_INCOHERENT': return 'Date d’achat incohérente (postérieure à aujourd’hui ou à la cession) : moyenne non calculée.';
    case 'TOO_RECENT': return `Moins de ${a.minDays} jours de possession : moyenne non calculée (elle serait trompeuse).`;
    default: return '';
  }
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
  try { return new Date(`${d.slice(0, 10)}T00:00:00Z`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }); } catch { return d; }
}

const NEGATIVE = new Set(['REDUCTION', 'REFUND', 'INDEMNITY']);
const RETENUE = new Set(['RETAINED_DIRECT', 'RETAINED_CONSOLIDATED']);

type BudgetForm = { id: number | null; category: string; label: string; /** Texte saisi en euros (lot 58A). */ amount: string; periodicity: string; validFrom: string | null; validTo: string | null };
const VIDE: BudgetForm = { id: null, category: 'FUEL', label: '', amount: '', periodicity: 'MONTHLY', validFrom: null, validTo: null };

function Bloc({ title, children, ...rest }: { title: string; children: React.ReactNode } & Record<`data-${string}`, boolean | string>) {
  return (
    <section className="space-y-2" {...rest}>
      <h3 className="vb-app-subsection m-0">{title}</h3>
      {children}
    </section>
  );
}

function Ligne({ label, value, muted, strong }: { label: string; value: string; muted?: boolean; strong?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 text-sm">
      <span className={`min-w-0 ${muted ? 'text-muted-foreground' : 'text-[color:var(--text-primary)]'}`}>{label}</span>
      <span className={`shrink-0 tabular-nums ${strong ? 'font-semibold text-[color:var(--text-primary)]' : ''}`}>{value}</span>
    </div>
  );
}

/** Lien vers le justificatif source d'une ligne (même page document sur desktop et mobile). */
function Justificatif({ fileId, title }: { fileId: number | null; title?: string }) {
  if (!fileId) return null;
  return (
    <Link href={`/documents/${fileId}`} className="inline-flex min-w-0 items-center gap-1 text-xs text-primary hover:underline" data-tco-doc-link={fileId} title={title}>
      <FileText className="w-3 h-3 shrink-0" /> <span className="truncate max-w-[16rem]">{title ? `Justificatif : ${title}` : 'Justificatif'}</span>
    </Link>
  );
}

function LigneDepense({ l, t }: { l: Line; t: TcoDto }) {
  const retenue = RETENUE.has(l.status);
  const montant = retenue ? l.includedCents : l.eurCents;
  const signe = l.kind && NEGATIVE.has(l.kind) ? '− ' : '';
  // Lot 75D (D) : montant inconnu — jamais « 0,00 € ».
  const valeur = l.amountUnknown ? 'Montant inconnu' : montant != null ? `${signe}${eur(montant)}` : minor(l.amountMinor, l.currency);
  return (
    <div className="py-2 text-sm" data-tco-line={l.id} data-tco-line-status={l.status}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[color:var(--text-primary)] break-words">{l.label}</p>
          <p className="text-xs text-muted-foreground">
            {dateFr(l.date)}
            {l.category ? ` · ${t.categoryLabels[l.category]}` : ''}
            {l.operationLabel && l.source !== 'OPERATION' ? ` · ${l.operationLabel}` : ''}
          </p>
        </div>
        <span className={`shrink-0 tabular-nums ${l.amountUnknown ? 'text-muted-foreground' : ''}`}>{valeur}</span>
      </div>
      {!retenue && (
        <p className="text-xs text-muted-foreground mt-0.5">
          {t.lineStatusLabels[l.status]}{l.reason ? ` — ${t.lineReasonLabels[l.reason]}` : ''}
        </p>
      )}
      {l.uncertain
        ? <p className="text-xs text-[color:var(--attention-on-soft)] mt-0.5" data-tco-line-uncertain>À vérifier : {l.note}</p>
        : l.note && <p className="text-xs text-muted-foreground mt-0.5">{l.note}</p>}
      <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
        <Justificatif fileId={l.fileId} />
        {/* Lot 68 : justificatifs repris par cette dépense consolidée (plus listés dans les non retenues). */}
        {(l.supportingDocuments ?? []).map((d) => <Justificatif key={d.fileId} fileId={d.fileId} title={d.title} />)}
      </div>
    </div>
  );
}

export function TcoSection({ assetId, readOnly = false, defaultOpen = false }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const [data, setData] = useState<TcoDto | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState<BudgetForm | null>(null);
  const [amountError, setAmountError] = useState(false);
  useEffect(() => { if (!form) setAmountError(false); }, [form]);
  const [saving, setSaving] = useState(false);
  const [refresh, setRefresh] = useState(0);
  // Lot 75D (J) : lignes des pages suivantes (chargement complémentaire), remises à zéro à chaque recalcul.
  const [extra, setExtra] = useState<Line[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  // Lot 76G : année des « Dépenses de l'année » (null : année par défaut du calcul) — conservée aux recalculs.
  const [year, setYear] = useState<number | null>(null);
  const [retainedOpen, setRetainedOpen] = useState(false); // L76G : sous-tiroir fermé par défaut
  const [retainedFilter, setRetainedFilter] = useState<'ALL' | 'YEAR'>('ALL');

  // Recalcul à chaque ouverture et après toute modification de la fiche (même événement que les autres sections).
  useEffect(() => {
    const handler = (e: Event) => {
      const id = (e as CustomEvent<{ assetId?: number }>).detail?.assetId;
      if (!id || id === assetId) setRefresh((n) => n + 1);
    };
    window.addEventListener('asset-details-updated', handler);
    return () => window.removeEventListener('asset-details-updated', handler);
  }, [assetId]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const r = await apiClient.get<{ tco: TcoDto; canEdit: boolean }>(`/api/assets/${assetId}/tco`);
      setData(r.tco);
      setExtra([]);
      setCanEdit(!!r.canEdit && !readOnly);
      setLocked(false);
    } catch (e) {
      if ((e as { code?: string }).code === 'PREMIUM_REQUIRED') { setLocked(true); setData(null); }
      else { setError(true); setData(null); }
    } finally {
      setLoading(false);
    }
  }, [assetId, readOnly]);

  useEffect(() => { if (open) void load(); }, [open, load, refresh]);

  const loadMore = async () => {
    if (!data) return;
    setLoadingMore(true);
    try {
      const offset = data.linesOffset + data.lines.length + extra.length;
      const r = await apiClient.get<{ tco: TcoDto }>(`/api/assets/${assetId}/tco?linesOffset=${offset}`);
      // Données recalculées entre-temps : on repart de la première page (aucun mélange de deux calculs).
      if (r.tco.linesTotal !== data.linesTotal || r.tco.summary.cumulativeCostCents !== data.summary.cumulativeCostCents) { void load(); return; }
      const vus = new Set([...data.lines, ...extra].map((l) => l.id));
      setExtra((prev) => [...prev, ...r.tco.lines.filter((l) => !vus.has(l.id))]);
    } catch {
      toast.error('Chargement des lignes suivantes impossible');
    } finally {
      setLoadingMore(false);
    }
  };

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
  const catLabels = t?.usageLabels.categories ?? ({} as TcoDto['usageLabels']['categories']);
  const perLabels = t?.usageLabels.periodicities ?? ({} as TcoDto['usageLabels']['periodicities']);
  const toutes = t ? [...t.lines, ...extra] : [];
  const affichees = toutes.length;
  const restantes = t ? Math.max(0, t.linesTotal - t.linesOffset - affichees) : 0;
  const retenues = toutes.filter((l) => RETENUE.has(l.status));
  const ajustements = retenues.filter((l) => l.kind && NEGATIVE.has(l.kind));
  const depenses = retenues.filter((l) => !(l.kind && NEGATIVE.has(l.kind)) && l.kind !== 'PROCEED');
  // Lot 68 : le serveur ne transmet que les lignes utiles pour CE bien (`tcoUserView`) — ni « autre bien », ni
  // justificatif déjà porté par une dépense consolidée affichée (tous restent au diagnostic BO). Garde défensive.
  const ecartees = toutes.filter((l) => !RETENUE.has(l.status) && l.status !== 'OUT_OF_SCOPE');
  // Lot 76G : indicateurs annuels calculés par le moteur (aucun recalcul ici).
  const annual = t?.annual ?? null;
  const anneeSel = annual ? (year != null && annual.years.some((y) => y.year === year) ? year : annual.defaultYear) : null;
  const anneeCourante = annual?.years.find((y) => y.year === anneeSel) ?? null;
  const depensesFiltrees = retainedFilter === 'YEAR' && anneeSel != null ? depenses.filter((l) => l.date?.slice(0, 4) === String(anneeSel)) : depenses;

  return (
    <div id="asset-section-tco" className="border border-border rounded-lg overflow-hidden" data-asset-tco>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 bg-muted/30 hover:bg-muted/50 transition-colors text-left"
        aria-expanded={open}
        data-tco-toggle
      >
        <span className="flex items-center gap-2 min-w-0">
          <span className="font-medium text-sm">Coût total de possession</span>
          {open && t && !locked && (
            <span className="text-[10px] font-medium text-primary bg-primary/10 rounded-full px-1.5 py-0.5 shrink-0 tabular-nums">{eur(t.summary.cumulativeCostCents)}</span>
          )}
          {locked && <Lock className="w-3.5 h-3.5 text-muted-foreground shrink-0" aria-label="Fonction Premium" />}
        </span>
        {open ? <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />}
      </button>

      {open && (
        <div className="p-4 space-y-5" data-tco-body>
          {loading && !t && !locked ? (
            <div className="flex justify-center py-6"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
          ) : locked ? (
            <div className="rounded-lg border border-border p-4 text-sm space-y-2" data-tco-locked>
              <div className="flex items-center gap-2 font-semibold"><Lock className="w-4 h-4" /> Fonction Premium</div>
              <p className="text-muted-foreground">Le coût total de possession (coûts documentés, valeur, résultat de cession) est disponible avec Premium et Premium Duo. Vos données sont conservées.</p>
            </div>
          ) : error || !t ? (
            <div className="text-sm text-muted-foreground flex flex-wrap items-center gap-2" data-tco-error>
              <AlertCircle className="w-4 h-4 text-[color:var(--danger)]" />
              Le coût total de possession n’a pas pu être calculé.
              <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => void load()}>Réessayer</button>
            </div>
          ) : (
            <>
              {/* ── Synthèse ── */}
              <div className="rounded-lg border border-primary/20 bg-primary/5 p-4" data-tco-summary>
                <p className="text-[13px] font-semibold text-primary mb-1">Coût cumulé documenté</p>
                <p className="text-2xl font-bold text-[color:var(--text-primary)] tabular-nums">{eur(t.summary.cumulativeCostCents)}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {t.period.start ? `Du ${dateFr(t.period.start)} ` : 'Date d’acquisition non renseignée — '}
                  {t.period.endSource === 'TODAY' ? 'à aujourd’hui' : `au ${dateFr(t.period.end)} (cession)`}
                </p>
                <div className="mt-3 divide-y divide-border">
                  <Ligne label="Coût d’acquisition" value={t.summary.acquisitionStatus === 'MISSING' ? 'non renseigné' : t.summary.acquisitionStatus === 'NOT_APPLICABLE' ? 'sans objet (aucun achat)' : eur(t.summary.acquisitionCents)} muted={t.summary.acquisitionStatus !== 'DOCUMENTED'} />
                  <Ligne label="Dépenses complémentaires" value={eur(t.summary.additionalCostsCents)} />
                  {t.reductionsCents + t.refundsCents + t.indemnitiesCents > 0 && (
                    <Ligne label="Avoirs, remboursements et indemnités" value={`− ${eur(t.reductionsCents + t.refundsCents + t.indemnitiesCents)}`} />
                  )}
                  {!t.disposed && <Ligne label="Coût net estimé (après valeur actuelle)" value={t.summary.netEstimatedCents != null ? eur(t.summary.netEstimatedCents) : 'non calculable'} strong />}
                  {t.disposed && <Ligne label="Coût net final (après cession)" value={t.summary.netFinalCents != null ? eur(t.summary.netFinalCents) : 'non établi'} strong />}
                </div>
                <p className={`text-xs mt-2 ${t.status === 'COMPLETE' ? 'text-muted-foreground' : 'text-[color:var(--attention-on-soft)]'}`} data-tco-completeness={t.status}>
                  {t.status === 'COMPLETE' ? `Calcul complet : ${t.reliability.operationsCounted + t.reliability.documentsCounted} élément(s) documenté(s).`
                    : t.status === 'PARTIAL' ? 'Résultat partiel : seule une partie des éléments a pu être lue.'
                      : 'Couverture incomplète : voir les alertes ci-dessous.'}
                </p>
              </div>

              {/* ── Lot 76G : indicateurs annuels (TCO total, TCO moyen annuel, dépenses de l'année) ── */}
              {annual && anneeCourante && (
                <section className="space-y-2" data-tco-annual>
                  <h3 className="vb-app-subsection m-0">Indicateurs annuels</h3>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <div className="rounded-lg border border-border p-3 min-w-0" data-tco-indicator="total">
                      <p className="text-xs text-muted-foreground">TCO total</p>
                      <p className="text-lg font-semibold text-[color:var(--text-primary)] tabular-nums">{eur(annual.average.totalCents)}</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        Coût cumulé {t.period.start ? `depuis le ${dateFr(t.period.start)}` : 'documenté'}{t.period.endSource === 'TODAY' ? '' : ` jusqu’à la cession (${dateFr(t.period.end)})`}.
                      </p>
                    </div>
                    <div className="rounded-lg border border-border p-3 min-w-0" data-tco-indicator="average" data-tco-average-status={annual.average.status}>
                      <p className="text-xs text-muted-foreground">TCO moyen annuel</p>
                      <p className={`text-lg font-semibold tabular-nums ${annual.average.cents == null ? 'text-muted-foreground' : 'text-[color:var(--text-primary)]'}`}>
                        {annual.average.cents != null ? `${eur(annual.average.cents)} / an` : 'Non calculé'}
                      </p>
                      <p className="text-xs text-muted-foreground mt-1 break-words">{moyenneExplication(annual.average, t.period.endSource)}</p>
                      {annual.average.cents != null && annual.average.incomplete && (
                        <p className="text-xs text-[color:var(--attention-on-soft)] mt-0.5">Données manquantes : valeur incomplète (voir les alertes).</p>
                      )}
                    </div>
                    <div className="rounded-lg border border-border p-3 min-w-0" data-tco-indicator="year">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-xs text-muted-foreground">Dépenses de l’année</p>
                        <Select value={String(anneeSel)} onValueChange={(v) => setYear(Number(v))}>
                          <SelectTrigger className="h-8 w-[6.5rem] shrink-0" aria-label="Année des dépenses" data-tco-year-select><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {[...annual.years].reverse().map((y) => <SelectItem key={y.year} value={String(y.year)}>{y.year}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </div>
                      <p className="text-lg font-semibold text-[color:var(--text-primary)] tabular-nums" data-tco-year-total={anneeCourante.year}>{eur(anneeCourante.costsCents)}</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        {anneeCourante.count === 0
                          ? `Aucune dépense datée du ${dateFr(anneeCourante.periodStart)} au ${dateFr(anneeCourante.periodEnd)}.`
                          : `${anneeCourante.count} dépense(s) réellement constatée(s) du ${dateFr(anneeCourante.periodStart)} au ${dateFr(anneeCourante.periodEnd)}.`}
                      </p>
                      {anneeCourante.creditsCents > 0 && (
                        <p className="text-xs text-muted-foreground mt-0.5">Avoirs, remboursements et indemnités de l’année : − {eur(anneeCourante.creditsCents)} (net {eur(anneeCourante.netCents)}).</p>
                      )}
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Le TCO moyen annuel est un coût annualisé : l’achat initial y est inclus, ce n’est donc pas le budget annuel récurrent d’utilisation.
                    Les dépenses de l’année sont les dépenses réellement constatées, à leur date, pendant l’année choisie.
                  </p>
                  {annual.undated.count > 0 && (
                    <p className="text-xs text-[color:var(--attention-on-soft)]" data-tco-annual-undated>
                      {annual.undated.count} dépense(s) sans date ({eur(annual.undated.costsCents)}) : comptée(s) dans le TCO total, rattachée(s) à aucune année.
                    </p>
                  )}
                  {annual.future.count > 0 && (
                    <p className="text-xs text-[color:var(--attention-on-soft)]" data-tco-annual-future>
                      {annual.future.count} dépense(s) datée(s) après aujourd’hui ({eur(annual.future.costsCents)}) : non encore réalisée(s), comptée(s) dans aucune année.
                    </p>
                  )}
                </section>
              )}

              {/* ── Détail des coûts ── */}
              <Bloc title="Détail des coûts" data-tco-breakdown>
                <div className="divide-y divide-border">
                  {t.breakdown.length === 0 && <p className="text-sm text-muted-foreground py-1.5">Aucun coût documenté.</p>}
                  {t.breakdown.map((b) => <Ligne key={b.category} label={`${b.label} (${b.count})`} value={eur(b.costsCents)} />)}
                  {t.reductionsCents > 0 && <Ligne label="Avoirs et réductions" value={`− ${eur(t.reductionsCents)}`} />}
                  {t.refundsCents > 0 && <Ligne label="Remboursements" value={`− ${eur(t.refundsCents)}`} />}
                  {t.indemnitiesCents > 0 && <Ligne label="Indemnités reçues" value={`− ${eur(t.indemnitiesCents)}`} />}
                  <Ligne label="Coût cumulé" value={eur(t.summary.cumulativeCostCents)} strong />
                </div>
              </Bloc>

              {/* Lot 75D (J) : liste abrégée — toujours signalée, même si elle ne contient que des dépenses retenues. */}
              {t.linesTruncated && (
                <div className="rounded-lg border border-border p-3 text-xs space-y-2" data-tco-lines-truncated>
                  <p className="text-muted-foreground" data-tco-lines-count>
                    {affichees} ligne(s) présentée(s) sur {t.linesTotal} ({t.retainedLinesTotal} retenue(s), {t.otherLinesTotal} non retenue(s)). Les totaux portent sur toutes les lignes.
                  </p>
                  {restantes > 0 && (
                    <Button variant="outline" size="sm" className="w-full sm:w-auto" onClick={() => void loadMore()} disabled={loadingMore} data-tco-load-more>
                      {loadingMore && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}Afficher les lignes suivantes ({restantes})
                    </Button>
                  )}
                </div>
              )}

              {/* Lot 76G (complément PO du 21/10) : liste fermée par défaut — le déclencheur ouvre le sous-tiroir. */}
              <section data-tco-retained>
                <button
                  type="button"
                  onClick={() => setRetainedOpen(true)}
                  aria-expanded={retainedOpen}
                  aria-haspopup="dialog"
                  className="w-full min-h-[44px] md:min-h-[36px] flex items-center justify-between gap-3 rounded-lg border border-border px-4 py-2.5 text-left hover:bg-muted/50 transition-colors"
                  data-tco-retained-trigger
                >
                  <span className="vb-app-subsection m-0">{`Dépenses retenues (${depenses.length}${t.linesTruncated ? ' · liste abrégée' : ''})`}</span>
                  <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" aria-hidden />
                </button>
              </section>

              {ajustements.length > 0 && (
                <Bloc title="Avoirs, remboursements et indemnités" data-tco-adjustments>
                  <div className="divide-y divide-border">{ajustements.map((l) => <LigneDepense key={l.id} l={l} t={t} />)}</div>
                </Bloc>
              )}

              {/* ── Valeur et cession ── */}
              {(t.disposed || t.disposal.desiredPriceCents != null || t.summary.currentValue) && (
                <Bloc title={t.disposed ? 'Cession' : 'Valeur actuelle et cession'} data-tco-disposal>
                  <div className="divide-y divide-border">
                    {!t.disposed && <Ligne label="Valeur actuelle" value={t.summary.currentValue ? `${eur(t.summary.currentValue.cents)} · ${dateFr(t.summary.currentValue.date)}` : 'non disponible'} muted />}
                    {t.disposal.desiredPriceCents != null && <Ligne label="Prix souhaité" value={eur(t.disposal.desiredPriceCents)} muted />}
                    {t.disposed && <Ligne label="Prix réalisé" value={eur(t.disposal.realizedPriceCents)} />}
                    {t.disposal.feesCents > 0 && <Ligne label="Frais de cession (inclus dans les coûts)" value={eur(t.disposal.feesCents)} muted />}
                    {t.disposal.resultKind === 'FINAL' && <Ligne label="Résultat définitif (coût net final)" value={eur(t.summary.netFinalCents)} strong />}
                    {t.disposal.resultKind === 'PROVISIONAL' && <Ligne label="Simulation provisoire au prix souhaité" value={eur(t.disposal.provisionalNetCents)} />}
                  </div>
                  {t.disposal.resultKind === 'PROVISIONAL' && <p className="text-xs text-muted-foreground">Simulation : le prix souhaité n’est pas un prix de vente réalisé.</p>}
                </Bloc>
              )}

              {/* ── Budget d'usage ── */}
              <Bloc title="Budget d’usage (estimation)" data-tco-usage>
                <p className="text-xs text-muted-foreground">Forfaits estimés, distincts des coûts réels : ils ne sont jamais ajoutés au coût cumulé.</p>
                <div className="divide-y divide-border">
                  {t.usage.items.map((b) => (
                    <div key={b.id} className="py-2 flex items-start justify-between gap-3 text-sm">
                      <div className="min-w-0">
                        <p className="text-[color:var(--text-primary)]">{b.label || catLabels[b.category]}</p>
                        <p className="text-xs text-muted-foreground">
                          {minor(b.amountMinor, b.currency)} {perLabels[b.periodicity]}
                          {b.validFrom || b.validTo ? ` · ${b.validFrom ? `du ${dateFr(b.validFrom)}` : ''}${b.validTo ? ` au ${dateFr(b.validTo)}` : ''}` : ''}
                          {!b.activeNow ? ' · hors validité' : ''}
                        </p>
                      </div>
                      {canEdit && (
                        <div className="flex shrink-0 gap-1">
                          <Button variant="ghost" size="sm" aria-label="Modifier le forfait" onClick={() => setForm({ id: b.id, category: b.category, label: b.label ?? '', amount: formatNumberForInput(b.amountMinor / 100), periodicity: b.periodicity, validFrom: b.validFrom, validTo: b.validTo })}><Pencil className="w-3.5 h-3.5" /></Button>
                          <Button variant="ghost" size="sm" aria-label="Supprimer le forfait" onClick={() => removeBudget(b.id)}><Trash2 className="w-3.5 h-3.5" /></Button>
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
                  <div className="rounded-lg border border-border p-4 space-y-3" data-tco-budget-form>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">Objet</Label>
                      <Select value={form.category} onValueChange={(v) => setForm({ ...form, category: v })}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>{(Object.keys(catLabels) as Array<keyof typeof catLabels>).map((c) => <SelectItem key={c} value={c}>{catLabels[c]}</SelectItem>)}</SelectContent>
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
                          <SelectContent>{(Object.keys(perLabels) as Array<keyof typeof perLabels>).map((p) => <SelectItem key={p} value={p}>{perLabels[p]}</SelectItem>)}</SelectContent>
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
              </Bloc>

              {/* ── Non retenues, non attribuées ── */}
              {ecartees.length > 0 && (
                <Bloc title={`Dépenses non retenues ou non attribuées (${ecartees.length})`} data-tco-excluded>
                  <div className="divide-y divide-border">{ecartees.map((l) => <LigneDepense key={l.id} l={l} t={t} />)}</div>
                </Bloc>
              )}

              {/* ── Alertes ── */}
              {(t.warningLabels.length > 0 || t.reliability.unconverted.length > 0) && (
                <Bloc title="Alertes de couverture" data-tco-warnings>
                  {t.warningLabels.map((w) => <p key={w} className="text-xs text-[color:var(--attention-on-soft)]">{w}</p>)}
                  {t.reliability.unconverted.length > 0 && (
                    <p className="text-xs text-muted-foreground">Non converti : {t.reliability.unconverted.map((u) => minor(u.amountMinor, u.currency)).join(', ')}.</p>
                  )}
                </Bloc>
              )}
              <p className="text-xs text-muted-foreground">Ce total est calculé : pour le corriger, modifiez le prix d’achat de la fiche ou le document concerné.</p>
            </>
          )}
        </div>
      )}

      {/* ── Lot 76G : sous-tiroir « Dépenses retenues » (à droite ; pleine largeur sur mobile) ── */}
      {t && (
        <Sheet open={retainedOpen} onOpenChange={setRetainedOpen}>
          <SheetContent side="right" id="tco-retained-drawer" className="w-full sm:max-w-lg flex flex-col gap-0 p-0" data-tco-retained-drawer>
            <SheetHeader className="px-5 pt-5 pb-3 border-b border-border">
              <button
                type="button"
                onClick={() => setRetainedOpen(false)}
                className="inline-flex min-h-[44px] md:min-h-[36px] items-center gap-1.5 self-start text-sm text-muted-foreground hover:text-[color:var(--text-primary)]"
                data-tco-retained-back
              >
                <ArrowLeft className="w-4 h-4" aria-hidden /> Coût total de possession
              </button>
              <SheetTitle>{`Dépenses retenues (${depensesFiltrees.length}${t.linesTruncated ? ' · liste abrégée' : ''})`}</SheetTitle>
              <SheetDescription>
                {retainedFilter === 'YEAR' && anneeCourante
                  ? `Dépenses datées de ${anneeCourante.year} : ${eur(anneeCourante.costsCents)} (${anneeCourante.count} dépense(s)).`
                  : `Toutes les dépenses retenues dans le coût cumulé (${eur(t.summary.cumulativeCostCents)}).`}
              </SheetDescription>
              {anneeCourante && (
                <div className="flex flex-wrap gap-2 pt-1" role="group" aria-label="Période des dépenses" data-tco-retained-filter>
                  {([['ALL', 'Toutes les années'], ['YEAR', `Année ${anneeCourante.year}`]] as const).map(([v, label]) => (
                    <Button key={v} type="button" size="sm" variant={retainedFilter === v ? 'default' : 'outline'} aria-pressed={retainedFilter === v}
                      onClick={() => setRetainedFilter(v)} data-tco-retained-filter-option={v}>
                      {label}
                    </Button>
                  ))}
                </div>
              )}
            </SheetHeader>
            <div className="flex-1 overflow-y-auto px-5 py-3">
              <div className="divide-y divide-border">
                {depensesFiltrees.length === 0 && (
                  <p className="text-sm text-muted-foreground py-1.5">{retainedFilter === 'YEAR' ? 'Aucune dépense retenue datée de cette année.' : 'Aucune dépense retenue.'}</p>
                )}
                {depensesFiltrees.map((l) => <LigneDepense key={l.id} l={l} t={t} />)}
              </div>
              {retainedFilter === 'YEAR' && annual && annual.undated.count > 0 && (
                <p className="text-xs text-muted-foreground pt-2">Les dépenses sans date ne sont rattachées à aucune année : choisissez « Toutes les années » pour les voir.</p>
              )}
              {t.linesTruncated && restantes > 0 && (
                <div className="pt-3 space-y-2">
                  <p className="text-xs text-muted-foreground">Liste abrégée : {affichees} ligne(s) présentée(s) sur {t.linesTotal}. Les totaux portent sur toutes les lignes.</p>
                  <Button variant="outline" size="sm" className="w-full sm:w-auto" onClick={() => void loadMore()} disabled={loadingMore}>
                    {loadingMore && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}Afficher les lignes suivantes ({restantes})
                  </Button>
                </div>
              )}
            </div>
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}
