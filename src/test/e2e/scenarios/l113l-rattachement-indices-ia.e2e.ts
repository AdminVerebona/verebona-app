/**
 * Lot 113L — ticket #711 « Rattachement documentaire — Confier à l'IA
 * l'arbitrage des indices et supprimer les faux conflits automatiques », sur
 * PostgreSQL réel (base dédiée), modèle IA SIMULÉ (sorties rejouées).
 *
 * Chaîne de production : `analyzeFileSources` (T1 rejoué) → abonné
 * `source_analyzed` → travail T3 `document_attachment_review` (file durable)
 * → passerelle IA (`t3_link_ambiguity`) → contrôle serveur → carte / trace.
 *
 * Les cas « assurance vélo + adresse de la maison » sont des CAS DE RECETTE
 * (données synthétiques reproduisant les documents 120 / 125 / 127 du compte
 * 13), jamais une exception codée : la décision vient de la sortie du modèle.
 *
 *   R1  assurance vélo + adresse personnelle = maison : aucune carte, vélo conservé,
 *       indices et unités sources tracés, valeur d'adresse jamais transmise ;
 *   R2  réanalyse `tco-amount-recovery` puis réanalyse ordinaire : décision réutilisée,
 *       aucun appel, aucune carte ; élément nouveau → nouvel appel ;
 *   R3  facture avec adresse de livraison d'un autre bien : décision du modèle, aucune carte ;
 *   R4  vrai conflit : UNE carte justifiée, aucun déplacement ; « Garder » respecté ;
 *   R5  identifiant cité à titre secondaire : aucune priorité à la correspondance brute ;
 *   R6  multi-biens : aucun choix exclusif, bien lié en SECONDARY ;
 *   R7  ambiguïté réelle : une seule carte, choix neutres, pas de doublon ;
 *   R8  échec IA / réponse invalide : aucune carte, trace et Supervision ;
 *   R9  anciennes cartes (base IDENTIFIER) : réévaluées par la phase « À traiter
 *       ouverts » — faux conflits fermés, vrai conflit maintenu, « Ignorer » respecté,
 *       idempotent (second passage : aucun appel) ;
 *   R10 sans le bloc 22 (prompt actif sans marqueur) : décision lue dans `matches`.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { drainQueues, sortieT1, useTargetState } from '../chain';
import type { RecordedOutput } from '../replay-gateway';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

/** Prompt actif « avec le bloc 22 » (marqueur) ou non — simulé : le texte du prompt n'est jamais modifié par le code. */
const marqueur = { actif: true };
vi.mock('@/services/ai/reconciliation/document-asset/attachment-review/contract', async (o) => ({
  ...(await o<object>()), attachmentReviewContractActive: async () => marqueur.actif,
}));

type Compte = { id: number; ownerUserId: number };
const ADRESSE_MAISON = { address1: '12 rue des Lilas', postalCode: '69003', city: 'Lyon' };
const ADRESSE_STUDIO = { address1: '4 avenue des Tilleuls', postalCode: '69006', city: 'Lyon' };

scenario('L113L', 'Rattachement documentaire : indices soumis à l’IA, plus de faux conflit automatique', ({ sql, make, useRecordings: rejouer }) => {
  useTargetState();
  afterEach(() => { marqueur.actif = true; delete process.env.T3_ATTACHMENT_REVIEW_ENABLED; });

  const revue = (o: Record<string, unknown>, extra: Record<string, unknown> = {}): RecordedOutput => ({
    operationCode: 't3_link_ambiguity', task: 'LINK_AMBIGUITY', repeat: true,
    output: { task: 'LINK_AMBIGUITY', matches: [], documentScope: 'SINGLE', attachmentReview: o, ...extra },
  });
  const analyser = async (compte: Compte, fileId: number, out: Record<string, unknown>, recordings: RecordedOutput[] = [], origin = 'e2e/l113l') => {
    await sql`UPDATE asset_files SET s3_bucket = 'e2e-bucket', original_filename = coalesce(original_filename, ${`doc-${fileId}.pdf`}),
                analysis_state = NULL WHERE id = ${fileId}`;
    const replay = await rejouer([{ operationCode: 't1_analyze_document', task: 'ANALYZE_DOCUMENT', output: out }, ...recordings]);
    const { analyzeFileSources } = await import('@/services/ai/source-analysis/entrypoint');
    const r = await analyzeFileSources([fileId], compte.id, { userId: compte.ownerUserId, billable: false, origin });
    if (!r || r.results.length === 0) throw new Error(`[e2e] analyse du fichier ${fileId} en échec`);
    await drainQueues();
    return { replay, warnings: r.results[0].warnings.map((w) => w.code) };
  };
  const assurance = (velo: { id: number }, texte: string[]) => sortieT1({
    title: 'Attestation d’assurance', date: '2026-01-15', documentTypeCode: 'INSURANCE_CERTIFICATE', rubricCode: 'INSURANCE',
    supplier: 'Assureur Démo', assets: [{ id: velo.id, label: 'VELO CARGO' }], facts: [], texte, multiAsset: false,
  });
  const TEXTE_VELO = ['M. Jean Fourche', '12 rue des Lilas 69003 Lyon', 'Assurance : VELO',
    'Votre attestation d’assurance pour votre VELO CARGO', 'Marque du véhicule : VELO CARGO'];
  const cartes = async (fileId: number) => (await sql<{ id: number; active: boolean; reason: string | null; question: string; proposals: unknown; ctx: Record<string, unknown> }[]>`
    SELECT id, resolved_at IS NULL AS active, resolution_reason AS reason, question, proposals_json AS proposals, trigger_context AS ctx
      FROM to_process_actions WHERE target_type = 'DOCUMENT' AND target_id = ${fileId} AND rule_code = 'LINK-ASSET-CONFLICT' ORDER BY id`)
    .map((c) => ({ ...c, proposals: ((typeof c.proposals === 'string' ? JSON.parse(c.proposals) : c.proposals) ?? []) as Array<Record<string, unknown>> }));
  const actives = async (fileId: number) => (await cartes(fileId)).filter((c) => c.active);
  const trace = async (fileId: number) => (await sql<{ r: Record<string, unknown> | null }[]>`
    SELECT attachment_review AS r FROM document_asset_resolutions WHERE file_id = ${fileId}`)[0]?.r as Record<string, any> | null;
  const principal = async (fileId: number) => (await sql<{ a: number | null }[]>`SELECT asset_id AS a FROM asset_files WHERE id = ${fileId}`)[0].a;
  const appels = (replay: { calls: Array<{ operationCode?: string; prompt?: string }> }, op = 't3_link_ambiguity') => replay.calls.filter((c) => c.operationCode === op);
  const compteVeloMaison = async () => {
    const compte = await make.account();
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison', keyCharacteristics: ADRESSE_MAISON });
    const velo = await make.asset(compte, { category: 'VEHICULE', name: 'Vélo Jean Fourche' });
    return { compte, maison, velo };
  };

  it('R1 — assurance vélo + adresse personnelle de la maison : aucune carte, vélo conservé, indices et unités tracés, adresse jamais transmise', async () => {
    const { compte, maison, velo } = await compteVeloMaison();
    const doc = await make.assetFile(compte, { assetId: velo.id });
    const { replay, warnings } = await analyser(compte, doc.id, assurance(velo, TEXTE_VELO), [revue({
      decision: 'KEEP_CURRENT', concernedAssetIds: [velo.id], citedIndexIds: [1],
      indexRoles: [{ indexId: 1, role: 'adresse du destinataire' }], reason: 'Le document assure le vélo cargo ; l’adresse est celle du destinataire.',
    })]);
    expect(warnings).toContain('ASSET_ATTACHMENT_INDICES');
    expect(warnings).not.toContain('ASSET_TARGET_CONTRADICTION');
    expect(await actives(doc.id)).toEqual([]);
    expect(await principal(doc.id)).toBe(velo.id);
    const t = (await trace(doc.id))!;
    expect(t).toMatchObject({ status: 'REVIEWED', contract: true, aiCalled: true, aiStatus: 'OK', decision: { kind: 'CONFIRMED', source: 'AI' } });
    expect(t.indices).toEqual(expect.arrayContaining([expect.objectContaining({ assetId: maison.id, kind: 'ADDRESS', currentAsset: false })]));
    expect(t.unitsSent.some((u: { withText: boolean; indexIds: number[] }) => u.withText && u.indexIds.length > 0)).toBe(true);
    expect(t.promptVersion).toBeTruthy();
    expect(t.traceIds.length).toBe(1);
    const [call] = appels(replay);
    expect(call.prompt).toContain('t3-document-attachment-review-v1');
    expect(call.prompt).toContain(`adresse identique à celle du bien candidat ${maison.id}`);
    expect(call.prompt).toContain('M. Jean Fourche');
    expect(call.prompt).not.toMatch(/12 rue des Lilas/i);
    expect(JSON.stringify(t)).not.toMatch(/rue des Lilas/i);
  });

  it('R2 — réanalyses tco-amount-recovery et ordinaire sans élément nouveau : décision réutilisée, aucun appel, aucune carte ; élément nouveau → nouvel appel', async () => {
    const { compte, velo } = await compteVeloMaison();
    const doc = await make.assetFile(compte, { assetId: velo.id });
    const ok = revue({ decision: 'KEEP_CURRENT', concernedAssetIds: [velo.id], citedIndexIds: [1], reason: 'Adresse du destinataire.' });
    await analyser(compte, doc.id, assurance(velo, TEXTE_VELO), [ok]);
    const tco = await analyser(compte, doc.id, assurance(velo, TEXTE_VELO), [ok], 'tco-amount-recovery');
    expect(appels(tco.replay)).toHaveLength(0);
    expect((await trace(doc.id))).toMatchObject({ status: 'REUSED', aiReused: true, decision: { kind: 'CONFIRMED' } });
    expect(await cartes(doc.id)).toEqual([]);
    const ordinaire = await analyser(compte, doc.id, assurance(velo, TEXTE_VELO), [ok]);
    expect(appels(ordinaire.replay)).toHaveLength(0);
    expect(await cartes(doc.id)).toEqual([]);
    // Élément nouveau pertinent (l'adresse apparaît désormais dans un autre contexte) : nouvelle revue.
    const nouveau = await analyser(compte, doc.id, assurance(velo, [...TEXTE_VELO.slice(0, 2), 'Bien assuré : 12 rue des Lilas 69003 Lyon', ...TEXTE_VELO.slice(2)]), [ok]);
    expect(appels(nouveau.replay)).toHaveLength(1);
    expect(await cartes(doc.id)).toEqual([]);
  });

  it('R3 — facture d’équipement avec adresse de livraison d’un autre bien : décision du modèle sur le contenu, aucune carte', async () => {
    const { compte, velo } = await compteVeloMaison();
    const doc = await make.assetFile(compte, { assetId: velo.id });
    const out = sortieT1({
      title: 'Facture antivol vélo', date: '2026-03-02', documentTypeCode: 'PURCHASE_INVOICE', rubricCode: 'PURCHASE', supplier: 'Cycles Démo',
      assets: [{ id: velo.id, label: 'Vélo cargo' }], facts: [], amountCents: 8900, texte: ['Adresse de livraison : 12 rue des Lilas 69003 Lyon', 'Antivol pour vélo cargo'],
    });
    const { replay } = await analyser(compte, doc.id, out, [revue({ decision: 'KEEP_CURRENT', concernedAssetIds: [velo.id], citedIndexIds: [1], reason: 'Adresse de livraison seulement.' })]);
    expect(appels(replay)).toHaveLength(1);
    expect(await actives(doc.id)).toEqual([]);
    expect(await principal(doc.id)).toBe(velo.id);
  });

  it('R4 — vrai conflit : UNE carte justifiée par les preuves, aucun déplacement ; « Garder » respecté à la réanalyse', async () => {
    const compte = await make.account();
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison', keyCharacteristics: ADRESSE_MAISON });
    const studio = await make.asset(compte, { category: 'IMMOBILIER', name: 'Studio', keyCharacteristics: ADRESSE_STUDIO });
    const doc = await make.assetFile(compte, { assetId: maison.id });
    const out = sortieT1({
      title: 'Avis de taxe foncière', date: '2026-09-01', documentTypeCode: 'PROPERTY_TAX', rubricCode: 'TAXES', supplier: 'Impôts',
      assets: [], facts: [], texte: ['Désignation du bien imposé :', '4 avenue des Tilleuls 69006 Lyon', 'Propriétaire : M. Démo'],
    });
    const arbitrage = revue({
      decision: 'ARBITRATE', concernedAssetIds: [studio.id], citedIndexIds: [1],
      reason: 'Le bien imposé désigné par l’avis est le studio de l’avenue des Tilleuls.',
    }, { matches: [{ candidateId: studio.id, score: 0.92, confidence: 'certain', reason: 'bien imposé' }] });
    await analyser(compte, doc.id, out, [arbitrage]);
    const [c] = await actives(doc.id);
    expect(c.question).toBe('Ce document est rattaché à « Maison » mais l’analyse indique qu’il concerne « Studio ». Quel bien garder ?');
    expect(c.ctx).toMatchObject({ basis: 'AI_REVIEW', currentAssetId: maison.id, suggestedAssetId: studio.id, ambiguous: false });
    expect(c.proposals.find((p) => p.value === `MOVE:${studio.id}`)).toMatchObject({ sourceContext: { label: 'Le bien imposé désigné par l’avis est le studio de l’avenue des Tilleuls.' } });
    expect(c.proposals.find((p) => p.value === 'IGNORE')).toMatchObject({ emphasis: 'neutral' });
    expect(await principal(doc.id)).toBe(maison.id);
    expect(JSON.stringify(c)).not.toMatch(/4 avenue des Tilleuls/i);
    // Réanalyse : même carte, pas de doublon.
    await analyser(compte, doc.id, out, [arbitrage]);
    expect(await actives(doc.id)).toHaveLength(1);
    const pub = (await sql<{ p: string }[]>`SELECT public_id AS p FROM to_process_actions WHERE id = ${c.id}`)[0].p;
    const { resolveArbitration } = await import('@/services/to-process/resolve-action.service');
    expect((await resolveArbitration(compte.id, pub, 'KEEP', { userId: compte.ownerUserId })).ok).toBe(true);
    const apres = await analyser(compte, doc.id, out, [arbitrage]);
    expect(appels(apres.replay)).toHaveLength(0);
    expect(await actives(doc.id)).toEqual([]);
    expect((await trace(doc.id))).toMatchObject({ status: 'USER_DECIDED_PAIR' });
    expect(await principal(doc.id)).toBe(maison.id);
  });

  it('R5 — identifiant cité à titre secondaire, candidat principal reconnu : aucune priorité à la correspondance brute', async () => {
    const compte = await make.account();
    const polo = await make.asset(compte, { category: 'VEHICULE', name: 'Polo', registrationNumber: 'AB-123-CD' });
    const clio = await make.asset(compte, { category: 'VEHICULE', name: 'Clio', registrationNumber: 'EF-456-GH' });
    const doc = await make.assetFile(compte, { assetId: polo.id });
    const out = sortieT1({
      title: 'Facture entretien Polo', date: '2026-05-10', documentTypeCode: 'MAINTENANCE_INVOICE', rubricCode: 'MAINTENANCE_WORKS', supplier: 'Garage Démo',
      assets: [{ id: polo.id, label: 'Polo AB-123-CD' }], facts: [], texte: ['Véhicule : Polo AB-123-CD', 'Véhicule de courtoisie prêté : EF-456-GH'],
    });
    await analyser(compte, doc.id, out, [revue({ decision: 'KEEP_CURRENT', concernedAssetIds: [polo.id], citedIndexIds: [1, 2], reason: 'Le véhicule entretenu est la Polo.' })]);
    expect(await actives(doc.id)).toEqual([]);
    const t = (await trace(doc.id))!;
    expect(t.indices).toEqual(expect.arrayContaining([
      expect.objectContaining({ assetId: clio.id, kind: 'REGISTRATION', currentAsset: false }),
      expect.objectContaining({ assetId: polo.id, kind: 'REGISTRATION', currentAsset: true }),
    ]));
  });

  it('R6 — document multi-biens : aucun choix exclusif, autre bien lié en SECONDARY, bien principal inchangé', async () => {
    const compte = await make.account();
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison', keyCharacteristics: ADRESSE_MAISON });
    const polo = await make.asset(compte, { category: 'VEHICULE', name: 'Polo', registrationNumber: 'AB-123-CD' });
    const doc = await make.assetFile(compte, { assetId: maison.id });
    const out = sortieT1({
      title: 'Attestation multirisque', date: '2026-02-01', documentTypeCode: 'INSURANCE_CERTIFICATE', rubricCode: 'INSURANCE', supplier: 'Assureur Démo',
      assets: [{ id: maison.id, label: 'Maison' }, { id: polo.id, label: 'Polo' }], facts: [], multiAsset: true,
      texte: ['Habitation assurée : 12 rue des Lilas 69003 Lyon', 'Véhicule assuré : Polo AB-123-CD'],
    });
    await analyser(compte, doc.id, out, [revue({ decision: 'MULTIPLE', concernedAssetIds: [maison.id, polo.id], citedIndexIds: [1, 2], reason: 'Le contrat couvre la maison et la Polo.' },
      { documentScope: 'MULTIPLE', matches: [{ candidateId: maison.id, score: 0.95, confidence: 'certain', reason: 'habitation' }, { candidateId: polo.id, score: 0.9, confidence: 'certain', reason: 'véhicule' }] })]);
    expect(await cartes(doc.id)).toEqual([]);
    expect(await principal(doc.id)).toBe(maison.id);
    expect(await trace(doc.id)).toMatchObject({ decision: { kind: 'MULTI_ASSET', assetIds: [polo.id] }, secondaryLinked: [polo.id] });
    const liens = await sql<{ r: string }[]>`SELECT link_role AS r FROM document_asset_links WHERE file_id = ${doc.id} AND status = 'ACTIVE' AND asset_id = ${polo.id}`;
    expect(liens.map((l) => l.r)).toContain('SECONDARY');
  });

  it('R7 — ambiguïté réelle : une seule carte actionnable, choix neutres, accès au document, aucun doublon au passage suivant', async () => {
    const compte = await make.account();
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison', keyCharacteristics: ADRESSE_MAISON });
    const studio = await make.asset(compte, { category: 'IMMOBILIER', name: 'Studio', keyCharacteristics: ADRESSE_STUDIO });
    const doc = await make.assetFile(compte, { assetId: maison.id });
    const out = sortieT1({
      title: 'Devis travaux', date: '2026-04-01', documentTypeCode: 'QUOTE', rubricCode: 'MAINTENANCE_WORKS', supplier: 'Artisan Démo',
      assets: [], facts: [], texte: ['Client : 12 rue des Lilas 69003 Lyon', 'Chantier : 4 avenue des Tilleuls 69006 Lyon ou adresse à confirmer'],
    });
    const amb = revue({ decision: 'ARBITRATE', concernedAssetIds: [maison.id, studio.id], citedIndexIds: [1, 2], reason: 'Le lieu du chantier n’est pas établi.' });
    await analyser(compte, doc.id, out, [amb]);
    const [c] = await actives(doc.id);
    expect(c.question).toBe('Ce document est rattaché à « Maison », mais son contenu pourrait aussi concerner « Studio ». Quel bien garder ?');
    expect(c.proposals.find((p) => String(p.value).startsWith('MOVE:'))).toMatchObject({ emphasis: 'neutral' });
    const { reconcileOpenToProcessActions } = await import('@/services/ai/reconciliation/continuous/open-actions.service');
    const replay = await rejouer([amb]);
    await reconcileOpenToProcessActions(compte.id, { triggerCode: 'schedule_hourly' });
    expect(appels(replay)).toHaveLength(0); // contexte inchangé : décision réutilisée
    expect(await cartes(doc.id)).toHaveLength(1);
    expect(await actives(doc.id)).toHaveLength(1);
  });

  it('R8 — échec IA et réponse invalide : aucune carte (jamais la règle supprimée), trace et Supervision', async () => {
    const { compte, velo } = await compteVeloMaison();
    const doc = await make.assetFile(compte, { assetId: velo.id });
    await analyser(compte, doc.id, assurance(velo, TEXTE_VELO), [{ operationCode: 't3_link_ambiguity', task: 'LINK_AMBIGUITY', output: null, error: { message: 'fournisseur indisponible', status: 503, recoverable: true }, repeat: true }]);
    expect(await cartes(doc.id)).toEqual([]);
    const { reviewDocumentAttachment } = await import('@/services/ai/reconciliation/document-asset/attachment-review/service');
    await rejouer([{ operationCode: 't3_link_ambiguity', task: 'LINK_AMBIGUITY', output: null, error: { message: 'fournisseur indisponible', status: 503, recoverable: true }, repeat: true }]);
    const r = await reviewDocumentAttachment({ accountId: compte.id, fileId: doc.id, finalAttempt: true, triggerCode: 'e2e' });
    expect(r).toMatchObject({ status: 'TECHNICAL_FAILURE', trace: { aiStatus: 'ERROR', decision: { kind: 'NO_DECISION', reasonCode: 'TECHNICAL_FAILURE' }, card: { effect: 'NONE' } } });
    expect(await cartes(doc.id)).toEqual([]);
    const anomalies = await sql`SELECT 1 FROM admin_anomalies WHERE account_id = ${compte.id} AND fingerprint LIKE ${'ai:t3-attachment-review:%'}`;
    expect(anomalies.length).toBeGreaterThan(0);
    // Réponse sans la section obligatoire (bloc 22 actif) : réponse invalide, aucune carte.
    const doc2 = await make.assetFile(compte, { assetId: velo.id });
    await analyser(compte, doc2.id, assurance(velo, TEXTE_VELO), [{ operationCode: 't3_link_ambiguity', task: 'LINK_AMBIGUITY', repeat: true,
      output: { task: 'LINK_AMBIGUITY', matches: [{ candidateId: velo.id + 0, score: 0.9, confidence: 'certain', reason: 'x' }] } }]);
    expect(await cartes(doc2.id)).toEqual([]);
    expect(await trace(doc2.id)).toMatchObject({ decision: { kind: 'NO_DECISION', reasonCode: 'REVIEW_OUTPUT_MISSING' } });
  });

  it('R9 — anciennes cartes IDENTIFIER (cas 120 / 125 / 127) : réévaluées, faux conflits fermés, vrai conflit maintenu, « Ignorer » respecté, idempotent', async () => {
    const { compte, maison, velo } = await compteVeloMaison();
    const studio = await make.asset(compte, { category: 'IMMOBILIER', name: 'Studio', keyCharacteristics: ADRESSE_STUDIO });
    // Documents analysés AVANT le lot 113L (revue coupée), cartes posées par l'ancienne règle.
    process.env.T3_ATTACHMENT_REVIEW_ENABLED = '0';
    const docs = [];
    for (const titre of ['Attestation d’assurance', 'Fiche Information et Conseil', 'Calendrier de prélèvement']) {
      const d = await make.assetFile(compte, { assetId: velo.id });
      await analyser(compte, d.id, sortieT1({ title: titre, date: '2026-01-15', documentTypeCode: 'INSURANCE_CERTIFICATE', rubricCode: 'INSURANCE',
        supplier: 'Assureur Démo', assets: [{ id: velo.id, label: 'VELO CARGO' }], facts: [], texte: TEXTE_VELO }));
      docs.push(d.id);
    }
    const vrai = await make.assetFile(compte, { assetId: maison.id });
    await analyser(compte, vrai.id, sortieT1({ title: 'Avis de taxe foncière', date: '2026-09-01', documentTypeCode: 'PROPERTY_TAX', rubricCode: 'TAXES',
      supplier: 'Impôts', assets: [], facts: [], texte: ['Désignation du bien imposé :', '4 avenue des Tilleuls 69006 Lyon'] }));
    const ignore = await make.assetFile(compte, { assetId: velo.id });
    await analyser(compte, ignore.id, assurance(velo, TEXTE_VELO));
    delete process.env.T3_ATTACHMENT_REVIEW_ENABLED;
    const { proposeDocumentAssetConflict } = await import('@/services/to-process/document-asset-conflict');
    for (const d of [...docs, ignore.id]) {
      expect(await proposeDocumentAssetConflict({ accountId: compte.id, fileId: d, currentAssetId: velo.id, suggestedAssetId: maison.id, basis: 'IDENTIFIER', kinds: ['ADDRESS'] })).toMatchObject({ status: 'CREATED' });
    }
    expect(await proposeDocumentAssetConflict({ accountId: compte.id, fileId: vrai.id, currentAssetId: maison.id, suggestedAssetId: studio.id, basis: 'IDENTIFIER', kinds: ['ADDRESS'] })).toMatchObject({ status: 'CREATED' });
    const [ci] = await actives(ignore.id);
    const pub = (await sql<{ p: string }[]>`SELECT public_id AS p FROM to_process_actions WHERE id = ${ci.id}`)[0].p;
    const { resolveArbitration } = await import('@/services/to-process/resolve-action.service');
    expect((await resolveArbitration(compte.id, pub, 'IGNORE', { userId: compte.ownerUserId })).ok).toBe(true);

    // Le modèle simulé : faux conflit pour les documents du vélo, vrai conflit pour l'avis de taxe.
    const { setDefaultResponder } = await import('../replay-gateway');
    setDefaultResponder('t3_link_ambiguity', 'LINK_AMBIGUITY', (input) => (input.prompt.includes('taxe foncière')
      ? { task: 'LINK_AMBIGUITY', matches: [{ candidateId: studio.id, score: 0.92, confidence: 'certain', reason: 'bien imposé' }], attachmentReview: { decision: 'ARBITRATE', concernedAssetIds: [studio.id], citedIndexIds: [1], reason: 'Le bien imposé est le studio.' } }
      : { task: 'LINK_AMBIGUITY', matches: [], attachmentReview: { decision: 'KEEP_CURRENT', concernedAssetIds: [velo.id], citedIndexIds: [1], reason: 'Adresse du destinataire ; objet assuré : le vélo.' } }));
    try {
      const replay = await rejouer([]);
      const { reconcileOpenToProcessActions } = await import('@/services/ai/reconciliation/continuous/open-actions.service');
      const r1 = await reconcileOpenToProcessActions(compte.id, { triggerCode: 'schedule_hourly' });
      expect(appels(replay)).toHaveLength(4);
      for (const d of docs) {
        expect((await cartes(d))[0]).toMatchObject({ active: false, reason: 'OBSOLETE' });
        expect(await principal(d)).toBe(velo.id);
        const ev = await sql<{ d: Record<string, unknown> }[]>`SELECT details AS d FROM to_process_action_events e JOIN to_process_actions a ON a.id = e.action_id
           WHERE a.target_id = ${d} AND a.rule_code = 'LINK-ASSET-CONFLICT' AND e.event = 'OBSOLETE'`;
        expect(ev[0].d).toMatchObject({ reason: 'ATTACHMENT_REVIEW', review: 'CONFIRMED' });
      }
      expect(r1.byResolver.T3_ASSET_CONFLICT).toBe(4);
      const [v] = await actives(vrai.id);
      expect(v.ctx).toMatchObject({ basis: 'AI_REVIEW', suggestedAssetId: studio.id });
      expect(await principal(vrai.id)).toBe(maison.id);
      // « Ignorer » respecté : la carte reste close, aucune nouvelle carte, aucun appel.
      expect((await cartes(ignore.id)).map((c) => [c.active, c.reason])).toEqual([[false, 'NOT_APPLICABLE']]);
      // Second passage : idempotent — aucun appel, rien de rouvert ni de dupliqué.
      const replay2 = await rejouer([]);
      await reconcileOpenToProcessActions(compte.id, { triggerCode: 'schedule_hourly' });
      expect(appels(replay2)).toHaveLength(0);
      for (const d of docs) expect(await actives(d)).toEqual([]);
      // Carte historique ACTUALISÉE en place (une seule carte active par document), jamais dupliquée.
      expect(await cartes(vrai.id)).toHaveLength(1);
      expect(await actives(vrai.id)).toHaveLength(1);
    } finally {
      const { setDefaultResponder: reset, t3SemanticNoMatchResponder } = await import('../replay-gateway');
      reset('t3_link_ambiguity', 'LINK_AMBIGUITY', t3SemanticNoMatchResponder);
    }
  });

  it('R10 — prompt actif SANS le bloc 22 : décision lue dans matches (bien actuel certain → confirmé ; autre bien certain → arbitrage)', async () => {
    marqueur.actif = false;
    const { compte, velo } = await compteVeloMaison();
    const doc = await make.assetFile(compte, { assetId: velo.id });
    await analyser(compte, doc.id, assurance(velo, TEXTE_VELO), [{ operationCode: 't3_link_ambiguity', task: 'LINK_AMBIGUITY', repeat: true,
      output: { task: 'LINK_AMBIGUITY', matches: [{ candidateId: velo.id, score: 0.95, confidence: 'certain', reason: 'objet assuré' }], documentScope: 'SINGLE' } }]);
    expect(await cartes(doc.id)).toEqual([]);
    expect(await trace(doc.id)).toMatchObject({ contract: false, decision: { kind: 'CONFIRMED' } });
  });
});
