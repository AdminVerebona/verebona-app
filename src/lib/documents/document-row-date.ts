/**
 * Date d'une LIGNE de document — lot 108D (ticket P1 « Listes de documents :
 * une seule date, la date du document, sinon « – » »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN SEUL CONTRAT DE RESTITUTION, TOUTES LES LISTES
 *
 * Une ligne de document (Mes documents, regroupement par Rubrique, onglet
 * Documents d'un bien, tiroirs Équipement / Pièce / Fournisseur, documents
 * d'un événement de référence, documents récents de l'accueil…) montre :
 *
 *   · un sous-titre = le TYPE documentaire seul (aucune date) ;
 *   · à droite, UNE date = la date métier du document
 *     (`asset_files.document_date`, champ unique, celui des filtres et tris
 *     « Date du document ») — sinon « – ».
 *
 * Jamais de repli : ni date d'ajout (`uploaded_at`), ni création, analyse,
 * modification, scan ou indexation. Cette fonction n'accepte donc QUE des
 * dates civiles (`AAAA-MM-JJ`, `AAAA-MM`, `AAAA`) : un horodatage reçu par
 * erreur (ex. `uploadedAt`) rend « – » au lieu d'être affiché comme une date
 * documentaire.
 *
 * Dates partielles : aucun jour inventé. `AAAA-MM` → « oct. 2019 »,
 * `AAAA` → « 2019 ». (Le modèle actuel stocke une date au jour près ; une
 * date partielle n'y est pas posée — T1 la rejette — et la ligne affiche
 * alors « – ».)
 *
 * La date d'ajout reste visible dans le DÉTAIL du document (tiroir) et reste
 * filtrable / triable comme critère distinct.
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Présentation d'une date absente, ambiguë ou non fiable (tiret unique). */
export const DOCUMENT_DATE_PLACEHOLDER = '–';

/** Libellé accessible de la cellule (lecteurs d'écran). */
export const DOCUMENT_DATE_A11Y_PREFIX = 'Date du document';
export const DOCUMENT_DATE_A11Y_MISSING = 'Date du document non renseignée';

/**
 * Décision PO 108D : le sous-titre d'une ligne est le Type documentaire SEUL.
 * Un autre choix (« Type · Bien » sur Mes documents) se change ici.
 */
export const DOCUMENT_ROW_SUBTITLE_INCLUDES_ASSET = false;

const MOIS_COURTS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
const MOIS_LONGS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

export type DocumentDatePrecision = 'day' | 'month' | 'year';

export interface DocumentRowDate {
  /** Texte visible : « 20 déc. 2025 », « oct. 2019 », « 2019 » ou « – ». */
  label: string;
  /** Nom accessible : « Date du document : 20 décembre 2025 ». */
  ariaLabel: string;
  /** Valeur `datetime` d'un élément `<time>` (null sans date). */
  dateTime: string | null;
  precision: DocumentDatePrecision | null;
}

function jourValide(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const fin = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= fin;
}

/**
 * Date documentaire d'une ligne (pure). Entrée : la valeur du champ métier
 * `documentDate` telle que servie par l'API (`AAAA-MM-JJ`), éventuellement
 * partielle. Toute autre forme (horodatage, texte) est refusée : « – ».
 */
export function documentRowDate(value: string | null | undefined): DocumentRowDate {
  const vide: DocumentRowDate = { label: DOCUMENT_DATE_PLACEHOLDER, ariaLabel: DOCUMENT_DATE_A11Y_MISSING, dateTime: null, precision: null };
  if (typeof value !== 'string') return vide;
  const s = value.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!jourValide(y, mo, d)) return vide;
    return {
      label: `${d} ${MOIS_COURTS[mo - 1]} ${y}`,
      ariaLabel: `${DOCUMENT_DATE_A11Y_PREFIX} : ${d === 1 ? '1er' : d} ${MOIS_LONGS[mo - 1]} ${y}`,
      dateTime: s,
      precision: 'day',
    };
  }
  m = /^(\d{4})-(\d{2})$/.exec(s);
  if (m) {
    const [y, mo] = [Number(m[1]), Number(m[2])];
    if (mo < 1 || mo > 12) return vide;
    return { label: `${MOIS_COURTS[mo - 1]} ${y}`, ariaLabel: `${DOCUMENT_DATE_A11Y_PREFIX} : ${MOIS_LONGS[mo - 1]} ${y}`, dateTime: s, precision: 'month' };
  }
  m = /^(\d{4})$/.exec(s);
  if (m) return { label: s, ariaLabel: `${DOCUMENT_DATE_A11Y_PREFIX} : ${s}`, dateTime: s, precision: 'year' };
  return vide;
}

/** Libellé seul (pratique pour les sous-titres de cartes existantes). */
export function documentRowDateLabel(value: string | null | undefined): string {
  return documentRowDate(value).label;
}
