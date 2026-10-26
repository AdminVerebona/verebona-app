/**
 * Lot 71F — INTRODUCTIONS DE COMPTAGE de la bulle, interdites partout.
 * Lot 75E — CLASSIFICATEUR DÉTERMINISTE UNIQUE, sans perte d'information.
 *
 * « Un sujet mérite votre attention aujourd'hui : … », « Deux sujets
 * nécessitent votre attention », « Voici deux sujets importants : … » : un
 * préambule qui se contente de COMPTER les sujets avant de les présenter. La
 * mascotte va directement au contenu utile — aucune phrase de remplacement.
 *
 * Module PUR (serveur et client, aucune dépendance) — source UNIQUE de la
 * classification pour :
 *   · la bulle (`bubble.ts` : blocs de sujet, message complet, présentation
 *     conservée côté client) ;
 *   · l'assemblage serveur (`presentation.ts` : un texte T6 porteur reprend
 *     son texte de secours) ;
 *   · le contrat T6 (`mechanicalWording` : sortie IA, sujet figé, entrée de
 *     cache — rejetées, l'entrée de cache est invalidée).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LOT 75E — POURQUOI UN CLASSIFICATEUR PLUTÔT QUE DES EXPRESSIONS
 *
 * Le lot 71F découpait le texte aux seuls « . : ; ! ? » et retirait toute
 * proposition reconnue : « Un sujet mérite votre attention aujourd'hui,
 * ajoutez votre premier document » devenait VIDE (la virgule ne séparait
 * rien) ; « Votre contrat contient deux éléments qui demandent votre
 * attention : les freins… » perdait « Votre contrat… » (faux positif).
 *
 * Désormais chaque PHRASE est découpée en propositions aux séparateurs
 * réellement utilisés (deux-points, virgule, point-virgule, tirets simple,
 * demi-cadratin et cadratin), puis chaque proposition est CLASSÉE par ses
 * mots (texte replié : casse, accents composés / décomposés, apostrophes,
 * espaces insécables indifférents) :
 *   · PRÉAMBULE — un nombre (« un », « deux », « 2 », « plusieurs »…) suivi
 *     d'un objet compté (sujet, point, élément, action…), éventuellement
 *     d'adjectifs vides (« importants », « nouveaux »…), et RIEN d'autre que
 *     le vocabulaire fermé d'une présentation (« voici », « vous avez »,
 *     « il y a », « méritent toute votre attention », « à traiter
 *     aujourd'hui »…). Seul un préambule est retiré, avec son séparateur ;
 *   · DOUTEUX — la même tête (« Deux sujets d'assurance : … ») avec UN mot
 *     hors vocabulaire, ou un préambule qui n'ouvre pas la phrase (« Bonjour
 *     Fabien, deux sujets méritent… ») : détecté (rejet T6, cache invalidé)
 *     mais JAMAIS découpé à l'aveugle — l'appelant prend le texte de
 *     secours déterministe (`UNSAFE`) ;
 *   · MÉTIER — tout le reste, conservé à l'identique : « Votre contrat
 *     contient deux éléments… », « Le devis comporte trois points à
 *     vérifier… », « Un rappel : … » ne sont jamais des préambules.
 * Aucune assertion arrière dans les expressions (WebView iOS anciennes).
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Nombre annoncé (jamais « aucun » : c'est un message d'état). */
const NOMBRES = new Set(['un', 'une', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix', 'onze', 'douze', 'plusieurs', 'quelques']);
/** Ce qui est compté. */
const OBJETS = new Set(['sujet', 'sujets', 'point', 'points', 'element', 'elements', 'chose', 'choses', 'question', 'questions', 'action', 'actions', 'tache', 'taches']);
/** Adjectifs VIDES admis entre le nombre et l'objet, ou après l'objet. */
const ADJECTIFS = new Set([
  'nouveau', 'nouveaux', 'nouvel', 'nouvelle', 'nouvelles', 'important', 'importants', 'importante', 'importantes',
  'principal', 'principaux', 'principale', 'principales', 'prioritaire', 'prioritaires',
  'petit', 'petits', 'petite', 'petites', 'grand', 'grands', 'grande', 'grandes', 'autre', 'autres', 'essentiel', 'essentiels',
  'essentielle', 'essentielles', 'particulier', 'particuliers', 'particuliere', 'particulieres', 'majeur', 'majeurs', 'majeure',
  'majeures', 'cle', 'cles', 'utile', 'utiles', 'rapide', 'rapides', 'precis', 'precise', 'precises',
]);
/** Vocabulaire fermé d'une PRÉSENTATION (verbes, pronoms, compléments vides). */
const PRESENTATION = new Set([
  // ouverture
  'voici', 'voila', 'j', 'ai', 'nous', 'avons', 'vous', 'avez', 'il', 'y', 'a', 'ont', 'est', 'sont', 'reste', 'restent',
  // verbes de l'attention
  'merite', 'meritent', 'necessite', 'necessitent', 'demande', 'demandent', 'requiert', 'requierent', 'appelle', 'appellent',
  'attend', 'attendent', 'retient', 'retiennent', 'interesse', 'interessent', 'concernent',
  // mots vides
  'toute', 'tout', 'toutes', 'tous', 'votre', 'vos', 'attention', 'au', 'aux', 'de', 'd', 'du', 'des', 'pour', 'le', 'la', 'les', 'l',
  'en', 'ce', 'cet', 'cette', 'ces', 'qui', 'que', 'ici', 'maintenant', 'priorite', 'particulierement', 'plus', 'bien',
  // moments
  'jour', 'matin', 'soir', 'aujourd', 'hui', 'semaine', 'moment', 'instant',
  // compléments « à traiter / à voir… »
  'traiter', 'voir', 'regarder', 'suivre', 'signaler', 'examiner', 'noter', 'retenir', 'prevoir', 'faire', 'venir', 'verifier', 'surveiller',
]);
/** Ouvertures seules admises AVANT un préambule (« Aujourd'hui, deux sujets… »). */
const OUVERTURES = new Set(['aujourd hui', 'ce matin', 'ce jour', 'cette semaine', 'en ce moment', 'pour le moment', 'pour l instant', 'bonjour', 'ici']);
/** Verbes de l'attention : « N sujets méritent (toute) votre attention », où qu'ils soient. */
const ATTENTION = /\b(?:un|une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze|\d+|plusieurs|quelques)\s+(?:[a-z]+\s+)?(?:sujets?|points?|elements?|choses?|questions?|actions?|taches?)\s+(?:merite|meritent|necessite|necessitent|demande|demandent|requiert|requierent|appelle|appellent)\s+(?:toute\s+)?votre\s+attention\b/;

const APOSTROPHES = /['\u2019\u2018\u201b\u02bc\u00b4`\u2032]/;
// Lot 75E : échappements (jamais de caractères combinants littéraux : un bundle
// servi sans charset les corrompait — constaté dans Chromium).
const DIACRITIQUES = /[\u0300-\u036f]/g;

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

const mots = (replie: string) => replie.split(/[^a-z0-9]+/).filter(Boolean);
const estNombre = (m: string) => NOMBRES.has(m) || /^\d+$/.test(m);

/** Nature d'une proposition (texte replié). */
type Nature = 'PREAMBULE' | 'DOUTEUX' | 'METIER';

function nature(replie: string): Nature {
  const m = mots(replie);
  if (m.length === 0) return 'METIER';
  // Tête : présentation éventuelle, nombre, adjectifs vides, objet compté.
  let i = 0;
  while (i < m.length && PRESENTATION.has(m[i]) && !estNombre(m[i])) i++;
  let tete = false;
  if (i < m.length && estNombre(m[i])) {
    let j = i + 1;
    let inconnus = 0;
    while (j < m.length && j <= i + 3 && !OBJETS.has(m[j])) {
      if (!ADJECTIFS.has(m[j])) inconnus++;
      j++;
    }
    tete = j < m.length && OBJETS.has(m[j]) && inconnus <= 1;
  }
  if (tete) {
    const inconnus = m.filter((x) => !(estNombre(x) || OBJETS.has(x) || ADJECTIFS.has(x) || PRESENTATION.has(x))).length;
    if (inconnus === 0) return 'PREAMBULE';
    // Une seule précision inconnue (« Deux sujets d'assurance ») : peut-être
    // une information — jamais découpée, mais jamais affichée telle quelle.
    if (inconnus === 1) return 'DOUTEUX';
    return 'METIER';
  }
  // « … et deux sujets méritent votre attention » au milieu d'un texte.
  return ATTENTION.test(replie) ? 'DOUTEUX' : 'METIER';
}

/** Une proposition : bornes dans le texte NFC, séparateur compris. */
interface Prop { debut: number; fin: number; texte: string; replie: string }

/**
 * Phrases du texte (fin : « . ! ? … ; » suivis d'un espace ou de la fin ;
 * « 142.50 », « 1er » ne coupent pas), puis propositions de chaque phrase
 * (fin : « : » « , » « ; » tiret entouré d'espaces, « – » « — »). Les
 * séparateurs restent dans leur proposition : recollées, elles redonnent le
 * texte à l'identique.
 */
function phrases(nfc: string, replie: string): Prop[][] {
  const out: Prop[][] = [];
  const fins = /[.!?…;]+(?=\s|$)/g;
  let debut = 0;
  const bornes: Array<[number, number]> = [];
  for (let m = fins.exec(replie); m; m = fins.exec(replie)) {
    let fin = m.index + m[0].length;
    while (fin < replie.length && replie[fin] === ' ') fin++;
    bornes.push([debut, fin]);
    debut = fin;
  }
  if (debut < replie.length) bornes.push([debut, replie.length]);
  for (const [a, b] of bornes) {
    const props: Prop[] = [];
    const sep = /\s*[:,;]\s*|\s+-\s+|\s*[–—]\s*/g;
    sep.lastIndex = a;
    let d = a;
    const segment = replie.slice(0, b);
    for (let m = sep.exec(segment); m && m.index < b; m = sep.exec(segment)) {
      if (m[0].length === 0) { sep.lastIndex++; continue; }
      const f = m.index + m[0].length;
      if (m.index > d) props.push({ debut: d, fin: f, texte: nfc.slice(d, f), replie: replie.slice(d, f) });
      else if (props.length) { props[props.length - 1].fin = f; props[props.length - 1].texte = nfc.slice(props[props.length - 1].debut, f); }
      d = f;
    }
    if (d < b) props.push({ debut: d, fin: b, texte: nfc.slice(d, b), replie: replie.slice(d, b) });
    if (props.length) out.push(props);
  }
  return out;
}

/** Ouverture seule (« Aujourd'hui, », « Bonjour, ») ? */
const estOuverture = (p: Prop) => OUVERTURES.has(mots(p.replie).join(' '));

/**
 * Classification d'un texte (pure, partagée composition / T6 / cache) :
 *   · `NONE` — aucune introduction : `text` = le texte, inchangé ;
 *   · `INTRO` — préambule(s) retiré(s) avec leur séparateur, majuscule rendue :
 *     `text` = l'information qui suit, INTÉGRALE ;
 *   · `INTRO_ONLY` — le texte n'était qu'une introduction : `text` vide ;
 *   · `UNSAFE` — introduction présente, mais séparation non fiable (préambule
 *     au milieu d'une phrase, précision inconnue) : `text` vide — l'appelant
 *     prend le texte de secours, jamais une découpe approximative.
 */
type CountingIntroKind = 'NONE' | 'INTRO' | 'INTRO_ONLY' | 'UNSAFE';
export function countingIntroOf(text: string | null | undefined): { kind: CountingIntroKind; text: string } {
  if (!text) return { kind: 'NONE', text: text ?? '' };
  const nfc = text.normalize('NFC');
  const replie = replier(nfc);
  const garde: string[] = [];
  let retire = false;
  for (const props of phrases(nfc, replie)) {
    const natures = props.map((p) => nature(p.replie));
    // Préambule en tête (éventuellement après « Aujourd'hui, »).
    let k = 0;
    if (props.length > 1 && estOuverture(props[0]) && natures[1] === 'PREAMBULE') k = 1;
    let tete = 0;
    if (natures[k] === 'PREAMBULE') tete = k + 1;
    // Toute autre introduction (douteuse, ou préambule hors tête) : séparation non fiable.
    if (natures.some((n, i) => i >= tete && n !== 'METIER')) return { kind: 'UNSAFE', text: '' };
    if (tete === 0) { garde.push(props.map((p) => p.texte).join('')); continue; }
    retire = true;
    const reste = props.slice(tete).map((p) => p.texte).join('');
    // Phrase réduite à sa ponctuation : retirée entière.
    if (/[\p{L}\p{N}]/u.test(reste)) garde.push(reste);
  }
  if (!retire) return { kind: 'NONE', text };
  const reste = garde.join('').replace(/\s+$/, '').replace(/^\s+/, '');
  if (!reste) return { kind: 'INTRO_ONLY', text: '' };
  return { kind: 'INTRO', text: reste.charAt(0).toLocaleUpperCase('fr-FR') + reste.slice(1) };
}

/** Le texte contient-il une introduction de comptage (y compris douteuse) ? (pure) */
export function hasCountingIntro(text: string | null | undefined): boolean {
  return countingIntroOf(text).kind !== 'NONE';
}

/**
 * Texte SANS introduction de comptage, information intégrale : « Un sujet
 * mérite votre attention aujourd'hui, ajoutez votre premier document… » →
 * « Ajoutez votre premier document… ». Vide quand il n'en reste rien, ou
 * quand la séparation n'est pas fiable (`UNSAFE`) : l'appelant reprend alors
 * le texte de secours (`displayableText`) — jamais une phrase inventée, jamais
 * une découpe approximative. Sans introduction : texte inchangé. Pure.
 */
export function stripCountingIntro(text: string): string {
  return countingIntroOf(text).text;
}

/**
 * Premier texte AFFICHABLE d'une liste de candidats (pure) : chacun est
 * débarrassé de son introduction ; vide ou non fiable → candidat suivant.
 * Rend '' si aucun ne convient (l'appelant décide : jamais un bloc vide).
 */
export function displayableText(candidates: ReadonlyArray<string | null | undefined>): string {
  for (const c of candidates) {
    const t = stripCountingIntro((c ?? '').trim()).trim();
    if (t) return t;
  }
  return '';
}
