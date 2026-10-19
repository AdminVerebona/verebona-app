/**
 * Rapprochement document ↔ équipement — règles PURES et contextes T3
 * (lot 71A : BUG P1 « confusion bien / équipement », point B ; ticket P1
 * « Enrichir les données transmises à T3 pour le rapprochement
 * documents–équipements »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DÉTERMINISTE D'ABORD, JAMAIS DE CHOIX ARBITRAIRE
 *
 * Univers : les équipements ACTUELS (non archivés) DU OU DES BIENS du
 * document, dans son compte. Chaque INDICE du document désigne un
 * équipement, ou il est ambigu :
 *   · VERIFIED_TARGET : fait T1 ciblant un équipement vérifié de ce bien ;
 *   · SERIAL_NUMBER   : n° de série exact (normalisé, ≥ 5 caractères dont un
 *                       chiffre), UNIQUE parmi les équipements du bien ;
 *   · BRAND_MODEL     : modèle lu identique (marque compatible) — ambigu si
 *                       deux équipements partagent ce modèle (le n° de série
 *                       départage) ;
 *   · DESIGNATION     : nom de l'équipement lu dans le titre / la désignation
 *                       — ambigu si un autre équipement du bien porte le même
 *                       nom ou un nom qui le contient (« Robot aspirateur »
 *                       face à « Robot aspirateur étage »).
 * La catégorie ou le type seuls ne suffisent JAMAIS ; un champ absent n'est
 * jamais une correspondance. Indices CERTAINS (cible vérifiée, n° de série)
 * prioritaires ; sinon indices FORTS non ambigus. Plusieurs équipements
 * désignés sans ambiguïté → plusieurs associations (facture « chaudière et
 * VMC »). Indices ambigus seulement → AMBIGUOUS (T3 ou carte LINK-ELT) : le
 * document reste rattaché au bien seul.
 *
 * CONTEXTE T3 : candidats et sujet structurés, informations DISCRIMINANTES
 * d'abord (identifiant, bien parent, nom, marque, modèle, n° de série), texte
 * libre ensuite — la troncature n'enlève que la fin. Jamais la date ni le
 * prix d'achat du bien comme caractéristique de l'équipement : le profil
 * d'équipement n'en porte aucun.
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

export interface DocumentFactProfile {
  key: string;
  value: string;
  label: string | null;
  targetType: string | null;
  targetId: number | null;
  targetLabel: string | null;
  excerpt: string | null;
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
}

export type MatchMethod = 'VERIFIED_TARGET' | 'SERIAL_NUMBER' | 'BRAND_MODEL' | 'DESIGNATION';

export interface EquipmentMatch {
  equipmentId: number;
  method: MatchMethod;
  score: number;
  reason: string;
}

export interface MatchResult {
  status: 'LINKED' | 'AMBIGUOUS' | 'NONE';
  links: EquipmentMatch[];
  /** Équipements en concurrence (indices ambigus), jamais liés automatiquement. */
  ambiguous: EquipmentMatch[];
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

/** Identifiants lus sur le document (valeurs brutes, dédoublonnées). */
export function documentIdentifiers(d: DocumentProfile): { serials: string[]; models: string[]; brands: string[]; designations: string[] } {
  const uniq = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];
  return {
    serials: uniq(d.facts.filter(isSerialFact).map((f) => f.value)),
    models: uniq(d.facts.filter(isModelFact).map((f) => f.value)),
    brands: uniq(d.facts.filter(isBrandFact).map((f) => f.value)),
    designations: uniq([
      ...d.facts.filter(isDesignationFact).map((f) => f.value),
      ...d.facts.filter((f) => f.targetType === 'EQUIPMENT' && f.targetLabel).map((f) => f.targetLabel as string),
    ]),
  };
}

// ── Rapprochement (pur) ─────────────────────────────────────────────────────

/** Décision déterministe document → équipements du bien (pure, testée). */
export function matchDocumentToEquipments(doc: DocumentProfile, equipments: readonly EquipmentProfile[]): MatchResult {
  const ids = new Set(equipments.map((e) => e.id));
  const certains = new Map<number, EquipmentMatch>();
  const forts = new Map<number, EquipmentMatch>();
  const ambigus = new Map<number, EquipmentMatch>();
  const garder = (m: Map<number, EquipmentMatch>, x: EquipmentMatch) => { if (!m.has(x.equipmentId)) m.set(x.equipmentId, x); };
  const ident = documentIdentifiers(doc);

  // 1. Faits T1 ciblant un équipement vérifié DU bien.
  for (const f of doc.facts) {
    if (f.targetType !== 'EQUIPMENT' || f.targetId == null || !ids.has(f.targetId)) continue;
    garder(certains, { equipmentId: f.targetId, method: 'VERIFIED_TARGET', score: 1, reason: `Fait « ${f.label ?? f.key} » lu pour cet équipement` });
  }

  // 2. N° de série exact et unique.
  const texteCompact = compactCode([doc.title, doc.description, ...doc.facts.flatMap((f) => [f.value, f.excerpt])].join(' '));
  const seriesLues = new Set(ident.serials.map(compactCode).filter(codeExploitable));
  for (const e of equipments) {
    const s = compactCode(e.serialNumber);
    if (!codeExploitable(s) || !(seriesLues.has(s) || texteCompact.includes(s))) continue;
    const memes = equipments.filter((x) => compactCode(x.serialNumber) === s);
    const m: EquipmentMatch = { equipmentId: e.id, method: 'SERIAL_NUMBER', score: 1, reason: `N° de série ${e.serialNumber} lu dans le document` };
    if (memes.length === 1) garder(certains, m);
    else for (const x of memes) garder(ambigus, { ...m, equipmentId: x.id });
  }

  // 3. Modèle lu (marque compatible).
  const modelesLus = new Set(ident.models.map(compactCode).filter((c) => c.length >= 3));
  const marquesLues = ident.brands.map(compactCode).filter(Boolean);
  const parModele = new Map<string, EquipmentProfile[]>();
  for (const e of equipments) {
    const mo = compactCode(e.model);
    if (mo.length < 3) continue;
    const lu = modelesLus.has(mo) || (codeExploitable(mo) && texteCompact.includes(mo));
    if (!lu) continue;
    const marque = compactCode(e.brand);
    if (marque && marquesLues.length > 0 && !marquesLues.some((b) => b.includes(marque) || marque.includes(b))) continue;
    parModele.set(mo, [...(parModele.get(mo) ?? []), e]);
  }
  for (const [mo, es] of parModele) {
    const memeModele = equipments.filter((x) => compactCode(x.model) === mo);
    for (const e of es) {
      const m: EquipmentMatch = { equipmentId: e.id, method: 'BRAND_MODEL', score: 0.9, reason: `Modèle ${e.brand ? `${e.brand} ` : ''}${e.model} lu dans le document` };
      garder(memeModele.length === 1 ? forts : ambigus, m);
    }
  }

  // 4. Désignation : nom de l'équipement lu dans le titre ou une désignation.
  const designations = words([doc.title, ...ident.designations].join(' | '));
  const noms = equipments.map((e) => ({ e, n: words(e.name) }));
  for (const { e, n } of noms) {
    if (n.trim().length < 4 || !designations.includes(n)) continue;
    // Un nom plus précis aussi lu l'emporte ; un nom identique, ou plus précis
    // mais NON lu, rend l'indice ambigu (« Robot aspirateur » ⊂ « Robot aspirateur étage »).
    const plusPrecisLu = noms.some((x) => x.e.id !== e.id && x.n !== n && x.n.includes(n) && designations.includes(x.n));
    if (plusPrecisLu) continue;
    const concurrents = noms.filter((x) => x.e.id !== e.id && (x.n === n || x.n.includes(n)));
    const m: EquipmentMatch = { equipmentId: e.id, method: 'DESIGNATION', score: 0.85, reason: `« ${e.name} » désigné par le document` };
    if (concurrents.length === 0) garder(forts, m);
    else for (const x of [e, ...concurrents.map((c) => c.e)]) garder(ambigus, { ...m, equipmentId: x.id, reason: `« ${x.name} » : désignation commune « ${e.name} »` });
  }

  const tri = (m: Map<number, EquipmentMatch>) => [...m.values()].sort((a, b) => a.equipmentId - b.equipmentId);
  if (certains.size > 0) return { status: 'LINKED', links: tri(certains), ambiguous: [] };
  for (const id of forts.keys()) ambigus.delete(id);
  if (forts.size > 0) {
    // Un indice fort non ambigu ne lève pas une ambiguïté portant sur d'AUTRES équipements : elle reste signalée.
    return { status: 'LINKED', links: tri(forts), ambiguous: tri(ambigus) };
  }
  if (ambigus.size >= 2) return { status: 'AMBIGUOUS', links: [], ambiguous: tri(ambigus) };
  return { status: 'NONE', links: [], ambiguous: [] };
}

// ── Contextes T3 (purs) ─────────────────────────────────────────────────────

/** Longueur maximale d'une ligne candidate (lue par `parseCandidates`). */
export const T3_CANDIDATE_MAX = 1000;
/** Longueur maximale du sujet transmis à T3. */
export const T3_SUBJECT_MAX = 3000;

const net = (s: string | null | undefined, max = 160) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

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

/** Description discriminante d'un équipement (sans aucune donnée d'achat du bien). */
export function equipmentDescriptor(e: EquipmentProfile): string[] {
  return [
    `"${net(e.name, 120)}"`,
    `bien parent:#${e.assetId}${e.assetName ? ` "${net(e.assetName, 60)}"` : ''}`,
    e.brand ? `marque:${net(e.brand, 60)}` : null,
    e.model ? `modèle:${net(e.model, 60)}` : null,
    e.serialNumber ? `n° de série:${net(e.serialNumber, 60)}` : null,
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

/** Faits T1 utiles au rapprochement, identifiants d'abord. */
function factsPrioritaires(d: DocumentProfile): DocumentFactProfile[] {
  const rang = (f: DocumentFactProfile) => (isSerialFact(f) ? 0 : isModelFact(f) || isBrandFact(f) ? 1
    : f.targetType === 'EQUIPMENT' ? 2 : isDesignationFact(f) ? 3 : 4);
  return [...d.facts].sort((a, b) => rang(a) - rang(b));
}

const factDescriptor = (f: DocumentFactProfile) => {
  const cible = f.targetType ? ` [cible ${f.targetType}${f.targetId != null ? `#${f.targetId}` : ''}${f.targetLabel ? ` « ${net(f.targetLabel, 60)} »` : ''}]` : '';
  const extrait = f.excerpt ? ` « ${net(f.excerpt, 120)} »` : '';
  return `${net(f.label ?? f.key, 60)} = ${net(f.value, 80)}${cible}${extrait}`;
};

/** Métadonnées du document (séparées des caractéristiques lues). */
function documentMeta(d: DocumentProfile): string[] {
  return [
    `Document #${d.fileId}${d.title ? ` « ${net(d.title, 140)} »` : ''}`,
    d.typeCode ? `type:${d.typeCode}` : null,
    d.assetIds.length ? `bien(s) parent(s):${d.assetIds.map((id, i) => `#${id}${d.assetNames[i] ? ` "${net(d.assetNames[i], 60)}"` : ''}`).join(', ')}` : null,
    d.documentDate ? `date du document:${d.documentDate}` : null,
    d.supplier ? `fournisseur:"${net(d.supplier, 80)}"` : null,
    d.amountCents != null ? `montant du document:${(d.amountCents / 100).toFixed(2)}€` : null,
  ].filter((x): x is string => !!x);
}

function identifiantsLus(d: DocumentProfile): string[] {
  const i = documentIdentifiers(d);
  return [
    i.designations.length ? `désignation(s) d’équipement lue(s):${i.designations.slice(0, 4).map((x) => `"${net(x, 80)}"`).join(', ')}` : null,
    i.brands.length ? `marque(s) lue(s):${i.brands.slice(0, 4).map((x) => net(x, 40)).join(', ')}` : null,
    i.models.length ? `modèle(s) lu(s):${i.models.slice(0, 4).map((x) => net(x, 40)).join(', ')}` : null,
    i.serials.length ? `n° de série lu(s):${i.serials.slice(0, 4).map((x) => net(x, 40)).join(', ')}` : null,
  ].filter((x): x is string => !!x);
}

/** SUBJECT_CONTEXT d'un document (DOCUMENT_EQUIPMENT). */
export function formatDocumentSubject(d: DocumentProfile): string {
  return joinWithinLimit([
    ...documentMeta(d),
    ...identifiantsLus(d),
    d.description ? `description:${net(d.description, 300)}` : null,
    ...factsPrioritaires(d).slice(0, 20).map((f) => `fait T1: ${factDescriptor(f)}`),
  ], T3_SUBJECT_MAX);
}

/** Ligne candidate « [id:N] … » d'un document (EQUIPMENT_DOCUMENT). */
export function formatDocumentCandidate(d: DocumentProfile): string {
  const [, ...meta] = documentMeta(d);
  return `[id:${d.fileId}] ${joinWithinLimit([
    `"${net(d.title ?? `Document #${d.fileId}`, 140)}"`,
    ...identifiantsLus(d),
    ...meta,
    d.description ? `— ${net(d.description, 200)}` : null,
    ...factsPrioritaires(d).slice(0, 8).map((f) => `fait: ${factDescriptor(f)}`),
  ], T3_CANDIDATE_MAX - 12)}`;
}

/** SUBJECT_CONTEXT d'un équipement (EQUIPMENT_DOCUMENT), avec les équipements à ne pas confondre. */
export function formatEquipmentSubject(e: EquipmentProfile, others: readonly EquipmentProfile[] = []): string {
  return joinWithinLimit([
    `Équipement #${e.id} ${joinWithinLimit(equipmentDescriptor(e), 900, ', ')}`,
    ...others.slice(0, 5).map((o) => `à ne pas confondre avec l’équipement #${o.id} ${joinWithinLimit(equipmentDescriptor(o), 400, ', ')}`),
  ], T3_SUBJECT_MAX);
}
