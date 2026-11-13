/**
 * Lot 113AM — Trello #739 « [P1][Régression] Rattachement documentaire — Une
 * adresse de correspondance ne doit jamais rattacher à la Maison », sur
 * PostgreSQL réel (base dédiée), modèle IA SIMULÉ (sorties rejouées).
 *
 * VOIE FAUTIVE DÉMONTRÉE (doc 126, lien #331) : projection T1 —
 * `resolveAssetByIdentifiers` (adresse lue dans le texte, égale à celle de la
 * Maison) → `mergeIdentifierCandidates` (candidat VÉRIFIÉ certain, raison
 * « identifiant canonique exact (contrôle serveur) ») →
 * `computeMasterDocumentLinks` (MENTIONED, confiance 1) →
 * `writeMasterDocumentLinks` → `linkDocumentToAsset` (origine AI). Quand le
 * bien du document n'était pas un choix humain, la même correspondance faisait
 * de la Maison le bien du document (PRIMARY + colonne `assetIdAuto`). AM0 la
 * reproduit à l'identique de l'algorithme d'avant (identification brute).
 *
 * Cas obligatoires du ticket :
 *   AM1 avis d'assurance du vélo + adresse du souscripteur = Maison : vélo seulement (deux états de départ) ;
 *   AM2 facture d'entretien de la voiture + adresse de facturation = Maison : voiture seulement ;
 *   AM3 taxe foncière désignant la Maison par son adresse : Maison rattachée (T1, puis T3 rétroactif) ;
 *   AM4 document multi-biens prouvé : liens justifiés seulement, aucune transitivité ;
 *   AM5 rattachement utilisateur existant : ni modifié ni complété sur un simple indice concurrent ;
 *   AM6 rejouer le doc 126 : lien erroné retiré par le rattrapage BO (simuler / appliquer avec motif /
 *       restaurer, idempotent, lien USER intact), absent après réanalyse T1, passage T3 et cohérence ;
 * et la garde partagée sur les autres voies :
 *   AM7 T3 DOCUMENT_ASSET (document sans bien) : aucune décision déterministe ni question sur la Maison ;
 *   AM8 revue #711 multi-biens et primitives d'écriture : refus journalisés (étape, règle, preuves).
 */
import { afterEach, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { drainQueues, sortieT1, useTargetState, type FaitT1 } from '../chain';
import type { RecordedOutput } from '../replay-gateway';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));
const marqueur = { actif: true };
vi.mock('@/services/ai/reconciliation/document-asset/attachment-review/contract', async (o) => ({
  ...(await o<object>()), attachmentReviewContractActive: async () => marqueur.actif,
}));

type Compte = { id: number; ownerUserId: number };
const ADRESSE_MAISON = { address1: '12 rue des Lilas', postalCode: '69003', city: 'Lyon' };
const SOUSCRIPTEUR = ['Souscripteur : M. Jean Fourche', '12 rue des Lilas 69003 Lyon'];

scenario('L113AM', 'Rattachement documentaire : une adresse de correspondance ne rattache jamais à la Maison', ({ sql, make, useRecordings: rejouer }) => {
  useTargetState();
  afterEach(() => { marqueur.actif = true; });

  const T3_ABS: RecordedOutput = { operationCode: 't3_link_ambiguity', task: 'LINK_AMBIGUITY', output: { task: 'LINK_AMBIGUITY', matches: [] }, repeat: true };
  const revue = (o: Record<string, unknown>, extra: Record<string, unknown> = {}): RecordedOutput => ({
    operationCode: 't3_link_ambiguity', task: 'LINK_AMBIGUITY', repeat: true,
    output: { task: 'LINK_AMBIGUITY', matches: [], documentScope: 'SINGLE', attachmentReview: o, ...extra },
  });
  const analyser = async (compte: Compte, fileId: number, out: Record<string, unknown>, recordings: RecordedOutput[] = [T3_ABS]) => {
    await sql`UPDATE asset_files SET s3_bucket = 'e2e-bucket', original_filename = coalesce(original_filename, ${`doc-${fileId}.pdf`}),
                analysis_state = NULL WHERE id = ${fileId}`;
    const replay = await rejouer([{ operationCode: 't1_analyze_document', task: 'ANALYZE_DOCUMENT', output: out }, ...recordings]);
    const { analyzeFileSources } = await import('@/services/ai/source-analysis/entrypoint');
    const r = await analyzeFileSources([fileId], compte.id, { userId: compte.ownerUserId, billable: false, origin: 'e2e/l113am' });
    if (!r || r.results.length === 0) throw new Error(`[e2e] analyse du fichier ${fileId} en échec`);
    await drainQueues();
    return { replay };
  };
  const passageT3 = async (compte: Compte, recordings: RecordedOutput[] = [T3_ABS]) => {
    const replay = await rejouer(recordings);
    const { reconcileAccount } = await import('@/services/ai/reconciliation/account-reconciliation.service');
    await reconcileAccount(compte.id, { type: 'scheduled' }, { triggerCode: 'asset_updated' });
    await drainQueues();
    return replay;
  };
  const avis = (velo: { id: number }, texte: string[] = SOUSCRIPTEUR) => sortieT1({
    title: 'Avis d’échéance assurance', date: '2026-01-15', documentTypeCode: 'INSURANCE_CERTIFICATE', rubricCode: 'INSURANCE',
    supplier: 'Assureur Démo', assets: [{ id: velo.id, label: 'VELO' }], facts: [], multiAsset: false,
    texte: [...texte, 'Véhicule assuré : VELO'],
  });
  const liens = async (fileId: number) => sql<{ id: number; asset_id: number | null; link_role: string; origin: string; status: string }[]>`
    SELECT id::int AS id, asset_id, link_role, origin, status FROM document_asset_links WHERE file_id = ${fileId} ORDER BY id`;
  const actifsVers = async (fileId: number, assetId: number) => (await liens(fileId)).filter((l) => l.status === 'ACTIVE' && l.asset_id === assetId);
  const principal = async (fileId: number) => (await sql<{ a: number | null }[]>`SELECT asset_id AS a FROM asset_files WHERE id = ${fileId}`)[0].a;
  const cartes = async (fileId: number) => sql<{ id: number; rule: string; question: string }[]>`
    SELECT id, rule_code AS rule, question FROM to_process_actions WHERE target_type = 'DOCUMENT' AND target_id = ${fileId} AND resolved_at IS NULL
       AND rule_code LIKE 'LINK-%'`;
  const journal = async (fileId: number) => sql<{ asset_id: number | null; step: string; decision: string; reason_code: string; proofs: Array<Record<string, unknown>>; write_kind: string; run_id: string | null; motive: string | null }[]>`
    SELECT asset_id, step, decision, reason_code, proofs, write_kind, run_id::text AS run_id, motive FROM document_asset_link_admissions WHERE file_id = ${fileId} ORDER BY id`;
  const compteVeloMaison = async () => {
    const compte = await make.account();
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison', keyCharacteristics: ADRESSE_MAISON });
    const velo = await make.asset(compte, { category: 'VEHICULE', name: 'Vélo Jean Fourche' });
    return { compte, maison, velo };
  };
  const reparer = async (action: 'simulate' | 'apply' | 'restore', compte: Compte, extra: { runId?: string; reason?: string | null } = {}) => {
    const { executeBackfill } = await import('@/services/admin/ops/backfill/executors');
    const hooks = { log: () => {}, progress: () => {} };
    const out = await executeBackfill(sql, { script: 'document-address-links', action, step: null, runId: extra.runId ?? null, accountId: compte.id,
      reason: extra.reason === undefined ? (action === 'simulate' ? null : 'recette 113AM — lien #331') : extra.reason }, hooks);
    return out.result as Record<string, any>;
  };

  it('AM0 — voie fautive démontrée : l’algorithme d’avant (identification brute) faisait de la Maison un candidat vérifié certain → lien MENTIONED', async () => {
    const { resolveAssetByIdentifiers } = await import('@/services/ai/reconciliation/document-asset/identifiers');
    const { mergeIdentifierCandidates, SERVER_IDENTIFIER_REASON } = await import('@/services/ai/source-analysis/steps/analyze-document.step');
    const { computeMasterDocumentLinks } = await import('@/services/ai/source-analysis/master/document-links');
    const { admissibleIdentification } = await import('@/services/ai/reconciliation/document-asset/address-roles');
    const records = [{ assetId: 14, family: 'IMMOBILIER' as const, values: ADRESSE_MAISON }, { assetId: 18, family: 'OBJECT' as const, values: {} }];
    const textes = [[...SOUSCRIPTEUR, 'Véhicule assuré : VELO'].join('\n')];
    const brute = resolveAssetByIdentifiers(records, { facts: [], texts: textes });
    expect(brute).toMatchObject({ uniqueAssetId: 14, matches: [{ assetId: 14, kind: 'ADDRESS', via: 'text' }] });
    const velo = { entityId: 18, confidence: 'certain' as const, score: 0.97, reason: 'désignation lue', excerpt: 'VELO', verified: true };
    const avant = mergeIdentifierCandidates([velo], brute);
    expect(avant.find((c) => c.entityId === 14)).toMatchObject({ verified: true, confidence: 'certain', score: 1, reason: SERVER_IDENTIFIER_REASON });
    // Bien choisi par l'utilisateur (vélo) : Maison MENTIONED, confiance 1 (= lien #331, rapport 7206 séquence 218).
    expect(computeMasterDocumentLinks({ facts: [], assetCandidates: avant, documentAssetId: 18, knownAssetId: 18 }))
      .toContainEqual({ assetId: 14, role: 'MENTIONED', confidence: 1 });
    // Bien automatique (aucun choix humain) : `uniqueAssetId` = Maison devenait le bien du document (PRIMARY + colonne).
    // Après : l'adresse du souscripteur est qualifiée, retirée de l'identification.
    const apres = admissibleIdentification({ records, resolution: brute, facts: [], texts: textes });
    expect(apres.resolution.assetIds).toEqual([]);
    // Adresse sous « Souscripteur : M. Jean Fourche » : rôle non établi (jamais « lieu du bien »).
    expect(apres.qualifications).toEqual([expect.objectContaining({ assetId: 14, role: 'UNQUALIFIED' })]);
  });

  it('AM1 — avis d’assurance du vélo, adresse du souscripteur = Maison : vélo seulement (choix humain ou lien IA de départ), aucune carte', async () => {
    // a) Document déposé sur le vélo (doc 126, lien #45 légitime).
    const { compte, maison, velo } = await compteVeloMaison();
    const doc = await make.assetFile(compte, { assetId: velo.id });
    await analyser(compte, doc.id, avis(velo), [revue({ decision: 'KEEP_CURRENT', concernedAssetIds: [velo.id], citedIndexIds: [1], reason: 'Adresse du souscripteur.' })]);
    expect(await actifsVers(doc.id, maison.id)).toEqual([]);
    expect(await actifsVers(doc.id, velo.id)).toHaveLength(1);
    expect(await principal(doc.id)).toBe(velo.id);
    expect(await cartes(doc.id)).toEqual([]);
    expect((await journal(doc.id)).filter((j) => j.asset_id === maison.id && j.decision === 'ADMITTED')).toEqual([]);
    // b) Vélo relié par un lien IA sans colonne (bien NON choisi par l'utilisateur) : avant, la Maison devenait PRIMARY + colonne.
    const doc2 = await make.assetFile(compte, {});
    await sql`INSERT INTO document_asset_links (account_id, file_id, asset_id, link_role, origin, confidence, status) VALUES (${compte.id}, ${doc2.id}, ${velo.id}, 'PRIMARY', 'AI', 1, 'ACTIVE')`;
    await analyser(compte, doc2.id, avis(velo));
    expect(await actifsVers(doc2.id, maison.id)).toEqual([]);
    expect(await principal(doc2.id)).toBe(velo.id);
    expect(await cartes(doc2.id)).toEqual([]);
  }, 180_000);

  it('AM2 — facture d’entretien de la voiture, adresse de facturation = Maison : voiture seulement', async () => {
    const compte = await make.account();
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison', keyCharacteristics: ADRESSE_MAISON });
    const voiture = await make.asset(compte, { category: 'VEHICULE', name: 'Polo', registrationNumber: 'AB-123-CD' });
    const doc = await make.assetFile(compte, {});
    await analyser(compte, doc.id, sortieT1({
      title: 'Facture entretien', date: '2026-03-10', documentTypeCode: 'MAINTENANCE_INVOICE', rubricCode: 'MAINTENANCE_WORKS', supplier: 'Garage Démo',
      assets: [{ id: voiture.id, label: 'Polo' }], facts: [], amountCents: 18900, multiAsset: false,
      texte: ['Adresse de facturation : 12 rue des Lilas 69003 Lyon', 'Véhicule : Polo AB-123-CD', 'Vidange et filtres'],
    }));
    expect(await principal(doc.id)).toBe(voiture.id);
    expect(await actifsVers(doc.id, maison.id)).toEqual([]);
    expect(await cartes(doc.id)).toEqual([]);
  }, 120_000);

  it('AM3 — taxe foncière désignant la Maison par son adresse : Maison rattachée (T1), puis rétroactivement par T3 quand l’adresse arrive sur la fiche', async () => {
    const compte = await make.account();
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison', keyCharacteristics: ADRESSE_MAISON });
    const doc = await make.assetFile(compte, {});
    const taxe = sortieT1({
      title: 'Avis de taxe foncière', date: '2025-09-15', documentTypeCode: 'OTHER', rubricCode: 'PROPERTY_MANAGEMENT', supplier: 'Finances publiques',
      assets: [], facts: [], multiAsset: false, texte: ['Adresse du bien : 12 rue des Lilas 69003 Lyon', 'Montant de la taxe'],
    });
    await analyser(compte, doc.id, taxe);
    expect(await principal(doc.id)).toBe(maison.id);
    const j = (await journal(doc.id)).find((x) => x.asset_id === maison.id && x.decision === 'ADMITTED' && x.step === 'T1_PROJECTION');
    expect(j?.proofs).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'IDENTIFIER', identifierKind: 'ADDRESS', addressRole: 'PROPERTY_LOCATION' })]));
    // Rétroactif : document analysé AVANT que la fiche porte l'adresse, puis passage T3.
    const compte2 = await make.account();
    const maison2 = await make.asset(compte2, { category: 'IMMOBILIER', name: 'Maison' });
    const doc2 = await make.assetFile(compte2, {});
    await analyser(compte2, doc2.id, taxe);
    expect(await principal(doc2.id)).toBeNull();
    await sql`UPDATE assets SET key_characteristics = ${JSON.stringify(ADRESSE_MAISON)}::jsonb WHERE id = ${maison2.id}`;
    await passageT3(compte2);
    expect(await principal(doc2.id)).toBe(maison2.id);
  }, 240_000);

  it('AM4 — multi-biens explicitement prouvé : chaque lien justifié, rien de plus (aucune transitivité)', async () => {
    const compte = await make.account();
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison', keyCharacteristics: ADRESSE_MAISON });
    const voiture = await make.asset(compte, { category: 'VEHICULE', name: 'Polo', registrationNumber: 'AB-123-CD' });
    const velo = await make.asset(compte, { category: 'VEHICULE', name: 'Vélo Jean Fourche' });
    const doc = await make.assetFile(compte, { assetId: maison.id });
    const plaque: FaitT1 = { canonicalKey: 'registrationNumber', value: 'AB-123-CD', valueType: 'string', excerpt: 'Véhicule assuré : Polo AB-123-CD', assetId: voiture.id };
    await analyser(compte, doc.id, sortieT1({
      title: 'Attestation multirisque', date: '2026-02-01', documentTypeCode: 'INSURANCE_CERTIFICATE', rubricCode: 'INSURANCE', supplier: 'Assureur Démo',
      assets: [{ id: maison.id, label: 'Maison' }, { id: voiture.id, label: 'Polo' }], facts: [plaque], multiAsset: true,
      texte: ['Habitation assurée : 12 rue des Lilas 69003 Lyon'],
    }), [revue({ decision: 'MULTIPLE', concernedAssetIds: [maison.id, voiture.id], citedIndexIds: [1], reason: 'Contrat maison et Polo.' }, { documentScope: 'MULTIPLE' })]);
    expect(await principal(doc.id)).toBe(maison.id);
    expect((await actifsVers(doc.id, voiture.id)).map((l) => l.link_role)).toEqual(['SECONDARY']);
    expect(await actifsVers(doc.id, velo.id)).toEqual([]);
    // Aucune transitivité : un document du vélo qui ne cite ni la maison ni la Polo n'hérite d'aucun lien.
    const doc2 = await make.assetFile(compte, { assetId: velo.id });
    await analyser(compte, doc2.id, avis(velo, ['Contrat vélo']));
    expect((await liens(doc2.id)).filter((l) => l.status === 'ACTIVE').map((l) => l.asset_id)).toEqual([velo.id]);
  }, 180_000);

  it('AM5 — rattachement utilisateur existant : ni modifié ni complété sur un simple indice concurrent (même une adresse « du bien »)', async () => {
    const { compte, maison, velo } = await compteVeloMaison();
    const doc = await make.assetFile(compte, { assetId: velo.id });
    const avantLiens = await liens(doc.id);
    await analyser(compte, doc.id, avis(velo, ['Adresse du bien : 12 rue des Lilas 69003 Lyon']),
      [revue({ decision: 'KEEP_CURRENT', concernedAssetIds: [velo.id], citedIndexIds: [1], reason: 'Le contrat assure le vélo.' })]);
    expect(await principal(doc.id)).toBe(velo.id);
    expect(await actifsVers(doc.id, maison.id)).toEqual([]);
    expect((await liens(doc.id)).filter((l) => l.status === 'ACTIVE').map((l) => [l.id, l.asset_id, l.origin]))
      .toEqual(avantLiens.filter((l) => l.status === 'ACTIVE').map((l) => [l.id, l.asset_id, l.origin]));
    expect(await cartes(doc.id)).toEqual([]);
  }, 120_000);

  it('AM6 — rejouer le doc 126 : lien erroné détecté par preuve, retiré avec motif, restaurable, idempotent ; lien USER intact ; aucune réapparition (T1, T3, cohérence)', async () => {
    const { compte, maison, velo } = await compteVeloMaison();
    const doc = await make.assetFile(compte, { assetId: velo.id });
    await analyser(compte, doc.id, avis(velo), [revue({ decision: 'KEEP_CURRENT', concernedAssetIds: [velo.id], citedIndexIds: [1], reason: 'Adresse du souscripteur.' })]);
    // État de préproduction (antérieur au correctif) : lien #331, AI MENTIONED confiance 1.
    const [l331] = await sql<{ id: number }[]>`INSERT INTO document_asset_links (account_id, file_id, asset_id, link_role, origin, confidence, status)
      VALUES (${compte.id}, ${doc.id}, ${maison.id}, 'MENTIONED', 'AI', 1, 'ACTIVE') RETURNING id::int AS id`;
    // Même texte, mais lien CONFIRMÉ par l'utilisateur : jamais touché.
    const docUser = await make.assetFile(compte, { assetId: velo.id });
    await analyser(compte, docUser.id, avis(velo), [revue({ decision: 'KEEP_CURRENT', concernedAssetIds: [velo.id], citedIndexIds: [1], reason: 'Adresse du souscripteur.' })]);
    await sql`INSERT INTO document_asset_links (account_id, file_id, asset_id, link_role, origin, confidence, status) VALUES (${compte.id}, ${docUser.id}, ${maison.id}, 'SECONDARY', 'USER', 1, 'ACTIVE')`;
    // Document de la Maison réellement prouvé (taxe foncière) : conservé.
    const docTaxe = await make.assetFile(compte, {});
    await analyser(compte, docTaxe.id, sortieT1({ title: 'Avis de taxe foncière', date: '2025-09-15', documentTypeCode: 'OTHER', rubricCode: 'PROPERTY_MANAGEMENT',
      supplier: null, assets: [], facts: [], multiAsset: false, texte: ['Adresse du bien : 12 rue des Lilas 69003 Lyon'] }));
    expect(await principal(docTaxe.id)).toBe(maison.id);

    const sim = await reparer('simulate', compte);
    expect(sim).toMatchObject({ mode: 'simulate', erroneous: 1, repaired: 0 });
    expect(sim.samples).toEqual([expect.objectContaining({ fileId: doc.id, assetId: maison.id, linkId: l331.id, addressRole: 'UNQUALIFIED', repaired: false })]);
    expect(JSON.stringify(sim)).not.toMatch(/rue des Lilas/i);
    expect(await actifsVers(doc.id, maison.id)).toHaveLength(1);
    // Appliquer : motif obligatoire.
    await expect(reparer('apply', compte, { reason: null })).rejects.toThrow(/Motif/);
    const app = await reparer('apply', compte);
    expect(app).toMatchObject({ mode: 'apply', erroneous: 1, repaired: 1, derived: { reconciled: 1, failed: 0 } });
    expect(await actifsVers(doc.id, maison.id)).toEqual([]);
    expect((await liens(doc.id)).find((l) => l.id === l331.id)?.status).toBe('REMOVED');
    expect(await actifsVers(docUser.id, maison.id)).toHaveLength(1);
    expect(await principal(docTaxe.id)).toBe(maison.id);
    expect(await principal(doc.id)).toBe(velo.id);
    expect((await journal(doc.id)).filter((x) => x.decision === 'REPAIRED')).toEqual([expect.objectContaining({ asset_id: maison.id, run_id: app.runId, motive: 'recette 113AM — lien #331' })]);
    // Idempotent.
    expect(await reparer('apply', compte)).toMatchObject({ erroneous: 0, repaired: 0 });
    // Restaurer, puis réappliquer.
    expect(await reparer('restore', compte, { runId: app.runId })).toMatchObject({ restored: 1, skipped: 0 });
    expect(await actifsVers(doc.id, maison.id)).toHaveLength(1);
    expect(await reparer('restore', compte, { runId: app.runId })).toMatchObject({ restored: 0 });
    expect(await reparer('apply', compte)).toMatchObject({ repaired: 1 });
    await drainQueues();
    // Aucune réapparition : réanalyse T1, passage T3 (dont revue des « À traiter » ouverts), cohérence corrective.
    await analyser(compte, doc.id, avis(velo), [revue({ decision: 'KEEP_CURRENT', concernedAssetIds: [velo.id], citedIndexIds: [1], reason: 'Adresse du souscripteur.' })]);
    await passageT3(compte, [revue({ decision: 'KEEP_CURRENT', concernedAssetIds: [velo.id], citedIndexIds: [1], reason: 'Adresse du souscripteur.' })]);
    const { runCoherenceFor } = await import('../coherence-run');
    await runCoherenceFor(sql, [compte.id], { mode: 'CORRECTIVE' });
    await drainQueues();
    expect(await actifsVers(doc.id, maison.id)).toEqual([]);
    expect(await principal(doc.id)).toBe(velo.id);
    expect(await cartes(doc.id)).toEqual([]);
  }, 300_000);

  it('AM6 bis — état antérieur « Maison PRIMARY + colonne automatique » : la réanalyse T1 rend le vélo, le rattrapage remet la colonne à vide', async () => {
    const { compte, maison, velo } = await compteVeloMaison();
    // Réanalyse : le lien AI d'une analyse antérieure vers la Maison n'est plus justifié → retiré par T1 lui-même.
    const doc = await make.assetFile(compte, {});
    await sql`INSERT INTO document_asset_links (account_id, file_id, asset_id, link_role, origin, confidence, status) VALUES (${compte.id}, ${doc.id}, ${maison.id}, 'PRIMARY', 'AI', 1, 'ACTIVE')`;
    await sql`UPDATE asset_files SET asset_id = ${maison.id}, user_edited_fields = jsonb_build_object('assetIdAuto', ${maison.id}::int) WHERE id = ${doc.id}`;
    await analyser(compte, doc.id, avis(velo));
    expect(await actifsVers(doc.id, maison.id)).toEqual([]);
    expect(await principal(doc.id)).toBe(velo.id);
    // Rattrapage (sans réanalyse) : lien AI + colonne automatique retirés, rattachement réexaminé par T3.
    const doc2 = await make.assetFile(compte, {});
    await analyser(compte, doc2.id, avis(velo));
    await sql`UPDATE document_asset_links SET status = 'REMOVED', removed_at = now() WHERE file_id = ${doc2.id} AND status = 'ACTIVE'`;
    await sql`UPDATE asset_files SET asset_id = NULL, user_edited_fields = '{}'::jsonb WHERE id = ${doc2.id}`;
    await sql`INSERT INTO document_asset_links (account_id, file_id, asset_id, link_role, origin, confidence, status) VALUES (${compte.id}, ${doc2.id}, ${maison.id}, 'PRIMARY', 'AI', 1, 'ACTIVE')`;
    await sql`UPDATE asset_files SET asset_id = ${maison.id}, user_edited_fields = jsonb_build_object('assetIdAuto', ${maison.id}::int) WHERE id = ${doc2.id}`;
    const app = await reparer('apply', compte);
    expect(app).toMatchObject({ repaired: 1, derived: { resolutionRequested: 1 } });
    expect(await principal(doc2.id)).not.toBe(maison.id);
    expect(await actifsVers(doc2.id, maison.id)).toEqual([]);
    expect(await reparer('restore', compte, { runId: app.runId })).toMatchObject({ restored: 1 });
    expect(await principal(doc2.id)).toBe(maison.id);
  }, 240_000);

  it('AM7 — T3 DOCUMENT_ASSET, document sans bien : l’adresse du souscripteur ne décide rien et ne crée aucune question sur la Maison', async () => {
    const { compte, maison } = await compteVeloMaison();
    const doc = await make.assetFile(compte, {});
    await analyser(compte, doc.id, sortieT1({
      title: 'Courrier assureur', date: '2026-01-15', documentTypeCode: 'OTHER', rubricCode: 'INSURANCE', supplier: 'Assureur Démo',
      assets: [], facts: [], multiAsset: false, texte: SOUSCRIPTEUR,
    }));
    await passageT3(compte);
    expect(await principal(doc.id)).toBeNull();
    expect(await actifsVers(doc.id, maison.id)).toEqual([]);
    const res = (await sql<{ method: string | null; reason_code: string | null; candidates: unknown }[]>`
      SELECT method, reason_code, candidates FROM document_asset_resolutions WHERE file_id = ${doc.id}`)[0];
    expect(res.reason_code ?? '').not.toMatch(/IDENTIFIER_EXACT/);
    expect(JSON.stringify(res.candidates ?? [])).not.toContain(`"assetId":${maison.id}`);
    for (const c of await cartes(doc.id)) expect(c.question).not.toContain('Maison');
  }, 180_000);

  it('AM8 — garde partagée sur les primitives et la revue #711 : refus journalisés (étape, règle, preuves), aucune écriture', async () => {
    const { compte, maison, velo } = await compteVeloMaison();
    const doc = await make.assetFile(compte, { assetId: velo.id });
    await analyser(compte, doc.id, avis(velo), [revue({ decision: 'MULTIPLE', concernedAssetIds: [velo.id, maison.id], citedIndexIds: [1], reason: 'Le document cite la maison.' },
      { documentScope: 'MULTIPLE', matches: [{ candidateId: velo.id, score: 0.95, confidence: 'certain', reason: 'vélo' }, { candidateId: maison.id, score: 0.9, confidence: 'certain', reason: 'adresse' }] })]);
    // La revue juge la Maison concernée sur la seule adresse du souscripteur : lien refusé, aucune carte.
    expect(await actifsVers(doc.id, maison.id)).toEqual([]);
    expect(await cartes(doc.id)).toEqual([]);
    const revueTrace = (await sql<{ r: Record<string, any> | null }[]>`SELECT attachment_review AS r FROM document_asset_resolutions WHERE file_id = ${doc.id}`)[0]?.r;
    expect(revueTrace).toMatchObject({ secondaryRefused: [maison.id], secondaryLinked: [] });
    expect(await journal(doc.id)).toEqual(expect.arrayContaining([expect.objectContaining({
      asset_id: maison.id, step: 'T3_ATTACHMENT_REVIEW', decision: 'REFUSED', reason_code: 'ADDRESS_NOT_QUALIFIED', write_kind: 'LINK',
    })]));
    // Primitives : lien AI sans preuve admissible, colonne automatique sans justification.
    const { linkDocumentToAsset } = await import('@/services/documents/document-asset-links');
    const r = await linkDocumentToAsset({ accountId: compte.id, fileId: doc.id, target: { assetId: maison.id }, role: 'MENTIONED', origin: 'AI', confidence: 1,
      justification: { step: 'OTHER', rule: 'E2E', proofs: [{ kind: 'IDENTIFIER', identifierKind: 'ADDRESS', addressRole: 'CORRESPONDENCE' }] } });
    expect(r.outcome).toBe('refused');
    const doc2 = await make.assetFile(compte, {});
    const { ASSET_LINK_SLOT } = await import('@/services/to-process/document-slots');
    const { db } = await import('@/db');
    expect(await ASSET_LINK_SLOT.writeAuto(db, compte.id, doc2.id, maison.id, { origin: 'RECONCILIATION', confidence: 1 })).toBe(false);
    expect(await principal(doc2.id)).toBeNull();
    expect(await journal(doc2.id)).toEqual([expect.objectContaining({ asset_id: maison.id, decision: 'REFUSED', reason_code: 'NO_JUSTIFICATION', write_kind: 'PRIMARY_COLUMN' })]);
    expect(JSON.stringify(await journal(doc.id))).not.toMatch(/rue des Lilas/i);
  }, 180_000);
});
