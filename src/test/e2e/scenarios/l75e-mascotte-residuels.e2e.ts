/**
 * Lot 75E — BUG P1 « Mascotte : écarts résiduels du lot 71F » sur
 * PostgreSQL 16 réel : présentation servie par `getMascotPresentation`
 * (chemin de l'API `/api/home/mascot`), IA simulée, cache T6 réel.
 *
 *  L75E-MASC-E2E-01  sortie IA « Voici deux sujets importants : … » : rejetée,
 *                    jamais mise en cache ; texte de secours intégral ; révision publiée
 *  L75E-MASC-E2E-02  sortie IA « …, ajoutez votre premier document » (virgule) :
 *                    rejetée, l'instruction complète reste affichée
 *  L75E-MASC-E2E-03  cache historique porteur d'une variante : supprimé, renouvelé
 *  L75E-MASC-E2E-04  formulation T6 valide : servie, son secours l'accompagne ;
 *                    échéances T6 : dates conservées, aucun bloc vide
 */
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { useTargetState } from '../chain';

const modele = vi.hoisted(() => ({ texte: (fallback: string) => fallback, formulate: 0 }));

function provider() {
  return {
    name: 'simule-l75e-masc',
    isConfigured: () => true,
    async call(input: { prompt: string }) {
      const mode = /^MODE = (\w+)$/m.exec(input.prompt)?.[1];
      if (mode === 'EVALUATE') {
        const ctx = JSON.parse(/Candidats à évaluer : (.*)\n/.exec(input.prompt)![1]) as { candidates: Array<{ subjectId: string; evidence: Array<{ ref: string }> }> };
        return {
          rawText: JSON.stringify({
            schemaVersion: 't6-evaluation-v1',
            decisions: ctx.candidates.map((c) => ({
              subjectId: c.subjectId, decision: 'SHOW_NOW', category: 'ACTION_NOW', reasonCode: 'ACTION_REQUIRED_SOON',
              reason: 'Une démarche est nécessaire à court terme.', expectedAction: 'Prendre rendez-vous avec le prestataire', actionDeadline: null,
              suggestedReviewAt: null, priorityHint: 'MEDIUM', uncertainties: [], evidenceRefs: [c.evidence.find((e) => e.ref.endsWith('.dueDate'))?.ref ?? c.evidence[0].ref],
            })),
          }),
          inputTokens: 100, outputTokens: 30,
        };
      }
      if (mode !== 'FORMULATE') throw new Error('appel inattendu');
      modele.formulate++;
      const entree = JSON.parse(/Entrée structurée : (.*)\n/.exec(input.prompt)![1]) as { subjects: Array<{ subjectId: string; fallbackText: string }> };
      return {
        rawText: JSON.stringify({
          schemaVersion: 't6-output-v2',
          messages: entree.subjects.map((s) => ({ subjectId: s.subjectId, text: modele.texte(s.fallbackText), highlight: null })),
          suggestions: [],
        }),
        inputTokens: 100, outputTokens: 30,
      };
    },
  };
}

const INTRO = /sujets? (importants?|m[ée]rit|n[ée]cessit)|votre attention|^voici/i;
const ONB = 'Ajoutez votre premier document pour garage : une facture, un contrat ou une garantie.';

scenario('L75E-MASC', 'Lot 75E — mascotte : classificateur unique, aucun bloc vide (PG16)', ({ sql, make }) => {
  useTargetState({}, { masters: ['T1', 'T2'] });
  beforeAll(async () => {
    const { setAiProvider } = await import('@/services/ai/gateway/providers');
    setAiProvider(provider() as never);
  });
  beforeEach(async () => {
    modele.texte = (f) => f;
    modele.formulate = 0;
    const r = await import('@/services/home/mascot/t6-runner');
    r.resetT6Breaker();
    r.resetT6EvaluationState();
    (await import('@/services/home/mascot/mascot.service')).cancelPendingPregenerations();
  });
  afterEach(async () => { (await import('@/services/home/mascot/mascot.service')).cancelPendingPregenerations(); });

  const svc = () => import('@/services/home/mascot/mascot.service');
  const B = () => import('@/services/home/mascot/bubble');
  const pregen = async (accountId: number) => (await svc()).getMascotPresentation(accountId, 'pregen', null);
  const blocs = async (p: import('@/services/home/mascot/types').MascotPresentation) => (await B()).subjectBlocks(p).map((x) => x.text);
  const cacheAvec = async (accountId: number, motif: string) =>
    (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM home_mascot_cache WHERE account_id = ${accountId} AND messages::text ILIKE ${motif}`)[0].n;

  async function garage() {
    const a = await make.account({ plan: 'premium' });
    await make.asset(a, { name: 'garage' });
    return a;
  }

  it('L75E-MASC-E2E-01 — sortie IA « Voici deux sujets importants : … » : rejetée, jamais en cache ; secours intégral ; révision publiée', async () => {
    const a = await garage();
    modele.texte = (f) => `Voici deux sujets importants : ${f.charAt(0).toLowerCase()}${f.slice(1)}`;
    const p = await pregen(a.id);
    expect(modele.formulate).toBeGreaterThan(0);
    expect(await blocs(p)).toEqual([ONB]);
    expect((await B()).composeSpeech({ presentation: p, empty: false }).text).not.toMatch(INTRO);
    expect(p.presentationRevision).toBe((await import('@/services/home/mascot/types')).MASCOT_PRESENTATION_REVISION);
    expect(await cacheAvec(a.id, '%importants%')).toBe(0);
  });

  it('L75E-MASC-E2E-02 — sortie IA avec virgule : rejetée, l’instruction complète reste affichée (aucune perte)', async () => {
    const a = await garage();
    modele.texte = (f) => `Un sujet mérite votre attention aujourd’hui, ${f.charAt(0).toLowerCase()}${f.slice(1)}`;
    const p = await pregen(a.id);
    expect(await blocs(p)).toEqual([ONB]);
    expect(await cacheAvec(a.id, '%attention%')).toBe(0);
  });

  it('L75E-MASC-E2E-03 — cache historique porteur d’une variante (« Il y a deux sujets pour vous aujourd’hui, … ») : supprimé, renouvelé', async () => {
    const a = await garage();
    await pregen(a.id);
    await sql`UPDATE home_mascot_cache SET messages = (
                SELECT jsonb_agg(jsonb_set(m, '{text}', to_jsonb('Il y a deux sujets pour vous aujourd’hui, ' || (m->>'text'))))
                  FROM jsonb_array_elements(messages) m)
              WHERE account_id = ${a.id} AND jsonb_array_length(messages) > 0`;
    expect(await cacheAvec(a.id, '%deux sujets pour vous%')).toBeGreaterThan(0);
    const n0 = modele.formulate;
    const p = await pregen(a.id);
    expect(await blocs(p)).toEqual([ONB]);
    expect(modele.formulate).toBeGreaterThan(n0);
    expect(await cacheAvec(a.id, '%deux sujets pour vous%')).toBe(0);
  });

  it('L75E-MASC-E2E-04 — formulation T6 valide servie avec son secours ; échéances T6 : dates conservées, aucun bloc vide', async () => {
    const a = await make.account({ plan: 'premium' });
    const maison = await make.asset(a, { category: 'LOGEMENT', name: 'Maison Lilas' });
    await sql`UPDATE assets SET status = 'EN_SERVICE' WHERE id = ${maison.id}`;
    await make.assetFile(a as never, { assetId: maison.id }); // compte documenté : aucun sujet d'accueil
    const { dansJours } = await import('../t6-assessment');
    for (const [titre, n] of [['Ramonage cheminée', 12], ['Révision chaudière', 20]] as const) {
      const e = await make.agendaItem(a as never, { title: titre, startDate: dansJours(n), assetIds: [maison.id] });
      await sql`UPDATE agenda_items SET home_category = 'action' WHERE id = ${e.id}`;
    }
    modele.texte = (f) => `Pensez-y : ${f}`;
    await pregen(a.id); // évaluation (IA simulée)
    const p = await pregen(a.id);
    const textes = await blocs(p);
    expect(textes).toHaveLength(2);
    for (const t of textes) {
      expect(t.trim()).not.toBe('');
      expect(t).not.toMatch(INTRO);
      expect(t).toMatch(/\d{4}/); // la date reste dite
    }
    const t6 = p.paragraphs.filter((x) => x.text.startsWith('Pensez-y'));
    expect(t6.length).toBeGreaterThan(0);
    for (const x of t6) expect(x.fallbackText && x.text.endsWith(x.fallbackText)).toBe(true);
  });
});
