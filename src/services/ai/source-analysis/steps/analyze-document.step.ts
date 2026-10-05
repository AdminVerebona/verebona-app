/**
 * T1 master, branche ANALYZE_DOCUMENT (opération `t1_analyze_document`) —
 * CDC 15 §23, §22.2, PM-T1, T1-01, T1-04, T1-08.
 *
 * Remplace (lot 16b-3 : seul chemin) les anciennes étapes `extract_source`,
 * `classify_document`, `identify_entities` et `classify_rubric` : UNE analyse
 * cohérente du document regroupé (métadonnées, classification, entités,
 * transcription, visuel, tableaux, faits ciblés).
 *
 * Ce que fait le serveur autour de l'appel, et que le prompt ne peut garantir :
 *   · il fournit les référentiels en DONNÉES (registre canonique filtré par la
 *     famille du bien connu, EVENT_CATALOG, DOCUMENT_CATALOG) ;
 *   · il impose la TASK et le schéma de la branche (`T1AnalyzeDocumentOutput`) ;
 *   · après validation Zod : preuve obligatoire par fait (U2), identifiants
 *     revérifiés en base (U9, `identifier-verifier`), tableaux normalisés et
 *     références de cellules ramenées à la grille (U10, T1-08).
 *
 * Cette étape n'écrit RIEN. La projection (`projection/document-projection`)
 * et la persistance décident ensuite.
 */
import { AiGateway } from '../../gateway/ai-gateway';
import {
  T1_MASTER_PROMPT_CODE,
  type T1AnalyzeDocumentOutput,
  type T1Fact,
} from '../master/t1-contract';
import { T1AnalyzeDocumentTolerantOutput, splitNormalisation } from '../master/tolerant-output';
import { buildAnalyzeDocumentVariables, catalogForCapabilities, contextFilterStats, knownTargetFamily } from '../master/prompt-context';
import { enforceT1Capabilities } from '../master/capability-guard';
import { getAccountCapabilities } from '@/services/account-capabilities.service';
import { catalogForPrompts } from '@/services/canonical/registry';
import { checkFactEvidence, factLabel } from '../master/fact-evidence';
import { verifyCandidates, type VerifiableEntity } from '../identifier-verifier';
import { loadAssetFamilies } from '../master/rubric-rules';
import { normalizeTablesWithMap, cellAt } from '../../knowledge/document-tables';
import { emptyTrace, mergeTrace } from '../trace';
import type { VerifiableTargetType } from '../projection/document-projection';
import type {
  SourceInput, AnalysisContext, AnalysisWarning, AiOperationTrace, ExtractedTable, LinkCandidate,
} from '../types';
import type { AssetFamily as V2AssetFamily } from '@/lib/referential/v2';

export const T1_ANALYZE_DOCUMENT_OPERATION = 't1_analyze_document';

export interface AnalyzeDocumentResult {
  /** Sortie validée : faits prouvés, identifiants d'entités vérifiés, cellules ramenées à la grille. */
  analysis: T1AnalyzeDocumentOutput;
  tables: ExtractedTable[];
  assetCandidates: LinkCandidate[];
  roomCandidates: LinkCandidate[];
  equipmentCandidates: LinkCandidate[];
  /** Identifiants VÉRIFIÉS en base, par type de cible (projection). */
  verifiedIds: Record<VerifiableTargetType, Set<number>>;
  /** Bien du document : connu, sinon unique candidat vérifié certain, sinon null. */
  documentAssetId: number | null;
  warnings: AnalysisWarning[];
  trace: AiOperationTrace;
  promptVersion: string;
}

export async function analyzeDocument(
  input: SourceInput,
  groupIndices: number[],
  ctx: AnalysisContext,
): Promise<AnalyzeDocumentResult> {
  const warnings: AnalysisWarning[] = [];
  const knownAssetId = ctx.linkedAssetId ?? null;

  // DOCUMENT_CATALOG restreint aux familles du bien connu (toutes sinon).
  const v2Families: V2AssetFamily[] = await loadAssetFamilies(knownAssetId ? [knownAssetId] : []);

  // Capacités du compte AU MOMENT de l'analyse (pièces, équipements) : elles
  // filtrent le contexte transmis ET la sortie (garde-fou ci-dessous).
  const capabilities = ctx.capabilities ?? await getAccountCapabilities(ctx.accountId);

  const res = await AiGateway.execute({
    useCaseCode: 'SOURCE_ANALYSIS',
    operationCode: T1_ANALYZE_DOCUMENT_OPERATION,
    task: 'ANALYZE_DOCUMENT',
    masterPromptCode: T1_MASTER_PROMPT_CODE,
    accountId: input.accountId,
    userId: input.userId,
    sourceIds: groupIndices.map((i) => input.sourceIds[i]),
    promptVariables: buildAnalyzeDocumentVariables({ input, groupIndices, ctx, v2Families, capabilities }),
    attachments: buildAttachments(input, groupIndices),
    // Normalisation tolérante AVANT le contrat strict (`master/tolerant-output`).
    outputSchema: T1AnalyzeDocumentTolerantOutput,
    sourceVersion: input.sourceVersion,
  });
  const { output: brut, report } = splitNormalisation(res.data);

  // ── Capacités du compte : garde-fou serveur (le modèle n'est pas une garantie) ──
  // Avant vérification des identifiants, projection et persistance : une cible
  // pièce / équipement hors capacités devient une connaissance générique
  // (rien n'est perdu, rien n'est reporté sur le bien) ; entités écartées.
  const { output: out, counters } = enforceT1Capabilities(brut, capabilities);
  if (counters.forbiddenTargetsRequalified > 0) {
    warnings.push({
      code: 'FORBIDDEN_TARGET_REQUALIFIED',
      message: `${counters.forbiddenTargetsRequalified} information(s) sur une pièce ou un équipement conservée(s) comme connaissance générique (fonctionnalité non incluse dans l’offre).`,
      target: 't1-master:capabilities',
    });
  }
  const capabilityTrace = {
    rooms: capabilities.rooms,
    equipments: capabilities.equipments,
    ...counters,
    ...contextFilterStats(ctx, capabilities),
    fieldsFilteredByCapabilities: catalogForCapabilities(catalogForPrompts({ family: knownTargetFamily(ctx) }), capabilities).fieldsFiltered,
  };
  if (counters.forbiddenTargetsReturned > 0 || counters.forbiddenEntitiesDropped > 0) {
    // Observabilité : compteurs seulement, aucune valeur métier.
    console.info(`[t1-capabilities] compte ${ctx.accountId} ${JSON.stringify(capabilityTrace)}`);
  }
  if (report?.truncatedFacts) {
    warnings.push({
      code: 'FACTS_TRUNCATED',
      message: `Sortie limitée à 300 faits : ${report.truncatedFacts} fait(s) au-delà non retenus.`,
      target: 't1-master:facts-truncated',
    });
  }
  if (report?.tooLongFacts) {
    warnings.push({
      code: 'FACT_INVALID_DROPPED',
      message: `${report.tooLongFacts} fait(s) à valeur trop longue écarté(s) (jamais tronqués : la valeur serait fausse).`,
      target: 't1-master:facts-too-long',
    });
  }
  if (report?.droppedTables) {
    warnings.push({
      code: 'TABLE_STRUCTURE_UNCERTAIN',
      message: `${report.droppedTables} tableau(x) inexploitable(s) écarté(s) (sans colonne ou plus de 1000 lignes).`,
      target: 't1-master:tables-dropped',
    });
  }
  if (report?.droppedObservations) {
    warnings.push({
      code: 'PARTIAL_EXTRACTION',
      message: `${report.droppedObservations} observation(s) visuelle(s) sans description écartée(s).`,
      target: 't1-master:observations-dropped',
    });
  }
  if (report?.droppedFacts) {
    warnings.push({
      code: 'FACT_INVALID_DROPPED',
      message: `${report.droppedFacts} fait(s) mal formé(s) écarté(s) ; le reste de l’analyse est conservé.`,
      target: 't1-master:facts-invalid',
    });
  }

  // ── Tableaux : grille explicite, cellules ramenées à la grille fusionnée ──
  const { tables, locate } = normalizeTablesWithMap(out.tables);
  const uncertain = tables.filter((t) => t.uncertain);
  if (uncertain.length > 0) {
    warnings.push({
      code: 'TABLE_STRUCTURE_UNCERTAIN',
      message: `Structure incertaine : ${uncertain.map((t) => `« ${t.title ?? `tableau ${t.index + 1}`} » (${t.issues.slice(0, 2).join(' ; ') || 'signalée par l’analyse'})`).join(', ')}.`,
    });
  }
  if (!out.hasExploitableContent) {
    warnings.push({ code: 'NO_EXPLOITABLE_CONTENT', message: 'La source ne contient aucune information exploitable.' });
  }

  // ── Preuve obligatoire par fait (U2) ────────────────────────────────────
  const facts: T1Fact[] = [];
  const rejected: string[] = [];
  for (const f of out.facts) {
    const check = checkFactEvidence(f);
    if (!check.ok) {
      // Une valeur vide n'est pas une information : elle n'a pas à voyager.
      if (check.reason !== 'NO_VALUE') rejected.push(factLabel(f));
      continue;
    }
    const cell = f.evidence?.table ? tableRef(f.evidence.table, tables, locate) : undefined;
    const { table: _brute, ...evidence } = check.fact.evidence ?? {};
    void _brute;
    facts.push({ ...check.fact, evidence: cell ? { ...evidence, table: cell } : evidence });
  }
  if (rejected.length > 0) {
    warnings.push({
      code: 'FIELD_WITHOUT_EVIDENCE',
      message: `${rejected.length} information(s) écartée(s) faute de preuve adaptée (${rejected.slice(0, 5).join(', ')}).`,
    });
  }
  // Un extrait « lu » doit se retrouver dans le texte lisible (transcription
  // ou contenu préextrait) ; sinon la lecture n'est pas vérifiable : le fait
  // reste, en `probable` (U11). Contrôle impossible sans aucun texte.
  const introuvables = verifyExcerpts(facts, [out.transcription, input.extractedContent]);
  if (introuvables.length > 0) {
    warnings.push({
      code: 'EXCERPT_NOT_FOUND',
      message: `${introuvables.length} extrait(s) introuvable(s) dans le texte lisible : confiance ramenée à « probable » (${introuvables.slice(0, 5).join(', ')}).`,
      target: 't1-master:excerpt-not-found',
    });
  }

  const low = facts.filter((f) => f.confidence !== 'certain').length;
  if (facts.length >= 5 && low / facts.length > 0.6) {
    warnings.push({
      code: 'LOW_CONFIDENCE_OVERALL',
      message: `${Math.round((low / facts.length) * 100)} % des champs extraits sont incertains.`,
    });
  }

  // ── Identifiants en monde fermé (U9) : entités ET cibles des faits ──────
  const verification = await verifyAll(out, facts, input.accountId);
  warnings.push(...verification.warnings);
  const verifiedIds = verification.verifiedIds;
  if (knownAssetId) verifiedIds.ASSET.add(knownAssetId);

  if (out.entities.multiAsset) {
    warnings.push({
      code: 'MULTI_ASSET_DOCUMENT',
      message:
        'Le document concerne plusieurs biens. Chaque fait reste sur sa cible ; ' +
        'la réconciliation traitera les cas ambigus.',
    });
  }

  const known: LinkCandidate[] = knownAssetId
    ? [{
        entityId: knownAssetId, confidence: 'certain', score: 1,
        reason: "bien choisi par l'utilisateur au dépôt du document", excerpt: '', verified: true,
      }]
    : [];
  // N-N (T1-05) : les autres biens vérifiés restent candidats, même quand un
  // bien est connu ; `resolveAssetId` retient toujours le bien connu.
  const others = verification.assets.filter((c) => c.entityId !== knownAssetId);
  const assetCandidates = [...known, ...others];
  const verifiedAssets = verification.assets.filter((c) => c.verified);
  if (!knownAssetId && verifiedAssets.length > 1) {
    warnings.push({
      code: 'AMBIGUOUS_ASSET',
      message: 'Plusieurs biens correspondent. Le rattachement sera arbitré par la réconciliation.',
    });
  }
  const documentAssetId = knownAssetId
    ?? (verifiedAssets.length === 1 && verifiedAssets[0].confidence === 'certain' ? verifiedAssets[0].entityId : null);

  // Sortie « propre » transmise à la projection : identifiants d'entités
  // neutralisés s'ils n'existent pas dans le compte.
  const neutralise = <C extends { entityId: number | null }>(list: C[], type: VerifiableTargetType): C[] =>
    list.map((c) => (c.entityId !== null && !verifiedIds[type].has(c.entityId) ? { ...c, entityId: null } : c));
  const analysis: T1AnalyzeDocumentOutput = {
    ...out,
    entities: {
      ...out.entities,
      assets: neutralise(out.entities.assets, 'ASSET'),
      rooms: neutralise(out.entities.rooms, 'ROOM'),
      equipments: neutralise(out.entities.equipments, 'EQUIPMENT'),
      suppliers: neutralise(out.entities.suppliers, 'SUPPLIER'),
    },
    facts,
  };

  return {
    analysis,
    tables,
    assetCandidates,
    roomCandidates: verification.rooms,
    equipmentCandidates: verification.equipments,
    verifiedIds,
    documentAssetId,
    warnings,
    trace: { ...mergeTrace(emptyTrace(), res, T1_ANALYZE_DOCUMENT_OPERATION), accountCapabilities: capabilityTrace },
    promptVersion: res.promptVersion,
  };
}

/** Forme de comparaison : sans accents, casse ni ponctuation ni espaces. */
const plat = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Déclasse en `probable` (en place) les faits TEXT_EXTRACTION « certains »
 * dont l'extrait ne figure pas dans les textes fournis. Rend leurs libellés.
 */
export function verifyExcerpts(facts: T1Fact[], textes: Array<string | undefined | null>): string[] {
  const corpus = textes.filter((t): t is string => Boolean(t?.trim())).map(plat).join('|');
  if (!corpus) return [];
  const out: string[] = [];
  for (const f of facts) {
    const e = f.provenance === 'TEXT_EXTRACTION' ? f.evidence?.excerpt : undefined;
    if (!e || f.confidence !== 'certain') continue;
    const cle = plat(e);
    if (!cle || corpus.includes(cle)) continue;
    f.confidence = 'probable';
    out.push(factLabel(f));
  }
  return out;
}

type RawCandidate = T1AnalyzeDocumentOutput['entities']['assets'][number];

/** Candidat du master → `LinkCandidate` (contrat historique). */
export function toLinkCandidate(c: RawCandidate): LinkCandidate {
  return {
    entityId: c.entityId,
    ...(c.rawLabel ? { rawLabel: c.rawLabel } : {}),
    confidence: c.confidence,
    score: c.score,
    reason: c.reason ?? '',
    excerpt: c.evidenceSignals.join(' ; '),
    verified: false,
  };
}

const ENTITE: Record<VerifiableTargetType, VerifiableEntity> = {
  ASSET: 'asset', EQUIPMENT: 'equipment', ROOM: 'room', SUPPLIER: 'supplier',
};

/**
 * Vérifie en une requête par type les identifiants des entités ET ceux des
 * cibles de faits. Les avertissements sont dédoublonnés (un même identifiant
 * halluciné cité par dix faits n'en produit qu'un).
 */
async function verifyAll(out: T1AnalyzeDocumentOutput, facts: T1Fact[], accountId: number) {
  const lists: Record<VerifiableTargetType, LinkCandidate[]> = {
    ASSET: out.entities.assets.map(toLinkCandidate),
    ROOM: out.entities.rooms.map(toLinkCandidate),
    EQUIPMENT: out.entities.equipments.map(toLinkCandidate),
    SUPPLIER: out.entities.suppliers.map(toLinkCandidate),
  };
  const fromFacts: Record<VerifiableTargetType, LinkCandidate[]> = { ASSET: [], ROOM: [], EQUIPMENT: [], SUPPLIER: [] };
  for (const f of facts) {
    const t = f.target.type;
    if (t !== 'ASSET' && t !== 'ROOM' && t !== 'EQUIPMENT' && t !== 'SUPPLIER') continue;
    const id = f.target.entityId;
    if (id === null || lists[t].some((c) => c.entityId === id) || fromFacts[t].some((c) => c.entityId === id)) continue;
    fromFacts[t].push({ entityId: id, confidence: f.target.confidence, score: 0, reason: 'cible d’un fait', excerpt: '', verified: false });
  }

  const types = Object.keys(ENTITE) as VerifiableTargetType[];
  const outcomes = await Promise.all(types.map((t) => verifyCandidates(ENTITE[t], [...lists[t], ...fromFacts[t]], accountId)));

  const verifiedIds: Record<VerifiableTargetType, Set<number>> = {
    ASSET: new Set(), ROOM: new Set(), EQUIPMENT: new Set(), SUPPLIER: new Set(),
  };
  const warnings: AnalysisWarning[] = [];
  const seen = new Set<string>();
  const result: Partial<Record<VerifiableTargetType, LinkCandidate[]>> = {};
  types.forEach((t, i) => {
    const o = outcomes[i];
    for (const c of o.candidates) if (c.verified && c.entityId !== null) verifiedIds[t].add(c.entityId);
    for (const w of o.warnings) {
      const k = `${w.code}:${w.target ?? w.message}`;
      if (!seen.has(k)) { seen.add(k); warnings.push(w); }
    }
    result[t] = o.candidates.slice(0, lists[t].length);
  });

  return {
    verifiedIds, warnings,
    assets: result.ASSET ?? [], rooms: result.ROOM ?? [], equipments: result.EQUIPMENT ?? [],
  };
}

/** Une référence de cellule invalide est ignorée plutôt que d'associer au hasard (U10). */
function tableRef(
  r: { index: number; row: number; column: number },
  tables: ExtractedTable[],
  locate: (rawIndex: number, rawRow: number) => { index: number; row: number } | null,
): { index: number; row: number; column: number } | undefined {
  const at = locate(r.index, r.row);
  if (!at || !cellAt(tables[at.index], at.row, r.column)) return undefined;
  return { index: at.index, row: at.row, column: r.column };
}

function buildAttachments(input: SourceInput, groupIndices: number[]) {
  if (!input.contentUrls) return [];
  return groupIndices
    .map((i) => ({
      url: input.contentUrls![i],
      mimeType: input.mimeTypes[i] ?? 'application/pdf',
      displayName: input.displayNames[i],
    }))
    .filter((a) => Boolean(a.url));
}
