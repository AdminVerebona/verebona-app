/**
 * CONTEXTE de résolution T3 DOCUMENT_ASSET et son EMPREINTE (lot 34E — tickets
 * « T3 : réconciliation globale réellement continue » et « T3 —
 * réconciliation continue des documents non résolus »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * `documentAssetContextFingerprint` représente TOUT ce qui peut modifier le
 * résultat de DOCUMENT_ASSET, et RIEN d'autre :
 *
 *   côté document  connaissance documentaire (extraction, transcription,
 *                  faits actifs, cibles, futures unités de source — `digest`),
 *                  candidats T1, liens SECONDARY / MENTIONED ;
 *   côté compte    les biens qui DEVIENNENT candidats (nom, alias, famille,
 *                  sous-type, identifiants — sensibles hachés —, provenance et
 *                  signaux), recalculés depuis l'index de TOUS les biens ;
 *   côté moteur    version de résolution T3, du Candidate Builder, des règles
 *                  déterministes.
 *
 * Un bien sans rapport créé, un document sans lien ajouté : les candidats ne
 * changent pas → même empreinte → CONFIRMED_NO_CHANGE sans IA. Un bien
 * renommé « Maison de Valence », une adresse complétée, un fait qui apporte
 * une immatriculation : un candidat apparaît (ou change de preuve) → empreinte
 * différente → réévaluation (déterministe d'abord). Jamais un hachage de la
 * base du compte.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'node:crypto';
import type { AttachmentState } from './attachment-state';
import { buildDocumentAssetCandidates, CANDIDATE_BUILDER_VERSION, type CandidateBuildResult } from './candidate-builder';
import type { DocumentAssetCandidate } from './decision';
import { loadDocumentKnowledgeSources, type DocumentKnowledgeSources } from './document-sources';
import { identifiersFingerprint, promptIdentifiers, type IdentifierResolution } from './identifiers';
import { loadAccountMatchingIndex, type AccountMatchingIndex } from './matching-index';
import type { DocumentAssetResolution } from './resolution.repository';
import { DOCUMENT_ASSET_RESOLUTION_VERSION } from './version';

/**
 * Version des règles déterministes (identifiants forts, référence partagée,
 * nom distinctif unique). Entre dans l'empreinte.
 *   · 1 — lot 34E.
 */
export const DOCUMENT_ASSET_RULES_VERSION = 1;

export interface DocumentAssetContext {
  accountId: number;
  fileId: number;
  sources: DocumentKnowledgeSources | null;
  build: CandidateBuildResult;
  /** Candidats prêts pour la décision (tous, sans borne de découverte). */
  candidates: DocumentAssetCandidate[];
  labels: Map<number, { name: string; category: string | null; subtype: string | null }>;
  identification: IdentifierResolution;
  /** Empreinte des identifiants des biens (signal historique 32C, conservé). */
  idsFingerprint: string;
  extractionAt: string | null;
  multiAssetDeclared: boolean;
  fingerprint: string;
  /** Index utilisé (réutilisable pour une seconde évaluation du même compte). */
  index: AccountMatchingIndex;
  t1Candidates: DocumentAssetResolution['t1Candidates'];
}

/** Empreinte du contexte (pure). */
export function documentAssetContextFingerprint(p: {
  documentDigest: string | null;
  candidates: ReadonlyArray<Pick<DocumentAssetCandidate, 'assetId' | 'name' | 'family' | 'subtype' | 'identifiers' | 'serverSignals' | 't1' | 'currentRole' | 'sources' | 'contextSignals' | 'distinctiveNameMatch'>>;
  /** Identifiants (sensibles compris) des biens candidats : hachés. */
  candidateIdentifiers: Record<number, Record<string, string>>;
  matches: readonly string[];
  versions?: { resolution: number; builder: number; rules: number };
}): string {
  const v = p.versions ?? {
    resolution: DOCUMENT_ASSET_RESOLUTION_VERSION, builder: CANDIDATE_BUILDER_VERSION, rules: DOCUMENT_ASSET_RULES_VERSION,
  };
  const ids = (id: number) => createHash('sha256')
    .update(JSON.stringify(Object.entries(p.candidateIdentifiers[id] ?? {}).sort(([a], [b]) => a.localeCompare(b)))).digest('hex');
  const payload = JSON.stringify({
    v: [v.resolution, v.builder, v.rules],
    d: p.documentDigest,
    c: [...p.candidates].sort((a, b) => a.assetId - b.assetId).map((c) => [
      c.assetId, c.name.trim().toLowerCase(), c.family, c.subtype, ids(c.assetId),
      [...(c.sources ?? [])].sort(), [...c.serverSignals].sort(), [...(c.contextSignals ?? [])].sort(),
      c.t1 ? [c.t1.confidence, c.t1.score] : null, c.currentRole, c.distinctiveNameMatch === true,
    ]),
    m: [...p.matches].sort(),
  });
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * Reconstruit le contexte d'un document depuis l'état ACTUEL (connaissance
 * persistée + index du compte). Aucune écriture, aucun appel modèle : sert
 * à la fois au travail T3 et à la confirmation en page de balayage.
 */
export async function computeDocumentAssetContext(p: {
  accountId: number;
  fileId: number;
  state: Pick<AttachmentState, 'secondaryAssetIds' | 'mentionedAssetIds'>;
  resolution: Pick<DocumentAssetResolution, 't1Candidates'> | null;
  /** Index du compte déjà construit (balayage) ; à défaut, construit ici. */
  index?: AccountMatchingIndex;
}): Promise<DocumentAssetContext> {
  const t1Candidates = p.resolution?.t1Candidates ?? [];
  const [sources, index] = await Promise.all([
    loadDocumentKnowledgeSources({ accountId: p.accountId, fileId: p.fileId, t1Candidates }),
    p.index ? Promise.resolve(p.index) : loadAccountMatchingIndex(p.accountId),
  ]);
  const build = buildDocumentAssetCandidates({ index, sources, state: p.state, t1Candidates, fileId: p.fileId });
  const t1 = new Map(t1Candidates.map((c) => [c.assetId, c]));
  const factTargets = new Set(build.candidates.filter((c) => c.sources.includes('FACT_TARGET')).map((c) => c.assetId));

  const labels = new Map<number, { name: string; category: string | null; subtype: string | null }>();
  const candidateIdentifiers: Record<number, Record<string, string>> = {};
  const candidates: DocumentAssetCandidate[] = build.candidates.map((b) => {
    const a = index.byId.get(b.assetId)!;
    labels.set(a.assetId, { name: a.name, category: a.category, subtype: a.subtype });
    candidateIdentifiers[a.assetId] = a.record.values;
    const c = t1.get(a.assetId);
    return {
      assetId: a.assetId,
      name: a.name,
      family: a.family,
      subtype: a.subtype,
      identifiers: promptIdentifiers(a.record),
      serverSignals: b.evidenceSignals,
      contextSignals: b.contextSignals,
      sources: b.sources,
      distinctiveNameMatch: b.distinctiveNameMatch,
      t1: c ? { confidence: c.confidence, score: c.score, reason: c.reason, signals: c.signals } : null,
      currentRole: p.state.secondaryAssetIds.includes(a.assetId) || factTargets.has(a.assetId)
        ? 'SECONDARY' as const
        : p.state.mentionedAssetIds.includes(a.assetId) ? 'MENTIONED' as const : null,
    };
  });

  const fingerprint = documentAssetContextFingerprint({
    documentDigest: sources?.digest ?? null, candidates, candidateIdentifiers, matches: build.deterministicMatches,
  });
  return {
    accountId: p.accountId,
    fileId: p.fileId,
    sources,
    build,
    candidates,
    labels,
    identification: build.identification,
    idsFingerprint: identifiersFingerprint(index.records),
    extractionAt: sources?.extraction?.extractedAt ?? null,
    multiAssetDeclared: sources?.extraction?.multiAsset === true,
    fingerprint,
    index,
    t1Candidates,
  };
}

/** Provenance des candidats, pour le monitoring (`assetId` → sources). */
export function candidateSourcesOf(ctx: Pick<DocumentAssetContext, 'candidates'>): Record<string, string[]> {
  return Object.fromEntries(ctx.candidates.map((c) => [String(c.assetId), c.sources ?? []]));
}
