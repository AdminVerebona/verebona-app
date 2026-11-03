/**
 * Règles CENTRALISÉES d'équivalence des représentations Agenda — lot 106A
 * (ticket P1 « Agenda — doublons DPE non autoréparés »). Module PUR, sans base.
 *
 * Aucune règle métier en dur ailleurs : la prévention à la source (candidats
 * T4, `build-agenda-candidates.step.ts`), le rapprochement T4
 * (`agenda-intelligence.service.ts`) et le contrôle de cohérence
 * COH-AGENDA-EQUIVALENT-REPRESENTATIONS lisent ces mêmes tables.
 *
 *   · GENERIC_EVENT_ABSORPTION : un événement GÉNÉRIQUE (« Contrôle réalisé »,
 *     type `inspection` sans champ d'origine) daté comme un fait PRÉCIS du même
 *     dossier (DPE réalisé, `dpeDate`) sur la même cible n'est pas un fait
 *     supplémentaire — sauf si le dossier désigne un AUTRE diagnostic
 *     (électricité, gaz…) : celui-là reste distinct ;
 *   · DOSSIER_DATE_FIELDS : champs « date d'établissement du dossier » (le
 *     registre n'y attache aucun effet Agenda ; leur événement vient de
 *     l'annotation T1 `semanticEvent`) ;
 *   · STABLE_REFERENCE_FIELDS : références qui désignent UNE occurrence (n°
 *     ADEME d'un DPE) — identité certaine si elles concordent, faits distincts
 *     si elles diffèrent ;
 *   · TYPE_SUBJECT_TOKENS : mots qui, dans le sujet d'un fait, désignent le type
 *     précis (un sujet « DPE » n'apporte rien à « DPE réalisé »).
 * L'intitulé n'est JAMAIS une clé : il ne sert qu'à reconnaître un intitulé
 * générique ou non informatif (indice), jamais à conclure seul à une identité.
 */

/** Types génériques → types précis qui les représentent déjà (même cible, même date, même dossier). */
export const GENERIC_EVENT_ABSORPTION: Readonly<Record<string, readonly string[]>> = {
  inspection: ['dpe'],
};

/** Champs « date d'établissement du dossier » (aucun effet Agenda au registre). */
export const DOSSIER_DATE_FIELDS: readonly string[] = ['diagnosticDate'];

/** Références stables d'une occurrence, par type métier. */
export const STABLE_REFERENCE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  dpe: ['dpeAdemeNumber'],
};

/** Champ de date d'un fait précis, par type métier (ancrage d'une représentation par la fiche ou un document). */
export const OCCURRENCE_DATE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  dpe: ['dpeDate'],
};

/** Mots désignant le type précis dans un sujet (normalisés, sans accents). */
export const TYPE_SUBJECT_TOKENS: Readonly<Record<string, readonly string[]>> = {
  dpe: ['dpe', 'performance energetique', 'diagnostic de performance energetique', 'peb'],
};

/** Intitulés « tête » génériques (avant « — ») : indice seulement (même liste que la projection 76H). */
export const GENERIC_TITLE_HEADS: readonly string[] = ['controle realise', 'entretien realise', 'reparation', 'intervention', 'diagnostic realise'];

/** Normalisation commune (sans accents, minuscules, ponctuation → espace). */
export const normalizeEq = (s: string | null | undefined): string =>
  (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Référence stable normalisée (n° ADEME : majuscules, sans espaces ni séparateurs). */
export const normalizeReference = (s: string | null | undefined): string | null => {
  const v = (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return v.length >= 6 ? v : null;
};

/** Le sujet désigne-t-il le type précis (« DPE », « performance énergétique ») ? */
export function subjectDesignatesType(subject: string | null | undefined, businessType: string): boolean {
  const s = normalizeEq(subject);
  if (!s) return false;
  return (TYPE_SUBJECT_TOKENS[businessType] ?? []).some((t) => s === t || s.includes(t));
}

/** Le type `generic` est-il représenté par `precise` (même cible, même date, même dossier) ? */
export const absorbs = (precise: string | null | undefined, generic: string | null | undefined): boolean =>
  !!precise && !!generic && (GENERIC_EVENT_ABSORPTION[generic] ?? []).includes(precise);

/** Tête d'intitulé (avant « — ») normalisée. */
export const titleHead = (title: string): string => normalizeEq(title.split(' — ')[0] ?? title);
/** Sujet d'intitulé (après « — »), ou null. */
export const titleSubject = (title: string): string | null => {
  const i = title.indexOf(' — ');
  return i >= 0 ? title.slice(i + 3).trim() || null : null;
};

/** Intitulé générique (indice) : tête de la liste `GENERIC_TITLE_HEADS`. */
export const isGenericTitle = (title: string): boolean => GENERIC_TITLE_HEADS.includes(titleHead(title));

/**
 * Sujet NON INFORMATIF d'un intitulé : absent, ou ne fait que répéter la tête
 * (« DPE réalisé — DPE »), ou n'est que l'intitulé d'un document source (« DPE
 * réalisé — Compromis de vente »). Un sujet informatif (« Installation
 * électrique ») n'est jamais remplacé.
 */
export function subjectIsUninformative(title: string, extra: { documentTitles?: readonly string[]; assetName?: string | null } = {}): boolean {
  const subject = titleSubject(title);
  if (!subject) return true;
  const s = normalizeEq(subject);
  if (extra.assetName && s === normalizeEq(extra.assetName)) return false; // déjà le nom du bien : rien à changer
  const tete = new Set(titleHead(title).split(' '));
  if (s.split(' ').every((w) => tete.has(w))) return true;
  return (extra.documentTitles ?? []).some((t) => normalizeEq(t) === s);
}
