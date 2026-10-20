/**
 * T3 — harmonisation du nommage documentaire (lot 61, fiabilisé au lot 72B) :
 * CONTEXTE, pur.
 *
 * LOT DE COMPARAISON (code) ≠ FAMILLE (IA). Le code rassemble seulement des
 * documents COMPARABLES, sans règle métier ni nomenclature. Lot 72B (E4) :
 * les documents sont reliés par des CLÉS DE RAPPROCHEMENT génériques —
 * émetteur normalisé (casse, accents, formes juridiques), SIREN de
 * l'émetteur, référence de contrat lue par T1 ou portée par une Opération,
 * Opération partagée (relation connue). Deux documents partageant une clé
 * sont dans le même lot (composantes connexes) : un même contrat dont
 * l'émetteur est absent ou formulé différemment est donc présenté ENSEMBLE.
 * À défaut de toute clé forte : même nature documentaire et même bien (clé
 * faible, jamais un pont entre lots). Une clé de rapprochement qui relierait
 * plus de `LINK_MAX_ISSUERS` émetteurs distincts est ignorée (regroupement
 * excessif). Le modèle décide ensuite, à l'intérieur du lot, quelles
 * familles existent — deux contrats d'un même lot gardent des conventions
 * distinctes.
 *
 * BORNES SANS PERTE : un lot plus grand que `maxDocs` est examiné en
 * plusieurs appels ; chaque appel reçoit ses documents À EXAMINER et des
 * documents de RÉFÉRENCE du même lot. Tous les documents du lot sont
 * examinés, appel après appel (reprise au passage suivant).
 *
 * EMPREINTE (E3) : l'empreinte d'un document couvre TOUT ce que l'IA lit —
 * nom, protection, nature, rubrique, émetteur (et SIREN), date, montant, bien,
 * version de l'extraction (texte, nombre de faits), empreinte des faits
 * actifs (valeurs, périodes, cibles), références de contrat, Opérations
 * liées, liens document ↔ bien. Versions et empreintes DÉTERMINISTES calculées
 * en base (coût maîtrisé : jamais le texte intégral haché à chaque passage).
 * À contexte inchangé : aucun appel.
 *
 * CONTEXTE IA (E5) : plus de troncature arbitraire (10 faits, 300 caractères,
 * 3 Opérations) — une SÉLECTION pertinente sous budget : faits classés
 * (références, contrats, périodes, adresses, dates d'abord), passages du
 * texte intégral portant une information discriminante (référence, adresse,
 * date, montant), où qu'ils soient dans le texte, avec leur PROVENANCE ;
 * indication de ce qui n'a pas été transmis et de l'insuffisance du contexte
 * (abstention attendue).
 */
import { createHash } from 'node:crypto';
import { extractDiscriminants, type NameOrigin } from './guards';

/**
 * Version du constructeur de contexte : entre dans l'empreinte des lots.
 * Lot 72B : `naming-v2` (empreinte étendue). Un lot examiné en v1 et inchangé
 * depuis est recalé sans appel IA (`legacyGroupFingerprint`).
 */
export const NAMING_CONTEXT_VERSION = 'naming-v2';
export const NAMING_CONTEXT_VERSION_V1 = 'naming-v1';
export const NAMING_RELATION = 'DOCUMENT_NAMING — harmoniser les intitulés des documents d’une même famille (sortie : document_renames)';
/** Une clé de rapprochement reliant plus d'émetteurs distincts est ignorée (regroupement excessif). */
export const LINK_MAX_ISSUERS = 3;

/** Document du compte, tel que lu pour le nommage. */
export interface NamingDoc {
  id: number;
  name: string;
  originalName: string | null;
  filename: string | null;
  s3Key: string | null;
  publicId: string | null;
  titleSource: string;
  legacyUserEdit: boolean;
  typeCode: string | null;
  supplier: string | null;
  documentDate: string | null;
  assetId: number | null;
  assetName: string | null;
  extractionId: number | null;
  extractedAt: string | null;
  extractionTitle: string | null;
  amountCents: number | null;
  // ── Lot 72B (E3, E4) : facultatifs (corpus, documents antérieurs) ─────────
  /** Rubrique documentaire (classement). */
  rubricCode?: string | null;
  /** SIRET / SIREN de l'émetteur lu par T1. */
  supplierSiret?: string | null;
  /** Version de l'extraction (identifiant, dates, taille du texte, nombre de faits). */
  extractionVersion?: string | null;
  /** Empreinte des faits actifs (valeurs, périodes, cibles, statut). */
  factsDigest?: string | null;
  /** Références de contrat (normalisées, discriminantes) : faits T1 et Opérations. */
  contractRefs?: string[];
  /** Opérations actives liées au document. */
  operationIds?: number[];
  /** Empreinte des liens document ↔ bien actifs. */
  linksDigest?: string | null;
}

const LEGAL_FORMS = new Set(['sa', 'sas', 'sasu', 'sarl', 'eurl', 'sci', 'snc', 'scp', 'scm', 'gie', 'ltd', 'llc', 'inc', 'gmbh', 'ag', 'bv', 'nv', 'spa', 'srl', 'plc', 'cie', 'et']);

/** Clé d'émetteur (pure) : générique, aucune liste de fournisseurs. */
export function supplierKey(s: string | null | undefined): string | null {
  const mots = String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/\./g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter((w) => w && !LEGAL_FORMS.has(w));
  return mots.length ? mots.join(' ') : null;
}

/** SIREN (9 chiffres) d'un SIRET / SIREN, ou null. */
export function sirenOf(s: string | null | undefined): string | null {
  const d = String(s ?? '').replace(/\D/g, '');
  return d.length === 9 || d.length === 14 ? d.slice(0, 9) : null;
}

/** Lot de comparaison « historique » d'un document (clé principale), ou `null`. */
export function groupKeyOf(d: Pick<NamingDoc, 'supplier' | 'typeCode' | 'assetId'>): string | null {
  const s = supplierKey(d.supplier);
  if (s) return `s:${s}`;
  if (d.typeCode) return `t:${d.typeCode}|a:${d.assetId ?? '-'}`;
  return null;
}

/**
 * Clés de rapprochement d'un document (pure, E4). Clés FORTES : émetteur
 * (`s:`), SIREN (`e:`), contrat (`c:`), Opération (`o:`). Sans clé forte :
 * la clé faible nature + bien (`t:`), jamais combinée aux autres.
 */
export function linkKeysOf(d: Pick<NamingDoc, 'supplier' | 'typeCode' | 'assetId' | 'supplierSiret' | 'contractRefs' | 'operationIds'>): string[] {
  const fortes: string[] = [];
  const s = supplierKey(d.supplier);
  if (s) fortes.push(`s:${s}`);
  const siren = sirenOf(d.supplierSiret);
  if (siren) fortes.push(`e:${siren}`);
  for (const r of d.contractRefs ?? []) fortes.push(`c:${r}`);
  for (const o of d.operationIds ?? []) fortes.push(`o:${o}`);
  if (fortes.length) return [...new Set(fortes)].sort();
  return d.typeCode ? [`t:${d.typeCode}|a:${d.assetId ?? '-'}`] : [];
}

const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 32);

/** Empreinte des DONNÉES d'un document (hors nom) : nouvelle information ⇔ empreinte modifiée. */
export function documentFingerprint(d: NamingDoc): string {
  return sha([
    d.typeCode, d.rubricCode ?? null, supplierKey(d.supplier), sirenOf(d.supplierSiret), d.documentDate, d.assetId,
    d.extractionId, d.extractedAt, d.extractionVersion ?? null, d.amountCents, d.factsDigest ?? null,
    [...(d.contractRefs ?? [])].sort(), [...(d.operationIds ?? [])].sort((a, b) => a - b), d.linksDigest ?? null,
  ]);
}

/** Empreinte v1 (lot 61) : sert seulement à recaler sans appel un lot inchangé depuis son dernier examen. */
export function legacyDocumentFingerprint(d: NamingDoc): string {
  return sha([d.typeCode, supplierKey(d.supplier), d.documentDate, d.assetId, d.extractionId, d.extractedAt, d.amountCents]);
}

/** Nom protégé (renommage manuel explicite). */
export function isProtected(d: Pick<NamingDoc, 'titleSource' | 'legacyUserEdit'>): boolean {
  return d.titleSource === 'USER' || d.legacyUserEdit;
}

/** Empreinte d'un document dans son lot (nom, protection, données). */
export function docSnapshotHash(d: NamingDoc): string {
  return sha([d.name, isProtected(d), documentFingerprint(d)]).slice(0, 16);
}

/** Empreinte d'un lot à partir de l'index (identifiant → empreinte du document). */
export function membersFingerprint(members: ReadonlyArray<{ id: number; hash: string }>): string {
  return sha([NAMING_CONTEXT_VERSION, [...members].sort((a, b) => a.id - b.id).map((m) => [m.id, m.hash])]);
}

/** Empreinte d'un lot (pure) : documents, noms, protection, données. */
export function groupFingerprint(docs: readonly NamingDoc[]): string {
  return membersFingerprint(docs.map((d) => ({ id: d.id, hash: docSnapshotHash(d) })));
}

/** Empreinte v1 d'un lot (lot 61), pour le recalage sans appel. */
export function legacyGroupFingerprint(docs: readonly NamingDoc[]): string {
  return sha([NAMING_CONTEXT_VERSION_V1, [...docs].sort((a, b) => a.id - b.id)
    .map((d) => [d.id, sha([d.name, isProtected(d), legacyDocumentFingerprint(d)]).slice(0, 16)])]);
}

/** Instantané d'un lot (identifiant → empreinte), mémorisé après un examen complet. */
export function groupSnapshot(docs: readonly NamingDoc[]): Record<string, string> {
  return Object.fromEntries(docs.map((d) => [String(d.id), docSnapshotHash(d)]));
}

export interface NamingGroup { key: string; docs: NamingDoc[] }
export interface MemberGroup { key: string; ids: number[]; keys: string[] }

/**
 * Lots de comparaison (pure, E4) : composantes connexes des documents reliés
 * par une clé de rapprochement. Clé du lot : l'émetteur le plus représenté,
 * sinon la nature + bien, sinon la plus petite clé de rapprochement —
 * stable tant que la composition ne change pas. Rend aussi les documents
 * sans clé (contexte insuffisant). Strictement par compte : l'appelant ne
 * fournit que les documents d'un compte.
 */
export function groupMembers(members: ReadonlyArray<{ id: number; keys: readonly string[] }>): { groups: MemberGroup[]; withoutContext: number[] } {
  const parent = members.map((_m, i) => i);
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a: number, b: number) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb); };
  const parCle = new Map<string, number[]>();
  const sans: number[] = [];
  members.forEach((m, i) => {
    if (!m.keys.length) { sans.push(m.id); return; }
    for (const k of m.keys) { const l = parCle.get(k) ?? []; l.push(i); parCle.set(k, l); }
  });
  for (const [k, idx] of parCle) {
    if (idx.length < 2) continue;
    if (!k.startsWith('s:') && !k.startsWith('t:')) {
      const emetteurs = new Set(idx.flatMap((i) => members[i].keys.filter((x) => x.startsWith('s:'))));
      if (emetteurs.size > LINK_MAX_ISSUERS) continue;
    }
    for (let j = 1; j < idx.length; j++) union(idx[0], idx[j]);
  }
  const comps = new Map<number, number[]>();
  members.forEach((m, i) => {
    if (!m.keys.length) return;
    const r = find(i);
    const l = comps.get(r) ?? [];
    l.push(i);
    comps.set(r, l);
  });
  const groups: MemberGroup[] = [];
  for (const idx of comps.values()) {
    const compte = new Map<string, number>();
    for (const i of idx) for (const k of members[i].keys) compte.set(k, (compte.get(k) ?? 0) + 1);
    const cles = [...compte.keys()].sort();
    const meilleur = (prefixe: string) => cles.filter((k) => k.startsWith(prefixe))
      .sort((a, b) => compte.get(b)! - compte.get(a)! || (a < b ? -1 : 1))[0];
    const key = meilleur('s:') ?? meilleur('t:') ?? cles[0];
    groups.push({ key, ids: idx.map((i) => members[i].id).sort((a, b) => a - b), keys: cles });
  }
  groups.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  // Deux composantes ne peuvent porter la même clé (une clé partagée les aurait réunies).
  return { groups, withoutContext: sans };
}

/** Regroupe des documents (pure) — même algorithme que l'index. */
export function buildGroups(docs: readonly NamingDoc[]): { groups: NamingGroup[]; withoutContext: number[] } {
  const parId = new Map(docs.map((d) => [d.id, d]));
  const { groups, withoutContext } = groupMembers(docs.map((d) => ({ id: d.id, keys: linkKeysOf(d) })));
  return { groups: groups.map((g) => ({ key: g.key, docs: orderDocs(g.ids.map((id) => parId.get(id)!)) })), withoutContext };
}

/** Ordre stable d'examen : chronologique (date du document), puis identifiant. */
export function orderDocs(l: readonly NamingDoc[]): NamingDoc[] {
  return [...l].sort((a, b) => {
    const da = a.documentDate ?? '9999';
    const db = b.documentDate ?? '9999';
    return da < db ? -1 : da > db ? 1 : a.id - b.id;
  });
}

export interface NamingChunk { index: number; count: number; targets: NamingDoc[]; references: NamingDoc[] }

/**
 * Documents À EXAMINER d'un lot (pure). Premier examen : tout le lot.
 * Réexamen : lot tenant en un appel → tout le lot (vue complète de la
 * famille) ; lot volumineux → les documents nouveaux ou modifiés depuis
 * l'instantané du dernier examen complet.
 */
export function reviewTargets(docs: readonly NamingDoc[], snapshot: Record<string, string> | null, maxDocs: number): NamingDoc[] {
  if (!snapshot || docs.length <= maxDocs) return [...docs];
  return docs.filter((d) => snapshot[String(d.id)] !== docSnapshotHash(d));
}

/**
 * Découpage en appels (pure). Lot tenant en un appel : un seul appel, les
 * autres documents du lot en RÉFÉRENCE. Au-delà de `maxDocs` : chaque appel
 * porte `maxDocs - R` documents à examiner et R documents de référence
 * (R = maxDocs / 4, au plus 8) — les plus récents des documents déjà
 * examinés, complétés au besoin par des documents d'autres parties.
 */
export function planChunks(docs: readonly NamingDoc[], targets: readonly NamingDoc[], maxDocs: number): NamingChunk[] {
  if (!targets.length) return [];
  const ids = new Set(targets.map((d) => d.id));
  const autres = docs.filter((d) => !ids.has(d.id));
  if (docs.length <= maxDocs) return [{ index: 0, count: 1, targets: [...targets], references: autres }];
  const r = Math.max(1, Math.min(8, Math.floor(maxDocs / 4)));
  const t = maxDocs - r;
  const count = Math.ceil(targets.length / t);
  return Array.from({ length: count }, (_x, i) => {
    const tg = targets.slice(i * t, (i + 1) * t);
    const voisins = (i === 0 ? targets.slice(-r) : targets.slice(Math.max(0, i * t - r), i * t)).filter((d) => !tg.includes(d));
    const references = [...autres.slice(-r), ...voisins].slice(0, r);
    return { index: i, count, targets: tg, references };
  });
}

// ── Sélection contextuelle (E5) ─────────────────────────────────────────────

/** Fait T1 lu en base, avant sélection. */
export interface RawFact {
  id: number;
  key: string;
  value: string;
  period: string | null;
  /** T1_EXTRACTION | REVALIDATION_T2 … */
  provenance: string;
  /** Fait d'une clé canonique de référence de contrat (référentiel). */
  contractReference?: boolean;
  canonical?: boolean;
}

export interface SelectedFact { key: string; value: string; period?: string | null; source: string; factId: number }
export interface Passage { text: string; offset: number; source: 'EXTRACTION_FULL_TEXT' }

/** Budgets de sélection (caractères), jamais des troncatures de liste. */
export const CONTEXT_BUDGET = { facts: 2_400, factValue: 240, head: 240, passages: 1_200, passage: 200 } as const;

const discriminantScore = (t: string): number => {
  const d = extractDiscriminants(t, { clean: false });
  return d.references.length * 3 + d.address.length * 2 + d.dates.length + d.amounts.length;
};

/**
 * Faits transmis (pure) : classés par pertinence — référence de contrat,
 * valeur discriminante (référence, adresse, date), période, clé canonique —
 * puis par ancienneté ; doublons retirés ; sous budget de caractères.
 */
export function selectFacts(facts: readonly RawFact[], budget: number = CONTEXT_BUDGET.facts): { selected: SelectedFact[]; omitted: number } {
  const vus = new Set<string>();
  const notes = facts.filter((f) => f.value && f.value.trim()).map((f) => ({
    // Présence (plafonnée) d'une information discriminante, jamais leur nombre : une valeur bavarde ne passe pas devant un contrat.
    f, score: (f.contractReference ? 10 : 0) + Math.min(3, discriminantScore(`${f.value}`)) * 2 + (f.period ? 3 : 0) + (f.canonical ? 1 : 0),
  })).sort((a, b) => b.score - a.score || a.f.id - b.f.id);
  const selected: SelectedFact[] = [];
  let total = 0;
  let omitted = 0;
  for (const { f } of notes) {
    const value = f.value.trim().slice(0, CONTEXT_BUDGET.factValue);
    const cle = `${f.key}\u0000${value}\u0000${f.period ?? ''}`;
    if (vus.has(cle)) continue;
    vus.add(cle);
    const cout = f.key.length + value.length + (f.period?.length ?? 0) + 8;
    if (selected.length > 0 && total + cout > budget) { omitted++; continue; }
    total += cout;
    selected.push({ key: f.key, value, ...(f.period ? { period: f.period } : {}), source: f.provenance || 'T1_EXTRACTION', factId: f.id });
  }
  return { selected, omitted };
}

/**
 * Début du texte et passages discriminants (pure) : le début (repère), puis
 * les phrases portant une référence, une adresse, une date ou un montant, où
 * qu'elles soient dans le texte intégral, avec leur position (provenance).
 */
export function selectPassages(text: string | null | undefined, budget: number = CONTEXT_BUDGET.passages): { head: string | null; passages: Passage[]; textChars: number } {
  const brut = String(text ?? '');
  if (!brut.trim()) return { head: null, passages: [], textChars: 0 };
  const head = brut.replace(/\s+/g, ' ').trim().slice(0, CONTEXT_BUDGET.head);
  const segments: Array<{ text: string; offset: number }> = [];
  const re = /[^.;!?\n]+[.;!?\n]?/g;
  for (let m = re.exec(brut); m; m = re.exec(brut)) {
    const s = m[0];
    if (!s.trim()) continue;
    for (let i = 0; i < s.length; i += CONTEXT_BUDGET.passage) {
      const morceau = s.slice(i, i + CONTEXT_BUDGET.passage);
      const debut = morceau.search(/\S/);
      if (debut >= 0) segments.push({ text: morceau.replace(/\s+/g, ' ').trim(), offset: m.index + i + debut });
    }
  }
  const finTete = brut.search(/\S/) + CONTEXT_BUDGET.head;
  const notes = segments.filter((s) => s.offset + s.text.length > finTete)
    .map((s) => ({ s, score: discriminantScore(s.text) })).filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.s.offset - b.s.offset);
  const vus = new Set<string>();
  const passages: Passage[] = [];
  let total = 0;
  for (const { s } of notes) {
    if (vus.has(s.text)) continue;
    vus.add(s.text);
    if (total + s.text.length > budget) continue;
    total += s.text.length;
    passages.push({ text: s.text, offset: s.offset, source: 'EXTRACTION_FULL_TEXT' });
  }
  passages.sort((a, b) => a.offset - b.offset);
  return { head: head || null, passages, textChars: brut.length };
}

/** Détail d'un document fourni à l'IA (chargé pour les seuls documents de l'appel). */
export interface NamingDocDetail {
  facts: Array<{ key: string; value: string; period?: string | null; source?: string; factId?: number }>;
  excerpt: string | null;
  operations: Array<{ id: number; type: string | null; status: string; contractReference?: string | null; relatedDocumentIds?: number[]; source?: string }>;
  history: Array<{ at: string; from: string | null; to: string | null; origin: string }>;
  /** Lot 72B (E5) : passages discriminants du texte intégral, avec leur position. */
  passages?: Passage[];
  /** Lot 72B (E4, E5) : références de contrat connues et leur provenance. */
  contracts?: Array<{ reference: string; source: string }>;
  /** Lot 72B (E5) : ce qui a été transmis ou non ; contexte suffisant ? */
  context?: { factsTotal: number; factsProvided: number; textChars: number; passagesProvided: number; sufficient: boolean };
}

export interface NamingDocState {
  origin: NameOrigin;
  lastRenamedAt: string | null;
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
  }
  return v;
}

/**
 * Variables du master T3 (les six emplacements ; `null` pour ceux des autres
 * branches). Aucun nouvel emplacement : SUBJECT_CONTEXT (le lot, les
 * conventions décrites au dernier examen), CANDIDATES (les documents),
 * RELATION_TYPE (rappel de la tâche). Pure, déterministe.
 */
export function namingVariables(p: {
  group: NamingGroup;
  chunk: NamingChunk;
  conventions: unknown[];
  states: ReadonlyMap<number, NamingDocState>;
  details: ReadonlyMap<number, NamingDocDetail>;
  maxLength: number;
}): Record<string, unknown> {
  const types = [...new Set(p.group.docs.map((d) => d.typeCode).filter(Boolean))].sort();
  const fournisseurs = [...new Set(p.group.docs.map((d) => d.supplier?.trim()).filter(Boolean))].sort();
  const subject = {
    comparisonSet: {
      key: p.group.key,
      suppliers: fournisseurs,
      documentTypes: types,
      documentCount: p.group.docs.length,
      part: { index: p.chunk.index + 1, of: p.chunk.count },
    },
    previousConventions: p.conventions,
    constraints: { maxNameLength: p.maxLength, protectedOrigins: ['USER'], renameOnlyDocumentsOfThisSet: true, renameOnlyRoleToExamine: true },
  };
  const doc = (d: NamingDoc, role: 'TO_EXAMINE' | 'REFERENCE') => {
    const st = p.states.get(d.id);
    const det = p.details.get(d.id);
    return {
      documentId: d.id,
      role,
      currentName: d.name,
      originalName: d.originalName ?? null,
      nameOrigin: st?.origin ?? 'UNKNOWN',
      renameAllowed: role === 'TO_EXAMINE' && !isProtected(d),
      lastRenamedAt: st?.lastRenamedAt ?? null,
      nameHistory: det?.history ?? [],
      documentType: d.typeCode,
      documentDate: d.documentDate,
      supplier: d.supplier,
      asset: d.assetId ? { id: d.assetId, name: d.assetName } : null,
      amountCents: d.amountCents,
      extractionTitle: d.extractionTitle,
      facts: det?.facts ?? [],
      excerpt: det?.excerpt ?? null,
      operations: det?.operations ?? [],
      ...(det?.passages ? { passages: det.passages } : {}),
      ...(det?.contracts ? { contracts: det.contracts } : {}),
      ...(det?.context ? { context: det.context } : {}),
    };
  };
  const candidates = [
    ...p.chunk.targets.map((d) => doc(d, 'TO_EXAMINE')),
    ...p.chunk.references.map((d) => doc(d, 'REFERENCE')),
  ].sort((a, b) => a.documentId - b.documentId).map(canonical);
  return {
    FIELD: null,
    CURRENT_STATE: null,
    EVIDENCES: null,
    SUBJECT_CONTEXT: JSON.stringify(canonical(subject)),
    CANDIDATES: candidates,
    RELATION_TYPE: NAMING_RELATION,
  };
}
