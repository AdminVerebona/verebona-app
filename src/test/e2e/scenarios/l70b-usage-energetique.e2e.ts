/**
 * Lot 70B — « Usage énergétique » d'un équipement (décision PO 19/10 n° 1),
 * sur PostgreSQL 16 réel (toutes les migrations, dont 0486).
 *
 * L70-ENER-E01 Chaque valeur, saisie par la route de création (tiroir) :
 *              persistée ; valeur hors liste refusée (400) ; contrainte CHECK.
 * L70-ENER-E02 Route PUT : écrit `energyUsage` ET `category` (lue depuis
 *              toujours sans être écrite), sans toucher aux autres champs ;
 *              champ absent = inchangé ; null = non renseigné.
 * L70-ENER-E03 Priorité sur le type : « Aucun » exclut une chaudière, un
 *              usage déclaré inclut un équipement au type inconnu, « Non
 *              renseigné » laisse jouer le type — même résultat dans la
 *              complétude B6, la préparation, le mappeur et le PDF.
 * L70-ENER-E04 Isolation des comptes : un autre compte ne lit ni ne modifie
 *              l'usage d'un équipement qui ne lui appartient pas.
 */
import { NextRequest } from 'next/server';
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';

const session = vi.hoisted(() => ({ currentAccountId: 0, userId: 0 }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    handleSessionError: () => new Response(null, { status: 401 }),
  },
}));
vi.mock('@/lib/asset-quota-guard', () => ({
  assetModificationDecision: async () => ({ allowed: true }), refuserSiModificationBiensSuspendue: async () => null,
  countAccountAssets: async () => 0,
}));
vi.mock('@/services/entitlements.service', async (orig) => ({ ...(await orig<object>()), canUsePremiumFeature: async () => ({ allowed: true }) }));
vi.mock('@/services/equipment/equipment-auto-link.service', () => ({ runEquipmentAutoLink: async () => undefined }));
vi.mock('@/services/verebona-assistant/events/business-events', () => ({ emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {} }));
vi.mock('@/services/ai/reconciliation/account-reconciliation.service', () => ({ notifyCoherenceEvent: () => undefined }));

scenario('L70-ENER', 'Usage énergétique des équipements (tiroir, règle B6, CIL)', ({ sql, make }) => {
  const bien = async () => {
    const compte = await make.account({ plan: 'premium' });
    const b = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison L70' });
    await sql`UPDATE assets SET subtype = 'Maison', address = '3 rue des Tilleuls', postal_code = '69003', city = 'Lyon' WHERE id = ${b.id}`;
    const [row] = await sql<{ id: number; accountId: number; category: string; subtype: string | null; address: string | null; postalCode: string | null; city: string | null }[]>`
      SELECT id, account_id AS "accountId", category, subtype, address, postal_code AS "postalCode", city FROM assets WHERE id = ${b.id}`;
    return { compte, bien: b, row };
  };
  const as = (compte: { id: number; ownerUserId: number }) => { session.currentAccountId = compte.id; session.userId = compte.ownerUserId; };
  const post = async (assetId: number, body: unknown) => {
    const { POST } = await import('@/app/api/assets/[id]/equipments/route');
    return POST(new NextRequest(`http://x/api/assets/${assetId}/equipments`, { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id: String(assetId) }) });
  };
  const put = async (assetId: number, equipId: number, body: unknown) => {
    const { PUT } = await import('@/app/api/assets/[id]/equipments/[equipId]/route');
    return PUT(new NextRequest(`http://x/api/assets/${assetId}/equipments/${equipId}`, { method: 'PUT', body: JSON.stringify(body) }), { params: Promise.resolve({ id: String(assetId), equipId: String(equipId) }) });
  };
  const detail = async (equipId: number) => {
    const { GET } = await import('@/app/api/equipments/[id]/route');
    return GET(new NextRequest(`http://x/api/equipments/${equipId}`), { params: Promise.resolve({ id: String(equipId) }) });
  };
  const ligne = async (id: number) => (await sql<{ name: string; type: string | null; category: string | null; energy_usage: string | null; status: string; purchase_price_cents: number | null }[]>`
    SELECT name, type, category, energy_usage, status, purchase_price_cents FROM equipments WHERE id = ${id}`)[0];

  it('L70-ENER-E01 — chaque valeur saisie à la création est persistée ; hors liste : refus ; contrainte CHECK', async () => {
    const { compte, bien: b } = await bien();
    as(compte);
    for (const v of ['chauffage', 'ecs', 'ventilation', 'refroidissement', 'enr', 'aucun', null] as const) {
      const res = await post(b.id, { name: `Équipement ${v ?? 'non renseigné'}`, type: null, energyUsage: v });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.energyUsage).toBe(v);
      expect((await ligne(body.id)).energy_usage).toBe(v);
    }
    // Ancien client (sans le champ) : non renseigné.
    const ancien = await (await post(b.id, { name: 'Sans champ', type: 'Chaudière' })).json();
    expect((await ligne(ancien.id)).energy_usage).toBeNull();
    // Valeur hors liste : 400, rien d'écrit.
    const avant = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM equipments WHERE asset_id = ${b.id}`)[0].n;
    expect((await post(b.id, { name: 'X', energyUsage: 'Chauffage' })).status).toBe(400);
    expect((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM equipments WHERE asset_id = ${b.id}`)[0].n).toBe(avant);
    // Base : la contrainte refuse toute autre valeur.
    await expect(sql`UPDATE equipments SET energy_usage = 'solaire' WHERE id = ${ancien.id}`).rejects.toThrow(/equipments_energy_usage_check/);
  });

  it('L70-ENER-E02 — route PUT : écrit energyUsage et category, autres champs intacts ; absent = inchangé', async () => {
    const { compte, bien: b } = await bien();
    as(compte);
    const [{ id }] = await sql<{ id: number }[]>`
      INSERT INTO equipments (asset_id, name, type, status, purchase_price_cents) VALUES (${b.id}, 'Chaudière', 'Chaudière gaz', 'EN_PANNE', 120000) RETURNING id`;

    let res = await put(b.id, id, { energyUsage: 'chauffage', category: ' CHAUFFAGE ' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ energyUsage: 'chauffage', category: 'CHAUFFAGE', type: 'Chaudière gaz', status: 'EN_PANNE' });
    expect(await ligne(id)).toEqual({ name: 'Chaudière', type: 'Chaudière gaz', category: 'CHAUFFAGE', energy_usage: 'chauffage', status: 'EN_PANNE', purchase_price_cents: 120000 });

    // Corps du tiroir sans ces champs (ancien client) : rien n'est effacé.
    res = await put(b.id, id, { name: 'Chaudière salle de bain', type: 'Chaudière gaz', status: 'EN_SERVICE', substructureId: null });
    expect(res.status).toBe(200);
    expect(await ligne(id)).toMatchObject({ name: 'Chaudière salle de bain', category: 'CHAUFFAGE', energy_usage: 'chauffage', status: 'EN_SERVICE', purchase_price_cents: 120000 });

    // « Non renseigné » et effacement de la catégorie.
    res = await put(b.id, id, { energyUsage: null, category: null });
    expect(res.status).toBe(200);
    expect(await ligne(id)).toMatchObject({ category: null, energy_usage: null, type: 'Chaudière gaz' });

    // Invalides : 400, rien d'écrit.
    expect((await put(b.id, id, { energyUsage: 'gaz' })).status).toBe(400);
    expect((await put(b.id, id, { category: 42 })).status).toBe(400);
    expect(await ligne(id)).toMatchObject({ category: null, energy_usage: null });

    // Lecture du tiroir.
    await put(b.id, id, { energyUsage: 'aucun' });
    const d = await (await detail(id)).json();
    expect(d.equipment).toMatchObject({ id, energyUsage: 'aucun', category: null });
  });

  it('L70-ENER-E03 — priorité sur le type ; complétude B6 = préparation = mappeur = PDF', async () => {
    const { compte, bien: b, row } = await bien();
    as(compte);
    const ajouter = async (name: string, type: string | null, energyUsage: string | null) =>
      (await (await post(b.id, { name, type, energyUsage })).json()).id as number;
    const { evaluateCilReadiness } = await import('@/services/exports/cil-preparation.service');
    const b6 = async () => { const r = await evaluateCilReadiness(row); return { status: r.blocks.find((x) => x.id === 'B6')!.status, ids: [...(r.energyEquipmentIds ?? [])].sort((x, y) => x - y), block: r.blocks.find((x) => x.id === 'B6')! }; };

    // 1. Une chaudière déclarée « Aucun usage énergétique » : exclue malgré son type.
    const chaudiere = await ajouter('Chaudière décorative', 'Chaudière fonte', 'aucun');
    let r = await b6();
    expect(r.status).toBe('unknown');
    expect(r.ids).toEqual([]);
    expect(r.block.missingItems[0].id).toBe('equipments_unclassified');

    // 2. « Non renseigné » : le type joue (VMC) ; usage déclaré sur un type inconnu : inclus.
    const vmc = await ajouter('VMC', 'VMC simple flux', null);
    const onduleur = await ajouter('Onduleur toiture', 'Onduleur', 'enr');
    const tv = await ajouter('TV salon', 'Téléviseur', null);
    r = await b6();
    expect(r.status).toBe('complete');
    expect(r.ids).toEqual([vmc, onduleur].sort((x, y) => x - y));

    // 3. Le type suggère « chauffage », l'usage déclaré dit « ecs » : l'usage déclaré l'emporte (libellé PDF).
    const ballon = await ajouter('Ballon', 'Chaudière mixte', 'ecs');

    // 4. Rendu réel : source → mappeur → template ; mêmes équipements que la préparation.
    const { loadExportSource } = await import('@/services/exports/v12/data/source');
    const { mapDossierData } = await import('@/services/exports/v12/data/mappers');
    const { buildDefaultChoices, planSelection } = await import('@/services/exports/v12/data/choices');
    const { renderDossierHtml } = await import('@/services/exports/v12/templates');
    const source = await loadExportSource({ assetId: b.id, accountId: compte.id, userId: compte.ownerUserId, exportType: 'CIL' });
    const today = '2026-10-19';
    const plan = planSelection('CIL', source, buildDefaultChoices('CIL', source, { today }), today);
    const data = mapDossierData('CIL', { source, plan, resolved: null, meta: { reference: 'VBN-E2E-70B', generatedAt: '2026-10-19T09:00:00+02:00', preparedBy: null, templateLabel: 't', zipName: null, label: 'T' }, today }) as { cil: { blocks: Array<{ code: string; status: string; source: string | null }>; equipments: Array<{ equipment: string; usage: string }> } };
    const prep = await b6();
    expect(prep.ids).toEqual([vmc, onduleur, ballon].sort((x, y) => x - y));
    expect(data.cil.blocks.find((x) => x.code === 'B6')).toMatchObject({ status: 'complete', source: '3 équipements' });
    expect(data.cil.equipments.map((e) => [e.equipment, e.usage]).sort()).toEqual([
      ['Ballon', 'Eau chaude sanitaire'], ['Onduleur toiture', 'Production d’énergie (solaire…)'], ['VMC', 'VMC simple flux'],
    ].sort());
    // Le mappeur sans liste préparée (état antérieur) réapplique la même règle sur la source.
    const { cilEnergyEquipments } = await import('@/lib/cil/energy-equipment');
    expect(cilEnergyEquipments(source.equipments).map((e) => e.id).sort((x, y) => x - y)).toEqual(prep.ids);
    const html = renderDossierHtml('CIL', data as never, { sys: 'SYS/', asset: () => null, stylesheets: [], pageMap: null }).html;
    expect(html).not.toContain('Chaudière décorative');
    expect(html).not.toContain('TV salon');
    expect(html).toContain('Onduleur toiture');
    expect(html).toContain('Eau chaude sanitaire');
    void chaudiere; void tv;
  });

  it('L70-ENER-E04 — isolation des comptes : ni lecture ni modification depuis un autre compte', async () => {
    const a = await bien();
    const autre = await bien();
    as(a.compte);
    const [{ id }] = await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name, type, energy_usage) VALUES (${a.bien.id}, 'PAC', 'Pompe à chaleur', 'chauffage') RETURNING id`;
    as(autre.compte);
    // Par le bien d'autrui, puis par son propre bien (équipement étranger).
    expect((await put(a.bien.id, id, { energyUsage: 'aucun' })).status).toBe(404);
    expect((await put(autre.bien.id, id, { energyUsage: 'aucun', category: 'X' })).status).toBe(404);
    expect((await detail(id)).status).toBe(404);
    expect(await ligne(id)).toMatchObject({ energy_usage: 'chauffage', category: null });
    // La complétude du bien d'autrui n'est pas affectée ; celle de l'autre compte ne voit rien.
    const { evaluateCilReadiness } = await import('@/services/exports/cil-preparation.service');
    expect((await evaluateCilReadiness(a.row)).energyEquipmentIds).toEqual([id]);
    expect((await evaluateCilReadiness(autre.row)).energyEquipmentIds).toEqual([]);
  });
});
