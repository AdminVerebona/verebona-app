/**
 * Rapprochement document ↔ équipement — règles PURES et contextes T3
 * (lot 71A : BUG P1 « confusion bien / équipement », point B ; ticket P1
 * « Enrichir les données transmises à T3 pour le rapprochement
 * documents–équipements » ; lot 75G : écarts résiduels).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DÉTERMINISTE D'ABORD, JAMAIS DE CHOIX ARBITRAIRE
 *
 * Univers : les équipements ACTUELS (non archivés) DU OU DES BIENS du
 * document, dans son compte. Chaque INDICE du document désigne un
 * équipement, ou il est ambigu :
 *   · VERIFIED_TARGET : fait T1 STRUCTURÉ (`document_facts`) ciblant un
 *                       équipement vérifié de ce bien — CERTAIN ;
 *   · SERIAL_NUMBER   : n° de série exact (normalisé, ≥ 5 caractères dont un
 *                       chiffre), UNIQUE parmi les équipements du bien —
 *                       CERTAIN s'il est lu dans les données structurées
 *                       (titre, description, faits), FORT s'il n'est lu que
 *                       dans une source secondaire (lot 75G : unité source,
 *                       fait non résolu) ;
 *   · BRAND_MODEL     : modèle lu identique (marque compatible) — FORT ;
 *   · DESIGNATION     : nom de l'équipement lu dans le titre / une
 *                       désignation — FORT ;
 *   · GENERIC_DESIGNATION (lot 75G) : mot de tête commun à PLUSIEURS
 *                       équipements (« radiateur » face à « Radiateur
 *                       salon » et « Radiateur chambre ») — jamais un lien,
 *                       seulement une ambiguïté à arbitrer.
 * La catégorie ou le type seuls ne suffisent JAMAIS ; un champ absent n'est
 * jamais une correspondance ; une simple mention dans un bloc de texte
 * (unité source) n'est jamais une désignation — seuls des codes exacts (n°
 * de série, modèle) y sont recherchés.
 *
 * COMBINAISON (lot 75G, écarts A / B) : les liens CERTAINS et FORTS
 * COMPATIBLES sont fusionnés (facture « chaudière par n° de série + VMC par
 * modèle » → deux liens). Un indice fort qui désigne un équipement SEMBLABLE
 * (même modèle, nom inclus dans l'autre) à un équipement certain est écarté ;
 * deux indices forts désignant deux équipements semblables deviennent une
 * ambiguïté. Les ambiguïtés sont rendues par GROUPE : un groupe dont un
 * membre est rattaché est « expliqué » et disparaît ; les autres restent à
 * arbitrer (T3 ou carte LINK-ELT) SANS annuler les liens certains.
 *
 * CONTEXTE T3 (lot 75G, écart F) : bornes de taille conservées, mais
 * priorité aux identifiants EXACTS, au bien parent, aux cibles et preuves ;
 * un identifiant n'est JAMAIS coupé (segment omis en entier) ; les
 * équipements « à ne pas confondre » sont choisis par pertinence. Jamais la
 * date ni le prix d'achat du bien comme caractéristique de l'équipement.
 * ══════════════════════════════════════════════════════════════════════════
 */

export interface EquipmentProfile {
  id: number;
  assetId: number;
  assetName: string | null;
  name: string;
  type: string | null;
  category: string | null;
  /** Valeurs CANONIQUES de la fiche de l'équipement (repli : colonnes miroirs). */
  brand: string | null;
  model: string | null;
  serialNumber: string | null;
  room: string | null;
  /** Caractéristiques distinctives (puissance, COP, fluide, usage énergétique…), libellées. */
  features: string[];
}

/**
 * Provenance d'une information documentaire (lot 75G, écart B) :
 *   · FACT        `document_facts` actif (donnée structurée canonique) ;
 *   · UNRESOLVED  `document_unresolved_facts` UNRESOLVED / RETAINED (clé et
 *                 valeur lues, non intégrées par T1) ;
 *   · SOURCE_UNIT `document_source_units` « libellé : valeur » couvert ou
 *                 non résolu.
 */
export type DocumentInfoProvenance = 'FACT' | 'UNRESOLVED' | 'SOURCE_UNIT';

export interface DocumentFactProfile {
  key: string;
  value: string;
  label: string | null;
  targetType: string | null;
  targetId: number | null;
  targetLabel: string | null;
  excerpt: string | null;
  /** Absente : FACT. */
  provenance?: DocumentInfoProvenance;
}

export interface DocumentProfile {
  fileId: number;
  title: string | null;
  typeCode: string | null;
  description: string | null;
  supplier: string | null;
  documentDate: string | null;
  amountCents: number | null;
  assetIds: number[];
  assetNames: string[];
  facts: DocumentFactProfile[];
  /**
   * Lot 75G : textes des unités source (blocs, lignes de tableau) — n'y sont
   * recherchés QUE des codes exacts (n° de série, modèle) ; jamais transmis
   * tels quels à T3.
   */
  sourceTexts?: string[];
}

export type MatchMethod = 'VERIFIED_TARGET' | 'SERIAL_NUMBER' | 'BRAND_MODEL' | 'DESIGNATION' | 'GENERIC_DESIGNATION';

export interface EquipmentMatch {
  equipmentId: number;
  method: MatchMethod;
  score: number;
  reason: string;
}

export interface MatchResult {
  status: 'LINKED' | 'AMBIGUOUS' | 'NONE';
  /** Équipements désignés sans ambiguïté (certains et forts compatibles). */
  links: EquipmentMatch[];
  /** Équipements en concurrence (groupes résiduels aplatis), jamais liés automatiquement. */
  ambiguous: EquipmentMatch[];
  /** Groupes d'ambiguïté résiduels (≥ 2 équipements chacun, ids triés). */
  groups: number[][];
}

// ── Normalisation ───────────────────────────────────────────────────────────

const sansAccents = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
/** « FR-2026 001 » → « FR2026001 ». */
export const compactCode = (s: string | null | undefined) => sansAccents(String(s ?? '')).toUpperCase().replace(/[^A-Z0-9]/g, '');
/** Texte en mots séparés par une espace, minuscules, sans accents. */
export const words = (s: string | null | undefined) => ` ${sansAccents(String(s ?? '')).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
const codeExploitable = (c: string) => c.length >= 5 && /\d/.test(c);

const CLE_SERIE = /(s[ée]rie|serial|\bs\/?n\b|num[ée]ro de s)/i;
const CLE_MODELE = /(mod[eè]le|model|r[ée]f[ée]rence produit|\bref(erence)?\b)/i;
const CLE_MARQUE = /(marque|brand|fabricant|manufacturer|constructeur)/i;
const CLE_DESIGNATION = /(d[ée]signation|article|libell[ée]|produit|appareil|[ée]quipement)/i;

const factKeyText = (f: DocumentFactProfile) => `${f.key} ${f.label ?? ''}`;
const isSerialFact = (f: DocumentFactProfile) => f.key === 'serialNumber' || f.key === 'vin' || CLE_SERIE.test(factKeyText(f));
const isModelFact = (f: DocumentFactProfile) => f.key === 'modelName' || f.key === 'model' || (!isSerialFact(f) && CLE_MODELE.test(factKeyText(f)));
const isBrandFact = (f: DocumentFactProfile) => f.key === 'brand' || f.key === 'make' || CLE_MARQUE.test(factKeyText(f));
const isDesignationFact = (f: DocumentFactProfile) => !isSerialFact(f) && CLE_DESIGNATION.test(factKeyText(f));
const isPrimary = (f: DocumentFactProfile) => (f.provenance ?? 'FACT') === 'FACT';

/** Identifiants lus sur le document (valeurs brutes, dédoublonnées ; structurés d'abord). */
export function documentIdentifiers(d: DocumentProfile): { serials: string[]; models: string[]; brands: string[]; designations: string[] } {
  const ordre = [...d.facts.filter(isPrimary), ...d.facts.filter((f) => !isPrimary(f))];
  const uniq = (xs: string[]) => {
    const vus = new Set<string>();
    return xs.map((x) => x.trim()).filter((x) => {
      const k = compactCode(x);
      if (!x || !k || vus.has(k)) return false;
      vus.add(k);
      return true;
    });
  };
  return {
    serials: uniq(ordre.filter(isSerialFact).map((f) => f.value)),
    models: uniq(ordre.filter(isModelFact).map((f) => f.value)),
    brands: uniq(ordre.filter(isBrandFact).map((f) => f.value)),
    designations: uniq([
      ...ordre.filter(isDesignationFact).map((f) => f.value),
      ...ordre.filter((f) => isPrimary(f) && f.targetType === 'EQUIPMENT' && f.targetLabel).map((f) => f.targetLabel as string),
    ]),
  };
}

const MOTS_VIDES = new Set(['le', 'la', 'les', 'des', 'du', 'de', 'un', 'une', 'et', 'ou', 'au', 'aux', 'en', 'pour', 'sur', 'avec']);
/** Mot de tête d'un nom d'équipement (« Radiateur salon » → « radiateur »), ≥ 5 lettres. */
function motDeTete(name: string): string | null {
  const w = words(name).trim().split(' ').find((x) => !MOTS_VIDES.has(x));
  return w && w.length >= 5 && !/^\d+$/.test(w) ? w : null;
}

/** Deux équipements « semblables » : même modèle, ou nom inclus dans l'autre. */
function semblables(a: EquipmentProfile, b: EquipmentProfile): boolean {
  const ma = compactCode(a.model);
  if (ma.length >= 3 && ma === compactCode(b.model)) return true;
  const na = words(a.name);
  const nb = words(b.name);
  return na.trim().length >= 4 && nb.trim().length >= 4 && (na.includes(nb) || nb.includes(na));
}

// ── Rapprochement (pur) ─────────────────────────────────────────────────────

/** Décision déterministe document → équipements du bien (pure, testée). */
export function matchDocumentToEquipments(doc: DocumentProfile, equipments: readonly EquipmentProfile[]): MatchResult {
  const parId = new Map(equipments.map((e) => [e.id, e]));
  const certains = new Map<number, EquipmentMatch>();
  const forts = new Map<number, EquipmentMatch>();
  const groupes: EquipmentMatch[][] = [];
  const garder = (m: Map<number, EquipmentMatch>, x: EquipmentMatch) => { if (!m.has(x.equipmentId)) m.set(x.equipmentId, x); };
  const ident = documentIdentifiers(doc);
  const primaires = doc.facts.filter(isPrimary);
  const secondaires = doc.facts.filter((f) => !isPrimary(f));

  // 1. Faits T1 STRUCTURÉS ciblant un équipement vérifié DU bien.
  for (const f of primaires) {
    if (f.targetType !== 'EQUIPMENT' || f.targetId == null || !parId.has(f.targetId)) continue;
    garder(certains, { equipmentId: f.targetId, method: 'VERIFIED_TARGET', score: 1, reason: `Fait « ${f.label ?? f.key} » lu pour cet équipement` });
  }

  // 2. N° de série exact et unique (certain : données structurées ; fort : source secondaire).
  const textePrimaire = compactCode([doc.title, doc.description, ...primaires.flatMap((f) => [f.value, f.excerpt])].join(' '));
  const texteSecondaire = compactCode([...secondaires.flatMap((f) => [f.value, f.excerpt]), ...(doc.sourceTexts ?? [])].join(' '));
  const seriesPrim = new Set(primaires.filter(isSerialFact).map((f) => compactCode(f.value)).filter(codeExploitable));
  const seriesSec = new Set(secondaires.filter(isSerialFact).map((f) => compactCode(f.value)).filter(codeExploitable));
  const seriesVues = new Set<string>();
  for (const e of equipments) {
    const s = compactCode(e.serialNumber);
    if (!codeExploitable(s) || seriesVues.has(s)) continue;
    const primaire = seriesPrim.has(s) || textePrimaire.includes(s);
    const secondaire = !primaire && (seriesSec.has(s) || texteSecondaire.includes(s));
    if (!primaire && !secondaire) continue;
    seriesVues.add(s);
    const memes = equipments.filter((x) => compactCode(x.serialNumber) === s);
    const m: EquipmentMatch = primaire
      ? { equipmentId: e.id, method: 'SERIAL_NUMBER', score: 1, reason: `N° de série ${e.serialNumber} lu dans le document` }
      : { equipmentId: e.id, method: 'SERIAL_NUMBER', score: 0.95, reason: `N° de série ${e.serialNumber} lu dans une unité source ou un fait non résolu` };
    if (memes.length === 1) garder(primaire ? certains : forts, m);
    else groupes.push(memes.map((x) => ({ ...m, equipmentId: x.id })));
  }

  // 3. Modèle lu (marque compatible).
  const toutTexte = `${textePrimaire} ${texteSecondaire}`;
  const modelesLus = new Set(ident.models.map(compactCode).filter((c) => c.length >= 3));
  const marquesLues = ident.brands.map(compactCode).filter(Boolean);
  const parModele = new Map<string, EquipmentProfile[]>();
  for (const e of equipments) {
    const mo = compactCode(e.model);
    if (mo.length < 3) continue;
    const lu = modelesLus.has(mo) || (codeExploitable(mo) && toutTexte.includes(mo));
    if (!lu) continue;
    const marque = compactCode(e.brand);
    if (marque && marquesLues.length > 0 && !marquesLues.some((b) => b.includes(marque) || marque.includes(b))) continue;
    parModele.set(mo, [...(parModele.get(mo) ?? []), e]);
  }
  for (const [mo, es] of parModele) {
    const memeModele = equipments.filter((x) => compactCode(x.model) === mo);
    const ms = es.map((e): EquipmentMatch => ({ equipmentId: e.id, method: 'BRAND_MODEL', score: 0.9, reason: `Modèle ${e.brand ? `${e.brand} ` : ''}${e.model} lu dans le document` }));
    if (memeModele.length === 1) garder(forts, ms[0]);
    else groupes.push(memeModele.map((x) => ({ ...ms[0], equipmentId: x.id, reason: `Modèle ${x.model} commun à plusieurs équipements` })));
  }

  // 4. Désignation : nom de l'équipement lu dans le titre ou une désignation.
  const designations = words([doc.title, ...ident.designations].join(' | '));
  const noms = equipments.map((e) => ({ e, n: words(e.name) }));
  const designes = new Set<number>();
  for (const { e, n } of noms) {
    if (n.trim().length < 4 || !designations.includes(n)) continue;
    designes.add(e.id);
    // Un nom plus précis aussi lu l'emporte ; un nom identique, ou plus précis
    // mais NON lu, rend l'indice ambigu (« Robot aspirateur » ⊂ « Robot aspirateur étage »).
    const plusPrecisLu = noms.some((x) => x.e.id !== e.id && x.n !== n && x.n.includes(n) && designations.includes(x.n));
    if (plusPrecisLu) continue;
    const concurrents = noms.filter((x) => x.e.id !== e.id && (x.n === n || x.n.includes(n)));
    const m: EquipmentMatch = { equipmentId: e.id, method: 'DESIGNATION', score: 0.85, reason: `« ${e.name} » désigné par le document` };
    if (concurrents.length === 0) garder(forts, m);
    else groupes.push([e, ...concurrents.map((c) => c.e)].map((x) => ({ ...m, equipmentId: x.id, reason: `« ${x.name} » : désignation commune « ${e.name} »` })));
  }

  // 5. Désignation GÉNÉRIQUE (mot de tête commun à plusieurs équipements) : ambiguïté seulement.
  const texteGenerique = words([doc.title, doc.description, ...ident.designations].join(' | '));
  const parTete = new Map<string, EquipmentProfile[]>();
  for (const e of equipments) {
    const t = motDeTete(e.name);
    if (t) parTete.set(t, [...(parTete.get(t) ?? []), e]);
  }
  for (const [t, es] of parTete) {
    if (es.length < 2 || !texteGenerique.includes(` ${t} `) || es.some((e) => designes.has(e.id))) continue;
    groupes.push(es.map((e) => ({ equipmentId: e.id, method: 'GENERIC_DESIGNATION', score: 0.5, reason: `Désignation générique « ${t} » commune à plusieurs équipements` })));
  }

  // ── Combinaison ──
  const liens = new Map(certains);
  const fortsRetenus = [...forts.values()].filter((f) => !liens.has(f.equipmentId)
    && ![...certains.keys()].some((id) => semblables(parId.get(id)!, parId.get(f.equipmentId)!)));
  for (const f of fortsRetenus) {
    const jumeaux = fortsRetenus.filter((x) => x.equipmentId !== f.equipmentId && semblables(parId.get(x.equipmentId)!, parId.get(f.equipmentId)!));
    if (jumeaux.length === 0) liens.set(f.equipmentId, f);
    else groupes.push([f, ...jumeaux]);
  }
  const tri = (xs: Iterable<EquipmentMatch>) => [...xs].sort((a, b) => a.equipmentId - b.equipmentId);
  const links = tri(liens.values());

  // Groupes résiduels : un groupe dont un membre est rattaché est expliqué ; doublons fusionnés.
  const residuels = new Map<string, EquipmentMatch[]>();
  for (const g of groupes) {
    const membres = tri(new Map(g.map((x) => [x.equipmentId, x])).values());
    if (membres.length < 2 || membres.some((x) => liens.has(x.equipmentId))) continue;
    const cle = membres.map((x) => x.equipmentId).join(',');
    if (!residuels.has(cle)) residuels.set(cle, membres);
  }
  const groups = [...residuels.values()].map((g) => g.map((x) => x.equipmentId));
  const ambiguous = tri(new Map([...residuels.values()].flat().map((x) => [x.equipmentId, x])).values());
  const status = links.length > 0 ? 'LINKED' : groups.length > 0 ? 'AMBIGUOUS' : 'NONE';
  return { status, links, ambiguous, groups };
}

/**
 * Groupes d'ambiguïté qui restent à arbitrer, une fois retirés ceux qu'un
 * lien ACTIF existant (toutes origines) explique déjà (pure, testée).
 */
export function unresolvedGroups(groups: readonly number[][], alreadyLinked: ReadonlySet<number>): number[][] {
  return groups.filter((g) => g.length >= 2 && !g.some((id) => alreadyLinked.has(id)));
}

// ── Contextes T3 (purs) ─────────────────────────────────────────────────────

/** Longueur maximale d'une ligne candidate (lue par `parseCandidates`). */
export const T3_CANDIDATE_MAX = 1000;
/** Longueur maximale du sujet transmis à T3. */
export const T3_SUBJECT_MAX = 3000;
/** Un « identifiant » plus long n'en est pas un : il est omis, jamais coupé. */
const IDENTIFIANT_MAX = 120;

const net = (s: string | null | undefined, max = 160) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
/** Identifiant ENTIER (espaces normalisés) ou null s'il est trop long — jamais tronqué. */
const entier = (s: string | null | undefined): string | null => {
  const v = (s ?? '').replace(/\s+/g, ' ').trim();
  return v && v.length <= IDENTIFIANT_MAX ? v : null;
};

/**
 * Assemble des segments par ordre de priorité sans dépasser `max` : un
 * segment qui ne tient pas est omis (jamais coupé au milieu d'un
 * identifiant), les suivants (moins prioritaires) aussi s'ils ne tiennent pas.
 */
export function joinWithinLimit(segments: Array<string | null | undefined>, max: number, sep = ' | '): string {
  let out = '';
  for (const s of segments) {
    if (!s) continue;
    const next = out ? `${out}${sep}${s}` : s;
    if (next.length > max) continue;
    out = next;
  }
  return out;
}

/**
 * Segments « libellé:v1, v2, … » ne contenant que des valeurs ENTIÈRES ; au
 * besoin plusieurs segments (« (suite) ») pour qu'aucune valeur ne soit
 * perdue par une borne de segment.
 */
function segmentsIdentifiants(libelle: string, valeurs: string[], max = 400): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  const rendu = (xs: string[], suite: boolean) => `${libelle}${suite ? ' (suite)' : ''}:${xs.join(', ')}`;
  for (const v of valeurs.map(entier).filter((x): x is string => !!x)) {
    if (cur.length && rendu([...cur, v], out.length > 0).length > max) { out.push(rendu(cur, out.length > 0)); cur = []; }
    cur.push(v);
  }
  if (cur.length) out.push(rendu(cur, out.length > 0));
  return out;
}

/** Description discriminante d'un équipement (sans aucune donnée d'achat du bien), identifiants d'abord. */
export function equipmentDescriptor(e: EquipmentProfile): string[] {
  const id = (label: string, v: string | null) => { const x = entier(v); return x ? `${label}:${x}` : null; };
  return [
    `"${net(e.name, 120)}"`,
    `bien parent:#${e.assetId}${e.assetName ? ` "${net(e.assetName, 60)}"` : ''}`,
    id('marque', e.brand),
    id('modèle', e.model),
    id('n° de série', e.serialNumber),
    e.type ? `type:${net(e.type, 60)}` : null,
    e.category ? `catégorie:${net(e.category, 60)}` : null,
    e.room ? `pièce:${net(e.room, 60)}` : null,
    ...e.features.map((f) => net(f, 80)),
  ].filter((x): x is string => !!x);
}

/** Ligne candidate « [id:N] … » d'un équipement (DOCUMENT_EQUIPMENT). */
export function formatEquipmentCandidate(e: EquipmentProfile): string {
  return `[id:${e.id}] ${joinWithinLimit(equipmentDescriptor(e), T3_CANDIDATE_MAX - 12)}`;
}

/** Rang de priorité d'un fait (0 = n° de série … 4 = autre ; source secondaire : après). */
function rangFait(f: DocumentFactProfile): number {
  const r = isSerialFact(f) ? 0 : isModelFact(f) || isBrandFact(f) ? 1 : f.targetType === 'EQUIPMENT' ? 2 : isDesignationFact(f) ? 3 : 4;
  return isPrimary(f) ? r : r + 0.5;
}

/** Faits utiles au rapprochement, identifiants d'abord, structurés avant les sources secondaires. */
function factsPrioritaires(d: DocumentProfile): DocumentFactProfile[] {
  return d.facts.map((f, i) => ({ f, i })).sort((a, b) => rangFait(a.f) - rangFait(b.f) || a.i - b.i).map((x) => x.f);
}

const factDescriptor = (f: DocumentFactProfile) => {
  const cible = f.targetType ? ` [cible ${f.targetType}${f.targetId != null ? `#${f.targetId}` : ''}${f.targetLabel ? ` « ${net(f.targetLabel, 60)} »` : ''}]` : '';
  const extrait = f.excerpt ? ` « ${net(f.excerpt, 120)} »` : '';
  const source = isPrimary(f) ? '' : f.provenance === 'UNRESOLVED' ? ' (fait non résolu)' : ' (unité source)';
  const valeur = isSerialFact(f) || isModelFact(f) ? entier(f.value) : net(f.value, 80);
  return valeur === null ? null : `${net(f.label ?? f.key, 60)} = ${valeur}${cible}${extrait}${source}`;
};

/** Métadonnées du document : tête (titre, biens parents) et compléments. */
function documentMeta(d: DocumentProfile): { head: string; parents: string | null; rest: string[] } {
  return {
    head: `Document #${d.fileId}${d.title ? ` « ${net(d.title, 140)} »` : ''}`,
    parents: d.assetIds.length ? `bien(s) parent(s):${d.assetIds.map((id, i) => `#${id}${d.assetNames[i] ? ` "${net(d.assetNames[i], 60)}"` : ''}`).join(', ')}` : null,
    rest: [
      d.typeCode ? `type:${d.typeCode}` : null,
      d.documentDate ? `date du document:${d.documentDate}` : null,
      d.supplier ? `fournisseur:"${net(d.supplier, 80)}"` : null,
      d.amountCents != null ? `montant du document:${(d.amountCents / 100).toFixed(2)}€` : null,
    ].filter((x): x is string => !!x),
  };
}

/** Identifiants lus, par ordre de pouvoir discriminant (n° de série, modèle, marque), puis désignations. */
function identifiantsLus(d: DocumentProfile): { exacts: string[]; designations: string[] } {
  const i = documentIdentifiers(d);
  return {
    exacts: [
      ...segmentsIdentifiants('n° de série lu(s)', i.serials),
      ...segmentsIdentifiants('modèle(s) lu(s)', i.models),
      ...segmentsIdentifiants('marque(s) lue(s)', i.brands),
    ],
    designations: segmentsIdentifiants('désignation(s) d’équipement lue(s)', i.designations.map((x) => `"${net(x, 80)}"`)),
  };
}

/** SUBJECT_CONTEXT d'un document (DOCUMENT_EQUIPMENT) : identifiants exacts, bien parent, cibles et preuves d'abord. */
export function formatDocumentSubject(d: DocumentProfile): string {
  const meta = documentMeta(d);
  const ids = identifiantsLus(d);
  const faits = factsPrioritaires(d).map((f) => ({ f, s: factDescriptor(f) })).filter((x): x is { f: DocumentFactProfile; s: string } => !!x.s);
  const discriminants = faits.filter((x) => rangFait(x.f) < 3).map((x) => `fait T1: ${x.s}`);
  const secondaires = faits.filter((x) => rangFait(x.f) >= 3).map((x) => `fait T1: ${x.s}`);
  return joinWithinLimit([
    meta.head, meta.parents, ...ids.exacts, ...discriminants, ...ids.designations, ...meta.rest,
    d.description ? `description:${net(d.description, 300)}` : null,
    ...secondaires,
  ], T3_SUBJECT_MAX);
}

/** Ligne candidate « [id:N] … » d'un document (EQUIPMENT_DOCUMENT). */
export function formatDocumentCandidate(d: DocumentProfile): string {
  const meta = documentMeta(d);
  const ids = identifiantsLus(d);
  const faits = factsPrioritaires(d).map(factDescriptor).filter((x): x is string => !!x);
  return `[id:${d.fileId}] ${joinWithinLimit([
    `"${net(d.title ?? `Document #${d.fileId}`, 140)}"`,
    ...ids.exacts, meta.parents, ...ids.designations, ...meta.rest,
    d.description ? `— ${net(d.description, 200)}` : null,
    ...faits.map((f) => `fait: ${f}`),
  ], T3_CANDIDATE_MAX - 12)}`;
}

/**
 * Pertinence d'un équipement « à ne pas confondre » avec `e` (pure) :
 * modèle, nom, marque, type, catégorie, pièce communs.
 */
export function confusionScore(e: EquipmentProfile, o: EquipmentProfile): number {
  let s = 0;
  if (compactCode(e.model).length >= 3 && compactCode(e.model) === compactCode(o.model)) s += 4;
  const ne = words(e.name), no = words(o.name);
  if (ne === no) s += 4;
  else if (ne.includes(no) || no.includes(ne)) s += 3;
  else if (motDeTete(e.name) && motDeTete(e.name) === motDeTete(o.name)) s += 2;
  if (compactCode(e.brand) && compactCode(e.brand) === compactCode(o.brand)) s += 2;
  if (e.type && e.type === o.type) s += 1;
  if (e.category && e.category === o.category) s += 1;
  if (e.room && e.room === o.room) s += 0.5;
  return s;
}

/** SUBJECT_CONTEXT d'un équipement (EQUIPMENT_DOCUMENT), avec les équipements à ne pas confondre (par pertinence). */
export function formatEquipmentSubject(e: EquipmentProfile, others: readonly EquipmentProfile[] = []): string {
  const parPertinence = others.filter((o) => o.id !== e.id)
    .map((o) => ({ o, s: confusionScore(e, o) }))
    .sort((a, b) => b.s - a.s || a.o.id - b.o.id)
    .map((x) => x.o);
  return joinWithinLimit([
    `Équipement #${e.id} ${joinWithinLimit(equipmentDescriptor(e), 900, ', ')}`,
    ...parPertinence.map((o) => `à ne pas confondre avec l’équipement #${o.id} ${joinWithinLimit(equipmentDescriptor(o), 400, ', ')}`),
  ], T3_SUBJECT_MAX);
}
