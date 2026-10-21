/**
 * Lot 75G — rapprochement documents ↔ équipements unifié, déclenchements
 * durables, création d'équipement fiable, rattrapage historique sécurisé —
 * sur PostgreSQL 16 réel (toutes les migrations).
 *
 * Tickets : « Rapprochement documents–équipements — écarts résiduels 71A »
 * (RDE-A … RDE-G) et « Biens / équipements — écarts résiduels 71A » (L71R-A,
 * B, D1, D2, D3, E).
 *
 * RDE-A1/L71R-B  facture chaudière certaine + robot ambigu : chaudière liée,
 *                T3 reçoit les SEULS robots, abstention → carte LINK-ELT,
 *                lien certain conservé ; facture chaudière + VMC : deux liens.
 * RDE-B1         n° de série seulement dans une unité source / un fait non
 *                résolu : rattachement sans IA, aucun appel T1.
 * RDE-C1/L71R-A  réexamen LINK-ELT : service commun (lien N-N + colonne),
 *                carte close après vérification ; type seul : rien ; retrait
 *                utilisateur et carte « Non applicable » jamais contredits ;
 *                lien au bien conservé.
 * RDE-D1/L71R-D3 création / renommage / n° de série modifié : travail
 *                DURABLE en file, dédupliqué, rejouable, sans IA en
 *                modification ; valeur inchangée : rien n'est relancé.
 * RDE-E1         plus de 500 documents et plus de 500 équipements.
 * RDE-F1         données RÉELLEMENT transmises à t3_link_ambiguity dans les
 *                deux sens (identifiants entiers, concurrent pertinent).
 * L71R-D1        créations concurrentes : chaque réponse rend SON équipement.
 * L71R-D2        prix fourni à la création : sur l'équipement seul (USER).
 * L71R-E1..E3    rattrapage : deux acquisitions légitimes jamais supprimées
 *                (suspects), autres attributs diagnostiqués, reprise après
 *                interruption sans perte ni doublon, simulation sans écriture.
 * RDE-ISO        isolation des comptes (file et service).
 */
import { NextRequest } from 'next/server';
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { drainQueues, useTargetState } from '../chain';
import type { RecordedOutput } from '../replay-gateway';
import type { AccountRow } from '../factories';

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
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

scenario('L75G', 'Rapprochement documents–équipements unifié et durable', ({ sql, make, useRecordings: rejouer }) => {
  useTargetState();
  const ABSTENTION: RecordedOutput = { operationCode: 't3_link_ambiguity', task: 'LINK_AMBIGUITY', output: { task: 'LINK_AMBIGUITY', matches: [] }, repeat: true };
  const as = (c: AccountRow) => { session.currentAccountId = c.id; session.userId = c.ownerUserId; };
  const maison = async (c: AccountRow) => {
    const a = await make.asset(c, { category: 'IMMOBILIER', name: `Maison ${c.id}` });
    await sql`UPDATE assets SET subtype = 'Maison' WHERE id = ${a.id}`;
    return a;
  };
  const equipement = async (assetId: number, name: string, o: { brand?: string; model?: string; serial?: string } = {}) => {
    const [{ id }] = await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name) VALUES (${assetId}, ${name}) RETURNING id`;
    if (o.brand || o.model || o.serial) {
      await sql`INSERT INTO equipment_cil_specs (equipment_id, brand, model, serial_number) VALUES (${id}, ${o.brand ?? null}, ${o.model ?? null}, ${o.serial ?? null})`;
    }
    return id;
  };
  const document = async (c: AccountRow, assetId: number, title: string, faits: Array<{ key: string; value: string; label?: string }> = []) => {
    const f = await make.assetFile(c, { assetId });
    await sql`UPDATE asset_files SET retained_title = ${title} WHERE id = ${f.id}`;
    if (faits.length) {
      const [ext] = await sql<{ id: number }[]>`INSERT INTO document_extractions (account_id, file_id, full_text, full_text_chars) VALUES (${c.id}, ${f.id}, '', 0) RETURNING id`;
      for (const x of faits) {
        await sql`INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, canonical_key, label, value_text, confidence, excerpt)
                  VALUES (${c.id}, ${f.id}, ${ext.id}, ${x.key}, ${x.key}, ${x.label ?? null}, ${x.value}, 'certain', ${`${x.label ?? x.key} : ${x.value}`})`;
      }
    }
    return f.id;
  };
  const liens = async (fileId: number) => (await sql<{ equipment_id: number; origin: string; asset_id: number }[]>`
    SELECT equipment_id, origin, asset_id FROM document_asset_links WHERE file_id = ${fileId} AND status = 'ACTIVE' AND equipment_id IS NOT NULL ORDER BY equipment_id`);
  const colonne = async (fileId: number) => (await sql<{ equipment_id: number | null }[]>`SELECT equipment_id FROM asset_files WHERE id = ${fileId}`)[0].equipment_id;
  const carteOuverte = async (fileId: number) => (await sql<{ id: number; ctx: { candidates: number[] } }[]>`
    SELECT id, trigger_context AS ctx FROM to_process_actions WHERE target_type = 'DOCUMENT' AND target_id = ${fileId} AND rule_code = 'LINK-ELT' AND resolved_at IS NULL`)[0] ?? null;
  const travaux = async (equipmentId: number) => sql<{ id: number; status: string; payload: { events: Array<{ reason: string }> }; business_result: string | null }[]>`
    SELECT id, status, payload, business_result FROM ai_job_queue WHERE treatment = 'T3' AND target_type = 'equipment_documents' AND target_id = ${String(equipmentId)} ORDER BY id`;
  /** Fait passer les travaux temporisés (regroupement de rafale) puis vide les files. */
  const executer = async () => {
    // La file est partagée avec les autres scénarios du fichier : on la vide jusqu'à ce que NOS travaux soient passés.
    for (let i = 0; i < 10; i++) {
      await sql`UPDATE ai_job_queue SET available_at = now() WHERE status = 'PENDING' AND target_type = 'equipment_documents'`;
      await drainQueues(200);
      const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ai_job_queue WHERE status IN ('PENDING', 'RUNNING') AND target_type = 'equipment_documents'`;
      if (n === 0) return;
    }
  };
  const t3 = (replay: { calls: Array<{ operationCode?: string; prompt?: string }> }) => replay.calls.filter((x) => x.operationCode === 't3_link_ambiguity');

  // ══ A / B ═══════════════════════════════════════════════════════════════

  it('RDE-A1 / L71R-B — chaudière certaine + robot ambigu : chaudière liée, T3 sur les SEULS robots, carte LINK-ELT, lien certain conservé', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c);
    const chaudiere = await equipement(m.id, 'Chaudière', { brand: 'Frisquet', serial: 'FR-2020-77881' });
    const r1 = await equipement(m.id, 'Robot aspirateur', { brand: 'iRobot', model: 'Roomba i7', serial: 'R7-0001' });
    const r2 = await equipement(m.id, 'Robot aspirateur', { brand: 'iRobot', model: 'Roomba i7', serial: 'R7-0002' });
    const f = await document(c, m.id, 'Facture chaudière et robot aspirateur', [
      { key: 'serialNumber', value: 'FR-2020-77881', label: 'N° de série' }, { key: 'designation', value: 'Robot aspirateur', label: 'Désignation' },
    ]);
    const replay = await rejouer([ABSTENTION]);
    const { syncDocumentEquipmentLinks } = await import('@/services/equipment/document-equipment-link.service');
    const r = await syncDocumentEquipmentLinks({ accountId: c.id, fileId: f, allowAi: true });
    expect(r).toMatchObject({ status: 'LINKED', linked: [chaudiere], ambiguous: [r1, r2], aiCalled: true, cardProposed: true });
    // Données RÉELLEMENT transmises : les deux robots, jamais la chaudière (déjà certaine).
    const appels = t3(replay);
    expect(appels).toHaveLength(1);
    expect(appels[0].prompt).toMatch(new RegExp(`"candidateId":\\s*${r1}`));
    expect(appels[0].prompt).toMatch(new RegExp(`"candidateId":\\s*${r2}`));
    expect(appels[0].prompt).not.toMatch(new RegExp(`"candidateId":\\s*${chaudiere}\\b`));
    expect(appels[0].prompt).toContain('n° de série:R7-0001');
    expect(appels[0].prompt).toContain('n° de série lu(s):FR-2020-77881');
    expect((await liens(f)).map((x) => [x.equipment_id, x.asset_id])).toEqual([[chaudiere, m.id]]);
    expect(await colonne(f)).toBe(chaudiere);
    expect((await carteOuverte(f))?.ctx.candidates.sort()).toEqual([r1, r2].sort());
    // Rejoué : aucun lien, aucune carte de plus ; la carte reste ouverte, le lien certain aussi.
    const encore = await syncDocumentEquipmentLinks({ accountId: c.id, fileId: f, allowAi: false });
    expect(encore.created).toBe(0);
    expect((await sql`SELECT id FROM to_process_actions WHERE target_id = ${f} AND rule_code = 'LINK-ELT'`)).toHaveLength(1);
    // L71R-B : chaudière par n° de série + VMC par modèle distinctif → deux liens.
    const vmc = await equipement(m.id, 'VMC', { brand: 'Aldes', model: 'Dee Fly Cube 370' });
    const g = await document(c, m.id, 'Entretien annuel', [{ key: 'serialNumber', value: 'FR 2020 77881' }, { key: 'modelName', value: 'Dee Fly Cube 370' }]);
    const r3 = await syncDocumentEquipmentLinks({ accountId: c.id, fileId: g });
    expect(r3.linked.sort()).toEqual([chaudiere, vmc].sort());
    expect(await colonne(g)).toBeNull();
  });

  it('RDE-B1 — n° de série seulement dans une unité source ou un fait non résolu : rattachement sans IA ni T1', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c);
    const pac = await equipement(m.id, 'Chauffage salon', { serial: 'PAC-998877' });
    const ballon = await equipement(m.id, 'Ballon', { serial: 'BAL-445566' });
    const f = await document(c, m.id, 'Rapport d’intervention');
    await sql`INSERT INTO document_source_units (account_id, file_id, source_unit_id, kind, ordinal, coverage_status, content_text)
              VALUES (${c.id}, ${f}, 'p1:b1', 'TEXT_BLOCK', 0, 'UNRESOLVED', 'Appareil contrôlé : n° PAC 998877, RAS')`;
    // Unité INCERTAINE : jamais une correspondance.
    await sql`INSERT INTO document_source_units (account_id, file_id, source_unit_id, kind, ordinal, coverage_status, content_text)
              VALUES (${c.id}, ${f}, 'p1:b2', 'TEXT_BLOCK', 1, 'UNCERTAIN', 'Peut-être BAL 445566')`;
    const g = await document(c, m.id, 'Bon de livraison');
    await sql`INSERT INTO document_unresolved_facts (account_id, file_id, reason, raw_key, raw_value) VALUES (${c.id}, ${g}, 'NO_CANONICAL_KEY', 'numeroSerie', 'BAL445566')`;
    const replay = await rejouer([]);
    const { syncDocumentEquipmentLinks } = await import('@/services/equipment/document-equipment-link.service');
    expect((await syncDocumentEquipmentLinks({ accountId: c.id, fileId: f, allowAi: true })).linked).toEqual([pac]);
    expect((await syncDocumentEquipmentLinks({ accountId: c.id, fileId: g, allowAi: true })).linked).toEqual([ballon]);
    expect(replay.calls).toHaveLength(0);
  });

  // ══ C ═══════════════════════════════════════════════════════════════════

  it('RDE-C1 / L71R-A — réexamen LINK-ELT : service commun (N-N + colonne), carte close après vérification ; type seul : rien ; refus utilisateur respectés', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c);
    const r1 = await equipement(m.id, 'Radiateur salon');
    const r2 = await equipement(m.id, 'Radiateur chambre');
    const f = await document(c, m.id, 'Facture radiateur');
    const { proposeDocumentEquipmentLink } = await import('@/services/to-process/document-equipment-link');
    await proposeDocumentEquipmentLink({ accountId: c.id, fileId: f, assetId: m.id, candidates: [{ equipmentId: r1, score: 0.5, reason: 'x' }, { equipmentId: r2, score: 0.5, reason: 'x' }] });
    const carte = (await carteOuverte(f))!.id;
    const { resolveDocumentElementLink } = await import('@/services/ai/reconciliation/continuous/document-element-link');
    // Toujours ambigu : T3 consulté (abstention), carte conservée, rien d'écrit.
    let arbitrages = 0;
    const amb = await resolveDocumentElementLink({ accountId: c.id, fileId: f, actionId: carte, deps: { arbitrate: async () => { arbitrages++; return { equipmentId: null, abstained: true }; } } });
    expect(amb).toMatchObject({ status: 'AMBIGUOUS', aiCalled: true });
    expect(arbitrages).toBe(1);
    expect(await liens(f)).toEqual([]);
    // T3 tranche : lien N-N AI + colonne, carte close APRÈS vérification, document toujours sur le bien.
    const ok = await resolveDocumentElementLink({ accountId: c.id, fileId: f, actionId: carte, deps: { arbitrate: async (p) => ({ equipmentId: p.candidateIds.includes(r2) ? r2 : null, score: 0.9, reason: 'chambre' }) } });
    expect(ok).toMatchObject({ status: 'APPLIED', equipmentId: r2 });
    expect((await liens(f)).map((x) => [x.equipment_id, x.origin, x.asset_id])).toEqual([[r2, 'AI', m.id]]);
    expect(await colonne(f)).toBe(r2);
    expect(await carteOuverte(f)).toBeNull();
    expect((await sql`SELECT 1 FROM asset_files WHERE id = ${f} AND asset_id = ${m.id}`)).toHaveLength(1);

    // Type seul : jamais candidat, jamais rattaché.
    const robot = await equipement(m.id, 'Appareil cuisine');
    await sql`UPDATE equipments SET type = 'Électroménager' WHERE id = ${robot}`;
    const h = await document(c, m.id, 'Facture électroménager');
    const { syncDocumentEquipmentLinks } = await import('@/services/equipment/document-equipment-link.service');
    expect((await syncDocumentEquipmentLinks({ accountId: c.id, fileId: h, allowAi: true })).status).toBe('NONE');
    expect(await liens(h)).toEqual([]);

    // Retrait utilisateur d'un lien : jamais rétabli (service et réexamen).
    const pac = await equipement(m.id, 'Pompe à chaleur', { serial: 'PAC-123456' });
    const k = await document(c, m.id, 'Entretien PAC-123456');
    await syncDocumentEquipmentLinks({ accountId: c.id, fileId: k });
    expect((await liens(k)).map((x) => x.equipment_id)).toEqual([pac]);
    await sql`UPDATE document_asset_links SET status = 'REMOVED', origin = 'USER', removed_at = now() WHERE file_id = ${k} AND equipment_id = ${pac}`;
    await sql`UPDATE asset_files SET equipment_id = NULL WHERE id = ${k}`;
    expect((await syncDocumentEquipmentLinks({ accountId: c.id, fileId: k, allowAi: true })).created).toBe(0);
    expect(await liens(k)).toEqual([]);

    // Carte déclarée « Non applicable » : ses candidats ne sont plus jamais rattachés automatiquement.
    const n = await document(c, m.id, 'Devis radiateur');
    await proposeDocumentEquipmentLink({ accountId: c.id, fileId: n, assetId: m.id, candidates: [{ equipmentId: r1, score: 0.5, reason: 'x' }, { equipmentId: r2, score: 0.5, reason: 'x' }] });
    await sql`UPDATE to_process_actions SET resolved_at = now(), resolution_reason = 'NOT_APPLICABLE' WHERE target_id = ${n} AND rule_code = 'LINK-ELT'`;
    let appels = 0;
    const apres = await syncDocumentEquipmentLinks({ accountId: c.id, fileId: n, allowAi: true, arbitrate: async () => { appels++; return { equipmentId: r1, score: 0.99 }; } });
    expect(appels).toBe(0);
    expect(apres.linked).toEqual([]);
    expect(await carteOuverte(n)).toBeNull();
  });

  it('RDE-C2 — LINK-ELT : équipement identifiable créé après la carte → rattaché, carte close ; candidat déjà rattaché → sans objet sans écriture', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c);
    const r1 = await equipement(m.id, 'Radiateur salon');
    const r2 = await equipement(m.id, 'Radiateur chambre');
    const f = await document(c, m.id, 'Entretien annuel Vitodens 200');
    const { proposeDocumentEquipmentLink } = await import('@/services/to-process/document-equipment-link');
    await proposeDocumentEquipmentLink({ accountId: c.id, fileId: f, assetId: m.id, candidates: [{ equipmentId: r1, score: 0.5, reason: 'x' }, { equipmentId: r2, score: 0.5, reason: 'x' }] });
    const carte = (await carteOuverte(f))!.id;
    const vito = await equipement(m.id, 'Vitodens 200');
    const { resolveDocumentElementLink } = await import('@/services/ai/reconciliation/continuous/document-element-link');
    expect(await resolveDocumentElementLink({ accountId: c.id, fileId: f, actionId: carte })).toMatchObject({ status: 'APPLIED', aiCalled: false, equipmentId: vito });
    expect((await liens(f)).map((x) => x.equipment_id)).toEqual([vito]);
    // Candidat déjà rattaché (par l'utilisateur) : sans objet, rien n'est écrit.
    const g = await document(c, m.id, 'Facture radiateur');
    await proposeDocumentEquipmentLink({ accountId: c.id, fileId: g, assetId: m.id, candidates: [{ equipmentId: r1, score: 0.5, reason: 'x' }, { equipmentId: r2, score: 0.5, reason: 'x' }] });
    await sql`UPDATE asset_files SET equipment_id = ${r1} WHERE id = ${g}`;
    const r = await resolveDocumentElementLink({ accountId: c.id, fileId: g, actionId: (await carteOuverte(g))!.id });
    expect(r).toMatchObject({ status: 'ALREADY_LINKED', equipmentId: r1, deterministicAttempted: false });
    expect((await liens(g)).filter((x) => x.origin === 'AI')).toEqual([]);
  });

  // ══ D ═══════════════════════════════════════════════════════════════════

  it('RDE-D1 / L71R-D3 — création, renommage, n° de série modifié : travail durable, dédupliqué, rejouable ; valeur inchangée : rien', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c);
    const f = await document(c, m.id, 'Facture pompe à chaleur', [{ key: 'serialNumber', value: 'PAC-998877', label: 'N° de série' }]);
    const g = await document(c, m.id, 'Contrat entretien ballon thermodynamique');
    await rejouer([ABSTENTION]);
    as(c);
    const { POST } = await import('@/app/api/assets/[id]/equipments/route');
    const res = await POST(new NextRequest(`http://x/api/assets/${m.id}/equipments`, { method: 'POST', body: JSON.stringify({ name: 'Chauffage salon' }) }),
      { params: Promise.resolve({ id: String(m.id) }) });
    expect(res.status).toBe(201);
    const pac = (await res.json() as { id: number }).id;
    // Mise en file ATTENDUE (persistée avant la réponse), exécution par la file.
    expect((await travaux(pac)).map((j) => [j.status, j.payload.events.map((e) => e.reason)])).toEqual([['PENDING', ['created']]]);
    await executer();
    expect((await travaux(pac))[0].status).toBe('DONE');
    expect(await liens(f)).toEqual([]);

    // N° de série saisi (écrivain canonique) → nouveau travail → rattachement déterministe.
    const { writeCanonicalEntityField } = await import('@/services/canonical/entity-state');
    await writeCanonicalEntityField({ target: { type: 'EQUIPMENT', id: pac }, accountId: c.id, key: 'serialNumber', value: 'PAC998877', origin: 'USER' });
    // Même valeur réécrite : aucune nouvelle demande (dédupliquée de toute façon tant qu'elle attend).
    await writeCanonicalEntityField({ target: { type: 'EQUIPMENT', id: pac }, accountId: c.id, key: 'serialNumber', value: 'PAC998877', origin: 'USER' });
    const enAttente = (await travaux(pac)).filter((j) => j.status === 'PENDING');
    expect(enAttente).toHaveLength(1);
    expect(enAttente[0].payload.events.map((e) => e.reason)).toEqual(['identifiers_changed']);
    const replay = await rejouer([]);
    await executer();
    expect((await liens(f)).map((x) => x.equipment_id)).toEqual([pac]);
    expect(t3(replay)).toHaveLength(0);
    expect((await travaux(pac)).every((j) => j.status === 'DONE')).toBe(true);

    // Renommage effectif → travail ; même nom → aucun travail.
    const { PUT } = await import('@/app/api/assets/[id]/equipments/[equipId]/route');
    const put = (body: Record<string, unknown>) => PUT(new NextRequest(`http://x/api/assets/${m.id}/equipments/${pac}`, { method: 'PUT', body: JSON.stringify(body) }),
      { params: Promise.resolve({ id: String(m.id), equipId: String(pac) }) });
    const avant = (await travaux(pac)).length;
    expect((await put({ name: 'Chauffage salon', type: 'pac' })).status).toBe(200);
    expect((await travaux(pac)).length).toBe(avant);
    expect((await put({ name: 'Ballon thermodynamique' })).status).toBe(200);
    expect((await travaux(pac)).map((j) => j.payload.events[0].reason).at(-1)).toBe('renamed');
    await executer();
    expect((await liens(g)).map((x) => x.equipment_id)).toEqual([pac]);
    // Rejoué : aucun doublon.
    const { requestEquipmentDocumentSync } = await import('@/services/equipment/equipment-document-queue');
    await requestEquipmentDocumentSync(c.id, pac, { reason: 'renamed' });
    await executer();
    expect(await liens(f)).toHaveLength(1);
    expect(await liens(g)).toHaveLength(1);
    expect((await travaux(pac)).at(-1)?.business_result).toBe('NO_CHANGE');
  });

  it('RDE-ISO — isolation : un travail ne lit ni n’écrit hors de son compte ; un équipement étranger est TARGET_GONE', async () => {
    const a = await make.account({ plan: 'premium' });
    const b = await make.account({ plan: 'premium' });
    const mb = await maison(b);
    const eqB = await equipement(mb.id, 'Chaudière', { serial: 'CH-778899' });
    const ma = await maison(a);
    const fa = await document(a, ma.id, 'Entretien chaudière CH-778899');
    const { requestEquipmentDocumentSync } = await import('@/services/equipment/equipment-document-queue');
    // Demande forgée (équipement d'un autre compte) : refusée à la mise en file.
    expect(await requestEquipmentDocumentSync(a.id, eqB, { reason: 'renamed' })).toBeNull();
    const { syncEquipmentDocumentLinks } = await import('@/services/equipment/document-equipment-link.service');
    expect((await syncEquipmentDocumentLinks({ accountId: a.id, equipmentId: eqB })).found).toBe(false);
    expect(await liens(fa)).toEqual([]);
  });

  // ══ E ═══════════════════════════════════════════════════════════════════

  it('RDE-E1 — plus de 500 documents et plus de 500 équipements : aucun candidat exclu', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c);
    await sql`INSERT INTO asset_files (user_id, account_id, asset_id, s3_key, mime_type, retained_title)
              SELECT ${c.ownerUserId}, ${c.id}, ${m.id}, 'e2e/' || ${c.id} || '/' || g || '.pdf', 'application/pdf', 'Document ' || g FROM generate_series(1, 520) g`;
    const dernier = await document(c, m.id, 'Contrôle PAC-778811');
    await sql`INSERT INTO equipments (asset_id, name) SELECT ${m.id}, 'Appareil ' || g FROM generate_series(1, 505) g`;
    const pac = await equipement(m.id, 'Pompe à chaleur', { serial: 'PAC-778811' });
    const { syncEquipmentDocumentLinks, syncDocumentEquipmentLinks, loadEquipmentProfiles } = await import('@/services/equipment/document-equipment-link.service');
    expect((await loadEquipmentProfiles(c.id, { assetIds: [m.id] })).length).toBe(506);
    const r = await syncEquipmentDocumentLinks({ accountId: c.id, equipmentId: pac });
    expect(r.examined).toBe(521);
    expect(r.linkedDocuments).toEqual([dernier]);
    expect((await syncDocumentEquipmentLinks({ accountId: c.id, fileId: dernier })).linked).toEqual([pac]);
  }, 180_000);

  // ══ F ═══════════════════════════════════════════════════════════════════

  it('RDE-F1 — sens EQUIPMENT_DOCUMENT : données réellement transmises (documents candidats, identifiants entiers, concurrent pertinent)', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c);
    for (let i = 0; i < 7; i++) await equipement(m.id, `Appareil divers ${i}`);
    const ancien = await equipement(m.id, 'Robot aspirateur', { brand: 'iRobot', model: 'Roomba i7', serial: 'R7-0001' });
    const notice = await document(c, m.id, 'Notice', [{ key: 'modelName', value: 'Roomba i7', label: 'Modèle' }]);
    const replay = await rejouer([{ operationCode: 't3_link_ambiguity', task: 'LINK_AMBIGUITY', output: { task: 'LINK_AMBIGUITY', matches: [{ candidateId: notice, score: 0.9, confidence: 'certain', reason: 'modèle et notice' }] } }]);
    const nouveau = await equipement(m.id, 'Robot aspirateur étage', { brand: 'iRobot', model: 'Roomba i7', serial: 'R7-0002' });
    const { syncEquipmentDocumentLinks } = await import('@/services/equipment/document-equipment-link.service');
    const r = await syncEquipmentDocumentLinks({ accountId: c.id, equipmentId: nouveau, allowAi: true });
    expect(r.aiCalls).toBe(1);
    const [appel] = t3(replay);
    expect(appel.prompt).toMatch(new RegExp(`"candidateId":\\s*${notice}`));
    expect(appel.prompt).toContain('modèle(s) lu(s):Roomba i7');
    expect(appel.prompt).toContain(`Équipement #${nouveau}`);
    expect(appel.prompt).toContain('n° de série:R7-0002');
    // Le jumeau passe avant les sept autres équipements, malgré l'ordre de lecture.
    expect(appel.prompt).toContain(`à ne pas confondre avec l’équipement #${ancien}`);
    const p = appel.prompt ?? '';
    expect(p.indexOf(`#${ancien}`)).toBeLessThan(p.indexOf('Appareil divers 0') === -1 ? Infinity : p.indexOf('Appareil divers 0'));
    expect(appel.prompt).not.toMatch(/prix d.achat|acquisitionPrice/);
    expect(r.linkedDocuments).toEqual([notice]);
  });

  // ══ L71R-D1 / D2 ════════════════════════════════════════════════════════

  it('L71R-D1 / D2 — créations concurrentes : chaque réponse rend SON équipement ; prix sur l’équipement seul, strict', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await make.asset(c, { category: 'IMMOBILIER', name: 'Maison', purchasePriceCents: 30_000_000 });
    await sql`UPDATE assets SET subtype = 'Maison' WHERE id = ${m.id}`;
    as(c);
    const { POST } = await import('@/app/api/assets/[id]/equipments/route');
    const creer = (body: Record<string, unknown>) => POST(new NextRequest(`http://x/api/assets/${m.id}/equipments`, { method: 'POST', body: JSON.stringify(body) }),
      { params: Promise.resolve({ id: String(m.id) }) });
    const noms = Array.from({ length: 8 }, (_, i) => `Équipement concurrent ${i}`);
    const reponses = await Promise.all(noms.map((name) => creer({ name })));
    const corps = await Promise.all(reponses.map((r) => r.json() as Promise<{ id: number; name: string }>));
    for (const [i, b] of corps.entries()) {
      expect(b.name).toBe(noms[i]);
      expect((await sql<{ name: string }[]>`SELECT name FROM equipments WHERE id = ${b.id}`)[0].name).toBe(noms[i]);
    }
    expect(new Set(corps.map((b) => b.id)).size).toBe(8);
    // D2 : prix fourni → équipement (colonne + fiche USER), jamais le bien ; absent → vide ; décimal → 400.
    const robot = (await (await creer({ name: 'Robot', purchasePriceCents: 49_900, estimatedValueCents: 30_000 })).json() as { id: number }).id;
    const [ligne] = await sql<{ ppc: number; evc: number }[]>`SELECT purchase_price_cents AS ppc, estimated_value_cents AS evc FROM equipments WHERE id = ${robot}`;
    expect(ligne).toEqual({ ppc: 49_900, evc: 30_000 });
    const { getCanonicalEntityState } = await import('@/services/canonical/entity-state');
    expect((await getCanonicalEntityState({ type: 'EQUIPMENT', id: robot }, c.id))!.fields.acquisitionPrice).toMatchObject({ value: 499, origin: 'USER' });
    expect((await sql<{ p: number }[]>`SELECT purchase_price_cents AS p FROM assets WHERE id = ${m.id}`)[0].p).toBe(30_000_000);
    const vide = (await (await creer({ name: 'Sans prix' })).json() as { id: number }).id;
    expect((await sql<{ ppc: number | null }[]>`SELECT purchase_price_cents AS ppc FROM equipments WHERE id = ${vide}`)[0].ppc).toBeNull();
    expect((await creer({ name: 'Décimal', purchasePriceCents: 499.5 })).status).toBe(400);
    expect((await creer({ name: 'Négatif', estimatedValueCents: -1 })).status).toBe(400);
    expect((await creer({ name: 'Trop grand', purchasePriceCents: 3_000_000_000 })).status).toBe(400);
  });

  // ══ L71R-E ══════════════════════════════════════════════════════════════

  it('L71R-E1..E3 — rattrapage : acquisitions légitimes intactes (suspects), autres attributs diagnostiqués, reprise après interruption sans perte ni doublon', async () => {
    const { recordEvidence } = await import('@/services/ai/evidence/field-evidence.service');
    const preuve = (c: AccountRow, assetId: number, sourceId: number, key: string, value: string | number, excerpt: string,
      o: { equipmentId?: number; rule?: string; authority?: number } = {}) => recordEvidence({
      accountId: c.id, assetId, fieldKey: key, value, normalizedValue: String(value), sourceType: 'document', sourceId, location: {},
      excerpt, confidence: 'certain', authorityScore: o.authority ?? 60, canonicalKey: key,
      projectionOrigin: o.rule ? 'DETERMINISTIC_RULE' : 'MODEL_CANONICAL', projectionRule: o.rule ?? null,
      target: o.equipmentId ? { type: 'EQUIPMENT', entityId: o.equipmentId, label: null, confidence: 'certain' } : { type: 'ASSET', entityId: assetId, label: null, confidence: 'certain' },
    });
    const c = await make.account({ plan: 'premium' });
    // E1 — un même bon de commande : la cuisine (bien) ET le robot (équipement), montants différents.
    const m = await make.asset(c, { category: 'IMMOBILIER', name: 'Maison', keyCharacteristics: { acquisitionPrice: 20_000, acquisitionPrice__origin: 'RECONCILIATION' } });
    await sql`UPDATE assets SET subtype = 'Maison' WHERE id = ${m.id}`;
    const robot = await equipement(m.id, 'Robot aspirateur');
    const bon = (await make.assetFile(c, { assetId: m.id })).id;
    await preuve(c, m.id, bon, 'acquisitionPrice', 20_000, 'Total 20 000,00 €', { rule: 'PURCHASE_RECEIPT_ACQUISITION_PRICE', authority: 90 });
    await preuve(c, m.id, bon, 'acquisitionPrice', 499, 'Robot 499,00 €', { equipmentId: robot });
    // E1 bis — même date sur un justificatif portant aussi l'achat du bien (lu par T1) : légitime.
    const facture = (await make.assetFile(c, { assetId: m.id })).id;
    await preuve(c, m.id, facture, 'acquisitionDate', '2024-05-02', 'Le 02/05/2024', { rule: 'PURCHASE_RECEIPT_ACQUISITION_DATE' });
    await preuve(c, m.id, facture, 'acquisitionDate', '2024-05-02', 'Livraison robot le 02/05/2024', { equipmentId: robot });
    await preuve(c, m.id, facture, 'acquisitionPrice', 18_000, 'Maison 18 000 €');
    // E2 — autre attribut : fin de garantie identique au bien, sans preuve propre de l'équipement (automatique).
    await sql`UPDATE assets SET key_characteristics = '{"acquisitionPrice":20000,"acquisitionPrice__origin":"RECONCILIATION","warrantyEndDate":"2027-01-01","warrantyEndDate__origin":"RECONCILIATION"}'::jsonb WHERE id = ${m.id}`;
    await sql`UPDATE equipments SET key_characteristics = '{"warrantyEndDate":"2027-01-01","warrantyEndDate__origin":"RECONCILIATION"}'::jsonb WHERE id = ${robot}`;
    // E3 — vraie erreur démontrée (cas A) sur un second bien, pour la reprise.
    const m2 = await make.asset(c, { category: 'IMMOBILIER', name: 'Studio', keyCharacteristics: { acquisitionDate: '2025-03-10', acquisitionDate__origin: 'RECONCILIATION' } });
    const tv = await equipement(m2.id, 'Téléviseur');
    const acte = (await make.assetFile(c, { assetId: m2.id })).id;
    const ftv = (await make.assetFile(c, { assetId: m2.id })).id;
    await preuve(c, m2.id, acte, 'acquisitionDate', '2019-06-14', 'Signé le 14/06/2019', { authority: 50 });
    await preuve(c, m2.id, ftv, 'acquisitionDate', '2025-03-10', 'Date : 10/03/2025', { rule: 'PURCHASE_RECEIPT_ACQUISITION_DATE', authority: 90 });
    await preuve(c, m2.id, ftv, 'acquisitionDate', '2025-03-10', 'Achat TV le 10/03/2025', { equipmentId: tv });

    const actives = async () => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM field_evidence WHERE account_id = ${c.id} AND COALESCE(lifecycle_status, 'ACTIVE') = 'ACTIVE'`)[0].n;
    const { runDataSeparationBackfill } = await import('@/services/equipment/data-separation-backfill');
    const n0 = await actives();
    const sim = await runDataSeparationBackfill({ apply: false, accountId: c.id });
    expect(sim.cases.map((x) => [x.kind, x.assetId])).toEqual([['ASSET_EVIDENCE_WITHDRAWN', m2.id]]);
    expect(sim.suspects.map((x) => [x.kind, x.assetId, x.fieldKey]).sort()).toEqual([
      ['ACQUISITION_EVIDENCE_UNPROVEN', m.id, 'acquisitionDate'], ['ACQUISITION_EVIDENCE_UNPROVEN', m.id, 'acquisitionPrice'], ['OTHER_ATTRIBUTE_IDENTICAL', m.id, 'warrantyEndDate'],
    ].sort());
    expect(await actives()).toBe(n0);
    expect((await sql`SELECT id FROM data_separation_corrections WHERE account_id = ${c.id}`)).toHaveLength(0);

    // Interruption entre le retrait et la réconciliation : retrait ET journal écrits ensemble.
    const coupe = await runDataSeparationBackfill({ apply: true, accountId: c.id, reason: 'Recette L71R-E', simulateInterruption: 'before_reconcile' });
    expect(coupe.failed).toHaveLength(1);
    expect(await actives()).toBe(n0 - 1);
    expect((await sql`SELECT id FROM data_separation_corrections WHERE account_id = ${c.id}`)).toHaveLength(1);
    // Reprise : la fiche est réconciliée, rien n'est retiré ni journalisé deux fois.
    const reprise = await runDataSeparationBackfill({ apply: true, accountId: c.id, reason: 'Reprise L71R-E' });
    expect(reprise.failed).toEqual([]);
    expect(reprise.resumed).toBe(1);
    expect(reprise.cases).toEqual([]);
    const { getCanonicalAssetState } = await import('@/services/canonical/asset-state');
    expect((await getCanonicalAssetState(m2.id, c.id))!.fields.acquisitionDate?.value).toBe('2019-06-14');
    expect((await sql`SELECT id FROM data_separation_corrections WHERE account_id = ${c.id} AND kind = 'ASSET_EVIDENCE_WITHDRAWN'`)).toHaveLength(1);
    // Acquisitions légitimes et attribut suspect : intacts.
    expect(await actives()).toBe(n0 - 1);
    expect((await getCanonicalAssetState(m.id, c.id))!.fields.acquisitionPrice?.value).toBe(20_000);
    const { getCanonicalEntityState } = await import('@/services/canonical/entity-state');
    expect((await getCanonicalEntityState({ type: 'EQUIPMENT', id: robot }, c.id))!.fields.warrantyEndDate?.value).toBe('2027-01-01');
    // Troisième passage : plus rien à reprendre.
    expect((await runDataSeparationBackfill({ apply: true, accountId: c.id, reason: 'Rejeu' })).resumed).toBe(0);
  });
});
