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

type Evaluator = (c: MasterCorpusCase, output: unknown, ctx: { masterText: (code: string) => string }) => Promise<string[]>;

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
  // ANALYZE_DOCUMENT (lot 40, CDC Opérations V1 C3) : candidats Opération
  // rejoués à travers l'ancrage et la BARRIÈRE SERVEUR réels
  // (`operation-candidates/prepare`). Attendus facultatifs :
  //   · `operationCandidates` : candidats RETENUS, dans l'ordre (type,
  //     statut, rôle, établi, confiance, rôles et devises des montants) ;
  //   · `noEstablishedCandidate: true` : aucun candidat établi (F-003 à F-009).
  // Invariants contrôlés sur TOUS les cas : un candidat établi a au moins
  // une preuve ; une preuve de paiement ne porte aucun coût (INV-FINAL-015).
  async t1_analyze_document(c, output) {
    const { anchorOperationCandidates, currencyEvidenceOf, gateOperationCandidates } = await import('../../source-analysis/operation-candidates/prepare');
    const { checkFactEvidence } = await import('../../source-analysis/master/fact-evidence');
    const { transactionNature } = await import('../../source-analysis/projection/rules');
    const out = structuredClone(output) as import('../../source-analysis/master/t1-contract').T1AnalyzeDocumentOutput;
    const ancres = anchorOperationCandidates(out, 'PASS_1');
    const ctx = c.context as { verified?: Partial<Record<'ASSET' | 'EQUIPMENT' | 'ROOM', number[]>>; capabilities?: { rooms?: boolean; equipments?: boolean } };
    const ids = (k: 'ASSET' | 'EQUIPMENT' | 'ROOM') => new Set(ctx.verified?.[k] ?? []);
    const gardes = out.facts.filter((f) => checkFactEvidence(f).ok) as Array<{ t1FactRef?: string }>;
    const classification = out.document.classification;
    const r = gateOperationCandidates(ancres, {
      hasExploitableContent: out.hasExploitableContent,
      documentTypeCode: classification?.documentTypeCode ?? null,
      verifiedIds: { ASSET: ids('ASSET'), EQUIPMENT: ids('EQUIPMENT'), ROOM: ids('ROOM') },
      capabilities: { rooms: ctx.capabilities?.rooms ?? true, equipments: ctx.capabilities?.equipments ?? true },
      keptFactRefs: new Set(gardes.flatMap((f) => (f.t1FactRef ? [f.t1FactRef] : []))),
      currencyEvidence: currencyEvidenceOf(out),
      transactionNature: transactionNature({
        documentTypeCode: classification?.documentTypeCode ?? null,
        texts: [out.document.title?.value, out.document.amountCents?.evidence?.excerpt],
      }),
    });
    const errs: string[] = [];
    for (const x of r.candidates) {
      errs.push(...ecart(!x.established || x.evidenceFactRefs.length > 0, `candidat ${x.candidateKey} établi sans preuve`));
      errs.push(...ecart(x.sourceRoleHint !== 'PAYMENT_PROOF' || x.financialHints.every((h) => h.role !== 'REALIZED_COST' && h.role !== 'FORECAST_COST'),
        `preuve de paiement ${x.candidateKey} comptée comme coût`));
    }
    if (exp(c, 'noEstablishedCandidate')) {
      errs.push(...ecart(r.candidates.every((x) => !x.established), `candidat établi inattendu (${r.candidates.filter((x) => x.established).map((x) => x.typeHint ?? 'type nul').join(', ')})`));
    }
    const attendus = exp<Array<Record<string, unknown>>>(c, 'operationCandidates');
    if (attendus) {
      errs.push(...ecart(r.candidates.length === attendus.length, `${r.candidates.length} candidat(s) retenu(s) ≠ ${attendus.length}`));
      attendus.forEach((a, i) => {
        const x = r.candidates[i];
        if (!x) return;
        const vu: Record<string, unknown> = {
          typeHint: x.typeHint, statusHint: x.statusHint, sourceRoleHint: x.sourceRoleHint, established: x.established,
          confidence: x.confidence, exclusionReason: x.exclusionReason,
          financialRoles: x.financialHints.map((h) => h.role), currencies: x.financialHints.map((h) => h.currency),
          amountsMinor: x.financialHints.map((h) => h.amountMinor), amountScopes: x.financialHints.map((h) => h.amountScope),
          targetEntityIds: x.targetHints.map((t) => t.entityId), evidenceCount: x.evidenceFactRefs.length,
        };
        for (const [k, v] of Object.entries(a)) {
          errs.push(...ecart(JSON.stringify(vu[k]) === JSON.stringify(v), `candidat ${i + 1} : ${k} ${JSON.stringify(vu[k])} ≠ ${JSON.stringify(v)}`));
        }
      });
    }
    return errs;
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
    // Lot 31B — relation DOCUMENT_ASSET : décision serveur réelle
    // (`decideFromAiOutput` : monde fermé, seuil, certain exigé, marge A OU B,
    // A ET B déclaré, jamais un candidat sans preuve).
    const da = (c.context as { documentAsset?: { candidates: unknown[] } }).documentAsset;
    if (da) {
      const { decideFromAiOutput } = await import('../../reconciliation/document-asset/decision');
      const r = decideFromAiOutput(output as never, da.candidates as never);
      const ids = r.kind === 'APPLY' ? [r.assetId] : r.kind === 'MULTI_ASSET' ? r.assetIds : [];
      return [
        ...ecart(r.kind === exp(c, 'decision'), `décision ${r.kind} ≠ ${String(exp(c, 'decision'))}`),
        ...ecart(exp(c, 'assetIds') === undefined || JSON.stringify(ids) === JSON.stringify(exp(c, 'assetIds')), `biens ${JSON.stringify(ids)}`),
        ...ecart(exp(c, 'reasonCode') === undefined || (r.kind === 'ABSTAIN' && r.reasonCode === exp(c, 'reasonCode')), 'motif d’abstention inattendu'),
        ...ecart(!(exp<string[]>(c, 'neverDecisions') ?? []).includes(r.kind), `décision interdite ${r.kind}`),
      ];
    }
    const { decideLinks } = await import('../../reconciliation/master/link-ambiguity');
    const o = output as { matches: Array<{ candidateId: number; score: number; confidence: string; reason: string }> };
    const r = decideLinks(o.matches as never, { exclusive: true });
    const attendu = exp<{ candidateIds: number[] }>(c, 'ambiguity');
    return [
      ...ecart(JSON.stringify(r.retained) === JSON.stringify(exp(c, 'matches') ?? []), 'liaison automatique retenue malgré l’ambiguïté'),
      ...ecart(!attendu || JSON.stringify(r.ambiguity?.candidateIds) === JSON.stringify(attendu.candidateIds), 'ambiguïté non signalée'),
    ];
  },
  // Lot 42 — OPERATION_MATCH (CDC Opérations V1 C6.2) : monde fermé puis
  // décision serveur réelle (`applyM3Verdict`) sur la décision M3_REQUIRED du
  // cas. Attendus : `outcome`, `operationId` (facultatif), `neverOutcomes`.
  async t3_operation_match(c, output) {
    const { translateOperationMatch } = await import('../../reconciliation/master/operation-match');
    const { applyM3Verdict } = await import('../../../business-operations/consolidation/matching');
    const om = (c.context as { operationMatch: {
      candidate: Record<string, unknown>; operations: Array<Record<string, unknown>>; plausible: number[];
    } }).operationMatch;
    const ops = om.operations.map((o) => ({ providerKey: null, refs: [], assetIds: [], plannedDate: null, startDate: null, realizedDate: null, endDate: null, ...o })) as never[];
    const identity = {
      candidateId: 1, candidateKey: 'op1', fileId: 1, established: true, confidence: 'certain', type: null, status: 'REALIZED', role: null,
      summary: '', provider: null, providerKey: null, assetIds: [], targetAuthority: null, equipmentIds: [], refs: [],
      dates: { plannedDate: null, startDate: null, realizedDate: null, endDate: null }, hints: [], ...om.candidate,
    } as never;
    const { verdict } = translateOperationMatch(output as never, new Set(om.plausible));
    const base = {
      outcome: 'HOLD_UNRESOLVED' as const, operationId: null, matchMethod: null, reason: 'M3_REQUIRED',
      detail: { certain: [], plausible: [...om.plausible], contradictions: [], excluded: [] },
    };
    const d = applyM3Verdict(identity, base, verdict, { operations: ops, assetStatus: new Map() });
    return [
      ...ecart(d.outcome === exp(c, 'outcome'), `issue ${d.outcome} ≠ ${String(exp(c, 'outcome'))}`),
      ...ecart(exp(c, 'operationId') === undefined || d.operationId === exp(c, 'operationId'), `Opération ${String(d.operationId)}`),
      ...ecart(!(exp<string[]>(c, 'neverOutcomes') ?? []).includes(d.outcome), `issue interdite ${d.outcome}`),
    ];
  },
  // Lot 61 — DOCUMENT_NAMING : garde-fous serveur réels (`judgeProposal`,
  // `collidingProposals`) sur les propositions du modèle. Attendus :
  // `applied` (identifiant → nom retenu), `refused` (identifiant → motif).
  async t3_document_naming(c, output) {
    const { judgeProposal, collidingProposals } = await import('../../reconciliation/document-naming/guards');
    const { documentFingerprint } = await import('../../reconciliation/document-naming/context');
    const x = (c.context as { documentNaming: { docs: Array<Record<string, unknown>>; origins?: Record<string, string>; known?: Record<string, unknown> } }).documentNaming;
    const docs = new Map(x.docs.map((d) => [Number(d.id), {
      id: Number(d.id), name: String(d.name), origin: (x.origins?.[String(d.id)] ?? 'UNKNOWN') as never, fingerprint: documentFingerprint(d as never),
    }]));
    const o = output as { document_renames?: Array<Record<string, unknown>> };
    const seen = new Set<number>();
    const verdicts = (o.document_renames ?? []).map((p) => ({ p, v: judgeProposal(p as never, {
      docs, seen, known: (x.known?.[String(p.document_id)] as never) ?? { dates: [], periods: [], amountsCents: [], texts: [] }, now: new Date(), cooldownDays: 30,
    }) }));
    const collisions = collidingProposals(verdicts.flatMap(({ p, v }) => (v.accept ? [{ documentId: Number(p.document_id), name: v.name }] : [])), docs);
    const appliques: Record<string, string> = {};
    const refuses: Record<string, string> = {};
    for (const { p, v } of verdicts) {
      if (v.accept && !collisions.has(Number(p.document_id))) appliques[String(p.document_id)] = v.name;
      else refuses[String(p.document_id)] = v.accept ? 'NAME_COLLISION' : v.code;
    }
    // Lot 63 : familles attendues (facultatif) — regroupement des documents,
    // indépendamment des libellés et de l'ordre (le jugement reste celui de l'IA).
    const familles = exp<number[][]>(c, 'families');
    const cle = (l: number[][]) => JSON.stringify(l.map((f) => [...f].map(Number).sort((a, b) => a - b)).sort((a, b) => a[0] - b[0]));
    const obtenues = ((output as { families?: Array<{ document_ids?: number[] }> }).families ?? []).map((f) => f.document_ids ?? []);
    return [
      ...ecart(JSON.stringify(appliques) === JSON.stringify(exp(c, 'applied') ?? {}), `renommages retenus ${JSON.stringify(appliques)}`),
      ...ecart(exp(c, 'refused') === undefined || JSON.stringify(refuses) === JSON.stringify(exp(c, 'refused')), `refus ${JSON.stringify(refuses)}`),
      ...ecart(familles === undefined || cle(obtenues) === cle(familles), `familles ${cle(obtenues)} ≠ ${familles ? cle(familles) : ''}`),
    ];
  },
  // Lot 85F — KNOWLEDGE_QUERY : validation SERVEUR réelle (`validateKnowledgeAnswer` :
  // monde fermé, extrait recopié, valeur exprimée et normalisée, contradiction).
  // Attendus : `outcome` (issue effective), `findings` (cible → valeur normalisée,
  // facultatif), `rejected` (motifs de refus, facultatif).
  // Lot 98A (P0-A) — attendus de COMPLÉTUDE, robustes à la formulation d'une réponse réelle :
  // `required` (cibles qui doivent figurer : une réponse « durée seule » est INCOMPLÈTE),
  // `values` (cible → valeur normalisée, autres cibles admises), `forbidden` (`FIELD` : date
  // inventée), `endDate` (décision permise par la chaîne déterministe existante :
  // NO_ACTION_UNDATED_NOT_NEEDED, DATE_STILL_NEEDED, DATE_FOUND — `completeness.ts`).
  async t3_knowledge_query(c, output) {
    const { validateKnowledgeAnswer } = await import('../../reconciliation/knowledge-query/validate');
    const { defaultNormalizers } = await import('../../reconciliation/knowledge-query/service');
    const { knowledgeCompleteness, endDateNeedOf } = await import('../../reconciliation/knowledge-query/completeness');
    const x = (c.context as { knowledgeQuery: { question: never; elements: Array<{ label: string | null; value: string | null; text: string | null }> } }).knowledgeQuery;
    const v = validateKnowledgeAnswer(output as never, x.question, x.elements as never[], await defaultNormalizers());
    const obtenus = Object.fromEntries(v.findings.map((f) => [f.target, f.normalized ?? f.rawValue]));
    const attendus = exp<Record<string, string>>(c, 'findings');
    const refus = v.rejected.map((r) => r.code).sort();
    const k = knowledgeCompleteness(v.findings, {
      required: exp<string[]>(c, 'required'), values: exp<Record<string, string>>(c, 'values'), forbidden: exp<string[]>(c, 'forbidden'),
    });
    const finAttendue = exp<string>(c, 'endDate');
    const fin = finAttendue === undefined ? null : await endDateNeedOf(v.findings, x.elements);
    return [
      ...ecart(v.outcome === exp(c, 'outcome'), `issue ${v.outcome} ≠ ${String(exp(c, 'outcome'))}`),
      ...ecart(attendus === undefined || JSON.stringify(obtenus) === JSON.stringify(attendus), `constats ${JSON.stringify(obtenus)}`),
      ...ecart(exp(c, 'rejected') === undefined || JSON.stringify(refus) === JSON.stringify(exp(c, 'rejected')), `refus ${JSON.stringify(refus)}`),
      ...ecart(k.missing.length === 0, `réponse incomplète : constituant(s) manquant(s) ${k.missing.join(', ')}`),
      ...ecart(k.forbiddenPresent.length === 0, `cible(s) non attendue(s) ${k.forbiddenPresent.join(', ')}${k.forbiddenPresent.includes('FIELD') ? ' : date inventée' : ''}`),
      ...k.valueMismatches.map((m) => `${m.target} : ${JSON.stringify(m.obtained)} ≠ attendu ${m.expected}`),
      ...ecart(fin === null || fin.decision === finAttendue,
        `décision date de fin ${fin?.decision ?? ''} ≠ ${String(finAttendue)} (échéancier ${fin?.repaymentSchedule ? 'identifié' : 'non identifié'}, démarches de fin ${fin?.endActions.length ?? 0})`),
    ];
  },
  // Lot 97A — OPERATION_IDENTITY (contrat t3-operation-identity-v1) : contexte construit par le code de
  // production (`buildIdentityInput`), validation serveur réelle (monde fermé, complétude, protections) puis
  // plan (décisions certaines → décisions de rattachement). Attendus : `valid`, `outcome`, `mutations`
  // (natures triées), `issues` (motifs de refus triés).
  async t3_operation_identity(c, output) {
    const [{ buildIdentityInput }, { validateIdentity, planIdentity }] = await Promise.all([
      import('@/services/business-operations/semantic/identity-context'), import('@/services/business-operations/semantic/identity-validate'),
    ]);
    const b = buildIdentityInput((c.context as { identity: never }).identity);
    const v = validateIdentity(output, b.scope);
    const issues = v.ok ? [] : [...new Set(v.problems.map((p) => p.issue))].sort();
    const kinds = v.ok && v.decision.outcome !== 'ABSTAIN' ? planIdentity(v.decision, b.scope).mutations.map((m) => m.kind).sort() : [];
    return [
      ...ecart(exp(c, 'valid') === undefined || v.ok === exp(c, 'valid'), `validité ${v.ok}${v.ok ? '' : ` (${issues.join(',')})`}`),
      ...ecart(exp(c, 'outcome') === undefined || (v.ok && v.decision.outcome === exp(c, 'outcome')), `issue ${v.ok ? v.decision.outcome : 'refusée'}`),
      ...ecart(exp(c, 'mutations') === undefined || JSON.stringify(kinds) === JSON.stringify(exp(c, 'mutations')), `mutations ${JSON.stringify(kinds)}`),
      ...ecart(exp(c, 'issues') === undefined || JSON.stringify(issues) === JSON.stringify(exp(c, 'issues')), `refus ${JSON.stringify(issues)}`),
    ];
  },
  // ── T4 ─────────────────────────────────────────────────────────────────────
  // Lot 97A — AGENDA_REPRESENTATION (contrat t4-agenda-representation-v1) : contexte construit par le code de
  // production (`buildRepresentationInput`), validation (`validateRepresentation`) et plan (`planRepresentation`)
  // réels. Attendus : `valid`, `outcome`, `mutations` (natures dans l'ordre du plan), `refused` (motifs), `issues`.
  async t4_agenda_representation(c, output) {
    const [{ buildRepresentationInput }, { validateRepresentation }, { planRepresentation }] = await Promise.all([
      import('@/services/business-operations/semantic/context'), import('@/services/business-operations/semantic/validate'),
      import('@/services/business-operations/semantic/plan'),
    ]);
    const b = buildRepresentationInput((c.context as { representation: never }).representation);
    const v = validateRepresentation(output, b.scope);
    const issues = v.ok ? [] : [...new Set(v.problems.map((p) => p.issue))].sort();
    const plan = v.ok ? planRepresentation(v.decision, b.scope) : { mutations: [], refused: [] };
    return [
      ...ecart(exp(c, 'valid') === undefined || v.ok === exp(c, 'valid'), `validité ${v.ok}${v.ok ? '' : ` (${issues.join(',')})`}`),
      ...ecart(exp(c, 'outcome') === undefined || (v.ok && v.decision.outcome === exp(c, 'outcome')), `issue ${v.ok ? v.decision.outcome : 'refusée'}`),
      ...ecart(exp(c, 'mutations') === undefined || JSON.stringify(plan.mutations.map((m) => m.kind)) === JSON.stringify(exp(c, 'mutations')), `mutations ${JSON.stringify(plan.mutations.map((m) => m.kind))}`),
      ...ecart(exp(c, 'refused') === undefined || JSON.stringify(plan.refused.map((r) => r.reason)) === JSON.stringify(exp(c, 'refused')), `refus ${JSON.stringify(plan.refused.map((r) => r.reason))}`),
      ...ecart(exp(c, 'issues') === undefined || JSON.stringify(issues) === JSON.stringify(exp(c, 'issues')), `problèmes ${JSON.stringify(issues)}`),
    ];
  },
  async t4_classify_event(c, output) {
    const { translateClassifyEvent, translateEventDecision } = await import('../../agenda/master/classify-event');
    const r = translateClassifyEvent(output as never);
    const errs = exp(c, 'category') === undefined ? []
      : ecart(r.classification.category === exp(c, 'category'), `catégorie ${r.classification.category} ≠ ${String(exp(c, 'category'))}`);
    // Lot 54 (t4_output_v2) : décision appliquée par le moteur, cohérence
    // avec l'entrée réelle comprise (candidat de récurrence présent ou non).
    if (exp(c, 'agendaDecision') !== undefined || exp(c, 'recurrenceDecision') !== undefined) {
      const avecCandidat = Boolean((c.context as { recurrenceCandidate?: unknown }).recurrenceCandidate);
      const d = translateEventDecision(output as never, avecCandidat);
      errs.push(
        ...ecart(exp(c, 'agendaDecision') === undefined || d.agendaDecision === exp(c, 'agendaDecision'), `agendaDecision ${d.agendaDecision} ≠ ${String(exp(c, 'agendaDecision'))}`),
        ...ecart(exp(c, 'recurrenceDecision') === undefined || d.recurrenceDecision === exp(c, 'recurrenceDecision'), `recurrenceDecision ${d.recurrenceDecision} ≠ ${String(exp(c, 'recurrenceDecision'))}`),
      );
    }
    // Lot 61 (t4_output_v3) : évaluation de l'intervention « À traiter »,
    // contrôlée par le serveur (preuve retrouvée dans le contexte fourni).
    if (exp(c, 'interventionNeeded') !== undefined || exp(c, 'interventionKind') !== undefined) {
      const { checkInterventionCoherence } = await import('../../../to-process/intervention-check');
      const ctx = c.context as { candidate?: { excerpt?: string; title?: string }; toProcessAssessment?: { documentTitle?: string | null } };
      const iv = checkInterventionCoherence((output as { intervention?: never }).intervention, {
        requested: !!ctx.toProcessAssessment,
        providedText: [ctx.candidate?.excerpt ?? '', ctx.candidate?.title ?? '', ctx.toProcessAssessment?.documentTitle ?? ''].join(' '),
      });
      errs.push(
        ...ecart(exp(c, 'interventionNeeded') === undefined || iv?.needed === exp(c, 'interventionNeeded'), `intervention ${iv?.needed ?? 'absente'} ≠ ${String(exp(c, 'interventionNeeded'))}`),
        ...ecart(exp(c, 'interventionKind') === undefined || iv?.kind === exp(c, 'interventionKind'), `nature ${iv?.kind ?? 'aucune'} ≠ ${String(exp(c, 'interventionKind'))}`),
      );
    }
    return errs;
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
      // Lot 29 (ticket 13) : types d'indice conservés (équipement, pièce — jamais rabattus sur `asset`).
      ...ecart(!exp(c, 'entityHintTypes') || JSON.stringify(route.entityHints.map((h) => h.type)) === JSON.stringify(exp(c, 'entityHintTypes')),
        `types d’indice ${route.entityHints.map((h) => h.type).join(',')}`),
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
  // ── T6 ─────────────────────────────────────────────────────────────────────
  // Règles serveur du §28 (mêmes sujets, même ordre, aucun fait ajouté,
  // nuances) : `evaluateT6CorpusCase` du contrat T6 (C).
  async t6_formulate(c, output) {
    const { evaluateT6CorpusCase } = await import('@/services/home/mascot/t6-contract');
    return evaluateT6CorpusCase(c.context as never, output, c.expected as never);
  },
  // Lot 61 — MODE=EVALUATE : contrat `t6-evaluation-v1` (Zod strict) et
  // contrôles métier (une décision par candidat, ordre, motifs, preuves, dates).
  async t6_evaluate(c, output) {
    const { evaluateT6EvaluationCorpusCase } = await import('@/services/home/mascot/t6-contract');
    return evaluateT6EvaluationCorpusCase(c.context as never, output, c.expected as never);
  },
};

async function loadAnswer() {
  const { toGeneratedAnswer } = await import('@/services/verebona-assistant/core/generation.adapter');
  const { validateGeneratedAnswer } = await import('@/services/verebona-assistant/core/response-validator.service');
  return { toGeneratedAnswer, validateAnswerForCorpus: validateGeneratedAnswer };
}
