/**
 * Lot 111M (ticket « budgets IA », P1 T3) — KNOWLEDGE_QUERY : un élément
 * dont le texte dépasse `charsPerElement` ne peut plus contribuer à une
 * couverture « complète » sans examen de la suite de son texte.
 *
 *  L111M-T3-01  anomalie (reproduite AVANT correction) : élément coupé +
 *               réponse NOT_FOUND ⇒ « information absente » alors que la
 *               valeur figure dans la partie coupée
 *  L111M-T3-02  le texte long est découpé en segments consécutifs (aucune
 *               perte) ; un segment non transmis rend le contexte incomplet
 *  L111M-T3-03  NOT_FOUND interdit tant que des passages restent non examinés
 *  L111M-T3-04  continuation PERSISTANTE et BORNÉE (reprise à la page suivante,
 *               aucune page réexaminée, plafond de pages total)
 *  L111M-T3-05  reprise après une panne IA en cours de continuation
 *  L111M-T3-06  information réellement absente (tout examiné) : NOT_FOUND légitime
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: {} }));

const contrat = await import('../contract');
const ctxMod = await import('../context');
const svc = await import('../service');
const { getRule } = await import('@/services/to-process/rules-catalog');

const RULE = getRule('DATA-CONTRACT-END')!;
type El = import('../contract').KnowledgeElement & { structured?: boolean };
const unite = (ref: string, text: string, p: Partial<El> = {}): El => ({
  ref, document: 'D0', fileId: 10, layer: 'SOURCE_UNIT', kind: 'TEXT_BLOCK', label: null, value: null, text, confidence: 'certain', page: 1,
  covered: true, sourceUnitId: ref.toLowerCase(), ...p,
});
const DOCS: import('../contract').KnowledgeDocument[] = [{ ref: 'D0', fileId: 10, role: 'TARGET', relation: null, title: 'Contrat', documentType: 'FINANCING_CONTRACT' }];
const FIN = 'Le contrat prend fin le 31/12/2030.';
/** Texte long : la clause déterminante est en FIN d'élément, au-delà de 600 caractères. */
const LONG = `${'Conditions générales applicables au présent contrat, sans incidence sur sa durée. '.repeat(12)}${FIN}`;
const NOT_FOUND = { task: 'KNOWLEDGE_QUERY', outcome: 'NOT_FOUND', findings: [], reason: 'rien dans les éléments transmis' };
const FOUND = (ref: string) => ({ task: 'KNOWLEDGE_QUERY', outcome: 'FOUND', reason: 'date écrite', findings: [
  { target: 'FIELD', rawValue: '31/12/2030', evidenceRefs: [ref], excerpt: FIN, confidence: 'certain', meaning: 'fin du contrat' }] });

/**
 * Fournisseur simulé « honnête » : répond FOUND seulement si la clause figure
 * dans le texte RÉELLEMENT transmis sur la page, NOT_FOUND sinon.
 */
function harnais(o: { elements: El[]; bounds?: import('../context').KnowledgeBounds; failAt?: number[] }) {
  const appels: Array<{ refs: string[] }> = [];
  const memo = new Map<string, import('../store').StoredKnowledgeQuery>();
  let n = 0;
  const deps: import('../service').KnowledgeQueryDeps = {
    capability: async () => ({ available: true, version: 'pv-test', reason: 'AVAILABLE' }),
    collect: async () => ({ hasExtraction: true, documents: DOCS, elements: o.elements, missing: [] }),
    call: async (c) => {
      n += 1;
      const page = { elements: (c.variables as { EVIDENCES: Array<{ ref: string; text: string | null }> }).EVIDENCES };
      appels.push({ refs: page.elements.map((e) => e.ref) });
      if (o.failAt?.includes(n)) throw new Error('panne simulée');
      const porteur = page.elements.find((e) => (e.text ?? '').includes(FIN));
      return { output: contrat.T3KnowledgeQueryOutput.parse(porteur ? FOUND(porteur.ref) : NOT_FOUND), traceId: `t-${n}` };
    },
    memory: {
      ready: async () => true,
      find: async (k) => memo.get(JSON.stringify(k)) ?? null,
      callsLastDay: async () => 0,
      save: async (r) => {
        const k = JSON.stringify({ accountId: r.accountId, fileId: r.fileId, fieldKey: r.fieldKey, questionFp: r.questionFp, contextFp: r.contextFp, promptVersion: r.promptVersion });
        const prev = memo.get(k);
        memo.set(k, { id: 1, status: r.status, outcome: r.outcome, findings: r.findings, rejected: r.rejected, calls: r.calls, attempts: (prev?.attempts ?? 0) + 1,
          traceIds: r.traceIds, retryAt: r.retryAt ?? null, pagesTotal: r.pagesTotal, pagesExamined: r.pagesExamined,
          declared: (r.contextSummary as { declared?: string[] }).declared as never });
        return 1;
      },
    },
    now: () => new Date('2026-11-05T10:00:00Z'),
    dailyMax: 100,
    bounds: o.bounds,
  };
  const interpret = () => svc.interpretT1Knowledge({ accountId: 1, fileId: 10, rule: RULE, key: 'contractEndDate', trigger: 'T3', allowAi: true, today: '2026-11-05', deps });
  return { interpret, appels, memo };
}

describe('L111M-T3-01 — anomalie : un élément coupé ne permet plus de conclure à l’absence', () => {
  it('bornes par défaut (600 caractères par élément) : la clause de fin d’élément est transmise et trouvée', async () => {
    const h = harnais({ elements: [unite('U-1', LONG)] });
    const r = await h.interpret();
    // Avant correction : outcome NOT_FOUND, semanticallyAbsent = true (fausse absence).
    expect(r.outcome).toBe('FOUND');
    expect(svc.semanticallyAbsent(r)).toBe(false);
    expect(r.findings[0]?.normalized).toBe('2030-12-31');
  });
});

describe('L111M-T3-02 — segmentation sans perte, couverture vérifiée', () => {
  const B = { elementsPerPage: 80, charsPerPage: 16_000, maxPages: 5, charsPerElement: 600, maxLinkedDocuments: 5 };
  it('texte long : segments consécutifs (avec recouvrement), tout le texte est transmis, aucun élément coupé', () => {
    const p = ctxMod.planKnowledgePages([unite('U-1', LONG)], DOCS, B);
    const segs = p.pages.flatMap((x) => x.elements);
    expect(segs.length).toBeGreaterThan(1);
    expect(segs[0].ref).toBe('U-1');
    expect(segs.slice(1).every((s, i) => s.ref === `U-1#${i + 2}` && s.sourceUnitId === 'u-1' && s.fileId === 10)).toBe(true);
    expect(segs.every((s) => (s.text ?? '').length <= 600)).toBe(true);
    expect(segs.some((s) => (s.text ?? '').includes(FIN))).toBe(true);
    expect(p).toMatchObject({ complete: true, cutElements: 0, droppedElements: 0, segmentedElements: 1 });
  });
  it('segments au-delà du plafond total de pages : contexte INCOMPLET, élément compté comme coupé', () => {
    const p = ctxMod.planKnowledgePages([unite('U-1', LONG)], DOCS, { ...B, elementsPerPage: 1, maxPages: 1, maxContinuationPages: 1 });
    expect(p).toMatchObject({ complete: false, cutElements: 1 });
    expect(p.pages).toHaveLength(1);
  });
  it('élément court : plan IDENTIQUE à l’existant (même empreinte, aucune réinterrogation)', () => {
    const court = [unite('U-1', 'Montant : 1 200 €')];
    const p = ctxMod.planKnowledgePages(court, DOCS, B);
    expect(p.pages.flatMap((x) => x.elements.map((e) => e.ref))).toEqual(['U-1']);
    expect(p.continuationPages).toEqual([]);
    expect(ctxMod.contextFingerprint(DOCS, p)).toBe(ctxMod.contextFingerprint(DOCS, { pages: p.pages, complete: true }));
  });
});

describe('L111M-T3-03/04/05 — continuation persistante et bornée', () => {
  // Une page = 1 élément ; 1 page par passage ; plafond total 20 pages.
  const B = { elementsPerPage: 1, charsPerPage: 16_000, maxPages: 1, charsPerElement: 200, maxLinkedDocuments: 5, maxContinuationPages: 20 };

  it('passage 1 : NOT_FOUND sur la 1re page seulement ⇒ INCOMPLETE (jamais une absence) ; passages suivants : reprise sans réexamen', async () => {
    const h = harnais({ elements: [unite('U-1', LONG)], bounds: B });
    const total = ctxMod.planKnowledgePages([unite('U-1', LONG)], DOCS, B);
    const nbPages = total.pages.length + total.continuationPages.length;
    expect(nbPages).toBeGreaterThan(2);
    const r1 = await h.interpret();
    expect(r1.outcome).toBe('INCOMPLETE');
    expect(svc.semanticallyAbsent(r1)).toBe(false);
    expect(svc.interpretationPending(r1)).toBe(true);
    let r = r1;
    for (let k = 0; k < nbPages && r.outcome === 'INCOMPLETE'; k += 1) r = await h.interpret();
    expect(r.outcome).toBe('FOUND');
    // Chaque page examinée UNE seule fois.
    const vues = h.appels.flatMap((a) => a.refs);
    expect(new Set(vues).size).toBe(vues.length);
    expect(h.appels.length).toBe(nbPages);
    // Mémoire : réponse définitive, plus aucun appel.
    const avant = h.appels.length;
    const r9 = await h.interpret();
    expect(r9).toMatchObject({ outcome: 'FOUND', cached: true, aiCalled: false });
    expect(h.appels.length).toBe(avant);
  });

  it('plafond total atteint avant la fin : INCOMPLETE définitif et explicite, jamais NOT_FOUND', async () => {
    const h = harnais({ elements: [unite('U-1', LONG)], bounds: { ...B, maxContinuationPages: 2 } });
    let r = await h.interpret();
    r = await h.interpret();
    r = await h.interpret();
    expect(r.outcome).toBe('INCOMPLETE');
    expect(r.summary?.complete).toBe(false);
    expect(h.appels.length).toBe(2);
  });

  it('panne IA en cours de continuation : progression conservée, reprise à la page interrompue', async () => {
    const h = harnais({ elements: [unite('U-1', LONG)], bounds: { ...B, maxPages: 3 }, failAt: [2] });
    const r1 = await h.interpret();
    expect(r1).toMatchObject({ status: 'PENDING', pendingReason: 'AI_FAILED' });
    const [m] = [...h.memo.values()];
    expect(m.pagesExamined).toBe(1);
    // Délai de nouvelle tentative écoulé.
    m.retryAt = null;
    let r = await h.interpret();
    for (let k = 0; k < 10 && r.outcome === 'INCOMPLETE'; k += 1) r = await h.interpret();
    expect(r.outcome).toBe('FOUND');
    const vues = h.appels.flatMap((a) => a.refs);
    // La page en panne est rejouée une fois, la première jamais.
    expect(vues.filter((x) => x === 'U-1')).toHaveLength(1);
  });
});

describe('L111M-T3-06 — information réellement absente', () => {
  it('tout le texte examiné, rien trouvé : NOT_FOUND légitime', async () => {
    const h = harnais({ elements: [unite('U-1', LONG.replace(FIN, 'Aucune date de fin.'))] });
    const r = await h.interpret();
    expect(r.outcome).toBe('NOT_FOUND');
    expect(r.summary).toMatchObject({ complete: true, cut: 0 });
    expect(svc.semanticallyAbsent(r)).toBe(true);
  });
});
