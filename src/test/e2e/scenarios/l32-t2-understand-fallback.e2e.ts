/**
 * Lot 32 — T2 : UNDERSTAND, fallback général de compréhension, de bout en
 * bout sur PostgreSQL réel : `runAssistant` + PORTS RÉELS
 * (`buildOrchestratorPorts`), master T2 rejoué par la vraie passerelle (aucun
 * réseau) — `replay.calls` est le compteur d'appels LLM.
 *
 *  · C : « Quels documents sont liés à ce bien ? » sans contexte → « De quel
 *    bien parlez-vous ? » avec les biens DISPONIBLES (règle du lot 29), 0 appel
 *    LLM, aucune recherche globale ; état de compréhension tracé ;
 *  · G : « Parle-moi de la Polo » puis « ce bien » → la Polo, sans question ;
 *  · D : « l'autre » non levé par le fil → UNDERSTAND (1 appel) → indice
 *    ramené au compte par le serveur → recherche sur la Cupra seule ;
 *  · I : « Quels documents sont liés à la Polo ? » sans document de la Polo →
 *    « aucun document », jamais les documents d'un autre bien.
 */
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { demander, useTargetState } from '../chain';

vi.mock('@/lib/asset-quota-guard', () => ({ assetModificationDecision: async () => ({ allowed: true }) }));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));
const session = vi.hoisted(() => ({ currentAccountId: 0, userId: 0 }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    handleSessionError: () => new Response(null, { status: 401 }),
  },
}));

type Compte = { id: number; ownerUserId: number };
const understand = (output: Record<string, unknown>) => ({
  operationCode: 't2_understand', task: 'UNDERSTAND',
  output: { mode: 'UNDERSTAND', confidence: 'exact', requestedFacts: [], requestedTopics: [], filters: {}, reason: 'e2e', ...output },
});

scenario('L32-T2U', 'Lot 32 — T2 UNDERSTAND, fallback général de compréhension', ({ sql, make, useRecordings }) => {
  useTargetState({}, { masters: ['T1', 'T2'] });

  const compte = async (): Promise<Compte> => { const a = await make.account({ plan: 'premium' }); return { id: a.id, ownerUserId: a.ownerUserId }; };
  const bien = async (c: Compte, name: string, over: { category?: string; subtype?: string | null; status?: string } = {}) => {
    const a = await make.asset({ id: c.id, ownerUserId: c.ownerUserId } as never, { category: over.category ?? 'VEHICULE', name });
    await sql`UPDATE assets SET subtype = ${over.subtype ?? null}, status = ${over.status ?? 'EN_SERVICE'} WHERE id = ${a.id}`;
    return a;
  };
  const fichier = async (c: Compte, assetId: number, titre: string) => {
    const f = await make.assetFile({ id: c.id, ownerUserId: c.ownerUserId } as never, { assetId, name: `${titre}.pdf` });
    await sql`UPDATE asset_files SET retained_title = ${titre} WHERE id = ${f.id}`;
    return f;
  };

  it('T2U-C-E2E — cible manquante évidente : clarification déterministe (biens disponibles), 0 appel LLM, aucune recherche globale', async () => {
    const c = await compte();
    const maison = await bien(c, 'Maison Lyon', { category: 'IMMOBILIER', subtype: 'Maison' });
    const polo = await bien(c, 'Polo');
    const cupra = await bien(c, 'Cupra');
    await bien(c, 'Clio', { status: 'ARCHIVED' });
    await fichier(c, cupra.id, 'Assurance Cupra');
    const replay = await useRecordings([]);
    // Un fil existe (la clarification y est enregistrée, comme dans l'application).
    const r0 = await demander(c, 'Bonjour');
    const r = await demander(c, 'Quels documents sont liés à ce bien ?', { pageContext: { route: '/accueil' }, conversationId: r0.conversationId });
    expect(r.answer).toBe('De quel bien parlez-vous ?');
    expect(r.clarification?.candidates.map((x) => x.entityId).sort()).toEqual([maison.id, polo.id, cupra.id].sort());
    expect(r.sources).toEqual([]);
    expect(replay.calls).toHaveLength(0);
    expect(r.cascade?.aiCalls).toBe(0);
    const [run] = await sql<{ j: { understanding?: { status: string; reasons: string[] } } }[]>`
      SELECT retrieval_methods_json AS j FROM verebona_request_runs WHERE request_id = ${r.requestId}`;
    expect(run?.j?.understanding).toMatchObject({ status: 'PARTIAL', reasons: ['MISSING_TARGET'] });
  });

  it('T2U-G-E2E — « Parle-moi de la Polo » puis « ce bien » : la Polo, sans clarification', async () => {
    const c = await compte();
    const polo = await bien(c, 'Polo');
    const cupra = await bien(c, 'Cupra');
    const carte = await fichier(c, polo.id, 'Carte grise Polo');
    await fichier(c, cupra.id, 'Assurance Cupra');
    // « Parle-moi de la Polo » : intention inconnue des règles → UNDERSTAND.
    let replay = await useRecordings([understand({ intent: 'ACCOUNT_SEARCH_ASSET', entityHints: [{ type: 'asset', value: 'Polo' }] })]);
    const r1 = await demander(c, 'Parle-moi de la Polo');
    expect(r1.conversationId).toBeTruthy();
    expect(replay.calls.map((x) => x.task)).toEqual(['UNDERSTAND']);
    // « ce bien » : levé par le fil — aucune question, aucun appel modèle.
    replay = await useRecordings([]);
    const r2 = await demander(c, 'Quels documents sont liés à ce bien ?', { conversationId: r1.conversationId });
    expect(r2.clarification).toBeNull();
    expect(r2.answer).not.toContain('Cupra');
    expect(r2.sources.map((s) => s.id)).toContain(`doc_${carte.id}`);
    expect(replay.calls).toHaveLength(0);
  });

  it('T2U-D-E2E — « l’autre » non levé par le fil : UNDERSTAND (1 appel) puis résolution SERVEUR de l’indice', async () => {
    const c = await compte();
    const polo = await bien(c, 'Polo');
    const cupra = await bien(c, 'Cupra');
    await fichier(c, polo.id, 'Carte grise Polo');
    const assurance = await fichier(c, cupra.id, 'Assurance Cupra');
    let replay = await useRecordings([]);
    const r1 = await demander(c, 'Quels documents sont liés à la Polo ?');
    expect(replay.calls).toHaveLength(0);
    replay = await useRecordings([understand({ intent: 'ACCOUNT_SEARCH_DOCUMENT', entityHints: [{ type: 'asset', value: 'Cupra' }] })]);
    const r2 = await demander(c, 'Et les documents qui concernent l’autre ?', { conversationId: r1.conversationId });
    expect(replay.calls.map((x) => x.task)).toEqual(['UNDERSTAND']);
    expect(r2.sources.map((s) => s.id)).toContain(`doc_${assurance.id}`);
    expect(r2.answer).not.toContain('Carte grise Polo');
    expect(r2.cascade?.understanding).toMatchObject({ status: 'COMPLETE', resolvedBy: 'understand' });
  });

  it('T2U-I-E2E — aucun résultat véritable : recherche sur la Polo seule → « aucun document »', async () => {
    const c = await compte();
    await bien(c, 'Polo');
    const cupra = await bien(c, 'Cupra');
    await fichier(c, cupra.id, 'Assurance Cupra');
    const replay = await useRecordings([]);
    const r = await demander(c, 'Quels documents sont liés à la Polo ?');
    expect(r.answer).toMatch(/aucun document/i);
    expect(r.answer).toContain('Polo');
    expect(r.answer).not.toContain('Cupra');
    expect(r.clarification).toBeNull();
    expect(replay.calls).toHaveLength(0);
  });
});
