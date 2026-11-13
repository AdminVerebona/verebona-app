/**
 * Lot 113AM (Trello #739) — justification des rattachements AUTOMATIQUES
 * écrits par T3 (DOCUMENT_ASSET : déterministe, identité de groupe /
 * rattachement rétroactif, IA ; revue du rattachement #711). Module PUR.
 *
 * Chaque preuve est tirée de ce que T3 a réellement examiné : correspondances
 * exactes (rôle qualifié de l'adresse), sources du Candidate Builder,
 * signaux d'identité du document, décision du modèle. La garde partagée
 * (`admitDocumentAssetLink`) juge ensuite, avant l'écriture.
 */
import type { AddressRole, LinkJustification, LinkProof } from '@/services/documents/document-asset-links/admission';
import { addressRoleOf, qualifyAddressValue, type AddressQualification, type AddressRoleFact } from './address-roles';
import { CITY_POSTAL_CONTEXT, type CandidateSource } from './candidate-builder';
import type { IdentifierResolution } from './identifiers';
import type { DocumentAssetCandidate, DocumentAssetDecision } from './decision';
import type { DocumentIdentityContext } from './identity/decision';

/** Raison posée par le serveur sur un candidat T1 issu d'une correspondance exacte (même texte que T1). */
const SERVER_IDENTIFIER_REASON = 'identifiant canonique exact (contrôle serveur)';

/** Preuves « candidat » d'un bien (sources du Candidate Builder, correspondances exactes). Pure. */
export function candidateProofs(p: {
  assetId: number;
  candidate: Pick<DocumentAssetCandidate, 'sources' | 'contextSignals' | 't1' | 'distinctiveNameMatch'> | null | undefined;
  identification: Pick<IdentifierResolution, 'matches'>;
  qualifications: readonly AddressQualification[];
}): LinkProof[] {
  const out: LinkProof[] = [];
  for (const m of p.identification.matches) {
    if (m.assetId !== p.assetId) continue;
    out.push({ kind: 'IDENTIFIER', identifierKind: m.kind, via: m.via, ...(m.kind === 'ADDRESS' ? { addressRole: addressRoleOf(p.qualifications, p.assetId) } : {}) });
  }
  const c = p.candidate;
  for (const s of (c?.sources ?? []) as CandidateSource[]) {
    switch (s) {
      case 'STRONG_IDENTIFIER': break; // porté par `identification`
      case 'T1_CANDIDATE':
        out.push(c?.t1?.reason === SERVER_IDENTIFIER_REASON
          ? { kind: 'CONTEXT', detail: 'T1_SERVER_CANDIDATE' }
          : { kind: 'MODEL_DESIGNATION', score: c?.t1?.score ?? null, detail: c?.t1?.confidence ?? null });
        break;
      case 'FACT_TARGET': out.push({ kind: 'FACT_TARGET' }); break;
      case 'SHARED_REFERENCE': out.push({ kind: 'SHARED_REFERENCE' }); break;
      case 'EXACT_NAME': case 'ALIAS':
        out.push(c?.distinctiveNameMatch ? { kind: 'DISTINCT_NAME', detail: s } : { kind: 'CONTEXT', detail: s });
        break;
      case 'CONTEXTUAL_MATCH': {
        const sig = c?.contextSignals ?? [];
        const seulementAdresse = sig.length > 0 && sig.every((x) => x === CITY_POSTAL_CONTEXT || /adresse du bien cit/.test(x));
        out.push(seulementAdresse ? { kind: 'CONTEXT', identifierKind: 'ADDRESS', detail: s } : { kind: 'CONTEXT', detail: s });
        break;
      }
      default: out.push({ kind: 'CONTEXT', detail: s });
    }
  }
  return out;
}

/** Appui d'une décision d'identité : signaux du document qui fondent son appartenance au groupe. Pure. */
export function identitySupport(p: {
  identity: DocumentIdentityContext | null | undefined;
  targetAssetId: number;
  facts: readonly AddressRoleFact[];
  texts: ReadonlyArray<string | null | undefined>;
}): LinkProof[] {
  const ms = p.identity?.memberships?.length ? p.identity.memberships
    : p.identity?.group && p.identity.member ? [{ group: p.identity.group, member: p.identity.member }] : [];
  const out: LinkProof[] = [];
  for (const { group, member } of ms) {
    if (group.targetAssetId !== p.targetAssetId) continue;
    if (member.via !== 'OWN_IDENTITY') { out.push({ kind: 'SHARED_REFERENCE', detail: `IDENTITY_${member.via}` }); continue; }
    for (const s of group.evidence.filter((e) => member.evidenceRefs.includes(e.ref))) {
      if (s.kind === 'ADDRESS') {
        const rue = s.key.split('|')[0] ?? '';
        const q = qualifyAddressValue({ addr: rue, assetId: p.targetAssetId, facts: p.facts, texts: p.texts });
        out.push({ kind: 'IDENTIFIER', identifierKind: 'ADDRESS', addressRole: q.role, via: s.origin === 'FACT' ? 'fact' : 'text', detail: 'IDENTITY_SIGNAL' });
      } else {
        out.push({ kind: 'IDENTIFIER', identifierKind: s.kind, detail: 'IDENTITY_SIGNAL' });
      }
    }
  }
  return out;
}

/** Justification d'un rattachement T3 DOCUMENT_ASSET (pure). */
export function documentAssetLinkJustification(p: {
  assetId: number;
  decision: Extract<DocumentAssetDecision, { kind: 'APPLY' | 'MULTI_ASSET' }>;
  branch: string | null | undefined;
  candidates: readonly DocumentAssetCandidate[];
  identification: Pick<IdentifierResolution, 'matches'>;
  qualifications: readonly AddressQualification[];
  identity?: DocumentIdentityContext | null;
  facts: readonly AddressRoleFact[];
  texts: ReadonlyArray<string | null | undefined>;
}): LinkJustification {
  const base = candidateProofs({
    assetId: p.assetId, candidate: p.candidates.find((c) => c.assetId === p.assetId), identification: p.identification, qualifications: p.qualifications,
  });
  const proofs: LinkProof[] = [];
  if (p.branch === 'IDENTITY' || p.decision.reason.startsWith('GROUP_IDENTITY')) {
    proofs.push({ kind: 'IDENTITY_GROUP', detail: p.decision.reason, support: identitySupport({ identity: p.identity, targetAssetId: p.assetId, facts: p.facts, texts: p.texts }) });
    proofs.push(...base);
  } else if (p.decision.method === 'AI') {
    proofs.push({ kind: 'AI_DECISION', detail: p.decision.reason.slice(0, 120), score: p.decision.kind === 'APPLY' ? p.decision.score : null, support: base }, ...base);
  } else {
    proofs.push(...base);
  }
  return { step: 'T3_DOCUMENT_ASSET', rule: `${p.branch ?? 'NONE'}:${p.decision.reason}`.slice(0, 200), proofs };
}

/** Justification d'un lien SECONDARY posé par la revue du rattachement (#711, MULTI_ASSET). Pure. */
export function attachmentReviewLinkJustification(p: {
  assetId: number;
  indices: ReadonlyArray<{ assetId: number; kind: string }>;
  facts: ReadonlyArray<{ targetType: string | null; targetEntityId: number | null }>;
  modelCandidate: boolean;
  addressRole: AddressRole;
  reviewKey: string | null;
}): LinkJustification {
  const support: LinkProof[] = [];
  for (const i of p.indices) {
    if (i.assetId !== p.assetId) continue;
    support.push(i.kind === 'ADDRESS'
      ? { kind: 'IDENTIFIER', identifierKind: 'ADDRESS', addressRole: p.addressRole }
      : { kind: 'IDENTIFIER', identifierKind: i.kind });
  }
  if (p.facts.some((f) => f.targetType === 'ASSET' && f.targetEntityId === p.assetId)) support.push({ kind: 'FACT_TARGET' });
  if (p.modelCandidate) support.push({ kind: 'MODEL_DESIGNATION' });
  return { step: 'T3_ATTACHMENT_REVIEW', rule: 'MULTI_ASSET_SECONDARY', proofs: [{ kind: 'AI_REVIEW', detail: p.reviewKey?.slice(0, 64) ?? null, support }] };
}
