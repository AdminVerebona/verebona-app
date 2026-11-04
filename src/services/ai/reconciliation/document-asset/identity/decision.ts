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
 *      `crossDocument` de la sortie du modèle.
 *
 * Lot 108E (ticket « correctif #626 bis ») :
 *   · A2 — un document peut appartenir à plusieurs groupes (logement ET
 *     appareil) : la décision déterministe exige que TOUS désignent le même
 *     bien (ou ne le contredisent pas) ;
 *   · A4 — quand le modèle a REÇU les preuves croisées, la section
 *     `crossDocument` est OBLIGATOIRE pour un rattachement automatique et
 *     vérifiée face à l'état SERVEUR (statut du groupe, cible, appartenance du
 *     document, preuves citées) ; absente ou incohérente → abstention tracée.
 *     Appels non enrichis (prompt sans le bloc) : comportement d'avant.
 */
import type { CandidateSource } from '../candidate-builder';
import type { DocumentAssetCandidate, DocumentAssetDecision } from '../decision';
import type { AccountIdentityGraph, GroupMember, IdentityGroup } from './graph';
import { membershipOf, membershipsOf } from './graph';
import { T3_DOCUMENT_ASSET_CROSS_CONTRACT } from './contract';

/** Contexte « identité » d'UN document, porté par le contexte DOCUMENT_ASSET. */
export interface DocumentIdentityContext {
  graph: AccountIdentityGraph;
  group: IdentityGroup | null;
  member: GroupMember | null;
  exclusions: Array<{ groupKey: string; reason: string }>;
  /** Part « identité » de l'empreinte du contexte (null : hors groupe). */
  fingerprint: string | null;
  /** Lot 108E : toutes les appartenances du document (logement, véhicule, appareil). */
  memberships?: Array<{ group: IdentityGroup; member: GroupMember }>;
}

export function identityContextOf(graph: AccountIdentityGraph, fileId: number, fingerprint: string | null): DocumentIdentityContext {
  const m = membershipOf(graph, fileId);
  return {
    graph, group: m?.group ?? null, member: m?.member ?? null, exclusions: graph.exclusions.get(fileId) ?? [], fingerprint,
    memberships: membershipsOf(graph, fileId),
  };
}

const RATTACHABLE = ['DEMONSTRABLE', 'ATTESTED', 'CONFIRMED'];

/**
 * Lot 108E : cible commune de TOUTES les appartenances (pure) — `null` si
 * aucune n'établit de bien ou si l'une contredit (autre cible, groupe
 * AMBIGUOUS, bien hors des candidats d'un groupe à confirmer, bien refusé).
 */
export function consistentIdentityTarget(identity: DocumentIdentityContext | null): { group: IdentityGroup; member: GroupMember } | null {
  const ms = identity?.memberships?.length ? identity.memberships : identity?.group && identity.member ? [{ group: identity.group, member: identity.member }] : [];
  const porteur = ms.find((m) => m.group.targetAssetId && RATTACHABLE.includes(m.group.status)) ?? null;
  if (!porteur) return null;
  const cible = porteur.group.targetAssetId!;
  for (const m of ms) {
    const g = m.group;
    if (RATTACHABLE.includes(g.status) && g.targetAssetId !== cible) return null;
    if (g.status === 'AMBIGUOUS') return null;
    if (g.refusedAssetIds.includes(cible)) return null;
    if (g.status === 'TO_CONFIRM' && !g.candidateAssetIds.includes(cible)) return null;
  }
  return porteur;
}

/** Rattachement déterministe par l'identité du groupe (pure). */
export function decideFromIdentity(
  identity: DocumentIdentityContext | null,
  candidates: readonly DocumentAssetCandidate[],
  opts: { multiAssetDeclared: boolean; identifiedAssetIds: readonly number[] },
): DocumentAssetDecision | null {
  if (!identity?.group || !identity.member || opts.multiAssetDeclared) return null;
  const porteur = consistentIdentityTarget(identity);
  if (!porteur) return null;
  const g = porteur.group;
  // Identifiant fort du document vers un AUTRE bien : jamais tranché ici.
  if (opts.identifiedAssetIds.some((id) => id !== g.targetAssetId)) return null;
  const has = (c: DocumentAssetCandidate, s: CandidateSource) => !!c.sources?.includes(s);
  const autreDesigne = candidates.some((c) => c.assetId !== g.targetAssetId
    && (has(c, 'FACT_TARGET') || has(c, 'STRONG_IDENTIFIER') || has(c, 'SHARED_REFERENCE') || (has(c, 'T1_CANDIDATE') && c.t1?.confidence === 'certain')));
  if (autreDesigne) return null;
  return {
    kind: 'APPLY', assetId: g.targetAssetId!, score: 1, method: 'DETERMINISTIC',
    reason: `GROUP_IDENTITY_${g.status}:${porteur.member.via}${g.family === 'EQUIPMENT' ? ':EQUIPMENT' : ''}`,
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
  const ms = identity.memberships?.length ? identity.memberships : [{ group: g, member: identity.member }];
  const attente = ms.find((m) => m.group.status === 'TO_CONFIRM' && m.group.cardEligible);
  if (attente) return { kind: 'GROUP_CONFIRMATION_PENDING', groupKey: attente.group.groupKey };
  const refus = [...new Set(ms.flatMap((m) => m.group.refusedAssetIds))].sort((a, b) => a - b);
  if (refus.length > 0) return { kind: 'REFUSED_ASSETS', groupKey: (ms.find((m) => m.group.refusedAssetIds.length) ?? ms[0]).group.groupKey, refusedAssetIds: refus };
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
): { context: CrossDocumentContext; allowedEvidenceIds: Set<number>; server: CrossServerState } | null {
  if (!identity) return null;
  // Contrat v1 : familles PROPERTY / VEHICLE seulement (un groupe d'appareil reste une règle SERVEUR, jamais transmis).
  const bienFam = (x: IdentityGroup | null | undefined) => (x && x.family !== 'EQUIPMENT' ? x : null);
  const ms = identity.memberships?.length ? identity.memberships : identity.group && identity.member ? [{ group: identity.group, member: identity.member }] : [];
  const membre = ms.find((m) => bienFam(m.group)) ?? null;
  const exclu = identity.exclusions.map((e) => bienFam(identity.graph.byKey.get(e.groupKey))).find(Boolean) ?? null;
  const g = membre?.group ?? exclu;
  if (!g) return null;
  const member = membre?.member ?? null;
  const ref = 'I1';
  const meta = (id: number) => titles?.get(id) ?? { title: null, documentType: null, supplier: null };
  const docs: CrossDocumentContext['groupDocuments'] = [
    ...g.members.map((m) => ({ fileId: m.fileId, ...meta(m.fileId), membership: m.via === 'OWN_IDENTITY' ? 'OWN_IDENTITY' as const : 'CONTRACT' as const })),
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
  const exclusion = member ? null : identity.exclusions.find((e) => e.groupKey === g.groupKey) ?? null;
  const context: CrossDocumentContext = {
    contract: T3_DOCUMENT_ASSET_CROSS_CONTRACT,
    documentIdentity: {
      status: member ? 'MEMBER' : exclusion ? 'EXCLUDED' : 'NONE',
      identityRef: member ? ref : null,
      family: g.family as 'PROPERTY' | 'VEHICLE',
      // Le contrat v1 connaît OWN_IDENTITY et CONTRACT ; un saut par événement de référence est décrit comme un saut contractuel.
      membership: member ? (member.via === 'OWN_IDENTITY' ? 'OWN_IDENTITY' : 'CONTRACT') : null,
      exclusionReason: exclusion?.reason ?? null,
      hopFromFileId: member?.hopFromFileId ?? null,
    },
    groupDocuments: docs,
    evidences,
    edges: g.edges.slice(0, MAX_EVIDENCES).map((e) => ({
      fromFileId: e.fromFileId, toFileId: e.toFileId, via: e.via === 'SAME_OPERATION' ? 'SAME_CONTRACT' : e.via, kind: e.kind,
      evidenceIds: e.evidenceRefs.map((r) => idByRef.get(r)).filter((x): x is number => typeof x === 'number'),
    })),
    contradictions: g.contradictions.slice(0, 10).map((c) => ({ code: c.code, fileIds: c.fileIds, assetIds: c.assetIds ?? [] })),
    groupToAsset: {
      status: g.status, targetAssetId: g.targetAssetId, candidateAssetIds: g.candidateAssetIds, refusedAssetIds: g.refusedAssetIds,
      confirmedByUser: g.status === 'CONFIRMED',
    },
  };
  return {
    context, allowedEvidenceIds: new Set(evidences.map((e) => e.evidenceId)),
    server: { documentStatus: context.documentIdentity.status, groupStatus: g.status, targetAssetId: g.targetAssetId, candidateAssetIds: [...g.candidateAssetIds], refusedAssetIds: [...g.refusedAssetIds] },
  };
}

/** Lot 108E : état SERVEUR auquel la sortie croisée du modèle est confrontée. */
export interface CrossServerState {
  documentStatus: 'MEMBER' | 'EXCLUDED' | 'NONE';
  groupStatus: string;
  targetAssetId: number | null;
  candidateAssetIds: number[];
  refusedAssetIds: number[];
}

// ── Sortie du modèle : section `crossDocument` ──────────────────────────────

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
 *     contradiction signalée, relation groupe → bien non établie pour un
 *     membre ; lot 108E (A4) : relation groupe → bien ou appartenance du
 *     document INCOHÉRENTE avec l'état serveur, aucune preuve citée ;
 *   · `missing` (lot 108E) : section ABSENTE alors que le modèle a reçu les
 *     preuves croisées (`required`) — jamais un rattachement automatique.
 * Section absente sans `required` : rien à contrôler (prompt sans le bloc,
 * autres relations) — rétrocompatibilité.
 */
export function validateCrossDocumentOutput(
  out: CrossDocumentOutput | null | undefined,
  ctx: { allowedEvidenceIds: ReadonlySet<number>; member: boolean; required?: boolean; server?: CrossServerState | null },
): { violation: boolean; blockApply: boolean; missing: boolean; reasons: string[] } {
  if (!out) {
    return ctx.required
      ? { violation: false, blockApply: true, missing: true, reasons: ['CROSS_DOCUMENT_OUTPUT_MISSING'] }
      : { violation: false, blockApply: false, missing: false, reasons: [] };
  }
  const reasons: string[] = [];
  const inconnues = (out.citedEvidenceIds ?? []).filter((id) => !ctx.allowedEvidenceIds.has(id));
  if (inconnues.length) reasons.push(`UNKNOWN_EVIDENCE_ID:${inconnues.slice(0, 5).join(',')}`);
  if (out.documentApplicability !== 'APPLIES') reasons.push(`DOCUMENT_APPLICABILITY_${out.documentApplicability}`);
  if (out.userValidationRequired) reasons.push('USER_VALIDATION_REQUIRED');
  if ((out.contradictions ?? []).length > 0) reasons.push('CONTRADICTIONS_REPORTED');
  if (ctx.member && (out.groupToAsset === 'UNCERTAIN' || out.groupToAsset === 'NOT_ESTABLISHED')) reasons.push(`GROUP_TO_ASSET_${out.groupToAsset}`);
  const sv = ctx.server ?? null;
  if (ctx.required) {
    // Une réponse ENRICHIE doit être vérifiable : preuves citées, statuts cohérents avec le serveur.
    if ((out.citedEvidenceIds ?? []).length === 0) reasons.push('CITED_EVIDENCE_MISSING');
    if (sv) {
      const etabli = RATTACHABLE.includes(sv.groupStatus);
      if (out.groupToAsset === 'ESTABLISHED' && !etabli) reasons.push(`GROUP_TO_ASSET_INCONSISTENT_WITH_SERVER:${sv.groupStatus}`);
      if (sv.documentStatus === 'MEMBER' && out.groupToAsset === 'NOT_APPLICABLE') reasons.push('GROUP_TO_ASSET_NOT_APPLICABLE_FOR_MEMBER');
      if (sv.documentStatus === 'MEMBER' && out.documentIdentity !== 'ESTABLISHED') reasons.push(`DOCUMENT_IDENTITY_${out.documentIdentity}_FOR_MEMBER`);
      if (sv.documentStatus === 'EXCLUDED' && out.documentIdentity === 'ESTABLISHED') reasons.push('DOCUMENT_IDENTITY_INCONSISTENT_WITH_SERVER:EXCLUDED');
      if (sv.documentStatus !== 'MEMBER' && out.groupToAsset === 'ESTABLISHED') reasons.push('GROUP_TO_ASSET_ESTABLISHED_FOR_NON_MEMBER');
    }
  }
  return { violation: inconnues.length > 0, blockApply: reasons.length > 0, missing: false, reasons };
}

/**
 * Lot 108E (A4) : le bien RETENU par le modèle est-il compatible avec l'état
 * serveur du groupe ? (cible établie → ce bien seul ; bien refusé → jamais ;
 * groupe à confirmer → jamais sans confirmation). Pure.
 */
export function crossTargetAllowed(assetId: number, sv: CrossServerState | null | undefined): string | null {
  if (!sv || sv.documentStatus !== 'MEMBER') return sv?.refusedAssetIds.includes(assetId) ? 'TARGET_REFUSED_BY_USER' : null;
  if (sv.refusedAssetIds.includes(assetId)) return 'TARGET_REFUSED_BY_USER';
  if (RATTACHABLE.includes(sv.groupStatus) && sv.targetAssetId !== null && sv.targetAssetId !== assetId) return 'TARGET_DIFFERS_FROM_GROUP';
  if (sv.groupStatus === 'TO_CONFIRM' || sv.groupStatus === 'AMBIGUOUS' || sv.groupStatus === 'REFUSED') return `GROUP_${sv.groupStatus}`;
  return null;
}
