/**
 * Termes de recherche d'une question — CDC §13.4 et §13.10.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI CE MODULE EXISTE
 *
 * Tout le retrieval fonctionne par correspondance de mots : les adaptateurs
 * passent la question entière dans un `ILIKE '%…%'` sur le nom des entités.
 * Une question qui ne nomme aucune entité ne ramène donc rien, et l'assistant
 * répond « je n'ai pas assez d'éléments ».
 *
 * C'est exactement ce qui se produit sur « j'ai quoi comme biens ? » — la
 * première question que pose un utilisateur qui découvre l'assistant, et celle
 * à laquelle il répondait le plus mal. Le CDC prévoyait la recherche D'UN bien
 * (§11.3) ; il n'avait pas prévu l'inventaire.
 *
 * Distinguer les deux cas ne demande pas de modèle : une question qui, une fois
 * retirés les mots outils et les mots génériques de catégorie, ne contient plus
 * aucun terme discriminant, ne cherche pas un objet — elle demande la liste.
 * ══════════════════════════════════════════════════════════════════════════
 */

/**
 * Mots outils du français, plus les formes interrogatives et possessives
 * fréquentes dans une question posée à un assistant.
 */
const MOTS_OUTILS = new Set([
  'a', 'ai', 'as', 'ait', 'au', 'aux', 'avec', 'avoir', 'c', 'ca', 'ce', 'ces',
  'cet', 'cette', 'combien', 'comme', 'd', 'dans', 'de', 'des', 'du', 'elle',
  'en', 'est', 'et', 'eu', 'il', 'ils', 'j', 'je', 'l', 'la', 'le', 'les',
  'leur', 'leurs', 'liste', 'lister', 'ma', 'mes', 'moi', 'mon', 'n', 'ne',
  'nos', 'notre', 'nous', 'on', 'ont', 'ou', 'par', 'pas', 'possede',
  'possedes', 'pour', 'qu', 'quel', 'quelle', 'quelles', 'quels', 'que',
  'qui', 'quoi', 's', 'sa', 'se', 'ses', 'son', 'sont', 'sur', 't', 'ta',
  'tes', 'toi', 'ton', 'tous', 'tout', 'toute', 'toutes', 'tu', 'un', 'une',
  'y', 'affiche', 'afficher', 'donne', 'donner', 'montre', 'montrer', 'voir',
  'dis', 'dire', 'connaitre', 'savoir', 'stp', 'svp', 'merci',
]);

/**
 * Mots de CATÉGORIE : ils disent de quelle famille d'objet on parle, jamais
 * duquel. « mes biens » nomme une famille ; « ma Clio » nomme un objet.
 *
 * Ils sont retirés des termes discriminants, mais c'est précisément leur
 * présence qui rend une question d'inventaire reconnaissable.
 */
const MOTS_CATEGORIE = new Set([
  'bien', 'biens', 'propriete', 'proprietes', 'patrimoine', 'possession',
  'possessions', 'objet', 'objets', 'actif', 'actifs',
  'maison', 'maisons', 'appartement', 'appartements', 'logement', 'logements',
  'immeuble', 'immeubles', 'terrain', 'terrains', 'residence', 'residences',
  'vehicule', 'vehicules', 'voiture', 'voitures', 'auto', 'moto', 'motos',
  'bateau', 'bateaux', 'velo', 'velos', 'caravane', 'camping',
]);

/** Retire les accents et la ponctuation, découpe en mots. */
function mots(message: string): string[] {
  return message
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’]/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Termes discriminants d'une question — ceux qui peuvent servir à retrouver un
 * objet précis. Un chiffre est conservé : « Clio 3 », « lot 12 ».
 */
export function extractSearchTerms(message: string): string[] {
  return mots(message).filter((m) => {
    // Une lettre isolée est du bruit ; un chiffre isolé ne l'est pas — il
    // distingue une « Clio 3 » d'une « Clio 4 », un « lot 2 » d'un « lot 7 ».
    if (m.length === 1 && !/^\d$/.test(m)) return false;
    return !MOTS_OUTILS.has(m) && !MOTS_CATEGORIE.has(m);
  });
}

/**
 * La question demande-t-elle la LISTE plutôt qu'un objet précis ?
 *
 * Deux conditions cumulatives :
 *   · aucun terme discriminant ne subsiste — sinon c'est une recherche ;
 *   · un mot de catégorie est présent — sinon la question ne porte pas sur les
 *     biens et lister le compte serait hors sujet.
 *
 * La seconde condition évite d'attraper « bonjour » ou « merci », qui ne
 * laissent eux non plus aucun terme discriminant.
 */
export function isInventoryQuery(message: string): boolean {
  const tous = mots(message);
  if (tous.length === 0) return false;
  if (!tous.some((m) => MOTS_CATEGORIE.has(m))) return false;
  return extractSearchTerms(message).length === 0;
}
