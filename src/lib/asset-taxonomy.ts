/**
 * Classement des biens : Famille de bien → Catégorie de bien.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * SOURCE UNIQUE
 *
 * Les listes de sous-types étaient recopiées dans `AssetFormDialog` et
 * `AssetDetailsTab`, et divergeaient déjà du besoin (« Garage », « Local
 * commercial », pas d'Immeuble ni de Mobil-home, pas de Camping-car ni de
 * Bateau). Elles vivent désormais ici.
 *
 *   Famille        Catégories
 *   ─────────────  ───────────────────────────────────────────────────────
 *   Véhicule       Voiture ; Moto ; Vélo ; Camping-car ; Bateau ; Camion
 *   Immobilier     Maison ; Appartement ; Immeuble ; Terrain ; Garage/box ;
 *                  Mobil-home ; Local professionnel/commercial
 *   Objet          Tech / IT / Électronique ; Loisir / Sport ;
 *                  Maison & équipement
 *
 * ── STOCKAGE (INCHANGÉ) ───────────────────────────────────────────────────
 *
 *   - Famille           → `assets.category`   (VEHICULE | IMMOBILIER | OBJECT)
 *   - Catégorie Immo/Véhicule → `assets.subtype` (libellé, ex. « Maison »)
 *   - Catégorie Objet   → `assets.object_category` (OBJECT_CATEGORY_*)
 *
 * Le schéma n'est pas modifié : l'API, les exports, l'IA et le référentiel
 * documentaire V2 lisent déjà ces colonnes. Les deux libellés renommés sont
 * migrés en base (0138) et reconnus en lecture (`normalizeAssetCategory`).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { OBJECT_CATEGORY_LABELS, type ObjectCategory } from '@/types/domain';
import { RENAMED_ASSET_CATEGORIES } from './asset-category-legacy';

export type AssetFamilyCode = 'VEHICULE' | 'IMMOBILIER' | 'OBJECT';

export interface AssetCategoryOption {
  /** Valeur enregistrée (subtype, ou code OBJECT_CATEGORY_* pour Objet). */
  value: string;
  label: string;
  /**
   * Formulations UTILISATEUR de la catégorie, en plus de son libellé et de ses
   * anciens libellés (`asset-category-legacy`) : « auto » pour Voiture.
   * Reconnues partout (assistant, recherche) — jamais stockées.
   */
  userTerms?: readonly string[];
}

export interface AssetFamilyDefinition {
  code: AssetFamilyCode;
  label: string;
  categories: AssetCategoryOption[];
  /** Formulations utilisateur de la FAMILLE (« logement » pour Immobilier). */
  userTerms?: readonly string[];
}

const libelles = (values: string[], termes: Record<string, readonly string[]> = {}): AssetCategoryOption[] =>
  values.map((v) => ({ value: v, label: v, ...(termes[v] ? { userTerms: termes[v] } : {}) }));

/** Familles proposées, dans l'ordre d'affichage. */
export const ASSET_FAMILIES: AssetFamilyDefinition[] = [
  {
    code: 'VEHICULE',
    label: 'Véhicule',
    categories: libelles(['Voiture', 'Moto', 'Vélo', 'Camping-car', 'Bateau', 'Camion'], {
      Voiture: ['auto'],
      Moto: ['scooter'],
      'Vélo': ['bicyclette'],
      Camion: ['camionnette'],
    }),
    userTerms: ['automobile', 'caravane'],
  },
  {
    code: 'IMMOBILIER',
    label: 'Immobilier',
    categories: libelles([
      'Maison',
      'Appartement',
      'Immeuble',
      'Terrain',
      'Garage/box',
      'Mobil-home',
      'Local professionnel/commercial',
    ]),
    userTerms: ['logement', 'habitation', 'résidence', 'chalet', 'studio', 'villa'],
  },
  {
    code: 'OBJECT',
    label: 'Objet',
    categories: (Object.keys(OBJECT_CATEGORY_LABELS) as ObjectCategory[]).map((code) => ({
      value: code,
      label: OBJECT_CATEGORY_LABELS[code],
    })),
  },
];

const FAMILY_BY_CODE = new Map(ASSET_FAMILIES.map((f) => [f.code, f]));

export function getAssetFamily(code: string | null | undefined): AssetFamilyDefinition | undefined {
  return code ? FAMILY_BY_CODE.get(code as AssetFamilyCode) : undefined;
}

/** Libellé de famille (« Véhicule »…), repli sur le code. */
export function assetFamilyLabel(code: string | null | undefined): string {
  if (!code) return '';
  return getAssetFamily(code)?.label ?? LEGACY_FAMILY_LABELS[code] ?? code;
}

/**
 * Familles anciennes ou codes historiques — LEGACY_SUPPORTED : lisibles,
 * normalisées vers une famille actuelle, jamais proposées à la création.
 * `stored` : valeur encore possible dans `assets.category` (acceptée par
 * l'API pour ne pas rejeter un bien existant) ; `OBJET` est l'ancien code
 * de l'assistant, jamais stocké.
 */
export const LEGACY_ASSET_FAMILIES: Readonly<Record<string, { label: string; family: AssetFamilyCode; stored: boolean }>> = {
  MATERIEL_PRO: { label: 'Matériel pro', family: 'OBJECT', stored: true },
  AUTRE: { label: 'Autre', family: 'OBJECT', stored: true },
  OBJET: { label: 'Objet', family: 'OBJECT', stored: false },
};
const LEGACY_FAMILY_LABELS: Record<string, string> = Object.fromEntries(
  Object.entries(LEGACY_ASSET_FAMILIES).map(([code, f]) => [code, f.label]),
);

/** Statut d'un code de famille : proposé (ACTIVE), ancien mais lisible, inconnu. */
export type ReferentialStatus = 'ACTIVE' | 'LEGACY_SUPPORTED' | 'UNKNOWN';

/**
 * RÉSOLVEUR UNIQUE des familles (ticket « Référentiels » §B) : code actuel,
 * code historique (`MATERIEL_PRO`, `AUTRE`, `OBJET`) → famille actuelle.
 * `undefined` : valeur inconnue. Casse et espaces ignorés.
 * `toAssetFamily()` du registre canonique le délègue ici.
 */
export function toAssetFamilyCode(category: string | null | undefined): AssetFamilyCode | undefined {
  const c = category?.trim().toUpperCase();
  if (!c) return undefined;
  if (FAMILY_BY_CODE.has(c as AssetFamilyCode)) return c as AssetFamilyCode;
  return LEGACY_ASSET_FAMILIES[c]?.family;
}

export function assetFamilyStatus(category: string | null | undefined): ReferentialStatus {
  const c = category?.trim().toUpperCase();
  if (c && FAMILY_BY_CODE.has(c as AssetFamilyCode)) return 'ACTIVE';
  return c && LEGACY_ASSET_FAMILIES[c] ? 'LEGACY_SUPPORTED' : 'UNKNOWN';
}

/**
 * Valeurs de `assets.category` acceptées par l'API : familles proposées, puis
 * familles anciennes encore stockées (un bien existant reste modifiable).
 */
export const ACCEPTED_ASSET_CATEGORY_CODES: readonly string[] = [
  ...ASSET_FAMILIES.map((f) => f.code),
  ...Object.entries(LEGACY_ASSET_FAMILIES).filter(([, f]) => f.stored).map(([code]) => code),
];

/** Catégories d'une famille. Vide pour une famille inconnue. */
export function getAssetCategories(familyCode: string | null | undefined): AssetCategoryOption[] {
  return getAssetFamily(familyCode)?.categories ?? [];
}

/**
 * Anciens libellés → libellés actuels (données et saisies antérieures).
 * Table unique `asset-category-legacy` (partagée avec `asset-capabilities`).
 */
export const LEGACY_CATEGORY_ALIASES: Readonly<Record<string, string>> = RENAMED_ASSET_CATEGORIES;

/** Normalise une catégorie Immo/Véhicule saisie ou stockée sous un ancien libellé. */
export function normalizeAssetCategory(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return LEGACY_CATEGORY_ALIASES[trimmed.toLowerCase()] ?? trimmed;
}

/** Libellé de catégorie d'un bien, quelle que soit sa famille. */
export function assetCategoryLabel(asset: {
  category: string;
  subtype?: string | null;
  objectCategory?: string | null;
}): string | null {
  if (asset.category === 'OBJECT') {
    return asset.objectCategory
      ? OBJECT_CATEGORY_LABELS[asset.objectCategory as ObjectCategory] ?? asset.objectCategory
      : null;
  }
  return normalizeAssetCategory(asset.subtype);
}

// ══════════════════════════════════════════════════════════════════════════
// DÉSIGNATIONS DANS UN TEXTE (assistant T2, lot 29 — tickets 8a / 8b)
//
// « la maison », « mon appartement », « ma voiture », « mon véhicule » :
// une CATÉGORIE ou une FAMILLE désigne un bien quand elle est unique dans le
// compte. Le vocabulaire est DÉRIVÉ de ce référentiel (familles, catégories,
// anciens libellés) — aucun dictionnaire parallèle. Une catégorie précise
// n'est jamais élargie à sa famille : « la maison » ≠ « n'importe quel bien
// immobilier » (le rapprochement des biens est fait par l'appelant).
// ══════════════════════════════════════════════════════════════════════════

export interface AssetDesignation {
  /** `category` : une catégorie précise (Maison) ; `family` : une famille (Véhicule). */
  kind: 'category' | 'family';
  family: AssetFamilyCode;
  /** Catégorie stockée (`assets.subtype`), pour `kind: 'category'`. */
  category?: string;
  /** Forme reconnue dans le texte (normalisée). */
  matched: string;
}

const sansAccents = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Formes d'écriture d'un libellé : normalisé, tirets → espaces, alternatives « a/b ». */
function formesDeBase(libelle: string): string[] {
  const base = sansAccents(libelle).replace(/[’']/g, ' ').trim();
  const variantes = new Set<string>([base, base.replace(/-/g, ' ')]);
  // « Garage/box », « Local professionnel/commercial » : chaque alternative.
  if (base.includes('/')) {
    const [tete, ...alts] = base.split('/');
    variantes.add(tete.trim());
    const prefixe = tete.trim().split(' ').slice(0, -1).join(' ');
    for (const a of alts) variantes.add(`${prefixe ? `${prefixe} ` : ''}${a.trim()}`.trim());
    // Le libellé stocké lui-même (« garage/box ») reste reconnu (lot 30).
  }
  return [...variantes].filter((v) => v && v.length >= 3);
}

/** Formes reconnues d'un libellé : formes de base et pluriels simples. */
function formesDe(libelle: string): string[] {
  const out = new Set<string>();
  for (const v of formesDeBase(libelle)) {
    out.add(v);
    if (!/[sx]$/.test(v)) { out.add(`${v}s`); if (/(eau|au)$/.test(v)) out.add(`${v}x`); }
  }
  return [...out];
}

let vocabulaire: Array<{ forme: string; d: Omit<AssetDesignation, 'matched'> }> | null = null;

function vocabulaireDesignations(): Array<{ forme: string; d: Omit<AssetDesignation, 'matched'> }> {
  if (vocabulaire) return vocabulaire;
  const v: Array<{ forme: string; d: Omit<AssetDesignation, 'matched'> }> = [];
  for (const fam of ASSET_FAMILIES) {
    for (const terme of [fam.label, ...(fam.userTerms ?? [])]) {
      for (const forme of formesDe(terme)) v.push({ forme, d: { kind: 'family', family: fam.code } });
    }
    // Catégories Objet : stockées hors `subtype` (object_category), libellés
    // composés — seule la famille « objet » est reconnue dans un texte.
    if (fam.code === 'OBJECT') continue;
    for (const c of fam.categories) {
      for (const terme of [c.label, ...(c.userTerms ?? [])]) {
        for (const forme of formesDe(terme)) v.push({ forme, d: { kind: 'category', family: fam.code, category: c.value } });
      }
    }
  }
  for (const [ancien, actuel] of Object.entries(LEGACY_CATEGORY_ALIASES)) {
    const fam = ASSET_FAMILIES.find((f) => f.categories.some((c) => c.value === actuel));
    if (!fam) continue;
    for (const forme of formesDe(ancien)) {
      if (!v.some((x) => x.forme === forme)) v.push({ forme, d: { kind: 'category', family: fam.code, category: actuel } });
    }
  }
  // Formes longues d'abord (« camping car » avant « car »).
  vocabulaire = v.sort((a, b) => b.forme.length - a.forme.length);
  return vocabulaire;
}

/**
 * Catégories et familles de biens désignées dans un texte (pure, testée),
 * dans l'ordre d'apparition, sans recouvrement. Insensible à la casse et aux
 * accents ; « la maison », « mes voitures », « mon véhicule ».
 */
export function assetDesignationsIn(text: string): AssetDesignation[] {
  return reperer(text).trouves;
}

/** Repérage commun : désignations trouvées et texte normalisé où elles sont masquées par des `#`. */
function reperer(text: string): { trouves: AssetDesignation[]; masque: string } {
  let t = ` ${sansAccents(text ?? '').replace(/[’']/g, ' ').replace(/[^a-z0-9/ -]+/g, ' ').replace(/\s+/g, ' ')} `;
  const trouves: Array<{ pos: number; d: AssetDesignation }> = [];
  for (const { forme, d } of vocabulaireDesignations()) {
    const motif = ` ${forme} `;
    let i = t.indexOf(motif);
    while (i >= 0) {
      trouves.push({ pos: i, d: { ...d, matched: forme } });
      t = `${t.slice(0, i + 1)}${'#'.repeat(forme.length)}${t.slice(i + 1 + forme.length)}`;
      i = t.indexOf(motif);
    }
  }
  return { trouves: trouves.sort((a, b) => a.pos - b.pos).map((x) => x.d), masque: t };
}

/**
 * Texte normalisé (minuscules, sans accent) privé des désignations de biens
 * — familles, catégories, formulations, mots génériques (« biens ») —, y
 * compris les formes en plusieurs mots (« camping car », « local
 * commercial »). Pure ; sert aux termes discriminants d'une recherche.
 */
export function withoutAssetDesignations(text: string): string {
  const mots = reperer(text).masque.replace(/#+/g, ' ').split(' ');
  return mots.filter((w) => w && !formesGeneriques().has(w)).join(' ');
}

/** Catégorie stockée d'un bien (`subtype`) correspondant à une désignation de catégorie ? */
export function subtypeMatchesCategory(subtype: string | null | undefined, category: string): boolean {
  const s = normalizeAssetCategory(subtype);
  return !!s && sansAccents(s) === sansAccents(category);
}

/**
 * Options d'un sélecteur de catégorie : celles de la famille, plus la valeur
 * courante si elle n'y figure pas (catégorie ancienne comme « Studio ») —
 * pour ne jamais effacer silencieusement ce qui est enregistré.
 */
export function categoryOptionsWithCurrent(
  familyCode: string | null | undefined,
  current: string | null | undefined,
): AssetCategoryOption[] {
  const options = getAssetCategories(familyCode);
  const normalized = familyCode === 'OBJECT' ? current : normalizeAssetCategory(current);
  if (normalized && !options.some((o) => o.value === normalized)) {
    return [...options, { value: normalized, label: normalized }];
  }
  return options;
}

// ══════════════════════════════════════════════════════════════════════════
// VOCABULAIRE DES BIENS POUR L'ASSISTANT ET LA RECHERCHE (lot 30)
//
// T2 n'a plus de dictionnaire de biens propre (anciens `MOTS_CATEGORIE`,
// `FAMILY_WORDS`, `FAMILY_BY_WORD`, synonymes « voiture/véhicule »,
// démonstratif « cette maison ») : tout est DÉRIVÉ de ce référentiel —
// familles, catégories, formulations utilisateur (`userTerms`) et anciens
// libellés. Ajouter une catégorie ici suffit à la faire reconnaître partout.
// ══════════════════════════════════════════════════════════════════════════

/**
 * Mots GÉNÉRIQUES de bien : ils désignent les biens sans famille ni
 * catégorie (« mes biens », « mon patrimoine »).
 */
export const ASSET_GENERIC_TERMS: readonly string[] = ['bien', 'propriété', 'patrimoine', 'possession', 'actif'];

let generiques: Set<string> | null = null;
function formesGeneriques(): Set<string> {
  generiques ??= new Set(ASSET_GENERIC_TERMS.flatMap(formesDe));
  return generiques;
}

let motsSimples: Set<string> | null = null;
/**
 * Le MOT (normalisé, sans accent) désigne-t-il un bien, une famille ou une
 * catégorie (« maison », « voitures », « logement », « biens ») ? Pure.
 */
export function isAssetVocabularyWord(word: string): boolean {
  if (!motsSimples) {
    motsSimples = new Set(formesGeneriques());
    for (const { forme } of vocabulaireDesignations()) if (!forme.includes(' ')) motsSimples.add(forme);
  }
  return motsSimples.has(sansAccents(word ?? '').trim());
}

/** Famille désignée en premier dans un texte (catégorie → sa famille), sinon `undefined`. */
export function assetFamilyMentionedIn(text: string): AssetFamilyCode | undefined {
  return assetDesignationsIn(text)[0]?.family;
}

/**
 * Désignation de bien EN TÊTE d'un texte (« maison de Lyon » → `maison`,
 * « bien » → `bien`), forme normalisée ; `null` sinon. Sert aux
 * démonstratifs (« cette maison », « ce bien »).
 */
export function leadingAssetTerm(text: string): string | null {
  const d = leadingAssetDesignation(text);
  if (d) return d.matched;
  const t = ` ${normaliserTexte(text)} `;
  for (const g of formesGeneriques()) if (t.startsWith(` ${g} `)) return g;
  return null;
}

/** Désignation de famille ou de catégorie EN TÊTE d'un texte (« voitures de location » → Voiture), sinon `null`. */
export function leadingAssetDesignation(text: string): AssetDesignation | null {
  const t = ` ${normaliserTexte(text)} `;
  for (const { forme, d } of vocabulaireDesignations()) if (t.startsWith(` ${forme} `)) return { ...d, matched: forme };
  return null;
}

const normaliserTexte = (text: string) =>
  sansAccents(text ?? '').replace(/[’']/g, ' ').replace(/[^a-z0-9/ -]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Alternatives d'expression régulière (texte normalisé sans accent) de TOUT
 * le vocabulaire des biens : mots génériques, familles et leurs
 * formulations, et — sauf `families: true` — catégories et anciens libellés.
 * Formes longues d'abord ; espace ou tiret indifférents. Pour les motifs
 * d'aiguillage de l'assistant (lot 30 : plus de liste de mots figée).
 */
export function assetVocabularyAlternatives(opts: { familiesOnly?: boolean } = {}): string {
  const formes = new Set<string>(formesGeneriques());
  for (const { forme, d } of vocabulaireDesignations()) if (!opts.familiesOnly || d.kind === 'family') formes.add(forme);
  const esc = (f: string) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[ -]/g, '[ -]');
  return [...formes].sort((a, b) => b.length - a.length || a.localeCompare(b)).map(esc).join('|');
}

/**
 * Formes équivalentes d'un mot de bien pour la RECHERCHE textuelle (pure) :
 * une famille → ses formulations ; une catégorie → les siennes et celles de
 * sa famille (« voiture » → véhicule, auto, automobile). Mots simples au
 * singulier, le mot lui-même exclu. Vide pour un mot qui n'est pas un bien.
 */
export function assetSearchSynonyms(word: string): string[] {
  const w = sansAccents(word ?? '').trim();
  if (!w) return [];
  const d = assetDesignationsIn(w).find((x) => x.matched === w || x.matched === `${w}s`);
  if (!d) return [];
  const fam = ASSET_FAMILIES.find((f) => f.code === d.family)!;
  const termes = [fam.label, ...(fam.userTerms ?? [])];
  if (d.kind === 'category') {
    const c = fam.categories.find((x) => x.value === d.category);
    termes.push(...(c ? [c.label, ...(c.userTerms ?? [])] : []));
    termes.push(...Object.entries(LEGACY_CATEGORY_ALIASES).filter(([, actuel]) => actuel === d.category).map(([ancien]) => ancien));
  }
  const out = new Set<string>();
  for (const t of termes) for (const f of formesDeBase(t)) if (!/[ /-]/.test(f) && f !== w) out.add(f);
  return [...out];
}
