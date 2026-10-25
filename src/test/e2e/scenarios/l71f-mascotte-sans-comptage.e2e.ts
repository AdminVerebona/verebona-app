/**
 * Lot 71F — mascotte : plus AUCUNE introduction de comptage (« Un sujet
 * mérite votre attention aujourd'hui : … », « Deux sujets nécessitent… »),
 * sur PostgreSQL réel : présentation servie par `getMascotPresentation`
 * (chemin de l'API `/api/home/mascot`), IA simulée, cache T6 réel.
 */
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { useTargetState } from '../chain';
import { activerContratQuestions } from '../t6-suggestions-v3';

/** IA simulée : FORMULATE rend le texte de secours, précédé (ou non) d'une introduction de comptage. */
const modele = vi.hoisted(() => ({ prefixe: '' as string, formulate: 0 }));

function provider() {
  return {
    name: 'simule-l71f',
    isConfigured: () => true,
    async call(input: { prompt: string }) {
      const mode = /^MODE = (\w+)$/m.exec(input.prompt)?.[1];
      if (mode === 'EVALUATE') {
        const ctx = JSON.parse(/Candidats à évaluer : (.*)\n/.exec(input.prompt)![1]) as { candidates: Array<{ subjectId: string; evidence: Array<{ ref: string }> }> };
        return {
          rawText: JSON.stringify({
            schemaVersion: 't6-evaluation-v1',
            decisions: ctx.candidates.map((c) => ({
              subjectId: c.subjectId, decision: 'SUPPRESS', category: 'INFORMATION', reasonCode: 'NO_ACTION_REQUIRED',
              reason: 'Échéance connue et suivie : aucune démarche à engager.', expectedAction: null, actionDeadline: null,
              suggestedReviewAt: null, priorityHint: null, uncertainties: [], evidenceRefs: [c.evidence[0]?.ref],
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
          messages: entree.subjects.map((s) => ({ subjectId: s.subjectId, text: `${modele.prefixe}${s.fallbackText}`, highlight: null })),
          suggestions: [],
        }),
        inputTokens: 100, outputTokens: 30,
      };
    },
  };
}

const INTRO = /sujets? (mérite|nécessite)|votre attention/i;

scenario('L71F-MASC', 'Lot 71F — mascotte sans introduction de comptage (PG16)', ({ sql, make }) => {
  useTargetState({}, { masters: ['T1', 'T2'] });
  beforeAll(async () => {
    const { setAiProvider } = await import('@/services/ai/gateway/providers');
    setAiProvider(provider() as never);
  });
  beforeEach(async () => {
    modele.prefixe = '';
    modele.formulate = 0;
    const r = await import('@/services/home/mascot/t6-runner');
    r.resetT6Breaker();
    r.resetT6EvaluationState();
    (await import('@/services/home/mascot/mascot.service')).cancelPendingPregenerations();
  });
  afterEach(async () => { (await import('@/services/home/mascot/mascot.service')).cancelPendingPregenerations(); await activerContratQuestions(false); });

  const svc = () => import('@/services/home/mascot/mascot.service');
  const B = () => import('@/services/home/mascot/bubble');
  const pregen = async (accountId: number) => (await svc()).getMascotPresentation(accountId, 'pregen', null);

  /** Bulle visible (en-tête + blocs + cartes), telle que MascotSpeaks la compose. */
  async function bulle(p: import('@/services/home/mascot/types').MascotPresentation) {
    const b = await B();
    return {
      entete: b.bubbleLead({ presentation: p, empty: false }).text,
      blocs: b.subjectBlocks(p).map((x) => x.text),
      cartes: b.homeItems(p, false).map((x) => x.kind),
      complet: b.composeSpeech({ presentation: p, empty: false }).text,
    };
  }

  const v0 = (p: import('@/services/home/mascot/types').MascotPresentation) => p.paragraphs.filter((x) => x.sourceCode !== 'CLEAR').map((x) => x.text);

  it('L71F-E2E-01 — scénario de la capture : bien « garage », aucun document, ONB-DOC — instruction directe, aucun en-tête', async () => {
    const a = await make.account({ plan: 'premium' });
    await make.asset(a, { name: 'garage' });
    const p = await pregen(a.id);
    const v = await bulle(p);
    expect(p.paragraphs.map((x) => x.sourceCode)).toContain('ONB-DOC');
    expect(v.entete).toBe('');
    expect(v.blocs).toEqual(['Ajoutez votre premier document pour garage : une facture, un contrat ou une garantie.']);
    expect(v.complet).not.toMatch(INTRO);
    const onb = (await B()).subjectBlocks(p)[0];
    expect(onb.actions[0]).toMatchObject({ label: 'Déposer un document', primary: true });
    expect(onb.actions[0].action.target).toMatchObject({ kind: 'upload_document' });
  });

  it('L71F-E2E-02 — sortie IA porteuse d’une introduction (sans accent, apostrophe droite) : jamais affichée ni mise en cache', async () => {
    const a = await make.account({ plan: 'premium' });
    await make.asset(a, { name: 'garage' });
    modele.prefixe = "Un sujet merite votre attention aujourd'hui : ";
    const p = await pregen(a.id);
    expect(modele.formulate).toBeGreaterThan(0); // la sortie IA a bien été produite… puis rejetée
    expect(v0(p)).toEqual(['Ajoutez votre premier document pour garage : une facture, un contrat ou une garantie.']);
    const v = await bulle(p);
    expect(v.entete).not.toMatch(INTRO);
    expect(v.blocs.join(' ')).not.toMatch(INTRO);
    expect(v.complet).not.toMatch(/merite|mérite|votre attention/i);
    const cache = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM home_mascot_cache WHERE account_id = ${a.id} AND messages::text ILIKE '%attention%'`;
    expect(cache[0].n).toBe(0);
  });

  it('L71F-E2E-03 — entrée de cache historique porteuse d’une introduction : non servie, SUPPRIMÉE, renouvelée proprement', async () => {
    // Lot 87C : prompt porteur des questions (version simulée du contrat t6-suggestions-v3) — sans lui,
    // aucune question n'est demandée et la bulle inchangée reprend ses textes figés (R8) sans appel.
    await activerContratQuestions(true);
    const a = await make.account({ plan: 'premium' });
    await make.asset(a, { name: 'garage' });
    // 1) génération saine, mise en cache.
    await pregen(a.id);
    const avant = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM home_mascot_cache WHERE account_id = ${a.id} AND jsonb_array_length(messages) > 0`;
    expect(avant[0].n).toBeGreaterThan(0);
    // 2) ancienne formulation (avant lot 68) réinjectée telle qu'en préproduction.
    await sql`UPDATE home_mascot_cache SET messages = (
                SELECT jsonb_agg(jsonb_set(m, '{text}', to_jsonb('Deux sujets méritent votre attention aujourd’hui : ' || (m->>'text'))))
                  FROM jsonb_array_elements(messages) m)
              WHERE account_id = ${a.id} AND jsonb_array_length(messages) > 0`;
    const injecte = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM home_mascot_cache WHERE account_id = ${a.id} AND messages::text ILIKE '%attention%'`;
    expect(injecte[0].n).toBeGreaterThan(0);
    const n0 = modele.formulate;
    const p = await pregen(a.id);
    const v = await bulle(p);
    expect(v.complet).not.toMatch(INTRO);
    expect(v.blocs.join(' ')).not.toMatch(INTRO);
    // L'entrée fautive est supprimée puis renouvelée (nouvel appel), sans introduction.
    expect(modele.formulate).toBeGreaterThan(n0);
    const restant = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM home_mascot_cache WHERE account_id = ${a.id} AND messages::text ILIKE '%attention%'`;
    expect(restant[0].n).toBe(0);
  });

  it('L71F-E2E-04 — un « À traiter » DO_FIRST : carte directe, aucun en-tête de comptage', async () => {
    const a = await make.account({ plan: 'premium' });
    const maison = await make.asset(a, { category: 'LOGEMENT', name: 'Maison Lilas' });
    await sql`UPDATE assets SET status = 'EN_SERVICE' WHERE id = ${maison.id}`;
    await sql`INSERT INTO to_process_actions (account_id, target_type, target_id, field_key, action_kind, rule_code, question, priority)
              VALUES (${a.id}, 'ASSET', ${maison.id}, 'purchasePriceCents', 'COMPLETE', 'DATA-ACQUISITION-PRICE', 'Prix d’achat ?', 'DO_FIRST')`;
    const p = await pregen(a.id);
    const v = await bulle(p);
    expect(v.cartes).toContain('todo');
    expect(v.entete).toBe('');
    expect(v.complet).not.toMatch(INTRO);
    expect(v.complet).not.toMatch(/Rien de particulier/);
  });
});
