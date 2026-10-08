/**
 * Lot 32 (32E) — de bout en bout sur PostgreSQL réel.
 *
 * Point 8 — exemples « Par exemple » du champ « Demander à Verebona » :
 * chaque exemple renvoyé par la VRAIE route `/api/verebona/suggestions`
 * (catalogue unique + contexte serveur) est posé à l'orchestrateur réel
 * (`runAssistant` + ports réels), avec le contexte que le champ envoie
 * (`buildPageContext` → `enrichPageContext` → `sanitizePageContext`), sur
 * web et mobile. Le modèle est SIMULÉ (aucun réseau) : UNDERSTAND ne
 * comprend rien (la question doit être traitée sans lui ou par l'aide),
 * ANSWER cite la première source fournie. Le Centre d'aide est l'instantané
 * publié (`fixtures/help-corpus-t2.snapshot.json`).
 *
 *  · AC8.7 : chaque exemple proposé produit une VRAIE réponse (ni « rien
 *    trouvé », ni « je ne peux pas répondre de façon fiable », ni
 *    clarification, ni erreur) — comptes riche, vide et ambigu ;
 *  · AC8.8 : fiche → le bien est nommé et la réponse porte sur CE bien ;
 *    nom ambigu → aucun exemple nommé.
 *
 * Point 5 — export d'une exécution IA (route admin réelle) :
 *  · AC5.5 : exécution réelle de l'assistant (passerelle, traces) exportée ;
 *    sortie jamais en clair (empreinte ou rien), question de l'utilisateur absente ;
 *  · AC5.6 : textes libres (erreur, charge utile du job) masqués.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { demander, useTargetState } from '../chain';

vi.mock('@/lib/asset-quota-guard', () => ({ assetModificationDecision: async () => ({ allowed: true }) }));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));
const session = vi.hoisted(() => ({ currentAccountId: 0, userId: 0, adminId: 0 }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    requireAdmin: async () => session.adminId,
    handleSessionError: () => new Response(null, { status: 401 }),
  },
}));

type Compte = { id: number; ownerUserId: number };

/** Modèle simulé : UNDERSTAND ne comprend rien ; ANSWER cite la première source du prompt. */
function modeleSimule() {
  const calls: Array<{ task?: string; prompt: string }> = [];
  const provider = {
    name: 'simule',
    isConfigured: () => true,
    async call(input: { task?: string; prompt: string }) {
      calls.push({ task: input.task, prompt: input.prompt });
      if (input.task === 'ANSWER') {
        const ids = [...new Set(input.prompt.match(/\bhelp_[A-Z0-9-]+__[a-z0-9-]+\b/g) ?? [])];
        return {
          rawText: JSON.stringify({
            mode: 'ANSWER', format: 'claims', status: 'answered',
            claims: [{ text: 'Voici la marche à suivre décrite dans l’aide.', sourceIds: ids.slice(0, 1), derivation: 'direct', factual: true }],
          }),
          inputTokens: 1200, outputTokens: 80,
        };
      }
      if (input.task === 'UNDERSTAND') {
        return {
          rawText: JSON.stringify({ mode: 'UNDERSTAND', confidence: 'low', intent: 'UNKNOWN', requestedTopics: [], filters: {}, entityHints: [], requestedFacts: [], reason: 'simulé' }),
          inputTokens: 300, outputTokens: 20,
        };
      }
      throw new Error(`[simulé] tâche inattendue ${input.task}`);
    },
  };
  return { calls, provider };
}

// Lot 33 : nouvel aveu du Centre d'aide (« …d’information suffisamment fiable… »).
const ECHEC = /Je n’ai rien trouvé de correspondant|ne peux pas répondre de façon fiable|pas trouvé dans le Centre d’aide d’information suffisamment fiable|Je ne sais pas|n’est plus disponible|une erreur/i;

scenario('L32E', 'Lot 32E — exemples « Par exemple » répondables, export d’une exécution IA', ({ sql, make }) => {
  useTargetState({}, { masters: ['T1', 'T2'] });

  const installer = async () => {
    const hc = await import('@/services/verebona-assistant/core/help-corpus.service');
    const json = JSON.parse(readFileSync(join(__dirname, '../fixtures/help-corpus-t2.snapshot.json'), 'utf8'));
    const corpus = hc.parseHelpCorpus(json);
    if (!corpus) throw new Error('instantané du Centre d’aide illisible');
    hc.setHelpCorpusForTests(corpus);
    const sim = modeleSimule();
    const { setAiProvider } = await import('@/services/ai/gateway/providers');
    setAiProvider(sim.provider as never);
    return sim;
  };

  const compte = async (): Promise<Compte> => { const a = await make.account({ plan: 'premium' }); return { id: a.id, ownerUserId: a.ownerUserId }; };
  const bien = async (c: Compte, name: string, category = 'VEHICULE') => {
    const a = await make.asset(c as never, { name, category });
    await sql`UPDATE assets SET status = 'EN_SERVICE' WHERE id = ${a.id}`;
    return a.id;
  };
  const fichier = async (c: Compte, assetId: number | null, titre: string, etat = 'ANALYZED') => {
    const f = await make.assetFile(c as never, { assetId });
    await sql`UPDATE asset_files SET retained_title = ${titre}, original_filename = ${`${titre}.pdf`}, analysis_state = ${etat} WHERE id = ${f.id}`;
    return f.id;
  };
  const dans = (jours: number) => new Date(Date.now() + jours * 86_400_000).toISOString().slice(0, 10);

  /** Exemples de la page, servis par la VRAIE route. */
  const exemples = async (c: Compte, route: string): Promise<Array<{ id: string; label: string }>> => {
    session.currentAccountId = c.id; session.userId = c.ownerUserId;
    const { GET } = await import('@/app/api/verebona/suggestions/route');
    const { NextRequest } = await import('next/server');
    const res = await GET(new NextRequest(`http://x/api/verebona/suggestions?route=${encodeURIComponent(route)}`));
    expect(res.status).toBe(200);
    return ((await res.json()) as { suggestions: Array<{ id: string; label: string }> }).suggestions.slice(0, 3);
  };

  /** Contexte envoyé par le champ (desktop : web ; espace mobile : mobile). */
  const contexte = async (route: string, platform: 'web' | 'mobile') => {
    const { buildPageContext } = await import('@/lib/verebona/page-context');
    const { enrichPageContext } = await import('@/lib/help-center/screens');
    const { sanitizePageContext } = await import('@/services/verebona-assistant/core/page-context');
    return sanitizePageContext(enrichPageContext(buildPageContext(route), platform));
  };

  /** Pose chaque exemple de chaque page ; rend les échecs (vide attendu). */
  const verifier = async (c: Compte, routes: string[], sim: ReturnType<typeof modeleSimule>) => {
    const echecs: string[] = [];
    const vus: string[] = [];
    for (const route of routes) {
      for (const s of await exemples(c, route)) {
        for (const platform of ['web', 'mobile'] as const) {
          sim.calls.length = 0;
          const r = await demander(c, s.label, { pageContext: await contexte(route, platform) });
          vus.push(`${route} [${platform}] ${s.label}`);
          const answer = String(r.answer ?? '');
          const raison = r.cascade?.diagnostic === 'SEARCH_NO_RESULT' || r.cascade?.diagnostic === 'TARGET_NOT_FOUND' ? r.cascade.diagnostic
            : r.clarification ? 'clarification'
              : ECHEC.test(answer) ? `réponse « ${answer.slice(0, 80)} »`
                : sim.calls.some((x) => x.task === 'ANSWER') && (r.sources ?? []).length === 0 ? 'réponse rédigée sans source'
                  : null;
          if (raison) echecs.push(`${route} [${platform}] « ${s.label} » → ${raison}`);
        }
      }
    }
    return { echecs, vus };
  };

  it('AC8.7 — compte riche : chaque exemple de chaque page a une vraie réponse (web et mobile)', async () => {
    const sim = await installer();
    const c = await compte();
    const cupra = await bien(c, 'Cupra');
    const maison = await bien(c, 'Maison Lyon', 'IMMOBILIER');
    await fichier(c, cupra, 'Facture entretien garage');
    await fichier(c, null, 'Contrat assurance habitation');
    await fichier(c, cupra, 'Scan illisible', 'ANALYSIS_FAILED');
    await fichier(c, maison, 'Diagnostic énergie', 'ANALYZING');
    await make.agendaItem(c as never, { title: 'Contrôle technique', startDate: dans(10), assetIds: [cupra] });
    await sql`INSERT INTO to_process_actions (account_id, target_type, target_id, field_key, action_kind, rule_code, question)
              VALUES (${c.id}, 'ASSET', ${cupra}, 'purchasePriceCents', 'ARBITRATE', 'DATA-ACQUISITION-PRICE', 'Prix d’achat ?')`;
    await sql`INSERT INTO export_generation (asset_id, account_id, user_id, export_type, status)
              VALUES (${cupra}, ${c.id}, ${c.ownerUserId}, 'DOSSIER_COMPLET', 'ready')`;

    const routes = ['/accueil', '/accueil/a-traiter', '/assets', `/assets/${cupra}`, `/assets/${maison}`, '/documents', '/agenda', '/mon-compte', '/aide'];
    const { echecs, vus } = await verifier(c, routes, sim);
    expect(echecs).toEqual([]);
    expect(vus.length).toBeGreaterThanOrEqual(routes.length * 3 * 2);
    // Les exemples dépendant des données sont bien présents ici.
    const tous = vus.join('\n');
    expect(tous).toContain('Que dois-je traiter en priorité ?');
    expect(tous).toContain('Quels documents ne sont rattachés à aucun bien ?');
    expect(tous).toMatch(/Quels sont les documents de Cupra \?/);
  });

  it('AC8.8 — fiche : le bien est NOMMÉ et la réponse porte sur ce bien ; jamais « ce bien »', async () => {
    await installer();
    const c = await compte();
    const cupra = await bien(c, 'Cupra');
    await bien(c, 'Polo');
    await fichier(c, cupra, 'Facture entretien garage');
    await make.agendaItem(c as never, { title: 'Contrôle technique', startDate: dans(12), assetIds: [cupra] });
    const l = await exemples(c, `/assets/${cupra}`);
    expect(l.map((s) => s.label)).toEqual([
      'Quels sont les documents de Cupra ?',
      'Quelles sont les prochaines échéances de Cupra ?',
      'Comment compléter la fiche d’un bien ?',
    ]);
    const docs = await demander(c, l[0].label, { pageContext: await contexte(`/assets/${cupra}`, 'web') });
    expect(docs.answer).toContain('Facture entretien garage');
    const ech = await demander(c, l[1].label, { pageContext: await contexte(`/assets/${cupra}`, 'web') });
    expect(ech.answer).toMatch(/Contrôle technique/);
    expect(ech.answer).toMatch(/Cupra/);
    for (const r of ['/accueil', '/documents', '/assets', '/agenda']) {
      for (const s of await exemples(c, r)) expect(s.label, r).not.toMatch(/ce bien|sa fiche/);
    }
  });

  it('AC8.7 — compte vide et nom ambigu : exemples généraux, tous répondables', async () => {
    const sim = await installer();
    const vide = await compte();
    const seul = await bien(vide, 'Clio');
    const r1 = await verifier(vide, ['/accueil', '/accueil/a-traiter', '/assets', `/assets/${seul}`, '/documents', '/agenda'], sim);
    expect(r1.echecs).toEqual([]);
    // Ni documents, ni éléments à traiter : pas d'exemple qui répondrait « rien ».
    expect(r1.vus.join('\n')).not.toMatch(/Que dois-je traiter|ne sont rattachés|Quels sont les documents/);

    const amb = await compte();
    const cupra = await bien(amb, 'Cupra');
    await bien(amb, 'Cupra Born');
    await fichier(amb, cupra, 'Facture entretien garage');
    const l = await exemples(amb, `/assets/${cupra}`);
    expect(l.map((s) => s.label).join('|')).not.toMatch(/Cupra/);
    const r2 = await verifier(amb, [`/assets/${cupra}`, '/accueil'], sim);
    expect(r2.echecs).toEqual([]);
  });

  it('AC5.5 — export d’une exécution réelle de l’assistant : complet, sortie en empreinte, sans la question', async () => {
    const sim = await installer();
    const c = await compte();
    await bien(c, 'Cupra');
    const QUESTION = 'Comment fonctionne la page « À traiter » ?';
    const r = await demander(c, QUESTION, { pageContext: await contexte('/accueil/a-traiter', 'web') });
    expect(sim.calls.map((x) => x.task)).toContain('ANSWER');
    expect(r.sources?.length).toBeGreaterThan(0);
    const [ev] = await sql<{ id: number }[]>`SELECT id FROM ai_usage_event WHERE account_id = ${c.id} ORDER BY id DESC LIMIT 1`;
    expect(ev).toBeTruthy();

    const admin = await make.user({ role: 'ADMIN' });
    session.adminId = admin.id;
    const { GET } = await import('@/app/api/admin/ai/executions/[id]/export/route');
    const { NextRequest } = await import('next/server');
    const res = await GET(new NextRequest(`http://x/api/admin/ai/executions/${ev.id}/export?download=1`), { params: Promise.resolve({ id: String(ev.id) }) });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/\.json"$/);
    const texte = await res.text();
    const x = JSON.parse(texte);
    expect(x.format).toBe('verebona.ai-execution/v1');
    expect(x.callId).toBe(Number(ev.id));
    expect(x.traceId).toBeTruthy();
    expect(x.summary.treatment).toBe('T2');
    expect(x.calls.length).toBeGreaterThanOrEqual(1);
    expect(x.costs.inputTokens).toBeGreaterThanOrEqual(1200);
    expect(x.appliedConfiguration.task).toBe('ANSWER');
    expect(x.modelIO.renderedPrompt).toBeNull();
    // §29.6 : sortie de l'assistant jamais conservée — au plus une empreinte
    // (appel sans étape de pipeline : rien, et l'export le dit).
    expect(x.modelIO.responses.every((o: { kind: string }) => o.kind === 'digest')).toBe(true);
    if (x.modelIO.responses.length === 0) expect(x.modelIO.responseNote).toMatch(/Aucune sortie journalisée/);
    expect(texte).not.toContain('Voici la marche à suivre');
    expect(texte).not.toContain(QUESTION);
  });

  it('AC5.6 — textes libres masqués dans l’export (erreur, charge utile du job)', async () => {
    const c = await compte();
    const IBAN = 'FR76 3000 6000 0112 3456 7890 189';
    const [job] = await sql<{ id: number }[]>`
      INSERT INTO ai_job_queue (treatment, account_id, target_type, target_id, dedupe_key, trigger_code, payload, last_error)
      VALUES ('T3', ${c.id}, 'asset', '1', ${`e2e32e:${c.id}:${Math.random()}`}, 'manual', ${JSON.stringify({ note: `iban ${IBAN}` })}::jsonb, ${`échec ${IBAN}`})
      RETURNING id`;
    const [ev] = await sql<{ id: number }[]>`
      INSERT INTO ai_usage_event (account_id, operation_type, operation_code, provider, model, is_billable, is_fallback,
                                  input_tokens, output_tokens, cost_micros, duration_ms, status, error_code, error_message,
                                  metadata, use_case_code, job_id)
      VALUES (${c.id}, 't3_value_conflict', 't3_value_conflict', 'gemini', 'gemini-2.5-pro', true, false, 100, 10, 50, 20,
              'error', 'OUTPUT_INVALID', ${`sortie ${IBAN}`}, ${JSON.stringify({ traceId: randomUUID(), pricing: { currency: 'USD' } })}::jsonb,
              'RECONCILIATION', ${job.id})
      RETURNING id`;
    const admin = await make.user({ role: 'ADMIN' });
    session.adminId = admin.id;
    const { GET } = await import('@/app/api/admin/ai/executions/[id]/export/route');
    const { NextRequest } = await import('next/server');
    const res = await GET(new NextRequest(`http://x/api/admin/ai/executions/${ev.id}/export`), { params: Promise.resolve({ id: String(ev.id) }) });
    const texte = await res.text();
    const x = JSON.parse(texte);
    expect(texte).not.toContain('FR76 3000');
    expect(texte).toContain('[IBAN_MASQUE]');
    expect(x.errors.map((e: { where: string }) => e.where)).toEqual(expect.arrayContaining([expect.stringMatching(/^appel /), `job ${job.id}`]));
    expect(x.job.id).toBe(Number(job.id));
    expect(x.inputs.find((i: { label: string }) => i.label === 'Tarif figé')?.value).toEqual({ currency: 'USD' });
  });
});
