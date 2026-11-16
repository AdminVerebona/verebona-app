/**
 * Carte #744, travaux D — CONTENU de la fiche : SYNTHÈSE FACTUELLE, MONTANTS
 * et NOTES de l'événement de référence (CDC « Opérations / Agenda V2.0 » §5,
 * §14, §18 ; AC42, AC52 à AC55, AC57). PUR (aucune dépendance serveur) :
 * partagé par la lecture de la fiche, la page, les routes et les tests.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUE CE MODULE N'EST PAS
 *
 * Ce n'est NI un moteur financier, NI un agrégat nouveau (CDC §18 : « la
 * source canonique des montants économiques est le moteur financier existant,
 * pas un nouvel agrégat dans la fiche »). Les chiffres viennent de ce qui est
 * DÉJÀ enregistré :
 *   · le montant est le NET INDICATIF du moteur existant
 *     (`indicativeNetCents`, `services/business-operations/diagnostics/model`) :
 *     coûts réalisés moins remises, remboursements, indemnités et produits ;
 *     les DEVIS et prévisions n'y entrent pas (§18 : « devis = prévision et
 *     non dépense effective ») ; une composante hors EUR sans contre-valeur
 *     connue n'est PAS convertie (AC54) — elle est signalée, jamais devinée ;
 *   · les nombres sont des `count(DISTINCT …)` : un justificatif ou un
 *     événement de l'Agenda PARTAGÉ avec un autre événement de référence est
 *     compté UNE SEULE FOIS (AC57, « bloquants de MEP : double comptage ») ;
 *   · la période est l'étendue des faits DATÉS de la fiche — aucune date
 *     inventée, aucune comparaison avec la date du jour.
 *
 * AUCUN MONTANT INVENTÉ : une rubrique dont rien n'est connu N'APPARAÎT PAS
 * (§14 : « sections affichées seulement lorsqu'elles contiennent des
 * informations »). La synthèse est FACTUELLE : aucun texte rédigé par l'IA
 * (celui du CDC §14 relève de T3 et n'est pas livré), donc aucun appel IA à
 * l'ouverture de la page.
 *
 * NOTES : le champ libre de l'utilisateur reprend le référentiel EXISTANT du
 * champ unique « Notes / Description » d'un document (lot 113Z, ticket #723) :
 * même nom, même borne, même normalisation — aucune règle dupliquée.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Textes nouveaux : « à valider par le PO » (fiche de recette 114O, section
 * « Travaux D — contenu »).
 */
import { lowerBound, isPartialDate, type PartialDate } from '@/lib/documents/business-periods';
import { NOTES_DESCRIPTION_LABEL, NOTES_INVALID_MESSAGE, NOTES_MAX_LENGTH, normalizeNotesText } from '@/lib/documents/notes-description';

// ── Synthèse factuelle et montants ─────────────────────────────────────────

/** Repères de la fiche, lus dans ce qui est déjà enregistré (aucun calcul métier nouveau). */
export interface ReferenceEventSummary {
  /**
   * Net indicatif en CENTIMES D'EURO, tel que le rend la règle existante
   * `indicativeNetCents` ; null : aucun coût réalisé connu (la rubrique
   * n'apparaît pas). Peut être négatif (indemnités supérieures aux coûts).
   */
  netCents: number | null;
  /** Composantes hors EUR sans contre-valeur connue : NON comptées, jamais converties (AC54). */
  unconvertedCount: number;
  /** Justificatifs reliés, chacun une seule fois (jamais plafonné en silence). */
  documentCount: number;
  /** Événements de l'Agenda reliés, chacun une seule fois même s'il est partagé. */
  agendaItemCount: number;
  /** Fournisseurs reliés, par nom (ordre de la fiche). */
  supplierNames: string[];
  /** Étendue des faits datés de la fiche ; null : aucun fait daté. */
  period: { from: string; to: string } | null;
}

export const REFERENCE_EVENT_SUMMARY_KEYS = ['spent', 'documents', 'period', 'agenda', 'suppliers'] as const;
export type ReferenceEventSummaryKey = (typeof REFERENCE_EVENT_SUMMARY_KEYS)[number];

/** Textes de la synthèse (nouveaux : à valider par le PO, sauf mention « existant »). */
export const REFERENCE_EVENT_SUMMARY_LABELS = {
  title: 'Synthèse',
  /** Ce que la synthèse est, et ce qu'elle n'est pas (dit une fois, sous les repères). */
  note: 'Ces repères sont lus dans ce qui est déjà enregistré. Un justificatif ou un événement partagé avec un autre événement de référence n’est compté qu’une seule fois.',
  spent: 'Total dépensé',
  spentHint: 'Coûts réalisés, moins les remises, remboursements et indemnités. Les devis et les prévisions n’y sont pas comptés.',
  /** Une composante hors EUR sans contre-valeur connue : elle n'est pas convertie (AC54). */
  spentUnconverted: 'Un montant dans une autre devise n’est pas compté ici : il reste consultable sur son justificatif.',
  spentUnconvertedMany: 'Des montants dans une autre devise ne sont pas comptés ici : ils restent consultables sur leurs justificatifs.',
  /** Existant (vocabulaire de la fiche et du tiroir d'un document). */
  documents: 'Justificatifs',
  period: 'Période couverte',
  /** Existant (vocabulaire de l'Agenda). */
  agenda: 'Événements',
  /** Existant (titre de rubrique de la fiche). */
  suppliers: 'Fournisseurs',
  /** Étendue d'une période : « Du … au … » ; un seul jour connu : « Le … ». */
  periodFrom: 'Du',
  periodTo: 'au',
  periodSingle: 'Le',
  /** Fournisseurs au-delà des trois premiers nommés. */
  othersOne: 'et 1 autre',
  othersMany: 'et {n} autres',
} as const;

/** Nombre de fournisseurs nommés dans la synthèse ; au-delà : « et n autres ». */
export const REFERENCE_EVENT_SUMMARY_SUPPLIERS_SHOWN = 3;

/** Un repère affichable de la synthèse. */
export interface ReferenceEventSummaryEntry {
  key: ReferenceEventSummaryKey;
  label: string;
  value: string;
  /** Précision affichée sous la valeur ; null : aucune. */
  hint: string | null;
}

/** `AAAA-MM-JJ` → `JJ/MM/AAAA` ; toute autre valeur : null (jamais une date fabriquée). */
const jour = (d: string): string | null =>
  /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : null;

/**
 * Montant en centimes d'euro, écrit comme le coût de possession
 * (`fr-FR`, devise EUR). null : rien à afficher (aucun montant inventé).
 */
export function referenceEventEuros(cents: number | null | undefined): string | null {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return null;
  return (cents / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
}

/** « Du JJ/MM/AAAA au JJ/MM/AAAA », ou « Le JJ/MM/AAAA » quand les deux bornes coïncident ; null : rien. */
export function referenceEventPeriodText(p: { from: string; to: string } | null | undefined): string | null {
  if (!p) return null;
  const a = jour(p.from);
  const b = jour(p.to);
  if (!a || !b) return null;
  const L = REFERENCE_EVENT_SUMMARY_LABELS;
  return a === b ? `${L.periodSingle} ${a}` : `${L.periodFrom} ${a} ${L.periodTo} ${b}`;
}

/**
 * ÉTENDUE des faits datés de la fiche (pure) : la plus ancienne et la plus
 * récente des dates reçues. Une date partielle (année, mois) est ramenée à sa
 * borne basse par la règle existante (`lowerBound`) — jamais à un jour qui
 * n'existe pas. Toute valeur qui n'est pas une date est ignorée ; aucune date
 * n'est inventée et la date du jour n'intervient pas. null : aucun fait daté.
 */
export function referenceEventPeriodOf(dates: readonly (string | null | undefined)[]): { from: string; to: string } | null {
  const jours: string[] = [];
  for (const d of dates) {
    if (typeof d !== 'string') continue;
    // Un jour du CALENDRIER RÉEL seulement (« 2023-02-29 », « 2024-13-01 » ne sont pas des dates).
    const court = d.slice(0, 10);
    if (court.length === 10 && isPartialDate(court)) { jours.push(court); continue; }
    if (isPartialDate(d)) jours.push(lowerBound(d as PartialDate));
  }
  if (jours.length === 0) return null;
  jours.sort();
  return { from: jours[0], to: jours[jours.length - 1] };
}

/**
 * Repères AFFICHABLES, dans l'ordre : chacun n'y figure que si quelque chose
 * est connu (aucun « — », aucun zéro, aucun montant inventé). Liste vide : la
 * rubrique « Synthèse » n'est pas affichée du tout.
 */
export function referenceEventSummaryEntries(s: ReferenceEventSummary | null | undefined): ReferenceEventSummaryEntry[] {
  if (!s) return [];
  const L = REFERENCE_EVENT_SUMMARY_LABELS;
  const out: ReferenceEventSummaryEntry[] = [];
  const montant = referenceEventEuros(s.netCents);
  if (montant !== null) {
    const manque = s.unconvertedCount > 0 ? (s.unconvertedCount === 1 ? L.spentUnconverted : L.spentUnconvertedMany) : null;
    out.push({ key: 'spent', label: L.spent, value: montant, hint: manque ? `${L.spentHint} ${manque}` : L.spentHint });
  }
  if (s.documentCount > 0) out.push({ key: 'documents', label: L.documents, value: String(s.documentCount), hint: null });
  const periode = referenceEventPeriodText(s.period);
  if (periode !== null) out.push({ key: 'period', label: L.period, value: periode, hint: null });
  if (s.agendaItemCount > 0) out.push({ key: 'agenda', label: L.agenda, value: String(s.agendaItemCount), hint: null });
  const noms = s.supplierNames.map((n) => n.trim()).filter((n) => n.length > 0);
  if (noms.length > 0) {
    const montres = noms.slice(0, REFERENCE_EVENT_SUMMARY_SUPPLIERS_SHOWN);
    const reste = noms.length - montres.length;
    const suite = reste === 1 ? L.othersOne : reste > 1 ? L.othersMany.replace('{n}', String(reste)) : '';
    out.push({ key: 'suppliers', label: L.suppliers, value: suite ? `${montres.join(', ')} ${suite}` : montres.join(', '), hint: null });
  }
  return out;
}

// ── Notes / Description (champ libre de l'utilisateur) ─────────────────────

/** Note de l'utilisateur telle que la fiche la rend ; null : aucune note enregistrée. */
export interface ReferenceEventNotes {
  text: string;
  /** Jour du dernier enregistrement (`AAAA-MM-JJ`) ; null : inconnu. */
  updatedOn: string | null;
}

/** Borne du texte libre : celle du champ « Notes / Description » existant (lot 113Z). */
export const REFERENCE_EVENT_NOTES_MAX = NOTES_MAX_LENGTH;

/** Nom du champ : celui du champ unique existant (ticket #723, repris à l'identique). */
export const REFERENCE_EVENT_NOTES_FIELD = NOTES_DESCRIPTION_LABEL;

/** Textes du champ libre (nouveaux : à valider par le PO, sauf le nom du champ). */
export const REFERENCE_EVENT_NOTES_LABELS = {
  field: REFERENCE_EVENT_NOTES_FIELD,
  edit: 'Modifier',
  add: 'Ajouter une note',
  dialogTitle: 'Notes / Description',
  dialogHint: 'Ce texte est le vôtre. Il n’est jamais réécrit par Verebona et n’entre dans aucun calcul.',
  placeholder: 'Ce que vous voulez retenir de cet événement de référence',
  updatedOn: 'Modifié le',
  tooLong: `Ce texte ne peut pas dépasser ${NOTES_MAX_LENGTH} caractères.`,
  /** Existant (lot 113Z) : texte qui n'est pas un texte. */
  invalid: NOTES_INVALID_MESSAGE,
  unchanged: 'Aucune modification à enregistrer.',
  empty: 'Aucune note.',
  /** Effacer volontairement : la note disparaît, rien d'autre. */
  clearHint: 'Videz le champ pour retirer votre note.',
} as const;

export type ReferenceEventNotesValidation =
  | { ok: true; notes: string | null }
  | { ok: false; error: string };

/**
 * Lit la demande « enregistrer la note » (forme et borne SEULEMENT, comme les
 * autres demandes de la page) : `notes` est une chaîne, bornée ;
 * vide ou absente → `null` (la note est retirée, aucun autre effet). La
 * normalisation est celle du champ existant d'un document (`normalizeNotesText`).
 */
export function parseReferenceEventNotes(v: unknown): ReferenceEventNotesValidation {
  const L = REFERENCE_EVENT_NOTES_LABELS;
  if (v === undefined || v === null) return { ok: true, notes: null };
  if (typeof v !== 'string') return { ok: false, error: L.invalid };
  if (v.length > NOTES_MAX_LENGTH) return { ok: false, error: L.tooLong };
  const t = normalizeNotesText(v);
  return { ok: true, notes: t.length > 0 ? t : null };
}

/**
 * Demande à envoyer depuis la page : rien si le texte n'a pas changé (ouvrir
 * et enregistrer sans toucher au texte n'écrit rien — même règle que le champ
 * d'un document, `notesWriteFromEdit`).
 */
export function buildReferenceEventNotes(
  current: { notes?: ReferenceEventNotes | null; version: number }, edited: string,
): { ok: true; body: { expectedVersion: number; notes: string | null } } | { ok: false; error: string } {
  const L = REFERENCE_EVENT_NOTES_LABELS;
  if (edited.length > NOTES_MAX_LENGTH) return { ok: false, error: L.tooLong };
  const avant = normalizeNotesText(current.notes?.text ?? '');
  const apres = normalizeNotesText(edited);
  if (avant === apres) return { ok: false, error: L.unchanged };
  return { ok: true, body: { expectedVersion: current.version, notes: apres.length > 0 ? apres : null } };
}
