/**
 * Lot 106B — ticket « Mascotte — réparer les suggestions existantes et ajouter
 * des invitations de découverte » — de bout en bout sur PostgreSQL 16 réel :
 * vrai collecteur, vraie mascotte (`getMascotPresentation`), vraie passerelle
 * IA, vrai T2. Modèle SIMULÉ (aucun réseau). Aucun prompt du dépôt modifié :
 * le prompt T6 « compatible » est le texte LIVRÉ auquel on applique les blocs
 * OFFICIELS du guide du PO (étapes 3 et 13), activé comme une version BO.
 *
 *  L106B-E2E-01  prompt livré (cause démontrée) : aucune question, aucun
 *                contexte de questions transmis ; invitations du catalogue
 *                éditorial ; diagnostic BO PROMPT_INCOMPATIBLE ;
 *  L106B-E2E-02  compte vide : invitations sans preuve fictive, aucun appel
 *                IA pour elles, aucun bien créé ;
 *  L106B-E2E-03  compte « logement seul » (sans échéance ni priorité), prompt
 *                compatible : question personnalisée + invitation VÉHICULE
 *                rédigée par T6 ; affichage suivant servi par le cache ;
 *  L106B-E2E-04  affirmation personnalisée injustifiée et preuve fictive
 *                rejetées (motifs), catalogue en relais, bulle intacte ;
 *  L106B-E2E-05  clics : question → T2 répond (sources du compte) ;
 *                invitation → formulaire d'ajout sans bien, aucun bien créé ;
 *  L106B-E2E-06  « Autre suggestion » : renouvellement SANS appel IA, jamais
 *                la suggestion passée ; aucune tâche « À traiter » ;
 *  L106B-E2E-07  cache ancien / neuf : entrée v3 servie tant que le prompt ne
 *                change pas ; nouveau contrat → nouvelle génération unique ;
 *  L106B-E2E-08  IA en erreur : accueil utilisable, invitations du catalogue,
 *                aucune relance à l'affichage suivant ; diagnostic AI_ERROR ;
 *  L106B-E2E-09  isolation : suggestions passées propres à l'utilisateur et
 *                au compte ; contexte et cache cloisonnés ;
 *  L106B-E2E-10  Standard comme Premium ; compte non éligible : aucune
 *                invitation, aucun appel IA.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { demander, useTargetState } from '../chain';
import { fondee } from '../t6-suggestions-v3';

vi.mock('@/lib/asset-quota-guard', () => ({ assetModificationDecision: async () => ({ allowed: true }) }));

type Compte = { id: number; ownerUserId: number };
type Q = Record<string, unknown>;
type P = import('@/services/home/mascot/types').MascotPresentation;

const modele = vi.hoisted(() => ({
  t6Prompts: [] as string[],
  suggestions: (_ctx: Record<string, unknown>): Q[] => [],
  t6Down: false,
}));

function provider() {
  return {
    name: 'simule-l106b',
    isConfigured: () => true,
    async call(input: { task?: string; prompt: string }) {
      if (/^MODE = EVALUATE$/m.test(input.prompt)) {
        const ctx = JSON.parse(/Candidats à évaluer : (.*)\n/.exec(input.prompt)![1]) as { candidates: Array<{ subjectId: string }> };
        return {
          rawText: JSON.stringify({ schemaVersion: 't6-evaluation-v1', decisions: ctx.candidates.map((c) => ({
            subjectId: c.subjectId, decision: 'SUPPRESS', category: 'INFORMATION', reasonCode: 'NO_ACTION_REQUIRED',
            reason: 'Échéance connue et suivie dans l’agenda.', expectedAction: null, actionDeadline: null, suggestedReviewAt: null,
            priorityHint: null, evidenceRefs: [`${c.subjectId}.title`], uncertainties: [],
          })) }),
          inputTokens: 100, outputTokens: 20,
        };
      }
      if (/^MODE = FORMULATE$/m.test(input.prompt)) {
        modele.t6Prompts.push(input.prompt);
        if (modele.t6Down) throw new Error('T6 indisponible (simulation)');
        const entree = JSON.parse(/Entrée structurée : (.*)\n/.exec(input.prompt)![1]) as { subjects: Array<{ subjectId: string; fallbackText: string }> };
        const ctx = JSON.parse(/Contexte des questions suggérées : (.*)\n/.exec(input.prompt)?.[1] ?? 'null') as Record<string, unknown> | null;
        return {
          rawText: JSON.stringify({
            schemaVersion: 't6-output-v2',
            messages: entree.subjects.map((s) => ({ subjectId: s.subjectId, text: s.fallbackText, highlight: null })),
            suggestions: ctx ? modele.suggestions(ctx) : [],
          }),
          inputTokens: 200, outputTokens: 40,
        };
      }
      if (input.task === 'ANSWER') {
        const ids = [...new Set(input.prompt.match(/\b(?:document|agenda_item|asset|help)_[A-Za-z0-9_-]+\b/g) ?? [])];
        return {
          rawText: JSON.stringify({ mode: 'ANSWER', format: 'claims', status: 'answered', claims: [{ text: 'Voici ce que j’ai trouvé.', sourceIds: ids.slice(0, 1), derivation: 'direct', factual: true }] }),
          inputTokens: 100, outputTokens: 20,
        };
      }
      return {
        rawText: JSON.stringify({ mode: 'UNDERSTAND', confidence: 'low', intent: 'UNKNOWN', requestedTopics: [], filters: {}, entityHints: [], requestedFacts: [], reason: 'simulé' }),
        inputTokens: 50, outputTokens: 10,
      };
    },
  };
}

// ── Prompt T6 : texte livré + blocs OFFICIELS du guide (comme le PO) ────────

const LIVRE = readFileSync(join(process.cwd(), 'src/services/ai/prompts/mascot/t6_master_v1.txt'), 'utf8');
async function promptAvec(etapes: Array<'t6-suggestions-v3' | 't6-discovery-v1'>): Promise<string> {
  const { parseGuideBlocks } = await import('@/services/ai/prompt-conformity/guide-blocks');
  const blocs = parseGuideBlocks(readFileSync(join(process.cwd(), 'docs/exploitation/prompts-a-appliquer-par-le-po.md'), 'utf8'));
  let t = LIVRE;
  for (const id of etapes) {
    const b = blocs.find((x) => x.id === id)!;
    if (b.action === 'insert-before') t = t.replace(b.anchor!, `${b.text}\n\n${b.anchor}`);
    else t = `${t.slice(0, t.indexOf(b.from!))}${b.text}\n\n${t.slice(t.indexOf(b.to!))}`;
  }
  return t;
}
/** Version BO active du prompt T6 (null : aucune, fichier du dépôt). */
async function activerT6(etapes: Array<'t6-suggestions-v3' | 't6-discovery-v1'> | null, id = 10601): Promise<void> {
  const rt = await import('@/services/ai/master-prompts/master-prompt-runtime');
  rt.__setActiveMasterPromptsForTests(etapes ? [{ id, treatment: 'T6' as never, versionNumber: id, content: await promptAvec(etapes) }] : null);
}

const VOITURE = { kind: 'DISCOVERY', universe: 'VEHICLE', documentKind: 'INVOICE', text: 'Ajoutez une facture d’entretien automobile pour retrouver les interventions et leur coût.' };

scenario('L106B-SUGG', 'Lot 106B — suggestions de la mascotte réparées, invitations de découverte', ({ sql, make }) => {
  useTargetState({}, { masters: ['T1', 'T2'] });
  beforeAll(async () => {
    const { setAiProvider } = await import('@/services/ai/gateway/providers');
    setAiProvider(provider() as never);
  });
  beforeEach(async () => {
    modele.t6Prompts.length = 0;
    modele.t6Down = false;
    modele.suggestions = () => [];
    const r = await import('@/services/home/mascot/t6-runner');
    r.resetT6Breaker(); r.resetT6EvaluationState(); r.resetT6RecentFailures();
    (await import('@/services/home/mascot/mascot.service')).cancelPendingPregenerations();
    await activerT6(null);
  });
  afterEach(async () => {
    (await import('@/services/home/mascot/mascot.service')).cancelPendingPregenerations();
    await activerT6(null);
  });

  const svc = () => import('@/services/home/mascot/mascot.service');
  const compte = async (plan: 'standard' | 'premium' = 'premium'): Promise<Compte> => {
    const a = await make.account({ plan });
    return { id: a.id, ownerUserId: a.ownerUserId };
  };
  /** Compte « logement seul » : une maison, un document analysé, aucune échéance, aucune priorité. */
  async function logementSeul(plan: 'standard' | 'premium' = 'premium', nom = 'Maison Lilas') {
    const c = await compte(plan);
    const maison = await make.asset(c as never, { category: 'LOGEMENT', name: nom });
    await sql`UPDATE assets SET status = 'EN_SERVICE' WHERE id = ${maison.id}`;
    const f = await make.assetFile(c as never, { assetId: maison.id });
    await sql`UPDATE asset_files SET retained_title = 'Facture chaudière', original_filename = 'facture.pdf', analysis_state = 'ANALYZED' WHERE id = ${f.id}`;
    return { c, maison: maison.id };
  }
  const questionsDe = (p: P) => p.secondaries.filter((s) => s.action.target.kind === 'ask').map((s) => s.action.label);
  const invitationsDe = (p: P) => p.discovery?.invitations ?? [];
  const slots = async (p: P, empty = false, hidden?: Set<string>) => (await import('@/services/home/mascot/bubble')).homeSuggestionSlots(p, empty, [], hidden);
  const contexteDu = (prompt: string) => JSON.parse(/Contexte des questions suggérées : (.*)\n/.exec(prompt)![1]);
  /** Dernier diagnostic « Suggestions de l'accueil » écrit au rapport T6 du compte (écriture en arrière-plan). */
  const diagnostic = (accountId: number, attendu: string) => vi.waitFor(async () => {
    const r = await sql<Array<{ reason_code: string; value: Record<string, unknown> }>>`
      SELECT e.reason_code, e.value FROM ai_execution_report_entries e
       WHERE e.account_id = ${accountId} AND e.field_key = 'home_suggestions' ORDER BY e.report_id DESC, e.seq DESC LIMIT 1`;
    if (r[0]?.reason_code !== attendu) throw new Error(`diagnostic ${r[0]?.reason_code ?? 'absent'} ≠ ${attendu}`);
    return r[0];
  }, { timeout: 5_000 });

  it('L106B-E2E-01 — prompt livré : aucune question (cause démontrée), invitations du catalogue, diagnostic PROMPT_INCOMPATIBLE', async () => {
    const { c } = await logementSeul();
    modele.suggestions = (ctx) => [fondee(ctx, 'Quels sont mes documents ?', ['ACC.DOCUMENTS'])];
    const p = await (await svc()).getMascotPresentation(c.id, 'pregen', c.ownerUserId);
    // Aucun contexte de questions transmis à T6 (AC10 du lot 87C) : aucune question.
    for (const prompt of modele.t6Prompts) expect(/Contexte des questions suggérées : null\n/.test(prompt)).toBe(true);
    expect(questionsDe(p)).toEqual([]);
    // L'accueil n'est plus vide : invitations du catalogue éditorial (sans IA).
    const inv = invitationsDe(p);
    expect(inv.length).toBeGreaterThanOrEqual(2);
    expect(inv.every((x) => x.origin === 'CATALOG')).toBe(true);
    const s = await slots(p);
    expect(s.map((x) => x.kind)).toEqual(['invitation', 'invitation']);
    expect(s[0].kind === 'invitation' && s[1].kind === 'invitation' && s[0].invitation.universe !== s[1].invitation.universe).toBe(true);
    const d = await diagnostic(c.id, 'PROMPT_INCOMPATIBLE');
    expect(d.value).toMatchObject({ promptGrounds: false, promptDiscovery: false, invitationSource: 'CATALOG' });
  });

  it('L106B-E2E-02 — compte vide : invitations sans preuve fictive, aucun appel IA pour elles, aucun bien créé', async () => {
    await activerT6(['t6-suggestions-v3', 't6-discovery-v1']);
    const c = await compte();
    const p = await (await svc()).getMascotPresentation(c.id, 'pregen', c.ownerUserId);
    // Aucun contexte de questions (compte vide) : T6 ne reçoit jamais de section découverte.
    for (const prompt of modele.t6Prompts) expect(prompt).toMatch(/Contexte des questions suggérées : null\n/);
    expect(invitationsDe(p).length).toBeGreaterThanOrEqual(2);
    expect(invitationsDe(p).every((x) => x.origin === 'CATALOG')).toBe(true);
    expect((await slots(p, true)).map((x) => x.kind)).toEqual(['invitation', 'invitation']);
    const [{ n }] = await sql<[{ n: number }]>`SELECT count(*)::int AS n FROM assets WHERE account_id = ${c.id}`;
    expect(n).toBe(0);
    await diagnostic(c.id, 'NO_ACCOUNT_CONTEXT');
  });

  it('L106B-E2E-03 — logement seul, sans échéance ni priorité, prompt compatible : question + invitation VÉHICULE de T6 ; cache ensuite', async () => {
    await activerT6(['t6-suggestions-v3', 't6-discovery-v1']);
    const { c } = await logementSeul();
    modele.suggestions = (ctx) => [fondee(ctx, 'Quels sont les documents de Maison Lilas ?', ['A1', 'A1.DOCS'], { assetRef: 'A1' }), VOITURE];
    const { getMascotPresentation } = await svc();
    const p = await getMascotPresentation(c.id, 'pregen', c.ownerUserId);
    expect(modele.t6Prompts).toHaveLength(1);
    const ctx = contexteDu(modele.t6Prompts[0]);
    expect(ctx.discovery).toMatchObject({ contract: 't6-discovery-v1', max: 2 });
    expect(ctx.nextDeadlines).toEqual([]);
    // Aucune échéance ni priorité : les suggestions ne disparaissent pas pour ce seul motif.
    expect(questionsDe(p)).toEqual(['Quels sont les documents de Maison Lilas ?']);
    expect(invitationsDe(p)[0]).toMatchObject({ key: 'DISC:VEHICLE:INVOICE', origin: 'AI', cta: 'Ajouter une facture' });
    const s = await slots(p);
    expect(s.map((x) => x.kind)).toEqual(['question', 'invitation']);
    expect(s[1].kind === 'invitation' && s[1].invitation.universe).toBe('VEHICLE');
    // Affichage suivant : cache, aucun nouvel appel, mêmes suggestions.
    const d = await getMascotPresentation(c.id, 'display', c.ownerUserId);
    expect(modele.t6Prompts).toHaveLength(1);
    expect(questionsDe(d)).toEqual(questionsDe(p));
    expect(invitationsDe(d)[0].key).toBe('DISC:VEHICLE:INVOICE');
    const [cache] = await sql<[{ s: Array<Record<string, unknown>> }]>`SELECT suggestions AS s FROM home_mascot_cache WHERE account_id = ${c.id} AND jsonb_typeof(suggestions) = 'array'`;
    expect(cache.s.map((x) => x.kind ?? 'QUESTION')).toEqual(['QUESTION', 'DISCOVERY']);
    expect(cache.s[1]).not.toHaveProperty('groundRefs');
    const r = await diagnostic(c.id, 'OK');
    expect(r.value).toMatchObject({ promptGrounds: true, promptDiscovery: true, questions: 1 });
    expect(['AI', 'MIXED']).toContain(r.value.invitationSource);
  });

  it('L106B-E2E-04 — affirmation personnalisée injustifiée et preuve fictive : rejetées avec motifs ; catalogue en relais ; bulle intacte', async () => {
    await activerT6(['t6-suggestions-v3', 't6-discovery-v1']);
    const { c } = await logementSeul();
    modele.suggestions = () => [
      // Question qui prétend qu'une garantie existe, sans fondement.
      { question: 'Quand expire la garantie de ma voiture ?', subject: 'DOCUMENTS', purpose: 'CONSULT', assetRef: null, deadlineRef: null, decision: { relevant: true, answerable: true, preparationUseful: null }, groundRefs: [], informationNature: ['DOCUMENT_TITLE'] },
      { kind: 'DISCOVERY', universe: 'VEHICLE', documentKind: 'INVOICE', text: 'Ajoutez la facture d’entretien de votre voiture pour retrouver son coût.' },
      { ...VOITURE, groundRefs: ['A1'] },
    ];
    const p = await (await svc()).getMascotPresentation(c.id, 'pregen', c.ownerUserId);
    expect(['ok', 'clear']).toContain(p.status); // accueil utilisable (jamais « dégradé » pour les suggestions)
    expect(questionsDe(p)).toEqual([]);
    expect(invitationsDe(p).every((x) => x.origin === 'CATALOG')).toBe(true);
    expect(invitationsDe(p).length).toBeGreaterThanOrEqual(2);
    const rapport = await vi.waitFor(async () => {
      const [g] = await sql<Array<{ report: { reasons: Record<string, number>; accepted: number } | null }>>`
        SELECT suggestion_report AS report FROM home_mascot_generations WHERE account_id = ${c.id} AND status = 'generated' ORDER BY id DESC LIMIT 1`;
      if (!g?.report) throw new Error('journal T6 pas encore écrit');
      return g.report;
    });
    expect(rapport.accepted).toBe(0);
    expect(rapport.reasons).toMatchObject({ contract_missing_grounds: 1, discovery_personal_claim: 1, discovery_with_grounds: 1 });
    await diagnostic(c.id, 'VALIDATION_REJECTED');
  });

  it('L106B-E2E-05 — clics : question → T2 répond depuis le compte ; invitation → formulaire d’ajout sans bien, aucun bien créé', async () => {
    await activerT6(['t6-suggestions-v3', 't6-discovery-v1']);
    const { c, maison } = await logementSeul();
    modele.suggestions = (ctx) => [fondee(ctx, 'Quels sont les documents de Maison Lilas ?', ['A1', 'A1.DOCS'], { assetRef: 'A1' }), VOITURE];
    const p = await (await svc()).getMascotPresentation(c.id, 'pregen', c.ownerUserId);
    const [q, i] = await slots(p);
    expect(q.kind).toBe('question');
    const t = q.secondary!.action.target;
    expect(t.kind === 'ask' && t.context.assetId).toBe(maison);
    if (t.kind === 'ask') {
      const r = await demander(c, t.question, { pageContext: { route: '/accueil', intent: t.context.intent, assetId: String(t.context.assetId) } });
      expect(r.clarification ?? null).toBeNull();
      expect((r.sources ?? []).length).toBeGreaterThan(0);
    }
    // Invitation : parcours d'ajout EXISTANT, aucun bien présélectionné ni créé.
    expect(i.kind).toBe('invitation');
    expect(i.secondary!.action.target).toEqual({ kind: 'upload_document', assetId: null });
    const [{ n }] = await sql<[{ n: number }]>`SELECT count(*)::int AS n FROM assets WHERE account_id = ${c.id}`;
    expect(n).toBe(1);
  });

  it('L106B-E2E-06 — « Autre suggestion » : renouvellement sans appel IA, jamais la suggestion passée, aucune tâche « À traiter »', async () => {
    await activerT6(['t6-suggestions-v3', 't6-discovery-v1']);
    const { c } = await logementSeul();
    modele.suggestions = (ctx) => [fondee(ctx, 'Quels sont les documents de Maison Lilas ?', ['A1', 'A1.DOCS'], { assetRef: 'A1' }), VOITURE];
    const { getMascotPresentation } = await svc();
    const p = await getMascotPresentation(c.id, 'pregen', c.ownerUserId);
    const avant = await slots(p);
    const appels = modele.t6Prompts.length;
    const [{ n: atpAvant }] = await sql<[{ n: number }]>`SELECT count(*)::int AS n FROM to_process_actions WHERE account_id = ${c.id}`;
    const { recordSuggestionSkip } = await import('@/services/home/mascot/discovery');
    // Passage côté client : la suivante prend la place immédiatement.
    const local = await slots(p, false, new Set([avant[1].key]));
    expect(local.map((x) => x.key)).not.toContain(avant[1].key);
    expect(local).toHaveLength(2);
    // Passage enregistré : l'affichage suivant ne la repropose pas (ni l'invitation, ni la question passée).
    expect(await recordSuggestionSkip(c.id, c.ownerUserId, avant[1].key)).toBe(true);
    expect(await recordSuggestionSkip(c.id, c.ownerUserId, avant[0].key)).toBe(true);
    const d = await getMascotPresentation(c.id, 'display', c.ownerUserId);
    expect(modele.t6Prompts.length).toBe(appels); // aucun appel redondant
    expect(invitationsDe(d).map((x) => x.key)).not.toContain(avant[1].key);
    expect(questionsDe(d)).toEqual([]);
    const apres = await slots(d);
    expect(apres).toHaveLength(2);
    expect(apres.map((x) => x.key)).not.toContain(avant[0].key);
    expect(apres.map((x) => x.key)).not.toContain(avant[1].key);
    const [{ n: atpApres }] = await sql<[{ n: number }]>`SELECT count(*)::int AS n FROM to_process_actions WHERE account_id = ${c.id}`;
    expect(atpApres).toBe(atpAvant);
    await diagnostic(c.id, 'ALL_SKIPPED');
    // Clé hors format : refusée, rien d'écrit.
    expect(await recordSuggestionSkip(c.id, c.ownerUserId, 'ATP:42')).toBe(false);
  });

  it('L106B-E2E-07 — cache ancien / neuf : entrée v3 servie sans appel ; nouveau contrat → une seule nouvelle génération', async () => {
    await activerT6(['t6-suggestions-v3'], 10611);
    const { c } = await logementSeul();
    modele.suggestions = (ctx) => [fondee(ctx, 'Quels sont les documents de Maison Lilas ?', ['A1', 'A1.DOCS'], { assetRef: 'A1' }), ...(ctx.discovery ? [VOITURE] : [])];
    const { getMascotPresentation } = await svc();
    const ancien = await getMascotPresentation(c.id, 'pregen', c.ownerUserId);
    expect(questionsDe(ancien)).toHaveLength(1);
    expect(invitationsDe(ancien).every((x) => x.origin === 'CATALOG')).toBe(true);
    expect(contexteDu(modele.t6Prompts[0]).discovery).toBeUndefined();
    // Compatibilité : l'entrée valide du contrat v3 reste servie (aucun appel).
    await getMascotPresentation(c.id, 'display', c.ownerUserId);
    expect(modele.t6Prompts).toHaveLength(1);
    // Nouveau prompt (étape 13) : nouvelle clé, l'ancienne entrée n'est plus lue ; une génération.
    await activerT6(['t6-suggestions-v3', 't6-discovery-v1'], 10612);
    const neuf = await getMascotPresentation(c.id, 'pregen', c.ownerUserId);
    expect(modele.t6Prompts).toHaveLength(2);
    expect(invitationsDe(neuf)[0]).toMatchObject({ key: 'DISC:VEHICLE:INVOICE', origin: 'AI' });
    await getMascotPresentation(c.id, 'display', c.ownerUserId);
    expect(modele.t6Prompts).toHaveLength(2);
  });

  it('L106B-E2E-08 — IA en erreur : accueil utilisable, invitations du catalogue, aucune relance à l’affichage suivant', async () => {
    await activerT6(['t6-suggestions-v3', 't6-discovery-v1']);
    const { c } = await logementSeul();
    modele.t6Down = true;
    const { getMascotPresentation } = await svc();
    const p = await getMascotPresentation(c.id, 'display', c.ownerUserId);
    expect(['ok', 'clear']).toContain(p.status); // accueil utilisable (jamais « dégradé » pour les suggestions)
    expect(questionsDe(p)).toEqual([]);
    expect(invitationsDe(p).length).toBeGreaterThanOrEqual(2);
    // La génération d'arrière-plan échoue ; l'affichage suivant ne la relance pas.
    await vi.waitFor(() => { if (modele.t6Prompts.length < 1) throw new Error('génération pas encore partie'); });
    await new Promise((r) => setTimeout(r, 200));
    const n = modele.t6Prompts.length;
    const d = await getMascotPresentation(c.id, 'display', c.ownerUserId);
    expect(modele.t6Prompts.length).toBe(n);
    expect(invitationsDe(d).every((x) => x.origin === 'CATALOG')).toBe(true);
    await diagnostic(c.id, 'AI_ERROR');
  });

  it('L106B-E2E-09 — isolation : passages propres à l’utilisateur et au compte ; contexte et cache cloisonnés', async () => {
    await activerT6(['t6-suggestions-v3', 't6-discovery-v1']);
    const a = await logementSeul('premium', 'Maison Lilas');
    const b = await logementSeul('premium', 'Chalet Bleu');
    modele.suggestions = (ctx) => [fondee(ctx, `Quels sont les documents de ${(ctx.assets as Array<{ name: string }>)[0].name} ?`, ['A1', 'A1.DOCS'], { assetRef: 'A1' }), VOITURE];
    const { getMascotPresentation } = await svc();
    const { recordSuggestionSkip } = await import('@/services/home/mascot/discovery');
    await getMascotPresentation(a.c.id, 'pregen', a.c.ownerUserId);
    await getMascotPresentation(b.c.id, 'pregen', b.c.ownerUserId);
    expect(JSON.stringify(contexteDu(modele.t6Prompts.at(-1)!))).not.toContain('Maison Lilas');
    await recordSuggestionSkip(a.c.id, a.c.ownerUserId, 'DISC:VEHICLE:INVOICE');
    // Compte A, son utilisateur : passée ; compte B : intacte ; compte A, autre utilisateur : intacte.
    expect(invitationsDe(await getMascotPresentation(a.c.id, 'display', a.c.ownerUserId)).map((x) => x.key)).not.toContain('DISC:VEHICLE:INVOICE');
    expect(invitationsDe(await getMascotPresentation(b.c.id, 'display', b.c.ownerUserId))[0].key).toBe('DISC:VEHICLE:INVOICE');
    expect(invitationsDe(await getMascotPresentation(a.c.id, 'display', b.c.ownerUserId))[0].key).toBe('DISC:VEHICLE:INVOICE');
    const lignes = await sql<Array<{ account_id: number; user_id: number }>>`SELECT account_id, user_id FROM home_suggestion_skips WHERE account_id IN (${a.c.id}, ${b.c.id})`;
    expect(lignes.map((x) => [Number(x.account_id), Number(x.user_id)])).toEqual([[a.c.id, a.c.ownerUserId]]);
  });

  it('L106B-E2E-10 — Standard comme Premium ; compte non éligible : aucune invitation, aucun appel IA', async () => {
    await activerT6(['t6-suggestions-v3', 't6-discovery-v1']);
    modele.suggestions = (ctx) => [fondee(ctx, 'Quels sont les documents de Maison Lilas ?', ['A1', 'A1.DOCS'], { assetRef: 'A1' })];
    const std = await logementSeul('standard');
    const p = await (await svc()).getMascotPresentation(std.c.id, 'pregen', std.c.ownerUserId);
    expect(questionsDe(p)).toEqual(['Quels sont les documents de Maison Lilas ?']);
    expect(invitationsDe(p).length).toBeGreaterThanOrEqual(2);
    const ro = await logementSeul('premium', 'Villa Rose');
    await sql`UPDATE account_subscriptions SET status = 'readonly' WHERE account_id = ${ro.c.id}`;
    const avant = modele.t6Prompts.length;
    const r = await (await svc()).getMascotPresentation(ro.c.id, 'display', ro.c.ownerUserId);
    expect(r.discovery ?? null).toBeNull();
    expect(questionsDe(r)).toEqual([]);
    expect(modele.t6Prompts.length).toBe(avant);
    await diagnostic(ro.c.id, 'NOT_ELIGIBLE');
  });
});
