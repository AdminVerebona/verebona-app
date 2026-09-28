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

// ══════════════════════════════════════════════════════════════════════════
// DÉCOUPAGE DE LA REQUÊTE — CDC §11.2, §13.5
//
// Les adaptateurs recevaient la PHRASE ENTIÈRE et faisaient un
// `LIKE '%phrase%'` : « retrouve ma facture de plombier » ne trouvait jamais
// « Facture Plomberie Martin ». La requête est désormais découpée en termes :
//   · casse, accents, tirets et ponctuation normalisés ;
//   · mots outils et verbes de demande retirés ;
//   · singulier / pluriel ramenés à une racine (« factures » → « facture ») ;
//   · synonymes métier (« voiture » ↔ « véhicule », « CT » ↔ « contrôle
//     technique », « plombier » ↔ « plomberie »…) ;
//   · fautes simples tolérées au classement (distance d'édition ≤ 1 ou 2) ;
//   · immatriculations, numéros et dates conservés tels quels.
// ══════════════════════════════════════════════════════════════════════════

/** Verbes et tournures de DEMANDE : ils disent quoi faire, pas quoi chercher. */
const VERBES_DEMANDE = new Set([
  'retrouve', 'retrouver', 'retrouvez', 'trouve', 'trouver', 'trouvez', 'cherche', 'chercher', 'cherchez',
  'recherche', 'rechercher', 'ouvre', 'ouvrir', 'ouvrez', 'montrez', 'affichez', 'peux', 'peut', 'pouvez',
  'voudrais', 'veux', 'aimerais', 'besoin', 'est', 'ou', 'quand', 'comment', 'faut', 'svp', 'stp',
  'avez', 'avons', 'suis', 'sont', 'etait', 'etaient', 'dernier', 'derniere', 'derniers', 'dernieres',
  'concernant', 'propos', 'lie', 'lies', 'liee', 'liees', 'rattache', 'rattaches', 'rattachee',
  'vous', 'votre', 'vos', 'nos', 'avoir', 'fait', 'faire',
  // Mots de TYPE génériques : ils désignent une famille de résultats, pas un
  // contenu à retrouver dans un titre.
  'document', 'documents', 'fichier', 'fichiers', 'element', 'elements', 'resultat', 'resultats',
  'info', 'infos', 'information', 'informations',
]);

/** Synonymes métier (formes normalisées, sans accent). Symétriques. */
const SYNONYMES: string[][] = [
  ['voiture', 'vehicule', 'auto', 'automobile'],
  ['logement', 'maison', 'appartement', 'habitation'],
  ['facture', 'note', 'ticket', 'recu'],
  ['devis', 'estimation', 'proposition'],
  ['assurance', 'assureur', 'contrat'],
  ['entretien', 'revision', 'maintenance'],
  ['chaudiere', 'chauffage'],
  ['plombier', 'plomberie'],
  ['electricien', 'electricite'],
  ['garantie', 'extension'],
  ['ct', 'controle'],
  ['dpe', 'diagnostic'],
  ['notaire', 'acte'],
  ['impot', 'taxe'],
  ['fournisseur', 'artisan', 'prestataire', 'entreprise'],
  ['echeance', 'rappel', 'rendez'],
  ['velo', 'bicyclette'],
];

const SYNONYMES_PAR_MOT = new Map<string, string[]>();
for (const groupe of SYNONYMES) for (const m of groupe) SYNONYMES_PAR_MOT.set(m, groupe.filter((x) => x !== m));

/** Mot normalisé : minuscules, sans accent. */
export function normalizeWord(w: string): string {
  return w.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * Racine simple (singulier) : « factures » → « facture », « travaux » →
 * « travail » n'est PAS tenté (irrégulier) — seuls s / x finaux sont retirés.
 */
export function stemFr(w: string): string {
  if (w.length > 3 && /[a-z]s$/.test(w) && !/ss$/.test(w)) return w.slice(0, -1);
  if (w.length > 4 && /aux$/.test(w)) return w; // « travaux », « bureaux » : laissés tels quels
  if (w.length > 3 && /[a-z]x$/.test(w)) return w.slice(0, -1);
  return w;
}

export interface QueryTerm {
  /** Forme normalisée saisie. */
  raw: string;
  /** Racine (singulier). */
  stem: string;
  /** Formes équivalentes (synonymes métier, racines). */
  variants: string[];
  /** Identifiant, immatriculation, numéro ou date : correspondance exacte seulement. */
  exact: boolean;
}

/**
 * Découpe une question en termes de recherche. Les mots de CATÉGORIE sont
 * conservés (« facture maison » cherche aussi « maison ») ; les mots outils
 * et verbes de demande sont retirés.
 */
export function tokenizeQuery(message: string): QueryTerm[] {
  const brut = String(message ?? '');
  // Immatriculations (AB-123-CD) et dates (12/03/2024) : protégées avant découpage.
  const proteges = [
    ...(brut.match(/\b[A-Za-z]{2}-?\d{3}-?[A-Za-z]{2}\b/g) ?? []),
    ...(brut.match(/\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/g) ?? []),
  ];
  const reste = proteges.reduce((t, p) => t.replace(p, ' '), brut);
  const vus = new Set<string>();
  const out: QueryTerm[] = [];
  for (const p of proteges) {
    const n = normalizeWord(p);
    if (!vus.has(n)) { vus.add(n); out.push({ raw: n, stem: n, variants: [n.replace(/-/g, '')], exact: true }); }
  }
  for (const m of mots(reste)) {
    if (m.length === 1 && !/^\d$/.test(m)) continue;
    if (MOTS_OUTILS.has(m) || VERBES_DEMANDE.has(m)) continue;
    const stem = stemFr(m);
    if (vus.has(stem)) continue;
    vus.add(stem);
    const exact = /\d/.test(m);
    const syn = SYNONYMES_PAR_MOT.get(stem) ?? SYNONYMES_PAR_MOT.get(m) ?? [];
    out.push({ raw: m, stem, variants: [...new Set([stem, ...syn])], exact });
  }
  return out.slice(0, 8);
}

/**
 * Distance d'édition bornée (Damerau-Levenshtein restreinte : une inversion
 * de deux lettres voisines compte pour une faute), pour les fautes simples.
 */
export function editDistance(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let best = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cout = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cout);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      best = Math.min(best, d[i][j]);
    }
    if (best > max) return max + 1;
  }
  return d[a.length][b.length];
}

/** Tolérance aux fautes selon la longueur du mot (§11.2 « fautes simples »). */
function tolerance(len: number): number {
  return len >= 8 ? 2 : len >= 5 ? 1 : 0;
}

/**
 * Part des termes retrouvés dans un texte (0 à 1). Un terme compte 1 s'il est
 * présent (racine ou synonyme), 0,8 s'il n'est retrouvé qu'à une faute près.
 */
export function termMatchRatio(terms: QueryTerm[], text: string): number {
  if (terms.length === 0) return 0;
  const hay = normalizeWord(text);
  const motsTexte = hay.split(/[^a-z0-9]+/).filter(Boolean);
  const compact = hay.replace(/[^a-z0-9]/g, '');
  let total = 0;
  for (const t of terms) {
    if (t.exact) {
      if (hay.includes(t.raw) || t.variants.some((v) => compact.includes(v))) total += 1;
      continue;
    }
    if (t.variants.some((v) => motsTexte.some((w) => w === v || stemFr(w) === v || (v.length >= 4 && w.startsWith(v))))) { total += 1; continue; }
    const tol = tolerance(t.stem.length);
    if (tol > 0 && motsTexte.some((w) => editDistance(stemFr(w), t.stem, tol) <= tol)) total += 0.8;
  }
  return total / terms.length;
}

/**
 * Motifs SQL `LIKE` d'un terme : racine et synonymes, plus un préfixe court
 * pour les mots longs (une faute en fin de mot reste retrouvée, le classement
 * `termMatchRatio` écartant ensuite les faux positifs).
 */
export function likePatterns(t: QueryTerm): string[] {
  if (t.exact) return [...new Set([t.raw, ...t.variants])].map((v) => `%${v}%`);
  const base = t.variants.map((v) => `%${v}%`);
  if (t.stem.length >= 6) base.push(`%${t.stem.slice(0, Math.max(4, Math.ceil(t.stem.length * 0.6)))}%`);
  return [...new Set(base)];
}

/**
 * Motifs `LIKE` TOLÉRANTS (§11.4 « résultats proches ») : la racine amputée
 * de ses deux dernières lettres, et privée de ses deux premières — une faute
 * au début ou à la fin du mot reste retrouvée. Réservés à la seconde passe,
 * quand la recherche normale n'a rien donné.
 */
export function likePatternsTolerants(t: QueryTerm): string[] {
  if (t.exact || t.stem.length < 4) return likePatterns(t);
  const s = t.stem;
  return [...new Set([...likePatterns(t), `%${s.slice(0, Math.max(3, s.length - 2))}%`, `%${s.slice(2)}%`])];
}

/**
 * Part des termes retrouvés « à peu près » (§11.4) : jusqu'à deux fautes pour
 * un mot de 4 lettres ou plus, une pour un mot plus court. Sert à classer
 * les résultats proches, jamais les résultats normaux.
 */
export function nearMatchRatio(terms: QueryTerm[], text: string): number {
  if (terms.length === 0) return 0;
  const motsTexte = normalizeWord(text).split(/[^a-z0-9]+/).filter(Boolean);
  let total = 0;
  for (const t of terms) {
    if (t.exact) { if (normalizeWord(text).includes(t.raw)) total += 1; continue; }
    const tol = t.stem.length >= 4 ? 2 : 1;
    if (motsTexte.some((w) => t.variants.includes(w) || editDistance(stemFr(w), t.stem, tol) <= tol)) total += 1;
  }
  return total / terms.length;
}
