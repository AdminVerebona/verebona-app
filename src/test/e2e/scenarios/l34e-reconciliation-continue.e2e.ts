/**
 * Lot 34E — réconciliation T3 CONTINUE sur base réelle.
 *
 *   · ticket « T3 : rendre la réconciliation globale réellement continue » —
 *     révision de connaissance du compte, empreinte du contexte pertinent,
 *     déterministe avant IA, faits sans cible ↔ équipement, autorité
 *     utilisateur, À traiter synchronisé, pas de boucle — T3C-01 à 08 ;
 *   · ticket « T3 — réconciliation continue des documents non résolus » —
 *     Candidate Builder indépendant de T1, invalidation par création /
 *     renommage / identifiant / fait, cartes LINK-ASSET, limite du prompt,
 *     rattrapage de l'existant — T3D-01 à 12.
 *
 * Chaîne de production : `analyzeFileSources` (sortie T1 rejouée) → abonné
 * `source_analyzed` → file durable T3 vidée par l'exécutant de production ;
 * balayage `sweepDocumentsWithoutPrimary` (même sélection que les pages
 * planifiées) ; réconciliation compte `reconcileOpenKnowledge`. Les appels
 * modèle sont COMPTÉS par opération sur la passerelle rejouée (« sans IA »).
 */
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { drainQueues, sortieT1, useTargetState, type FaitT1 } from '../chain';
import type { RecordedOutput } from '../replay-gateway';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Compte = { id: number; ownerUserId: number };

scenario('L34E', 'Réconciliation T3 continue : révision de connaissance, Candidate Builder, documents et faits non résolus', ({ sql, make, useRecordings: rejouer }) => {
  useTargetState();

  const T3_ABSTENTION: RecordedOutput = {
    operationCode: 't3_link_ambiguity', task: 'LINK_AMBIGUITY', output: { task: 'LINK_AMBIGUITY', matches: [] }, repeat: true,
  };

  const analyser = async (compte: Compte, fileId: number, output: Record<string, unknown>, extra: RecordedOutput[] = []) => {
    await sql`UPDATE asset_files SET s3_bucket = 'e2e-bucket', original_filename = coalesce(original_filename, ${`doc-${fileId}.pdf`}),
                analysis_state = NULL WHERE id = ${fileId}`;
    const replay = await rejouer([{ operationCode: 't1_analyze_document', task: 'ANALYZE_DOCUMENT', output }, ...extra]);
    const { analyzeFileSources } = await import('@/services/ai/source-analysis/entrypoint');
    const r = await analyzeFileSources([fileId], compte.id, { userId: compte.ownerUserId, billable: false, origin: 'e2e/l34e' });
    if (!r || r.results.length === 0) throw new Error(`[e2e] analyse du fichier ${fileId} en échec`);
    await drainQueues();
    return replay;
  };
  const sortie = (p: {
    title?: string; texte?: string[]; facts?: FaitT1[]; assets?: Array<{ id: number; label: string; confidence?: 'certain' | 'probable'; score?: number }>;
  }) => {
    const out = sortieT1({
      title: p.title ?? 'Facture d’intervention', date: '2026-09-14', documentTypeCode: 'MAINTENANCE_INVOICE', rubricCode: 'MAINTENANCE_WORKS',
      assets: (p.assets ?? []).map((a) => ({ id: a.id, label: a.label })), facts: p.facts ?? [], texte: p.texte, multiAsset: false,
    });
    const ents = (out.entities as { assets: Array<Record<string, unknown>> }).assets;
    (p.assets ?? []).forEach((a, i) => { ents[i].confidence = a.confidence ?? 'certain'; ents[i].score = a.score ?? 0.97; });
    return out;
  };
  const fait = (canonicalKey: string, value: string, excerpt = `${canonicalKey} : ${value}`): FaitT1 => ({
    canonicalKey, value, valueType: 'string', excerpt, assetId: null,
  });

  const liens = async (fileId: number) => (await sql<{ asset_id: number | null; equipment_id: number | null; link_role: string; origin: string }[]>`
    SELECT asset_id, equipment_id, link_role, origin FROM document_asset_links WHERE file_id = ${fileId} AND status = 'ACTIVE' ORDER BY id`);
  const colonne = async (fileId: number) => (await sql<{ asset_id: number | null }[]>`SELECT asset_id FROM asset_files WHERE id = ${fileId}`)[0].asset_id;
  type Eval = Record<string, unknown> & { result: string; aiCalled: boolean };
  const resolution = async (fileId: number) => (await sql<{
    status: string; method: string | null; reason_code: string | null; runs: number; updated_at: Date; evaluated_at: Date | null;
    knowledge_revision: string | null; context_fingerprint: string | null; e: Eval | null; resolution_version: number | null;
  }[]>`
    SELECT status, method, reason_code, runs, updated_at, evaluated_at, knowledge_revision, context_fingerprint, last_evaluation AS e, resolution_version
      FROM document_asset_resolutions WHERE file_id = ${fileId}`)[0];
  const cartes = async (fileId: number) => (await sql<{ active: boolean; kind: string; reason: string | null; proposals: unknown }[]>`
    SELECT resolved_at IS NULL AS active, action_kind AS kind, resolution_reason AS reason, proposals_json AS proposals
      FROM to_process_actions WHERE target_type = 'DOCUMENT' AND target_id = ${fileId} AND rule_code = 'LINK-ASSET' ORDER BY id`)
    .map((a) => ({ ...a, proposals: ((typeof a.proposals === 'string' ? JSON.parse(a.proposals) : a.proposals) ?? []) as Array<{ value: unknown }> }));
  const actives = async (fileId: number) => (await cartes(fileId)).filter((c) => c.active);
  const appels = (replay: { calls: Array<{ operationCode?: string }> }, op: string) => replay.calls.filter((c) => c.operationCode === op).length;
  const balayer = async (compte: Compte) => {
    const { sweepDocumentsWithoutPrimary } = await import('@/services/ai/reconciliation/document-asset/queue');
    return sweepDocumentsWithoutPrimary({ accountId: compte.id, triggerCode: 'schedule_hourly' });
  };
  const ADRESSE = { address1: '12 rue Exemple', postalCode: '69003', city: 'Lyon' };
  const maison = (compte: Compte, name: string, kc?: Record<string, unknown>) => make.asset(compte, { category: 'IMMOBILIER', name, keyCharacteristics: kc });
  const sousType = (assetId: number, subtype: string) => sql`UPDATE assets SET subtype = ${subtype} WHERE id = ${assetId}`;

  // ══ Ticket « réconciliation globale réellement continue » ════════════════

  it('T3C-01 — nouveau bien : document à l’adresse connue NO_CANDIDATE, la maison est créée → T3 reprend le document, rattachement automatique, À traiter fermé, sans T1 ni IA ; monitoring complet', async () => {
    const compte = await make.account();
    await make.asset(compte, { category: 'VEHICULE', name: 'Polo' });
    const doc = await make.assetFile(compte, { assetId: null });
    await analyser(compte, doc.id, sortie({ texte: ['Intervention au 12 rue Exemple, 69003 Lyon'] }));
    expect(await resolution(doc.id)).toMatchObject({ status: 'NO_CANDIDATE' });
    expect(await actives(doc.id)).toEqual([expect.objectContaining({ kind: 'COMPLETE' })]);

    const m = await maison(compte, 'Maison', ADRESSE);
    const replay = await rejouer([]);
    expect(await balayer(compte)).toBe(1);
    await drainQueues();
    expect(appels(replay, 't1_analyze_document') + appels(replay, 't3_link_ambiguity')).toBe(0);
    expect(await colonne(doc.id)).toBe(m.id);
    expect(await actives(doc.id)).toEqual([]);
    const r = await resolution(doc.id);
    expect(r).toMatchObject({ status: 'RESOLVED', method: 'DETERMINISTIC' });
    // Monitoring : « Previous knowledge revision / Current / Trigger / Context changed / Result / AI call ».
    expect(r.e).toMatchObject({
      documentId: doc.id, reprocessReason: 'CONTEXT_CHANGED', previousResolution: 'NO_CANDIDATE', newResolution: 'RESOLVED',
      fingerprintChanged: true, aiCalled: false, result: 'RESOLVED_DETERMINISTICALLY', linkedAssetId: m.id, toProcessAction: 'CLOSED',
      candidateCount: 1, candidateSources: { [String(m.id)]: expect.arrayContaining(['STRONG_IDENTIFIER']) }, deterministicMatches: [`${m.id}:ADDRESS`],
    });
    expect(Number(r.e!.currentKnowledgeRevision)).toBeGreaterThan(Number(r.e!.previousKnowledgeRevision));
    expect(r.e!.knowledgeChanged).toEqual(expect.arrayContaining(['ASSET']));
    // Résolu : plus jamais repris.
    expect(await balayer(compte)).toBe(0);
  });

  it('T3C-02 — nouvel équipement : fait « n° de série » sans cible, équipement créé avec ce numéro → T3 précise le fait, relie le document à l’équipement, rattache au bien porteur — sans T1 ni IA', async () => {
    const compte = await make.account();
    await maison(compte, 'Maison A');
    const b = await maison(compte, 'Maison B');
    const doc = await make.assetFile(compte, { assetId: null });
    await analyser(compte, doc.id, sortie({ title: 'Entretien annuel', facts: [fait('serialNumber', 'SN-ABC12345', 'Numéro de série SN-ABC12345')] }));
    expect(await resolution(doc.id)).toMatchObject({ status: 'NO_CANDIDATE' });

    const [{ id: eq }] = await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name) VALUES (${b.id}, 'Chaudière') RETURNING id`;
    await sql`INSERT INTO equipment_cil_specs (equipment_id, serial_number) VALUES (${eq}, 'SNABC12345')`;
    const replay = await rejouer([]);
    const { reconcileOpenKnowledge } = await import('@/services/ai/reconciliation/continuous/open-knowledge.service');
    const ok = await reconcileOpenKnowledge(compte.id, { triggerCode: 'asset_updated' });
    expect(ok.facts).toMatchObject({ skipped: false, retargeted: 1, linkedEquipments: 1 });
    const [f] = await sql<{ target_type: string; target_entity_id: number; projection_rule: string }[]>`
      SELECT target_type, target_entity_id, projection_rule FROM document_facts WHERE file_id = ${doc.id} AND status = 'active' AND canonical_key = 'serialNumber'`;
    expect(f).toMatchObject({ target_type: 'EQUIPMENT', target_entity_id: eq, projection_rule: 'T3_IDENTIFIER_MATCH' });
    expect(await liens(doc.id)).toContainEqual(expect.objectContaining({ equipment_id: eq, link_role: 'SECONDARY', origin: 'AI' }));
    expect(ok.documents.enqueued).toBe(1);
    await drainQueues();
    expect(appels(replay, 't1_analyze_document') + appels(replay, 't3_link_ambiguity')).toBe(0);
    expect(await colonne(doc.id)).toBe(b.id);
    expect(await resolution(doc.id)).toMatchObject({ status: 'RESOLVED', method: 'DETERMINISTIC' });
    // Idempotence : un second passage n'écrit rien de plus (aucun doublon de lien, de fait).
    const avant = (await liens(doc.id)).length;
    const ok2 = await reconcileOpenKnowledge(compte.id, { triggerCode: 'asset_updated' });
    expect(ok2.facts?.retargeted ?? 0).toBe(0);
    expect((await liens(doc.id)).length).toBe(avant);
  });

  it('T3C-03 — un nouveau document apporte le contexte : même n° de contrat qu’un document rattaché à la Polo → le premier est rattaché à la Polo', async () => {
    const compte = await make.account();
    const polo = await make.asset(compte, { category: 'VEHICULE', name: 'Polo' });
    await make.asset(compte, { category: 'VEHICULE', name: 'Cupra' });
    const a = await make.assetFile(compte, { assetId: null });
    await analyser(compte, a.id, sortie({ title: 'Avenant au contrat', facts: [fait('insuranceContractNumber', 'POL-778899')] }));
    expect(await resolution(a.id)).toMatchObject({ status: 'NO_CANDIDATE' });

    const b = await make.assetFile(compte, { assetId: null });
    await analyser(compte, b.id, sortie({ title: 'Attestation d’assurance', assets: [{ id: polo.id, label: 'Polo' }], facts: [fait('insuranceContractNumber', 'POL-778899')] }));
    expect(await colonne(b.id)).toBe(polo.id);

    const replay = await rejouer([]);
    expect(await balayer(compte)).toBe(1);
    await drainQueues();
    expect(appels(replay, 't3_link_ambiguity')).toBe(0);
    expect(await colonne(a.id)).toBe(polo.id);
    expect(await resolution(a.id)).toMatchObject({ status: 'RESOLVED', method: 'DETERMINISTIC', reason_code: 'SHARED_REFERENCE' });
  });

  it('T3C-04 / T3D-06 — nouveau document SANS rapport : la révision change, le contexte de A non → CONFIRMED_NO_CHANGE, sans IA, aucune nouvelle carte', async () => {
    const compte = await make.account();
    await maison(compte, 'Maison de Valence');
    const a = await make.assetFile(compte, { assetId: null });
    await analyser(compte, a.id, sortie({ title: 'Facture fibre internet' }));
    const avant = await resolution(a.id);
    expect(avant.status).toBe('NO_CANDIDATE');
    const c = await make.assetFile(compte, { assetId: null });
    await analyser(compte, c.id, sortie({ title: 'Ticket de caisse' }));
    await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });

    const replay = await rejouer([]);
    expect(await balayer(compte)).toBe(0);
    expect(appels(replay, 't3_link_ambiguity')).toBe(0);
    const apres = await resolution(a.id);
    expect(apres).toMatchObject({ status: 'NO_CANDIDATE', runs: avant.runs, context_fingerprint: avant.context_fingerprint });
    expect(Number(apres.knowledge_revision)).toBeGreaterThan(Number(avant.knowledge_revision));
    expect(apres.e).toMatchObject({ result: 'CONFIRMED_NO_CHANGE', aiCalled: false, fingerprintChanged: false, candidateCount: 0 });
    expect(await cartes(a.id)).toHaveLength(1);
  });

  it('T3C-05 / T3D-04 — Informations complétées : VIN saisi sur la Polo → match déterministe, rattachement, À traiter fermé', async () => {
    const compte = await make.account();
    const polo = await make.asset(compte, { category: 'VEHICULE', name: 'Polo' });
    await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    const doc = await make.assetFile(compte, { assetId: null });
    await analyser(compte, doc.id, sortie({ title: 'Facture garage', facts: [fait('vin', 'WVWZZZ6RZHY123456')] }));
    expect(await resolution(doc.id)).toMatchObject({ status: 'NO_CANDIDATE' });
    expect(await actives(doc.id)).toHaveLength(1);

    await sql`UPDATE assets SET key_characteristics = ${JSON.stringify({ vin: 'WVWZZZ6RZHY123456' })} WHERE id = ${polo.id}`;
    const replay = await rejouer([]);
    expect(await balayer(compte)).toBe(1);
    await drainQueues();
    expect(appels(replay, 't3_link_ambiguity') + appels(replay, 't1_analyze_document')).toBe(0);
    expect(await colonne(doc.id)).toBe(polo.id);
    expect(await actives(doc.id)).toEqual([]);
  });

  it('T3C-06 / T3D-10 — choix utilisateur (Polo), nouvelle donnée suggérant un autre bien : jamais de déplacement automatique', async () => {
    const compte = await make.account();
    const polo = await make.asset(compte, { category: 'VEHICULE', name: 'Polo' });
    const doc = await make.assetFile(compte, { assetId: null });
    await analyser(compte, doc.id, sortie({ title: 'Contrat d’entretien — Cupra Formentor' }));
    const { linkDocumentToAsset } = await import('@/services/documents/document-asset-links');
    await linkDocumentToAsset({ accountId: compte.id, fileId: doc.id, target: { assetId: polo.id }, role: 'PRIMARY', origin: 'USER' });
    // Nouvelle connaissance : la Cupra Formentor est créée (nom cité dans le document).
    await make.asset(compte, { category: 'VEHICULE', name: 'Cupra Formentor' });
    const replay = await rejouer([T3_ABSTENTION]);
    expect(await balayer(compte)).toBe(0);
    const { resolveDocumentAsset } = await import('@/services/ai/reconciliation/document-asset/resolve-document-asset.service');
    expect(await resolveDocumentAsset({ accountId: compte.id, fileId: doc.id })).toMatchObject({ outcome: 'SUPERSEDED', status: 'USER_DECIDED', aiCalled: false });
    expect(appels(replay, 't3_link_ambiguity')).toBe(0);
    expect((await liens(doc.id)).filter((l) => l.link_role === 'PRIMARY')).toEqual([expect.objectContaining({ asset_id: polo.id, origin: 'USER' })]);
  });

  it('T3C-06 bis — contradiction FORTE avec le choix utilisateur (VIN d’un autre bien) : carte d’incohérence « À traiter », jamais de déplacement ; pas de doublon au passage suivant', async () => {
    const compte = await make.account();
    const polo = await make.asset(compte, { category: 'VEHICULE', name: 'Polo' });
    const cupra = await make.asset(compte, { category: 'VEHICULE', name: 'Cupra' });
    const doc = await make.assetFile(compte, { assetId: null });
    await analyser(compte, doc.id, sortie({ title: 'Facture pneus', facts: [fait('vin', 'VSSZZZKLZJR123456')] }));
    const { linkDocumentToAsset } = await import('@/services/documents/document-asset-links');
    await linkDocumentToAsset({ accountId: compte.id, fileId: doc.id, target: { assetId: polo.id }, role: 'PRIMARY', origin: 'USER' });
    await sql`UPDATE assets SET key_characteristics = ${JSON.stringify({ vin: 'VSSZZZKLZJR123456' })} WHERE id = ${cupra.id}`;
    const { reconcileOpenKnowledge } = await import('@/services/ai/reconciliation/continuous/open-knowledge.service');
    expect((await reconcileOpenKnowledge(compte.id)).userConflicts).toMatchObject({ proposed: 1 });
    const conflit = await sql<{ active: boolean; ctx: Record<string, unknown> }[]>`
      SELECT resolved_at IS NULL AS active, trigger_context AS ctx FROM to_process_actions
       WHERE target_type = 'DOCUMENT' AND target_id = ${doc.id} AND rule_code = 'LINK-ASSET-CONFLICT'`;
    expect(conflit).toEqual([expect.objectContaining({ active: true, ctx: expect.objectContaining({ currentAssetId: polo.id, suggestedAssetId: cupra.id }) })]);
    expect((await liens(doc.id)).filter((l) => l.link_role === 'PRIMARY')).toEqual([expect.objectContaining({ asset_id: polo.id, origin: 'USER' })]);
    // Aucune nouvelle connaissance : aucun nouveau passage, aucun doublon.
    expect((await reconcileOpenKnowledge(compte.id)).userConflicts).toMatchObject({ examined: 0, proposed: 0 });
    expect(await sql`SELECT 1 FROM to_process_actions WHERE target_id = ${doc.id} AND rule_code = 'LINK-ASSET-CONFLICT'`).toHaveLength(1);
  });

  it('T3C-07 — deux balayages sans changement : aucun appel IA, aucune nouvelle écriture ; relance du travail : NO_CHANGE, aucun doublon', async () => {
    const compte = await make.account();
    const a = await maison(compte, 'Maison A');
    const b = await maison(compte, 'Maison B');
    const doc = await make.assetFile(compte, { assetId: null });
    await analyser(compte, doc.id, sortie({
      assets: [{ id: a.id, label: 'Maison A', confidence: 'probable', score: 0.6 }, { id: b.id, label: 'Maison B', confidence: 'probable', score: 0.6 }],
    }), [T3_ABSTENTION]);
    expect(await resolution(doc.id)).toMatchObject({ status: 'ABSTAINED' });
    // Connaissance du compte modifiée sans rapport : balayage 1 → confirmation.
    await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    const replay = await rejouer([T3_ABSTENTION]);
    expect(await balayer(compte)).toBe(0);
    const s1 = await resolution(doc.id);
    expect(s1.e).toMatchObject({ result: 'CONFIRMED_NO_CHANGE' });
    // Balayage 2 : aucune évolution → rien (pas même une date).
    expect(await balayer(compte)).toBe(0);
    const s2 = await resolution(doc.id);
    expect(s2.updated_at).toEqual(s1.updated_at);
    expect(s2.evaluated_at).toEqual(s1.evaluated_at);
    // Relance explicite du travail : même contexte → NO_CHANGE, aucun appel, aucun doublon.
    const { resolveDocumentAsset } = await import('@/services/ai/reconciliation/document-asset/resolve-document-asset.service');
    expect(await resolveDocumentAsset({ accountId: compte.id, fileId: doc.id })).toMatchObject({ outcome: 'NO_CHANGE', aiCalled: false });
    expect(appels(replay, 't3_link_ambiguity')).toBe(0);
    expect(await cartes(doc.id)).toHaveLength(1);
    expect(await liens(doc.id)).toEqual(expect.not.arrayContaining([expect.objectContaining({ link_role: 'PRIMARY' })]));
  });

  it('T3C-08 / T3D-05 — nouvelle analyse ou nouveau fait : l’ancienne résolution devient obsolète, T3 réévalue', async () => {
    const compte = await make.account();
    const polo = await make.asset(compte, { category: 'VEHICULE', name: 'Polo', registrationNumber: 'AB-123-CD' });
    const doc = await make.assetFile(compte, { assetId: null });
    await analyser(compte, doc.id, sortie({ title: 'Facture garage' }));
    expect(await resolution(doc.id)).toMatchObject({ status: 'NO_CANDIDATE' });
    expect(await balayer(compte)).toBe(0);
    // Nouvelle analyse (représentation persistée plus récente) : reprise, motif NEW_ANALYSIS.
    await sql`UPDATE document_extractions SET extracted_at = now() + interval '1 minute' WHERE file_id = ${doc.id}`;
    expect(await balayer(compte)).toBe(1);
    await drainQueues();
    expect((await resolution(doc.id)).e).toMatchObject({ reprocessReason: 'NEW_ANALYSIS', result: 'NO_CANDIDATE' });
    // Nouveau fait (révalidation, enrichissement) : immatriculation → rattachement déterministe.
    await sql`INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, canonical_key, value_text, normalized_value, confidence, excerpt, status)
              SELECT account_id, file_id, id, 'registrationNumber', 'registrationNumber', 'AB-123-CD', 'AB-123-CD', 'certain', 'Immatriculation AB-123-CD', 'active'
                FROM document_extractions WHERE file_id = ${doc.id}`;
    const replay = await rejouer([]);
    expect(await balayer(compte)).toBe(1);
    await drainQueues();
    expect(appels(replay, 't1_analyze_document') + appels(replay, 't3_link_ambiguity')).toBe(0);
    expect(await colonne(doc.id)).toBe(polo.id);
    expect((await resolution(doc.id)).e).toMatchObject({ result: 'RESOLVED_DETERMINISTICALLY', knowledgeChanged: expect.arrayContaining(['FACT']) });
  });

  // ══ Ticket « réconciliation continue des documents non résolus » ═════════

  it('T3D-01 — aucun candidat T1, nom exact « Maison de Valence » dans le document : le Candidate Builder retrouve le bien, résolution sans IA', async () => {
    const compte = await make.account();
    const valence = await maison(compte, 'Maison de Valence');
    await maison(compte, 'Appartement de Lyon');
    const doc = await make.assetFile(compte, { assetId: null });
    const replay = await analyser(compte, doc.id, sortie({ title: 'Contrat d’assurance – Maison de Valence', assets: [] }));
    expect(appels(replay, 't3_link_ambiguity')).toBe(0);
    expect(await colonne(doc.id)).toBe(valence.id);
    const r = await resolution(doc.id);
    expect(r).toMatchObject({ status: 'RESOLVED', method: 'DETERMINISTIC', reason_code: 'DISTINCT_NAME' });
    expect((r.e!.candidateSources as Record<string, string[]>)[String(valence.id)]).toContain('EXACT_NAME');
  });

  it('T3D-02 / T3D-09 — aucun bien au moment de T1 (NO_CANDIDATE, carte À compléter), puis création du bien : nouvelle résolution automatique, carte fermée', async () => {
    const compte = await make.account();
    await maison(compte, 'Appartement de Lyon');
    const doc = await make.assetFile(compte, { assetId: null });
    await analyser(compte, doc.id, sortie({ title: 'Taxe foncière Maison de Valence' }));
    expect(await resolution(doc.id)).toMatchObject({ status: 'NO_CANDIDATE' });
    expect(await actives(doc.id)).toEqual([expect.objectContaining({ kind: 'COMPLETE' })]);
    const valence = await maison(compte, 'Maison de Valence');
    expect(await balayer(compte)).toBe(1);
    await drainQueues();
    expect(await colonne(doc.id)).toBe(valence.id);
    expect(await actives(doc.id)).toEqual([]);
    expect((await cartes(doc.id))[0]).toMatchObject({ active: false, reason: 'OBSOLETE' });
  });

  it('T3D-03 — renommage « Maison 1 » → « Maison de Valence » : empreinte différente, rerun, rattachement', async () => {
    const compte = await make.account();
    const m1 = await maison(compte, 'Maison 1');
    await maison(compte, 'Studio');
    const doc = await make.assetFile(compte, { assetId: null });
    await analyser(compte, doc.id, sortie({ title: 'Facture plombier — Maison de Valence' }));
    const avant = await resolution(doc.id);
    expect(avant.status).toBe('NO_CANDIDATE');
    await sql`UPDATE assets SET name = 'Maison de Valence' WHERE id = ${m1.id}`;
    expect(await balayer(compte)).toBe(1);
    await drainQueues();
    const r = await resolution(doc.id);
    expect(r.context_fingerprint).not.toBe(avant.context_fingerprint);
    expect(r.e).toMatchObject({ fingerprintChanged: true, reprocessReason: 'CONTEXT_CHANGED' });
    expect(await colonne(doc.id)).toBe(m1.id);
  });

  it('T3D-07 — libellé générique « maison », plusieurs maisons : même si le modèle en désigne une, pas d’auto-rattachement abusif → ARBITRATE', async () => {
    const compte = await make.account();
    const a = await maison(compte, 'Maison');
    const b = await maison(compte, 'Maison 2');
    await sousType(a.id, 'Maison'); await sousType(b.id, 'Maison');
    const doc = await make.assetFile(compte, { assetId: null });
    const choixModele: RecordedOutput = {
      operationCode: 't3_link_ambiguity', task: 'LINK_AMBIGUITY', repeat: true,
      output: { task: 'LINK_AMBIGUITY', matches: [{ candidateId: a.id, score: 0.95, confidence: 'certain', reason: 'maison' }] },
    };
    const replay = await analyser(compte, doc.id, sortie({ title: 'Facture de ramonage maison' }), [choixModele]);
    expect(appels(replay, 't3_link_ambiguity')).toBe(1);
    expect(await colonne(doc.id)).toBeNull();
    expect((await liens(doc.id)).filter((l) => l.link_role === 'PRIMARY')).toEqual([]);
    expect(await resolution(doc.id)).toMatchObject({ status: 'ABSTAINED' });
    const [carte] = await actives(doc.id);
    expect(carte.kind).toBe('ARBITRATE');
    expect(carte.proposals.map((p) => p.value).sort()).toEqual([a.id, b.id].sort());
  });

  it('T3D-08 — plusieurs candidats crédibles : T3 IA puis abstention → ARBITRATE avec les candidats ; COMPLETE → ARBITRATE quand ils apparaissent', async () => {
    const compte = await make.account();
    const doc = await make.assetFile(compte, { assetId: null });
    await maison(compte, 'Appartement de Lyon');
    await analyser(compte, doc.id, sortie({ title: 'Devis toiture Maison de Valence et Maison de Bourg' }));
    expect(await actives(doc.id)).toEqual([expect.objectContaining({ kind: 'COMPLETE' })]);
    const v = await maison(compte, 'Maison de Valence');
    const bg = await maison(compte, 'Maison de Bourg');
    const replay = await rejouer([T3_ABSTENTION]);
    expect(await balayer(compte)).toBe(1);
    await drainQueues();
    expect(appels(replay, 't3_link_ambiguity')).toBe(1);
    expect(await resolution(doc.id)).toMatchObject({ status: 'ABSTAINED' });
    const act = await actives(doc.id);
    expect(act).toHaveLength(1);
    expect(act[0].kind).toBe('ARBITRATE');
    expect(act[0].proposals.map((p) => p.value).sort()).toEqual([v.id, bg.id].sort());
    expect((await resolution(doc.id)).e).toMatchObject({ toProcessAction: 'CREATED', aiCalled: true });
  });

  it('T3D-11 — bien hors des 60 premiers transmis au modèle : retrouvé par le Candidate Builder serveur', async () => {
    const compte = await make.account();
    await sql`INSERT INTO assets (user_id, account_id, category, subtype, name)
              SELECT ${compte.ownerUserId}, ${compte.id}, 'IMMOBILIER', 'Maison', 'Maison ' || g FROM generate_series(1, 70) g`;
    const chalet = await maison(compte, 'Chalet des Arcs');
    const doc = await make.assetFile(compte, { assetId: null });
    const replay = await analyser(compte, doc.id, sortie({ title: 'Taxe foncière — Chalet des Arcs' }));
    expect(appels(replay, 't3_link_ambiguity')).toBe(0);
    expect(await colonne(doc.id)).toBe(chalet.id);
  });

  it('T3D-12 — ancien NO_CANDIDATE historique (version antérieure) : réellement réévalué avec le nouveau Candidate Builder, pas recopié', async () => {
    const compte = await make.account();
    const valence = await maison(compte, 'Maison de Valence');
    const doc = await make.assetFile(compte, { assetId: null });
    await analyser(compte, doc.id, sortie({ title: 'Assurance habitation Maison de Valence' }));
    // État historique : décision NO_CANDIDATE de l'ancien moteur (lot 32C), sans contexte.
    await sql`DELETE FROM document_asset_links WHERE file_id = ${doc.id}`;
    await sql`UPDATE asset_files SET asset_id = NULL, user_edited_fields = NULL WHERE id = ${doc.id}`;
    await sql`UPDATE document_asset_resolutions SET status = 'NO_CANDIDATE', last_outcome = 'NO_CANDIDATE', resolution_version = 2,
                knowledge_revision = NULL, context_fingerprint = NULL, last_evaluation = NULL WHERE file_id = ${doc.id}`;
    expect(await balayer(compte)).toBe(1);
    await drainQueues();
    expect(await colonne(doc.id)).toBe(valence.id);
    const r = await resolution(doc.id);
    expect(r).toMatchObject({ status: 'RESOLVED', resolution_version: 3 });
    expect(r.e).toMatchObject({ reprocessReason: 'ENGINE_VERSION', previousResolution: 'NO_CANDIDATE' });
  });
});
