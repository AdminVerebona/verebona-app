/**
 * Contrats de sortie versionnés et adaptateurs de compatibilité — lot 33D
 * (ticket « diagnostic » §5 ; ticket « réussite malgré les désalignements »
 * §14 à §18).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE EXÉCUTION SE RELIE À QUATRE ÉLÉMENTS
 *
 *   code déployé · prompt (version) · configuration · SCHÉMA DE SORTIE
 *
 * Le quatrième manquait : chaque contrat porte ici un libellé versionné
 * (`t1_analyze_document@v3`) et une empreinte (SHA-256 du schéma JSON
 * dérivé du schéma Zod) — une modification du schéma sans changement de
 * version se voit dans l'empreinte.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ADAPTATEURS EXPLICITES, VERSIONNÉS, TESTÉS
 *
 * Une sortie produite dans un format ANTÉRIEUR du contrat (prompt d'une
 * ancienne version, texte BO divergent du dépôt) est migrée par un
 * adaptateur nommé `tN_vX_to_vY`, appliqué AVANT la normalisation générique
 * et consigné dans le rapport. Pas de règle implicite cachée dans un parser.
 *
 *   T1AnalyzeDocumentOutput
 *     v1 — format de l'ancien moteur (`extract_source_v5`, lots ≤ 11) :
 *          métadonnées à la racine, `excerpt` à plat, `fields[]`
 *          (`fieldKey`, `value`, `unit`, `excerpt`, `page`…) ;
 *     v2 — prompt maître lot 12 (`document`, `facts[]` ciblés, `evidence`) ;
 *     v3 — lot 33 : identique à v2 pour le modèle ; `entityId` absent = null,
 *          `reason` nul accepté (une v2 est toujours une v3 valide) ;
 *     v4 — lot 40 : `businessOperationCandidates[]` (CDC Opérations V1 C3.1).
 *          Une v3 est toujours une v4 valide (tableau absent = aucun
 *          candidat, sans adaptation ni marque « réparée »).
 *     v5 — lot 53D (retours PO D2, D9, Q16) : `financialHints[].amountEurMinor`
 *          facultatif, rôle `LOAN_PRINCIPAL`, portée `FEE`, devise « XXX ».
 *          Une v4 est toujours une v5 valide (aucun adaptateur).
 *     v6 — lot 91D : `valueDecisions[]` facultatif (décisions de T1 sur les
 *          valeurs significatives, contrat `t1-value-decisions-v1`). Une v5
 *          est toujours une v6 valide (tableau absent = contrat non porté).
 *   adaptateurs : t1_v1_to_v2 ; v2 → v3 : aucun ; v4 → v5 : aucun ; t1_v3_to_v4 pour les
 *   seules formes ANTÉRIEURES du bloc candidat (texte BO divergent qui
 *   suivrait le CDC §7.1 / B3 : `businessOperationCandidate` unique,
 *   `operationCandidates[]` au vocabulaire B3).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'crypto';
import { z, type ZodType } from 'zod';
import type { OutputRepairStep, OutputSchemaRef } from '../diagnostics/taxonomy';
import { splitPipe } from './field-validation';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

interface CompatAdapter {
  id: string;
  from: number;
  to: number;
  description: string;
  /** La sortie est-elle dans le format `from` ? */
  detect(value: unknown): boolean;
  apply(value: Obj): Obj;
}

interface OutputContract {
  /** Nom du schéma au référentiel (`outputSchema` de l'opération). */
  name: string;
  /** Libellé de l'opération principale (`t1_analyze_document`). */
  label: string;
  version: number;
  adapters: readonly CompatAdapter[];
}

// ── T1 v1 → v2 ──────────────────────────────────────────────────────────────

function evidenceOf(o: Obj): Obj {
  const e: Obj = isObj(o.evidence) ? { ...o.evidence } : {};
  if (e.excerpt === undefined && typeof o.excerpt === 'string') e.excerpt = o.excerpt;
  if (e.page === undefined && typeof o.page === 'number') e.page = o.page;
  if (e.section === undefined && typeof o.section === 'string') e.section = o.section;
  if (e.table === undefined && isObj(o.table)) e.table = o.table;
  return e;
}

function metaOf(o: unknown): Obj | undefined {
  if (!isObj(o)) return undefined;
  return { value: o.value, confidence: o.confidence, evidence: evidenceOf(o) };
}

/** Champ de l'ancien moteur → fait ciblé du master. */
function factOf(f: Obj): Obj {
  const key = typeof f.fieldKey === 'string' ? f.fieldKey : typeof f.key === 'string' ? f.key : null;
  // Clé « chemin » (`vehicule.clio.kilometrage`) : jamais une clé canonique.
  const canonique = key && /^[A-Za-z][A-Za-z0-9]*$/.test(key) ? key : null;
  const subject = typeof f.subject === 'string' && f.subject.trim() ? f.subject : null;
  return {
    canonicalKey: canonique,
    rawKey: key,
    label: f.label ?? null,
    subject,
    attribute: f.attribute ?? null,
    ...(f.rawValue !== undefined ? { rawValue: f.rawValue } : {}),
    normalizedValue: f.normalizedValue ?? f.value ?? null,
    ...(f.valueType !== undefined ? { valueType: f.valueType } : {}),
    canonicalUnit: f.canonicalUnit ?? f.unit ?? null,
    // L'ancien format ne ciblait pas : un champ sans sujet visait le bien du
    // document (la projection ne le rattache que s'il est le SEUL bien) ; un
    // champ porté par un sujet reste une connaissance générique (U7, U8).
    target: isObj(f.target) ? f.target : {
      type: subject ? 'GENERIC' : 'ASSET', entityId: null, rawLabel: subject,
      confidence: f.confidence ?? 'probable', evidenceSignals: [],
    },
    provenance: f.provenance ?? 'TEXT_EXTRACTION',
    confidence: f.confidence,
    evidence: evidenceOf(f),
    ...(f.visualEvidence !== undefined ? { visualEvidence: f.visualEvidence } : {}),
    ...(f.semanticEvent !== undefined ? { semanticEvent: f.semanticEvent } : {}),
    ...(f.recurrence !== undefined ? { recurrence: f.recurrence } : {}),
  };
}

export const T1_V1_TO_V2: CompatAdapter = {
  id: 't1_v1_to_v2',
  from: 1,
  to: 2,
  description: 'Format de l’ancien moteur (extract_source_v5 : métadonnées à la racine, fields[]) → prompt maître (document, facts[] ciblés).',
  detect: (v) => isObj(v) && !isObj(v.document)
    && (Array.isArray(v.fields) || isObj(v.title) || isObj(v.documentDate) || isObj(v.amountCents) || isObj(v.supplier)),
  apply: (v) => {
    const document: Obj = {};
    for (const k of ['title', 'description', 'documentDate', 'amountCents'] as const) {
      const m = metaOf(v[k]);
      if (m) document[k] = m;
    }
    if (isObj(v.supplier)) {
      const s = v.supplier;
      document.supplier = { name: s.name, siret: s.siret ?? null, confidence: s.confidence, evidence: evidenceOf(s) };
    }
    if (isObj(v.classification)) document.classification = v.classification;
    const facts = [
      ...(Array.isArray(v.facts) ? v.facts : []),
      ...(Array.isArray(v.fields) ? v.fields.filter(isObj).map(factOf) : []),
    ];
    const out: Obj = {
      task: v.task ?? 'ANALYZE_DOCUMENT',
      document,
      facts,
    };
    for (const k of ['entities', 'transcription', 'visual', 'tables', 'hasExploitableContent'] as const) {
      if (v[k] !== undefined) out[k] = v[k];
    }
    return out;
  },
};

// ── T1 v3 → v4 : formes antérieures du bloc candidat ────────────────────────

const CERTAINTY_B3: Readonly<Record<string, { established: boolean; confidence: string }>> = {
  SUFFICIENT: { established: true, confidence: 'certain' },
  AMBIGUOUS: { established: true, confidence: 'probable' },
  INSUFFICIENT: { established: false, confidence: 'probable' },
};

/** Index de faits d'une liste de preuves (nombres, ou objets `{ factIndex }`). */
function factIndexesOf(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((x) => (typeof x === 'number' ? [x]
    : isObj(x) && typeof x.factIndex === 'number' ? [x.factIndex] : []));
}

/** Candidat au vocabulaire du CDC §7.1 (`businessOperationCandidate`) ou B3 (`operationCandidates`) → C3.1. */
function candidateOf(c: Obj, i: number): Obj {
  const b3 = typeof c.certainty === 'string' ? CERTAINTY_B3[c.certainty.toUpperCase()] : undefined;
  const conf = typeof c.confidence === 'string' && c.confidence.toLowerCase() === 'uncertain' ? 'probable' : c.confidence;
  const t = isObj(c.temporalHints) ? c.temporalHints : {};
  return {
    candidateKey: c.candidateKey ?? c.candidate_key ?? `op${i + 1}`,
    established: c.established ?? c.exists ?? b3?.established ?? false,
    confidence: conf ?? b3?.confidence ?? 'probable',
    typeHint: c.typeHint ?? c.proposed_type ?? null,
    statusHint: c.statusHint ?? c.status_hint ?? null,
    summary: c.summary ?? c.technical_label ?? '',
    sourceRoleHint: c.sourceRoleHint ?? c.source_role ?? null,
    ...(c.provider !== undefined ? { provider: c.provider } : {}),
    targetHints: Array.isArray(c.targetHints) ? c.targetHints : Array.isArray(c.target_candidates) ? c.target_candidates : [],
    businessReferences: Array.isArray(c.businessReferences) ? c.businessReferences
      : typeof c.external_reference === 'string' ? [{ kind: 'OTHER', value: c.external_reference }] : [],
    temporalHints: {
      ...t,
      ...(c.planned_date ? { plannedDate: c.planned_date } : {}),
      ...(c.start_date ? { startDate: c.start_date } : {}),
      ...(c.realized_date ? { realizedDate: c.realized_date } : {}),
      ...(c.end_date ? { endDate: c.end_date } : {}),
    },
    financialHints: Array.isArray(c.financialHints) ? c.financialHints : [],
    evidenceFactIndexes: Array.isArray(c.evidenceFactIndexes) ? c.evidenceFactIndexes : factIndexesOf(c.evidence ?? c.evidence_refs),
    ...(c.exclusionReason ?? c.exclusion_reason ? { exclusionReason: c.exclusionReason ?? c.exclusion_reason } : {}),
  };
}

const T1_V3_TO_V4: CompatAdapter = {
  id: 't1_v3_to_v4',
  from: 3,
  to: 4,
  description: 'Bloc candidat Opération au format antérieur (CDC §7.1 `businessOperationCandidate` ou B3 `operationCandidates[]`) → `businessOperationCandidates[]` (C3.1).',
  detect: (v) => isObj(v) && v.businessOperationCandidates === undefined
    && (isObj(v.businessOperationCandidate) || Array.isArray(v.operationCandidates)),
  apply: (v) => {
    const { businessOperationCandidate: seul, operationCandidates: liste, ...reste } = v;
    const sources = Array.isArray(liste) ? liste : isObj(seul) ? [seul] : [];
    return { ...reste, businessOperationCandidates: sources.filter(isObj).map(candidateOf) };
  },
};

// ── Registre ────────────────────────────────────────────────────────────────

const CONTRACTS: readonly OutputContract[] = [
  // Lot 91D : v6 = v5 + `valueDecisions[]` facultatif (une v5 reste une v6 valide, aucun adaptateur).
  { name: 'T1AnalyzeDocumentOutput', label: 't1_analyze_document', version: 6, adapters: [T1_V1_TO_V2, T1_V3_TO_V4] },
  { name: 'T1GroupUploadOutput', label: 't1_group_upload', version: 1, adapters: [] },
  { name: 'T3ValueConflictOutput', label: 't3_value_conflict', version: 1, adapters: [] },
  { name: 'T3LinkAmbiguityOutput', label: 't3_link_ambiguity', version: 1, adapters: [] },
  { name: 'T3OperationMatchOutput', label: 't3_operation_match', version: 1, adapters: [] },
  // Lot 61 : `document_renames` facultative (absente = aucune proposition).
  { name: 'T3DocumentNamingOutput', label: 't3_document_naming', version: 1, adapters: [] },
  // Lot 85F : contrat `t3-knowledge-query-v1` (demande à l'équipe IA 85F).
  { name: 'T3KnowledgeQueryOutput', label: 't3_knowledge_query', version: 1, adapters: [] },
  { name: 'T4ClassifyEventOutput', label: 't4_classify_event', version: 1, adapters: [] },
  // Lot 54 : même contrat (T4_CLASSIFY_EVENT), version 2 — schéma distinct,
  // choisi par le contrat de sortie `t4_output_v2` de la version de prompt.
  { name: 'T4ClassifyEventV2Output', label: 't4_classify_event', version: 2, adapters: [] },
  // Lot 61 : version 3 — v2 + bloc `intervention` (« À traiter »), contrat `t4_output_v3`.
  { name: 'T4ClassifyEventV3Output', label: 't4_classify_event', version: 3, adapters: [] },
  { name: 'T4VerifyCompletionOutput', label: 't4_verify_completion', version: 1, adapters: [] },
  { name: 'T4TemporalAmbiguityOutput', label: 't4_temporal_ambiguity', version: 1, adapters: [] },
  { name: 'T2UnderstandOutput', label: 't2_understand', version: 1, adapters: [] },
  { name: 'T2AnswerOutput', label: 't2_answer', version: 1, adapters: [] },
  { name: 'T2RevalidateOutput', label: 't2_revalidate', version: 1, adapters: [] },
  // T6 : `schemaVersion: "t6-output-v2"` dans la sortie même.
  { name: 'T6FormulateOutput', label: 't6_formulate', version: 2, adapters: [] },
  // Lot 61 : `schemaVersion: "t6-evaluation-v1"` dans la sortie même.
  { name: 'T6EvaluateOutput', label: 't6_evaluate', version: 1, adapters: [] },
];

export function contractFor(name: string | null | undefined): OutputContract | null {
  return name ? CONTRACTS.find((c) => c.name === name) ?? null : null;
}

export function listContracts(): readonly OutputContract[] {
  return CONTRACTS;
}

const hashCache = new WeakMap<object, string>();

/** Empreinte (12) du schéma JSON dérivé — stable pour un même schéma. */
export function schemaHash(schema: ZodType): string {
  const hit = hashCache.get(schema);
  if (hit) return hit;
  let txt: string;
  try {
    txt = JSON.stringify(z.toJSONSchema(splitPipe(schema).main, { io: 'input', unrepresentable: 'any' }));
  } catch {
    txt = String((schema as unknown as { _zod?: { def?: { type?: string } } })._zod?.def?.type ?? 'unknown');
  }
  const h = createHash('sha256').update(txt).digest('hex').slice(0, 12);
  hashCache.set(schema, h);
  return h;
}

/** Référence du contrat de sortie d'un appel (§5). */
export function outputSchemaRef(name: string | null | undefined, schema: ZodType, operationCode: string): OutputSchemaRef {
  const c = contractFor(name);
  return {
    name: name ?? operationCode,
    version: c ? `${c.label}@v${c.version}` : `${operationCode}@v1`,
    hash: schemaHash(schema),
  };
}

/**
 * Adaptateurs applicables, en chaîne (v1 → v2 → …). Chaque adaptation
 * appliquée est consignée.
 */
export function applyCompatAdapters(value: unknown, name: string | null | undefined, report: OutputRepairStep[]): unknown {
  const c = contractFor(name);
  if (!c || !isObj(value)) return value;
  let cur: unknown = value;
  for (const a of [...c.adapters].sort((x, y) => x.from - y.from)) {
    if (isObj(cur) && a.detect(cur)) {
      cur = a.apply(cur);
      report.push({ stage: 'compat_adapter', rule: a.id, path: '$', detail: `${c.label} v${a.from} → v${a.to}` });
    }
  }
  return cur;
}
