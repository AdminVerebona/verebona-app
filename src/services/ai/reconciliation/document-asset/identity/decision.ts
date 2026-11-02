/**
 * T3 DOCUMENT_ASSET — décisions PURES fondées sur les groupes d'identité
 * (lot 105D, ticket « Rattachement rétroactif après création d'un bien »,
 * §D3, §E, §F).
 *
 *   1. `decideFromIdentity` : APRÈS les identifiants forts et les règles
 *      contextuelles, AVANT tout appel modèle. Un membre d'un groupe
 *      DEMONSTRABLE (identifiant d'un seul bien), ATTESTED (documents déjà
 *      rattachés à ce seul bien) ou CONFIRMED (confirmation de l'utilisateur)
 *      est rattaché sans IA — jamais si le document désigne par ailleurs un
 *      autre bien, s'il est multibiens, ou s'il n'est pas lui-même membre
 *      (identité propre ou contrat à un saut).
 *   2. `identityGate` : groupe TO_CONFIRM avec carte groupée → abstention sans
 *      IA ni carte individuelle (la décision appartient à l'utilisateur) ;
 *      biens refusés → retirés des candidats (aucune question répétée).
 *   3. `crossDocumentContext` : contexte « preuves croisées » du prompt T3
 *      (contrat `t3-document-asset-cross-v1`) — références opaques, AUCUNE
 *      adresse en clair.
 *   4. `validateCrossDocumentOutput` : contrôle serveur de la section
 *      facultative `crossDocument` de la sortie du modèle.
 */
import type { CandidateSource } from '../candidate-builder';
import type { DocumentAssetCandidate, DocumentAssetDecision } from '../decision';
import type { AccountIdentityGraph, GroupMember, IdentityGroup } from './graph';
import { membershipOf } from './graph';
import { T3_DOCUMENT_ASSET_CROSS_CONTRACT } from './contract';

/** Contexte « identité » d'UN document, porté par le contexte DOCUMENT_ASSET. */
export interface DocumentIdentityContext {
  graph: AccountIdentityGraph;
  group: IdentityGroup | null;
  member: GroupMember | null;
  exclusions: Array<{ groupKey: string; reason: string }>;
  /** Part « identité » de l'empreinte du contexte (null : hors groupe). */
  fingerprint: string | null;
}

export function identityContextOf(graph: AccountIdentityGraph, fileId: number, fingerprint: string | null): DocumentIdentityContext {
  const m = membershipOf(graph, fileId);
  return { graph, group: m?.group ?? null, member: m?.member ?? null, exclusions: graph.exclusions.get(fileId) ?? [], fingerprint };
}

/** Rattachement déterministe par l'identité du groupe (pure). */
export function decideFromIdentity(
  identity: DocumentIdentityContext | null,
  candidates: readonly DocumentAssetCandidate[],
  opts: { multiAssetDeclared: boolean; identifiedAssetIds: readonly number[] },
): DocumentAssetDecision | null {
  if (!identity?.group || !identity.member || opts.multiAssetDeclared) return null;
  const g = identity.group;
  if (!g.targetAssetId || !['DEMONSTRABLE', 'ATTESTED', 'CONFIRMED'].includes(g.status)) return null;
  // Identifiant fort du document vers un AUTRE bien : jamais tranché ici.
  if (opts.identifiedAssetIds.some((id) => id !== g.targetAssetId)) return null;
  const has = (c: DocumentAssetCandidate, s: CandidateSource) => !!c.sources?.includes(s);
  const autreDesigne = candidates.some((c) => c.assetId !== g.targetAssetId
    && (has(c, 'FACT_TARGET') || has(c, 'STRONG_IDENTIFIER') || has(c, 'SHARED_REFERENCE') || (has(c, 'T1_CANDIDATE') && c.t1?.confidence === 'certain')));
  if (autreDesigne) return null;
  return {
    kind: 'APPLY', assetId: g.targetAssetId, score: 1, method: 'DETERMINISTIC',
    reason: `GROUP_IDENTITY_${g.status}:${identity.member.via}`,
  };
}

export type IdentityGate =
  | { kind: 'GROUP_CONFIRMATION_PENDING'; groupKey: string }
  | { kind: 'REFUSED_ASSETS'; groupKey: string; refusedAssetIds: number[] }
  | null;

/** Garde avant l'IA : question groupée en attente, ou biens refusés (pure). */
export function identityGate(identity: DocumentIdentityContext | null): IdentityGate {
  const g = identity?.group;
  if (!g || !identity?.member) return null;
  if (g.status === 'TO_CONFIRM' && g.cardEligible) return { kind: 'GROUP_CONFIRMATION_PENDING', groupKey: g.groupKey };
  if (g.refusedAssetIds.length > 0) return { kind: 'REFUSED_ASSETS', groupKey: g.groupKey, refusedAssetIds: [...g.refusedAssetIds] };
  return null;
}

// ── Contexte « preuves croisées » du prompt T3 ─────────────────────────────

export interface CrossDocumentContext {
  contract: typeof T3_DOCUMENT_ASSET_CROSS_CONTRACT;
  documentIdentity: {
    status: 'MEMBER' | 'EXCLUDED' | 'NONE';
    identityRef: string | null;
    family: 'PROPERTY' | 'VEHICLE' | null;
    membership: 'OWN_IDENTITY' | 'CONTRACT' | null;
    exclusionReason: string | null;
    hopFromFileId: number | null;
  };
  groupDocuments: Array<{
    fileId: number; title: string | null; documentType: string | null; supplier: string | null;
    membership: 'OWN_IDENTITY' | 'CONTRACT' | 'ANCHOR' | 'EXCLUDED'; exclusionReason?: string; linkedAssetIds?: number[];
  }>;
  evidences: Array<{
    evidenceId: number; fileId: number; identityRef: string; identityFamily: string; kind: string; role: string;
    field: string | null; origin: string; reliability: string; verifiedByServer: true; thisDocument: boolean;
  }>;
  edges: Array<{ fromFileId: number; toFileId: number; via: string; kind: string; evidenceIds: number[] }>;
  contradictions: Array<{ code: string; fileIds: number[]; assetIds: number[] }>;
  groupToAsset: {
    status: string; targetAssetId: number | null; candidateAssetIds: number[]; refusedAssetIds: number[]; confirmedByUser: boolean;
  };
}

/** Bornes du contexte transmis (jamais de la découverte). */
const MAX_GROUP_DOCUMENTS = 30;
const MAX_EVIDENCES = 40;

/**
 * Contexte croisé d'un document pour le prompt T3 (pure) : `null` si le
 * document n'appartient à aucun groupe et n'en est exclu d'aucun. Les
 * valeurs (adresse…) ne sont JAMAIS transmises : `identityRef` opaque.
 */
export function crossDocumentContext(
  identity: DocumentIdentityContext | null, fileId: number, titles?: ReadonlyMap<number, { title: string | null; documentType: string | null; supplier: string | null }>,
): { context: CrossDocumentContext; allowedEvidenceIds: Set<number> } | null {
  if (!identity) return null;
  const g = identity.group ?? (identity.exclusions[0] ? identity.graph.byKey.get(identity.exclusions[0].groupKey) ?? null : null);
  if (!g) return null;
  const ref = 'I1';
  const meta = (id: number) => titles?.get(id) ?? { title: null, documentType: null, supplier: null };
  const docs: CrossDocumentContext['groupDocuments'] = [
    ...g.members.map((m) => ({ fileId: m.fileId, ...meta(m.fileId), membership: m.via })),
    ...g.anchors.map((a) => ({ fileId: a.fileId, ...meta(a.fileId), membership: 'ANCHOR' as const, linkedAssetIds: a.assetIds })),
    ...g.excluded.map((x) => ({ fileId: x.fileId, ...meta(x.fileId), membership: 'EXCLUDED' as const, exclusionReason: x.reason })),
  ].sort((a, b) => (a.fileId === fileId ? -1 : b.fileId === fileId ? 1 : a.fileId - b.fileId)).slice(0, MAX_GROUP_DOCUMENTS);
  const idByRef = new Map<string, number>();
  const evidences: CrossDocumentContext['evidences'] = [];
  for (const s of [...g.evidence].sort((a, b) => (a.fileId === fileId ? -1 : b.fileId === fileId ? 1 : a.fileId - b.fileId || a.ref.localeCompare(b.ref)))) {
    if (evidences.length >= MAX_EVIDENCES || idByRef.has(s.ref)) continue;
    const evidenceId = evidences.length + 1;
    idByRef.set(s.ref, evidenceId);
    evidences.push({
      evidenceId, fileId: s.fileId, identityRef: s.family === 'CONTRACT' ? 'C1' : ref, identityFamily: s.family, kind: s.kind, role: s.role,
      field: s.field, origin: s.origin, reliability: s.reliability, verifiedByServer: true, thisDocument: s.fileId === fileId,
    });
  }
  const exclusion = identity.exclusions.find((e) => e.groupKey === g.groupKey) ?? null;
  const context: CrossDocumentContext = {
    contract: T3_DOCUMENT_ASSET_CROSS_CONTRACT,
    documentIdentity: {
      status: identity.member ? 'MEMBER' : exclusion ? 'EXCLUDED' : 'NONE',
      identityRef: identity.member ? ref : null,
      family: g.family,
      membership: identity.member?.via ?? null,
      exclusionReason: exclusion?.reason ?? null,
      hopFromFileId: identity.member?.hopFromFileId ?? null,
    },
    groupDocuments: docs,
    evidences,
    edges: g.edges.slice(0, MAX_EVIDENCES).map((e) => ({
      fromFileId: e.fromFileId, toFileId: e.toFileId, via: e.via, kind: e.kind,
      evidenceIds: e.evidenceRefs.map((r) => idByRef.get(r)).filter((x): x is number => typeof x === 'number'),
    })),
    contradictions: g.contradictions.slice(0, 10).map((c) => ({ code: c.code, fileIds: c.fileIds, assetIds: c.assetIds ?? [] })),
    groupToAsset: {
      status: g.status, targetAssetId: g.targetAssetId, candidateAssetIds: g.candidateAssetIds, refusedAssetIds: g.refusedAssetIds,
      confirmedByUser: g.status === 'CONFIRMED',
    },
  };
  return { context, allowedEvidenceIds: new Set(evidences.map((e) => e.evidenceId)) };
}

// ── Sortie du modèle : section facultative `crossDocument` ─────────────────

export interface CrossDocumentOutput {
  documentIdentity: 'ESTABLISHED' | 'UNCERTAIN' | 'NONE';
  groupToAsset: 'ESTABLISHED' | 'UNCERTAIN' | 'NOT_ESTABLISHED' | 'NOT_APPLICABLE';
  documentApplicability: 'APPLIES' | 'DOES_NOT_APPLY' | 'UNCERTAIN';
  citedEvidenceIds?: number[];
  contradictions?: string[];
  userValidationRequired?: boolean;
}

/**
 * Contrôle serveur de la section `crossDocument` (pure) :
 *   · `violation` : preuve citée hors de celles fournies (monde fermé U1) ;
 *   · `blockApply` : portée du document non établie, validation demandée,
 *     contradiction signalée, ou relation groupe → bien non établie pour un
 *     document membre d'un groupe — aucun rattachement automatique.
 * Section absente : rien à contrôler (prompt sans le bloc, autres relations).
 */
export function validateCrossDocumentOutput(
  out: CrossDocumentOutput | null | undefined,
  ctx: { allowedEvidenceIds: ReadonlySet<number>; member: boolean },
): { violation: boolean; blockApply: boolean; reasons: string[] } {
  if (!out) return { violation: false, blockApply: false, reasons: [] };
  const reasons: string[] = [];
  const inconnues = (out.citedEvidenceIds ?? []).filter((id) => !ctx.allowedEvidenceIds.has(id));
  if (inconnues.length) reasons.push(`UNKNOWN_EVIDENCE_ID:${inconnues.slice(0, 5).join(',')}`);
  if (out.documentApplicability !== 'APPLIES') reasons.push(`DOCUMENT_APPLICABILITY_${out.documentApplicability}`);
  if (out.userValidationRequired) reasons.push('USER_VALIDATION_REQUIRED');
  if ((out.contradictions ?? []).length > 0) reasons.push('CONTRADICTIONS_REPORTED');
  if (ctx.member && (out.groupToAsset === 'UNCERTAIN' || out.groupToAsset === 'NOT_ESTABLISHED')) reasons.push(`GROUP_TO_ASSET_${out.groupToAsset}`);
  return { violation: inconnues.length > 0, blockApply: reasons.length > 0, reasons };
}
