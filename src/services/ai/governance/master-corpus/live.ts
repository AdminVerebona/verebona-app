/**
 * Passage RÉEL du corpus en préproduction — CDC 15 §30, D-17 (« passage
 * réel en préprod sur le sous-ensemble critique »).
 *
 * Le sous-ensemble critique = les cas dont le contexte permet de construire
 * les variables RÉELLES du master, avec les MÊMES constructeurs que la
 * production (variables T1, T2, T3, T4, T5, T6). Le modèle est appelé par la
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
  async t3_link_ambiguity(c) {
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
    const x = ctx<{ candidate?: { title: string; date?: string; excerpt?: string }; field?: { title: string; originFieldKey?: string; date?: string } }>(c);
    const src = x.field ?? x.candidate;
    if (!src) return null;
    const { classifyEventVariables } = await import('../../agenda/master/classify-event');
    return classifyEventVariables(
      { title: src.title, originFieldKey: x.field?.originFieldKey ?? null, description: x.candidate?.excerpt ?? null } as never,
      { accountId: 0, date: src.date ?? null, excerpt: x.candidate?.excerpt },
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
  async t5_analyze(c) { return t5Variables(c); },
  async t5_modify(c) { return t5Variables(c); },
  async t6_formulate(c) {
    const input = ctx<{ input?: unknown }>(c).input;
    return input ? { INPUT_JSON: JSON.stringify(input) } : null;
  },
};

async function t5Variables(c: MasterCorpusCase): Promise<Vars | null> {
  const x = ctx<{ instruction?: string; masterTargets?: string[] }>(c);
  if (!x.instruction) return null;
  const { targetTexts, formatCurrentPrompts } = await import('../prompt-control.service');
  const { emptyTreatmentConfig } = await import('../../config/config-types');
  const { T5_TARGETS } = await import('../../config/treatments');
  const version = {
    entries: T5_TARGETS.map((t) => ({
      ...emptyTreatmentConfig(t), prompt: `Préambule ${t} (corpus).`,
      // Lot 16b : tous les traitements en master ; `masterTargets` du cas ne
      // distingue plus que les lignes dont le texte master est exposé.
      promptArchitecture: 'master' as const,
    })),
  } as never;
  return { CURRENT_MASTER_PROMPTS: formatCurrentPrompts(version, await targetTexts(version)), INSTRUCTION: x.instruction };
}

/** Variables réelles d'un cas, ou null s'il n'appartient pas au sous-ensemble critique. */
export async function liveVariablesFor(c: MasterCorpusCase): Promise<Vars | null> {
  const b = BUILDERS[c.operationCode];
  return b ? b(c) : null;
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
        idempotencyKey: `master-corpus-live:${c.id}:${Date.now()}`,
        // Lot 22 : campagne de mesure du BO, hors plafond de coût du compte.
        costCapExempt: true,
      });
      return res.data;
    },
  };
}
