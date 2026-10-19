/**
 * Lot 69 — diagnostics construits sur l'état réel (PostgreSQL 16 réel).
 *
 *   · CIL : `evaluateCilReadiness` sur un vrai bien → `blockingBlocks` et
 *     message = blocs RÉELLEMENT manquants (B1 seul, B3 seul, B8 seul, paires,
 *     aucun) ; catalogue (`loadExportCatalog`) aligné ;
 *   · B6 : préparation (`evaluateCilReadiness`) et rendu (`loadExportSource`
 *     + mappeur + template CIL) retiennent EXACTEMENT les mêmes équipements,
 *     un équipement non énergétique ne rend plus B6 « renseigné », un
 *     équipement archivé ne compte plus.
 */
import { expect, it } from 'vitest';
import { scenario } from '../scenario';

scenario('L69-DIAG', 'Diagnostics construits sur l’état réel (CIL B1/B3/B8, B6)', ({ sql, make }) => {
  type Etat = { adresse: boolean; plan: boolean; dpe: boolean };

  const bienCil = async (etat: Etat) => {
    const compte = await make.account({ plan: 'premium' });
    const bien = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison test' });
    await sql`UPDATE assets SET subtype = 'Maison',
      address = ${etat.adresse ? '12 rue des Lilas' : null}, postal_code = ${etat.adresse ? '69003' : null}, city = ${etat.adresse ? 'Lyon' : null}
      WHERE id = ${bien.id}`;
    if (etat.plan) {
      const f = await make.assetFile(compte, { assetId: bien.id, name: 'plan.pdf' });
      await sql`UPDATE asset_files SET document_type = 'PLAN_CONSTRUCTION', retained_function_code = 'PLAN_CONSTRUCTION' WHERE id = ${f.id}`;
    }
    if (etat.dpe) {
      const f = await make.assetFile(compte, { assetId: bien.id, name: 'dpe.pdf' });
      await sql`UPDATE asset_files SET document_type = 'DPE', retained_function_code = 'DPE' WHERE id = ${f.id}`;
    }
    const [row] = await sql<{ id: number; accountId: number; category: string; subtype: string | null; address: string | null; postalCode: string | null; city: string | null }[]>`
      SELECT id, account_id AS "accountId", category, subtype, address, postal_code AS "postalCode", city FROM assets WHERE id = ${bien.id}`;
    return { compte, bien, row };
  };

  const evaluer = async (etat: Etat) => {
    const { row } = await bienCil(etat);
    const { evaluateCilReadiness } = await import('@/services/exports/cil-preparation.service');
    const { cilBlockingMessage } = await import('@/lib/exports/cil-blocking');
    const r = await evaluateCilReadiness(row);
    const { loadExportCatalog } = await import('@/services/exports/export-catalog.service');
    const cat = await loadExportCatalog(row);
    const hint = cat.dossiers.find((d) => d.code === 'CIL')!.readiness.hints.find((h) => h.code === 'CIL_ACTION_REQUIRED')?.message ?? null;
    return { ids: r.blockingBlocks.map((b) => b.id), message: cilBlockingMessage(r.blockingBlocks), hint, status: r.globalStatus };
  };

  it('DIAG-E-C01 — B1 seul manquant (adresse absente)', async () => {
    const e = await evaluer({ adresse: false, plan: true, dpe: true });
    expect(e.ids).toEqual(['B1']);
    expect(e.message).toBe('Identification du logement à compléter avant de générer le CIL.');
    expect(e.hint).toBe(e.message);
  });

  it('DIAG-E-C02 — B3 seul manquant (aucun plan)', async () => {
    const e = await evaluer({ adresse: true, plan: false, dpe: true });
    expect(e.ids).toEqual(['B3']);
    expect(e.message).toBe('Plans et coupes à compléter avant de générer le CIL.');
    expect(e.hint).toBe(e.message);
  });

  it('DIAG-E-C03 — B8 seul manquant (aucun DPE)', async () => {
    const e = await evaluer({ adresse: true, plan: true, dpe: false });
    expect(e.ids).toEqual(['B8']);
    expect(e.message).toBe('Documents de performance énergétique à compléter avant de générer le CIL.');
  });

  it('DIAG-E-C04 — B1 + B3', async () => {
    const e = await evaluer({ adresse: false, plan: false, dpe: true });
    expect(e.ids).toEqual(['B1', 'B3']);
    expect(e.message).toBe('Identification du logement et Plans et coupes sont à compléter avant de générer le CIL.');
  });

  it('DIAG-E-C05 — B3 + B8', async () => {
    const e = await evaluer({ adresse: true, plan: false, dpe: false });
    expect(e.ids).toEqual(['B3', 'B8']);
    expect(e.message).toBe('Plans et coupes et Documents de performance énergétique sont à compléter avant de générer le CIL.');
  });

  it('DIAG-E-C06 — aucun bloc manquant : prêt, aucun message', async () => {
    const e = await evaluer({ adresse: true, plan: true, dpe: true });
    expect(e.status).toBe('ready');
    expect(e.ids).toEqual([]);
    expect(e.message).toBeNull();
    expect(e.hint).toBeNull();
  });

  it('DIAG-E-B6 — préparation et PDF retiennent les mêmes équipements (données structurées, archivés exclus, aucun repli)', async () => {
    const { compte, bien, row } = await bienCil({ adresse: true, plan: true, dpe: true });
    const ajouter = async (name: string, type: string | null, category: string | null = null) => {
      const [e] = await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name, type, category) VALUES (${bien.id}, ${name}, ${type}, ${category}) RETURNING id`;
      return e.id;
    };
    const tv = await ajouter('TV salon', 'Téléviseur');
    const portail = await ajouter('Chauffage du portail', null); // nom trompeur, aucune donnée structurée
    const { evaluateCilReadiness } = await import('@/services/exports/cil-preparation.service');

    // 1. Seulement des équipements non énergétiques : B6 non renseigné (avant : « renseigné » dès un équipement).
    let r = await evaluateCilReadiness(row);
    expect(r.blocks.find((b) => b.id === 'B6')!.status).toBe('unknown');
    expect(r.energyEquipmentIds).toEqual([]);

    // 2. Ajout d'une chaudière (type structuré), d'une VMC archivée et d'un équipement caractérisé par ses données CIL.
    const chaudiere = await ajouter('Chaudière', 'Chaudière gaz à condensation');
    const vmc = await ajouter('VMC', 'VMC simple flux');
    await sql`UPDATE equipments SET archived_at = now() WHERE id = ${vmc}`;
    const poele = await ajouter('Appareil du séjour', null);
    await sql`INSERT INTO equipment_cil_specs (equipment_id, energy_type) VALUES (${poele}, 'BOIS')`;

    r = await evaluateCilReadiness(row);
    expect(r.blocks.find((b) => b.id === 'B6')!.status).toBe('complete');
    expect([...r.energyEquipmentIds!].sort((a, b) => a - b)).toEqual([chaudiere, poele].sort((a, b) => a - b));
    expect(r.energyEquipmentIds).not.toContain(tv);
    expect(r.energyEquipmentIds).not.toContain(portail);

    // 3. Rendu : source réelle → mappeur → template.
    const { loadExportSource } = await import('@/services/exports/v12/data/source');
    const { mapDossierData } = await import('@/services/exports/v12/data/mappers');
    const { buildDefaultChoices, planSelection } = await import('@/services/exports/v12/data/choices');
    const { renderDossierHtml } = await import('@/services/exports/v12/templates');
    const source = await loadExportSource({ assetId: bien.id, accountId: compte.id, userId: compte.ownerUserId, exportType: 'CIL' });
    const today = '2026-10-19';
    const plan = planSelection('CIL', source, buildDefaultChoices('CIL', source, { today }), today);
    const data = mapDossierData('CIL', { source, plan, resolved: null, meta: { reference: 'VBN-E2E-69', generatedAt: '2026-10-19T09:00:00+02:00', preparedBy: null, templateLabel: 't', zipName: null, label: 'T' }, today }) as { cil: { blocks: Array<{ code: string; status: string; source: string | null }>; equipments: Array<{ equipment: string }> } };
    expect(data.cil.blocks.find((b) => b.code === 'B6')).toMatchObject({ status: 'complete', source: '2 équipements' });
    expect(data.cil.equipments.map((e) => e.equipment).sort()).toEqual(['Appareil du séjour', 'Chaudière']);
    const html = renderDossierHtml('CIL', data as never, { sys: 'SYS/', asset: () => null, stylesheets: [], pageMap: null }).html;
    expect(html).not.toContain('TV salon');
    expect(html).not.toContain('Chauffage du portail');
  });
});
