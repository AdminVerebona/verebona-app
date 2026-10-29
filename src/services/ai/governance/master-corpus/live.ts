/**
 * Passage RÉEL du corpus en préproduction — CDC 15 §30, D-17 (« passage
 * réel en préprod sur le sous-ensemble critique »).
 *
 * Le sous-ensemble critique = les cas dont le contexte permet de construire
 * les variables RÉELLES du master, avec les MÊMES constructeurs que la
 * production (variables T1, T2, T3, T4, T6). Le modèle est appelé par la
 * passerelle réelle (texte master de la version EFFECTIVE, modèles,
 * validation discriminée, trace, coût imputé au compte technique fourni),
 * puis la sortie passe les contrôles serveur de la branche (`evaluators.ts`).
 *
 * Hors sous-ensemble (pas de variables réelles possibles) : cas exigeant
 * une pièce jointe (T1 sur image sans texte extrait, REVALIDATE visuel).
 * Chaque branche doit garder au moins un cas réel — sinon le passage réel
 * de ce master est rouge.
 */
import { AiGateway } from '../../gateway/ai-gateway';
import { structuredSpecFor } from '../../master-prompts/structured-context';
import { masterOutputSchemaFor } from '../../gateway/master-output-schemas';
import { AI_OPERATIONS } from '../../registry/operations';
import type { MasterCorpusCase } from './cases';

type Vars = Record<string, unknown>;
type Builder = (c: MasterCorpusCase) => Promise<Vars | null>;

const ctx = <T>(c: MasterCorpusCase) => c.context as T;

const BUILDERS: Record<string, Builder> = {
  async t1_group_upload(c) {
    const x = ctx<{ displayNames?: string[]; mimeTypes?: string[] }>(c);
    if (!x.displayNames?.length) return null;
    const { buildGroupUploadVariables } = await import('../../source-analysis/master/prompt-context');
    return buildGroupUploadVariables({
      sourceType: 'file', sourceIds: x.displayNames.map((_n, i) => i + 1), accountId: 0, userId: 0,
      displayNames: x.displayNames, mimeTypes: x.mimeTypes ?? x.displayNames.map(() => 'application/pdf'),
    } as never) as unknown as Vars;
  },
  async t1_analyze_document(c) {
    const x = ctx<{ extractedContent?: string; displayNames?: string[]; mimeTypes?: string[] }>(c);
    if (!x.extractedContent) return null;
    const { buildAnalyzeDocumentVariables } = await import('../../source-analysis/master/prompt-context');
    const { fixtureAnalysisContext } = await import('../../source-analysis/__fixtures__/t1/load');
    const names = x.displayNames ?? ['document.pdf'];
    return buildAnalyzeDocumentVariables({
      input: {
        sourceType: 'file', sourceIds: names.map((_n, i) => i + 1), accountId: 0, userId: 0,
        displayNames: names, mimeTypes: x.mimeTypes ?? names.map(() => 'application/pdf'), extractedContent: x.extractedContent,
      } as never,
      groupIndices: [0], ctx: fixtureAnalysisContext(c as never), v2Families: [],
      // Corpus : compte Premium (pièces et équipements), cas des fixtures.
      capabilities: { rooms: true, equipments: true },
    }) as unknown as Vars;
  },
  async t2_understand(c) {
    const q = ctx<{ question?: string }>(c).question;
    if (!q) return null;
    const { t2MasterVariables } = await import('../../assistant/master/t2-answer');
    const { describeIntentCatalog, describeFieldCatalog } = await import('../../assistant/master/t2-understand');
    return t2MasterVariables('UNDERSTAND', {
      QUESTION: q, INTENTS: describeIntentCatalog(), FIELD_CATALOG: describeFieldCatalog(),
      PAGE_CONTEXT: '(aucun contexte de page)', CONVERSATION_CONTEXT: '(nouvelle conversation, aucun échange précédent)',
    });
  },
  async t2_answer(c) {
    const x = ctx<{ intent?: string; question?: string; sources?: never[] }>(c);
    if (!x.intent || !x.sources?.length) return null;
    const { t2MasterVariables, formatT2Sources, formatResolvedTargets } = await import('../../assistant/master/t2-answer');
    return t2MasterVariables('ANSWER', {
      INTENT: x.intent, QUESTION: x.question ?? '(question du corpus)', TODAY: new Date().toISOString().slice(0, 10),
      RESOLVED_TARGETS: formatResolvedTargets(undefined, x.sources), CONVERSATION: '(nouvelle conversation, aucun échange précédent)',
      SOURCES: formatT2Sources(x.sources),
    });
  },
  async t2_revalidate(c) {
    const r = ctx<{ revalidate?: Record<string, string>; provenance?: string }>(c);
    if (!r.revalidate || r.provenance === 'VISUAL') return null;
    const { t2MasterVariables } = await import('../../assistant/master/t2-answer');
    return t2MasterVariables('REVALIDATE', {
      QUESTION: r.revalidate.question, FACT: r.revalidate.fact, CURRENT_VALUE: r.revalidate.currentValue,
      PROVENANCE_MODE: 'TEXT', LOCATION: r.revalidate.location, CONTENT: r.revalidate.content,
    });
  },
  async t3_value_conflict(c) {
    const x = ctx<{ fieldKey: string; current: { value: string | null; origin: string }; candidates: Array<Record<string, unknown>> }>(c);
    const { valueConflictVariables } = await import('../../reconciliation/master/value-conflict');
    const candidates = x.candidates.map((k) => ({ ...k, documentDate: k.documentDate ? new Date(String(k.documentDate)) : null }));
    return valueConflictVariables({
      accountId: 0, assetId: 0, candidates: candidates as never, currentValue: x.current.value, currentOrigin: x.current.origin,
      decision: { fieldKey: x.fieldKey, currentValue: x.current.value, proposedValue: null, action: 'request_ai_review',
        reasonCode: 'AMBIGUOUS_EVIDENCE', confidence: 'probable', evidenceIds: [], deterministic: true } as never,
    });
  },
  async t3_operation_match(c) {
    // Lot 42 : variables enregistrées par le constructeur de production (`operationMatchVariables`).
    const x = ctx<{ operationMatch?: { subject?: unknown; candidates?: unknown[] } }>(c).operationMatch;
    if (!x?.subject || !x.candidates?.length) return null;
    const { operationMatchVariables } = await import('../../reconciliation/master/operation-match');
    return operationMatchVariables(x.subject as never, x.candidates as never);
  },
  async t3_document_naming(c) {
    // Lot 61 : variables construites par le constructeur de production (`namingVariables`).
    const x = ctx<{ documentNaming?: { docs?: unknown[]; origins?: Record<string, string>; conventions?: unknown[] } }>(c).documentNaming;
    if (!x?.docs?.length) return null;
    const { namingVariables, planChunks, groupKeyOf } = await import('../../reconciliation/document-naming/context');
    const docs = x.docs as never as import('../../reconciliation/document-naming/context').NamingDoc[];
    const group = { key: groupKeyOf(docs[0]) ?? 'corpus', docs };
    return namingVariables({
      group, chunk: planChunks(docs, docs, 40)[0], conventions: x.conventions ?? [],
      states: new Map(docs.map((d) => [d.id, { origin: (x.origins?.[String(d.id)] ?? 'UNKNOWN') as never, lastRenamedAt: null }])),
      details: new Map(), maxLength: 120,
    });
  },
  async t3_knowledge_query(c) {
    // Lot 85F : variables construites par le constructeur de production (`knowledgeQueryVariables`), première page.
    const x = ctx<{ knowledgeQuery?: { question?: unknown; documents?: unknown[]; elements?: unknown[]; today?: string } }>(c).knowledgeQuery;
    if (!x?.question || !x.elements?.length) return null;
    const { knowledgeQueryVariables } = await import('../../reconciliation/knowledge-query/contract');
    return knowledgeQueryVariables({
      question: x.question as never, documents: (x.documents ?? []) as never,
      page: { index: 1, count: 1, elements: x.elements as never }, today: x.today ?? '2026-10-24',
    });
  },
  async t3_operation_identity(c) {
    // Lot 97A : variables construites par le constructeur de production (`buildIdentityInput`, six emplacements T3).
    const raw = ctx<{ identity?: unknown }>(c).identity;
    if (!raw) return null;
    const [{ buildIdentityInput }, { identityVariables }] = await Promise.all([
      import('@/services/business-operations/semantic/identity-context'), import('@/services/business-operations/semantic/identity-contract'),
    ]);
    return identityVariables(buildIdentityInput(raw as never).input);
  },
  async t4_agenda_representation(c) {
    // Lot 97A : contexte construit par le constructeur de production (`buildRepresentationInput`, contrat t4_input_v3).
    const raw = ctx<{ representation?: unknown }>(c).representation;
    if (!raw) return null;
    const { buildRepresentationInput } = await import('@/services/business-operations/semantic/context');
    return { AGENDA_REPRESENTATION: buildRepresentationInput(raw as never).input };
  },
  async t3_link_ambiguity(c) {
    // Lot 31B — relation DOCUMENT_ASSET : même constructeur que la production.
    const da = ctx<{ documentAsset?: { subject: unknown; candidates: unknown[] } }>(c).documentAsset;
    if (da) {
      const { documentAssetVariables } = await import('../../reconciliation/document-asset/decision');
      return documentAssetVariables(da.subject as never, da.candidates as never);
    }
    const vars = ctx<{ variables?: Record<string, unknown> }>(c).variables;
    if (!vars) return null;
    const { LINK_RELATIONS, parseCandidates } = await import('../../reconciliation/master/link-ambiguity');
    for (const spec of Object.values(LINK_RELATIONS)) {
      const candidates = parseCandidates(vars[spec.variable]);
      if (candidates.length) {
        return { FIELD: null, CURRENT_STATE: null, EVIDENCES: null, SUBJECT_CONTEXT: vars.SUBJECT_CONTEXT ?? null,
          CANDIDATES: candidates, RELATION_TYPE: spec.relation };
      }
    }
    return null;
  },
  async t4_classify_event(c) {
    const x = ctx<{
      candidate?: { title: string; date?: string; excerpt?: string; documentType?: string };
      field?: { title: string; originFieldKey?: string; date?: string };
      /** Lot 54 : récurrence envisagée par le serveur (t4_input_v2). */
      recurrenceCandidate?: import('../../agenda/master/classify-event').T4RecurrenceCandidate | null;
      /** Lot 61 : demande d'évaluation « À traiter » (t4_output_v3). */
      toProcessAssessment?: import('../../agenda/master/classify-event').ToProcessAssessmentRequest | null;
    }>(c);
    const src = x.field ?? x.candidate;
    if (!src) return null;
    const { classifyEventVariables } = await import('../../agenda/master/classify-event');
    return classifyEventVariables(
      { title: src.title, originFieldKey: x.field?.originFieldKey ?? null, description: x.candidate?.excerpt ?? null } as never,
      { accountId: 0, date: src.date ?? null, excerpt: x.candidate?.excerpt, documentType: x.candidate?.documentType ?? null, recurrenceCandidate: x.recurrenceCandidate ?? null,
        toProcessAssessment: x.toProcessAssessment ?? null },
    );
  },
  async t4_temporal_ambiguity(c) {
    const x = ctx<{ temporal?: Record<string, unknown>; candidates?: Array<{ candidateId: number; date: string; interpretation: string }> }>(c);
    if (!x.temporal || !x.candidates?.length) return null;
    const { temporalAmbiguityVariables } = await import('../../agenda/master/temporal-ambiguity');
    return temporalAmbiguityVariables(x.temporal, x.candidates);
  },
  async t4_verify_completion(c) {
    const x = ctx<{ item: never; evidence: Record<string, unknown> }>(c);
    if (!x.item || !x.evidence) return null;
    const { decideCompletion } = await import('../../agenda/status-reconciler');
    const { verifyCompletionVariables } = await import('../../agenda/master/verify-completion');
    const ev = { ...x.evidence, documentDate: x.evidence.documentDate ? new Date(String(x.evidence.documentDate)) : null } as never;
    return verifyCompletionVariables(x.item, ev, decideCompletion(x.item, ev));
  },
  async t6_formulate(c) {
    const input = ctx<{ input?: unknown }>(c).input;
    // Lot 55A : emplacement facultatif des questions suggérées — `null` (bulle seule).
    const suggestions = ctx<{ suggestionContext?: unknown }>(c).suggestionContext ?? null;
    // Lot 61 : candidats jamais transmis en FORMULATE (mode EVALUATE distinct).
    return input ? {
      INPUT_JSON: JSON.stringify(input),
      SUGGESTION_CONTEXT: suggestions ? JSON.stringify(suggestions) : null,
      INTERPELLATION_CONTEXT: null,
    } : null;
  },
  // Lot 61 : MODE=EVALUATE — entrée `t6-evaluation-input-v1` du cas.
  async t6_evaluate(c) {
    const input = ctx<{ input?: unknown }>(c).input;
    return input ? { INPUT_JSON: null, SUGGESTION_CONTEXT: null, INTERPELLATION_CONTEXT: JSON.stringify(input) } : null;
  },
};

/** Variables réelles d'un cas, ou null s'il n'appartient pas au sous-ensemble critique. */
export async function liveVariablesFor(c: MasterCorpusCase): Promise<Vars | null> {
  const b = BUILDERS[c.operationCode];
  return b ? b(c) : null;
}

/** Lot 54 — schémas de sortie possibles de la branche (contrats de sortie déclarés), hors schéma de l'opération. */
export function branchSchemas(c: Pick<MasterCorpusCase, 'masterPromptCode' | 'task' | 'outputSchema'>) {
  const spec = structuredSpecFor(c.masterPromptCode);
  if (!spec) return [];
  const noms = new Set(Object.values(spec.outputContracts).map((o) => o.byTask[c.task]?.schemaName).filter((n): n is string => Boolean(n) && n !== c.outputSchema));
  return [...noms].map((n) => masterOutputSchemaFor(n)).filter((x): x is NonNullable<typeof x> => Boolean(x));
}

/** Construit l'adaptateur `live` du runner : variables pré-calculées, appel par la passerelle réelle. */
export async function buildLiveRunner(cases: MasterCorpusCase[], account: { accountId: number; userId: number }) {
  const vars = new Map<string, Vars | null>();
  for (const c of cases) vars.set(`${c.file}#${c.id}`, await liveVariablesFor(c));
  return {
    variablesFor: (c: MasterCorpusCase) => vars.get(`${c.file}#${c.id}`) ?? null,
    async call(c: MasterCorpusCase, variables: Vars) {
      const op = AI_OPERATIONS[c.operationCode];
      const schema = masterOutputSchemaFor(c.outputSchema);
      if (!schema) throw new Error(`schéma ${c.outputSchema} inconnu`);
      const res = await AiGateway.execute({
        useCaseCode: op.useCaseCode, operationCode: c.operationCode,
        accountId: account.accountId, userId: account.userId,
        promptVariables: variables, outputSchema: schema,
        // Lot 54 : schémas de la branche selon le contrat de sortie de la version active (T4 v1 / v2).
        acceptedOutputSchemas: branchSchemas(c),
        idempotencyKey: `master-corpus-live:${c.id}:${Date.now()}`,
        // Lot 22 : campagne de mesure du BO, hors plafond de coût du compte.
        costCapExempt: true,
      });
      return res.data;
    },
  };
}
