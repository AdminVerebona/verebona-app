/**
 * T3 — harmonisation du nommage documentaire (lot 61) : CONTEXTE, pur.
 *
 * LOT DE COMPARAISON (code) ≠ FAMILLE (IA). Le code rassemble seulement des
 * documents COMPARABLES, sans règle métier : même émetteur (fournisseur
 * normalisé : casse, accents, formes juridiques) ; à défaut d'émetteur, même
 * nature documentaire et même bien. Le modèle décide ensuite, à l'intérieur
 * du lot, quelles familles existent (nature, contrat, bien, service, contenu)
 * — deux documents d'un même lot peuvent appartenir à des familles et des
 * conventions différentes (deux contrats d'un même fournisseur).
 *
 * BORNES SANS PERTE : un lot plus grand que `maxDocs` est examiné en
 * plusieurs appels ; chaque appel reçoit ses documents À EXAMINER et des
 * documents de RÉFÉRENCE du même lot (déjà examinés ou les plus récents),
 * ainsi que les conventions décrites au dernier examen. Tous les documents
 * du lot sont examinés, appel après appel (reprise au passage suivant).
 *
 * STABILITÉ : l'empreinte d'un lot ne dépend que des documents, de leurs
 * noms, de leur protection et de leurs données (pas de la date, ni de la
 * version du prompt) : à état inchangé, aucun nouvel appel.
 */
import { createHash } from 'node:crypto';
import type { NameOrigin } from './guards';

/** Version du constructeur de contexte : entre dans l'empreinte des lots. */
export const NAMING_CONTEXT_VERSION = 'naming-v1';
export const NAMING_RELATION = 'DOCUMENT_NAMING — harmoniser les intitulés des documents d’une même famille (sortie : document_renames)';

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
}

const LEGAL_FORMS = new Set(['sa', 'sas', 'sasu', 'sarl', 'eurl', 'sci', 'snc', 'scp', 'scm', 'gie', 'ltd', 'llc', 'inc', 'gmbh', 'ag', 'bv', 'nv', 'spa', 'srl', 'plc', 'cie', 'et']);

/** Clé d'émetteur (pure) : générique, aucune liste de fournisseurs. */
export function supplierKey(s: string | null | undefined): string | null {
  const mots = String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/\./g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter((w) => w && !LEGAL_FORMS.has(w));
  return mots.length ? mots.join(' ') : null;
}

/** Lot de comparaison d'un document, ou `null` (contexte insuffisant). */
export function groupKeyOf(d: Pick<NamingDoc, 'supplier' | 'typeCode' | 'assetId'>): string | null {
  const s = supplierKey(d.supplier);
  if (s) return `s:${s}`;
  if (d.typeCode) return `t:${d.typeCode}|a:${d.assetId ?? '-'}`;
  return null;
}

const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 32);

/** Empreinte des DONNÉES d'un document (hors nom) : nouvelle information ⇔ empreinte modifiée. */
export function documentFingerprint(d: NamingDoc): string {
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

/** Empreinte d'un lot (pure) : documents, noms, protection, données. */
export function groupFingerprint(docs: readonly NamingDoc[]): string {
  return sha([NAMING_CONTEXT_VERSION, [...docs].sort((a, b) => a.id - b.id).map((d) => [d.id, docSnapshotHash(d)])]);
}

/** Instantané d'un lot (identifiant → empreinte), mémorisé après un examen complet. */
export function groupSnapshot(docs: readonly NamingDoc[]): Record<string, string> {
  return Object.fromEntries(docs.map((d) => [String(d.id), docSnapshotHash(d)]));
}

export interface NamingGroup { key: string; docs: NamingDoc[] }

/** Regroupe les documents du compte (pure). Rend aussi les documents sans lot (contexte insuffisant). */
export function buildGroups(docs: readonly NamingDoc[]): { groups: NamingGroup[]; withoutContext: number[] } {
  const parCle = new Map<string, NamingDoc[]>();
  const sans: number[] = [];
  for (const d of docs) {
    const k = groupKeyOf(d);
    if (!k) { sans.push(d.id); continue; }
    const l = parCle.get(k) ?? [];
    l.push(d);
    parCle.set(k, l);
  }
  const groups = [...parCle.entries()].map(([key, l]) => ({ key, docs: orderDocs(l) }));
  groups.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { groups, withoutContext: sans };
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

/** Détail d'un document fourni à l'IA (chargé pour les seuls documents de l'appel). */
export interface NamingDocDetail {
  facts: Array<{ key: string; value: string; period?: string | null }>;
  excerpt: string | null;
  operations: Array<{ id: number; type: string | null; status: string }>;
  history: Array<{ at: string; from: string | null; to: string | null; origin: string }>;
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
    constraints: { maxNameLength: p.maxLength, protectedOrigins: ['USER'], renameOnlyDocumentsOfThisSet: true },
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
      renameAllowed: !isProtected(d),
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
