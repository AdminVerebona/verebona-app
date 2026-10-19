/**
 * Lot 71F — INTRODUCTIONS DE COMPTAGE de la bulle, interdites partout.
 *
 * « Un sujet mérite votre attention aujourd'hui : … », « Deux sujets
 * nécessitent votre attention », « 3 points méritent toute votre
 * attention », « Voici deux sujets pour vous : … » : un préambule qui se
 * contente de COMPTER les sujets avant de les présenter. La mascotte va
 * directement au contenu utile — aucune phrase de remplacement.
 *
 * Module PUR (serveur et client, aucune dépendance) — source unique de la
 * détection pour :
 *   · la bulle (`bubble.ts` : en-tête et blocs de sujet, dernier rempart
 *     côté écran, quel que soit le parcours : T6, secours, cache, À traiter,
 *     Duo, onboarding) ;
 *   · l'assemblage serveur (`presentation.ts` : un texte T6 qui en porte une
 *     reprend son texte de secours) ;
 *   · le contrat T6 (`mechanicalWording` : sortie IA, sujet figé, entrée de
 *     cache — rejetées, l'entrée de cache est invalidée).
 *
 * Insensible à la casse, aux accents (y compris décomposés), aux
 * apostrophes (’ ' ʼ …), aux espaces insécables et au singulier / pluriel.
 * « Aucun sujet à traiter en priorité » n'est PAS une introduction de
 * comptage (message d'état, conservé). Aucune assertion arrière dans les
 * expressions (WebView iOS anciennes) : le texte est replié en ASCII, `\b`
 * suffit.
 */

/** Nombre annoncé (jamais « aucun » : c'est un message d'état). */
const NOMBRE = String.raw`(?:un|une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze|\d+|plusieurs|quelques)`;
/** Ce qui est compté. */
const OBJET = String.raw`(?:sujets?|points?|elements?|choses?|questions?|actions?|taches?)`;
/** Adjectif facultatif entre le nombre et l'objet (« deux nouveaux sujets »). */
const ADJ = String.raw`(?:[a-z]+\s+)?`;

/**
 * A — « N sujets … attention » dans une même proposition, où qu'elle soit
 * (« méritent / nécessitent / demandent / requièrent / appellent (toute)
 * votre attention »).
 */
const ATTENTION = new RegExp(String.raw`\b${NOMBRE}\s+${ADJ}${OBJET}\b[^.:;!?]{0,60}?\battention\b`);

/**
 * B — proposition qui OUVRE sur un comptage pour présenter la suite :
 * « Voici deux sujets : », « J'ai un point pour vous », « Deux sujets
 * aujourd'hui : », « 2 points à traiter : ».
 */
const PRESENTATION = new RegExp(
  String.raw`^\s*(?:(?:aujourd'hui|ce jour|ce matin)\s*,?\s*)?(?:(?:voici|voila|j'ai|nous avons|vous avez|il y a)\s+)?${NOMBRE}\s+${ADJ}${OBJET}\b`
  + String.raw`(?:\s*[.:;!?]*\s*$|[^.:;!?]{0,60}?\b(?:a traiter|a voir|a regarder|a suivre|a signaler|a examiner|pour vous|pour aujourd'hui|aujourd'hui|ce jour|du jour)\b)`,
);

const APOSTROPHES = /['’‘‛ʼ´`′]/;
const DIACRITIQUES = /[̀-ͯ]/g;

/** Repli caractère par caractère : même longueur que le texte NFC (indices alignés). */
function replier(nfc: string): string {
  let out = '';
  for (let i = 0; i < nfc.length; i++) {
    const c = nfc[i];
    if (APOSTROPHES.test(c)) { out += "'"; continue; }
    if (/\s/.test(c)) { out += ' '; continue; }
    const b = c.normalize('NFD').replace(DIACRITIQUES, '').toLowerCase();
    out += b.length === 1 ? b : c;
  }
  return out;
}

/**
 * Propositions du texte : coupées APRÈS chaque « . », « : », « ; », « ! »
 * ou « ? » (le séparateur reste dans sa proposition), espaces compris —
 * recollées telles quelles, le texte est restitué à l'identique.
 */
function propositions(nfc: string): string[] {
  return nfc.match(/[^.:;!?]*[.:;!?]+\s*|[^.:;!?]+$/g) ?? [];
}

function estIntroduction(proposition: string): boolean {
  const p = replier(proposition);
  return ATTENTION.test(p) || PRESENTATION.test(p);
}

/** Le texte contient-il une introduction de comptage ? (pure) */
export function hasCountingIntro(text: string | null | undefined): boolean {
  if (!text) return false;
  return propositions(text.normalize('NFC')).some(estIntroduction);
}

/**
 * Retire les introductions de comptage d'un texte — la proposition entière,
 * sans phrase de remplacement — et rend la majuscule initiale à ce qui
 * reste : « Un sujet mérite votre attention aujourd'hui : Ajoutez votre
 * premier document… » → « Ajoutez votre premier document… ». Un texte qui
 * n'était qu'une introduction devient vide. Sans introduction : texte
 * inchangé (même référence de contenu). Pure.
 */
export function stripCountingIntro(text: string): string {
  if (!hasCountingIntro(text)) return text;
  const reste = propositions(text.normalize('NFC')).filter((p) => !estIntroduction(p)).join('').trim();
  return reste ? reste.charAt(0).toLocaleUpperCase('fr-FR') + reste.slice(1) : '';
}
