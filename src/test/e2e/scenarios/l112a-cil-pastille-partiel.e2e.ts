/**
 * Lot 112A — pastille « Partiel » du PDF CIL (décision PO du 06/11),
 * PostgreSQL 16 réel, routes réelles.
 *
 * L112A-E2E-01  Bien documenté en partie (un matériau, une PAC seule) :
 *               Informations (route `cil-checklist`) « Partiel » pour B5 et B6 ;
 *               préparation (DTO) et PDF (source réelle → mappeur → template)
 *               affichent la MÊME pastille bloc par bloc, « Partiel » rendu en
 *               texte, manques cités, compteurs et en-tête cohérents ; blocage
 *               CIL-RULE-002 inchangé.
 * L112A-E2E-02  Données complétées (ECS, ventilation, déclarations N/A
 *               justifiées des usages absents) : « Renseigné » partout.
 * L112A-E2E-03  Bloc déclaré non applicable (justifié, route réelle) :
 *               « Non applicable » partout, jamais « Partiel » ; retrait →
 *               la pastille revient à l'état réel (« Partiel »).
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
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Mapped = { code: string; status: string; source: string | null; resolution?: string | null };

scenario('L112A', 'CIL : pastille « Partiel » — Informations = préparation = PDF', ({ sql, make }) => {
  const logement = async () => {
    const compte = await make.account({ plan: 'premium' });
    const bien = await make.asset(compte, { category: 'IMMOBILIER', name: 'Appartement L112A' });
    await sql`UPDATE assets SET subtype = 'Appartement', address = '4 rue Garibaldi', postal_code = '69006', city = 'Lyon' WHERE id = ${bien.id}`;
    session.currentAccountId = compte.id; session.userId = compte.ownerUserId;
    for (const code of ['PLAN_CONSTRUCTION', 'DPE']) {
      const f = await make.assetFile(compte, { assetId: bien.id, name: `${code.toLowerCase()}.pdf` });
      await sql`UPDATE asset_files SET document_type = ${code}, retained_function_code = ${code} WHERE id = ${f.id}`;
    }
    // B5 : un seul poste décrit (murs) ; B6 : une PAC (chauffage) seule.
    await sql`INSERT INTO energy_materials (asset_id, category, material_nature, thermal_resistance_r, thickness_mm) VALUES (${bien.id}, 'murs_exterieurs', 'Laine de verre', 3.2, 120)`;
    const equipement = async (name: string, type: string, energyType: string) => {
      const [e] = await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name, type) VALUES (${bien.id}, ${name}, ${type}) RETURNING id`;
      await sql`INSERT INTO equipment_cil_specs (equipment_id, energy_type) VALUES (${e.id}, ${energyType})`;
      return e.id;
    };
    await equipement('PAC du séjour', 'Pompe à chaleur air/eau', 'électricité');
    return { compte, bien, equipement };
  };
  const ctx = (assetId: number) => ({ params: Promise.resolve({ id: String(assetId) }) });

  /** Les trois lectures : Informations (route réelle), préparation (DTO), PDF (mappeur + template). */
  const lire = async (c: { id: number; ownerUserId: number }, assetId: number) => {
    const { GET } = await import('@/app/api/assets/[id]/cil-checklist/route');
    const res = await GET(new NextRequest(`http://x/api/assets/${assetId}/cil-checklist`), ctx(assetId));
    expect(res.status).toBe(200);
    const state = (await res.json()).state as { blocks: Array<{ id: string; status: string }> };
    const { loadExportSource } = await import('@/services/exports/v12/data/source');
    const { buildPreparation } = await import('@/services/exports/v12/preparation/prepare');
    const { mapDossierData } = await import('@/services/exports/v12/data/mappers');
    const { buildDefaultChoices, planSelection } = await import('@/services/exports/v12/data/choices');
    const { renderDossierHtml } = await import('@/services/exports/v12/templates');
    const source = await loadExportSource({ assetId, accountId: c.id, userId: c.ownerUserId, exportType: 'CIL' });
    const today = '2026-11-06';
    const prep = buildPreparation('CIL', source, { today, lastGeneration: null }).cil!;
    const plan = planSelection('CIL', source, buildDefaultChoices('CIL', source, { today }), today);
    const data = mapDossierData('CIL', { source, plan, resolved: null, meta: { reference: 'VBN-E2E-112A', generatedAt: '2026-11-06T09:00:00+01:00', preparedBy: null, templateLabel: 't', zipName: null, label: 'T' }, today }) as { cil: { blocks: Mapped[] } };
    const html = renderDossierHtml('CIL', data as never, { sys: 'SYS/', asset: () => null, stylesheets: [], pageMap: null }).html;
    const info = (id: string) => state.blocks.find((b) => b.id === id)!.status;
    const pdf = (id: string) => data.cil.blocks.find((b) => b.code === id)!;
    const dto = (id: string) => prep.blocks.find((b) => b.id === id)!;
    // Invariant 112A : préparation = PDF, bloc par bloc (aucun calcul parallèle).
    for (const m of data.cil.blocks) expect([m.code, dto(m.code).pillStatus ?? dto(m.code).status]).toEqual([m.code, m.status]);
    return { info, pdf, dto, prep, html, data, source };
  };
  const declarer = async (assetId: number, blockId: string, justification: string) => {
    const { PATCH } = await import('@/app/api/assets/[id]/exports/cil/resolutions/route');
    const res = await PATCH(new NextRequest(`http://x/api/assets/${assetId}/exports/cil/resolutions`, { method: 'PATCH', body: JSON.stringify({ blockId, resolution: 'not_applicable', justification }) }), ctx(assetId));
    expect(res.status).toBe(200);
  };
  const retirer = async (assetId: number, blockId: string) => {
    const { DELETE } = await import('@/app/api/assets/[id]/exports/cil/resolutions/route');
    const res = await DELETE(new NextRequest(`http://x/api/assets/${assetId}/exports/cil/resolutions?blockId=${blockId}`, { method: 'DELETE' }), ctx(assetId));
    expect(res.status).toBe(200);
  };

  it('L112A-E2E-01 — données en partie présentes : « Partiel » identique dans Informations, la préparation et le PDF', async () => {
    const { compte, bien } = await logement();
    const r = await lire(compte, bien.id);

    for (const id of ['B5', 'B6']) {
      expect(r.info(id)).toBe('partiel');
      expect(r.dto(id)).toMatchObject({ status: 'complete', pillStatus: 'partial' });
      expect(r.pdf(id).status).toBe('partial');
    }
    expect(r.pdf('B5').source).toMatch(/^1 matériau · à compléter : /);
    expect(r.pdf('B6').source).toMatch(/^1 équipement · à compléter : .*Eau chaude sanitaire/);
    // B1 renseigné partout ; aucun blocage CIL-RULE-002 (adresse, plan, DPE présents).
    expect(r.info('B1')).toBe('renseigne');
    expect(r.pdf('B1').status).toBe('complete');
    expect(r.prep.blockingBlocks).toEqual([]);

    // Rendu : texte « Partiel » (impression N&B), ton du moteur V12, compteurs et en-tête cohérents.
    // B9 : plan et DPE ne sont pas des annexes → « À compléter » (Informations : « Manquant »), jamais « Partiel »
    // ni « Renseigné » ; masqué au PDF sans document ni statut utile (CIL-PDF-11).
    expect(r.info('B9')).toBe('manquant');
    expect(r.dto('B9').pillStatus).toBe('unknown');
    const shown = r.data.cil.blocks.filter((b) => b.code !== 'B9' || b.status !== 'unknown');
    const nPartial = shown.filter((b) => b.status === 'partial').length;
    const nTodo = shown.filter((b) => ['partial', 'unknown', 'invalid'].includes(b.status)).length;
    expect(nPartial).toBeGreaterThanOrEqual(2);
    expect(r.html.match(/<span class="pill warn ">Partiel<\/span>/g)!.length).toBeGreaterThanOrEqual(nPartial);
    expect(r.html).toContain(`${nTodo} à compléter dont ${nPartial} partiels`);
    expect(r.html).toContain('« Partiel » signale un bloc documenté');
  });

  it('L112A-E2E-02 — données complétées : « Renseigné » partout pour B6', async () => {
    const { compte, bien, equipement } = await logement();
    await equipement('Chauffe-eau', 'Chauffe-eau thermodynamique', 'électricité');
    await equipement('VMC', 'VMC simple flux', 'électricité');
    await declarer(bien.id, 'B6.refroidissement', 'Pas de climatisation');
    await declarer(bien.id, 'B6.enr', 'Aucune production d’énergie');
    const r = await lire(compte, bien.id);
    expect(r.info('B6')).toBe('renseigne');
    expect(r.dto('B6')).toMatchObject({ status: 'complete', pillStatus: 'complete' });
    expect(r.pdf('B6')).toMatchObject({ status: 'complete', source: '3 équipements' });
    // B5 reste partiel (un seul poste) : la règle est la même pour chaque bloc.
    expect(r.pdf('B5').status).toBe('partial');
  });

  it('L112A-E2E-03 — bloc déclaré non applicable (justifié) : « Non applicable » partout ; retrait → « Partiel »', async () => {
    const { compte, bien } = await logement();
    await sql`DELETE FROM energy_materials WHERE asset_id = ${bien.id}`;
    await declarer(bien.id, 'B5', 'Logement en sous-sol sans paroi isolée');
    let r = await lire(compte, bien.id);
    expect(r.info('B5')).toBe('non_applicable');
    expect(r.dto('B5').pillStatus).toBe('not_applicable');
    expect(r.pdf('B5')).toMatchObject({ status: 'not_applicable', resolution: 'Logement en sous-sol sans paroi isolée' });
    expect(r.html).toContain('Logement en sous-sol sans paroi isolée');

    await retirer(bien.id, 'B5');
    await sql`INSERT INTO energy_materials (asset_id, category, material_nature) VALUES (${bien.id}, 'toiture', 'Laine soufflée')`;
    r = await lire(compte, bien.id);
    expect(r.dto('B5').pillStatus).toBe(r.pdf('B5').status);
    expect(r.pdf('B5').status).toBe('partial');
    expect(r.info('B5')).toBe('partiel');
  });
});
