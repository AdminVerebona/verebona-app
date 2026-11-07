/**
 * REVUE DU RATTACHEMENT d'un document — parties PURES (lot 113L, ticket #711).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * PRINCIPE : le code fournit les indices ; l'IA les interprète dans le
 * contexte du document et décide si un arbitrage est nécessaire ; le code
 * contrôle et applique la décision avec traçabilité.
 *
 *   · `buildAttachmentIndices` : une correspondance exacte (adresse,
 *     immatriculation, VIN, numéro de série, cadastre) ou une désignation du
 *     modèle T1 est un INDICE, jamais une conclusion — avec les unités
 *     sources où elle apparaît (bloc, page, nature) ;
 *   · `maskIdentifierValues` : le contexte est transmis, la VALEUR de
 *     l'identifiant d'un bien jamais (adresse : donnée sensible du registre)
 *     — remplacée par une référence au bien candidat ; masquage vérifié, sinon
 *     le texte n'est pas transmis ;
 *   · `attachmentReviewVariables` : variables du master T3 (branche
 *     LINK_AMBIGUITY, relation DOCUMENT_ASSET), aucun emplacement nouveau ;
 *   · `decideAttachmentReview` : lecture déterministe et CONTRÔLÉE de la
 *     décision du modèle (monde fermé, cohérence, justification) — aucune
 *     règle sémantique ici : aucune liste de rôles, aucune exception par type
 *     de document ou de bien ;
 *   · `attachmentReviewKey` : mémoire de la décision (contexte PERTINENT
 *     inchangé → décision réutilisée, aucun appel, aucune carte recréée).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'node:crypto';
import { closedWorldLinkAmbiguity, type T3LinkAmbiguityOutput } from '../../master/t3-contract';
import { decideLinks, LINK_MIN_MARGIN } from '../../master/link-ambiguity';
import {
  IDENTIFIER_KIND_LABELS, isPromptSafeKey, normalizeAddress, normalizeCode, normalizeText, resolveAssetByIdentifiers,
  type AssetIdentifierRecord, type IdentifierMatch, type IdentifierResolution,
} from '../identifiers';
import { normalizePlate, normalizeVin } from '@/lib/vehicle-identifiers';
import { T3_ATTACHMENT_REVIEW_CONTRACT } from './contract';

/** Version des règles de la revue (entre dans la clé de mémoire). */
export const ATTACHMENT_REVIEW_VERSION = 1;

/** Seuil et confiance d'une décision lue dans `matches` (mêmes que T3 DOCUMENT_ASSET). */
export const ATTACHMENT_REVIEW_THRESHOLD = 0.8;

/** Bornes du contexte transmis (jamais une borne de découverte). */
export const REVIEW_MAX_INDICES = 12;
export const REVIEW_MAX_UNITS = 16;
const UNIT_CONTEXT_CHARS = 600;

export type AttachmentIndexKind = IdentifierMatch['kind'] | 'T1_DESIGNATION';

/** Indice soumis au modèle : jamais une valeur, toujours sa provenance. */
export interface AttachmentIndex {
  indexId: number;
  assetId: number;
  kind: AttachmentIndexKind;
  /** fait T1, texte lu, ou désignation du modèle T1. */
  via: 'fact' | 'text' | 'model';
  /** La valeur ne désigne que ce bien parmi ceux du compte. */
  exclusive: boolean;
  /** Le bien de l'indice est-il (l'un des) bien(s) du rattachement actuel ? */
  currentAsset: boolean;
  /** Unités sources où l'indice apparaît. */
  unitIds: string[];
}

/** Unité source persistée (couche exhaustive T1). */
export interface ReviewSourceUnit {
  unitId: string;
  kind: string;
  page: number | null;
  ordinal: number;
  parentUnitId: string | null;
  text: string | null;
  label: string | null;
  value: string | null;
}

/** Unité transmise au modèle (texte masqué, ou null si le masquage n'est pas vérifiable). */
export interface ReviewUnitContext {
  unitId: string;
  page: number | null;
  kind: string;
  label: string | null;
  context: string | null;
  /** Indices présents dans l'unité (vide : unité voisine, contexte seulement). */
  indexIds: number[];
}

export interface ReviewCandidate {
  assetId: number;
  name: string;
  family: string | null;
  subtype: string | null;
  identifiers: Record<string, string>;
  /** Proposition du MODÈLE T1 seulement (jamais un candidat enrichi par le serveur). */
  t1: { confidence: string; score: number; reason: string } | null;
  current: boolean;
  /** Faits du document qui ciblent ce bien. */
  factCount: number;
}

export type ReviewAttachmentOrigin = 'USER' | 'HISTORICAL' | 'AUTOMATIC';

export type AttachmentReviewDecision =
  | { kind: 'CONFIRMED'; reason: string; source: 'AI' | 'NO_INDEX' }
  | { kind: 'MULTI_ASSET'; assetIds: number[]; reason: string }
  | {
    kind: 'ARBITRATE'; suggestedAssetId: number; ambiguous: boolean; reason: string; citedUnitIds: string[]; citedIndexIds: number[];
    /** Lot 113S (`t3-user-question-v1`) : question BRUTE proposée par T3, contrôlée avant affichage (`ai-user-question.ts`). */
    userQuestion?: string | null;
  }
  | {
    kind: 'NO_DECISION';
    reasonCode: 'INSUFFICIENT_EVIDENCE' | 'UNSUPPORTED_ARBITRATION' | 'CLOSED_WORLD_VIOLATION' | 'REVIEW_OUTPUT_MISSING'
      | 'INCONSISTENT_OUTPUT' | 'INSUFFICIENT_CONTEXT' | 'AI_NOT_CONFIGURED' | 'AI_DISABLED' | 'TECHNICAL_FAILURE';
    reason?: string;
  };

const borne = (v: unknown, n: number): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, n) : null;
};

// ── Masquage des valeurs d'identifiant ─────────────────────────────────────

interface Token { start: number; end: number; raw: string }

function tokens(text: string): Token[] {
  return [...text.matchAll(/[\p{L}\p{N}]+/gu)].map((m) => ({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, raw: m[0] }));
}

/** Libellé de remplacement : nature de l'identifiant et bien candidat (jamais la valeur). */
export function maskLabel(kind: IdentifierMatch['kind'], assetId: number): string {
  return `[${IDENTIFIER_KIND_LABELS[kind]} identique à celle du bien candidat ${assetId}]`;
}

/** Plages [début, fin) des occurrences d'une valeur dans le texte (pure). */
function spansOf(text: string, kind: IdentifierMatch['kind'], value: string): Array<[number, number]> {
  const t = tokens(text);
  const out: Array<[number, number]> = [];
  if (kind === 'ADDRESS') {
    const needle = normalizeAddress(value).split(' ').filter(Boolean);
    if (needle.length === 0) return out;
    const norm = t.map((x) => normalizeAddress(x.raw));
    for (let i = 0; i < t.length; i += 1) {
      let k = 0;
      let j = i;
      // Un jeton normalisé peut en porter plusieurs (rare) : comparaison jeton à jeton, vides ignorés.
      while (k < needle.length && j < t.length) {
        const n = norm[j];
        if (!n) { j += 1; continue; }
        const parts = n.split(' ');
        if (parts.every((p, o) => needle[k + o] === p)) { k += parts.length; j += 1; } else break;
      }
      if (k === needle.length && j > i) out.push([t[i].start, t[j - 1].end]);
    }
    return out;
  }
  const cible = kind === 'REGISTRATION' ? normalizePlate(value) : kind === 'VIN' ? normalizeVin(value) : normalizeCode(value);
  if (!cible) return out;
  for (let i = 0; i < t.length; i += 1) {
    let acc = '';
    for (let w = 0; w < 4 && i + w < t.length; w += 1) {
      acc += normalizeCode(t[i + w].raw);
      if (acc.length > 24) break;
      if (acc === cible || (kind === 'REGISTRATION' && normalizePlate(acc) === cible)) { out.push([t[i].start, t[i + w].end]); break; }
    }
  }
  return out;
}

const KIND_KEY: Readonly<Record<IdentifierMatch['kind'], string>> = {
  ADDRESS: 'address1', REGISTRATION: 'registrationNumber', VIN: 'vin', SERIAL: 'serialNumber', CADASTRAL: 'cadastralRef',
};

/**
 * Remplace, dans un texte du document, toute valeur d'identifiant d'un bien
 * du compte par une référence au bien candidat. VÉRIFIÉ : si une
 * correspondance subsiste après masquage, le texte n'est PAS transmis
 * (`text: null`). Pure.
 */
export function maskIdentifierValues(text: string, records: readonly AssetIdentifierRecord[]): { text: string | null; masked: number } {
  const avant = resolveAssetByIdentifiers(records, { facts: [], texts: [text] });
  if (avant.matches.length === 0) return { text, masked: 0 };
  const plages: Array<{ s: number; e: number; label: string }> = [];
  for (const m of avant.matches) {
    const rec = records.find((r) => r.assetId === m.assetId);
    const valeur = rec?.values[KIND_KEY[m.kind]];
    if (!valeur) continue;
    for (const [s, e] of spansOf(text, m.kind, valeur)) plages.push({ s, e, label: maskLabel(m.kind, m.assetId) });
  }
  plages.sort((a, b) => a.s - b.s || b.e - a.e);
  let out = '';
  let pos = 0;
  let n = 0;
  for (const p of plages) {
    if (p.s < pos) continue;
    out += text.slice(pos, p.s) + p.label;
    pos = p.e;
    n += 1;
  }
  out += text.slice(pos);
  const apres = resolveAssetByIdentifiers(records, { facts: [], texts: [out] });
  return apres.matches.length === 0 ? { text: out, masked: n } : { text: null, masked: n };
}

/** Texte d'une unité (contenu, sinon « libellé : valeur »). Pure. */
export function reviewUnitText(u: Pick<ReviewSourceUnit, 'text' | 'label' | 'value'>): string {
  return ((u.text ?? '').trim() || [u.label, u.value].filter((x) => x && String(x).trim()).join(' : ')).slice(0, 4_000);
}

// ── Indices ────────────────────────────────────────────────────────────────

/** Correspondances exactes par unité source (pure). */
export function unitMatchesOf(units: readonly ReviewSourceUnit[], records: readonly AssetIdentifierRecord[]): Map<string, IdentifierMatch[]> {
  const out = new Map<string, IdentifierMatch[]>();
  for (const u of units) {
    const t = reviewUnitText(u);
    if (!t) continue;
    const r = resolveAssetByIdentifiers(records, { facts: [], texts: [t] });
    if (r.matches.length) out.set(u.unitId, r.matches);
  }
  return out;
}

/**
 * Indices de la revue (pure) : correspondances exactes du serveur (tous biens,
 * actuel compris — le modèle les pèse ensemble) et biens désignés avec
 * certitude par le MODÈLE T1. Ordre stable ; bornés.
 */
export function buildAttachmentIndices(p: {
  currentAssetIds: readonly number[];
  identification: Pick<IdentifierResolution, 'matches'>;
  t1Designations: ReadonlyArray<{ assetId: number; confidence: string }>;
  unitMatches: ReadonlyMap<string, readonly IdentifierMatch[]>;
}): AttachmentIndex[] {
  const actuels = new Set(p.currentAssetIds);
  const brut: Array<Omit<AttachmentIndex, 'indexId'>> = [];
  const vus = new Set<string>();
  for (const m of [...p.identification.matches].sort((a, b) => a.assetId - b.assetId || a.kind.localeCompare(b.kind))) {
    const k = `${m.assetId}:${m.kind}`;
    if (vus.has(k)) continue;
    vus.add(k);
    const unitIds = [...p.unitMatches.entries()].filter(([, l]) => l.some((x) => x.assetId === m.assetId && x.kind === m.kind)).map(([id]) => id).sort();
    brut.push({ assetId: m.assetId, kind: m.kind, via: m.via, exclusive: m.exclusive, currentAsset: actuels.has(m.assetId), unitIds });
  }
  for (const d of [...p.t1Designations].sort((a, b) => a.assetId - b.assetId)) {
    if (d.confidence !== 'certain' || actuels.has(d.assetId) || vus.has(`${d.assetId}:T1`)) continue;
    vus.add(`${d.assetId}:T1`);
    brut.push({ assetId: d.assetId, kind: 'T1_DESIGNATION', via: 'model', exclusive: true, currentAsset: false, unitIds: [] });
  }
  // Les indices d'un AUTRE bien d'abord (ce sont eux qui motivent la revue), puis ceux du bien actuel.
  const tries = [...brut.filter((x) => !x.currentAsset), ...brut.filter((x) => x.currentAsset)].slice(0, REVIEW_MAX_INDICES);
  return tries.map((x, i) => ({ ...x, indexId: i + 1 }));
}

/** La revue est-elle nécessaire ? Un indice désigne un bien hors du rattachement actuel. Pure. */
export function reviewNeeded(indices: readonly AttachmentIndex[]): boolean {
  return indices.some((i) => !i.currentAsset);
}

/** Biens que les indices désignent hors du rattachement actuel (pure, triés). */
export function otherAssetIds(indices: readonly AttachmentIndex[]): number[] {
  return [...new Set(indices.filter((i) => !i.currentAsset).map((i) => i.assetId))].sort((a, b) => a - b);
}

/**
 * Unités transmises (pure) : celles qui portent un indice, puis leur unité
 * parente et leurs voisines immédiates (ordre de lecture) — le contexte du
 * bloc (destinataire, objet assuré, livraison…) est celui du DOCUMENT, jamais
 * une règle du code. Valeurs masquées ; bornées.
 */
export function reviewUnitContexts(
  units: readonly ReviewSourceUnit[], indices: readonly AttachmentIndex[], records: readonly AssetIdentifierRecord[],
): ReviewUnitContext[] {
  const parId = new Map(units.map((u) => [u.unitId, u]));
  const ordre = [...units].sort((a, b) => a.ordinal - b.ordinal);
  const pos = new Map(ordre.map((u, i) => [u.unitId, i]));
  const retenues = new Map<string, number[]>();
  const ajouter = (id: string, indexIds: number[]) => {
    if (!parId.has(id)) return;
    retenues.set(id, [...new Set([...(retenues.get(id) ?? []), ...indexIds])].sort((a, b) => a - b));
  };
  for (const i of indices) for (const id of i.unitIds) ajouter(id, [i.indexId]);
  for (const id of [...retenues.keys()]) {
    const u = parId.get(id)!;
    if (u.parentUnitId) ajouter(u.parentUnitId, []);
    const k = pos.get(id)!;
    for (const v of [ordre[k - 1], ordre[k + 1]]) if (v && v.kind !== 'PAGE_GAP') ajouter(v.unitId, []);
  }
  const avecIndice = [...retenues.entries()].filter(([, l]) => l.length > 0).map(([id]) => id);
  const voisines = [...retenues.entries()].filter(([, l]) => l.length === 0).map(([id]) => id);
  const choisies = [...avecIndice, ...voisines].slice(0, REVIEW_MAX_UNITS);
  return choisies
    .map((id) => parId.get(id)!)
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((u) => {
      const brut = reviewUnitText(u);
      const m = brut ? maskIdentifierValues(brut, records) : { text: null };
      return {
        unitId: u.unitId, page: u.page, kind: u.kind, label: borne(u.label, 120),
        context: m.text ? borne(m.text, UNIT_CONTEXT_CHARS) : null,
        indexIds: retenues.get(u.unitId) ?? [],
      };
    });
}

/**
 * Contexte suffisant pour juger ? Au moins un indice d'un autre bien porte un
 * contexte documentaire lisible (unité masquée), ou est une désignation du
 * modèle T1 (dont les signaux sont transmis). Sinon : la revue n'appelle pas
 * le modèle — aucune carte, statut tracé (jamais la règle supprimée). Pure.
 */
export function reviewContextSufficient(indices: readonly AttachmentIndex[], units: readonly ReviewUnitContext[]): boolean {
  const lisibles = new Set(units.filter((u) => u.context).flatMap((u) => u.indexIds));
  return indices.some((i) => !i.currentAsset && (i.kind === 'T1_DESIGNATION' || lisibles.has(i.indexId)));
}

// ── Variables du master T3 ─────────────────────────────────────────────────

/** Relation transmise (`RELATION_TYPE`) : description de la relation cherchée, sans règle. */
export const ATTACHMENT_REVIEW_RELATION =
  'DOCUMENT_ASSET — REVUE DU RATTACHEMENT ACTUEL : le document est déjà rattaché au(x) bien(s) '
  + '`attachmentReview.currentAssetIds` ; dire, d’après le sens du document et le rôle des informations qu’il contient, '
  + 's’il concerne ce(s) bien(s), un autre bien (contradiction réelle), plusieurs biens, ou si une ambiguïté réelle demande '
  + 'la décision de l’utilisateur. Les correspondances `attachmentReview.indices` sont des indices à interpréter.';

const ATTACHMENT_ORIGIN_LABEL: Readonly<Record<ReviewAttachmentOrigin, string>> = {
  USER: 'choisi par l’utilisateur',
  HISTORICAL: 'rattachement historique (dépôt sur la fiche du bien)',
  AUTOMATIC: 'rattachement automatique',
};

const INDEX_KIND_TEXT: Readonly<Record<AttachmentIndexKind, string>> = {
  ...IDENTIFIER_KIND_LABELS,
  T1_DESIGNATION: 'désignation du bien par l’analyse documentaire (T1)',
};

/** Ligne de candidat (pure) : jamais une valeur sensible, jamais « contrôle serveur » pour un indice. */
export function describeReviewCandidate(c: ReviewCandidate, indices: readonly AttachmentIndex[], origin: ReviewAttachmentOrigin): string {
  const parts = [`"${c.name}" (${[c.family, c.subtype].filter(Boolean).join(', ') || 'bien'})`];
  if (c.current) parts.push(`RATTACHEMENT ACTUEL (${ATTACHMENT_ORIGIN_LABEL[origin]})`);
  const ids = Object.entries(c.identifiers).filter(([k]) => isPromptSafeKey(k)).map(([k, v]) => `${k}=${v}`);
  if (ids.length) parts.push(`identifiants: ${ids.join(', ')}`);
  if (c.factCount > 0) parts.push(`${c.factCount} fait(s) du document ciblent ce bien`);
  const siens = indices.filter((i) => i.assetId === c.assetId);
  if (siens.length) parts.push(`indices: ${siens.map((i) => `#${i.indexId} ${INDEX_KIND_TEXT[i.kind]}`).join(', ')} (rôle à interpréter)`);
  if (c.t1) parts.push(`analyse documentaire T1: ${c.t1.confidence} (${c.t1.score}) ${borne(c.t1.reason, 200) ?? ''}`.trim());
  return parts.join(' — ').slice(0, 700);
}

export interface ReviewSubject {
  fileId: number;
  title: string | null;
  documentType: string | null;
  documentDate: string | null;
  supplier: string | null;
  description: string | null;
  multiAssetDeclared: boolean | null;
  facts: Array<{ canonicalKey: string | null; label: string | null; value: string | null; excerpt: string | null; targetAssetId: number | null }>;
}

/**
 * Variables du master T3 pour la revue (pure). Faits : clés sensibles du
 * registre exclues, valeurs et extraits masqués ; candidats triés par
 * identifiant (ordre neutre).
 */
export function attachmentReviewVariables(p: {
  subject: ReviewSubject;
  candidates: readonly ReviewCandidate[];
  indices: readonly AttachmentIndex[];
  units: readonly ReviewUnitContext[];
  currentAssetIds: readonly number[];
  origin: ReviewAttachmentOrigin;
  records: readonly AssetIdentifierRecord[];
}): Record<string, unknown> {
  const masque = (v: string | null, n: number) => {
    const b = borne(v, n);
    return b ? maskIdentifierValues(b, p.records).text : null;
  };
  const facts = p.subject.facts
    .filter((f) => !f.canonicalKey || isPromptSafeKey(f.canonicalKey))
    .slice(0, 30)
    .map((f) => ({ key: f.canonicalKey ?? f.label ?? null, value: masque(f.value, 120), excerpt: masque(f.excerpt, 160), targetAssetId: f.targetAssetId }));
  return {
    FIELD: null,
    CURRENT_STATE: null,
    EVIDENCES: null,
    SUBJECT_CONTEXT: JSON.stringify({
      document: {
        fileId: p.subject.fileId,
        title: masque(p.subject.title, 160), type: p.subject.documentType, date: p.subject.documentDate,
        supplier: borne(p.subject.supplier, 120), description: masque(p.subject.description, 300),
        multiAssetDeclaredByT1: p.subject.multiAssetDeclared,
      },
      facts,
      attachmentReview: {
        contract: T3_ATTACHMENT_REVIEW_CONTRACT,
        currentAssetIds: [...p.currentAssetIds].sort((a, b) => a - b),
        currentAttachment: p.origin,
        indices: p.indices.map((i) => ({
          indexId: i.indexId, candidateId: i.assetId, nature: INDEX_KIND_TEXT[i.kind], via: i.via,
          exclusive: i.exclusive, currentAsset: i.currentAsset, unitIds: i.unitIds.slice(0, 10),
        })),
        sourceUnits: p.units.map((u) => ({
          unitId: u.unitId, page: u.page, kind: u.kind, label: u.label, text: u.context, indexIds: u.indexIds,
        })),
      },
    }),
    CANDIDATES: [...p.candidates]
      .sort((a, b) => a.assetId - b.assetId)
      .map((c) => ({ candidateId: c.assetId, description: describeReviewCandidate(c, p.indices, p.origin) })),
    RELATION_TYPE: ATTACHMENT_REVIEW_RELATION,
  };
}

// ── Après le modèle ────────────────────────────────────────────────────────

/**
 * Lecture CONTRÔLÉE de la décision du modèle (pure).
 *
 *   Avec le contrat (marqueur du prompt actif) : section `attachmentReview`
 *   OBLIGATOIRE ; monde fermé (biens, indices, unités fournis) ; KEEP_CURRENT
 *   ne cite que le(s) bien(s) actuel(s) ; MULTIPLE exige le bien actuel et un
 *   autre bien désigné `certain` dans `matches` ; ARBITRATE exige un autre
 *   bien ET au moins une preuve citée (indice ou unité) — sinon « arbitrage
 *   non justifié », aucune carte.
 *   Sans le contrat : `matches` / `documentScope` (seuil 0,8, `certain`,
 *   marge) — bien actuel en tête → confirmé ; autre bien en tête, actuel
 *   sous le seuil → arbitrage ; égalité réelle → arbitrage ambigu ; rien de
 *   certain → aucune décision (aucune carte).
 */
export function decideAttachmentReview(
  output: T3LinkAmbiguityOutput,
  p: {
    currentAssetIds: readonly number[]; candidateIds: readonly number[]; indexIds: readonly number[]; unitIds: readonly string[];
    contract: boolean;
  },
): AttachmentReviewDecision {
  const candidats = new Set(p.candidateIds);
  const actuels = new Set(p.currentAssetIds);
  const { warnings } = closedWorldLinkAmbiguity(output, candidats);
  if (warnings.length > 0) return { kind: 'NO_DECISION', reasonCode: 'CLOSED_WORLD_VIOLATION' };
  const tries = [...output.matches].sort((a, b) => b.score - a.score || a.candidateId - b.candidateId);
  const certainsAutres = tries.filter((m) => !actuels.has(m.candidateId) && m.confidence === 'certain' && m.score >= ATTACHMENT_REVIEW_THRESHOLD);

  if (p.contract) {
    const r = output.attachmentReview;
    if (!r) return { kind: 'NO_DECISION', reasonCode: 'REVIEW_OUTPUT_MISSING' };
    const concernes = [...new Set(r.concernedAssetIds ?? [])];
    const indices = new Set(p.indexIds);
    const unites = new Set(p.unitIds);
    if (concernes.some((id) => !candidats.has(id)) || (r.citedIndexIds ?? []).some((id) => !indices.has(id))
        || (r.citedUnitIds ?? []).some((id) => !unites.has(id)) || (r.indexRoles ?? []).some((x) => !indices.has(x.indexId))) {
      return { kind: 'NO_DECISION', reasonCode: 'CLOSED_WORLD_VIOLATION' };
    }
    const autres = concernes.filter((id) => !actuels.has(id));
    const reason = r.reason.trim();
    if (r.decision === 'KEEP_CURRENT') {
      if (autres.length > 0) return { kind: 'NO_DECISION', reasonCode: 'INCONSISTENT_OUTPUT', reason };
      return { kind: 'CONFIRMED', reason, source: 'AI' };
    }
    if (r.decision === 'MULTIPLE') {
      const prouves = autres.filter((id) => certainsAutres.some((m) => m.candidateId === id));
      if (!concernes.some((id) => actuels.has(id)) || prouves.length === 0) return { kind: 'NO_DECISION', reasonCode: 'INCONSISTENT_OUTPUT', reason };
      return { kind: 'MULTI_ASSET', assetIds: prouves.sort((a, b) => a - b), reason };
    }
    // ARBITRATE : un autre bien désigné, et une justification fondée sur les éléments fournis.
    if (autres.length === 0) return { kind: 'NO_DECISION', reasonCode: 'INCONSISTENT_OUTPUT', reason };
    const cites = { units: [...new Set(r.citedUnitIds ?? [])].sort(), indices: [...new Set(r.citedIndexIds ?? [])].sort((a, b) => a - b) };
    if (cites.units.length === 0 && cites.indices.length === 0) return { kind: 'NO_DECISION', reasonCode: 'UNSUPPORTED_ARBITRATION', reason };
    const rang = (id: number) => { const i = tries.findIndex((m) => m.candidateId === id); return i < 0 ? Number.MAX_SAFE_INTEGER : i; };
    const suggere = [...autres].sort((a, b) => rang(a) - rang(b) || a - b)[0];
    const ambigu = autres.length > 1 || concernes.some((id) => actuels.has(id)) || !certainsAutres.some((m) => m.candidateId === suggere);
    return {
      kind: 'ARBITRATE', suggestedAssetId: suggere, ambiguous: ambigu, reason, citedUnitIds: cites.units, citedIndexIds: cites.indices,
      ...(typeof r.userQuestion === 'string' ? { userQuestion: r.userQuestion } : {}),
    };
  }

  // ── Sans contrat : contrat historique de la branche (matches, documentScope) ──
  const auDessus = tries.filter((m) => m.score >= ATTACHMENT_REVIEW_THRESHOLD);
  const actuelCertain = auDessus.find((m) => actuels.has(m.candidateId) && m.confidence === 'certain');
  if (output.documentScope === 'MULTIPLE' && actuelCertain && certainsAutres.length > 0) {
    return { kind: 'MULTI_ASSET', assetIds: certainsAutres.map((m) => m.candidateId).sort((a, b) => a - b), reason: certainsAutres[0].reason };
  }
  if (auDessus.length === 0) return { kind: 'NO_DECISION', reasonCode: 'INSUFFICIENT_EVIDENCE' };
  const { ambiguity } = decideLinks(auDessus, { exclusive: true, threshold: ATTACHMENT_REVIEW_THRESHOLD, minMargin: LINK_MIN_MARGIN });
  const top = auDessus[0];
  if (ambiguity) {
    const autre = auDessus.find((m) => !actuels.has(m.candidateId));
    if (autre && auDessus.some((m) => actuels.has(m.candidateId))) {
      return { kind: 'ARBITRATE', suggestedAssetId: autre.candidateId, ambiguous: true, reason: autre.reason, citedUnitIds: [], citedIndexIds: [] };
    }
    return { kind: 'NO_DECISION', reasonCode: 'INSUFFICIENT_EVIDENCE' };
  }
  if (actuels.has(top.candidateId)) {
    return top.confidence === 'certain' ? { kind: 'CONFIRMED', reason: top.reason, source: 'AI' } : { kind: 'NO_DECISION', reasonCode: 'INSUFFICIENT_EVIDENCE' };
  }
  if (top.confidence === 'certain') {
    return { kind: 'ARBITRATE', suggestedAssetId: top.candidateId, ambiguous: false, reason: top.reason, citedUnitIds: [], citedIndexIds: [] };
  }
  return { kind: 'NO_DECISION', reasonCode: 'INSUFFICIENT_EVIDENCE' };
}

/** Décisions réutilisables à contexte pertinent inchangé (une panne ou une réponse invalide est toujours rejouée). */
export function reusableDecision(d: AttachmentReviewDecision | null | undefined): boolean {
  if (!d) return false;
  if (d.kind !== 'NO_DECISION') return true;
  return d.reasonCode === 'INSUFFICIENT_EVIDENCE' || d.reasonCode === 'UNSUPPORTED_ARBITRATION' || d.reasonCode === 'INSUFFICIENT_CONTEXT';
}

/**
 * Clé de la mémoire (pure) : contexte PERTINENT de la revue seulement —
 * rattachement actuel, indices (bien, nature, exclusivité), contexte masqué
 * des unités, candidats, contrat et configuration IA effective. Une réanalyse
 * qui relit le même document (reprise TCO, réanalyse ordinaire) sans élément
 * nouveau rend la même clé : décision réutilisée, aucune carte recréée.
 */
export function attachmentReviewKey(p: {
  currentAssetIds: readonly number[]; origin: ReviewAttachmentOrigin; indices: readonly AttachmentIndex[];
  units: readonly ReviewUnitContext[]; candidates: ReadonlyArray<Pick<ReviewCandidate, 'assetId' | 'name'>>;
  contract: boolean; aiConfigSignature: string;
}): string {
  const payload = JSON.stringify([
    ATTACHMENT_REVIEW_VERSION, [...p.currentAssetIds].sort((a, b) => a - b), p.origin,
    p.indices.map((i) => [i.assetId, i.kind, i.exclusive, i.currentAsset]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    p.units.filter((u) => u.indexIds.length > 0).map((u) => normalizeText(u.context ?? '')).sort(),
    [...p.candidates].sort((a, b) => a.assetId - b.assetId).map((c) => [c.assetId, c.name.trim().toLowerCase()]),
    p.contract, p.aiConfigSignature,
  ]);
  return createHash('sha256').update(payload).digest('hex').slice(0, 40);
}

/** Origine du rattachement actuel (pure). */
export function attachmentOriginOf(s: { userEdited: boolean; userLinkAssetIds: readonly number[]; columnIsAutomatic: boolean; columnAssetId: number | null }): ReviewAttachmentOrigin {
  if (s.userEdited || s.userLinkAssetIds.length > 0) return 'USER';
  if (s.columnAssetId !== null && !s.columnIsAutomatic) return 'HISTORICAL';
  return 'AUTOMATIC';
}
