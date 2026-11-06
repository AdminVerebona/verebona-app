/**
 * Lot 112F — CIL : facture / attestation de travaux RÉALISÉS → B5 « posé »
 * (date de pose, performances prouvées) et B6 (équipement posé), rattachés à
 * l'Opération d'intervention prouvée (même identité que B7, aucune ligne
 * energy_works) ; déclenchement depuis les écritures d'Opérations par le
 * contrôle de cohérence ciblé existant (PostgreSQL réel, écritures
 * d'Opérations par le service de production `withBusinessOperationWrite`).
 *
 * L112F-E2E-01  Facture d'isolation réalisée : matériau posé (date de pose = date de
 *               réalisation, R, épaisseur, source = facture), Opération inchangée,
 *               même identité que B7 ; devis (Opération envisagée) et devis joint à
 *               l'Opération réalisée : jamais posés ; Informations = préparation =
 *               PDF ; idempotent ; saisie USER protégée ; PAC posée → équipement créé
 *               avec date de pose ; Opération invalidée → pose retirée.
 * L112F-E2E-02  Négatifs : attestation sans date (partiel « date de pose »), facture
 *               et attestation contradictoires (à confirmer, rien d'écrit),
 *               équipement existant du même usage sans preuve d'identité (à
 *               confirmer, aucun équipement créé), équipement RATTACHÉ à
 *               l'Opération complété (champs vides seulement).
 * L112F-E2E-03  Déclenchement : création / réalisation + justificatif / invalidation /
 *               fusion d'une Opération → bus des Opérations → demande DURABLE du
 *               contrôle ciblé COH-CIL-DOCUMENT-PROJECTION sur le bien → passage
 *               ciblé correctif → B5 / B7 à jour, sans passage T3 du bien.
 */
import { afterAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

const CHECK = 'COH-CIL-DOCUMENT-PROJECTION';

scenario('L112F', 'CIL : travaux réalisés → matériaux / équipements posés ; déclenchement par les Opérations', ({ sql, make }) => {
  type Compte = { id: number; ownerUserId: number };
  const logement = async () => {
    const compte = await make.account({ plan: 'premium' });
    const bien = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison L112F' });
    await sql`UPDATE assets SET subtype = 'Maison', address = '3 allée des Tilleuls', postal_code = '44000', city = 'Nantes' WHERE id = ${bien.id}`;
    return { compte, bien };
  };
  /** Connaissance T1 persistée (faits génériques sujet / attribut), comme après l'analyse de la pièce. */
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
  const piece = async (c: Compte, assetId: number, code: string, date: string) => {
    const f = await make.assetFile(c as never, { assetId });
    await sql`UPDATE asset_files SET document_type_code = ${code}, document_date = ${date}, retained_title = ${`${code} ${date}`} WHERE id = ${f.id}`;
    return f.id;
  };
  /** Opération d'intervention par le service d'écriture de production (événements publiés après commit). */
  const intervention = async (c: { id: number }, assetId: number, o: { status: 'REALIZED' | 'ENVISAGED'; date: string | null; fileId: number; role: 'INVOICE' | 'REPORT' | 'QUOTE'; label: string; equipmentId?: number }) => {
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    return (await withBusinessOperationWrite(c.id, (repo) => repo.create({
      type: { code: 'INTERVENTION' }, status: o.status, realizedDate: o.status === 'REALIZED' ? o.date : null, plannedDate: o.status === 'ENVISAGED' ? o.date : null,
      technicalLabel: o.label, provider: 'Éco Habitat',
      source: { kind: 'DOCUMENT', entityKey: o.fileId, role: o.role, authority: 'DOCUMENT', confidence: 'certain' },
      assets: [{ assetId, role: 'PRIMARY', authority: 'DOCUMENT' }],
      equipments: o.equipmentId ? [{ equipmentId: o.equipmentId, authority: 'DOCUMENT' }] : [], reasonCode: 'E2E_L112F',
    }))).id;
  };
  const ecrire = async <T>(c: { id: number }, fn: (repo: import('@/services/business-operations/repository').BusinessOperationRepository) => Promise<T>) => {
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    return withBusinessOperationWrite(c.id, fn);
  };
  const projeter = async (c: { id: number }, assetId: number) => {
    const { projectCilDocumentsForAsset } = await import('@/services/cil/projection/document-projection');
    return projectCilDocumentsForAsset({ accountId: c.id, assetId });
  };
  const etat = async (c: { id: number }, assetId: number) => {
    const { getCilState } = await import('@/services/cil/state');
    return (await getCilState({ id: assetId, accountId: c.id }))!.state;
  };
  const item = (s: Awaited<ReturnType<typeof etat>>, id: string) => s.blocks.flatMap((b) => b.items).find((i) => i.id === id)!;
  const poses = async (assetId: number) => sql<{ category: string; material_nature: string | null; r: number | null; thickness_mm: number | null; origin: string; installation_state: string | null;
    installed_at: string | null; operation_id: number | null; source_file_id: number | null }[]>`
    SELECT category, material_nature, thermal_resistance_r::float8 AS r, thickness_mm, origin, installation_state, to_char(installed_at, 'YYYY-MM-DD') AS installed_at,
           operation_id::int AS operation_id, source_file_id FROM energy_materials WHERE asset_id = ${assetId} ORDER BY category, id`;
  const equipements = async (assetId: number) => sql<{ id: number; name: string; brand: string | null; energy_type: string | null; installed_at: string | null; op: number | null }[]>`
    SELECT e.id, e.name, s.brand, s.energy_type, to_char(s.installed_at, 'YYYY-MM-DD') AS installed_at, s.installation_operation_id::int AS op
      FROM equipments e LEFT JOIN equipment_cil_specs s ON s.equipment_id = e.id WHERE e.asset_id = ${assetId} AND e.archived_at IS NULL ORDER BY e.id`;
  const journal = async (assetId: number, prefix: string) => sql<{ projection_key: string; status: string; reason: string | null }[]>`
    SELECT projection_key, status, reason FROM cil_projection_journal WHERE asset_id = ${assetId} AND projection_key LIKE ${`${prefix}%`} ORDER BY projection_key`;
  const rendu = async (c: Compte, assetId: number) => {
    const { loadExportSource } = await import('@/services/exports/v12/data/source');
    const { buildPreparation } = await import('@/services/exports/v12/preparation/prepare');
    const { mapDossierData } = await import('@/services/exports/v12/data/mappers');
    const { buildDefaultChoices, planSelection } = await import('@/services/exports/v12/data/choices');
    const source = await loadExportSource({ assetId, accountId: c.id, userId: c.ownerUserId, exportType: 'CIL' });
    const today = '2026-11-06';
    const prep = buildPreparation('CIL', source, { today, lastGeneration: null }).cil!;
    const plan = planSelection('CIL', source, buildDefaultChoices('CIL', source, { today }), today);
    const data = mapDossierData('CIL', { source, plan, resolved: null, meta: { reference: 'VBN-E2E-112F', generatedAt: '2026-11-06T09:00:00+01:00', preparedBy: null, templateLabel: 't', zipName: null, label: 'T' }, today }) as {
      cil: { blocks: Array<{ code: string; status: string; source: string | null }>; materials: Array<{ post: string; material: string | null; spec: string | null; source: string | null }>;
        equipments: Array<{ equipment: string | null; specs: string | null; installed: string | null }>; works: Array<{ title: string; date: string | null }> };
    };
    return { prep, data };
  };
  const ISOLATION = [
    { subject: 'Isolation des combles perdus', attribute: 'Isolant', value: 'Laine soufflée' },
    { subject: 'Combles perdus', attribute: 'Résistance thermique', value: 7, unit: 'm2.K/W' },
    { subject: 'Combles perdus', attribute: 'Épaisseur', value: 30, unit: 'cm' },
  ];

  it('L112F-E2E-01 — facture d’isolation réalisée : matériau posé (date, performances), même identité que B7 ; devis jamais posé ; USER protégée ; PAC posée ; invalidation', async () => {
    const { compte, bien } = await logement();
    const facture = await piece(compte, bien.id, 'WORKS_INVOICE', '2024-10-02');
    await connaissance(compte, facture, ISOLATION);
    const op = await intervention(compte, bien.id, { status: 'REALIZED', date: '2024-10-02', fileId: facture, role: 'INVOICE', label: 'Isolation des combles' });
    // Devis joint à la même Opération réalisée (valeurs différentes) : jamais une preuve de pose.
    const devisJoint = await piece(compte, bien.id, 'WORKS_QUOTE', '2024-06-01');
    await connaissance(compte, devisJoint, [{ subject: 'Combles perdus', attribute: 'Résistance thermique', value: 5, unit: 'm2.K/W' }]);
    await ecrire(compte, (repo) => repo.addSource(op, { kind: 'DOCUMENT', entityKey: devisJoint, role: 'QUOTE', authority: 'DOCUMENT' }));
    // Devis d'isolation des murs : Opération envisagée.
    const devis = await piece(compte, bien.id, 'WORKS_QUOTE', '2025-02-01');
    await connaissance(compte, devis, [{ subject: 'Murs extérieurs', attribute: 'Isolant', value: 'Polystyrène' }, { subject: 'Murs extérieurs', attribute: 'Résistance thermique', value: 3.7, unit: 'm2.K/W' }]);
    await intervention(compte, bien.id, { status: 'ENVISAGED', date: '2025-06-01', fileId: devis, role: 'QUOTE', label: 'ITE' });
    const versions = await sql`SELECT id, version, status FROM business_operations WHERE account_id = ${compte.id} ORDER BY id`;

    const r = await projeter(compte, bien.id);
    expect(r.changed).toBe(true);
    expect(await poses(bien.id)).toEqual([
      { category: 'toiture', material_nature: 'Laine soufflée', r: 7, thickness_mm: 300, origin: 'DOCUMENT', installation_state: 'installe', installed_at: '2024-10-02', operation_id: op, source_file_id: facture },
    ]);
    expect(await journal(bien.id, 'cil:inst:')).toEqual([{ projection_key: `cil:inst:${op}:toiture`, status: 'WRITTEN', reason: 'INSTALLED' }]);

    // Informations : « posé le … », source = facture ; B7 = la même Opération (une seule identité, aucune copie energy_works).
    const s = await etat(compte, bien.id);
    expect(item(s, 'B5.toiture')).toMatchObject({ status: 'renseigne', values: [{ label: 'Laine soufflée (posé le 2 octobre 2024)', source: { kind: 'document', fileId: facture } }] });
    expect(item(s, 'B5.murs_exterieurs').status).toBe('manquant');
    expect(s.works).toEqual([expect.objectContaining({ kind: 'operation', id: op, date: '2024-10-02' })]);
    expect(await sql`SELECT 1 FROM energy_works WHERE asset_id = ${bien.id}`).toHaveLength(0);
    expect(await sql`SELECT id, version, status FROM business_operations WHERE account_id = ${compte.id} ORDER BY id`).toEqual(versions);

    // Préparation et PDF : même matériau, même travail.
    const { prep, data } = await rendu(compte, bien.id);
    expect(prep.blocks.find((b) => b.id === 'B5')!.status).not.toBe('missing');
    expect(data.cil.materials).toEqual([expect.objectContaining({ material: expect.stringContaining('Laine soufflée'), spec: expect.stringContaining('R = 7') })]);
    // Suite PDF (112F2) : mention « posé », date de pose et intervention source, puis la pièce — même état que l'onglet Informations.
    expect(data.cil.materials[0].source).toMatch(/^Posé le 02\/10\/2024 · intervention « Isolation des combles » · .*02\/10\/2024/);
    expect(data.cil.works).toEqual([expect.objectContaining({ title: 'Isolation des combles', date: '2024-10-02' })]);

    // Idempotent.
    expect(await projeter(compte, bien.id)).toMatchObject({ changed: false, journalChanges: 0 });

    // Saisie USER sur les murs, puis facture d'ITE réalisée : la saisie est conservée, rien n'est ajouté.
    await sql`INSERT INTO energy_materials (asset_id, category, material_nature, thermal_resistance_r) VALUES (${bien.id}, 'murs_exterieurs', 'Laine de bois', 4)`;
    const ite = await piece(compte, bien.id, 'WORKS_INVOICE', '2025-09-15');
    await connaissance(compte, ite, [{ subject: 'Murs extérieurs', attribute: 'Isolant', value: 'Polystyrène graphité' }, { subject: 'Murs extérieurs', attribute: 'Résistance thermique', value: 3.7, unit: 'm2.K/W' }]);
    const opIte = await intervention(compte, bien.id, { status: 'REALIZED', date: '2025-09-15', fileId: ite, role: 'INVOICE', label: 'ITE' });
    await projeter(compte, bien.id);
    expect((await poses(bien.id)).filter((m) => m.category === 'murs_exterieurs')).toEqual([expect.objectContaining({ origin: 'USER', material_nature: 'Laine de bois' })]);
    expect(await journal(bien.id, `cil:inst:${opIte}:`)).toEqual([{ projection_key: `cil:inst:${opIte}:murs_exterieurs`, status: 'PROTECTED', reason: 'USER_VALUE_DIFFERS' }]);
    expect(item(await etat(compte, bien.id), 'B5.murs_exterieurs').reason).toMatch(/votre saisie est conservée/);

    // Pompe à chaleur posée (aucun équipement de chauffage connu) : équipement créé, date de pose et Opération.
    const facturePac = await piece(compte, bien.id, 'WORKS_INVOICE', '2025-11-20');
    await connaissance(compte, facturePac, [
      { subject: 'Pompe à chaleur air/eau', attribute: 'Type', value: 'Pompe à chaleur air/eau' },
      { subject: 'Pompe à chaleur air/eau', attribute: 'Énergie', value: 'Électricité' },
      { subject: 'Pompe à chaleur air/eau', attribute: 'Marque', value: 'Atlantic' },
      { subject: 'Pompe à chaleur air/eau', attribute: 'Puissance', value: 8, unit: 'kW' },
    ]);
    const opPac = await intervention(compte, bien.id, { status: 'REALIZED', date: '2025-11-20', fileId: facturePac, role: 'INVOICE', label: 'Pose PAC' });
    const rp = await projeter(compte, bien.id);
    expect(rp.createdEquipmentIds).toHaveLength(1);
    expect(await equipements(bien.id)).toEqual([{ id: rp.createdEquipmentIds[0], name: 'Pompe à chaleur air/eau', brand: 'Atlantic', energy_type: 'Électricité', installed_at: '2025-11-20', op: opPac }]);
    const b6 = item(await etat(compte, bien.id), 'B6.chauffage');
    expect(b6).toMatchObject({ status: 'renseigne', values: [{ source: { kind: 'document', fileId: facturePac } }] });
    expect(b6.values[0].value).toContain('posé le 20 novembre 2025');
    // PDF : date de pose dans la colonne « Installation », intervention source sous le nom.
    const pdfPac = (await rendu(compte, bien.id)).data.cil.equipments.find((x) => x.equipment === 'Pompe à chaleur air/eau')!;
    expect(pdfPac).toMatchObject({ installed: '2025-11-20', specs: expect.stringContaining('posé · intervention « Pose PAC »') });
    expect(await projeter(compte, bien.id)).toMatchObject({ changed: false, journalChanges: 0 });

    // Opération d'isolation invalidée : la pose est retirée (B5 et B7) ; la PAC reste.
    await ecrire(compte, (repo) => repo.invalidate(op, 'E2E_ERREUR'));
    await projeter(compte, bien.id);
    expect((await poses(bien.id)).filter((m) => m.category === 'toiture')).toEqual([]);
    expect(await journal(bien.id, `cil:inst:${op}:`)).toEqual([{ projection_key: `cil:inst:${op}:toiture`, status: 'RETRACTED', reason: 'OPERATION_NO_LONGER_PROVES' }]);
    const apres = await etat(compte, bien.id);
    expect(item(apres, 'B5.toiture').status).toBe('manquant');
    expect((apres.works ?? []).map((w) => w.id)).toEqual([opIte, opPac]);
    expect(await equipements(bien.id)).toHaveLength(1);
  });

  it('L112F-E2E-02 — attestation sans date ; justificatifs contradictoires ; remplacement non prouvé ; équipement rattaché complété', async () => {
    // Attestation de travaux sans date de réalisation.
    const a = await logement();
    const attestation = await piece(a.compte, a.bien.id, 'OTHER_DOCUMENT', '2025-01-10');
    await connaissance(a.compte, attestation, [{ subject: 'Plancher bas', attribute: 'Isolant', value: 'Polyuréthane' }, { subject: 'Plancher bas', attribute: 'Épaisseur', value: 100, unit: 'mm' }]);
    const opA = await intervention(a.compte, a.bien.id, { status: 'REALIZED', date: null, fileId: attestation, role: 'REPORT', label: 'Isolation du plancher bas' });
    await projeter(a.compte, a.bien.id);
    expect(await poses(a.bien.id)).toEqual([expect.objectContaining({ category: 'planchers_bas', installation_state: 'installe', installed_at: null, operation_id: opA, thickness_mm: 100 })]);
    const sa = await etat(a.compte, a.bien.id);
    expect(item(sa, 'B5.planchers_bas')).toMatchObject({ status: 'partiel', missing: ['Planchers bas : date de pose'] });
    expect(item(sa, 'B7.works').status).toBe('partiel');
    // PDF : « Posé · date de pose à compléter », pastille Partiel (112A) qui cite le poste, comme la préparation.
    const ra = await rendu(a.compte, a.bien.id);
    expect(ra.data.cil.materials[0].source).toMatch(/^Posé · date de pose à compléter · intervention « Isolation du plancher bas »/);
    const b5 = ra.data.cil.blocks.find((x) => x.code === 'B5')!;
    expect(b5.status).toBe('partial');
    expect(b5.source).toMatch(/^1 matériau · à compléter : /);

    // Facture et attestation de la même Opération qui se contredisent : rien d'écrit, à confirmer.
    const b = await logement();
    const f1 = await piece(b.compte, b.bien.id, 'WORKS_INVOICE', '2025-03-01');
    await connaissance(b.compte, f1, ISOLATION);
    const f2 = await piece(b.compte, b.bien.id, 'OTHER_DOCUMENT', '2025-03-02');
    await connaissance(b.compte, f2, [{ subject: 'Combles perdus', attribute: 'Résistance thermique', value: 6, unit: 'm2.K/W' }]);
    const opB = await intervention(b.compte, b.bien.id, { status: 'REALIZED', date: '2025-03-01', fileId: f1, role: 'INVOICE', label: 'Combles' });
    await ecrire(b.compte, (repo) => repo.addSource(opB, { kind: 'DOCUMENT', entityKey: f2, role: 'REPORT', authority: 'DOCUMENT' }));
    await projeter(b.compte, b.bien.id);
    expect(await poses(b.bien.id)).toEqual([]);
    expect(await journal(b.bien.id, 'cil:inst:')).toEqual([{ projection_key: `cil:inst:${opB}:toiture`, status: 'CONFLICT', reason: 'PROOF_DOCUMENTS_DIFFER' }]);
    expect(item(await etat(b.compte, b.bien.id), 'B5.toiture').status).toBe('a_confirmer');

    // Chaudière déjà connue, facture de PAC sans lien ni identité prouvée : remplacement à confirmer, aucun équipement créé.
    const c = await logement();
    const [chaudiere] = await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name, type, category) VALUES (${c.bien.id}, 'Chaudière gaz', 'Chaudière gaz', 'chauffage') RETURNING id`;
    const fp = await piece(c.compte, c.bien.id, 'WORKS_INVOICE', '2025-11-20');
    await connaissance(c.compte, fp, [{ subject: 'Pompe à chaleur', attribute: 'Type', value: 'Pompe à chaleur air/eau' }, { subject: 'Pompe à chaleur', attribute: 'Marque', value: 'Daikin' }]);
    const opC = await intervention(c.compte, c.bien.id, { status: 'REALIZED', date: '2025-11-20', fileId: fp, role: 'INVOICE', label: 'PAC' });
    await projeter(c.compte, c.bien.id);
    expect((await equipements(c.bien.id)).map((e) => e.id)).toEqual([chaudiere.id]);
    expect(await journal(c.bien.id, 'cil:insteq:')).toEqual([{ projection_key: `cil:insteq:${opC}:chauffage`, status: 'AMBIGUOUS', reason: 'EXISTING_EQUIPMENT_FOR_USAGE' }]);
    const b6 = item(await etat(c.compte, c.bien.id), 'B6.chauffage');
    expect(b6.status).toBe('a_confirmer');
    expect(b6.reason).toMatch(/remplace/);

    // Équipement RATTACHÉ à l'Opération (saisi sans caractéristiques) : complété, date de pose ; marque saisie protégée.
    const d = await logement();
    const [vmc] = await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name, type, category) VALUES (${d.bien.id}, 'VMC', 'VMC', 'ventilation') RETURNING id`;
    await sql`INSERT INTO equipment_cil_specs (equipment_id, brand) VALUES (${vmc.id}, 'Aldes')`;
    const fv = await piece(d.compte, d.bien.id, 'WORKS_INVOICE', '2025-05-05');
    await connaissance(d.compte, fv, [{ subject: 'VMC', attribute: 'Type', value: 'VMC double flux' }, { subject: 'VMC', attribute: 'Marque', value: 'Atlantic' }, { subject: 'VMC', attribute: 'Puissance', value: 50, unit: 'W' }]);
    const opD = await intervention(d.compte, d.bien.id, { status: 'REALIZED', date: '2025-05-05', fileId: fv, role: 'INVOICE', label: 'VMC', equipmentId: vmc.id });
    await projeter(d.compte, d.bien.id);
    const [e] = await sql<{ brand: string; power_kw: number; installed_at: string; op: number }[]>`
      SELECT brand, power_kw::float8 AS power_kw, to_char(installed_at, 'YYYY-MM-DD') AS installed_at, installation_operation_id::int AS op FROM equipment_cil_specs WHERE equipment_id = ${vmc.id}`;
    expect(e).toEqual({ brand: 'Aldes', power_kw: 0.05, installed_at: '2025-05-05', op: opD });
    expect(await journal(d.bien.id, 'cil:insteq:')).toEqual([{ projection_key: `cil:insteq:${opD}:ventilation`, status: 'WRITTEN', reason: 'PARTIAL_USER_PROTECTED' }]);
    expect(await projeter(d.compte, d.bien.id)).toMatchObject({ changed: false });
  });

  it('L112F-E2E-03 — écriture d’Opération (création, réalisation + facture, invalidation, fusion) → contrôle ciblé durable → B5 / B7 à jour sans passage T3', async () => {
    const { compte, bien } = await logement();
    const { registerCoherenceTriggers, __resetCoherenceTriggersForTests } = await import('@/services/coherence/events');
    const orch = await import('@/services/coherence/orchestrator');
    const demande = async () => (await sql<{ r: string | null }[]>`
      SELECT request_reason AS r FROM coherence_object_proofs WHERE account_id = ${compte.id} AND check_id = ${CHECK} AND object_id = ${bien.id} AND requested_at IS NOT NULL`)[0]?.r ?? null;
    const attendreDemande = async (op: number) => {
      let r: string | null = null;
      for (let i = 0; i < 80 && (r = await demande()) !== `BUSINESS_OPERATION_CHANGED:${op}`; i++) await new Promise((x) => setTimeout(x, 50));
      return r;
    };
    const passageCible = () => orch.runTargetedChecks({ mode: 'CORRECTIVE', now: new Date(Date.now() + 3_600_000), deadline: Date.now() + 120_000 });
    await registerCoherenceTriggers();
    try {
      // 1. Création d'une Opération envisagée (devis) : demandée, rien de posé.
      const devis = await piece(compte, bien.id, 'WORKS_QUOTE', '2025-01-15');
      await connaissance(compte, devis, ISOLATION);
      const op = await intervention(compte, bien.id, { status: 'ENVISAGED', date: '2025-04-01', fileId: devis, role: 'QUOTE', label: 'Isolation des combles' });
      expect(await attendreDemande(op)).toBe(`BUSINESS_OPERATION_CHANGED:${op}`);
      await passageCible();
      expect(await poses(bien.id)).toEqual([]);
      expect(await journal(bien.id, 'cil:work:')).toEqual([{ projection_key: `cil:work:${op}`, status: 'ABSTAINED', reason: 'NOT_REALIZED' }]);

      // 2. Réalisée et justifiée (facture ajoutée) : posée au passage ciblé suivant, B7 = la même Opération.
      const facture = await piece(compte, bien.id, 'WORKS_INVOICE', '2025-04-03');
      await connaissance(compte, facture, ISOLATION);
      await sql`UPDATE coherence_object_proofs SET requested_at = NULL WHERE account_id = ${compte.id} AND check_id = ${CHECK}`;
      await ecrire(compte, async (repo) => {
        await repo.addSource(op, { kind: 'DOCUMENT', entityKey: facture, role: 'INVOICE', authority: 'DOCUMENT' });
        await repo.setStatus(op, 'REALIZED', { reasonCode: 'E2E_REALISE' });
        await repo.updateAttributes(op, { realizedDate: '2025-04-03', plannedDate: null }, 'E2E_REALISE');
      });
      expect(await attendreDemande(op)).toBe(`BUSINESS_OPERATION_CHANGED:${op}`);
      await passageCible();
      expect(await poses(bien.id)).toEqual([expect.objectContaining({ category: 'toiture', installation_state: 'installe', installed_at: '2025-04-03', operation_id: op, source_file_id: facture })]);
      expect(((await etat(compte, bien.id)).works ?? []).map((w) => w.id)).toEqual([op]);

      // 3. Invalidation : retirée au passage ciblé.
      await sql`UPDATE coherence_object_proofs SET requested_at = NULL WHERE account_id = ${compte.id} AND check_id = ${CHECK}`;
      await ecrire(compte, (repo) => repo.invalidate(op, 'E2E_ERREUR'));
      expect(await attendreDemande(op)).toBe(`BUSINESS_OPERATION_CHANGED:${op}`);
      await passageCible();
      expect(await poses(bien.id)).toEqual([]);
      expect((await etat(compte, bien.id)).works).toEqual([]);

      // 4. Fusion : l'Opération absorbée perd sa pose, la canonique la porte (relais des deux identités).
      const fa = await piece(compte, bien.id, 'WORKS_INVOICE', '2025-06-10');
      await connaissance(compte, fa, [{ subject: 'Menuiseries', attribute: 'Type de vitrage', value: 'Double vitrage' }, { subject: 'Menuiseries', attribute: 'Uw', value: 1.3, unit: 'W/m2.K' }]);
      await sql`UPDATE coherence_object_proofs SET requested_at = NULL WHERE account_id = ${compte.id} AND check_id = ${CHECK}`;
      const absorbee = await intervention(compte, bien.id, { status: 'REALIZED', date: '2025-06-10', fileId: fa, role: 'INVOICE', label: 'Fenêtres' });
      expect(await attendreDemande(absorbee)).toBe(`BUSINESS_OPERATION_CHANGED:${absorbee}`);
      await passageCible();
      expect((await poses(bien.id)).map((m) => [m.category, m.operation_id])).toEqual([['parois_vitrees', absorbee]]);
      const canonique = await intervention(compte, bien.id, { status: 'REALIZED', date: '2025-06-10', fileId: fa, role: 'INVOICE', label: 'Remplacement des fenêtres' });
      await sql`UPDATE coherence_object_proofs SET requested_at = NULL WHERE account_id = ${compte.id} AND check_id = ${CHECK}`;
      await sql`UPDATE business_operations SET invalidated_at = now(), invalidation_reason = 'MERGED', merged_into_operation_id = ${canonique} WHERE id = ${absorbee}`;
      const { publishBusinessOperationEvents } = await import('@/services/business-operations/events');
      await publishBusinessOperationEvents([{ type: 'BUSINESS_OPERATION_MERGED', accountId: compte.id, operationId: absorbee, canonicalOperationId: canonique, correlationId: 'e2e-112f', occurredAt: new Date().toISOString() }]);
      let r: string | null = null;
      for (let i = 0; i < 80 && !(r = await demande()); i++) await new Promise((x) => setTimeout(x, 50));
      expect(r).toMatch(/^BUSINESS_OPERATION_CHANGED:/);
      await passageCible();
      expect((await poses(bien.id)).map((m) => [m.category, m.operation_id])).toEqual([['parois_vitrees', canonique]]);
      expect(await journal(bien.id, `cil:inst:${absorbee}:`)).toEqual([{ projection_key: `cil:inst:${absorbee}:parois_vitrees`, status: 'RETRACTED', reason: 'OPERATION_NO_LONGER_PROVES' }]);
      // Une seule identité : aucune ligne energy_works, B7 = la canonique.
      expect(await sql`SELECT 1 FROM energy_works WHERE asset_id = ${bien.id}`).toHaveLength(0);
      expect(((await etat(compte, bien.id)).works ?? []).map((w) => w.id)).toEqual([canonique]);
    } finally {
      __resetCoherenceTriggersForTests();
      (await import('@/services/ai/source-analysis/events')).clearSourceAnalyzedHandlers();
    }
  });

  afterAll(() => { vi.restoreAllMocks(); });
});
