/**
 * Libellé naturel d'une échéance — lot 31, ticket T6 « fallback déterministe
 * des échéances » (DATE-NEXT, DATE-NEXT-2).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE TITRE D'AGENDA N'EST PAS UNE PHRASE
 *
 * `agendaItem.title` reste une donnée métier (transmise telle quelle à T6
 * dans les faits). Il n'est plus recopié entre guillemets dans le texte
 * d'accueil : le texte déterministe doit être présentable SANS T6 (T6
 * désactivé, en échec, rejeté — et affiché d'abord depuis le lot 26).
 *
 *   « Prochain contrôle technique — CUPRA LEON E-HYBRID180 » + bien « Cupra »
 *   (voiture) → « contrôle technique »
 *   → « Votre prochaine échéance est le contrôle technique de la Cupra, le
 *     18 avril 2028. »
 *
 * Règles, toutes GÉNÉRIQUES (aucun bien, aucune marque codés ici) :
 *   1. désignation du bien retirée seulement si elle CORRESPOND aux données
 *      du bien (nom, catégorie) : segment après un séparateur (« — », « – »,
 *      « - », « : », « | », parenthèses) qui partage un mot du nom du bien ;
 *      segment de tête entièrement fait du nom du bien ; nom exact du bien en
 *      fin de titre (« Révision Clio », « … pour Clio »). Jamais de recherche
 *      / remplacement libre dans le titre ;
 *   2. préfixe éditorial « Prochain(e)(s) » retiré en tête seulement, s'il
 *      reste un libellé ;
 *   3. articles construits sur une donnée CERTAINE : élision devant voyelle,
 *      sinon lexique fermé des noms d'échéance ci-dessous ; bien : genre du
 *      référentiel (`assetNameGrammar`, `@/lib/asset-taxonomy`). Sinon,
 *      formulation neutre (« Votre prochaine échéance concerne Cupra :
 *      contrôle technique, le 18 avril 2028. ») ;
 *   4. une date prévisionnelle est toujours dite estimée (DAT-003).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { assetCategoryLabel, assetNameGrammar, type GrammaticalGender } from '@/lib/asset-taxonomy';

const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’]/g, "'");
const mots = (s: string) => plain(s).split(/[^a-z0-9]+/).filter(Boolean);

/** Mots-outils : jamais un indice d'identité du bien. */
const MOTS_OUTILS = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'l', 'd', 'et', 'en', 'pour', 'mon', 'ma', 'mes', 'au', 'aux', 'a', 'un', 'une']);
const significatifs = (s: string) => mots(s).filter((w) => !MOTS_OUTILS.has(w) && (w.length >= 3 || /\d/.test(w)));

/**
 * Lexique FERMÉ des noms d'échéance dont le genre est connu (tête du
 * libellé). Un nom absent n'est pas deviné : formulation sans article.
 * `elide` : h muet (« l’hivernage »).
 */
const NOMS_ECHEANCE: Readonly<Record<string, { gender: GrammaticalGender; elide?: true }>> = {
  controle: { gender: 'm' }, ramonage: { gender: 'm' }, entretien: { gender: 'm' }, renouvellement: { gender: 'm' },
  remplacement: { gender: 'm' }, changement: { gender: 'm' }, paiement: { gender: 'm' }, reglement: { gender: 'm' },
  diagnostic: { gender: 'm' }, nettoyage: { gender: 'm' }, detartrage: { gender: 'm' }, desembouage: { gender: 'm' },
  contrat: { gender: 'm' }, abonnement: { gender: 'm' }, releve: { gender: 'm' }, bilan: { gender: 'm' },
  examen: { gender: 'm' }, passage: { gender: 'm' }, traitement: { gender: 'm' }, elagage: { gender: 'm' },
  debroussaillage: { gender: 'm' }, etalonnage: { gender: 'm' }, versement: { gender: 'm' }, loyer: { gender: 'm' },
  hivernage: { gender: 'm', elide: true }, carenage: { gender: 'm' }, parallelisme: { gender: 'm' },
  revision: { gender: 'f' }, vidange: { gender: 'f' }, visite: { gender: 'f' }, verification: { gender: 'f' },
  inspection: { gender: 'f' }, assurance: { gender: 'f' }, echeance: { gender: 'f' }, taxe: { gender: 'f' },
  declaration: { gender: 'f' }, garantie: { gender: 'f' }, maintenance: { gender: 'f' }, purge: { gender: 'f' },
  cotisation: { gender: 'f' }, facture: { gender: 'f' }, expiration: { gender: 'f' }, intervention: { gender: 'f' },
  reparation: { gender: 'f' }, resiliation: { gender: 'f' }, souscription: { gender: 'f' }, mise: { gender: 'f' },
  recharge: { gender: 'f' }, carte: { gender: 'f' }, location: { gender: 'f' }, fin: { gender: 'f' },
};

/** Voyelle initiale (le « y » initial est le plus souvent consonne : « la Yamaha »). */
const VOYELLE = /^[aeiouàâäéèêëîïôöùûüœæ]/i;

/**
 * Article défini d'un nom dont le genre est CONNU (lexique des échéances,
 * référentiel des biens) : `l’` devant voyelle ou h muet, sinon `le`/`la`.
 * Genre inconnu : `null` — rien n'est deviné, pas même l'élision (« Audit »
 * peut être un nom propre, « Entretiens » un pluriel).
 */
function article(nom: string, gender: GrammaticalGender | null, elide = false): string | null {
  if (gender === null) return null;
  if (elide || VOYELLE.test(nom)) return 'l’';
  if (gender === 'm') return 'le ';
  if (gender === 'f') return 'la ';
  return null;
}

/** « de » + article défini : « du », « de la », « de l’ ». */
const de = (art: string) => (art === 'le ' ? 'du ' : `de ${art}`);

// ── 1. Libellé ───────────────────────────────────────────────────────────────

/** Le segment désigne-t-il le bien ? (au moins un mot significatif du nom ou de la catégorie) */
function designeLeBien(segment: string, termes: string[]): boolean {
  const seg = new Set(significatifs(segment));
  return seg.size > 0 && termes.some((t) => significatifs(t).some((w) => seg.has(w)));
}

/** Segment fait UNIQUEMENT des mots du bien (tête « Cupra : vidange »). */
function seulementLeBien(segment: string, termes: string[]): boolean {
  const seg = significatifs(segment);
  const bien = new Set(termes.flatMap(significatifs));
  return seg.length > 0 && seg.every((w) => bien.has(w));
}

const SEPARATEUR = /\s+[—–\-:|]\s+/;
const CONNECTEUR_FINAL = /\s+(?:pour|de la|de l['’]|du|de|des)\s*$/i;

/** Retire en fin de libellé le nom exact du bien, et son connecteur (« Révision pour Clio »). */
function sansNomFinal(label: string, assetName: string): string {
  const cible = mots(assetName);
  if (cible.length === 0) return label;
  const brut = label.split(/\s+/);
  const norm = brut.map((w) => mots(w).join(' '));
  const fin = norm.slice(-cible.length).join(' ');
  if (brut.length <= cible.length || fin !== cible.join(' ')) return label;
  const reste = brut.slice(0, -cible.length).join(' ').replace(CONNECTEUR_FINAL, '').trim();
  return reste || label;
}

/** Tête du libellé (premier mot, normalisé). */
const tete = (label: string) => plain(label.split(/[\s’'-]+/)[0] ?? '');

/**
 * Minuscule initiale seulement pour un nom commun CERTAIN (tête du lexique) :
 * un mot inconnu peut être un nom propre ou un sigle (« Clio », « CT »).
 * Un libellé entièrement en capitales dont la tête est connue
 * (« CONTRÔLE TECHNIQUE ») est remis en minuscules.
 */
function minusculeInitiale(label: string): string {
  if (!NOMS_ECHEANCE[tete(label)]) return label;
  if (label === label.toLocaleUpperCase('fr')) return label.toLocaleLowerCase('fr');
  return label.charAt(0).toLocaleLowerCase('fr') + label.slice(1);
}

export interface DeadlineLabelInput {
  title: string;
  assetName?: string | null;
  /** Autres données du bien permettant de reconnaître sa désignation (catégorie…). */
  assetTerms?: Array<string | null | undefined>;
}

/**
 * Libellé naturel d'une échéance, à placer dans une phrase (pure, testée) :
 * « Prochain contrôle technique — CUPRA LEON E-HYBRID180 » + « Cupra »
 * → « contrôle technique ». Repli sur le titre si rien de sûr ne reste.
 */
export function deadlineDisplayLabel({ title, assetName, assetTerms = [] }: DeadlineLabelInput): string {
  const original = (title ?? '').replace(/\s+/g, ' ').trim();
  if (!original) return original;
  const termes = [assetName, ...assetTerms].filter((t): t is string => !!t && !!t.trim());
  let label = original;

  // Parenthèse finale qui désigne le bien : « Contrôle technique (Cupra) ».
  const paren = label.match(/^(.*\S)\s*\(([^()]+)\)$/);
  if (paren && designeLeBien(paren[2], termes)) label = paren[1];
  // Segments séparés : on retire la queue qui désigne le bien, la tête qui
  // n'est que lui ; les autres segments sont gardés, sans le séparateur
  // (« Assurance — Matmut » → « assurance Matmut »), dans une phrase.
  const segments = label.split(SEPARATEUR);
  while (segments.length > 1 && designeLeBien(segments[segments.length - 1], termes)) segments.pop();
  while (segments.length > 1 && seulementLeBien(segments[0], termes)) segments.shift();
  label = segments.join(' ');
  if (assetName) label = sansNomFinal(label, assetName);

  // Préfixe éditorial en tête, jamais ailleurs, jamais s'il ne reste rien.
  const sansPrefixe = label.replace(/^prochaine?s?\s+/i, '');
  if (sansPrefixe !== label && /[\p{L}\d]/u.test(sansPrefixe)) label = sansPrefixe;

  label = label.replace(/^[\s—–\-:|,]+|[\s—–\-:|,]+$/g, '').trim();
  return minusculeInitiale(label || original);
}

// ── 2. Phrases ───────────────────────────────────────────────────────────────

export interface DeadlineWordingItem {
  title: string;
  assetName: string | null;
  /** Famille (`assets.category`) et catégorie (`assets.subtype`) du bien, si connues. */
  assetCategory?: string | null;
  assetSubtype?: string | null;
}

interface Parts {
  label: string;
  /** Article défini du libellé (« le », « la », « l’ »), si certain. */
  art: string | null;
  gender: GrammaticalGender | null;
  /** « de la Cupra » / « la Cupra » si le genre du bien est certain. */
  bien: { de: string; ref: string } | null;
  assetName: string | null;
}

function parts(i: DeadlineWordingItem): Parts {
  const categorie = i.assetCategory
    ? assetCategoryLabel({ category: i.assetCategory, subtype: i.assetSubtype ?? null, objectCategory: null })
    : null;
  const label = deadlineDisplayLabel({ title: i.title, assetName: i.assetName, assetTerms: [categorie] });
  const lex = NOMS_ECHEANCE[tete(label)];
  const gender = lex?.gender ?? null;
  const grammaire = assetNameGrammar({ name: i.assetName, category: i.assetCategory, subtype: i.assetSubtype });
  const artBien = grammaire ? article(grammaire.name, grammaire.gender) : null;
  return {
    label,
    art: article(label, gender, lex?.elide),
    gender,
    bien: grammaire && artBien ? { de: `${de(artBien)}${grammaire.name}`, ref: `${artBien}${grammaire.name}` } : null,
    assetName: i.assetName?.trim() || null,
  };
}

/** Le libellé, sans article, avec sa majuscule (boutons « Voir « Contrôle technique » »). */
export function deadlineButtonLabel(i: DeadlineWordingItem): string {
  const { label } = parts(i);
  return label.charAt(0).toLocaleUpperCase('fr') + label.slice(1);
}

/**
 * DATE-NEXT — texte déterministe immédiatement affichable (pure, testée).
 *   · « Votre prochaine échéance est le contrôle technique de la Cupra, le 18 avril 2028. »
 *   · « … , prévu autour du 18 avril 2028 (date estimée). »
 *   · repli neutre : « Votre prochaine échéance concerne Cupra : contrôle technique, le 18 avril 2028. »
 */
export function deadlineNextText(i: DeadlineWordingItem & { forecast: boolean }, dateLabel: string): string {
  const p = parts(i);
  const neutre = i.forecast ? `autour du ${dateLabel} (date estimée)` : `le ${dateLabel}`;
  if (p.art && (p.bien || !p.assetName)) {
    const accord = p.gender === 'f' ? 'prévue' : p.gender === 'm' ? 'prévu' : null;
    const quand = i.forecast ? (accord ? `${accord} ${neutre}` : neutre) : neutre;
    return `Votre prochaine échéance est ${p.art}${p.label}${p.bien ? ` ${p.bien.de}` : ''}, ${quand}.`;
  }
  if (p.assetName) return `Votre prochaine échéance concerne ${p.bien ? p.bien.ref : p.assetName} : ${p.label}, ${neutre}.`;
  return `Votre prochaine échéance : ${p.label}, ${neutre}.`;
}

/** Élément d'une énumération : « le contrôle technique de la Cupra », « ramonage (Maison) ». */
function element(i: DeadlineWordingItem): string {
  const p = parts(i);
  const bien = p.bien ? ` ${p.bien.de}` : p.assetName ? ` (${p.assetName})` : '';
  return `${p.art ?? ''}${p.label}${bien}`;
}

/**
 * DATE-NEXT-2 — mêmes règles que DATE-NEXT (pure, testée) :
 * « Deux échéances sont prévues le 18 avril 2028 : le contrôle technique de
 * la Cupra et l’entretien de la chaudière. »
 */
export function deadlinePairText(a: DeadlineWordingItem, b: DeadlineWordingItem, dateLabel: string, forecast: boolean): string {
  const quand = forecast ? `autour du ${dateLabel} (date estimée)` : `le ${dateLabel}`;
  return `Deux échéances sont prévues ${quand} : ${element(a)} et ${element(b)}.`;
}
