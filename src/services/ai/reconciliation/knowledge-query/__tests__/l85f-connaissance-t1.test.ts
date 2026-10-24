/**
 * Lot 85F — ticket P1 « T3 doit exploiter toute la connaissance T1 persistée
 * avant de conclure qu'une information manque » : parties PURES et
 * orchestration avec un fournisseur IA SIMULÉ (sans base). Cycle complet sur
 * PostgreSQL 16 : `src/test/e2e/scenarios/l85f-t3-connaissance-t1.e2e.ts`.
 *
 *  L85F-U01  contrat de sortie KNOWLEDGE_QUERY (schéma)
 *  L85F-U02  validation serveur : monde fermé, extrait recopié, valeur exprimée, refus
 *  L85F-U03  formulations différentes → même résultat côté code
 *  L85F-U04  le code ne dépend d'aucun mot (garde anti-regex métier)
 *  L85F-U05  contexte borné, ordre neutre, complétude
 *  L85F-U06  orchestration : aucune IA si rien à interpréter, capacité absente, mémoire, budget, panne
 *  L85F-U07  constats → moteur existant : jamais une écriture automatique
 *  L85F-U08  registre IA : opération déclarée, branche facultative attendue de l'équipe IA
 *  L85F-U09  corpus de recette de la branche (ignoré sans la branche, rejoué avec)
 *  L85F-U-COH registre de cohérence : COH-T1-KNOWLEDGE-CONSUMPTION
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: {} }));

const contrat = await import('../contract');
const ctxMod = await import('../context');
const val = await import('../validate');
const svc = await import('../service');
const sem = await import('@/services/to-process/document-semantic-knowledge');
const { getRule } = await import('@/services/to-process/rules-catalog');
const { AI_CONFIDENCE_THRESHOLD } = await import('@/lib/referential/v2');

const RULE = getRule('DATA-CONTRACT-END')!;
const BNP = 'Le montant du prêt est de 490000,00 euros. La durée est égale à 22 ans';
type El = import('../contract').KnowledgeElement & { structured?: boolean };
const unite = (ref: string, text: string, p: Partial<El> = {}): El => ({
  ref, document: 'D0', fileId: 10, layer: 'SOURCE_UNIT', kind: 'TEXT_BLOCK', label: null, value: null, text, confidence: 'certain', page: 1,
  covered: true, sourceUnitId: ref.toLowerCase(), ...p,
});
const fait = (ref: string, label: string, value: string, p: Partial<El> = {}): El => ({
  ref, document: 'D0', fileId: 10, layer: 'FACT', kind: 'contractNumber', label, value, text: null, confidence: 'certain', page: null, structured: true, ...p,
});
const DOCS: import('../contract').KnowledgeDocument[] = [{ ref: 'D0', fileId: 10, role: 'TARGET', relation: null, title: 'Offre de crédit', documentType: 'FINANCING_CONTRACT' }];
const norm = await svc.defaultNormalizers();
const question = await svc.buildKnowledgeQuestion(RULE, 'contractEndDate');

const sortie = (outcome: string, findings: unknown[] = [], reason = 'simulé') => contrat.T3KnowledgeQueryOutput.parse({ task: 'KNOWLEDGE_QUERY', outcome, findings, reason });
const constat = (target: string, rawValue: string, refs: string[], excerpt: string, p: Record<string, unknown> = {}) =>
  ({ target, rawValue, evidenceRefs: refs, excerpt, confidence: 'certain', meaning: 'simulé', ...p });

describe('L85F-U01 — contrat de sortie KNOWLEDGE_QUERY', () => {
  it('FOUND exige un constat FIELD ; CONSTITUENTS aucun FIELD ; CONTRADICTION deux valeurs ; NOT_FOUND sans constat', () => {
    expect(() => sortie('FOUND', [constat('duration', '22 ans', ['U-1'], 'La durée est égale à 22 ans')])).toThrow();
    expect(() => sortie('CONSTITUENTS', [constat('FIELD', '31/12/2030', ['U-1'], 'x 31/12/2030')])).toThrow();
    expect(() => sortie('CONTRADICTION', [constat('FIELD', '31/12/2030', ['U-1'], '31/12/2030')])).toThrow();
    expect(() => sortie('NOT_FOUND', [constat('FIELD', '31/12/2030', ['U-1'], '31/12/2030')])).toThrow();
    expect(sortie('NOT_FOUND').findings).toEqual([]);
    expect(() => contrat.T3KnowledgeQueryOutput.parse({ task: 'KNOWLEDGE_QUERY', outcome: 'FOUND', findings: [{ ...constat('FIELD', 'x', [], 'x') }], reason: 'r' })).toThrow();
  });

  it('variables : six emplacements existants du master T3, données seulement (aucune consigne), question et constituants déclarés par donnée', () => {
    const v = contrat.knowledgeQueryVariables({ question, documents: DOCS, page: { index: 1, count: 1, elements: [unite('U-1', BNP)] }, today: '2026-10-24' });
    expect(Object.keys(v).sort()).toEqual(['CANDIDATES', 'CURRENT_STATE', 'EVIDENCES', 'FIELD', 'RELATION_TYPE', 'SUBJECT_CONTEXT']);
    expect(v.FIELD).toMatchObject({ contractVersion: 't3-knowledge-query-v1', key: 'contractEndDate', valueType: 'date', ruleCode: 'DATA-CONTRACT-END' });
    expect((v.CANDIDATES as Array<{ role: string }>).map((c) => c.role)).toEqual(['start', 'duration', 'firstInstalment', 'lastInstalment', 'count', 'periodicity', 'disbursement', 'repayment']);
    expect(v.EVIDENCES).toEqual([{ ref: 'U-1', document: 'D0', layer: 'SOURCE_UNIT', kind: 'TEXT_BLOCK', label: null, value: null, text: BNP, confidence: 'certain', page: 1 }]);
    expect(v.SUBJECT_CONTEXT).toMatchObject({ closedWorld: true, page: { index: 1, count: 1 } });
  });
});

describe('L85F-U02 — validation serveur de la sortie IA', () => {
  const els = [unite('U-1', BNP), unite('U-2', 'Le contrat prend effet le 01/03/2024.'), unite('U-3', 'Il est conclu pour une période de 36 mois.')];

  it('cas BNP : durée comprise (264 mois) et indice d’échéancier retenus avec leur preuve ; aucune date', () => {
    const v = val.validateKnowledgeAnswer(sortie('CONSTITUENTS', [
      constat('duration', '22 ans', ['U-1'], 'La durée est égale à 22 ans', { value: 264 }),
      constat('repayment', 'La durée est égale à 22 ans', ['U-1'], BNP),
    ]), question, els, norm);
    expect(v.outcome).toBe('CONSTITUENTS');
    expect(v.findings.map((f) => [f.target, f.normalized])).toEqual([['duration', '264'], ['repayment', null]]);
    expect(v.findings[0]).toMatchObject({ evidenceRefs: ['U-1'], evidenceConfidence: 'certain', fileIds: [10] });
    expect(v.rejected).toEqual([]);
  });

  it('preuve hors contexte, extrait non recopié, valeur absente de l’extrait, valeur incohérente, cible non demandée : refusés', () => {
    const v = val.validateKnowledgeAnswer(sortie('CONSTITUENTS', [
      constat('duration', '22 ans', ['U-99'], 'La durée est égale à 22 ans'),
      constat('duration', '25 ans', ['U-1'], 'La durée est égale à 25 ans'),
      constat('duration', '30 ans', ['U-1'], 'La durée est égale à 22 ans'),
      constat('duration', '22 ans', ['U-1'], 'La durée est égale à 22 ans', { value: 300 }),
      constat('mensualite', '1 800 €', ['U-1'], 'La durée est égale à 22 ans'),
    ]), question, els, norm);
    expect(v.findings).toEqual([]);
    expect(v.rejected.map((r) => r.code)).toEqual(['UNKNOWN_EVIDENCE_REF', 'EXCERPT_NOT_IN_EVIDENCE', 'VALUE_NOT_IN_EXCERPT', 'VALUE_MISMATCH', 'UNKNOWN_TARGET']);
    expect(v.outcome).toBe('REJECTED');
  });

  it('connaissance répartie sur plusieurs unités : constituants cités séparément ou en segments', () => {
    const v = val.validateKnowledgeAnswer(sortie('CONSTITUENTS', [
      constat('start', '01/03/2024', ['U-2'], 'Le contrat prend effet le 01/03/2024.'),
      constat('duration', '36 mois', ['U-3', 'U-2'], 'prend effet le 01/03/2024 [...] une période de 36 mois'),
    ]), question, els, norm);
    expect(v.findings.map((f) => [f.target, f.normalized])).toEqual([['start', '2024-03-01'], ['duration', '36']]);
  });

  it('abstention déclarée : aucun constat retenu même si des candidats sont cités ; contradiction détectée par le serveur', () => {
    expect(val.validateKnowledgeAnswer(sortie('AMBIGUOUS', [constat('duration', '22 ans', ['U-1'], 'La durée est égale à 22 ans')]), question, els, norm))
      .toMatchObject({ outcome: 'AMBIGUOUS', findings: [] });
    const deux = [unite('U-1', 'Fin du contrat : 31/12/2030'), unite('U-9', 'Le contrat expirera le 31/12/2031')];
    const v = val.validateKnowledgeAnswer(sortie('FOUND', [
      constat('FIELD', '31/12/2030', ['U-1'], 'Fin du contrat : 31/12/2030'), constat('FIELD', '31/12/2031', ['U-9'], 'expirera le 31/12/2031'),
    ]), question, deux, norm);
    expect(v.outcome).toBe('CONTRADICTION');
    expect(val.contradictoryTargets(v.findings)).toEqual(['FIELD']);
  });

  it('casse, accents, espaces insécables et apostrophes typographiques n’empêchent pas de retrouver un extrait recopié', () => {
    const v = val.validateKnowledgeAnswer(sortie('CONSTITUENTS', [constat('duration', '22 ANS', ['U-1'], 'la duree est egale a 22 ans')]), question, [unite('U-1', BNP)], norm);
    expect(v.findings.map((f) => f.normalized)).toEqual(['264']);
  });
});

describe('L85F-U03 — formulations différentes pour le même concept : résultat identique côté code', () => {
  it.each([
    ['La durée est égale à 22 ans', '22 ans'],
    ['Vous rembourserez ce financement en vingt-deux années.', 'vingt-deux années'],
    ['Term: 22 years', '22 years'],
    ['Engagement souscrit pour 264 mois au total.', '264 mois'],
  ])('« %s »', (texte, brut) => {
    const v = val.validateKnowledgeAnswer(sortie('CONSTITUENTS', [constat('duration', brut, ['U-1'], texte)]), question, [unite('U-1', texte)], norm);
    expect(v.findings.map((f) => [f.target, f.normalized])).toEqual([['duration', '264']]);
  });
});

describe('L85F-U04 — le code ne dépend d’aucun mot (compréhension = traitement IA)', () => {
  it('même texte : seule la réponse du modèle décide (aucune lecture du vocabulaire par le code)', () => {
    const els = [unite('U-1', BNP)];
    expect(val.validateKnowledgeAnswer(sortie('NOT_FOUND'), question, els, norm).outcome).toBe('NOT_FOUND');
    // Texte sans aucun mot du domaine : le constat validé est retenu à l'identique.
    const neutre = [unite('U-1', 'Le zorglub financier s’étale sur 22 ans')];
    const v = val.validateKnowledgeAnswer(sortie('CONSTITUENTS', [constat('duration', '22 ans', ['U-1'], 's’étale sur 22 ans')]), question, neutre, norm);
    expect(v.findings.map((f) => f.normalized)).toEqual(['264']);
  });

  it('garde : aucune regex métier, aucune liste de formulations dans les modules du lot 85F', () => {
    const racine = join(process.cwd(), 'src/services');
    const fichiers = [
      ...readdirSync(join(racine, 'ai/reconciliation/knowledge-query')).filter((f) => f.endsWith('.ts')).map((f) => join(racine, 'ai/reconciliation/knowledge-query', f)),
      join(racine, 'to-process/document-semantic-knowledge.ts'),
      join(racine, 'coherence/registry/checks/t1-knowledge-consumption.ts'),
    ];
    const VOCABULAIRE = /\bdur[ée]e|[ée]ch[ée]ance|\bmensualit|\bpr[êe]t\b|\bcr[ée]dit|\bemprunt|\brembours|\bfinancement|\bbnp\b|\bloan\b|\bmortgage|fin de contrat|date de fin|\br[ée]siliation|\breconduction|\bpr[ée]avis/i;
    for (const f of fichiers) {
      // Code seul : commentaires et chaînes (descriptions, messages, SQL) retirés.
      const code = readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '""')
        .replace(/(['"])(?:\\.|(?!\1).)*\1/g, '""')
        .replace(/\/\/[^\n]*/g, '');
      expect(code, `${f} : vocabulaire métier dans le code`).not.toMatch(VOCABULAIRE);
      // Littéraux de regex portant un mot (≥ 3 lettres consécutives) : interdits.
      const regex = code.match(/(?<![\w)\]])\/(?![/*\s])(?:\\.|\[(?:\\.|[^\]])*\]|[^/\n])+\/[gimsuy]*/g) ?? [];
      for (const r of regex) expect(r, `${f} : regex ${r}`).not.toMatch(/[a-zA-Zàâçéèêëîïôûùüÿ]{3,}/);
      expect(code, `${f} : new RegExp`).not.toMatch(/new RegExp/);
    }
  });
});

describe('L85F-U05 — contexte borné, ordre neutre, complétude', () => {
  const B = { elementsPerPage: 2, charsPerPage: 10_000, maxPages: 2, charsPerElement: 50, maxLinkedDocuments: 5 };
  it('document cible d’abord, couches dans l’ordre, pages bornées ; au-delà : contexte INCOMPLET (jamais une absence)', () => {
    const lie = { ref: 'D1', fileId: 11, role: 'LINKED' as const, relation: 'SAME_OPERATION' as const, title: null, documentType: null };
    const els: El[] = [unite('U-5', 'lié', { document: 'D1', fileId: 11 }), unite('U-1', 'a'), fait('F-1', 'N°', 'X1'), { ...unite('N-1', ''), layer: 'UNRESOLVED_FACT', value: 'v', text: null }];
    const p = ctxMod.planKnowledgePages(els, [...DOCS, lie], B);
    expect(p.pages.flatMap((x) => x.elements.map((e) => e.ref))).toEqual(['F-1', 'N-1', 'U-1', 'U-5']);
    expect(p.pages.map((x) => [x.index, x.count])).toEqual([[1, 2], [2, 2]]);
    expect(p).toMatchObject({ complete: true, unstructured: 3 });
    const trop = ctxMod.planKnowledgePages([...els, unite('U-6', 'b'), unite('U-7', 'c')], [...DOCS, lie], B);
    expect(trop).toMatchObject({ complete: false, droppedElements: 2 });
    expect(ctxMod.planKnowledgePages([unite('U-1', 'x'.repeat(200))], DOCS, B).cutElements).toBe(1);
  });
  it('faits structurés seuls : aucune connaissance non structurée ; empreinte stable du contexte', () => {
    const p = ctxMod.planKnowledgePages([fait('F-1', 'N°', 'X1')], DOCS, B);
    expect(p.unstructured).toBe(0);
    expect(ctxMod.contextFingerprint(DOCS, p)).toBe(ctxMod.contextFingerprint(DOCS, ctxMod.planKnowledgePages([fait('F-1', 'N°', 'X1')], DOCS, B)));
  });
});

/** Fournisseur simulé et mémoire en mémoire vive. */
function harnais(o: { elements: El[]; available?: boolean; reponses?: Array<unknown | Error>; dailyMax?: number; used?: number; bounds?: import('../context').KnowledgeBounds }) {
  const appels: unknown[] = [];
  const memo = new Map<string, import('../store').StoredKnowledgeQuery>();
  const enregistrements: unknown[] = [];
  let i = 0;
  const deps: import('../service').KnowledgeQueryDeps = {
    capability: async () => ({ available: o.available ?? true, version: 'pv-test', reason: (o.available ?? true) ? 'AVAILABLE' : 'BRANCH_MISSING' }),
    collect: async () => ({ hasExtraction: true, documents: DOCS, elements: o.elements, missing: [] }),
    call: async (c) => {
      appels.push(c);
      const r = (o.reponses ?? [])[Math.min(i, (o.reponses ?? []).length - 1)];
      i += 1;
      if (r instanceof Error) throw r;
      return { output: contrat.T3KnowledgeQueryOutput.parse(r), traceId: `t-${i}` };
    },
    memory: {
      ready: async () => true,
      find: async (k) => memo.get(JSON.stringify(k)) ?? null,
      callsLastDay: async () => o.used ?? 0,
      save: async (r) => {
        enregistrements.push(r);
        const k = JSON.stringify({ accountId: r.accountId, fileId: r.fileId, fieldKey: r.fieldKey, questionFp: r.questionFp, contextFp: r.contextFp, promptVersion: r.promptVersion });
        const prev = memo.get(k);
        memo.set(k, { id: 1, status: r.status, outcome: r.outcome, findings: r.findings, rejected: r.rejected, calls: r.calls, attempts: (prev?.attempts ?? 0) + 1,
          traceIds: r.traceIds, retryAt: r.retryAt ?? null, pagesTotal: r.pagesTotal, pagesExamined: r.pagesExamined });
        return 1;
      },
    },
    now: () => new Date('2026-10-24T10:00:00Z'),
    dailyMax: o.dailyMax ?? 100,
    bounds: o.bounds,
  };
  const interpret = (allowAi = true) => svc.interpretT1Knowledge({ accountId: 1, fileId: 10, rule: RULE, key: 'contractEndDate', trigger: 'T3', allowAi, today: '2026-10-24', deps });
  return { interpret, appels, enregistrements };
}
const BNP_OK = { task: 'KNOWLEDGE_QUERY', outcome: 'CONSTITUENTS', reason: 'durée écrite', findings: [
  constat('duration', '22 ans', ['U-1'], 'La durée est égale à 22 ans'), constat('repayment', 'La durée est égale à 22 ans', ['U-1'], BNP)] };

describe('L85F-U06 — orchestration du niveau 2 (fournisseur IA simulé)', () => {
  it('connaissance structurée seule : rien à interpréter, AUCUN appel IA (« absence » légitime)', async () => {
    const h = harnais({ elements: [fait('F-1', 'N° de contrat', 'AB-12345')] });
    const r = await h.interpret();
    expect(r).toMatchObject({ status: 'NOT_NEEDED', aiCalled: false });
    expect(h.appels).toHaveLength(0);
    expect(svc.semanticallyAbsent(r)).toBe(true);
  });

  it('capacité IA indisponible (branche non livrée) : « interprétation en attente », aucun appel, jamais une absence', async () => {
    const h = harnais({ elements: [unite('U-1', BNP)], available: false });
    const r = await h.interpret();
    expect(r).toMatchObject({ status: 'PENDING', pendingReason: 'CAPABILITY_UNAVAILABLE', aiCalled: false });
    expect(h.appels).toHaveLength(0);
    expect(svc.interpretationPending(r)).toBe(true);
    expect(svc.semanticallyAbsent(r)).toBe(false);
  });

  it('cas BNP : un appel, constats validés et mémorisés ; second passage IDEMPOTENT (aucun rappel)', async () => {
    const h = harnais({ elements: [unite('U-1', BNP)], reponses: [BNP_OK] });
    const r1 = await h.interpret();
    expect(r1).toMatchObject({ status: 'ANSWERED', outcome: 'CONSTITUENTS', aiCalled: true, calls: 1, cached: false });
    expect(r1.citedCoveredUnits).toEqual([{ ref: 'U-1', fileId: 10, sourceUnitId: 'u-1' }]);
    const r2 = await h.interpret();
    expect(r2).toMatchObject({ status: 'ANSWERED', outcome: 'CONSTITUENTS', aiCalled: false, cached: true });
    expect(r2.findings).toEqual(r1.findings);
    expect(h.appels).toHaveLength(1);
  });

  it('aucune information : NOT_FOUND → absence réelle ; contexte tronqué : INCOMPLETE (jamais une absence)', async () => {
    const h = harnais({ elements: [unite('U-1', 'Montant financé : 120 000 €')], reponses: [{ task: 'KNOWLEDGE_QUERY', outcome: 'NOT_FOUND', findings: [], reason: 'rien' }] });
    const r = await h.interpret();
    expect(r.outcome).toBe('NOT_FOUND');
    expect(svc.semanticallyAbsent(r)).toBe(true);
    const t = harnais({
      elements: [unite('U-1', 'a'), unite('U-2', 'b'), unite('U-3', 'c')], reponses: [{ task: 'KNOWLEDGE_QUERY', outcome: 'NOT_FOUND', findings: [], reason: 'rien' }],
      bounds: { elementsPerPage: 1, charsPerPage: 1_000, maxPages: 2, charsPerElement: 100, maxLinkedDocuments: 0 },
    });
    const rt = await t.interpret();
    expect(rt).toMatchObject({ status: 'ANSWERED', outcome: 'INCOMPLETE', calls: 2 });
    expect(svc.interpretationPending(rt)).toBe(true);
  });

  it('écran utilisateur (aucune sollicitation), budget épuisé, panne IA : en attente, jamais une absence ; panne mémorisée avec reprise programmée', async () => {
    expect((await harnais({ elements: [unite('U-1', BNP)], reponses: [BNP_OK] }).interpret(false)).pendingReason).toBe('TRIGGER_NOT_ALLOWED');
    expect((await harnais({ elements: [unite('U-1', BNP)], reponses: [BNP_OK], dailyMax: 5, used: 5 }).interpret()).pendingReason).toBe('BUDGET_EXHAUSTED');
    const h = harnais({ elements: [unite('U-1', BNP)], reponses: [new Error('503 indisponible')] });
    const r = await h.interpret();
    expect(r).toMatchObject({ status: 'PENDING', pendingReason: 'AI_FAILED', aiCalled: true });
    expect(h.enregistrements.at(-1)).toMatchObject({ status: 'AI_FAILED', retryAt: '2026-10-24T11:00:00.000Z' });
    // Reprise programmée non échue : aucun rappel.
    expect((await h.interpret()).pendingReason).toBe('RETRY_SCHEDULED');
    expect(h.appels).toHaveLength(1);
  });

  it('contradiction entre deux pages : détectée après réunion des constats', async () => {
    const h = harnais({
      elements: [unite('U-1', 'Fin du contrat : 31/12/2030'), unite('U-9', 'Le contrat expirera le 31/12/2031')],
      bounds: { elementsPerPage: 1, charsPerPage: 1_000, maxPages: 5, charsPerElement: 200, maxLinkedDocuments: 0 },
      reponses: [
        { task: 'KNOWLEDGE_QUERY', outcome: 'FOUND', reason: 'r', findings: [constat('FIELD', '31/12/2030', ['U-1'], 'Fin du contrat : 31/12/2030')] },
        { task: 'KNOWLEDGE_QUERY', outcome: 'FOUND', reason: 'r', findings: [constat('FIELD', '31/12/2031', ['U-9'], 'expirera le 31/12/2031')] },
      ],
    });
    const r = await h.interpret();
    expect(r).toMatchObject({ outcome: 'CONTRADICTION', contradictions: ['FIELD'], calls: 2 });
  });
});

describe('L85F-U07 — constats → moteur existant : jamais une écriture automatique', () => {
  const resolution = (findings: import('../validate').ValidatedFinding[]): import('../service').SemanticResolution => ({
    status: 'ANSWERED', outcome: 'FOUND', findings, rejected: [], contradictions: val.contradictoryTargets(findings), aiCalled: true, calls: 1, cached: false, traceIds: [],
    promptVersion: 'pv', questionFingerprint: 'q', contextFingerprint: 'c', summary: null, queryId: 1,
  });
  const vf = (target: string, normalized: string | null, p: Partial<import('../validate').ValidatedFinding> = {}): import('../validate').ValidatedFinding => ({
    target, rawValue: normalized ?? 'x', normalized, evidenceRefs: ['U-1'], excerpt: 'extrait', modelConfidence: 'certain', evidenceConfidence: 'certain', meaning: 'm', fileIds: [10], ...p,
  });
  const ident = (v: unknown) => (v === null || v === undefined ? null : String(v));

  it('valeur comprise : proposition SOUS le seuil d’écriture automatique (arbitrage), preuve citée ; contradiction : confiance basse', () => {
    const p = sem.semanticFieldProposals(resolution([vf('FIELD', '2031-06-30')]), ident);
    expect(p).toEqual([{ value: '2031-06-30', label: '2031-06-30', confidence: sem.SEMANTIC_PROPOSAL_CONFIDENCE, evidenceIds: ['t1:U-1'], sourceContext: { label: 'extrait' } }]);
    expect(sem.SEMANTIC_PROPOSAL_CONFIDENCE).toBeLessThan(AI_CONFIDENCE_THRESHOLD);
    const c = sem.semanticFieldProposals(resolution([vf('FIELD', '2030-12-31'), vf('FIELD', '2031-12-31', { evidenceRefs: ['U-9'] })]), ident);
    expect(c.map((x) => x.confidence)).toEqual([sem.SEMANTIC_WEAK_CONFIDENCE, sem.SEMANTIC_WEAK_CONFIDENCE]);
    expect(sem.semanticFieldProposals(resolution([vf('FIELD', '2030-12-31', { modelConfidence: 'probable' })]), ident)[0].confidence).toBe(sem.SEMANTIC_WEAK_CONFIDENCE);
  });

  it('constituants → faits du calcul existant, jamais « fiables » (source distincte de FACTS) ; indice d’échéancier transmis', () => {
    const x = sem.semanticConstituents(resolution([vf('duration', '264', { rawValue: '22 ans' }), vf('repayment', null), vf('start', '2024-03-01')]))!;
    expect(x.duration).toEqual([expect.objectContaining({ value: '22 ans', confidence: 'probable', source: 'T3_SEMANTIC:U-1' })]);
    expect(x.start).toEqual([expect.objectContaining({ value: '2024-03-01', confidence: 'probable' })]);
    expect(x.schedule?.repayment).toHaveLength(1);
    expect(sem.semanticConstituents(resolution([vf('FIELD', '2031-06-30')]))).toBeNull();
  });

  it('calcul déterministe : début + durée compris → date calculée PROBABLE (candidate, jamais écrite) ; durée seule → aucune date inventée', async () => {
    const dv = await import('@/services/to-process/document-derivations');
    const spec = dv.derivationFor('contractEndDate')!;
    const x = sem.semanticConstituents(resolution([vf('duration', '36', { rawValue: '36 mois', excerpt: 'Il est conclu pour une période de 36 mois.' }), vf('start', '2024-03-01', { excerpt: 'Le contrat prend effet le 01/03/2024.' })]))!;
    const r = dv.computeDerivation(spec, x.start!, x.duration!);
    expect(r).toMatchObject({ status: 'CALCULATED_PROBABLE', value: '2027-02-28' });
    const seule = sem.semanticConstituents(resolution([vf('duration', '264', { rawValue: '22 ans' })]))!;
    expect(dv.computeDerivation(spec, seule.start ?? [], seule.duration!)).toMatchObject({ status: 'NOT_DERIVABLE', value: null });
    // L'indice d'échéancier rend la date de fin non nécessaire sans démarche de fin (règle de pertinence existante, lot 76 I).
    expect(dv.endDateNeed({ repaymentSchedule: true, textes: [BNP] }).notNeeded).toBe(true);
  });
});

describe('L85F-U08 — registre IA : opération déclarée, branche facultative, texte attendu de l’équipe IA', () => {
  it('t3_knowledge_query : master T3, TASK=KNOWLEDGE_QUERY, emplacements existants, schéma relié ; inactive tant que la branche manque', async () => {
    const { getOperation } = await import('@/services/ai/registry/operations');
    const loader = await import('@/services/ai/prompts/prompt-loader');
    const { masterOutputSchemaFor } = await import('@/services/ai/gateway/master-output-schemas');
    const { contractFor } = await import('@/services/ai/gateway/output-resolution/contracts');
    const op = getOperation('t3_knowledge_query');
    expect(op).toMatchObject({ task: 'KNOWLEDGE_QUERY', masterPromptCode: 't3_master_v1', outputSchema: 'T3KnowledgeQueryOutput', billable: false, active: true });
    expect(op.promptVariables).toEqual(getOperation('t3_operation_match').promptVariables);
    expect(loader.isOptionalMasterTask('t3_master_v1', 'KNOWLEDGE_QUERY')).toBe(true);
    expect(loader.isMasterTaskTextPending('t3_master_v1', 'KNOWLEDGE_QUERY')).toBe(true);
    expect(masterOutputSchemaFor('T3KnowledgeQueryOutput')).toBe(contrat.T3KnowledgeQueryOutput);
    expect(contractFor('T3KnowledgeQueryOutput')).toMatchObject({ label: 't3_knowledge_query', version: 1 });
    // Aucun prompt modifié : le fichier du dépôt ne porte pas (encore) la branche.
    const texte = readFileSync(join(process.cwd(), 'src/services/ai/prompts/reconciliation/t3_master_v1.txt'), 'utf8');
    expect(loader.inspectMasterTemplate(texte).branches).not.toContain('KNOWLEDGE_QUERY');
  });
});

describe('L85F-U09 — corpus de recette de la branche (prêt pour la livraison de l’équipe IA)', () => {
  it('branche absente du fichier : cas ignorés, corpus vert ; branche présente (version de test) : 6 cas rejoués par l’évaluateur serveur', async () => {
    const { runMasterCorpus } = await import('@/services/ai/governance/master-corpus/runner');
    const { readMasterFileFromRepo } = await import('@/services/ai/governance/master-corpus/cases');
    const [sans] = await runMasterCorpus({ readMasterFile: readMasterFileFromRepo, treatments: ['T3'] });
    expect(sans.status).toBe('PASSED');
    expect(sans.skipped).toEqual(expect.arrayContaining(['P-T3-KQ-01', 'P-T3-KQ-06']));
    const texte = `${readMasterFileFromRepo('t3_master_v1')}\n\nBRANCHE TASK = KNOWLEDGE_QUERY\n\n(section de test)\n`;
    const [avec] = await runMasterCorpus({ readMasterFile: readMasterFileFromRepo, treatments: ['T3'], texts: { t3_master_v1: { text: texte, source: 'config' } } });
    const kq = avec.cases.filter((c) => c.task === 'KNOWLEDGE_QUERY');
    expect(kq.map((c) => c.id).sort()).toEqual(['P-T3-KQ-01', 'P-T3-KQ-02', 'P-T3-KQ-03', 'P-T3-KQ-04', 'P-T3-KQ-05', 'P-T3-KQ-06']);
    expect(kq.filter((c) => !c.passed).map((c) => `${c.id} : ${c.errors.join(' ; ')}`)).toEqual([]);
    expect(avec.branchesPassed).toContain('KNOWLEDGE_QUERY');
  });
});

describe('L85F-U-COH — registre de cohérence', () => {
  it('COH-T1-KNOWLEDGE-CONSUMPTION : actif, après les contrôles existants, contrat du registre respecté, couverture déclarée', async () => {
    const { COHERENCE_REGISTRY, activeChecks, getCheck } = await import('@/services/coherence/registry');
    const ids = COHERENCE_REGISTRY.map((c) => c.id);
    expect(ids.indexOf('COH-T1-KNOWLEDGE-CONSUMPTION')).toBeGreaterThan(ids.indexOf('COH-OPS-RECURRING-SERIES'));
    expect(activeChecks().map((c) => c.id)).toContain('COH-T1-KNOWLEDGE-CONSUMPTION');
    const c = getCheck('COH-T1-KNOWLEDGE-CONSUMPTION')!;
    expect(c).toMatchObject({ status: 'ACTIVE', version: 1, objectType: 'document', chain: ['T1', 'T3', 'PERSISTENCE', 'TO_PROCESS'] });
    expect(c.forbiddenRepairs).toEqual(expect.arrayContaining(['relancer T1', 'interpréter un texte par une règle lexicale']));
    expect(c.anomalies).toEqual(expect.arrayContaining(['CARD_ASKS_KNOWN_INFORMATION', 'FIELD_NOT_IN_T1_WITH_KNOWLEDGE', 'KNOWLEDGE_NOT_INTERPRETED', 'PARTIALLY_STRUCTURED_UNIT', 'OPERATION_CANDIDATE_WITHOUT_T1_EVIDENCE']));
    expect(typeof c.listObjects).toBe('function');
    expect(typeof c.repair).toBe('function');
    const { COVERAGE_INVENTORY } = await import('@/services/coherence/registry/coverage');
    expect(COVERAGE_INVENTORY.find((e) => e.domain === 'a-traiter')!.checks).toContain('COH-T1-KNOWLEDGE-CONSUMPTION');
    // 83B (extract → T1) reste distinct : aucun doublon d'identifiant.
    expect(new Set(ids).size).toBe(ids.length);
  });
});
