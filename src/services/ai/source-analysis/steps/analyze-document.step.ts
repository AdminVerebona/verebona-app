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
import { T1AnalyzeDocumentTolerantOutput, splitNormalisation, type T1NormalisationReport } from '../master/tolerant-output';
import { buildAnalyzeDocumentVariables, catalogForCapabilities, contextFilterStats, knownTargetFamily } from '../master/prompt-context';
import { enforceT1Capabilities } from '../master/capability-guard';
import { getAccountCapabilities, type AccountCapabilities } from '@/services/account-capabilities.service';
import type { AiAttachment } from '../../gateway/types';
import { applyOverflow } from '../source-units/merge';
import { continueByPages } from '../source-units/continuation';
import { isTruncationFailure } from '../source-units/truncation';
import { T1AnalyzeDocumentOutput as T1AnalyzeDocumentStrict } from '../master/t1-contract';
import { fullTextOf } from '../source-units/build-units';
import type { T1ExtractionExtras } from '../source-units/complete-extraction';
import { anchorOperationCandidates, mergeOperationCandidates, type AnchoredOperationCandidate, type CandidateOrigin } from '../operation-candidates/prepare';
import { anchorValueDecisions, type AnchoredValueDecision } from '../value-decisions/validate';
import { valueDecisionsOutputStatus, type ValueDecisionsPass } from '../value-decisions/output-conformity';
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
import {
  matchSignals, resolveAssetByIdentifiers, type IdentifierResolution,
} from '../../reconciliation/document-asset/identifiers';
import { addressRoleOf, admissibleIdentification, restrictIdentification, type AddressQualification } from '../../reconciliation/document-asset/address-roles';

const T1_ANALYZE_DOCUMENT_OPERATION = 't1_analyze_document';

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
  /** Lot 113AM (#739) : rôle qualifié de chaque correspondance d'adresse (biens, rôles, provenances — jamais la valeur). */
  addressQualifications?: AddressQualification[];
  warnings: AnalysisWarning[];
  trace: AiOperationTrace;
  promptVersion: string;
  /**
   * Lot 34F — matière de la couche A : texte lu par segment (passe, lots de
   * pages), lacunes, éléments écartés CONSERVÉS, lots et capacités (pour la
   * réparation ciblée). Lu par `completeT1Extraction`.
   */
  extraction?: T1ExtractionExtras;
  /**
   * Lot 40 — candidats Opération ANCRÉS (preuves = empreintes de faits) de la
   * passe principale et des lots de pages, fusionnés ; barrière serveur
   * appliquée ensuite (`analyseGroupWithMaster`). Jamais ceux des passes de
   * réparation ciblée.
   */
  operationCandidates?: AnchoredOperationCandidate[];
  /**
   * Lot 91D — décisions de T1 sur les valeurs significatives (passe
   * principale et lots de pages), ANCRÉES sur les empreintes de faits.
   * `null` : aucune sortie ne portait le tableau (contrat non porté).
   * Validées et filtrées par le marqueur du prompt dans `analyseGroupWithMaster`.
   */
  valueDecisions?: AnchoredValueDecision[] | null;
  /**
   * Lot 108K (§C) — statut de `valueDecisions` dans CHAQUE réponse T1
   * (passe principale, lots de pages) : présent, vide, absent, mal formé,
   * tronqué. Jugé contre le contrat dans `analyseGroupWithMaster`.
   */
  valueDecisionsPasses?: ValueDecisionsPass[];
}

/**
 * Un appel ANALYZE_DOCUMENT (passe principale, lot de pages ou réparation
 * ciblée) : variables du master, pièces jointes, lecture tolérante, puis
 * réintégration du lot de débordement (lot 34F : aucune borne du contrat
 * n'est une borne du document).
 */
export async function callAnalyzeDocument(p: {
  input: SourceInput;
  groupIndices: number[];
  ctx: AnalysisContext;
  capabilities: AccountCapabilities;
  v2Families: V2AssetFamily[];
  /** Absent : les fichiers du groupe. */
  attachments?: AiAttachment[];
  /** Remplace `SOURCES` (lot de pages, extrait ciblé). */
  sources?: string;
  triggerCode?: string;
  /** Lot 40 — origine des candidats Opération ancrés (défaut : lot de pages si `sources`, sinon passe 1). */
  candidateOrigin?: CandidateOrigin;
}) {
  const promptVariables = buildAnalyzeDocumentVariables({
    input: p.input, groupIndices: p.groupIndices, ctx: p.ctx, v2Families: p.v2Families, capabilities: p.capabilities,
  });
  if (p.sources) promptVariables.SOURCES = p.sources;
  const res = await AiGateway.execute({
    useCaseCode: 'SOURCE_ANALYSIS',
    operationCode: T1_ANALYZE_DOCUMENT_OPERATION,
    task: 'ANALYZE_DOCUMENT',
    masterPromptCode: T1_MASTER_PROMPT_CODE,
    accountId: p.input.accountId,
    userId: p.input.userId,
    sourceIds: p.groupIndices.map((i) => p.input.sourceIds[i]),
    promptVariables,
    attachments: p.attachments ?? buildAttachments(p.input, p.groupIndices),
    // Normalisation tolérante AVANT le contrat strict (`master/tolerant-output`).
    outputSchema: T1AnalyzeDocumentTolerantOutput,
    sourceVersion: p.input.sourceVersion,
    ...(p.triggerCode ? { triggerCode: p.triggerCode } : {}),
  });
  const { output: brut, report } = splitNormalisation(res.data);
  const { output, batches } = applyOverflow(brut, report);
  // Lot 40 : empreinte posée sur chaque fait, preuves des candidats ancrées
  // AVANT tout décalage d'index (lots, faits écartés) — voir operation-candidates.
  const operationCandidates = anchorOperationCandidates(output, p.candidateOrigin ?? (p.sources ? 'CHUNK' : 'PASS_1'));
  // Lot 91D : décisions sur les valeurs ancrées APRÈS les empreintes de faits (mêmes index que les candidats).
  const valueDecisions = anchorValueDecisions(output, p.candidateOrigin === 'CHUNK' || (!p.candidateOrigin && p.sources) ? 'CHUNK' : 'PASS_1',
    report?.invalidValueDecisions ?? []);
  if (report?.droppedCandidates || report?.truncatedCandidates) {
    console.info(`[t1-operation-candidates] fichier(s) ${p.groupIndices.map((i) => p.input.sourceIds[i]).join(',')} : `
      + `${report.droppedCandidates ?? 0} candidat(s) mal formé(s) écarté(s), ${report.truncatedCandidates ?? 0} au-delà de 20.`);
  }
  // Lot 108K (§C) : présent / vide / absent / mal formé / tronqué — jamais confondus.
  const valueDecisionsPass: ValueDecisionsPass = {
    origin: p.candidateOrigin === 'CHUNK' || (!p.candidateOrigin && p.sources) ? 'CHUNK' : 'PASS_1',
    ...valueDecisionsOutputStatus(output, report, res.prunedValues ?? []),
  };
  return { output, report, res, batches, operationCandidates, valueDecisions, valueDecisionsPass };
}

/** Compteurs de plusieurs lectures tolérantes (passe principale et lots de pages). */
function sommeRapports(reports: Array<T1NormalisationReport | null>): T1NormalisationReport | null {
  const l = reports.filter((r): r is T1NormalisationReport => r !== null);
  if (l.length === 0) return null;
  const n = (k: keyof T1NormalisationReport) => l.reduce((s, r) => s + (typeof r[k] === 'number' ? (r[k] as number) : 0), 0);
  return {
    truncatedFacts: n('truncatedFacts'), droppedFacts: n('droppedFacts'), tooLongFacts: n('tooLongFacts'),
    droppedTables: n('droppedTables'), droppedObservations: n('droppedObservations'), truncatedStrings: n('truncatedStrings'),
    overflowTables: n('overflowTables'), overflowObservations: n('overflowObservations'), overflowEntities: n('overflowEntities'),
    transcriptionTailChars: n('transcriptionTailChars'),
  };
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

  // Lot 111M (ticket « budgets IA », P1 T1, CA-10) : une passe 1 qui SATURE
  // avant de rendre une sortie exploitable (sortie tronquée sur toute la
  // chaîne) n'est plus un échec terminal pour un PDF découpable : elle est
  // poursuivie par pages dès la page 1 ; la couverture est vérifiée sur le
  // document original, indépendamment de la validité du JSON. Sinon (format
  // non découpable) : échec explicite, jamais une analyse complète.
  type Passe = Awaited<ReturnType<typeof callAnalyzeDocument>>;
  let saturationInitiale: unknown = null;
  let premiere: Passe | null = null;
  try {
    premiere = await callAnalyzeDocument({ input, groupIndices, ctx, capabilities, v2Families, candidateOrigin: 'PASS_1' });
  } catch (e) {
    if (!isTruncationFailure(e) || !pageContinuable(input, groupIndices)) throw e;
    saturationInitiale = e;
    console.info(`[t1-saturation] fichier(s) ${groupIndices.map((i) => input.sourceIds[i]).join(',')} : sortie tronquée dès la passe 1 — reprise par pages dès la page 1.`);
  }
  let resLot: Passe['res'] | null = null;
  const first: Pick<Passe, 'output' | 'report' | 'batches' | 'operationCandidates' | 'valueDecisions' | 'valueDecisionsPass'> = premiere ?? {
    output: T1AnalyzeDocumentStrict.parse({ task: 'ANALYZE_DOCUMENT', hasExploitableContent: false }), report: null, batches: 0,
    operationCandidates: [], valueDecisions: null,
    valueDecisionsPass: { origin: 'PASS_1', status: 'ABSENT' } as unknown as Passe['valueDecisionsPass'],
  };
  let operationCandidates = first.operationCandidates;
  // Lot 91D : décisions de la passe principale puis des lots de pages (null : aucune sortie ne porte le contrat).
  let valueDecisions: AnchoredValueDecision[] | null = first.valueDecisions;
  const valueDecisionsPasses: ValueDecisionsPass[] = premiere ? [first.valueDecisionsPass] : [];

  // ── Lot 34F : poursuite par lots de pages si la sortie est saturée ──────
  // (document normal : aucun effet, aucun appel). Puis fusion idempotente.
  // Lot 111M : saturation jugée par rapport au plafond TRANSMIS et au motif
  // d'arrêt du fournisseur (`generation`), plus par une constante.
  const suite = await continueByPages({
    input, groupIndices, first: first.output, firstOutputTokens: premiere?.res.outputTokens ?? 0, firstReport: first.report,
    firstGeneration: premiere?.res.generation ?? null, initialSaturation: !premiere,
    call: async (c) => {
      const r = await callAnalyzeDocument({ input, groupIndices, ctx, capabilities, v2Families, ...c, candidateOrigin: 'CHUNK' });
      resLot ??= r.res;
      // Lot 40 : candidats d'un lot de pages fusionnés (dédoublonnés, clés uniques).
      operationCandidates = mergeOperationCandidates(operationCandidates, r.operationCandidates);
      if (r.valueDecisions) valueDecisions = [...(valueDecisions ?? []), ...r.valueDecisions];
      valueDecisionsPasses.push(r.valueDecisionsPass);
      return { output: r.output, report: r.report, batches: r.batches, outputTokens: r.res.outputTokens ?? 0, pruned: r.res.prunedValues ?? [] };
    },
  });
  // Saturation initiale sans aucun lot lu : échec explicite (cause d'origine), jamais une analyse vide « réussie ».
  if (!premiere && !resLot) throw saturationInitiale;
  const res: Passe['res'] = premiere?.res ?? resLot!;
  if (!premiere) {
    warnings.push({
      code: 'PARTIAL_EXTRACTION',
      message: `Sortie tronquée dès la première lecture : document relu par lots de pages (${suite.chunkCount} lot(s)${suite.gaps.length ? `, ${suite.gaps.length} lacune(s)` : ''}) ; couverture vérifiée sur le document original.`,
      target: 't1-master:initial-saturation',
    });
  }
  const report = sommeRapports([first.report, ...suite.reports]);
  // Texte INTÉGRAL lu (passe + lots de pages) : persisté, contrôlé, découpé en unités.
  const brut: T1AnalyzeDocumentOutput = {
    ...suite.output,
    transcription: suite.segments.some((x) => x.text.trim()) ? fullTextOf(suite.segments) : suite.output.transcription,
  };
  // Débordement perdu en route (sortie réparée par la passerelle, lot 33D :
  // les lots de débordement de la 1re lecture n'y survivent pas) — mesuré, signalé.
  const debordementPerdu = Math.max(0, (first.report?.truncatedFacts ?? 0) - (first.report?.overflow?.facts.length ?? 0));

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
  // Lot 33D (§12, §13) : champs invalides retirés par la validation champ par
  // champ — jamais silencieux ; le reste de l'analyse est conservé.
  const retires = (res.outputRepairs ?? []).filter((r) => r.stage === 'field_pruning');
  if (retires.length > 0) {
    warnings.push({
      code: 'PARTIAL_EXTRACTION',
      message: `${retires.length} champ(s) invalide(s) de la sortie retiré(s) (${[...new Set(retires.map((r) => r.path))].slice(0, 5).join(', ')}) ; le reste de l’analyse est conservé.`,
      target: 't1-master:fields-pruned',
    });
  }
  // Lot 34F : au-delà de 300 faits, le surplus est traité en lot suivant —
  // FACTS_TRUNCATED ne signale plus qu'une perte RÉELLE (débordement perdu,
  // saturation sans découpage possible).
  if (debordementPerdu > 0 || suite.truncatedSections > 0) {
    warnings.push({
      code: 'FACTS_TRUNCATED',
      message: debordementPerdu > 0
        ? `${debordementPerdu} fait(s) au-delà de 300 non retrouvé(s) après correction de la sortie ; le texte source reste conservé.`
        : `Sortie saturée, poursuite par pages impossible (${suite.notContinuable ?? 'cause inconnue'}) : la fin du document peut manquer.`,
      target: 't1-master:facts-truncated',
    });
  }
  if (report?.tooLongFacts) {
    warnings.push({
      code: 'FACT_INVALID_DROPPED',
      message: `${report.tooLongFacts} fait(s) à valeur trop longue écarté(s) (jamais tronqués : la valeur serait fausse) — conservé(s) intégralement pour reprise.`,
      target: 't1-master:facts-too-long',
    });
  }
  if (report?.droppedTables) {
    warnings.push({
      code: 'TABLE_STRUCTURE_UNCERTAIN',
      message: `${report.droppedTables} tableau(x) vide(s) ou invalide(s) écarté(s) — conservé(s) tel(s) quel(s) pour reprise.`,
      target: 't1-master:tables-dropped',
    });
  }
  if (report?.droppedObservations) {
    warnings.push({
      code: 'PARTIAL_EXTRACTION',
      message: `${report.droppedObservations} observation(s) visuelle(s) sans description écartée(s) — conservée(s) pour reprise.`,
      target: 't1-master:observations-dropped',
    });
  }
  if (report?.droppedFacts) {
    warnings.push({
      code: 'FACT_INVALID_DROPPED',
      message: `${report.droppedFacts} fait(s) mal formé(s) écarté(s) — conservé(s) pour reprise ; le reste de l’analyse est conservé.`,
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
  const sansPreuve: T1Fact[] = [];
  for (const f of out.facts) {
    const check = checkFactEvidence(f);
    if (!check.ok) {
      // Une valeur vide n'est pas une information : elle n'a pas à voyager.
      // Lot 34F : un fait sans preuve n'est plus perdu — conservé (NO_EVIDENCE).
      if (check.reason !== 'NO_VALUE') { rejected.push(factLabel(f)); sansPreuve.push(f); }
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
      message: `${rejected.length} information(s) écartée(s) faute de preuve adaptée (${rejected.slice(0, 5).join(', ')}) — conservée(s) pour reprise.`,
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

  // ── Identifiants canoniques : correspondance DÉTERMINISTE serveur (lot 31B) ──
  // Adresse, immatriculation, VIN, numéro de série, référence cadastrale des
  // biens du compte (fiche canonique, sensibles compris — jamais transmis au
  // modèle) comparés, après normalisation, à ce que T1 a LU : faits,
  // transcription, texte préextrait, signaux d'entités. Une correspondance
  // exacte et unique prime sur une interprétation du modèle.
  const identification = resolveAssetByIdentifiers(ctx.assetIdentifiers ?? [], {
    facts: facts.map((f) => ({ canonicalKey: f.canonicalKey, value: f.normalizedValue ?? f.rawValue ?? null })),
    texts: [out.transcription, input.extractedContent, ...out.entities.assets.flatMap((a) => a.evidenceSignals)],
  });
  // Lot 113AM (#739) : une correspondance d'ADRESSE ne vaut identité du bien que si son rôle, lu dans
  // les sorties T1 (cible vérifiée du fait, libellé qui la précède), est « lieu du bien objet du
  // document ». L'adresse d'un souscripteur / destinataire / émetteur / de facturation / de livraison,
  // ou sans rôle établi, n'est plus qu'un INDICE (revue du rattachement #711) : ni candidat vérifié,
  // ni bien du document, ni lien. `identification` (complète) reste la source des indices.
  const qualification = admissibleIdentification({
    records: ctx.assetIdentifiers ?? [],
    resolution: identification,
    facts: facts.map((f) => ({
      canonicalKey: f.canonicalKey, value: f.normalizedValue ?? f.rawValue ?? null, label: f.label ?? null, subject: f.subject ?? null,
      rawKey: f.rawKey ?? null, targetType: f.target.type,
      targetEntityId: f.target.entityId !== null && verifiedIds[f.target.type as VerifiableTargetType]?.has(f.target.entityId) ? f.target.entityId : null,
    })),
    texts: [out.transcription, input.extractedContent],
  });
  // Rattachement choisi par l'utilisateur : une correspondance vers un bien que le MODÈLE ne désigne pas
  // n'est qu'un indice concurrent — ni candidat, ni lien (#739, « rattachement utilisateur existant »).
  const admissible = knownAssetId
    ? restrictIdentification(qualification.resolution, new Set([knownAssetId, ...verification.assets.filter((c) => c.verified && c.entityId !== null).map((c) => c.entityId as number)]))
    : qualification.resolution;
  const verifiedFromModel = withLinkProofs(mergeIdentifierCandidates(verification.assets, admissible), verification.assets, admissible, qualification.qualifications);
  for (const id of admissible.assetIds) verifiedIds.ASSET.add(id);

  const known: LinkCandidate[] = knownAssetId
    ? [{
        entityId: knownAssetId, confidence: 'certain', score: 1,
        reason: "bien choisi par l'utilisateur au dépôt du document", excerpt: '', verified: true,
      }]
    : [];
  // N-N (T1-05) : les autres biens vérifiés restent candidats, même quand un
  // bien est connu ; `resolveAssetId` retient toujours le bien connu.
  const others = verifiedFromModel.filter((c) => c.entityId !== knownAssetId);
  const assetCandidates = [...known, ...others];
  const verifiedAssets = verifiedFromModel.filter((c) => c.verified);

  // Ordre de priorité (ticket T1, §8) : bien choisi par l'utilisateur ;
  // identifiant exact et unique ; unique candidat certain du modèle ; sinon
  // aucune cible — T3 DOCUMENT_ASSET reprend immédiatement.
  let documentAssetId: number | null;
  if (knownAssetId) {
    documentAssetId = knownAssetId;
    // Jamais de remplacement silencieux : le rattachement utilisateur reste.
    // Lot 113L (ticket #711) : une correspondance exacte d'identifiant d'un
    // autre bien n'est plus une conclusion (« identifiant exact = conflit ») —
    // c'est un INDICE, calculé ici APRÈS l'appel, puis soumis avec son contexte
    // (unités sources) à la revue IA du rattachement (T3, `attachment-review`),
    // qui décide si un arbitrage est nécessaire. La désignation certaine d'un
    // autre bien par le modèle (base ANALYSIS) est elle aussi transmise comme
    // indice : la carte « À traiter » n'est plus jamais ouverte depuis T1.
    const indices = attachmentIndicesOf({ knownAssetId, identification });
    const conflit = detectAssetContradiction({
      knownAssetId, identification, modelAssets: verification.assets, multiAssetDeclared: out.entities.multiAsset === true,
    });
    if (indices || conflit) {
      warnings.push({
        code: 'ASSET_ATTACHMENT_INDICES',
        message: 'Le document cite des éléments d’un autre bien : indices transmis à la revue du rattachement ; '
          + 'le rattachement choisi est conservé.',
        target: `asset:${indices?.assetIds[0] ?? conflit?.assetId}`,
        attachmentIndices: {
          assetIds: [...new Set([...(indices?.assetIds ?? []), ...(conflit ? [conflit.assetId] : [])])].sort((a, b) => a - b),
          kinds: indices?.kinds ?? [],
          // Candidats du MODÈLE (vérifiés), jamais ceux enrichis par le serveur après l'appel.
          modelCandidates: verification.assets.filter((c) => c.verified && c.entityId !== null).map((c) => ({
            assetId: c.entityId as number, confidence: c.confidence, score: Number.isFinite(c.score) ? c.score : 0,
            reason: (c.reason ?? '').slice(0, 300), signals: (c.excerpt ?? '').slice(0, 1000),
          })),
        },
      });
    }
  } else if (admissible.uniqueAssetId !== null) {
    documentAssetId = admissible.uniqueAssetId;
  } else if (admissible.ambiguous) {
    documentAssetId = null;
  } else {
    documentAssetId = verifiedAssets.length === 1 && verifiedAssets[0].confidence === 'certain' ? verifiedAssets[0].entityId : null;
  }
  if (!knownAssetId && documentAssetId === null && (verifiedAssets.length > 1 || admissible.ambiguous)) {
    warnings.push({
      code: 'AMBIGUOUS_ASSET',
      message: 'Plusieurs biens correspondent. Le rattachement sera arbitré par la réconciliation.',
    });
  }

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
    addressQualifications: qualification.qualifications,
    warnings,
    trace: { ...mergeTrace(emptyTrace(), res, T1_ANALYZE_DOCUMENT_OPERATION), accountCapabilities: capabilityTrace },
    promptVersion: res.promptVersion,
    extraction: {
      segments: input.extractedContent?.trim() && !suite.segments.some((x) => x.text.trim())
        ? [{ text: input.extractedContent, pageOffset: 0, origin: 'PASS_1' }]
        : input.extractedContent?.trim() && input.sourceType === 'web_link'
          // Lien web : le contenu préextrait EST la source (la transcription en est une relecture).
          ? [{ text: input.extractedContent, pageOffset: 0, origin: 'PASS_1' }]
          : suite.segments,
      gaps: suite.gaps,
      dropped: [
        ...(first.report?.dropped ?? []).map((d) => ({ ...d, pass: 'PASS_1' as const })),
        ...suite.dropped,
      ],
      noEvidence: sansPreuve,
      prunedPaths: [...new Set(retires.map((r) => r.path))],
      // Lot 54G (point 3) : champs retirés par la validation AVEC leur valeur originale (passe + lots de pages).
      prunedFields: [
        ...(res.prunedValues ?? []).map((x) => ({ ...x, pass: 'PASS_1' as const, pageOffset: 0 })),
        ...(suite.pruned ?? []),
      ],
      batchedSections: first.batches + suite.batches + suite.chunkCount,
      truncatedSections: suite.truncatedSections + (debordementPerdu > 0 ? 1 : 0),
      chunkCount: suite.chunkCount,
      pageCount: suite.pageCount,
      // Lot 49B (DEV-01, DEV-03) : couverture réelle de la source ; originaux des valeurs réduites ou retirées.
      ...(suite.verification ? { verification: suite.verification } : {}),
      originals: [
        ...(first.report?.originals ?? []).map((o) => ({ ...o, pass: 'PASS_1' as const })),
        ...suite.reports.flatMap((r) => (r.originals ?? []).map((o) => ({ ...o, pass: 'CHUNK' as const }))),
      ],
      truncatedStrings: report?.truncatedStrings ?? 0,
      capabilities,
      v2Families,
    },
    operationCandidates,
    valueDecisions,
    valueDecisionsPasses,
  };
}

/**
 * Lot 111M — le groupe peut-il être relu par pages (un seul fichier PDF
 * accessible par URL, source non préextraite) ? Même règle que
 * `continueByPages`. Pur.
 */
function pageContinuable(input: SourceInput, groupIndices: number[]): boolean {
  if (groupIndices.length !== 1) return false;
  const i = groupIndices[0];
  const url = input.contentUrls?.[i];
  const texte = !!input.extractedContent?.trim() && (input.sourceType === 'web_link' || !input.contentUrls?.length);
  return !!url && /^https?:/i.test(url) && (input.mimeTypes[i] ?? 'application/pdf').includes('pdf') && !texte;
}

/**
 * Bien que le MODÈLE T1 désigne avec certitude À LA PLACE du bien choisi par
 * l'utilisateur (lot 32C, PO 8 / PO 10), sinon null. Pure.
 *
 * Lot 113L (ticket #711) : la branche « identifiant canonique exact et unique
 * d'un autre bien → conflit » (base IDENTIFIER) est SUPPRIMÉE — une
 * correspondance exacte est un indice (`attachmentIndicesOf`), interprété par
 * la revue IA. Reste la désignation du modèle : candidat UNIQUE certain et
 * vérifié, autre que le bien choisi, que le modèle ne cite pas lui-même avec
 * certitude, hors document déclaré multi-biens et hors correspondances
 * d'identifiants (alors soumises comme indices) — elle aussi transmise comme
 * indice, jamais une carte directe.
 */
export function detectAssetContradiction(p: {
  knownAssetId: number;
  identification: Pick<IdentifierResolution, 'uniqueAssetId' | 'assetIds' | 'matches'>;
  modelAssets: readonly LinkCandidate[];
  multiAssetDeclared: boolean;
}): { assetId: number; basis: 'ANALYSIS'; kinds: string[] } | null {
  if (p.identification.assetIds.length > 0 || p.multiAssetDeclared) return null;
  const certains = p.modelAssets.filter((c) => c.verified && c.entityId !== null && c.confidence === 'certain');
  if (certains.some((c) => c.entityId === p.knownAssetId)) return null;
  const autres = [...new Set(certains.map((c) => c.entityId as number))];
  return autres.length === 1 ? { assetId: autres[0], basis: 'ANALYSIS', kinds: [] } : null;
}

/**
 * Indices d'identifiant d'AUTRES biens que le bien choisi (lot 113L) : biens
 * et natures des correspondances exactes, jamais la valeur. Pure. `null` :
 * aucune correspondance hors du bien choisi.
 */
export function attachmentIndicesOf(p: {
  knownAssetId: number; identification: Pick<IdentifierResolution, 'matches'>;
}): { assetIds: number[]; kinds: string[] } | null {
  const autres = p.identification.matches.filter((m) => m.assetId !== p.knownAssetId);
  if (autres.length === 0) return null;
  return {
    assetIds: [...new Set(autres.map((m) => m.assetId))].sort((a, b) => a - b),
    kinds: [...new Set(autres.map((m) => m.kind))].sort(),
  };
}

/** Raison posée par le serveur sur un candidat issu d'une correspondance exacte (jamais une désignation du modèle). */
export const SERVER_IDENTIFIER_REASON = 'identifiant canonique exact (contrôle serveur)';

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

/**
 * Candidats « bien » après correspondance déterministe (lot 31B) : un bien
 * désigné par un identifiant exact devient candidat VÉRIFIÉ (il appartient au
 * compte : la fiche vient de `loadAnalysisContext`), certain s'il est le seul
 * désigné, probable sinon. Les signaux ajoutés ne citent jamais la valeur
 * (une adresse est sensible). Pure.
 */
export function mergeIdentifierCandidates(candidates: LinkCandidate[], identification: IdentifierResolution): LinkCandidate[] {
  const out = candidates.map((c) => ({ ...c }));
  for (const id of identification.assetIds) {
    const unique = identification.uniqueAssetId === id;
    const signals = matchSignals(identification, id).join(' ; ');
    const existant = out.find((c) => c.entityId === id);
    if (existant) {
      existant.verified = true;
      if (unique) { existant.confidence = 'certain'; existant.score = 1; }
      existant.excerpt = [existant.excerpt, signals].filter(Boolean).join(' ; ').slice(0, 1000);
      continue;
    }
    out.push({
      entityId: id, confidence: unique ? 'certain' : 'probable', score: unique ? 1 : 0.7,
      reason: SERVER_IDENTIFIER_REASON, excerpt: signals, verified: true,
    });
  }
  return out;
}

/**
 * Lot 113AM (#739) — preuves INTERNES de chaque candidat « bien » (pure) :
 * désignation par le MODÈLE (candidat vérifié du modèle, jamais un ajout du
 * serveur) et correspondances exactes ADMISSIBLES (nature, rôle qualifié
 * d'une adresse). Lues par la garde d'admission des liens T1.
 */
export function withLinkProofs(
  candidates: LinkCandidate[],
  modelCandidates: readonly LinkCandidate[],
  admissible: IdentifierResolution,
  qualifications: readonly AddressQualification[],
): LinkCandidate[] {
  return candidates.map((c) => {
    if (c.entityId === null) return c;
    const designe = modelCandidates.some((m) => m.entityId === c.entityId && m.verified);
    const identifiers = admissible.matches.filter((m) => m.assetId === c.entityId).map((m) => ({
      kind: m.kind, via: m.via, ...(m.kind === 'ADDRESS' ? { addressRole: addressRoleOf(qualifications, m.assetId) } : {}),
    }));
    return { ...c, modelDesignated: designe, ...(identifiers.length ? { identifiers } : {}) };
  });
}

type RawCandidate = T1AnalyzeDocumentOutput['entities']['assets'][number];

/** Candidat du master → `LinkCandidate` (contrat historique). */
function toLinkCandidate(c: RawCandidate): LinkCandidate {
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
export async function verifyAll(out: T1AnalyzeDocumentOutput, facts: T1Fact[], accountId: number) {
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
