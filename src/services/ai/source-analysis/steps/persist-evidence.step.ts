/**
 * Étape 9 — production des preuves par champ (CDC §4.1.7, §5.4 ; CDC 15
 * T1-01, T1-04, T1-05, §14.4).
 *
 * « Chaque valeur extraite doit comporter une preuve exploitable. »
 *
 * Les preuves sont écrites AVANT toute décision de réconciliation : elles
 * constituent le matériau du moteur de l'usage 2, qui ne relit jamais le
 * document lui-même (§5.6 : « Ne pas réenvoyer un document au modèle lorsque
 * son analyse structurée et ses preuves suffisent »).
 *
 * Deux chemins :
 *
 *  · `persistEvidence` (mode « étapes » historique) : tous les champs sur le
 *    bien déterminé par le pipeline — comportement inchangé pour un champ
 *    SANS cible. Un champ portant une cible VÉRIFIÉE (contrat enrichi) est
 *    écrit sur SA cible. Pas de supersede ici : ce chemin est appelé à
 *    l'analyse ET au rattachement tardif (`projectDocumentKnowledgeToAsset`),
 *    et le remplacement « déplacement A → B » relève du cycle de vie
 *    documentaire du lot 13 (T3-03) ; l'activer ici changerait le
 *    comportement historique sans commutateur.
 *
 *  · `persistProjectedFacts` (branche maître T1, après projection
 *    déterministe) : chaque fait sur SA cible, jamais sur un bien unique ;
 *    seuls les faits de clé canonique entrent dans `field_evidence` (T1-01 :
 *    « aucun alias libre n'entre dans field_evidence ») ; un fait sans cible
 *    vérifiée n'est rattaché à rien (U8) — il reste dans `document_facts` et
 *    est RENDU à l'appelant (DOD-01 : zéro perte silencieuse). Puis les
 *    preuves antérieures de la même source passent SUPERSEDED (§14.4).
 */
import {
  recordEvidence, supersedePriorSourceEvidence, previewPriorSourceEvidence, EvidenceSchemaNotReadyError,
  type SupersedeBySourceResult,
} from '../../evidence/field-evidence.service';
import { fieldEvidenceCanonicalReady } from '../../evidence/canonical-columns';
import { resolveFactTargets, isEvidenceTargetType, targetKey } from '../../evidence/fact-targets';
import { computeAuthorityScore } from '../../evidence/authority-score';
import type { FieldEvidenceInput, EvidenceLocation } from '../../evidence/evidence.types';
import type { ExtractedField, SourceInput, AiOperationTrace, PersistedFactTarget } from '../types';
import type { ProjectedFact } from '../master/t1-contract';
import { T1_MASTER_PROMPT_CODE } from '../master/t1-contract';
import { EXTRACT_SOURCE_PROMPT_VERSION } from '../prompt-version';
import { getField, isContextualAlias, isInputOnlyKey, resolveAlias } from '@/services/canonical/registry';

export interface PersistEvidenceInput {
  input: SourceInput;
  leadSourceId: number;
  assetId: number;
  fields: ExtractedField[];
  documentType?: string;
  documentDate?: string;
  trace: AiOperationTrace;
  /**
   * CDC 15 T3-03 (lot 13) — réanalyse en mode « étapes » : les preuves
   * ACTIVE antérieures de la même source (sans analyse datée, hors preuves
   * écrites maintenant) passent SUPERSEDED, sous verrou consultatif, avec
   * les règles de `persistProjectedFacts` (remplacement partiel si une
   * écriture échoue, lien vers la remplaçante de même clé/cible). Absent :
   * aucun remplacement (rattachement tardif, comportement historique).
   * `shadow` : ce qui serait remplacé est seulement journalisé.
   */
  supersede?: {
    mode: 'shadow' | 'enabled';
    onResult?: (r: SupersedeBySourceResult) => void;
  };
}

const evidenceSourceType = (input: SourceInput): FieldEvidenceInput['sourceType'] =>
  (input.sourceType === 'web_link' ? 'web_link' : 'document');

/** Cible vérifiable d'un champ enrichi (type bien/équipement/pièce, identifiant non nul). */
function verifiableTarget(t: PersistedFactTarget | undefined): { type: 'ASSET' | 'EQUIPMENT' | 'ROOM'; entityId: number } | null {
  if (!t || t.targetEntityId == null || !isEvidenceTargetType(t.targetType)) return null;
  return { type: t.targetType, entityId: t.targetEntityId };
}

/** Données du contrat enrichi d'un champ → colonnes 0219 (vides pour un champ historique). */
function canonicalExtension(field: ExtractedField): Partial<FieldEvidenceInput> {
  return {
    ...(field.canonicalKey !== undefined ? { canonicalKey: field.canonicalKey } : {}),
    ...(field.canonicalUnit !== undefined ? { canonicalUnit: field.canonicalUnit } : {}),
    ...(field.rawValue !== undefined && field.rawValue !== null ? { rawValue: String(field.rawValue) } : {}),
    ...(field.semanticEvent ? { semanticEvent: field.semanticEvent } : {}),
    ...(field.recurrence ? { recurrence: field.recurrence as unknown as Record<string, unknown> } : {}),
    ...(field.origin ? { projectionOrigin: field.origin } : {}),
    ...(field.ruleCode ? { projectionRule: field.ruleCode } : {}),
  };
}

/** Renvoie les identifiants de preuve créés, indexés par champ. */
export async function persistEvidence(p: PersistEvidenceInput): Promise<Map<string, number>> {
  const byField = new Map<string, number>();
  if (!p.assetId) return byField;

  const authorityScore = computeAuthorityScore({
    documentType: p.documentType,
    documentDate: p.documentDate ? new Date(p.documentDate) : null,
  });

  // T1-04 : un champ dont la cible est vérifiable est écrit sur SA cible, pas
  // sur le bien du pipeline. Résolution groupée (une requête par type).
  const written: number[] = [];
  let failures = 0;
  const targeted = p.fields.map((f) => verifiableTarget(f.target)).filter((t): t is NonNullable<typeof t> => !!t);
  const resolved = targeted.length ? await resolveFactTargets(p.input.accountId, targeted) : new Map<string, { assetId: number }>();

  for (const field0 of p.fields) {
    // D-D (lot 20) : champ de saisie seule (prix, surface d'annonce) — jamais
    // une preuve, quel que soit le document.
    if (isInputOnlyKey(field0.canonicalKey ?? field0.fieldKey)) {
      console.info(`[persist-evidence] champ ${field0.fieldKey} : saisie seule, preuve non écrite.`);
      continue;
    }
    // D-C (lot 20) : alias dont la clé dépend du document (`dateFinContrat`
    // d'un bail → leaseEndDate) résolu ICI, avec le type documentaire : la
    // preuve porte la clé canonique retenue, plus l'alias ambigu.
    const contextuelle = contextualFieldKey(field0, p.documentType);
    const field = contextuelle ? { ...field0, fieldKey: contextuelle } : field0;
    const vt = verifiableTarget(field.target);
    let assetId = p.assetId;
    let target: FieldEvidenceInput['target'] = null;
    if (vt) {
      const r = resolved.get(targetKey(vt.type, vt.entityId));
      if (!r) {
        // Cible annoncée introuvable dans le compte : rien n'est rattaché
        // arbitrairement ; le fait reste dans la connaissance documentaire.
        console.warn(`[persist-evidence] champ ${field.fieldKey} : cible ${vt.type}#${vt.entityId} introuvable, preuve non écrite.`);
        continue;
      }
      assetId = r.assetId;
      target = {
        type: vt.type, entityId: vt.entityId,
        label: field.target!.targetEntityLabel, confidence: field.target!.targetConfidence,
      };
    }
    try {
      const evidenceId = await recordEvidence({
        accountId: p.input.accountId,
        assetId,
        fieldKey: field.fieldKey,
        value: field.value,
        normalizedValue: field.normalizedValue ?? String(field.value),
        sourceType: evidenceSourceType(p.input),
        sourceId: p.leadSourceId,
        sourceVersion: p.input.sourceVersion,
        location: { page: field.page, selector: field.selector },
        // Observation visuelle : aucune citation, une preuve visuelle à la place.
        excerpt: field.provenance === 'VISUAL_ANALYSIS' ? null : (field.excerpt ?? null),
        evidenceOrigin: field.provenance ?? 'TEXT_EXTRACTION',
        visualEvidence: field.provenance === 'VISUAL_ANALYSIS' && field.visualEvidence
          ? { ...field.visualEvidence, fileId: p.leadSourceId }
          : null,
        documentType: p.documentType,
        documentDate: p.documentDate ? new Date(p.documentDate) : null,
        provider: 'gemini',
        model: p.trace.models[0],
        promptVersion: EXTRACT_SOURCE_PROMPT_VERSION,
        confidence: field.confidence,
        authorityScore,
        operationTraceId: p.trace.traceIds[0],
        ...canonicalExtension(field),
        ...(target ? { target } : {}),
      });
      byField.set(field0.fieldKey, evidenceId);
      if (contextuelle) byField.set(contextuelle, evidenceId);
      written.push(evidenceId);
    } catch (e) {
      failures += 1;
      // Une preuve manquante dégrade la réconciliation mais ne doit pas faire
      // échouer l'analyse du document (§11.4).
      console.error(`[persist-evidence] champ ${field.fieldKey} :`, (e as Error).message);
    }
  }

  if (p.supersede) {
    try {
      const base = { accountId: p.input.accountId, sourceType: evidenceSourceType(p.input), sourceId: p.leadSourceId, keepIds: written };
      const r = p.supersede.mode === 'enabled'
        ? await supersedePriorSourceEvidence({ ...base, analysisRunId: null, complete: failures === 0 })
        : await previewPriorSourceEvidence(base);
      p.supersede.onResult?.(r);
    } catch (e) {
      console.error(`[persist-evidence] remplacement des preuves de la source ${p.leadSourceId} :`, (e as Error).message);
    }
  }

  return byField;
}

// ══════════════════════════════════════════════════════════════════════════
// Branche maître T1 — faits projetés (CDC 15 T1-04, T1-05, §14.4, PM-T1-PRE)
// ══════════════════════════════════════════════════════════════════════════

export interface PersistProjectedFactsInput {
  input: SourceInput;
  leadSourceId: number;
  facts: ProjectedFact[];
  documentType?: string;
  documentDate?: string;
  trace: AiOperationTrace;
  /** `document_analysis_runs.id` : distingue les preuves de deux analyses (cycle de vie). */
  analysisRunId?: number | null;
  /** Version du prompt tracée sur la preuve (défaut : code du master T1). */
  promptVersion?: string;
}

/** Motif pour lequel un fait n'a pas produit de preuve de champ. */
export type ProjectedFactSkipReason =
  /** Connaissance générique (canonicalKey null) : document_facts seulement (T1-01). */
  | 'GENERIC_KNOWLEDGE'
  /** Clé annoncée canonique mais absente du registre : jamais écrite telle quelle. */
  | 'UNKNOWN_CANONICAL_KEY'
  /** Champ de saisie seule (`inputOnly`, décision PO D-D, lot 20) : jamais une preuve. */
  | 'INPUT_ONLY_FIELD'
  /** Cible DOCUMENT / SUPPLIER / GENERIC : pas un champ de bien. */
  | 'NON_ENTITY_TARGET'
  /** Aucune cible vérifiée (identifiant null) : non rattaché (U8). */
  | 'UNATTACHED'
  /** Identifiant annoncé introuvable dans le compte (revérification en base). */
  | 'TARGET_NOT_FOUND'
  /** Ni extrait littéral ni preuve visuelle. */
  | 'NO_EVIDENCE'
  /** Cible équipement/pièce alors que la migration 0219 manque. */
  | 'SCHEMA_NOT_READY'
  /** Écriture en échec (journalisée). */
  | 'WRITE_FAILED';

export interface PersistProjectedFactsResult {
  /** Preuves écrites, indexées par `canonicalKey@TYPE:entityId`. */
  evidenceIds: Map<string, number>;
  /** Faits sans preuve de champ, avec le motif — rien n'est perdu en silence. */
  skipped: Array<{ fact: ProjectedFact; reason: ProjectedFactSkipReason }>;
  /** Biens porteurs touchés (nouvelles preuves ET preuves remplacées) — à réconcilier (T3). */
  affectedAssetIds: number[];
  /**
   * Équipements et pièces touchés (nouvelles preuves ciblées ET preuves
   * ciblées remplacées) — réconciliation ciblée de leur fiche (lot 18, R3).
   * Les preuves remplacées ne sont lues que si CANONICAL_WRITE_MODE ou
   * T3_NEGATIVE_RECONCILIATION n'est pas `legacy` (sinon aucune requête).
   */
  affectedTargets: Array<{ type: 'EQUIPMENT' | 'ROOM'; id: number; assetId: number }>;
  /** Preuves antérieures de la source passées SUPERSEDED, dont reliées à une remplaçante. */
  superseded: { count: number; linked: number };
}

/** Clé d'indexation d'une preuve ciblée. */
export const projectedEvidenceKey = (canonicalKey: string, type: string, entityId: number) =>
  `${canonicalKey}@${targetKey(type, entityId)}`;

const scalarToString = (v: string | number | boolean | null): string | null =>
  (v === null || v === undefined ? null : String(v));

/**
 * Écrit les preuves des faits projetés, chacune sur sa cible, puis remplace
 * (SUPERSEDED) les preuves ACTIVE antérieures de la même source.
 *
 * Ne lève pas pour un fait isolé (journalisé, rendu dans `skipped`). Le
 * supersede n'est complet que si toutes les écritures ont réussi ; sinon,
 * seules les anciennes preuves AYANT une remplaçante sont remplacées.
 */
export async function persistProjectedFacts(p: PersistProjectedFactsInput): Promise<PersistProjectedFactsResult> {
  const result: PersistProjectedFactsResult = {
    evidenceIds: new Map(), skipped: [], affectedAssetIds: [], affectedTargets: [], superseded: { count: 0, linked: 0 },
  };
  const skip = (fact: ProjectedFact, reason: ProjectedFactSkipReason) => result.skipped.push({ fact, reason });

  // 1. Tri : seuls les faits canoniques, ciblés sur une entité, avec preuve.
  const eligible: Array<{ fact: ProjectedFact; type: 'ASSET' | 'EQUIPMENT' | 'ROOM'; entityId: number }> = [];
  for (const fact of p.facts) {
    if (fact.canonicalKey === null) { skip(fact, 'GENERIC_KNOWLEDGE'); continue; }
    if (!getField(fact.canonicalKey)) { skip(fact, 'UNKNOWN_CANONICAL_KEY'); continue; }
    if (getField(fact.canonicalKey)!.inputOnly) { skip(fact, 'INPUT_ONLY_FIELD'); continue; }
    if (!isEvidenceTargetType(fact.target.targetType)) { skip(fact, 'NON_ENTITY_TARGET'); continue; }
    if (fact.target.targetEntityId == null) { skip(fact, 'UNATTACHED'); continue; }
    const visual = fact.provenance === 'VISUAL_ANALYSIS';
    const hasProof = visual ? !!fact.visualEvidence?.description?.trim() : !!fact.evidence.excerpt?.trim();
    if (!hasProof && fact.origin !== 'DETERMINISTIC_RULE') { skip(fact, 'NO_EVIDENCE'); continue; }
    eligible.push({ fact, type: fact.target.targetType, entityId: fact.target.targetEntityId });
  }

  // 2. Revérification en base (compte) et bien porteur.
  const resolved = eligible.length
    ? await resolveFactTargets(p.input.accountId, eligible.map(({ type, entityId }) => ({ type, entityId })))
    : new Map<string, { assetId: number }>();
  const schemaReady = await fieldEvidenceCanonicalReady();

  const authorityScore = computeAuthorityScore({
    documentType: p.documentType,
    documentDate: p.documentDate ? new Date(p.documentDate) : null,
    isWebLink: p.input.sourceType === 'web_link',
  });
  const touched = new Set<number>();
  const cibles = new Map<string, { type: 'EQUIPMENT' | 'ROOM'; id: number; assetId: number }>();
  const written: number[] = [];
  let failures = 0;

  // 3. Écriture, fait par fait, sur SA cible.
  for (const { fact, type, entityId } of eligible) {
    const r = resolved.get(targetKey(type, entityId));
    if (!r) { skip(fact, 'TARGET_NOT_FOUND'); continue; }
    if (type !== 'ASSET' && !schemaReady) { skip(fact, 'SCHEMA_NOT_READY'); continue; }
    const key = fact.canonicalKey!;
    const visual = fact.provenance === 'VISUAL_ANALYSIS';
    const location: EvidenceLocation = {
      ...(fact.evidence.page ? { page: fact.evidence.page } : {}),
      ...(fact.evidence.section ? { section: fact.evidence.section } : {}),
      ...(fact.evidence.table ? { table: fact.evidence.table } : {}),
    };
    try {
      const id = await recordEvidence({
        accountId: p.input.accountId,
        assetId: r.assetId,
        fieldKey: key,
        value: fact.value,
        normalizedValue: scalarToString(fact.value) ?? undefined,
        sourceType: evidenceSourceType(p.input),
        sourceId: p.leadSourceId,
        sourceVersion: p.input.sourceVersion,
        location,
        // U10 / T1-08 : jamais de citation fabriquée pour une observation visuelle.
        excerpt: visual ? null : (fact.evidence.excerpt ?? null),
        evidenceOrigin: fact.provenance,
        visualEvidence: visual && fact.visualEvidence ? { ...fact.visualEvidence, fileId: p.leadSourceId } : null,
        documentType: p.documentType,
        documentDate: p.documentDate ? new Date(p.documentDate) : null,
        provider: p.trace.usedFallback ? 'fallback' : 'gemini',
        model: p.trace.models[0],
        promptVersion: p.promptVersion ?? T1_MASTER_PROMPT_CODE,
        confidence: fact.confidence,
        authorityScore,
        operationTraceId: p.trace.traceIds[0],
        canonicalKey: key,
        canonicalUnit: fact.canonicalUnit,
        rawValue: scalarToString(fact.rawValue),
        target: { type, entityId, label: fact.target.targetEntityLabel, confidence: fact.target.targetConfidence },
        semanticEvent: fact.semanticEvent,
        recurrence: fact.recurrence as unknown as Record<string, unknown> | null,
        projectionOrigin: fact.origin,
        projectionRule: fact.ruleCode,
        analysisRunId: p.analysisRunId ?? null,
      });
      written.push(id);
      touched.add(r.assetId);
      if (type !== 'ASSET') cibles.set(`${type}:${entityId}`, { type, id: entityId, assetId: r.assetId });
      result.evidenceIds.set(projectedEvidenceKey(key, type, entityId), id);
    } catch (e) {
      failures += 1;
      skip(fact, e instanceof EvidenceSchemaNotReadyError ? 'SCHEMA_NOT_READY' : 'WRITE_FAILED');
      console.error(`[persist-evidence] fait ${key} (${type}#${entityId}) :`, (e as Error).message);
    }
  }

  // 4. Cycle de vie (§14.4) : les preuves antérieures de la source sont
  //    remplacées, jamais supprimées. Un échec ici n'annule pas les
  //    nouvelles preuves (elles restent ACTIVE) ; il est journalisé.
  // Cibles des preuves sur le point d'être remplacées (lot 18) : lues seulement
  // si l'application aux entités est active (aucune requête en legacy).
  try {
    const { canonicalWriteMode, t3NegativeMode } = await import('@/services/canonical/rollout');
    if (canonicalWriteMode() !== 'legacy' || t3NegativeMode() !== 'legacy') {
      const { listSourceEntityTargets } = await import('../../evidence/entity-evidence');
      for (const c of await listSourceEntityTargets(p.input.accountId, evidenceSourceType(p.input), p.leadSourceId)) {
        cibles.set(`${c.type}:${c.id}`, c);
      }
    }
  } catch (e) {
    console.error(`[persist-evidence] cibles remplacées de la source ${p.leadSourceId} :`, (e as Error).message);
  }

  try {
    const s = await supersedePriorSourceEvidence({
      accountId: p.input.accountId,
      sourceType: evidenceSourceType(p.input),
      sourceId: p.leadSourceId,
      analysisRunId: p.analysisRunId ?? null,
      keepIds: written,
      complete: failures === 0,
    });
    result.superseded = { count: s.superseded, linked: s.linked };
    for (const a of s.assetIds) touched.add(a);
  } catch (e) {
    console.error(`[persist-evidence] supersede de la source ${p.leadSourceId} :`, (e as Error).message);
  }

  if (result.skipped.some((s) => s.reason === 'UNATTACHED' || s.reason === 'TARGET_NOT_FOUND')) {
    console.warn(
      `[persist-evidence] source ${p.leadSourceId} : ${result.skipped.filter((s) => s.reason === 'UNATTACHED' || s.reason === 'TARGET_NOT_FOUND').length} `
      + 'fait(s) canonique(s) sans cible vérifiée — conservés dans document_facts, non rattachés (CDC 15 U8).',
    );
  }

  result.affectedAssetIds = [...touched];
  result.affectedTargets = [...cibles.values()];
  return result;
}

/**
 * Fait projeté → champ extrait (contrat historique enrichi). Sert la
 * connaissance documentaire (`buildKnowledgeFromSourceAnalysis`) et tout
 * consommateur du `SourceAnalysisResult`.
 */
export function projectedFactToExtractedField(f: ProjectedFact): ExtractedField {
  const visual = f.provenance === 'VISUAL_ANALYSIS';
  return {
    // Clé canonique, sinon clé brute, sinon « sujet.attribut » (générique).
    fieldKey: f.canonicalKey ?? (f.rawKey || [f.subject, f.attribute].filter(Boolean).join('.') || 'fait'),
    value: f.value,
    ...(f.value !== null ? { normalizedValue: String(f.value) } : {}),
    confidence: f.confidence,
    ...(visual ? {} : f.evidence.excerpt ? { excerpt: f.evidence.excerpt } : {}),
    provenance: f.provenance,
    ...(visual && f.visualEvidence ? { visualEvidence: f.visualEvidence } : {}),
    ...(f.evidence.table ? { table: f.evidence.table } : {}),
    ...(f.evidence.page ? { page: f.evidence.page } : {}),
    ...(f.evidence.section ? { section: f.evidence.section } : {}),
    ...(f.subject ? { subject: f.subject } : {}),
    ...(f.attribute ? { attribute: f.attribute } : {}),
    ...(f.label ? { label: f.label } : {}),
    ...(f.canonicalUnit ? { unit: f.canonicalUnit } : {}),
    ...(f.periodStart ? { periodStart: f.periodStart } : {}),
    ...(f.periodEnd ? { periodEnd: f.periodEnd } : {}),
    ...(f.recurrence ? { recurrence: f.recurrence } : {}),
    canonicalKey: f.canonicalKey,
    rawKey: f.rawKey,
    rawValue: f.rawValue,
    valueType: f.valueType,
    canonicalUnit: f.canonicalUnit,
    target: f.target,
    semanticEvent: f.semanticEvent,
    origin: f.origin,
    ruleCode: f.ruleCode,
  };
}

// ── Alias contextuels (décision PO D-C, lot 20) ─────────────────────────────

/**
 * Clé canonique d'un champ historique dont la clé est un ALIAS CONTEXTUEL
 * (`dateFinContrat`, `numeroContrat`, `dateEtablissement`), pour ce type
 * documentaire ; `null` pour tout autre champ (inchangé), pour un champ du
 * contrat enrichi (sa `canonicalKey` fait foi), quand l'alias ne se résout
 * pas (`dateEtablissement` d'une facture : date du document) et quand le
 * document ne change rien à la résolution historique (`dateFinContrat` d'une
 * facture reste tel quel : même empreinte de preuve qu'avant). Pure.
 */
export function contextualFieldKey(
  field: Pick<ExtractedField, 'fieldKey' | 'canonicalKey'>, documentType: string | null | undefined,
): string | null {
  if (field.canonicalKey != null || !isContextualAlias(field.fieldKey)) return null;
  const avecContexte = resolveAlias(field.fieldKey, undefined, { documentType: documentType ?? null });
  if (!avecContexte || avecContexte === resolveAlias(field.fieldKey)) return null;
  return avecContexte;
}
