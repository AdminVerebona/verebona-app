/**
 * Lot 113X — carte #722 « [P2][Post-MEP] TCO — Supprimer l'alerte de dates en
 * doublon et permettre de renseigner les dates ». PUR (aucun import serveur) :
 * utilisé par le DTO (serveur), par le service d'écriture et par l'interface.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE SEULE INFORMATION, CALCULÉE PAR LE MOTEUR
 *
 * La liste des « dépenses sans date fiable » est EXACTEMENT le compartiment
 * « sans année » des indicateurs annuels (`annual.undated`, `tco/annual.ts`) :
 * lignes économiques DISTINCTES retenues par le moteur, coûts réalisés,
 * rattachées à aucune année (`annualYear === null`). Nombre et montant sont
 * donc ceux de la ventilation annuelle (jamais un décompte de justificatifs,
 * jamais un second calcul) ; le coût total n'est pas touché.
 *
 * OÙ SE SAISIT LA DATE (jamais une date propre au TCO)
 *
 * Pour chaque ligne, le CHAMP MÉTIER CANONIQUE déjà établi par le moteur :
 *   · `ASSET_FIELD`     — date d'achat de la fiche du bien (prix de la fiche,
 *                         ou achat consolidé depuis la fiche : `dateEntry` 113N) ;
 *   · `EQUIPMENT_FIELD` — date d'achat de la fiche de l'équipement (prix de la
 *                         fiche de l'équipement) ;
 *   · `DOCUMENT`        — date du justificatif UNIQUE qui établit le montant,
 *                         aujourd'hui absente (`dateEntry` 113N : jamais un
 *                         devis, une preuve de règlement, un échéancier) ;
 *   · `NONE`            — aucun champ qui daterait CETTE dépense sans
 *                         l'inventer (contrat à périodes, justificatifs
 *                         contradictoires, plusieurs justificatifs…) : la
 *                         correction se fait sur l'événement de référence ou
 *                         le justificatif ; « Conserver dans le TCO sans
 *                         date » (#712) reste possible.
 * Seules des dépenses RETENUES et RÉALISÉES figurent ici : un devis ou une
 * dépense prévue n'y est jamais, une date saisie ne transforme donc jamais une
 * prévision en dépense effective.
 *
 * Carte #769 — TROIS ISSUES DEPUIS LA MÊME DÉPENSE, TROIS QUANTITÉS DISTINCTES
 *
 *   · écart B : chaque dépense du panneau porte ses gestes du serveur —
 *     « Conserver dans le TCO sans date » / « Annuler mon choix » (date),
 *     la saisie de la date quand un champ métier existe, et « Retirer du
 *     TCO » (décision d'inclusion existante, réversible depuis « Dépenses
 *     non retenues » ; jamais un acquittement de la date) ;
 *   · écart C : `count` (dépenses sans date — couverture, stable tant que la
 *     date n'est pas établie ni la dépense retirée), `pendingCount`
 *     (confirmations de date encore attendues) et `confirmedCount`
 *     (confirmations déjà faites), calculés sur la trace COMPLÈTE du moteur,
 *     jamais sur la liste abrégée. Une confirmation n'est ni une nouvelle
 *     dépense ni une anomalie.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { isIsoDate } from '../finance/engine';
import type { TcoEconomicLine, TcoResult } from './model';
import type { TcoDiagnostics } from './diagnostics';
import { TCO_DATE_ACTIONS, tcoLineDecisionOptions, tcoLineUndated, type TcoDecisionOption } from './user-decisions';

/** Plus ancienne date de dépense acceptée (contrôle de plausibilité, paramètre centralisé). */
export const TCO_EXPENSE_DATE_MIN = '1900-01-01';
/** Nombre maximal de dépenses listées dans l'interface (le nombre et le montant restent exacts au-delà). */
export const TCO_UNDATED_MAX_ITEMS = 200;
/** Nombre maximal de dates enregistrées en une requête. */
export const TCO_UNDATED_MAX_ENTRIES = 100;
/** Code du point « date non établie » (lot 113N) : présenté par l'alerte unique, plus dans « Points à vérifier ». */
export const TCO_UNDATED_DIAGNOSTIC_CODE = 'ECONOMIC_DATE_UNDETERMINED';

/** Champ métier où se saisit la date de la dépense (calculé par le serveur, jamais par l'interface). */
export type TcoUndatedTarget =
  | { kind: 'ASSET_FIELD'; field: 'acquisitionDate' }
  | { kind: 'EQUIPMENT_FIELD'; field: 'acquisitionDate'; equipmentId: number }
  | { kind: 'DOCUMENT'; fileId: number }
  | { kind: 'NONE' };

/** Provenance affichée de la dépense. */
export type TcoUndatedOrigin = 'ASSET' | 'EQUIPMENT' | 'DOCUMENT' | 'OPERATION';

export interface TcoUndatedExpense {
  lineId: string;
  /** Carte #769 : clé du FAIT INDIVIDUEL (`factKey`), à défaut la clé stable de la ligne. */
  lineKey: string | null;
  /** Carte #769 : version des propriétés matérielles affichées (renvoyée avec chaque geste). */
  lineVersion: string | null;
  label: string;
  /** Montant RETENU dans le coût total (centimes EUR). */
  amountCents: number;
  category: TcoEconomicLine['category'];
  origin: TcoUndatedOrigin;
  operationId: number | null;
  operationLabel: string | null;
  /** Justificatifs sources (ouvrables depuis l'interface). */
  documents: Array<{ fileId: number; title: string | null }>;
  /** Date économique actuelle (null : inconnue ; une date future ou impossible n'est jamais retenue). */
  currentDate: string | null;
  /** Explication du moteur (pourquoi la date n'est pas établie), si elle existe. */
  note: string | null;
  target: TcoUndatedTarget;
  /** #712 : conservée sans date par l'utilisateur (point de décision clos). */
  confirmedUndated: boolean;
  /**
   * #712 : gestes de la date (« Conserver dans le TCO sans date » / « Annuler mon choix ») — serveur seulement.
   * Carte #769 (écart B) : et « Retirer du TCO » quand la dépense peut l'être (jamais confondu avec la date).
   */
  options: TcoDecisionOption[];
}

export interface TcoUndatedExpenses {
  /** Nombre de dépenses retenues sans date fiable (= `annual.undated.count`). */
  count: number;
  /** Montant retenu correspondant (= `annual.undated.costsCents`). */
  costsCents: number;
  /** Carte #769 : confirmations de date encore attendues (dépenses sans date ni choix « conserver sans date »). */
  pendingCount: number;
  /** Carte #769 : confirmations de date déjà faites (« Vos choix confirmés »). */
  confirmedCount: number;
  items: TcoUndatedExpense[];
  truncated: boolean;
}

/** Textes de l'interface. Ticket #722 repris à l'identique (pluriel) ; les autres : à valider par le PO (rapport 113X). */
export const TCO_UNDATED_TEXTS = {
  panelTitle: 'Dépenses sans date fiable',
  panelDescription: 'Renseignez la date effective des dépenses que vous connaissez. Vous pouvez laisser une dépense sans date : elle reste comptée dans le coût total.',
  field: 'Date effective de la dépense',
  currentDate: 'Date actuelle',
  noDate: 'Non renseignée',
  saveOne: 'Enregistrer',
  saveAll: (n: number) => `Enregistrer les dates (${n})`,
  close: 'Fermer',
  confirmDate: 'Confirmer cette date',
  reference: 'Voir l’événement de référence',
  // Carte #769 (écart C) — à valider par le PO.
  counters: (pending: number, confirmed: number): string =>
    `Conservation sans date : ${pending} choix à confirmer, ${confirmed} déjà ${confirmed > 1 ? 'confirmés' : 'confirmé'}.`,
  pendingBadge: 'Choix à confirmer',
  // Carte #769 (écart B) — à valider par le PO : retrait de plusieurs dépenses indissociables (même clé stable).
  removeShared: (n: number): string =>
    `Retirer du coût de possession les ${n} dépenses de même montant portées par ce justificatif ? Elles ne peuvent pas être retirées séparément. Vous pourrez les ajouter de nouveau.`,
  noField: 'Cette date ne se saisit pas ici : corrigez-la sur le justificatif ou sur l’événement de référence de la dépense.',
  savedOne: 'Date enregistrée',
  savedMany: (n: number) => `${n} dates enregistrées`,
  origins: {
    ASSET: 'Fiche du bien (date d’achat)',
    EQUIPMENT: 'Fiche de l’équipement (date d’achat)',
    DOCUMENT: 'Justificatif',
    OPERATION: 'Événement de référence',
  } satisfies Record<TcoUndatedOrigin, string>,
  targets: {
    ASSET_FIELD: 'La date sera enregistrée comme date d’achat sur la fiche du bien.',
    EQUIPMENT_FIELD: 'La date sera enregistrée comme date d’achat sur la fiche de l’équipement.',
    DOCUMENT: 'La date sera enregistrée comme date du justificatif.',
  },
} as const;

const fmtEur = (cents: number) => (cents / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });

/**
 * Alerte unique (texte du ticket à l'identique au pluriel ; singulier dérivé, à valider par le PO).
 * Aucun texte quand toutes les dépenses retenues sont datées (aucun état positif compensatoire).
 */
export function tcoUndatedMessage(count: number, costsCents: number, eur: (c: number) => string = fmtEur): string | null {
  if (!(count > 0)) return null;
  if (count === 1) return `1 dépense sans date fiable (${eur(costsCents)}). Elle est incluse dans le coût total mais n’est affectée à aucune année. Les montants annuels peuvent être incomplets.`;
  return `${count} dépenses sans date fiable (${eur(costsCents)}). Elles sont incluses dans le coût total mais ne sont affectées à aucune année. Les montants annuels peuvent être incomplets.`;
}

/** Libellé du bouton (texte du ticket). */
export const tcoUndatedButtonLabel = (count: number): string => `Renseigner les dates (${count})`;

const RETENUE = (s: string) => s === 'RETAINED_DIRECT' || s === 'RETAINED_CONSOLIDATED';
const EQUIPEMENT = /^equipment:(\d{1,10}):/;

/** Dépense retenue rattachée à aucune année par les indicateurs annuels (même sélection que `annual.undated`). */
export const tcoLineWithoutYear = (l: Pick<TcoEconomicLine, 'status' | 'kind' | 'annualYear'>): boolean =>
  RETENUE(l.status) && l.kind === 'REALIZED_COST' && l.annualYear === null;

/** Champ où se saisit la date de CETTE dépense (pure). */
export function tcoUndatedTarget(l: TcoEconomicLine): TcoUndatedTarget {
  if (l.dateEntry?.kind === 'ASSET_FIELD') return { kind: 'ASSET_FIELD', field: 'acquisitionDate' };
  if (l.dateEntry?.kind === 'DOCUMENT') return { kind: 'DOCUMENT', fileId: l.dateEntry.fileId };
  if (l.source === 'ASSET_DATA') return { kind: 'ASSET_FIELD', field: 'acquisitionDate' };
  const m = l.source === 'EQUIPMENT_DATA' ? EQUIPEMENT.exec(l.id) : null;
  if (m) return { kind: 'EQUIPMENT_FIELD', field: 'acquisitionDate', equipmentId: Number(m[1]) };
  return { kind: 'NONE' };
}

const ORIGINE: Readonly<Record<TcoEconomicLine['source'], TcoUndatedOrigin>> = {
  ASSET_DATA: 'ASSET', EQUIPMENT_DATA: 'EQUIPMENT', DOCUMENT: 'DOCUMENT', OPERATION: 'OPERATION',
};

/**
 * Dépenses sans date fiable d'un résultat TCO (pure, testée L113X-U-*). `lines` : trace COMPLÈTE du moteur
 * (jamais une page) ; `shown` : lignes montrées sur la fiche (gestes #712).
 */
export function tcoUndatedExpenses(t: Pick<TcoResult, 'lines'>, shown: readonly TcoEconomicLine[] = t.lines): TcoUndatedExpenses {
  const vues = new Set<string>();
  const lignes: TcoEconomicLine[] = [];
  for (const l of t.lines) {
    if (!tcoLineWithoutYear(l) || vues.has(l.id)) continue;
    vues.add(l.id);
    lignes.push(l);
  }
  // Carte #769 (écart B) : « Retirer du TCO » suit la décision d'inclusion existante, rattachée à la clé stable ; si
  // plusieurs dépenses retenues la partagent, le retrait les concerne toutes — la confirmation le dit explicitement.
  const partage = new Map<string, number>();
  for (const l of t.lines) if (RETENUE(l.status) && l.decisionKey) partage.set(l.decisionKey, (partage.get(l.decisionKey) ?? 0) + 1);
  const gestes = (l: TcoEconomicLine): TcoDecisionOption[] => tcoLineDecisionOptions(l, shown)
    .filter((o) => TCO_DATE_ACTIONS.has(o.action) || o.action === 'EXCLUDE')
    .map((o) => {
      const n = o.action === 'EXCLUDE' && l.decisionKey ? partage.get(l.decisionKey) ?? 1 : 1;
      return n > 1 ? { ...o, confirm: TCO_UNDATED_TEXTS.removeShared(n) } : o;
    });
  const items = lignes.slice(0, TCO_UNDATED_MAX_ITEMS).map((l): TcoUndatedExpense => {
    const docs = new Map<number, string | null>();
    if (l.fileId != null) docs.set(l.fileId, l.source === 'DOCUMENT' ? l.label : null);
    for (const f of l.sourceFileIds ?? []) if (!docs.has(f)) docs.set(f, null);
    const ui = l as TcoEconomicLine & { supportingDocuments?: Array<{ fileId: number; title: string }> };
    for (const d of ui.supportingDocuments ?? []) if (!docs.has(d.fileId) || docs.get(d.fileId) == null) docs.set(d.fileId, d.title);
    return {
      lineId: l.id, lineKey: l.factKey ?? l.decisionKey ?? null, lineVersion: l.version ?? null, label: l.label, amountCents: l.includedCents, category: l.category,
      origin: ORIGINE[l.source], operationId: l.operationId, operationLabel: l.operationLabel,
      documents: [...docs].map(([fileId, title]) => ({ fileId, title })),
      currentDate: isIsoDate(l.date) ? l.date.slice(0, 10) : null,
      note: l.note, target: tcoUndatedTarget(l), confirmedUndated: !!l.undatedConfirmation,
      options: gestes(l),
    };
  });
  const confirmees = lignes.filter((l) => !!l.undatedConfirmation).length;
  return {
    count: lignes.length, costsCents: lignes.reduce((n, l) => n + l.includedCents, 0),
    // Carte #769 (écart C) : trace complète (jamais la liste abrégée). « Attendue » : le geste de confirmation existe.
    pendingCount: lignes.filter((l) => !l.undatedConfirmation && tcoLineUndated(l)).length, confirmedCount: confirmees,
    items, truncated: lignes.length > items.length,
  };
}

/**
 * Diagnostics présentés sur la fiche (pure) : le point « date non établie » (113N) n'est plus répété dans
 * « Points à vérifier » — il est porté par l'alerte unique et son interface de saisie (qui propose aussi
 * « Conserver dans le TCO sans date »). Compteurs des cas ouverts recalculés ; une ligne reste « à revoir »
 * si un AUTRE cas ouvert la cite (ou ne peut l'exclure : sources abrégées). Les diagnostics du DTO
 * (T2, BO, e2e) ne changent pas.
 */
export function tcoSheetDiagnostics(d: TcoDiagnostics): TcoDiagnostics {
  const retire = d.items.filter((i) => i.code === TCO_UNDATED_DIAGNOSTIC_CODE && i.status === 'OPEN');
  if (!retire.length) return d;
  const items = d.items.filter((i) => !retire.includes(i));
  const ouverts = items.filter((i) => i.status === 'OPEN');
  const cites = new Set(ouverts.flatMap((i) => i.sources.map((s) => s.lineId).filter((x): x is string => !!x)));
  const abrege = ouverts.some((i) => i.sourcesTruncated);
  const retirees = new Set(retire.flatMap((i) => i.sources.map((s) => s.lineId).filter((x): x is string => !!x)));
  const aDecider = new Set(ouverts.flatMap((i) => i.sources.filter((s) => s.lineId && (s.actions ?? []).length).map((s) => s.lineId!)));
  return {
    ...d,
    items,
    open: {
      families: ouverts.length,
      occurrences: ouverts.reduce((n, i) => n + (i.count ?? 0), 0),
      anomalies: ouverts.filter((i) => i.nature === 'ANOMALY').length,
      coverage: ouverts.filter((i) => i.nature === 'COVERAGE').length,
      decisions: aDecider.size,
    },
    reviewLineIds: d.reviewLineIds.filter((id) => !retirees.has(id) || cites.has(id) || abrege),
  };
}

/** Motif d'une date refusée ou à confirmer (code stable + message). */
export type TcoDateCheck =
  | { ok: true; date: string }
  | { ok: false; code: 'INVALID_DATE' | 'FUTURE_DATE' | 'TOO_OLD'; message: string }
  | { ok: false; code: 'NEEDS_CONFIRMATION'; message: string };

const jj = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

/**
 * Validité et plausibilité d'une date saisie (pure) : date civile stricte (jamais normalisée : 29/02/2025
 * refusée), jamais après aujourd'hui, jamais avant `TCO_EXPENSE_DATE_MIN`. Contradiction avec la période de
 * possession (dépense antérieure à l'achat du bien ou postérieure à sa cession) : signalée, enregistrée
 * seulement après confirmation explicite — jamais remplacée par une autre date. La date d'achat du bien
 * elle-même définit la période : pas de contrôle de période pour elle.
 */
export function checkTcoExpenseDate(raw: unknown, ctx: {
  today: string; possessionStart?: string | null; disposalDate?: string | null; target: TcoUndatedTarget['kind']; confirmed?: boolean;
}): TcoDateCheck {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || !isIsoDate(v)) return { ok: false, code: 'INVALID_DATE', message: 'Date invalide : indiquez une date réelle (jour, mois, année).' };
  if (v > ctx.today.slice(0, 10)) return { ok: false, code: 'FUTURE_DATE', message: 'La date d’une dépense réalisée ne peut pas être postérieure à aujourd’hui.' };
  if (v < TCO_EXPENSE_DATE_MIN) return { ok: false, code: 'TOO_OLD', message: `Date non plausible : antérieure au ${jj(TCO_EXPENSE_DATE_MIN)}.` };
  if (ctx.target !== 'ASSET_FIELD' && !ctx.confirmed) {
    const debut = isIsoDate(ctx.possessionStart) ? ctx.possessionStart.slice(0, 10) : null;
    const fin = isIsoDate(ctx.disposalDate) ? ctx.disposalDate.slice(0, 10) : null;
    if (debut && v < debut) return { ok: false, code: 'NEEDS_CONFIRMATION', message: `Cette date est antérieure à l’achat du bien (${jj(debut)}). Confirmez-la si elle est exacte.` };
    if (fin && v > fin) return { ok: false, code: 'NEEDS_CONFIRMATION', message: `Cette date est postérieure à la cession du bien (${jj(fin)}). Confirmez-la si elle est exacte.` };
  }
  return { ok: true, date: v };
}

/** Saisie d'une date (corps de la requête). */
export interface TcoDateEntryInput {
  lineId: string;
  lineKey: string | null;
  date: string;
  /** L'utilisateur confirme une date contradictoire avec la période de possession. */
  confirm: boolean;
}

/** Corps `{ entries: [{ lineId, lineKey?, date, confirm? }] }` → entrées validées (pure ; la date est contrôlée ensuite). */
export function parseTcoDatesBody(body: unknown): { ok: true; value: TcoDateEntryInput[] } | { ok: false; message: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, message: 'Corps attendu : un objet.' };
  const e = (body as { entries?: unknown }).entries;
  if (!Array.isArray(e) || e.length === 0) return { ok: false, message: 'Au moins une date est attendue.' };
  if (e.length > TCO_UNDATED_MAX_ENTRIES) return { ok: false, message: `Au plus ${TCO_UNDATED_MAX_ENTRIES} dates par enregistrement.` };
  const out: TcoDateEntryInput[] = [];
  const vus = new Set<string>();
  for (const x of e) {
    if (!x || typeof x !== 'object') return { ok: false, message: 'Entrée invalide.' };
    const r = x as Record<string, unknown>;
    if (typeof r.lineId !== 'string' || !r.lineId.trim() || r.lineId.length > 200) return { ok: false, message: 'Dépense non identifiée.' };
    if (typeof r.date !== 'string' || r.date.length > 20) return { ok: false, message: 'Date attendue (AAAA-MM-JJ).' };
    if (vus.has(r.lineId)) return { ok: false, message: 'Une même dépense figure deux fois.' };
    vus.add(r.lineId);
    out.push({
      lineId: r.lineId, lineKey: typeof r.lineKey === 'string' && r.lineKey.length <= 400 ? r.lineKey : null,
      date: r.date, confirm: r.confirm === true,
    });
  }
  return { ok: true, value: out };
}
