/**
 * Contrôles SERVEUR rejoués sur chaque sortie enregistrée du corpus — CDC 15
 * §30 : « Cas minimum attendu » de chaque branche.
 *
 * Un évaluateur applique la traduction/validation serveur réelle de la
 * branche (monde fermé, protections, verdicts, support des affirmations…)
 * et compare au comportement attendu (`expected`). Il rend la liste des
 * écarts, vide si conforme. Une opération sans évaluateur est contrôlée
 * par le rendu du master et le schéma discriminé seulement (niveau
 * `schema`), ce qui est signalé dans le rapport.
 *
 * Imports dynamiques : le script de corpus ne charge que ce qu'il rejoue.
 */
import type { MasterCorpusCase } from './cases';

export type Evaluator = (c: MasterCorpusCase, output: unknown, ctx: { masterText: (code: string) => string }) => Promise<string[]>;

const ecart = (cond: boolean, msg: string): string[] => (cond ? [] : [msg]);
const exp = <T = unknown>(c: MasterCorpusCase, k: string): T | undefined => (c.expected ?? {})[k] as T | undefined;

export const MASTER_CORPUS_EVALUATORS: Readonly<Record<string, Evaluator>> = {
  // ── T1 ─────────────────────────────────────────────────────────────────────
  // GROUP_UPLOAD : partition exacte des fichiers déposés (aucun oubli, aucun
  // doublon, aucun indice inventé) — P-T1-01 « aucun mélange ».
  // ANALYZE_DOCUMENT : rendu + schéma (les contrôles de preuve et de
  // projection sont couverts par les tests unitaires et l'E2E P-T1-*).
  async t1_group_upload(c, output) {
    const n = ((c.context as { displayNames?: string[] }).displayNames ?? []).length;
    const vus = (output as { groups: number[][] }).groups.flat();
    const attendu = Array.from({ length: n }, (_x, i) => i);
    return [
      ...ecart(n === 0 || JSON.stringify([...vus].sort((a, b) => a - b)) === JSON.stringify(attendu), `partition invalide ${JSON.stringify(vus)}`),
      ...ecart(exp(c, 'groups') === undefined || JSON.stringify((output as { groups: unknown }).groups) === JSON.stringify(exp(c, 'groups')), 'regroupement inattendu'),
    ];
  },
  // ── T3 ─────────────────────────────────────────────────────────────────────
  async t3_value_conflict(c, output) {
    const { translateValueConflict } = await import('../../reconciliation/master/value-conflict');
    const ctx = c.context as { fieldKey: string; current: { value: string | null; origin: string }; candidates: Array<Record<string, unknown>> };
    const candidates = ctx.candidates.map((x) => ({ ...x, documentDate: x.documentDate ? new Date(String(x.documentDate)) : null })) as Array<Record<string, unknown>>;
    const r = translateValueConflict({
      accountId: 0, assetId: 0,
      decision: {
        fieldKey: ctx.fieldKey, currentValue: ctx.current.value, proposedValue: null, action: 'request_ai_review',
        reasonCode: 'AMBIGUOUS_EVIDENCE', confidence: 'probable', evidenceIds: candidates.map((x) => Number(x.evidenceId)), deterministic: true,
      } as never,
      candidates: candidates as never, currentValue: ctx.current.value, currentOrigin: ctx.current.origin,
    }, output as never);
    return [
      ...ecart(r.decision.action === exp(c, 'action'), `action ${r.decision.action} ≠ ${String(exp(c, 'action'))}`),
      ...ecart(!(exp<string[]>(c, 'neverActions') ?? []).includes(r.decision.action), `action interdite ${r.decision.action}`),
    ];
  },
  async t3_link_ambiguity(c, output) {
    const { decideLinks } = await import('../../reconciliation/master/link-ambiguity');
    const o = output as { matches: Array<{ candidateId: number; score: number; confidence: string; reason: string }> };
    const r = decideLinks(o.matches as never, { exclusive: true });
    const attendu = exp<{ candidateIds: number[] }>(c, 'ambiguity');
    return [
      ...ecart(JSON.stringify(r.retained) === JSON.stringify(exp(c, 'matches') ?? []), 'liaison automatique retenue malgré l’ambiguïté'),
      ...ecart(!attendu || JSON.stringify(r.ambiguity?.candidateIds) === JSON.stringify(attendu.candidateIds), 'ambiguïté non signalée'),
    ];
  },
  // ── T4 ─────────────────────────────────────────────────────────────────────
  async t4_classify_event(c, output) {
    const { translateClassifyEvent } = await import('../../agenda/master/classify-event');
    const r = translateClassifyEvent(output as never);
    return ecart(r.classification.category === exp(c, 'category'), `catégorie ${r.classification.category} ≠ ${String(exp(c, 'category'))}`);
  },
  async t4_temporal_ambiguity(c, output) {
    const { translateTemporalAmbiguity } = await import('../../agenda/master/temporal-ambiguity');
    const candidats = ((c.context as { candidates?: unknown[] }).candidates ?? []) as never[];
    const r = translateTemporalAmbiguity(output as never, candidats);
    const attendu = exp<string | null>(c, 'chosenDate') ?? null;
    return ecart((r.chosen?.date ?? null) === attendu, `date retenue ${r.chosen?.date ?? 'aucune'} ≠ ${attendu ?? 'aucune'}`);
  },
  async t4_verify_completion(c, output) {
    const { decideCompletion } = await import('../../agenda/status-reconciler');
    const { translateVerifyCompletion } = await import('../../agenda/master/verify-completion');
    const ctx = c.context as { item: never; evidence: Record<string, unknown> };
    const ev = { ...ctx.evidence, documentDate: ctx.evidence.documentDate ? new Date(String(ctx.evidence.documentDate)) : null } as never;
    const det = decideCompletion(ctx.item, ev);
    const r = translateVerifyCompletion(ctx.item, ev, det, output as never);
    return [
      ...ecart(r.status === exp(c, 'status'), `statut ${r.status} ≠ ${String(exp(c, 'status'))}`),
      ...ecart(exp(c, 'decision') === undefined || r.decision === exp(c, 'decision'), `décision ${r.decision}`),
      ...ecart(exp(c, 'occurrenceMatch') === undefined || r.occurrenceMatch === exp(c, 'occurrenceMatch'), `occurrence ${r.occurrenceMatch}`),
      ...ecart(r.status !== exp(c, 'neverStatus'), `statut interdit ${r.status}`),
      ...ecart(r.decision !== exp(c, 'neverDecision'), `décision interdite ${r.decision}`),
    ];
  },
  // ── T2 ─────────────────────────────────────────────────────────────────────
  async t2_understand(c, output) {
    const { toT2Understanding } = await import('../../assistant/master/t2-understand');
    const { toIntentRoute } = await import('@/services/verebona-assistant/core/classification.adapter');
    const r = toT2Understanding(output as never);
    const route = toIntentRoute(r.plan as never, 'PREMIUM');
    return [
      ...ecart(route.intent === exp(c, 'intent'), `intention ${route.intent}`),
      ...ecart(JSON.stringify(r.requestedFacts) === JSON.stringify(exp(c, 'requestedFacts') ?? r.requestedFacts), 'faits hors catalogue conservés'),
      ...ecart(!exp(c, 'readOnly') || route.allowedActionTypes.every((a) => /^(OPEN_|SHOW_)/.test(a)), 'action d’écriture permise'),
    ];
  },
  async t2_answer(c, output) {
    const { toGeneratedAnswer, validateAnswerForCorpus } = await loadAnswer();
    const { t2AnswerLines } = await import('../../assistant/master/t2-answer');
    const ctx = c.context as { intent: string; sources: never[] };
    const l = t2AnswerLines(output as never);
    const out = toGeneratedAnswer({ claims: l.lines as never, status: l.status, actionIntents: [], derivations: [] }, ctx.sources, [],
      { verifySupport: true, supportEvents: [], separator: l.separator });
    if (!out) return ['aucune affirmation soutenue'];
    const v = validateAnswerForCorpus(out, ctx.intent);
    if (!v) return ['réponse rejetée par le validateur'];
    const errs: string[] = [];
    if (exp(c, 'answerContains')) errs.push(...ecart(v.answer.includes(String(exp(c, 'answerContains'))), 'valeur attendue absente'));
    for (const x of exp<string[]>(c, 'answerNotContains') ?? []) errs.push(...ecart(!v.answer.includes(x), `« ${x} » affiché`));
    if (exp(c, 'supportLevel')) errs.push(...ecart(v.supportLevel === exp(c, 'supportLevel'), `étayage ${v.supportLevel}`));
    if (exp(c, 'lines')) errs.push(...ecart(v.answer.split('\n').length === exp(c, 'lines'), 'lignes aplaties'));
    if (exp(c, 'events')) errs.push(...ecart((output as { events?: unknown[] }).events?.length === exp(c, 'events'), 'événements perdus'));
    return errs;
  },
  async t2_revalidate(c, output) {
    const { fromT2Revalidate } = await import('@/services/verebona-assistant/core/revalidation.service');
    const prov = (c.context as { provenance?: 'TEXT' | 'VISUAL' }).provenance ?? 'TEXT';
    const r = fromT2Revalidate(output as never, prov);
    const contenu = ((c.context as { revalidate?: { content?: string } }).revalidate?.content ?? '').toLowerCase();
    return [
      ...ecart(!exp(c, 'excerptInContent') || (Boolean(r.excerpt) && contenu.includes(String(r.excerpt).toLowerCase())), 'extrait absent du contenu ciblé'),
      ...ecart(!('excerpt' in (c.expected ?? {})) || r.excerpt === exp(c, 'excerpt'), 'extrait inventé conservé'),
      ...ecart(!exp(c, 'visualEvidence') || Boolean(r.visualEvidence?.description), 'preuve visuelle absente'),
    ];
  },
  // ── T5 ─────────────────────────────────────────────────────────────────────
  async t5_analyze(c, output) {
    const { interpret } = await import('../prompt-control.service');
    const o = output as { verdict: never; analysis: string; targets: never[]; risks: string[]; configurationRecommendations: string[]; requiredCodeChanges: string[] };
    const r = interpret('analyze', { ...o, recommendations: o.configurationRecommendations } as never, () => '');
    return [
      ...ecart((exp<string[]>(c, 'verdicts') ?? [r.verdict]).includes(r.verdict), `verdict ${r.verdict}`),
      ...ecart(!exp(c, 'noProposedContent') || r.changes.every((x) => x.proposedContent === null), 'proposition écrite en analyse'),
      ...ecart(!exp(c, 'requiredCodeChanges') || o.requiredCodeChanges.length > 0, 'changement de code non signalé'),
    ];
  },
  async t5_modify(c, output, ctx) {
    const { interpret } = await import('../prompt-control.service');
    const o = output as { verdict: never; analysis: string; targets: never[]; risks: string[]; configurationRecommendations: string[] };
    const masters = new Set(((c.context as { masterTargets?: string[] }).masterTargets) ?? []);
    const { masterPromptForTreatment } = await import('../../config/prompt-architecture');
    const current = (t: string) => {
      const m = masters.has(t) ? masterPromptForTreatment(t as never) : null;
      return m ? ctx.masterText(m.masterPromptCode) : `Prompt actuel ${t}, texte de référence suffisamment long pour le seuil.`;
    };
    const r = interpret('modify', { ...o, recommendations: o.configurationRecommendations } as never, current as never,
      (t) => (masters.has(t) ? 'masterPrompt' : 'prompt'));
    const ecrits = r.changes.filter((x) => x.proposedContent).map((x) => x.treatment);
    return [
      ...ecart(JSON.stringify(ecrits) === JSON.stringify(exp(c, 'writable') ?? []), `cibles écrites ${ecrits.join(',') || '(aucune)'}`),
      ...ecart(!exp(c, 'field') || r.changes.filter((x) => x.proposedContent).every((x) => x.field === exp(c, 'field')), 'zone écrite incorrecte'),
      ...ecart(!r.changes.some((x) => (x.treatment as string) === 'T5'), 'T5 modifié par lui-même'),
    ];
  },
  // ── T6 ─────────────────────────────────────────────────────────────────────
  // Règles serveur du §28 (mêmes sujets, même ordre, aucun fait ajouté,
  // nuances) : `evaluateT6CorpusCase` du contrat T6 (C).
  async t6_formulate(c, output) {
    const { evaluateT6CorpusCase } = await import('@/services/home/mascot/t6-contract');
    return evaluateT6CorpusCase(c.context as never, output, c.expected as never);
  },
};

async function loadAnswer() {
  const { toGeneratedAnswer } = await import('@/services/verebona-assistant/core/generation.adapter');
  const { validateGeneratedAnswer } = await import('@/services/verebona-assistant/core/response-validator.service');
  return { toGeneratedAnswer, validateAnswerForCorpus: validateGeneratedAnswer };
}
