/**
 * Carte #880 — « Quel est le coût de possession de Maison ? » de bout en bout sur PostgreSQL réel, par la
 * VRAIE route de l'Assistant (`POST /api/verebona/messages`), depuis l'accueil, SANS identifiant ni
 * historique — comparé à la VRAIE route de la fiche (`GET /api/assets/:id/tco`), puis export BO unitaire.
 *
 *   CA01  Premium, « Maison » + « Polo », dépenses connues : `structured.ownership_cost`, mode
 *         `deterministic`, ID exact (trace `businessReading`), MÊMES chiffres que la fiche, zéro appel IA ;
 *         même résultat avec le bien de la suggestion (contexte de page revalidé, comme la route) ;
 *   CA02  matrice de noms (Clio, Mercedes, Chalet, Appartement de Lyon, Cupra, Résidence l’Étoile, Ferme du
 *         Suivi) et variantes (« ma maison », « coût total de possession », « TCO ») : le BON bien, chaque fois ;
 *   CA03  Standard (aucun montant), essai, Duo ; homonymes → clarification ; bien introuvable → « bien non
 *         identifié » (jamais « rien trouvé ») ; bien supprimé → introuvable parmi les biens actifs ; lecture TCO
 *         en erreur → « lecture impossible », succès technique conservé ; vraie recherche vide → « rien trouvé »
 *         (inchangé) ; dépense par thème → `structured.sum_qualified` (inchangé) ; forme large hors bien
 *         (« internet au total ») → compréhension (UNDERSTAND), jamais un TCO ;
 *   CA04  trace et export BO : demande / réponse / mode / issue / ID concordants ; contenus masqués sans
 *         habilitation, inclus avec ; absence d'appel IA dite.
 *
 * Fournisseur d'IA SIMULÉ et COMPTÉ : aucun appel réel.
 */
import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import { useTargetState } from '../chain';

vi.mock('@/lib/asset-quota-guard', () => ({ assetModificationDecision: async () => ({ allowed: true }) }));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));
const session = vi.hoisted(() => ({ userId: 0, currentAccountId: 0 }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId, planType: 'PREMIUM' }),
    handleSessionError: () => new Response(null, { status: 401 }),
  },
}));
vi.mock('@/lib/verebona/rate-limit', async (o) => ({
  ...(await o<object>()),
  checkAssistantRateLimit: async () => ({ allowed: true, retryAfterMs: 0 }),
  checkAssistantReadRateLimit: async () => ({ allowed: true, retryAfterMs: 0 }),
}));
vi.mock('@/services/verebona-assistant', async (o) => ({ ...(await o<object>()), ensureAssistantStartupChecked: () => ({ ok: true }) }));
/** Lecture TCO en panne pour UN bien désigné (CA03) — le moteur réel sinon. */
const panne = vi.hoisted(() => ({ assetId: 0 }));
vi.mock('@/services/business-operations/tco/service', async (o) => {
  const reel = await o<typeof import('@/services/business-operations/tco/service')>();
  return { ...reel, readAssetTco: async (accountId: number, assetId: number, opts?: never) => {
    if (panne.assetId && assetId === panne.assetId) throw new Error('ECONNRESET (simulé)');
    return reel.readAssetTco(accountId, assetId, opts);
  } };
});

type Compte = { id: number; ownerUserId: number };
type Corps = Record<string, unknown> & { answer?: string; requestId?: string; mode?: string; intent?: string; clarification?: unknown };
const RIEN = /Je n’ai rien trouvé de correspondant dans votre compte/;
const MONTANT = /\d[\d\s  ]*,\d{2}\s?€/;
const nb = (s: string) => s.replace(/[\u00a0\u202f]/g, ' ');

scenario('C880-TCO', 'Carte #880 — noms des biens préservés, coût de possession fiable jusqu’à la réponse', ({ sql, make }) => {
  useTargetState({}, { masters: ['T1', 'T2'] });
  const appels: string[] = [];
  let n = 0;
  beforeAll(async () => {
    (await import('@/services/ai/gateway/providers')).setAiProvider({
      name: 'simule', isConfigured: () => true,
      async call(input: { task?: string; operationCode?: string }) {
        if (String(input.operationCode ?? '').startsWith('t2_')) appels.push(String(input.task ?? input.operationCode));
        if (input.task === 'UNDERSTAND') {
          return { rawText: JSON.stringify({ mode: 'UNDERSTAND', confidence: 'low', intent: 'UNKNOWN', requestedTopics: [], filters: {}, entityHints: [], requestedFacts: [], reason: 'simulé' }), inputTokens: 1, outputTokens: 1 };
        }
        return { rawText: JSON.stringify({ mode: 'ANSWER', format: 'claims', status: 'answered', claims: [] }), inputTokens: 1, outputTokens: 1 };
      },
    } as never);
  });
  beforeEach(async () => {
    (await import('@/services/verebona-assistant/core/retrieval-cache')).clearRetrievalCache?.();
    appels.length = 0;
    panne.assetId = 0;
  });

  /** Dépenses consolidées réalisées d'un bien (moteur TCO réel). */
  const depenses = async (c: Compte, assetId: number, lignes: ReadonlyArray<readonly [string, number, string]>) => {
    for (const [type, cents, libelle] of lignes) {
      const [op] = await sql<{ id: number }[]>`
        INSERT INTO business_operations (account_id, type_code, status, realized_date, technical_label)
        VALUES (${c.id}, ${type}, 'REALIZED', DATE '2025-03-10', ${libelle}) RETURNING id::int AS id`;
      await sql`INSERT INTO business_operation_sources (account_id, operation_id, source_kind, source_entity_key, authority)
                VALUES (${c.id}, ${op.id}, 'MIGRATION', ${`e2e:${op.id}`}, 'STRUCTURED')`;
      await sql`INSERT INTO business_operation_asset_links (account_id, operation_id, asset_id, link_role, authority)
                VALUES (${c.id}, ${op.id}, ${assetId}, 'PRIMARY', 'STRUCTURED')`;
      await sql`INSERT INTO business_operation_financial_components (account_id, operation_id, kind, amount_minor, currency)
                VALUES (${c.id}, ${op.id}, 'REALIZED_COST', ${cents}, 'EUR')`;
    }
  };
  const bien = async (c: Compte, name: string, category = 'IMMOBILIER') => {
    const a = await make.asset({ id: c.id, ownerUserId: c.ownerUserId } as never, { name, category });
    await sql`UPDATE assets SET status = 'EN_SERVICE', deleted_at = NULL WHERE id = ${a.id}`;
    return a.id as number;
  };
  const compte = async (plan: 'standard' | 'premium' | 'premium_duo' | 'trial') => {
    const a = await make.account({ plan: plan === 'trial' ? null : plan });
    if (plan === 'trial') await sql`INSERT INTO account_subscriptions (account_id, plan_code, status, trial_ends_at) VALUES (${a.id}, 'premium', 'trialing', now() + interval '5 days')`;
    return { id: a.id, ownerUserId: a.ownerUserId } as Compte;
  };
  /** Compte du cas réel : « Maison » + « Polo », dépenses TCO connues. */
  const casReel = async (plan: 'standard' | 'premium' | 'premium_duo' | 'trial' = 'premium') => {
    const c = await compte(plan);
    const maison = await bien(c, 'Maison');
    const polo = await bien(c, 'Polo', 'VEHICULE');
    await depenses(c, maison, [['INTERVENTION', 120_000, 'Ramonage et chaudière'], ['CONTRACT', 64_000, 'Assurance habitation 2025'], ['OTHER', 18_050, 'Taxe ordures']]);
    await depenses(c, polo, [['INTERVENTION', 30_000, 'Révision']]);
    return { c, maison, polo };
  };
  /** VRAIE route d'envoi, depuis l'accueil, sans identifiant de bien ni historique. */
  const poser = async (c: Compte, message: string, pageContext: Record<string, unknown> = { route: '/accueil', platform: 'web' }) => {
    session.userId = c.ownerUserId; session.currentAccountId = c.id;
    const { POST } = await import('@/app/api/verebona/messages/route');
    n += 1;
    const res = await POST(new NextRequest('http://localhost/api/verebona/messages', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, clientRequestId: `c880-${Date.now()}-${n}`, pageContext }),
    }));
    return { status: res.status, body: await res.json() as Corps };
  };
  /** Trace enregistrée de la demande (cascade : stratégie, lecture métier, diagnostic, appels IA). */
  const trace = async (requestId: string) => {
    const [r] = await sql<{ mode: string; status: string; intent: string; retrieval_methods_json: Record<string, any> }[]>`
      SELECT mode, status, intent, retrieval_methods_json FROM verebona_request_runs WHERE request_id = ${requestId} ORDER BY id DESC LIMIT 1`;
    return r;
  };
  /** VRAIE route de la fiche. */
  const fiche = async (c: Compte, assetId: number) => {
    session.userId = c.ownerUserId; session.currentAccountId = c.id;
    const { GET } = await import('@/app/api/assets/[id]/tco/route');
    const res = await GET(new NextRequest(`http://localhost/api/assets/${assetId}/tco`), { params: Promise.resolve({ id: String(assetId) }) });
    return { status: res.status, body: await res.json() as Record<string, any> };
  };
  const eur = (cents: number) => nb(new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(cents / 100));

  it('CA01 — « Quel est le coût de possession de Maison ? » : TCO déterministe, ID exact, mêmes chiffres que la fiche, 0 appel IA', async () => {
    const { c, maison } = await casReel('premium');
    const { status, body } = await poser(c, 'Quel est le coût de possession de Maison ?');
    expect(status).toBe(200);
    const t = await trace(String(body.requestId));
    expect(t.mode).toBe('deterministic');
    expect(t.retrieval_methods_json.strategy).toBe('structured.ownership_cost');
    expect(t.retrieval_methods_json.aiCalls).toBe(0);
    expect(t.retrieval_methods_json.businessReading).toMatchObject({ reading: 'OWNERSHIP_COST', assetId: maison, assetResolution: 'NAME', outcome: 'ANSWERED', strategyExecuted: 'structured.ownership_cost' });
    expect(appels).toEqual([]);
    const f = await fiche(c, maison);
    expect(f.status).toBe(200);
    const total = Number(f.body.tco?.summary?.cumulativeCostCents);
    expect(total).toBe(202_050);
    const reponse = nb(String(body.answer));
    expect(reponse).toMatch(new RegExp(`^Chiffre clé : ${eur(total).replace(/\s/g, '\\s')} — coût cumulé documenté de Maison`));
    expect(reponse).not.toMatch(RIEN);
    expect(reponse).not.toContain('300,00'); // dépense de la Polo : jamais comptée

    // Suggestion correspondante : la route revalide la suggestion et fixe le bien (contexte de page) — même réponse.
    const s = await poser(c, 'Quel est le coût de possession de Maison ?', { route: '/accueil', platform: 'web', assetId: String(maison) });
    expect(nb(String(s.body.answer))).toBe(reponse);
    expect((await trace(String(s.body.requestId))).retrieval_methods_json.businessReading).toMatchObject({ assetId: maison, outcome: 'ANSWERED' });
  });

  it('CA02 — matrice de noms et variantes : le bon bien chaque fois', async () => {
    const c = await compte('premium');
    const ids: Record<string, number> = {};
    for (const [nom, cat] of [['Maison', 'IMMOBILIER'], ['Clio', 'VEHICULE'], ['Mercedes', 'VEHICULE'], ['Chalet', 'IMMOBILIER'], ['Appartement de Lyon', 'IMMOBILIER'],
      ['Cupra', 'VEHICULE'], ['Résidence l’Étoile', 'IMMOBILIER'], ['Ferme du Suivi', 'IMMOBILIER']] as const) {
      ids[nom] = await bien(c, nom, cat);
      await depenses(c, ids[nom], [['OTHER', 10_000 + Object.keys(ids).length * 100, `Frais ${nom}`]]);
    }
    const cas: Array<[string, string]> = [
      ['Quel est le coût de possession de Maison ?', 'Maison'], ['Quel est le coût de possession de ma maison ?', 'Maison'],
      ['Quel est le coût total de possession de Mercedes ?', 'Mercedes'], ['Quel est le TCO de Clio ?', 'Clio'],
      ['Quel est le coût de possession du Chalet ?', 'Chalet'], ['Quel est le coût de possession de l’Appartement de Lyon ?', 'Appartement de Lyon'],
      ['coût total de possession de Cupra', 'Cupra'], ['Quel est le coût de possession de la Résidence l’Étoile ?', 'Résidence l’Étoile'],
      ['Quel est le TCO de la Ferme du Suivi ?', 'Ferme du Suivi'],
    ];
    for (const [q, nom] of cas) {
      const { body } = await poser(c, q);
      const t = await trace(String(body.requestId));
      expect(t.retrieval_methods_json.businessReading, q).toMatchObject({ assetId: ids[nom], outcome: 'ANSWERED' });
      expect(nb(String(body.answer)), q).toContain(`coût cumulé documenté de ${nom}`);
    }
    expect(appels).toEqual([]);
  });

  it('CA03 — droits, ambiguïté, introuvable, supprimé, erreur de lecture : diagnostics métier distincts, jamais « rien trouvé »', async () => {
    // Standard : aucun montant ; essai et Duo : chiffré.
    const std = await casReel('standard');
    const s = await poser(std.c, 'Quel est le coût de possession de Maison ?');
    expect(String(s.body.answer)).toMatch(/Premium et Premium Duo/);
    expect(String(s.body.answer)).not.toMatch(MONTANT);
    expect((await trace(String(s.body.requestId))).retrieval_methods_json.businessReading).toMatchObject({ outcome: 'LOCKED', assetId: std.maison });
    for (const plan of ['trial', 'premium_duo'] as const) {
      const x = await casReel(plan);
      const r = await poser(x.c, 'Quel est le coût de possession de Maison ?');
      expect(nb(String(r.body.answer)), plan).toMatch(/^Chiffre clé : 2 020,50 € — coût cumulé documenté de Maison/);
    }

    const { c, maison } = await casReel('premium');
    // Introuvable : diagnostic explicite avec la désignation intacte.
    const intro = await poser(c, 'Quel est le coût de possession de Maisonnette ?');
    expect(String(intro.body.answer)).toMatch(/^Je n’ai pas identifié le bien « Maisonnette » parmi vos biens actifs\./);
    expect(String(intro.body.answer)).not.toMatch(RIEN);
    const ti = await trace(String(intro.body.requestId));
    expect(ti.retrieval_methods_json.diagnostic).toBe('TARGET_NOT_FOUND');
    expect(ti.retrieval_methods_json.businessReading).toMatchObject({ outcome: 'TARGET_NOT_FOUND', assetId: null });

    // Homonymes : clarification, aucun bien choisi.
    await bien(c, 'Maison');
    const amb = await poser(c, 'Quel est le coût de possession de Maison ?');
    expect(amb.body.clarification ?? amb.body.mode).toBeTruthy();
    expect(String(amb.body.answer)).not.toMatch(MONTANT);
    expect((await trace(String(amb.body.requestId))).retrieval_methods_json.businessReading).toMatchObject({ outcome: 'CLARIFICATION' });

    // Bien supprimé : plus parmi les biens actifs → introuvable, aucun montant.
    const sup = await casReel('premium');
    await sql`UPDATE assets SET deleted_at = now() WHERE id = ${sup.maison}`;
    const rs = await poser(sup.c, 'Quel est le coût de possession de Maison ?');
    expect(String(rs.body.answer)).toMatch(/Je n’ai pas identifié le bien « Maison »/);
    expect(String(rs.body.answer)).not.toMatch(MONTANT);

    // Lecture TCO en erreur : « lecture impossible », succès technique conservé (pas d'erreur d'infrastructure).
    const err = await casReel('premium');
    panne.assetId = err.maison;
    const console_ = vi.spyOn(console, 'error').mockImplementation(() => {});
    const re = await poser(err.c, 'Quel est le coût de possession de Maison ?');
    console_.mockRestore();
    expect(re.status).toBe(200);
    expect(String(re.body.answer)).toMatch(/^Une erreur technique m’empêche de lire cette information pour le moment\./);
    expect(String(re.body.answer)).not.toMatch(RIEN);
    expect(String(re.body.answer)).not.toMatch(MONTANT);
    const te = await trace(String(re.body.requestId));
    expect(te.status).toBe('ok');
    expect(te.retrieval_methods_json.diagnostic).toBe('TECHNICAL_READ_FAILURE');
    expect(te.retrieval_methods_json.businessReading).toMatchObject({ outcome: 'READ_ERROR', assetId: err.maison });
    panne.assetId = 0;

    // Non-régression : vraie recherche vide, dépense par thème, forme large hors bien.
    const vide = await poser(c, 'Retrouve la facture du plombier Zébulon');
    expect(String(vide.body.answer)).not.toMatch(/coût de possession|Chiffre clé/);
    const theme = await poser(c, 'Combien ai-je dépensé en entretien pour la Polo ?');
    expect((await trace(String(theme.body.requestId))).retrieval_methods_json.strategy).toBe('structured.sum_qualified');
    appels.length = 0;
    const large = await poser(c, 'Combien m’a coûté internet au total ?');
    const tl = await trace(String(large.body.requestId));
    expect(tl.retrieval_methods_json.businessReading?.outcome).not.toBe('TARGET_NOT_FOUND');
    expect(String(large.body.answer)).not.toMatch(/Chiffre clé/);
    expect(maison).toBeGreaterThan(0);
  });

  it('CA04 — export BO unitaire : demande, réponse, mode, issue et ID concordants ; contenus selon l’habilitation', async () => {
    const { c, maison } = await casReel('premium');
    const { body } = await poser(c, 'Quel est le coût de possession de Maison ?');
    const id = `T2:${body.requestId}`;
    const { buildExecutionUnitExport } = await import('@/services/ai/business-execution/export');
    const masque = await buildExecutionUnitExport(id, { sensitive: false }) as Record<string, any>;
    expect(masque.assistant).toMatchObject({ outcome: 'ANSWERED', technicalStatus: 'ok', answerMode: 'deterministic', run: { mode: 'deterministic' } });
    expect(masque.assistant.cascade.businessReading).toMatchObject({ assetId: maison, outcome: 'ANSWERED' });
    expect(masque.assistant.question).toMatchObject({ $etat: 'masqué' });
    expect(JSON.stringify(masque)).not.toContain('coût de possession de Maison ?');
    expect(masque.assistant.absent).toContain('Aucun appel IA : réponse produite sans modèle (aiCalls = 0) — aucun échange modèle à restituer.');
    const complet = await buildExecutionUnitExport(id, { sensitive: true }) as Record<string, any>;
    expect(complet.assistant.question).toMatchObject({ $etat: 'inclus', texte: 'Quel est le coût de possession de Maison ?' });
    expect(nb(complet.assistant.answer.texte)).toBe(nb(String(body.answer)));

    // Échec simulé du niveau structuré : l'export dit l'issue fonctionnelle (lecture en erreur), le statut technique reste « ok ».
    panne.assetId = maison;
    const console_ = vi.spyOn(console, 'error').mockImplementation(() => {});
    const e = await poser(c, 'Quel est le coût de possession de Maison ?');
    console_.mockRestore();
    const x = await buildExecutionUnitExport(`T2:${e.body.requestId}`, { sensitive: false }) as Record<string, any>;
    expect(x.assistant).toMatchObject({ outcome: 'READ_ERROR', technicalStatus: 'ok' });
    expect(x.assistant.cascade.diagnostic).toBe('TECHNICAL_READ_FAILURE');
  });
});
