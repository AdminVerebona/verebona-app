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
 *
 * Lot 49B (couche exhaustive T1) : les unités source et faits non résolus
 * EFFECTIVEMENT CONSIDÉRÉS — ceux qui désignent un candidat
 * (`matchedSourceUnits`) — entrent dans l'empreinte (`su`, absent quand il n'y
 * en a pas : l'empreinte des documents sans unité pertinente est inchangée).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'node:crypto';
import type { AttachmentState } from './attachment-state';
import { buildDocumentAssetCandidates, CANDIDATE_BUILDER_VERSION, isDistinctiveName, type CandidateBuildResult } from './candidate-builder';
import type { DocumentAssetCandidate } from './decision';
import { EXHAUSTIVE_SOURCE_KINDS, loadDocumentKnowledgeSources, type DocumentKnowledgeSources } from './document-sources';
import {
  identifiersFingerprint, normalizeText, promptIdentifiers, resolveAssetByIdentifiers,
  type IdentifierResolution,
} from './identifiers';
import { loadAccountMatchingIndex, type AccountMatchingIndex } from './matching-index';
import { registerSourceUnitProviders } from './source-unit-provider';
import type { DocumentAssetResolution } from './resolution.repository';
import { DOCUMENT_ASSET_RESOLUTION_VERSION } from './version';
import { documentIdentityFingerprint } from './identity/graph';
import { identityContextOf, type DocumentIdentityContext } from './identity/decision';
import { identityGraphFor } from './identity/load';

/**
 * Version des règles déterministes (identifiants forts, référence partagée,
 * nom distinctif unique). Entre dans l'empreinte.
 *   · 1 — lot 34E.
 */
const DOCUMENT_ASSET_RULES_VERSION = 1;

// Lot 49B : couche exhaustive T1 branchée dès le chargement du contexte T3.
registerSourceUnitProviders();

/** Unité source (ou fait non résolu) considérée : elle désigne au moins un candidat. */
export interface MatchedSourceUnit {
  unitId: string;
  origin: string;
  uncertain: boolean;
  assetIds: number[];
}

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
  /** Unités de la couche exhaustive T1 qui désignent un candidat (lot 49B). */
  matchedSourceUnits: MatchedSourceUnit[];
  /**
   * Lot 105D : identité documentaire du document (groupe, rôle, statut du
   * groupe face aux biens, décisions de l'utilisateur) — null : hors groupe,
   * coupure ou graphe illisible (comportement antérieur).
   */
  identity?: DocumentIdentityContext | null;
}

/** Empreinte du contexte (pure). */
export function documentAssetContextFingerprint(p: {
  documentDigest: string | null;
  candidates: ReadonlyArray<Pick<DocumentAssetCandidate, 'assetId' | 'name' | 'family' | 'subtype' | 'identifiers' | 'serverSignals' | 't1' | 'currentRole' | 'sources' | 'contextSignals' | 'distinctiveNameMatch'>>;
  /** Identifiants (sensibles compris) des biens candidats : hachés. */
  candidateIdentifiers: Record<number, Record<string, string>>;
  matches: readonly string[];
  versions?: { resolution: number; builder: number; rules: number };
  /** Unités source considérées (lot 49B) — absentes ou vides : empreinte inchangée. */
  sourceUnits?: ReadonlyArray<Pick<MatchedSourceUnit, 'unitId' | 'uncertain' | 'assetIds'>>;
  /** Lot 105D : part « identité documentaire » (groupe) — absente : empreinte inchangée. */
  identity?: string | null;
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
    ...(p.sourceUnits && p.sourceUnits.length > 0
      ? { su: [...p.sourceUnits].map((u) => [u.unitId, u.uncertain, [...u.assetIds].sort((a, b) => a - b)]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))) }
      : {}),
    ...(p.identity ? { id: p.identity } : {}),
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
  /** Lot 105D : graphe d'identité déjà construit pour le passage (null : sans identité) ; à défaut, mémorisé par index. */
  identityGraph?: import('./identity/graph').AccountIdentityGraph | null;
}): Promise<DocumentAssetContext> {
  const t1Candidates = p.resolution?.t1Candidates ?? [];
  const [sources, index] = await Promise.all([
    loadDocumentKnowledgeSources({ accountId: p.accountId, fileId: p.fileId, t1Candidates }),
    p.index ? Promise.resolve(p.index) : loadAccountMatchingIndex(p.accountId),
  ]);
  // Lot 105D : identité documentaire (graphe du compte mémorisé par index) — lue AVANT les candidats :
  // une adresse citée comme facturation / livraison n'est jamais une preuve pour le bien qui la porte.
  const graph = p.identityGraph !== undefined ? p.identityGraph : await identityGraphFor(p.accountId, index);
  const build = roleAwareBuild(
    buildDocumentAssetCandidates({ index, sources, state: p.state, t1Candidates, fileId: p.fileId }),
    graph?.contextOnlyAssets?.get(p.fileId) ?? [],
  );
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

  const matchedSourceUnits = matchSourceUnits(sources, index, candidates.map((c) => c.assetId));
  const identityFp = documentIdentityFingerprint(graph, p.fileId);
  const identity = graph ? identityContextOf(graph, p.fileId, identityFp) : null;
  const fingerprint = documentAssetContextFingerprint({
    documentDigest: sources?.digest ?? null, candidates, candidateIdentifiers, matches: build.deterministicMatches,
    sourceUnits: matchedSourceUnits, identity: identityFp,
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
    matchedSourceUnits,
    identity,
  };
}

/**
 * Lot 105D (§D1) — rôle des adresses : une correspondance d'ADRESSE avec un
 * bien dont l'adresse ne figure dans le document QU'AVEC un rôle autre que
 * celui du bien (facturation, livraison, fournisseur, installation) n'est
 * jamais un identifiant fort : retirée de l'identification (aucun
 * rattachement déterministe) et du « contrôle serveur » du candidat (aucune
 * preuve pour le modèle) — gardée comme simple indice de contexte. Pure.
 */
export function roleAwareBuild(build: CandidateBuildResult, contextOnlyAssetIds: readonly number[]): CandidateBuildResult {
  if (contextOnlyAssetIds.length === 0) return build;
  const hors = new Set(contextOnlyAssetIds);
  const retirer = (m: IdentifierResolution['matches'][number]) => m.kind === 'ADDRESS' && hors.has(m.assetId);
  if (!build.identification.matches.some(retirer)) return build;
  const matches = build.identification.matches.filter((m) => !retirer(m));
  const assetIds = [...new Set(matches.map((m) => m.assetId))].sort((a, b) => a - b);
  const identification: IdentifierResolution = {
    matches, assetIds, uniqueAssetId: assetIds.length === 1 ? assetIds[0] : null, ambiguous: assetIds.length > 1,
    multiAssetCandidate: assetIds.length > 1 && assetIds.every((id) => matches.some((m) => m.assetId === id && m.exclusive)),
  };
  const ADRESSE = /^adresse du bien identique/;
  const candidates = build.candidates.map((c) => {
    if (!hors.has(c.assetId) || matches.some((m) => m.assetId === c.assetId)) return c;
    const evidenceSignals = c.evidenceSignals.filter((x) => !ADRESSE.test(x));
    const sources = evidenceSignals.length === c.evidenceSignals.length ? c.sources : c.sources.filter((x) => x !== 'STRONG_IDENTIFIER');
    return {
      ...c, sources, evidenceSignals,
      contextSignals: [...new Set([...c.contextSignals, 'adresse du bien citée comme adresse de facturation, de livraison ou du fournisseur (rôle établi par le serveur) — jamais une preuve'])].sort(),
    };
  });
  return { ...build, candidates, identification, deterministicMatches: matches.map((m) => `${m.assetId}:${m.kind}`).sort() };
}

/** Unités considérées au plus (empreinte, monitoring). */
const MATCHED_UNITS_MAX = 200;

/**
 * Unités de la couche exhaustive T1 qui désignent un candidat (pure) :
 * identifiant fort exact du bien (ou d'un équipement du bien), nom / alias
 * distinctif, marque et modèle. Même contrôle serveur exact que le Candidate
 * Builder, unité par unité, restreint aux candidats retenus.
 */
export function matchSourceUnits(
  sources: Pick<DocumentKnowledgeSources, 'texts'> | null, index: AccountMatchingIndex, candidateIds: readonly number[],
): MatchedSourceUnit[] {
  if (!sources || candidateIds.length === 0) return [];
  const ids = new Set(candidateIds);
  const records = [
    ...index.records.filter((r) => ids.has(r.assetId)),
    ...index.entities.filter((e) => e.type === 'EQUIPMENT' && e.serial && ids.has(e.assetId))
      .map((e) => ({ assetId: e.assetId, family: 'OBJECT' as const, values: { serialNumber: e.serial! } })),
  ];
  const noms = index.assets.filter((a) => ids.has(a.assetId))
    .map((a) => ({ assetId: a.assetId, formes: [a.normalizedName, ...a.aliases].filter((f) => f.length >= 3 && isDistinctiveName(f)), bm: a.brandModel }));
  const out = new Map<string, MatchedSourceUnit>();
  for (const t of sources.texts) {
    if (!EXHAUSTIVE_SOURCE_KINDS.includes(String(t.origin)) || !t.unitIds?.length) continue;
    const r = resolveAssetByIdentifiers(records, { facts: [], texts: [t.text] });
    const hay = ` ${normalizeText(t.text)} `;
    const parNom = noms.filter((n) => n.formes.some((f) => hay.includes(` ${f} `)) || (n.bm && hay.includes(` ${n.bm} `))).map((n) => n.assetId);
    const assetIds = [...new Set([...r.assetIds, ...parNom])].sort((a, b) => a - b);
    if (assetIds.length === 0) continue;
    for (const unitId of t.unitIds) {
      const prev = out.get(unitId);
      out.set(unitId, {
        unitId, origin: String(t.origin), uncertain: (prev?.uncertain ?? true) && t.uncertain === true,
        assetIds: [...new Set([...(prev?.assetIds ?? []), ...assetIds])].sort((a, b) => a - b),
      });
      if (out.size >= MATCHED_UNITS_MAX) break;
    }
    if (out.size >= MATCHED_UNITS_MAX) break;
  }
  return [...out.values()].sort((a, b) => a.unitId.localeCompare(b.unitId));
}

/** Provenance des candidats, pour le monitoring (`assetId` → sources). */
export function candidateSourcesOf(ctx: Pick<DocumentAssetContext, 'candidates'>): Record<string, string[]> {
  return Object.fromEntries(ctx.candidates.map((c) => [String(c.assetId), c.sources ?? []]));
}
