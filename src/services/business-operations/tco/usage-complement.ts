/**
 * Lot 108C (ticket TCO-646 §E) — DÉPENSES D'USAGE : le forfait est une
 * ESTIMATION COMPLÉMENTAIRE des dépenses réelles. PUR (aucun accès base),
 * appelé par `computeTco` après les totaux documentés.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * RÈGLE (décision PO, remplace #445 / #474 « forfaits hors coût réalisé »)
 *
 * Pour chaque bien × catégorie d'usage × période de calcul ÉCHUE :
 *   R = somme NETTE des dépenses réelles RETENUES par le moteur (donc déjà
 *       dédoublonnées, acomptes et doublons écartés) de cette catégorie,
 *       datées dans la période ;
 *   F = forfait applicable à la période : montant × jours couverts / jours
 *       de la période (prorata explicite : dates d'effet / de fin du
 *       forfait, acquisition, cession) ;
 *   complément estimé = max(0, F − max(0, R)) ;
 *   contribution au TCO = R + complément = max(F, R) (R ≥ 0).
 * Le coût DOCUMENTÉ (`summary.cumulativeCostCents`) reste strictement réel ;
 * le TCO avec estimations = documenté + Σ compléments. Aucune Opération,
 * aucun ticket modifié : le rapprochement est catégoriel et temporel.
 *
 * PÉRIODE DE CALCUL : la période CIVILE de la périodicité du forfait (mois,
 * trimestre, année), bornée par les dates d'effet et la possession. Elle ne
 * compte qu'ÉCHUE : son dernier jour civil est passé (ou la possession a
 * pris fin par la cession). La période en cours est montrée « en cours »,
 * jamais ajoutée ; aucun mois futur, aucun budget prévisionnel au total.
 *
 * CATÉGORIE D'UNE DÉPENSE RÉELLE (jamais devinée au hasard) :
 *   1. classement de l'utilisateur (table `asset_usage_line_assignments`,
 *      clé stable de la ligne `tcoLineKeys`) — y compris « pas une dépense
 *      d'usage » ; prioritaire ;
 *   2. sinon, vocabulaire EXPLICITE du libellé (carburant, péage, recharge
 *      électrique… `USAGE_LEXICON`) pour une dépense de poste « usage » ou
 *      « autres » seulement, et un seul vocabulaire reconnu ; deux catégories
 *      reconnues → ambiguë, non classée ;
 *   3. sinon : non classée (proposée au classement quand un forfait existe).
 * « Autre dépense d'usage » n'est jamais reconnue automatiquement : seul le
 * classement de l'utilisateur la rapproche d'un forfait « Autre ».
 *
 * CHEVAUCHEMENTS : deux forfaits de même catégorie (et, pour « Autre », de
 * même libellé) actifs le même jour sont un CONFLIT explicite (refusé à la
 * saisie ; données antérieures : le forfait à la date d'effet la plus récente
 * — puis le plus récemment créé — s'applique sur les jours communs, signalé).
 * Révisions : une modification de montant crée une nouvelle version datée
 * (`revisesBudgetId`), les périodes closes gardent l'ancien montant.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { daysInclusive, isIsoDate } from '../finance/engine';
import type { TcoCategory, TcoEconomicLine, UsageBudget } from './model';
import { tcoLineKeys } from './user-decisions';
import { annualizeCents, type TcoOwnershipDuration } from './annual';

type UsageCategory = UsageBudget['category'];
type Periodicity = UsageBudget['periodicity'];

// ── Paramètres centralisés ─────────────────────────────────────────────────

/** Paramètres de la règle (aucune valeur en dur ailleurs). */
export const USAGE_COMPLEMENT_PARAMS = {
  /** Nombre maximal de périodes calculées par catégorie (les plus récentes) — 50 ans de mois. */
  maxWindowsPerKey: 600,
  /** Postes TCO dont le libellé peut désigner une catégorie d'usage (jamais un achat, un financement, un sinistre…). */
  lexicalCategories: ['USAGE', 'OTHER'] as readonly TcoCategory[],
  /** Postes TCO qu'un classement utilisateur ne peut pas rapprocher d'un forfait (un achat n'est pas une dépense d'usage). */
  nonAssignableCategories: ['ACQUISITION', 'DISPOSAL', 'FINANCING'] as readonly TcoCategory[],
  /** Nombre maximal de dépenses non classées proposées au classement. */
  maxUnclassified: 50,
} as const;

/**
 * Vocabulaire EXPLICITE d'une catégorie d'usage (texte normalisé : sans
 * accents, minuscules). Une marque, un fournisseur ou un montant ne désignent
 * jamais une catégorie. « OTHER » : aucun vocabulaire (classement utilisateur).
 */
export const USAGE_LEXICON: Readonly<Record<Exclude<UsageCategory, 'OTHER'>, RegExp>> = {
  FUEL: /\b(carburants?|essence|gazole|gasoil|gas-oil|diesel|sans[ -]plomb|sp ?95|sp ?98|superethanol|bioethanol|gpl)\b/,
  CHARGING: /\b(recharges? (electriques?|vehicule|ve)|bornes? de recharge|sessions? de recharge|charge electrique|recharge rapide)\b/,
  TOLLS: /\b(peages?|telepeage|autoroutes?)\b/,
};

// ── Entrées ────────────────────────────────────────────────────────────────

/** Classement d'une dépense réelle par l'utilisateur (table `asset_usage_line_assignments`). */
export interface UsageLineAssignment {
  key: string;
  /** NONE : « pas une dépense d'usage » (jamais rapprochée d'un forfait). */
  category: UsageCategory | 'NONE';
  /** Pour OTHER : libellé du forfait « Autre » visé (clé `OTHER:<libellé normalisé>`). */
  otherLabel: string | null;
  decidedAt: string;
  decidedByUserId: number | null;
}

export interface UsageComplementInput {
  budgets: readonly UsageBudget[];
  lines: readonly TcoEconomicLine[];
  assignments?: readonly UsageLineAssignment[];
  /** Possession : début (date d'achat / début de possession établie, sinon null), fin (aujourd'hui ou cession). */
  possession: { start: string | null; end: string; disposed: boolean };
  today: string;
  /** Coût cumulé documenté (strictement réel). */
  documentedCents: number;
  /** Jours de possession de la moyenne annuelle (null : moyenne non calculée). */
  averageDays: number | null;
  /** Lot 111F : durée de possession en années anniversaires (même diviseur que le coût annuel moyen documenté). */
  averageDuration?: TcoOwnershipDuration | null;
  /**
   * Lot 111F : prix d'acquisition du bien retiré de la moyenne annuelle avec
   * estimations (même base que le coût annuel moyen documenté) ; null : moyenne
   * non calculée.
   */
  averageExcludedCents?: number | null;
  net: { estimatedCents: number | null; finalCents: number | null; provisionalCents: number | null };
}

// ── Sortie ─────────────────────────────────────────────────────────────────

export type UsageComplementWarning =
  | 'USAGE_ESTIMATES_INCLUDED' | 'USAGE_BUDGET_OVERLAP' | 'USAGE_START_UNKNOWN' | 'USAGE_LINES_UNCLASSIFIED'
  | 'USAGE_LINES_UNDATED' | 'USAGE_NOT_CONVERTIBLE' | 'USAGE_WINDOWS_TRUNCATED';

export const USAGE_COMPLEMENT_WARNING_LABELS: Readonly<Record<UsageComplementWarning, string>> = {
  USAGE_ESTIMATES_INCLUDED: 'Le TCO complet inclut des estimations de dépenses d’usage pour les périodes sans justificatif suffisant : ce ne sont ni des factures ni des preuves de paiement.',
  USAGE_BUDGET_OVERLAP: 'Deux forfaits de même catégorie couvrent les mêmes jours : seul le plus récent est appliqué sur ces jours. Terminez ou modifiez l’un des deux.',
  USAGE_START_UNKNOWN: 'Un forfait sans date de début ne peut pas être estimé tant que la date d’achat du bien n’est pas connue : indiquez sa date de début.',
  USAGE_LINES_UNCLASSIFIED: 'Des dépenses pourraient être des dépenses d’usage sans catégorie certaine : classez-les pour qu’elles remplacent l’estimation correspondante.',
  USAGE_LINES_UNDATED: 'Des dépenses d’usage n’ont pas de date établie : elles sont comptées dans le coût réel mais ne réduisent l’estimation d’aucune période.',
  USAGE_NOT_CONVERTIBLE: 'Des forfaits dans une autre devise que l’euro ne sont pas ajoutés au TCO en euros.',
  USAGE_WINDOWS_TRUNCATED: 'Historique de forfait très long : seules les périodes les plus récentes sont estimées.',
};

/** Fondement de la catégorie d'une dépense réelle. */
type UsageLineBasis = 'USER' | 'LEXICAL';

interface UsageMatchedLine {
  lineId: string;
  decisionKey: string;
  label: string;
  date: string | null;
  /** Montant retenu signé (coût +, avoir / remboursement −), centimes EUR. */
  cents: number;
  fileId: number | null;
  operationId: number | null;
  basis: UsageLineBasis;
}

interface UsageWindow {
  key: string;
  category: UsageCategory;
  label: string;
  periodicity: Periodicity;
  /** Période civile (mois, trimestre, année). */
  periodStart: string;
  periodEnd: string;
  /** Jours effectivement couverts (dates d'effet, possession). */
  start: string;
  end: string;
  coveredDays: number;
  periodDays: number;
  prorated: boolean;
  budgetIds: number[];
  /** Part du forfait applicable portée par chaque forfait (révision en cours de période). */
  budgetParts: Array<{ budgetId: number; forfaitCents: number }>;
  /** F : forfait applicable (centimes EUR, après prorata). */
  forfaitCents: number;
  /** R : réel net retenu de la catégorie dans la période. */
  realCents: number;
  /** max(0, F − max(0, R)). */
  complementCents: number;
  /** R + complément. */
  contributionCents: number;
  lines: UsageMatchedLine[];
  /** Période échue (comptée) ; faux : en cours (montrée, jamais ajoutée). */
  closed: boolean;
}

type UsageBudgetStatus = 'APPLIED' | 'IN_PROGRESS' | 'NOT_STARTED' | 'ENDED_BEFORE_POSSESSION' | 'START_UNKNOWN' | 'NOT_CONVERTIBLE' | 'OVERRIDDEN';

export const USAGE_BUDGET_STATUS_LABELS: Readonly<Record<UsageBudgetStatus, string>> = {
  APPLIED: 'Appliqué aux périodes écoulées',
  IN_PROGRESS: 'Période en cours (estimée à sa fin)',
  NOT_STARTED: 'Commence plus tard',
  ENDED_BEFORE_POSSESSION: 'Hors de la période de possession',
  START_UNKNOWN: 'Date de début à indiquer',
  NOT_CONVERTIBLE: 'Autre devise : non ajouté en euros',
  OVERRIDDEN: 'Remplacé par un autre forfait sur toute sa période',
};

interface UsageBudgetState {
  budgetId: number;
  key: string;
  status: UsageBudgetStatus;
  /** Forfaits en conflit (mêmes jours, même catégorie). */
  overlapWith: number[];
  /** Version suivante (révision datée) de ce forfait. */
  revisedBy: number | null;
  /** Σ des compléments estimés que ce forfait a produits (périodes échues). */
  complementCents: number;
}

export interface UsageComplement {
  /** Coût réel documenté (inchangé). */
  documentedCents: number;
  /** Σ des compléments estimés des périodes échues. */
  estimatedComplementCents: number;
  /** TCO cumulé intégrant les estimations. */
  totalWithEstimatesCents: number;
  /** Réel retenu rapproché d'un forfait (périodes échues). */
  matchedRealCents: number;
  /** Σ des forfaits applicables (périodes échues). */
  forfaitCents: number;
  /** Coût annuel moyen de possession avec estimations, prix d'achat du bien exclu (lot 111F ; null : non calculé). */
  averageWithEstimatesCents: number | null;
  /** Coûts nets avec estimations (null : non calculables). */
  netEstimatedWithEstimatesCents: number | null;
  netFinalWithEstimatesCents: number | null;
  provisionalNetWithEstimatesCents: number | null;
  /** Périodes échues (comptées), puis période en cours par catégorie — les plus récentes d'abord. */
  windows: UsageWindow[];
  /** Ventilation par catégorie (périodes échues). */
  byCategory: Array<{ key: string; category: UsageCategory; label: string; periods: number; forfaitCents: number; realCents: number; complementCents: number; contributionCents: number }>;
  /** Compléments par année civile (année de la période). */
  byYear: Array<{ year: number; complementCents: number; forfaitCents: number; realCents: number }>;
  budgets: UsageBudgetState[];
  /** Dépenses réelles de poste « usage » ou « autres » sans catégorie d'usage certaine (forfait existant). */
  unclassified: Array<{ lineId: string; decisionKey: string; label: string; date: string | null; cents: number; fileId: number | null; ambiguous: UsageCategory[] }>;
  /** Dépenses d'usage classées sans date (aucune période). */
  undated: Array<{ lineId: string; key: string; cents: number; label: string }>;
  warnings: UsageComplementWarning[];
}

// ── Dates ──────────────────────────────────────────────────────────────────

const jour = (d: string) => d.slice(0, 10);
function addDays(d: string, n: number): string {
  const t = new Date(`${jour(d)}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
const pad = (n: number) => String(n).padStart(2, '0');
function lastDayOfMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
/** Période civile de la périodicité contenant `d` (pure). */
export function calendarPeriod(d: string, p: Periodicity): { start: string; end: string } {
  const y = Number(d.slice(0, 4));
  const m = Number(d.slice(5, 7));
  if (p === 'YEARLY') return { start: `${y}-01-01`, end: `${y}-12-31` };
  const m0 = p === 'QUARTERLY' ? Math.floor((m - 1) / 3) * 3 + 1 : m;
  const m1 = p === 'QUARTERLY' ? m0 + 2 : m0;
  return { start: `${y}-${pad(m0)}-01`, end: `${y}-${pad(m1)}-${pad(lastDayOfMonth(y, m1))}` };
}
const maxD = (a: string, b: string) => (a > b ? a : b);
const minD = (a: string, b: string) => (a < b ? a : b);

type Interval = { from: string; to: string };
/** `a` privé des jours de `b` (pure). */
function subtract(a: readonly Interval[], b: Interval): Interval[] {
  const out: Interval[] = [];
  for (const x of a) {
    if (b.to < x.from || b.from > x.to) { out.push(x); continue; }
    if (b.from > x.from) out.push({ from: x.from, to: addDays(b.from, -1) });
    if (b.to < x.to) out.push({ from: addDays(b.to, 1), to: x.to });
  }
  return out;
}

// ── Clés et classement ─────────────────────────────────────────────────────

const normaliser = (s: string | null | undefined) => (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Clé de rapprochement d'un forfait : catégorie ; « Autre » : catégorie + libellé normalisé (pure). */
export function usageKeyOf(category: UsageCategory, label: string | null | undefined): string {
  return category === 'OTHER' ? `OTHER:${normaliser(label)}` : category;
}

/** Catégories d'usage désignées EXPLICITEMENT par un libellé (pure). */
export function usageCategoriesOfText(text: string): UsageCategory[] {
  const t = normaliser(text);
  return (Object.keys(USAGE_LEXICON) as Array<keyof typeof USAGE_LEXICON>).filter((c) => USAGE_LEXICON[c].test(t));
}

const RETENUE = (s: string) => s === 'RETAINED_DIRECT' || s === 'RETAINED_CONSOLIDATED';
const CREDIT = new Set(['REDUCTION', 'REFUND']);

/** Une dépense retenue peut-elle être classée en dépense d'usage par l'utilisateur ? (pure) */
export function usageLineAssignable(l: Pick<TcoEconomicLine, 'status' | 'kind' | 'category' | 'includedCents'>): boolean {
  if (!RETENUE(l.status) || !l.kind || !(l.kind === 'REALIZED_COST' || CREDIT.has(l.kind))) return false;
  return !(l.category && USAGE_COMPLEMENT_PARAMS.nonAssignableCategories.includes(l.category));
}

interface Classified { line: TcoEconomicLine; key: string | null; category: UsageCategory | null; basis: UsageLineBasis | null; ambiguous: UsageCategory[]; excludedByUser: boolean }

function classify(lines: readonly TcoEconomicLine[], assignments: readonly UsageLineAssignment[]): Classified[] {
  // La plus récente l'emporte (même règle que les décisions « Ajouter / Retirer »).
  const parCle = new Map<string, UsageLineAssignment>();
  for (const a of [...assignments].sort((x, y) => y.decidedAt.localeCompare(x.decidedAt))) if (!parCle.has(a.key)) parCle.set(a.key, a);
  const vues = new Set<string>();
  const out: Classified[] = [];
  for (const l of lines) {
    if (vues.has(l.id) || !usageLineAssignable(l) || !l.includedCents) continue;
    vues.add(l.id);
    const k = tcoLineKeys(l);
    const a = parCle.get(k.primary) ?? k.secondary.map((s) => parCle.get(s)).find(Boolean);
    if (a) {
      if (a.category === 'NONE') { out.push({ line: l, key: null, category: null, basis: 'USER', ambiguous: [], excludedByUser: true }); continue; }
      out.push({ line: l, key: usageKeyOf(a.category, a.otherLabel), category: a.category, basis: 'USER', ambiguous: [], excludedByUser: false });
      continue;
    }
    if (!l.category || !USAGE_COMPLEMENT_PARAMS.lexicalCategories.includes(l.category)) continue;
    const cats = usageCategoriesOfText(`${l.label} ${l.operationLabel ?? ''}`);
    if (cats.length === 1) out.push({ line: l, key: cats[0], category: cats[0], basis: 'LEXICAL', ambiguous: [], excludedByUser: false });
    else out.push({ line: l, key: null, category: null, basis: null, ambiguous: cats, excludedByUser: false });
  }
  return out;
}

// ── Calcul ─────────────────────────────────────────────────────────────────

/** Complément estimé des dépenses d'usage (pure, testée L108C-*). */
export function computeUsageComplement(input: UsageComplementInput): UsageComplement {
  const today = jour(input.today);
  const warnings = new Set<UsageComplementWarning>();
  const pStart = isIsoDate(input.possession.start) && jour(input.possession.start) <= today ? jour(input.possession.start) : null;
  const pEnd = minD(jour(input.possession.end), today);
  const states = new Map<number, UsageBudgetState>();

  // Révisions : version suivante de chaque forfait.
  const revisedBy = new Map<number, number>();
  for (const b of input.budgets) if (b.revisesBudgetId != null) revisedBy.set(b.revisesBudgetId, b.id);

  // Intervalle brut de chaque forfait EUR, borné par la possession.
  const parCle = new Map<string, Array<{ b: UsageBudget; raw: Interval | null; prio: string }>>();
  for (const b of input.budgets) {
    const key = usageKeyOf(b.category, b.label);
    const st: UsageBudgetState = { budgetId: b.id, key, status: 'APPLIED', overlapWith: [], revisedBy: revisedBy.get(b.id) ?? null, complementCents: 0 };
    states.set(b.id, st);
    if (b.currency !== 'EUR') { st.status = 'NOT_CONVERTIBLE'; warnings.add('USAGE_NOT_CONVERTIBLE'); continue; }
    const vf = isIsoDate(b.validFrom) ? jour(b.validFrom) : null;
    const vt = isIsoDate(b.validTo) ? jour(b.validTo) : null;
    let raw: Interval | null = null;
    if (vf && vf > today) st.status = 'NOT_STARTED';
    else {
      const from = vf && pStart ? maxD(vf, pStart) : vf ?? pStart;
      if (!from) { st.status = 'START_UNKNOWN'; warnings.add('USAGE_START_UNKNOWN'); }
      else {
        const to = vt ? minD(vt, pEnd) : pEnd;
        if (to < from) st.status = 'ENDED_BEFORE_POSSESSION';
        else raw = { from, to };
      }
    }
    parCle.set(key, [...(parCle.get(key) ?? []), { b, raw, prio: `${vf ?? '0000-00-00'}#${String(b.id).padStart(12, '0')}` }]);
  }

  // Chevauchements : sur les jours communs, la date d'effet la plus récente (puis le plus récent) s'applique.
  const effectifs = new Map<number, Interval[]>();
  for (const groupe of parCle.values()) {
    const tri = [...groupe].filter((x) => x.raw).sort((a, b) => b.prio.localeCompare(a.prio));
    const pris: Array<{ id: number; iv: Interval }> = [];
    for (const x of tri) {
      let reste: Interval[] = [x.raw!];
      for (const p of pris) {
        const avant = reste.reduce((n, i) => n + daysInclusive(i.from, i.to), 0);
        reste = subtract(reste, p.iv);
        const apres = reste.reduce((n, i) => n + daysInclusive(i.from, i.to), 0);
        if (apres < avant) {
          // Une révision datée ne chevauche jamais sa version précédente ; tout autre recouvrement est un conflit.
          states.get(x.b.id)!.overlapWith.push(p.id);
          states.get(p.id)!.overlapWith.push(x.b.id);
          warnings.add('USAGE_BUDGET_OVERLAP');
        }
      }
      pris.push({ id: x.b.id, iv: x.raw! });
      if (!reste.length) states.get(x.b.id)!.status = 'OVERRIDDEN';
      effectifs.set(x.b.id, reste);
    }
  }

  // Fenêtres : période civile ∩ jours effectifs, fusionnées par catégorie et période.
  const fenetres = new Map<string, UsageWindow>();
  const budgetsById = new Map(input.budgets.map((b) => [b.id, b]));
  for (const [id, ivs] of effectifs) {
    const b = budgetsById.get(id)!;
    const key = usageKeyOf(b.category, b.label);
    for (const iv of ivs) {
      let c = iv.from;
      while (c <= iv.to) {
        const p = calendarPeriod(c, b.periodicity);
        const ws = maxD(p.start, iv.from);
        const we = minD(p.end, iv.to);
        const periodDays = daysInclusive(p.start, p.end);
        const days = daysInclusive(ws, we);
        const f = Math.round((b.amountMinor * days) / periodDays);
        const closed = p.end < today || (input.possession.disposed && we >= pEnd);
        const k = `${key}|${p.start}|${p.end}`;
        const w = fenetres.get(k);
        if (w) {
          w.start = minD(w.start, ws); w.end = maxD(w.end, we); w.coveredDays += days; w.forfaitCents += f; w.budgetIds.push(id); w.budgetParts.push({ budgetId: id, forfaitCents: f });
          w.prorated = w.coveredDays < w.periodDays; w.closed = w.closed || closed;
        } else {
          fenetres.set(k, {
            key, category: b.category, label: b.label ?? '', periodicity: b.periodicity, periodStart: p.start, periodEnd: p.end, start: ws, end: we,
            coveredDays: days, periodDays, prorated: days < periodDays, budgetIds: [id], budgetParts: [{ budgetId: id, forfaitCents: f }], forfaitCents: f, realCents: 0, complementCents: 0, contributionCents: 0, lines: [], closed,
          });
        }
        c = addDays(p.end, 1);
      }
    }
  }
  // Garde-fou de volume : les périodes les plus récentes par catégorie.
  let windows = [...fenetres.values()].sort((a, b) => b.periodStart.localeCompare(a.periodStart) || a.key.localeCompare(b.key));
  const parCleCompte = new Map<string, number>();
  windows = windows.filter((w) => {
    const n = (parCleCompte.get(w.key) ?? 0) + 1;
    parCleCompte.set(w.key, n);
    if (n > USAGE_COMPLEMENT_PARAMS.maxWindowsPerKey) { warnings.add('USAGE_WINDOWS_TRUNCATED'); return false; }
    return true;
  });

  // Dépenses réelles classées → fenêtre de même catégorie contenant leur date.
  const classees = classify(input.lines, input.assignments ?? []);
  const clesForfait = new Set(windows.map((w) => w.key));
  const undated: UsageComplement['undated'] = [];
  for (const c of classees) {
    if (!c.key) continue;
    const l = c.line;
    const signe = l.kind && CREDIT.has(l.kind) ? -1 : 1;
    const cents = signe * l.includedCents;
    const d = isIsoDate(l.date) && jour(l.date) <= today ? jour(l.date) : null;
    if (!d) {
      if (clesForfait.has(c.key)) { undated.push({ lineId: l.id, key: c.key, cents, label: l.label }); warnings.add('USAGE_LINES_UNDATED'); }
      continue;
    }
    const w = windows.find((x) => x.key === c.key && x.start <= d && d <= x.end);
    if (!w) continue; // hors de toute période de forfait : coût réel seul
    w.realCents += cents;
    w.lines.push({ lineId: l.id, decisionKey: l.decisionKey ?? tcoLineKeys(l).primary, label: l.label, date: d, cents, fileId: l.fileId, operationId: l.operationId, basis: c.basis! });
  }

  const byCat = new Map<string, UsageComplement['byCategory'][number]>();
  const byYear = new Map<number, UsageComplement['byYear'][number]>();
  let complement = 0;
  let forfait = 0;
  let reel = 0;
  for (const w of windows) {
    w.complementCents = Math.max(0, w.forfaitCents - Math.max(0, w.realCents));
    w.contributionCents = w.realCents + w.complementCents;
    if (!w.closed) continue;
    complement += w.complementCents; forfait += w.forfaitCents; reel += w.realCents;
    const c = byCat.get(w.key) ?? { key: w.key, category: w.category, label: w.label, periods: 0, forfaitCents: 0, realCents: 0, complementCents: 0, contributionCents: 0 };
    c.periods += 1; c.forfaitCents += w.forfaitCents; c.realCents += w.realCents; c.complementCents += w.complementCents; c.contributionCents += w.contributionCents;
    byCat.set(w.key, c);
    const y = Number(w.periodEnd.slice(0, 4));
    const a = byYear.get(y) ?? { year: y, complementCents: 0, forfaitCents: 0, realCents: 0 };
    a.complementCents += w.complementCents; a.forfaitCents += w.forfaitCents; a.realCents += w.realCents;
    byYear.set(y, a);
    // Part de complément de chaque forfait de la fenêtre, au prorata de son forfait (le reste d'arrondi au dernier).
    let reste = w.complementCents;
    w.budgetParts.forEach((p, i) => {
      const part = i === w.budgetParts.length - 1 ? reste : Math.round((w.complementCents * p.forfaitCents) / Math.max(1, w.forfaitCents));
      reste -= part;
      states.get(p.budgetId)!.complementCents += part;
    });
  }
  // Statut : période en cours seulement.
  for (const st of states.values()) {
    if (st.status !== 'APPLIED') continue;
    const ws = windows.filter((w) => w.budgetIds.includes(st.budgetId));
    if (ws.length && ws.every((w) => !w.closed)) st.status = 'IN_PROGRESS';
  }

  // Dépenses à classer : seulement si un forfait EUR existe (sinon la catégorie n'a aucun effet).
  const unclassified = clesForfait.size
    ? classees.filter((c) => !c.key && !c.excludedByUser).slice(0, USAGE_COMPLEMENT_PARAMS.maxUnclassified).map((c) => ({
      lineId: c.line.id, decisionKey: c.line.decisionKey ?? tcoLineKeys(c.line).primary, label: c.line.label, date: c.line.date,
      cents: (c.line.kind && CREDIT.has(c.line.kind) ? -1 : 1) * c.line.includedCents, fileId: c.line.fileId, ambiguous: c.ambiguous,
    }))
    : [];
  if (unclassified.length) warnings.add('USAGE_LINES_UNCLASSIFIED');
  if (complement > 0) warnings.add('USAGE_ESTIMATES_INCLUDED');

  const total = input.documentedCents + complement;
  const plus = (v: number | null) => (v == null ? null : v + complement);
  // Périodes en cours d'abord (montrées, non comptées), puis échues de la plus récente à la plus ancienne.
  windows.sort((a, b) => Number(a.closed) - Number(b.closed) || b.periodStart.localeCompare(a.periodStart) || a.key.localeCompare(b.key));
  return {
    documentedCents: input.documentedCents,
    estimatedComplementCents: complement,
    totalWithEstimatesCents: total,
    matchedRealCents: reel,
    forfaitCents: forfait,
    // Lot 111F : même base hors prix d'acquisition du bien que le coût annuel moyen documenté (jamais l'achat annualisé).
    averageWithEstimatesCents: input.averageDuration && input.averageExcludedCents != null
      ? annualizeCents(total - input.averageExcludedCents, input.averageDuration) : null,
    netEstimatedWithEstimatesCents: plus(input.net.estimatedCents),
    netFinalWithEstimatesCents: plus(input.net.finalCents),
    provisionalNetWithEstimatesCents: plus(input.net.provisionalCents),
    windows,
    byCategory: [...byCat.values()],
    byYear: [...byYear.values()].sort((a, b) => a.year - b.year),
    budgets: [...states.values()],
    unclassified,
    undated,
    warnings: [...warnings],
  };
}
