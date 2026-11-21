/**
 * Carte #812 (lot 116F) — UNE DATE DU DOCUMENT N'EST JAMAIS, À ELLE SEULE, UNE BORNE DE PÉRIODE.
 * Règles PURES (aucune IA, aucune relecture du fichier, aucun titre, type ni fournisseur lus).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE DÉFAUT. Un bon de commande daté du 17/11/2026, sans clause de validité, affichait « Début de
 * validité : 17/11/2026 ». La seule source d'une période de VALIDITÉ est un fait T1 `period.validity`
 * (`./model`, source 1) : le modèle avait rendu ce fait avec, pour seule borne, la date de la commande.
 * La qualification le recopiait tel quel dans `document_business_periods`, et tous les écrans lisent
 * cette table. Le code ne contrôlait pas ce que PROUVE la borne.
 *
 * LA RÈGLE. Pour les natures gardées (`POINT_DATE_GUARDED_KINDS`), une période dont les bornes connues
 * se réduisent à UN SEUL JOUR — début seul, fin seule, ou début = fin — et dont ce jour est une DATE
 * PONCTUELLE du document (date du document enregistrée, date du document lue par T1, date de
 * l'opération réalisée — commande, achat, facture, paiement) n'établit aucune période : c'est la date
 * du document, recopiée. Elle n'est donc PAS qualifiée. Le jour d'import n'est PAS une date du document
 * (un devis déposé le dernier jour de sa validité garde sa fin de validité).
 *   · Une période qui porte autre chose que cette date reste qualifiée comme avant : une seconde borne
 *     distincte (« valable jusqu'au… », devis du 03/11 valable jusqu'au 03/12), une durée indéterminée
 *     ÉTABLIE (`INDEFINITE`), une borne partielle qui n'est pas une date du document, un mois ou une
 *     année. Aucune liste de types de documents, aucun fournisseur : un bon de commande, un devis ou un
 *     contrat qui porte une validité réelle la garde.
 *   · Rien n'est supprimé à l'aveugle dans le stock : la PREUVE du fait (son extrait) dit si la copie
 *     est PROUVÉE (`POINT_DATE_COPY` : aucun extrait, extrait qui ne cite pas la date, extrait réduit à
 *     la date, extrait qui est la mention même de la date du document, pertinence non établie par T1)
 *     ou seulement PROBABLE (`TO_REVIEW` : l'extrait cite la date dans une mention propre). Une période
 *     déjà enregistrée de cette seconde classe est CONSERVÉE « à réexaminer » (`planRefresh`), jamais
 *     déclarée fausse ; elle n'est simplement plus créée par une nouvelle analyse. RÈGLE REMPLACÉE
 *     (recette du 21/11, voir plus bas) : cette classe ne vaut plus que pour une FIN SEULE.
 *
 * Jamais : lire le titre, le type ou le fournisseur ; interpréter le vocabulaire d'un extrait (seuls
 * des jetons de date sont reconnus) ; toucher une période corrigée par l'utilisateur (`planRefresh`).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { precisionOf, type BusinessPeriodKind, type PeriodBounds } from '@/lib/documents/business-periods';

/*
 * ══════════════════════════════════════════════════════════════════════════
 * REPRISE APRÈS LA RECETTE KO DU 21/11/2026 (carte #812) — RÈGLE REMPLACÉE pour le cas « à réexaminer ».
 *
 * Comment le code décidait qu'un extrait était une « mention propre » (inchangé, `classifyPointDatePeriod`) :
 * l'extrait du fait T1 n'est pas vide, il CITE le jour (`excerptCitesDay` : quantième et année parmi ses
 * nombres), il contient au moins un mot qui n'est ni un nombre ni un mot de calendrier (`excerptWords`), et
 * la suite de ces mots ne figure pas, d'un seul tenant, dans la mention d'une date ponctuelle du même jour
 * (`withinWords`). Aucun mot n'est interprété : « Votre commande du 17/11/2026 est validée » est donc une
 * « mention propre » dès que T1 a cité la date du document par « Commande du 17/11/2026 » — et la ligne du
 * stock restait affichée. C'est ce que la recette du PO refuse.
 *
 * LA RÈGLE RESSERRÉE. Une validité dont le DÉBUT est une date ponctuelle du document et qui ne porte RIEN
 * D'AUTRE que ce jour — ni fin distincte, ni durée indéterminée DÉCLARÉE (`INDEFINITE`), ni borne différente
 * de la date du document (début seul, ou début = fin) — n'est jamais qualifiée, quelle que soit sa mention :
 * une mention qui ne fait que redire la date du document ne suffit pas (`DOCUMENT_DATE_RESTATED`). Elle est
 * retirée du stock AVEC MOTIF (jamais supprimée), et n'est plus restituée à la lecture.
 * Une durée ne se lit aujourd'hui que par la FIN que T1 en déduit (« valable 30 jours » → début / fin) : le
 * fait T1 n'a pas de champ « durée » (proposition faite au PO dans la fiche de recette, non décidée).
 * Reste « à réexaminer » (inchangé, non tranché par le PO) : la FIN SEULE égale à une date du document,
 * portée par une mention propre (« offre valable jusqu'au 17/11/2026 » sur un document du 17/11).
 * ══════════════════════════════════════════════════════════════════════════
 */

/**
 * Natures pour lesquelles une date ponctuelle du document ne prouve aucune borne. VALIDITÉ seulement
 * (périmètre de la carte #812) : une garantie qui court du jour de l'achat, une couverture ou un effet
 * contractuel qui commencent le jour du document sont des faits légitimes et ne sont pas concernés.
 * Étendre cette liste est une décision du PO (« à décider », recette 116F).
 */
export const POINT_DATE_GUARDED_KINDS: readonly BusinessPeriodKind[] = ['VALIDITY'];

/**
 * Rôle d'une date ponctuelle du document :
 *   DOCUMENT_DATE     « Date du document » enregistrée (`asset_files.document_date`) ;
 *   T1_DOCUMENT_DATE  date du document lue par T1 (`document.documentDate` de l'analyse de référence) ;
 *   OPERATION_DATE    date de réalisation d'un candidat T1 actif (commande, achat, facture, paiement) ;
 *   DATE_FACT         autre fait T1 du document dont la valeur est CE jour (« Date de commande »…) : il
 *                     ne fait pas d'un jour une date du document, il apporte seulement sa mention.
 */
export type PointDateRole = 'DOCUMENT_DATE' | 'T1_DOCUMENT_DATE' | 'OPERATION_DATE' | 'DATE_FACT';

/** Rôles qui font d'un jour une date ponctuelle DU DOCUMENT. */
const DOCUMENT_ROLES: readonly PointDateRole[] = ['DOCUMENT_DATE', 'T1_DOCUMENT_DATE', 'OPERATION_DATE'];

export interface DocumentPointDate {
  /** Jour AAAA-MM-JJ. */
  date: string;
  role: PointDateRole;
  /** Extrait qui prouve cette date (mention lue par T1), s'il est connu. */
  excerpt?: string | null;
}

export type PointDateReason =
  /** Le fait n'a aucun extrait (aucune preuve propre). */
  | 'NO_OWN_PROOF'
  /** L'extrait ne cite pas la date de la borne : la borne vient d'ailleurs. */
  | 'PROOF_WITHOUT_DATE'
  /** L'extrait n'est QUE la date. */
  | 'PROOF_IS_THE_DATE'
  /** L'extrait est la mention même d'une date ponctuelle du document (aucun mot de plus). */
  | 'SAME_MENTION_AS_POINT_DATE'
  /** Contrat v2 : T1 n'a pas établi la pertinence de la nature (indéterminée, ou « sans date »). */
  | 'RELEVANCE_NOT_ESTABLISHED'
  /**
   * Recette du 21/11 : le DÉBUT est la date du document et le fait ne porte rien d'autre (ni fin distincte, ni
   * durée indéterminée déclarée) — sa mention, même propre, ne fait que redire la date du document.
   */
  | 'DOCUMENT_DATE_RESTATED';

export type PointDateVerdict =
  /** Pas une date ponctuelle recopiée : qualification inchangée. */
  | { verdict: 'JUSTIFIED' }
  /** Copie PROUVÉE de la date du document : jamais qualifiée, retirée du stock. */
  | { verdict: 'POINT_DATE_COPY'; date: string; roles: PointDateRole[]; reason: PointDateReason }
  /**
   * FIN SEULE le jour d'une date du document, mention propre : jamais créée, conservée « à réexaminer » si elle
   * existe. (Règle remplacée, recette du 21/11 : un DÉBUT égal à la date du document n'est plus de cette classe.)
   */
  | { verdict: 'TO_REVIEW'; date: string; roles: PointDateRole[] };

const isDay = (v: string | null | undefined): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

/**
 * Le SEUL jour qu'établissent les bornes (pure) : début seul, fin seule, ou début = fin, au jour près.
 * `null` : deux bornes distinctes, durée indéterminée établie, mois ou année, aucune borne.
 */
export function singleDayOf(b: PeriodBounds): string | null {
  if (b.openEnded) return null;
  const { start, end } = b;
  if (start && end) return start === end && precisionOf(start) === 'DAY' ? start : null;
  const seule = start ?? end;
  return seule && precisionOf(seule) === 'DAY' ? seule : null;
}

/** Mots de calendrier (mois, jours ; français et anglais, abréviations) : jamais une preuve, seulement l'écriture d'une date. */
const CALENDAR_WORDS = new Set([
  'janvier', 'fevrier', 'mars', 'avril', 'mai', 'juin', 'juillet', 'aout', 'septembre', 'octobre', 'novembre', 'decembre',
  'janv', 'fevr', 'fev', 'avr', 'juil', 'sept', 'oct', 'nov', 'dec',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep',
  'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
]);

const fold = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * L'extrait cite-t-il ce jour ? (pure, indépendante de la langue) : le quantième et l'année figurent
 * parmi les nombres de l'extrait (« 17/11/2026 », « 17 novembre 2026 », « 2026-11-17 », « 17.11.26 »),
 * ou la date y est écrite d'un bloc (« 17112026 », « 20261117 »).
 */
export function excerptCitesDay(excerpt: string | null | undefined, day: string): boolean {
  if (!excerpt || !isDay(day)) return false;
  const [y, m, d] = day.split('-');
  const nombres = excerpt.match(/\d+/g) ?? [];
  if (nombres.some((n) => n === `${d}${m}${y}` || n === `${y}${m}${d}`)) return true;
  const quantieme = nombres.some((n) => n.length <= 2 && Number(n) === Number(d));
  const annee = nombres.some((n) => n === y || (n.length === 2 && n === y.slice(2)));
  return quantieme && annee;
}

/** Mots d'un extrait, sans les nombres ni les mots de calendrier (pure) : ce que l'extrait dit EN PLUS d'une date. */
export function excerptWords(excerpt: string | null | undefined): string[] {
  if (!excerpt) return [];
  return fold(excerpt).split(/[^a-z]+/).filter((w) => w.length > 0 && !CALENDAR_WORDS.has(w));
}

/** Tous les mots de `a` figurent-ils, dans l'ordre et d'un seul tenant, dans `b` ? (pure) */
function withinWords(a: readonly string[], b: readonly string[]): boolean {
  if (!a.length || a.length > b.length) return false;
  for (let i = 0; i + a.length <= b.length; i++) {
    let ok = true;
    for (let j = 0; j < a.length && ok; j++) ok = b[i + j] === a[j];
    if (ok) return true;
  }
  return false;
}

/**
 * Verdict d'une période d'une nature gardée (pure). `relevance` : pertinence de la nature rendue par
 * T1 sous le contrat v2 (`KNOWN`, `UNKNOWN`, `UNDETERMINED`…), `null` hors contrat v2.
 */
export function classifyPointDatePeriod(p: {
  kind: BusinessPeriodKind;
  bounds: PeriodBounds;
  excerpt: string | null | undefined;
  pointDates: readonly DocumentPointDate[];
  relevance?: string | null;
}): PointDateVerdict {
  if (!POINT_DATE_GUARDED_KINDS.includes(p.kind)) return { verdict: 'JUSTIFIED' };
  const jour = singleDayOf(p.bounds);
  if (!jour) return { verdict: 'JUSTIFIED' };
  const memes = p.pointDates.filter((x) => x.date === jour);
  const roles = [...new Set(memes.map((x) => x.role).filter((r) => DOCUMENT_ROLES.includes(r)))];
  if (!roles.length) return { verdict: 'JUSTIFIED' };
  const copie = (reason: PointDateReason): PointDateVerdict => ({ verdict: 'POINT_DATE_COPY', date: jour, roles, reason });
  if (p.relevance != null && p.relevance !== 'KNOWN') return copie('RELEVANCE_NOT_ESTABLISHED');
  const extrait = (p.excerpt ?? '').trim();
  if (!extrait) return copie('NO_OWN_PROOF');
  if (!excerptCitesDay(extrait, jour)) return copie('PROOF_WITHOUT_DATE');
  const mots = excerptWords(extrait);
  if (!mots.length) return copie('PROOF_IS_THE_DATE');
  // La mention est celle d'une date ponctuelle du document (même extrait, ou extrait compris dedans) : rien de plus.
  if (memes.some((x) => withinWords(mots, excerptWords(x.excerpt)))) return copie('SAME_MENTION_AS_POINT_DATE');
  // Recette du 21/11 (règle remplacée) : un DÉBUT égal à la date du document, sans rien d'autre que ce jour
  // (`singleDayOf` : ni fin distincte, ni durée indéterminée déclarée), n'établit aucune validité — même cité
  // dans une mention propre. Seule la FIN SEULE reste « à réexaminer ».
  if (p.bounds.start != null) return copie('DOCUMENT_DATE_RESTATED');
  return { verdict: 'TO_REVIEW', date: jour, roles };
}

/**
 * Une période ENREGISTRÉE peut-elle n'être que la date du document ? (pure, sans lecture) — filtre d'entrée de
 * la règle À LA LECTURE (`service#pointDateCopyIds`) : nature gardée, jamais une correction de l'utilisateur,
 * bornes réduites à un seul jour. Seules ces périodes (rares) demandent la relecture des dates du document ;
 * toutes les autres sont restituées sans aucune requête de plus.
 */
export function isPointDateSuspect(p: { kind: BusinessPeriodKind; start: string | null; end: string | null; openEnded?: boolean; userLocked: boolean; origin?: string | null }): boolean {
  if (p.userLocked || p.origin === 'USER') return false;
  if (!POINT_DATE_GUARDED_KINDS.includes(p.kind)) return false;
  return singleDayOf({ start: p.start, end: p.end, ...(p.openEnded ? { openEnded: true } : {}) }) !== null;
}
