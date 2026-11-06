/**
 * Lot 111U — CIL : chaîne DPE → T1 → T3 → structures spécialisées → état
 * commun → Informations → préparation → PDF (PostgreSQL réel, migrations du
 * harnais, point d'entrée T1 de production avec sortie rejouée).
 *
 * L111U-E2E-01  DPE de recette complet : champs canoniques (classes, consommation,
 *               émissions, date, n° ADEME), matériaux (murs, toiture, vitrages),
 *               équipements (chauffage gaz, ECS, VMC) ; plancher bas NON décrit →
 *               aucun matériau inventé ; recommandations → aucun travail réalisé ;
 *               Informations = préparation = PDF (mêmes valeurs, même source).
 * L111U-E2E-02  Deuxième passage T3 et réimport identique : aucune écriture.
 * L111U-E2E-03  Rattrapage du stock par COH-CIL-DOCUMENT-PROJECTION : à blanc, puis
 *               correctif, puis idempotent ; saisie USER protégée ; ligne DOCUMENT
 *               supprimée par l'utilisateur non recréée.
 * L111U-E2E-04  Négatifs : deux DPE de même date contradictoires (à confirmer),
 *               DPE remplacé (le plus récent fait foi), document seulement CITÉ
 *               pour un autre bien (exclu), suppression du document (retrait),
 *               deux équipements candidats (ambigu), déclarations N/A refusées.
 */
import { NextRequest } from 'next/server';
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { analyserDocument, fiche, sortieT1, useTargetState, type FaitT1 } from '../chain';
import { proofOf, runCoherenceFor } from '../coherence-run';

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

const DATE = '2025-03-12';

/** Sortie T1 du DPE de recette (faits canoniques + faits génériques sujet / attribut). */
function dpeT1(assetId: number, o: { date?: string; murs?: string; sansRecommandations?: boolean } = {}) {
  const generique = (subject: string, attribute: string, value: string | number, excerpt: string, unit: string | null = null): FaitT1 & { attribute: string } =>
    ({ canonicalKey: null, rawKey: `${subject} ${attribute}`, subject, attribute, value, valueType: typeof value === 'number' ? 'number' : 'string', unit, excerpt, assetId });
  const facts: Array<FaitT1 & { attribute?: string }> = [
    { canonicalKey: 'dpeClass', value: 'D', valueType: 'string', excerpt: 'Classe énergie : D', assetId, subject: 'DPE' },
    { canonicalKey: 'gesClass', value: 'E', valueType: 'string', excerpt: 'Classe climat : E', assetId, subject: 'DPE' },
    { canonicalKey: 'energyConsumption', value: 231, valueType: 'number', unit: 'kWh/m2/an', excerpt: 'Consommation : 231 kWh/m²/an', assetId },
    { canonicalKey: 'gesEmissions', value: 48, valueType: 'number', unit: 'kg CO2/m2/an', excerpt: 'Émissions : 48 kg CO2/m²/an', assetId },
    { canonicalKey: 'dpeDate', value: o.date ?? DATE, valueType: 'date', excerpt: `Établi le ${o.date ?? DATE}`, assetId, subject: 'DPE', semanticEvent: { type: 'dpe', nature: 'HISTORICAL' } },
    { canonicalKey: 'dpeAdemeNumber', value: '2569E0123456X', valueType: 'string', excerpt: 'N° ADEME : 2569E0123456X', assetId },
    generique('Murs extérieurs', 'Isolant', o.murs ?? 'Laine de verre', `Murs : ${o.murs ?? 'Laine de verre'}`),
    generique('Murs extérieurs', 'Épaisseur', 10, 'Murs : épaisseur 10 cm', 'cm'),
    generique('Murs extérieurs', 'Résistance thermique', 2.5, 'Murs : R = 2,5 m².K/W', 'm2.K/W'),
    generique('Combles perdus', 'Isolant', 'Laine soufflée', 'Combles : laine soufflée'),
    generique('Combles perdus', 'Résistance thermique', 7, 'Combles : R = 7', 'm2.K/W'),
    generique('Menuiseries', 'Type de vitrage', 'Double vitrage PVC', 'Menuiseries : double vitrage PVC'),
    generique('Chauffage', 'Type', 'Chaudière gaz à condensation', 'Chauffage : chaudière gaz à condensation'),
    generique('Chauffage', 'Énergie', 'Gaz naturel', 'Énergie : gaz naturel'),
    generique('Chauffage', 'Puissance', 24, 'Puissance 24 kW', 'kW'),
    generique('Eau chaude sanitaire', 'Type', 'Ballon électrique 200 L', 'ECS : ballon électrique 200 L'),
    generique('Eau chaude sanitaire', 'Énergie', 'Électricité', 'ECS : électricité'),
    generique('Ventilation', 'Type', 'VMC simple flux hygroréglable', 'Ventilation : VMC simple flux'),
    // Plancher bas : AUCUNE description d'isolation dans ce DPE (AC09).
  ];
  if (!o.sansRecommandations) {
    facts.push(generique('Combles', 'Isolation recommandée', 'Laine soufflée 30 cm', 'Recommandation : isoler les combles (30 cm)'));
    facts.push({ ...generique('Chauffage', 'Type', 'Pompe à chaleur air/eau', 'Scénario 2 : PAC air/eau'), label: 'Scénario 2 — après travaux' });
  }
  const out = sortieT1({
    title: 'Diagnostic de performance énergétique', date: o.date ?? DATE, documentTypeCode: 'DPE', canonicalType: 'DPE', rubricCode: 'COMPLIANCE_CONTROLS',
    assets: [{ id: assetId, label: 'Appartement' }], multiAsset: false, facts: facts as FaitT1[],
  }) as { facts: Array<Record<string, unknown>> };
  // `sortieT1` ne porte pas l'attribut : complété ici (contrat t1Fact : sujet / attribut / valeur / unité).
  out.facts = out.facts.map((f, i) => ({ ...f, attribute: facts[i].attribute ?? null, valueUnit: facts[i].unit ?? null }));
  return out as Record<string, unknown>;
}

scenario('L111U', 'CIL : DPE → T1 → T3 → structures CIL → Informations → PDF', ({ sql, make, useRecordings }) => {
  useTargetState();

  const logement = async () => {
    const compte = await make.account({ plan: 'premium' });
    const bien = await make.asset(compte, { category: 'IMMOBILIER', name: 'Appartement L111U' });
    await sql`UPDATE assets SET subtype = 'Appartement', address = '12 rue des Lilas', postal_code = '69003', city = 'Lyon' WHERE id = ${bien.id}`;
    session.currentAccountId = compte.id; session.userId = compte.ownerUserId;
    return { compte, bien };
  };
  const analyser = async (c: { id: number; ownerUserId: number }, assetId: number, output: Record<string, unknown>) => {
    const f = await make.assetFile(c as never, { assetId });
    await analyserDocument(sql, useRecordings, { accountId: c.id, userId: c.ownerUserId, fileId: f.id, linkedAssetId: assetId, output });
    return f.id;
  };
  const etat = async (c: { id: number }, assetId: number) => {
    const { getCilState } = await import('@/services/cil/state');
    return (await getCilState({ id: assetId, accountId: c.id }))!.state;
  };
  const item = (s: Awaited<ReturnType<typeof etat>>, id: string) => s.blocks.flatMap((b) => b.items).find((i) => i.id === id)!;
  const materiaux = async (assetId: number) => sql<{ category: string; material_nature: string | null; thickness_mm: number | null; r: number | null; origin: string; installation_state: string | null; source_file_id: number | null }[]>`
    SELECT category, material_nature, thickness_mm, thermal_resistance_r::float8 AS r, origin, installation_state, source_file_id FROM energy_materials WHERE asset_id = ${assetId} ORDER BY category, id`;
  const equipements = async (assetId: number) => sql<{ id: number; name: string; category: string | null; energy_type: string | null; power_kw: number | null; field_origins: Record<string, string> | null }[]>`
    SELECT e.id, e.name, e.category, s.energy_type, s.power_kw::float8 AS power_kw, s.field_origins FROM equipments e LEFT JOIN equipment_cil_specs s ON s.equipment_id = e.id
     WHERE e.asset_id = ${assetId} AND e.archived_at IS NULL ORDER BY e.id`;
  const projeter = async (c: { id: number }, assetId: number) => {
    const { projectCilDocumentsForAsset } = await import('@/services/cil/projection/document-projection');
    return projectCilDocumentsForAsset({ accountId: c.id, assetId });
  };
  const rendu = async (c: { id: number; ownerUserId: number }, assetId: number) => {
    const { loadExportSource } = await import('@/services/exports/v12/data/source');
    const { buildPreparation } = await import('@/services/exports/v12/preparation/prepare');
    const { mapDossierData } = await import('@/services/exports/v12/data/mappers');
    const { buildDefaultChoices, planSelection } = await import('@/services/exports/v12/data/choices');
    const source = await loadExportSource({ assetId, accountId: c.id, userId: c.ownerUserId, exportType: 'CIL' });
    const today = '2026-11-05';
    const prep = buildPreparation('CIL', source, { today, lastGeneration: null }).cil!;
    const plan = planSelection('CIL', source, buildDefaultChoices('CIL', source, { today }), today);
    const data = mapDossierData('CIL', { source, plan, resolved: null, meta: { reference: 'VBN-E2E-111U', generatedAt: '2026-11-05T09:00:00+01:00', preparedBy: null, templateLabel: 't', zipName: null, label: 'T' }, today }) as {
      cil: { blocks: Array<{ code: string; status: string; source: string | null }>; materials: Array<{ post: string; material: string | null; spec: string | null; source: string | null }>;
        equipments: Array<{ equipment: string }>; works: unknown[]; energy: Record<string, string | null> };
    };
    return { prep, data };
  };


  /** Connaissance T1 persistée (extraction + faits génériques), comme après une analyse. */
  const connaissance = async (c: { id: number }, fileId: number, faits: Array<{ subject: string; attribute: string; value: string | number; unit?: string; label?: string }>) => {
    const [x] = await sql<{ id: number }[]>`INSERT INTO document_extractions (account_id, file_id, full_text, full_text_chars) VALUES (${c.id}, ${fileId}, 'e2e', 3)
      ON CONFLICT (file_id) DO UPDATE SET updated_at = now() RETURNING id`;
    await sql`UPDATE document_facts SET status = 'superseded' WHERE file_id = ${fileId}`;
    for (const f of faits) {
      await sql`INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, subject, attribute, label, value_text, value_number, value_unit, normalized_value, confidence, excerpt, target_type)
        VALUES (${c.id}, ${fileId}, ${x.id}, ${`${f.subject} ${f.attribute}`}, ${f.subject}, ${f.attribute}, ${f.label ?? null},
                ${typeof f.value === 'string' ? f.value : null}, ${typeof f.value === 'number' ? f.value : null}, ${f.unit ?? null},
                ${String(f.value)}, 'certain', ${`${f.subject} : ${f.value}`}, 'ASSET')`;
    }
  };
  const piece = async (c: { id: number; ownerUserId: number }, assetId: number, code: string, date: string) => {
    const f = await make.assetFile(c as never, { assetId });
    await sql`UPDATE asset_files SET document_type_code = ${code}, document_date = ${date}, retained_title = ${`${code} ${date}`} WHERE id = ${f.id}`;
    return f.id;
  };
  const operation = async (c: { id: number }, assetId: number, o: { status: 'REALIZED' | 'ENVISAGED'; date: string | null; fileId: number; role: string; label?: string; provider?: string }) => {
    const [op] = await sql<{ id: number }[]>`INSERT INTO business_operations (account_id, type_code, status, realized_date, planned_date, technical_label, provider)
      VALUES (${c.id}, 'INTERVENTION', ${o.status}, ${o.status === 'REALIZED' ? o.date : null}, ${o.status === 'ENVISAGED' ? o.date : null}, ${o.label ?? null}, ${o.provider ?? null}) RETURNING id::int AS id`;
    await sql`INSERT INTO business_operation_sources (account_id, operation_id, source_kind, source_entity_key, authority, source_role)
      VALUES (${c.id}, ${op.id}, 'DOCUMENT', ${String(o.fileId)}, 'DOCUMENT', ${o.role})`;
    await sql`INSERT INTO business_operation_asset_links (account_id, operation_id, asset_id, link_role, authority) VALUES (${c.id}, ${op.id}, ${assetId}, 'PRIMARY', 'DOCUMENT')`;
    await sql`INSERT INTO business_operation_documents (account_id, operation_id, file_id, origins) VALUES (${c.id}, ${op.id}, ${o.fileId}, ARRAY['SOURCE'])
      ON CONFLICT (operation_id, file_id) DO NOTHING`;
    return op.id;
  };

  it('L111U-E2E-01 — DPE de recette : T1 → T3 → tables CIL → Informations = préparation = PDF ; aucun fait inventé', async () => {
    const { compte, bien } = await logement();
    const dpe = await analyser(compte, bien.id, dpeT1(bien.id));
    const [f] = await sql<{ document_type_code: string | null }[]>`SELECT document_type_code FROM asset_files WHERE id = ${dpe}`;
    expect(f.document_type_code).toBe('DPE');

    // Champs canoniques du bien (T3 du registre).
    expect(await fiche(sql, bien.id)).toMatchObject({ dpeClass: 'D', gesClass: 'E', energyConsumption: 231, gesEmissions: 48, dpeDate: DATE, dpeAdemeNumber: '2569E0123456X' });

    // B5 : matériaux constatés, sourcés ; AUCUN plancher bas (non décrit).
    expect(await materiaux(bien.id)).toEqual([
      { category: 'murs_exterieurs', material_nature: 'Laine de verre', thickness_mm: 100, r: 2.5, origin: 'DOCUMENT', installation_state: 'constate', source_file_id: dpe },
      { category: 'parois_vitrees', material_nature: 'Double vitrage PVC', thickness_mm: null, r: null, origin: 'DOCUMENT', installation_state: 'constate', source_file_id: dpe },
      { category: 'toiture', material_nature: 'Laine soufflée', thickness_mm: null, r: 7, origin: 'DOCUMENT', installation_state: 'constate', source_file_id: dpe },
    ]);

    // B6 : un équipement par usage décrit ; la PAC du scénario de travaux n'est PAS créée.
    const eq = await equipements(bien.id);
    expect(eq.map((e) => [e.name, e.category, e.energy_type])).toEqual([
      ['Chaudière gaz à condensation', 'chauffage', 'Gaz naturel'],
      ['Ballon électrique 200 L', 'ecs', 'Électricité'],
      ['VMC simple flux hygroréglable', 'ventilation', null],
    ]);
    expect(eq[0]).toMatchObject({ power_kw: 24, field_origins: { energy_type: 'DOCUMENT', power_kw: 'DOCUMENT' } });

    // B7 : recommandations tracées, jamais des travaux réalisés.
    expect(await sql`SELECT 1 FROM energy_works WHERE asset_id = ${bien.id}`).toHaveLength(0);
    const [rec] = await sql<{ status: string }[]>`SELECT status FROM cil_projection_journal WHERE asset_id = ${bien.id} AND projection_key = ${`cil:rec:${dpe}`}`;
    expect(rec.status).toBe('RECOMMENDATION_ONLY');

    // Informations (état commun, route réelle).
    const { GET } = await import('@/app/api/assets/[id]/cil-checklist/route');
    const res = await GET(new NextRequest(`http://x/api/assets/${bien.id}/cil-checklist`), { params: Promise.resolve({ id: String(bien.id) }) });
    expect(res.status).toBe(200);
    const s = (await res.json()).state as Awaited<ReturnType<typeof etat>>;
    expect(item(s, 'B8.dpeDocument')).toMatchObject({ status: 'renseigne', values: [{ source: { kind: 'document', fileId: dpe } }] });
    expect(item(s, 'B8.dpeClass').values[0]).toMatchObject({ value: 'D', source: { fileId: dpe } });
    expect(item(s, 'B5.murs_exterieurs')).toMatchObject({ status: 'renseigne', values: [{ source: { fileId: dpe } }] });
    expect(item(s, 'B5.parois_vitrees').status).toBe('partiel');
    expect(item(s, 'B5.planchers_bas').status).toBe('manquant');
    expect(item(s, 'B6.chauffage').status).toBe('renseigne');
    expect(item(s, 'B4.gaz')).toMatchObject({ status: 'manquant', counted: true }); // gaz connu (chaudière gaz) : plan attendu, jamais N/A
    expect(item(s, 'B7.works').values).toEqual([]);
    expect(s.recommendations.count).toBe(1);
    expect(s.regulatory.percentage).toBeLessThan(100); // un DPE ne rend pas le carnet complet

    // Préparation et PDF : mêmes données, mêmes sources, sans ressaisie.
    const { prep, data } = await rendu(compte, bien.id);
    expect(prep.blocks.find((b) => b.id === 'B8')).toMatchObject({ status: 'complete', blocksGeneration: false });
    expect(prep.blocks.find((b) => b.id === 'B5')!.cilMissing).toEqual(expect.arrayContaining(['Planchers bas']));
    expect(data.cil.energy).toMatchObject({ dpe: 'D', ges: 'E', emissions: '48 kg CO₂/m²/an', date: DATE });
    expect(data.cil.materials.map((m) => m.post).sort()).toEqual(['Murs extérieurs', 'Parois vitrées', 'Toiture / combles']);
    expect(data.cil.materials.every((m) => /DPE|Diagnostic/.test(m.source ?? ''))).toBe(true);
    expect(data.cil.equipments.map((e) => e.equipment)).toEqual(eq.map((e) => e.name));
    expect(data.cil.works).toEqual([]);
    expect(data.cil.blocks.find((b) => b.code === 'B5')!.source).toBe('3 matériaux · à compléter : Parois vitrées et portes extérieures, Planchers bas');
  });

  it('L111U-E2E-02 — deuxième passage T3 et réimport identique : aucune écriture', async () => {
    const { compte, bien } = await logement();
    const dpe = await analyser(compte, bien.id, dpeT1(bien.id));
    const avant = { m: await materiaux(bien.id), e: await equipements(bien.id), j: await sql`SELECT projection_key, status, updated_at FROM cil_projection_journal WHERE asset_id = ${bien.id} ORDER BY 1` };
    const r = await projeter(compte, bien.id);
    expect(r).toMatchObject({ changed: false, journalChanges: 0, createdEquipmentIds: [] });
    // Réanalyse du même document, même sortie.
    await analyserDocument(sql, useRecordings, { accountId: compte.id, userId: compte.ownerUserId, fileId: dpe, linkedAssetId: bien.id, output: dpeT1(bien.id) });
    expect(await materiaux(bien.id)).toEqual(avant.m);
    expect((await equipements(bien.id)).map((e) => e.id)).toEqual(avant.e.map((e) => e.id));
    expect((await sql`SELECT projection_key, status FROM cil_projection_journal WHERE asset_id = ${bien.id} ORDER BY 1`).map((x) => x.status))
      .toEqual(avant.j.map((x) => x.status));
  });

  it('L111U-E2E-03 — rattrapage du stock (contrôle de cohérence) ; USER protégée ; suppression utilisateur respectée', async () => {
    const { compte, bien } = await logement();
    // Saisie USER préalable sur la toiture, divergente du DPE.
    await sql`INSERT INTO energy_materials (asset_id, category, material_nature, thermal_resistance_r) VALUES (${bien.id}, 'toiture', 'Ouate de cellulose', 8)`;
    const dpe = await analyser(compte, bien.id, dpeT1(bien.id, { sansRecommandations: true }));
    // Stock « historique » : la projection n'a jamais eu lieu (on retire ses écritures).
    await sql`DELETE FROM energy_materials WHERE asset_id = ${bien.id} AND origin = 'DOCUMENT'`;
    await sql`DELETE FROM equipments WHERE asset_id = ${bien.id}`;
    await sql`DELETE FROM cil_projection_journal WHERE asset_id = ${bien.id}`;

    const blanc = await runCoherenceFor(sql, [compte.id], { mode: 'DRY_RUN' });
    expect(blanc.results['COH-CIL-DOCUMENT-PROJECTION']).toMatchObject({ WOULD_REPAIR: 1 });
    expect(await materiaux(bien.id)).toHaveLength(1);

    const corr = await runCoherenceFor(sql, [compte.id], { mode: 'CORRECTIVE' });
    expect(corr.results['COH-CIL-DOCUMENT-PROJECTION']).toMatchObject({ REPAIRED: 1 });
    const m = await materiaux(bien.id);
    expect(m.find((x) => x.category === 'toiture')).toMatchObject({ origin: 'USER', material_nature: 'Ouate de cellulose', r: 8 });
    expect(m.filter((x) => x.category === 'toiture')).toHaveLength(1);
    const [j] = await sql<{ status: string; reason: string }[]>`SELECT status, reason FROM cil_projection_journal WHERE asset_id = ${bien.id} AND projection_key = 'cil:mat:toiture'`;
    expect(j).toEqual({ status: 'PROTECTED', reason: 'USER_VALUE_DIFFERS' });

    // Idempotent : la campagne suivante ne trouve plus rien.
    const encore = await runCoherenceFor(sql, [compte.id], { mode: 'CORRECTIVE' });
    expect(encore.results['COH-CIL-DOCUMENT-PROJECTION']).toMatchObject({ CONSISTENT: 1 });
    expect((await proofOf(sql, compte.id, 'COH-CIL-DOCUMENT-PROJECTION', bien.id))?.last_result).toBe('CONSISTENT');

    // L'utilisateur supprime la ligne DOCUMENT des murs : elle n'est pas recréée (source inchangée).
    await sql`DELETE FROM energy_materials WHERE asset_id = ${bien.id} AND category = 'murs_exterieurs'`;
    await projeter(compte, bien.id);
    expect((await materiaux(bien.id)).some((x) => x.category === 'murs_exterieurs')).toBe(false);
    expect(dpe).toBeGreaterThan(0);
  });

  it('L111U-E2E-04 — négatifs : contradiction, DPE remplacé, bien seulement cité, suppression, ambiguïté, N/A refusés', async () => {
    const { compte, bien } = await logement();
    // Deux DPE de même date, murs contradictoires → à confirmer, rien d'écrit pour les murs.
    const a = await analyser(compte, bien.id, dpeT1(bien.id, { sansRecommandations: true }));
    const b = await analyser(compte, bien.id, dpeT1(bien.id, { murs: 'Polystyrène', sansRecommandations: true }));
    await projeter(compte, bien.id);
    let s = await etat(compte, bien.id);
    expect(item(s, 'B5.murs_exterieurs').status).toBe('a_confirmer');
    // La valeur déjà prouvée (premier DPE) n'est ni effacée ni remplacée par la source contradictoire.
    expect((await materiaux(bien.id)).filter((x) => x.category === 'murs_exterieurs')).toEqual([expect.objectContaining({ material_nature: 'Laine de verre', source_file_id: a })]);
    expect(s.blocks.find((x) => x.id === 'B8')!.notice).toMatch(/2 DPE/);

    // DPE remplacé : le second devient plus récent → il fait foi (le premier reste consultable).
    await sql`UPDATE asset_files SET document_date = '2026-01-15' WHERE id = ${b}`;
    await projeter(compte, bien.id);
    expect((await materiaux(bien.id)).find((x) => x.category === 'murs_exterieurs')).toMatchObject({ material_nature: 'Polystyrène', source_file_id: b });

    // Suppression du document qui fait foi : le premier reprend la main (dates cohérentes, aucune valeur effacée à l'aveugle).
    await sql`UPDATE asset_files SET deleted_at = now() WHERE id = ${b}`;
    await projeter(compte, bien.id);
    expect((await materiaux(bien.id)).find((x) => x.category === 'murs_exterieurs')).toMatchObject({ material_nature: 'Laine de verre', source_file_id: a });
    s = await etat(compte, bien.id);
    expect(s.documents.some((d) => d.id === b)).toBe(false);

    // Bien seulement CITÉ (MENTIONED) par un DPE d'un autre logement : rien n'y est projeté.
    const autre = await make.asset(compte, { category: 'IMMOBILIER', name: 'Voisin' });
    await sql`INSERT INTO document_asset_links (account_id, file_id, asset_id, link_role, status, origin) VALUES (${compte.id}, ${a}, ${autre.id}, 'MENTIONED', 'ACTIVE', 'USER')`;
    const r = await projeter(compte, autre.id);
    expect(r.sourceDocuments).toBe(0);
    expect(await materiaux(autre.id)).toEqual([]);

    // Deux équipements de chauffage existants : ambigu, aucun complément.
    const voisin2 = await logement();
    await sql`INSERT INTO equipments (asset_id, name, type) VALUES (${voisin2.bien.id}, 'Chaudière A', 'Chaudière'), (${voisin2.bien.id}, 'Chaudière B', 'Chaudière')`;
    await analyser(voisin2.compte, voisin2.bien.id, dpeT1(voisin2.bien.id, { sansRecommandations: true }));
    const [amb] = await sql<{ status: string }[]>`SELECT status FROM cil_projection_journal WHERE asset_id = ${voisin2.bien.id} AND projection_key = 'cil:eq:chauffage'`;
    expect(amb.status).toBe('AMBIGUOUS');
    expect((await equipements(voisin2.bien.id)).filter((e) => e.energy_type)).toHaveLength(1); // seul le ballon ECS créé porte une énergie

    // Déclarations « Non applicable » : DPE jamais ; donnée renseignée refusée ; gaz autorisé.
    const { PATCH } = await import('@/app/api/assets/[id]/exports/cil/resolutions/route');
    const declarer = (blockId: string) => PATCH(new NextRequest('http://x', { method: 'PATCH', body: JSON.stringify({ blockId, resolution: 'not_applicable', justification: 'test' }) }), { params: Promise.resolve({ id: String(voisin2.bien.id) }) });
    expect((await declarer('B8')).status).toBe(400);
    expect((await declarer('B8.dpeDocument')).status).toBe(400);
    expect((await declarer('B6.ecs')).status).toBe(409);
    expect((await declarer('B6.refroidissement')).status).toBe(200);
    expect(item(await etat(voisin2.compte, voisin2.bien.id), 'B6.refroidissement').status).toBe('non_applicable');
  });

  it('L111U-E2E-05 — B7 : intervention réalisée prouvée par facture ; devis, sans facture, non énergétique : jamais réalisés', async () => {
    const { compte, bien } = await logement();
    // Facture d'isolation des combles : Opération réalisée, source facture.
    const facture = await piece(compte, bien.id, 'WORKS_INVOICE', '2024-10-02');
    await connaissance(compte, facture, [{ subject: 'Combles perdus', attribute: 'Isolant', value: 'Laine soufflée' }, { subject: 'Combles perdus', attribute: 'Résistance thermique', value: 7, unit: 'm2.K/W' }]);
    const realise = await operation(compte, bien.id, { status: 'REALIZED', date: '2024-10-02', fileId: facture, role: 'INVOICE', label: 'Isolation des combles', provider: 'Iso Plus' });
    // Devis de pompe à chaleur : envisagé.
    const devis = await piece(compte, bien.id, 'WORKS_QUOTE', '2025-02-01');
    await connaissance(compte, devis, [{ subject: 'Chauffage', attribute: 'Type', value: 'Pompe à chaleur air/eau' }]);
    const envisage = await operation(compte, bien.id, { status: 'ENVISAGED', date: '2025-06-01', fileId: devis, role: 'QUOTE' });
    // « Réalisée » sans facture ni attestation (commande seulement).
    const commande = await piece(compte, bien.id, 'WORKS_PURCHASE_ORDER', '2025-03-01');
    await connaissance(compte, commande, [{ subject: 'Ventilation', attribute: 'Type', value: 'VMC double flux' }]);
    const nonProuve = await operation(compte, bien.id, { status: 'REALIZED', date: '2025-03-15', fileId: commande, role: 'ORDER' });
    // Intervention réalisée NON énergétique (peinture).
    const peinture = await piece(compte, bien.id, 'WORKS_INVOICE', '2025-04-01');
    await connaissance(compte, peinture, [{ subject: 'Peinture', attribute: 'Surface', value: 40, unit: 'm2' }]);
    await operation(compte, bien.id, { status: 'REALIZED', date: '2025-04-01', fileId: peinture, role: 'INVOICE' });
    const versions = await sql`SELECT id, version, status FROM business_operations WHERE account_id = ${compte.id} ORDER BY id`;

    await projeter(compte, bien.id);
    const journal = await sql<{ projection_key: string; status: string; reason: string }[]>`
      SELECT projection_key, status, reason FROM cil_projection_journal WHERE asset_id = ${bien.id} AND projection_key LIKE 'cil:work:%' ORDER BY projection_key`;
    expect(journal).toEqual(expect.arrayContaining([
      { projection_key: `cil:work:${realise}`, status: 'WRITTEN', reason: 'REALIZED_ENERGY_WORK' },
      { projection_key: `cil:work:${envisage}`, status: 'ABSTAINED', reason: 'NOT_REALIZED' },
      { projection_key: `cil:work:${nonProuve}`, status: 'ABSTAINED', reason: 'REALIZATION_NOT_PROVEN' },
    ]));
    expect(journal).toHaveLength(3); // la peinture n'est pas un travail énergétique

    const s = await etat(compte, bien.id);
    expect(item(s, 'B7.works')).toMatchObject({ status: 'renseigne', values: [{ label: 'Isolation des combles', source: { kind: 'document', fileId: facture } }] });
    expect(item(s, 'B7.works').reason).toMatch(/2 intervention\(s\) énergétique\(s\) envisagée\(s\) ou sans facture/);
    expect(s.works).toEqual([expect.objectContaining({ kind: 'operation', id: realise, categories: ['isolation_toiture'], company: 'Iso Plus', date: '2024-10-02' })]);
    // Opérations réutilisées telles quelles ; aucune ligne energy_works ; le devis ne crée ni équipement ni matériau.
    expect(await sql`SELECT id, version, status FROM business_operations WHERE account_id = ${compte.id} ORDER BY id`).toEqual(versions);
    expect(await sql`SELECT 1 FROM energy_works WHERE asset_id = ${bien.id}`).toHaveLength(0);
    expect(await equipements(bien.id)).toEqual([]);

    const { prep, data } = await rendu(compte, bien.id);
    expect(prep.blocks.find((b) => b.id === 'B7')!.status).toBe('complete');
    expect(data.cil.works).toEqual([expect.objectContaining({ title: 'Isolation des combles', date: '2024-10-02', company: 'Iso Plus' })]);

    // Idempotent ; Opération invalidée (fusion, erreur) : qualification retirée.
    expect(await projeter(compte, bien.id)).toMatchObject({ journalChanges: 0 });
    await sql`UPDATE business_operations SET invalidated_at = now(), invalidation_reason = 'e2e' WHERE id = ${realise}`;
    await projeter(compte, bien.id);
    expect((await etat(compte, bien.id)).works).toEqual([]);
  });

  it('L111U-E2E-06 — coefficient U stocké et imprimé ; B2 depuis un fait explicite, USER protégée, contradiction, retrait', async () => {
    const { compte, bien } = await logement();
    const dpe = await piece(compte, bien.id, 'DPE', '2025-05-10');
    await connaissance(compte, dpe, [
      { subject: 'Menuiseries', attribute: 'Type de vitrage', value: 'Double vitrage' },
      { subject: 'Menuiseries', attribute: 'Uw', value: 1.4, unit: 'W/m2.K' },
    ]);
    await projeter(compte, bien.id);
    const [mat] = await sql<{ u: number | null; r: number | null }[]>`SELECT u_value::float8 AS u, thermal_resistance_r::float8 AS r FROM energy_materials WHERE asset_id = ${bien.id} AND category = 'parois_vitrees'`;
    expect(mat).toEqual({ u: 1.4, r: null });
    expect(item(await etat(compte, bien.id), 'B5.parois_vitrees').status).toBe('renseigne');
    expect((await rendu(compte, bien.id)).data.cil.materials.find((m) => m.post === 'Parois vitrées')!.spec).toContain('U = 1,4 W/(m²·K)');

    // B2 : sans fait explicite, le motif reste à saisir.
    expect(item(await etat(compte, bien.id), 'B2.trigger').status).toBe('manquant');
    expect(await sql`SELECT 1 FROM asset_cil_profiles WHERE asset_id = ${bien.id}`).toHaveLength(0);

    // Document qui établit le carnet : motif et date.
    const carnet = await piece(compte, bien.id, 'OTHER_DOCUMENT', '2025-09-01');
    await connaissance(compte, carnet, [
      { subject: 'Carnet d’information du logement', attribute: 'Motif', value: 'Rénovation énergétique' },
      { subject: 'Carnet d’information du logement', attribute: 'Date de constitution', value: '2025-09-01' },
    ]);
    await projeter(compte, bien.id);
    const profil = async () => (await sql<{ trigger_type: string; d: string | null; origin: string; source_file_id: number | null }[]>`
      SELECT trigger_type, to_char(trigger_date, 'YYYY-MM-DD') AS d, origin, source_file_id FROM asset_cil_profiles WHERE asset_id = ${bien.id}`)[0];
    expect(await profil()).toEqual({ trigger_type: 'renovation_energetique', d: '2025-09-01', origin: 'DOCUMENT', source_file_id: carnet });
    expect(item(await etat(compte, bien.id), 'B2.trigger')).toMatchObject({ status: 'renseigne', values: [{ source: { fileId: carnet } }] });

    // Document supprimé : profil DOCUMENT retiré, le motif redevient à saisir.
    await sql`UPDATE asset_files SET deleted_at = now() WHERE id = ${carnet}`;
    await projeter(compte, bien.id);
    expect(await profil()).toBeUndefined();

    // Saisie USER (route réelle) puis document contraire : la saisie est conservée.
    const { POST } = await import('@/app/api/assets/[id]/cil-profile/route');
    const res = await POST(new NextRequest('http://x', { method: 'POST', body: JSON.stringify({ triggerType: 'volontaire', triggerDate: '2025-10-01' }) }), { params: Promise.resolve({ id: String(bien.id) }) });
    expect(res.status).toBe(200);
    const autre = await piece(compte, bien.id, 'OTHER_DOCUMENT', '2025-11-01');
    await connaissance(compte, autre, [{ subject: 'Carnet d’information du logement', attribute: 'Motif', value: 'Construction neuve' }]);
    await projeter(compte, bien.id);
    expect(await profil()).toMatchObject({ trigger_type: 'volontaire', d: '2025-10-01', origin: 'USER' });
    const [j] = await sql<{ status: string; reason: string }[]>`SELECT status, reason FROM cil_projection_journal WHERE asset_id = ${bien.id} AND projection_key = 'cil:profile'`;
    expect(j).toEqual({ status: 'PROTECTED', reason: 'USER_VALUE_DIFFERS' });

    // Autre logement : deux documents contradictoires → à confirmer, rien d'écrit.
    const v = await logement();
    for (const motif of ['Rénovation énergétique', 'Démarche volontaire']) {
      const f = await piece(v.compte, v.bien.id, 'OTHER_DOCUMENT', '2025-09-01');
      await connaissance(v.compte, f, [{ subject: 'Carnet d’information du logement', attribute: 'Motif', value: motif }]);
    }
    await projeter(v.compte, v.bien.id);
    expect(await sql`SELECT 1 FROM asset_cil_profiles WHERE asset_id = ${v.bien.id}`).toHaveLength(0);
    expect(item(await etat(v.compte, v.bien.id), 'B2.trigger').status).toBe('a_confirmer');
  });
});
