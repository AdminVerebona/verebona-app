/**
 * Lot 31B — rattachement Document → Bien sur base réelle.
 *
 *   · ticket T1 : identifiants canoniques (ENTITY_CONTEXT enrichi, adresse
 *     jamais transmise), correspondance déterministe serveur, lien PRIMARY AI
 *     même en mono-bien, priorité au choix utilisateur — T1-LINK-01 à 08 ;
 *   · ticket T3 : reprise immédiate par T3 DOCUMENT_ASSET quand T1 n'a pas de
 *     bien certain, déterministe avant IA, IA sur candidats et faits persistés,
 *     abstention → UNE action « À traiter », multi-biens, utilisateur
 *     prioritaire, idempotence, rattrapage planifié — T3DOC-01 à 14.
 *
 * Chaîne de production : `analyzeFileSources` (T1 master, sortie rejouée) →
 * abonné `source_analyzed` → file durable T3 (cible `document`) vidée par
 * l'exécutant de production (`runOne`, aiguillage `registerReconciliationHandlers`).
 */
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { drainQueues, sortieT1, useTargetState } from '../chain';
import type { RecordedOutput } from '../replay-gateway';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Compte = { id: number; ownerUserId: number };

scenario('L31B', 'Rattachement document → bien : identifiants canoniques (T1) et T3 DOCUMENT_ASSET', ({ sql, make, useRecordings: rejouer }) => {
  useTargetState();

  const T3_ABSTENTION: RecordedOutput = {
    operationCode: 't3_link_ambiguity', task: 'LINK_AMBIGUITY', output: { task: 'LINK_AMBIGUITY', matches: [] }, repeat: true,
  };
  const t3Sortie = (matches: Array<{ candidateId: number; score: number; confidence: string; reason?: string }>, documentScope = 'SINGLE'): RecordedOutput => ({
    operationCode: 't3_link_ambiguity', task: 'LINK_AMBIGUITY',
    output: { task: 'LINK_AMBIGUITY', documentScope, matches: matches.map((m) => ({ reason: 'signal fourni', ...m })) },
  });

  /** Analyse par le point d'entrée de production ; files vidées sauf `drain: false`. */
  const analyser = async (
    compte: Compte, fileId: number, output: Record<string, unknown>,
    opts: { extra?: RecordedOutput[]; drain?: boolean } = {},
  ) => {
    await sql`UPDATE asset_files SET s3_bucket = 'e2e-bucket', original_filename = coalesce(original_filename, ${`doc-${fileId}.pdf`}),
                analysis_state = NULL WHERE id = ${fileId}`;
    const replay = await rejouer([{ operationCode: 't1_analyze_document', task: 'ANALYZE_DOCUMENT', output }, ...(opts.extra ?? [])]);
    const { analyzeFileSources } = await import('@/services/ai/source-analysis/entrypoint');
    const r = await analyzeFileSources([fileId], compte.id, { userId: compte.ownerUserId, billable: false, origin: 'e2e/l31b' });
    if (!r || r.results.length === 0) throw new Error(`[e2e] analyse du fichier ${fileId} en échec`);
    if (opts.drain !== false) await drainQueues();
    return { r, replay, warnings: r.results[0].warnings.map((w) => w.code) };
  };

  const sortie = (p: { assets?: Array<{ id: number; label: string; confidence?: 'certain' | 'probable'; score?: number }>; texte?: string[]; multiAsset?: boolean; facts?: Parameters<typeof sortieT1>[0]['facts'] }) => {
    const out = sortieT1({
      title: 'Facture d’entretien', date: '2026-09-14', documentTypeCode: 'MAINTENANCE_INVOICE', rubricCode: 'MAINTENANCE_WORKS',
      assets: (p.assets ?? []).map((a) => ({ id: a.id, label: a.label })), facts: p.facts ?? [], texte: p.texte, multiAsset: p.multiAsset ?? false,
    });
    const ents = (out.entities as { assets: Array<Record<string, unknown>> }).assets;
    (p.assets ?? []).forEach((a, i) => { ents[i].confidence = a.confidence ?? 'certain'; ents[i].score = a.score ?? 0.97; });
    return out;
  };

  const liens = async (fileId: number) => (await sql<{ asset_id: number; link_role: string; origin: string; confidence: string | null }[]>`
    SELECT asset_id, link_role, origin, confidence FROM document_asset_links
     WHERE file_id = ${fileId} AND status = 'ACTIVE' ORDER BY asset_id, id`)
    .map((l) => [Number(l.asset_id), l.link_role, l.origin, l.confidence === null ? null : Number(l.confidence)]);
  const fichier = async (fileId: number) => (await sql<{ asset_id: number | null; analysis_state: string | null; ue: Record<string, unknown> | null }[]>`
    SELECT asset_id, analysis_state, user_edited_fields AS ue FROM asset_files WHERE id = ${fileId}`)[0];
  const jobsDoc = async (fileId: number) => sql<{ id: number; status: string; trigger_code: string | null }[]>`
    SELECT id, status, trigger_code FROM ai_job_queue WHERE treatment = 'T3' AND target_type = 'document' AND target_id = ${String(fileId)} ORDER BY id`;
  const resolution = async (fileId: number) => (await sql<{ status: string; method: string | null; reason_code: string | null; candidates: unknown; runs: number }[]>`
    SELECT status, method, reason_code, candidates, runs FROM document_asset_resolutions WHERE file_id = ${fileId}`)[0];
  const actionsLink = async (fileId: number) => (await sql<{ id: number; action_kind: string; active: boolean; proposals: unknown; question: string | null }[]>`
    SELECT id, action_kind, resolved_at IS NULL AS active, proposals_json AS proposals, question FROM to_process_actions
     WHERE target_type = 'DOCUMENT' AND target_id = ${fileId} AND rule_code = 'LINK-ASSET' ORDER BY id`)
    .map((a) => ({ ...a, proposals: ((typeof a.proposals === 'string' ? JSON.parse(a.proposals) : a.proposals) ?? []) as Array<{ value: unknown; label: string }> }));
  const evenementDocumentLinked = async (accountId: number, fileId: number) => (await sql`
    SELECT 1 FROM ai_job_queue WHERE treatment = 'T3' AND account_id = ${accountId} AND target_type IS NULL
       AND payload -> 'events' @> ${JSON.stringify([{ event: 'document_linked', objectType: 'document', objectId: fileId }])}::jsonb`).length > 0;
  const appelsT3 = (replay: { calls: Array<{ operationCode?: string }> }) => replay.calls.filter((c) => c.operationCode === 't3_link_ambiguity').length;

  const maisonLyon = (compte: Compte, name = 'Maison') => make.asset(compte, {
    category: 'IMMOBILIER', name, keyCharacteristics: { address1: '12 rue Exemple', postalCode: '69003', city: 'Lyon' },
  });
  const studioLyon = (compte: Compte) => make.asset(compte, {
    category: 'IMMOBILIER', name: 'Studio', keyCharacteristics: { address1: '8 avenue Foch', postalCode: '69006', city: 'Lyon' },
  });

  // ══ Ticket T1 ═══════════════════════════════════════════════════════════

  it('T1-LINK-01 — adresse exacte : documentAssetId résolu par le serveur, PRIMARY AI vers la maison ; adresse jamais transmise au modèle', async () => {
    const compte = await make.account();
    const maison = await maisonLyon(compte);
    await studioLyon(compte);
    const doc = await make.assetFile(compte, { assetId: null });
    const { replay, warnings } = await analyser(compte, doc.id, sortie({ texte: ['Adresse d’intervention : 12 rue Exemple, 69003 Lyon'] }));

    expect(await liens(doc.id)).toEqual([[maison.id, 'PRIMARY', 'AI', 1]]);
    const f = await fichier(doc.id);
    // Rattachement VISIBLE (colonne lue par les listes), marqué automatique.
    expect(f).toMatchObject({ asset_id: maison.id, analysis_state: 'ANALYZED' });
    expect(f.ue).toMatchObject({ assetIdAuto: maison.id });
    expect(warnings).not.toContain('AMBIGUOUS_ASSET');
    expect(await jobsDoc(doc.id)).toEqual([]);
    expect(await actionsLink(doc.id)).toEqual([]);
    // ENTITY_CONTEXT : code postal / ville transmis, adresse (sensible) jamais.
    const prompt = replay.calls.find((c) => c.operationCode === 't1_analyze_document')!.prompt;
    expect(prompt).toContain('"postalCode":"69003"');
    expect(prompt).not.toContain('12 rue Exemple');
    expect(prompt).not.toContain('8 avenue Foch');
  });

  it('T1-LINK-02 — adresse normalisée (casse, accents) : rattachement automatique', async () => {
    const compte = await make.account();
    const rep = await make.asset(compte, { category: 'IMMOBILIER', name: 'Appartement', keyCharacteristics: { address1: '12 Rue de la République' } });
    await studioLyon(compte);
    const doc = await make.assetFile(compte, { assetId: null });
    await analyser(compte, doc.id, sortie({ texte: ['Logement : 12 rue de la republique'] }));
    expect(await liens(doc.id)).toEqual([[rep.id, 'PRIMARY', 'AI', 1]]);
    expect((await fichier(doc.id)).asset_id).toBe(rep.id);
  });

  it('T1-LINK-03 — immatriculation exacte (AB-123-CD / AB123CD) : rattachement à la Polo', async () => {
    const compte = await make.account();
    const polo = await make.asset(compte, { category: 'VEHICULE', name: 'Polo', registrationNumber: 'AB-123-CD' });
    await make.asset(compte, { category: 'VEHICULE', name: 'Clio', registrationNumber: 'XY-987-ZT' });
    const doc = await make.assetFile(compte, { assetId: null });
    const { replay } = await analyser(compte, doc.id, sortie({ texte: ['Véhicule immatriculé AB123CD'] }));
    expect(await liens(doc.id)).toEqual([[polo.id, 'PRIMARY', 'AI', 1]]);
    // L'immatriculation (non sensible) est un identifiant transmis à T1.
    expect(replay.calls[0].prompt).toContain('"registrationNumber":"AB-123-CD"');
  });

  it('T1-LINK-04 / T3DOC-01 — candidat unique certain de T1 : PRIMARY AI conservé en mono-bien ; aucun travail DOCUMENT_ASSET', async () => {
    const compte = await make.account();
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const doc = await make.assetFile(compte, { assetId: null });
    await analyser(compte, doc.id, sortie({ assets: [{ id: maison.id, label: 'Maison', confidence: 'certain', score: 0.97 }] }));
    expect(await liens(doc.id)).toEqual([[maison.id, 'PRIMARY', 'AI', 1]]);
    expect(await jobsDoc(doc.id)).toEqual([]);
    expect(await resolution(doc.id)).toBeUndefined();
  });

  it('T1-LINK-05 / T3DOC-02 / T3DOC-14 — deux biens compatibles : aucun rattachement arbitraire, AMBIGUOUS_ASSET, T3 DOCUMENT_ASSET en file IMMÉDIATEMENT, pas de « À traiter » avant T3', async () => {
    const compte = await make.account();
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const studio = await make.asset(compte, { category: 'IMMOBILIER', name: 'Studio' });
    const doc = await make.assetFile(compte, { assetId: null });
    const { warnings } = await analyser(compte, doc.id, sortie({
      assets: [{ id: maison.id, label: 'Maison', confidence: 'probable', score: 0.6 }, { id: studio.id, label: 'Studio', confidence: 'probable', score: 0.6 }],
    }), { drain: false, extra: [T3_ABSTENTION] });

    expect(warnings).toContain('AMBIGUOUS_ASSET');
    expect((await liens(doc.id)).map((l) => l[1])).toEqual(['MENTIONED', 'MENTIONED']);
    expect((await fichier(doc.id))).toMatchObject({ asset_id: null, analysis_state: 'ANALYZED' });
    expect(await jobsDoc(doc.id)).toEqual([expect.objectContaining({ status: 'PENDING', trigger_code: 'source_analyzed' })]);
    expect(await resolution(doc.id)).toMatchObject({ status: 'PENDING' });
    // Ni l'analyse, ni le pont « À traiter » (correction, balayage) ne posent la question avant T3.
    expect(await actionsLink(doc.id)).toEqual([]);
    const { syncDocumentRulesFromState } = await import('@/services/to-process/document-rule-bridge');
    await syncDocumentRulesFromState(compte.id, doc.id, { create: true });
    expect(await actionsLink(doc.id)).toEqual([]);

    // T3 s'abstient → UNE question, avec les candidats ; document « à valider ».
    await drainQueues();
    const [a] = await actionsLink(doc.id);
    expect(a).toMatchObject({ action_kind: 'ARBITRATE', active: true, question: 'À quel bien rattacher ce document ?' });
    expect(a.proposals.map((p) => Number(p.value)).sort()).toEqual([maison.id, studio.id].sort());
    expect((await fichier(doc.id)).analysis_state).toBe('VALIDATION_REQUIRED');
    expect(await resolution(doc.id)).toMatchObject({ status: 'ABSTAINED', reason_code: 'INSUFFICIENT_EVIDENCE' });
  });

  it('T1-LINK-06 — rattachement utilisateur (#42) et identifiant d’un autre bien (#43) dans le document : #42 conservé, contradiction remontée', async () => {
    const compte = await make.account();
    const a42 = await make.asset(compte, { category: 'VEHICULE', name: 'Polo', registrationNumber: 'AB-123-CD' });
    const a43 = await make.asset(compte, { category: 'VEHICULE', name: 'Clio', registrationNumber: 'XY-987-ZT' });
    const doc = await make.assetFile(compte, { assetId: a42.id }); // choix au dépôt = choix utilisateur
    const { warnings } = await analyser(compte, doc.id, sortie({ texte: ['Véhicule XY-987-ZT'] }));

    expect((await fichier(doc.id)).asset_id).toBe(a42.id);
    expect(warnings).toContain('ASSET_TARGET_CONTRADICTION');
    const l = await liens(doc.id);
    expect(l.filter((x) => x[1] === 'PRIMARY')).toEqual([[a42.id, 'PRIMARY', 'LEGACY_COLUMN', 1]]);
    expect(l).toContainEqual([a43.id, 'MENTIONED', 'AI', 1]);
    expect(await jobsDoc(doc.id)).toEqual([]);

    // Même règle pour un lien N-N USER (sans colonne).
    const doc2 = await make.assetFile(compte, { assetId: null });
    const { linkDocumentToAsset } = await import('@/services/documents/document-asset-links');
    await linkDocumentToAsset({ accountId: compte.id, fileId: doc2.id, target: { assetId: a42.id }, role: 'PRIMARY', origin: 'USER' });
    const r2 = await analyser(compte, doc2.id, sortie({ texte: ['Véhicule XY-987-ZT'] }));
    expect(r2.warnings).toContain('ASSET_TARGET_CONTRADICTION');
    expect((await liens(doc2.id)).filter((x) => x[1] === 'PRIMARY')).toEqual([[a42.id, 'PRIMARY', 'USER', null]]);
    expect((await fichier(doc2.id)).asset_id).toBeNull();
  });

  it('T1-LINK-07 — réanalyse qui confirme #42 : aucun doublon, lien conservé', async () => {
    const compte = await make.account();
    const maison = await maisonLyon(compte);
    const doc = await make.assetFile(compte, { assetId: null });
    const out = sortie({ texte: ['12 rue Exemple 69003 Lyon'] });
    await analyser(compte, doc.id, out);
    await analyser(compte, doc.id, out);
    expect(await liens(doc.id)).toEqual([[maison.id, 'PRIMARY', 'AI', 1]]);
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM document_asset_links WHERE file_id = ${doc.id}`;
    expect(n).toBe(1);
    expect((await fichier(doc.id)).asset_id).toBe(maison.id);
  });

  it('T1-LINK-08 — ancien rattachement AUTOMATIQUE vers #42, nouvelle analyse certaine #43 : ancien lien AI retiré, nouveau lien AI ; jamais contre un lien USER', async () => {
    const compte = await make.account();
    const a42 = await make.asset(compte, { category: 'VEHICULE', name: 'Polo', registrationNumber: 'AB-123-CD' });
    const a43 = await make.asset(compte, { category: 'VEHICULE', name: 'Clio', registrationNumber: 'XY-987-ZT' });
    const doc = await make.assetFile(compte, { assetId: null });
    await analyser(compte, doc.id, sortie({ texte: ['Véhicule AB-123-CD'] }));
    expect(await liens(doc.id)).toEqual([[a42.id, 'PRIMARY', 'AI', 1]]);

    await analyser(compte, doc.id, sortie({ texte: ['Véhicule XY-987-ZT'] }));
    expect(await liens(doc.id)).toEqual([[a43.id, 'PRIMARY', 'AI', 1]]);
    expect((await fichier(doc.id)).asset_id).toBe(a43.id);
    const [{ retires }] = await sql<{ retires: number }[]>`
      SELECT count(*)::int AS retires FROM document_asset_links WHERE file_id = ${doc.id} AND asset_id = ${a42.id} AND status = 'REMOVED'`;
    expect(retires).toBe(1);

    // L'utilisateur choisit #43 (tiroir : colonne + marque utilisateur) ; une analyse #42 ne le déplace pas.
    await sql`UPDATE asset_files SET user_edited_fields = COALESCE(user_edited_fields, '{}'::jsonb) || '{"assetId": true}'::jsonb WHERE id = ${doc.id}`;
    const r = await analyser(compte, doc.id, sortie({ texte: ['Véhicule AB-123-CD'] }));
    expect((await fichier(doc.id)).asset_id).toBe(a43.id);
    expect(r.warnings).toContain('ASSET_TARGET_CONTRADICTION');
  });

  // ══ Ticket T3 DOCUMENT_ASSET ════════════════════════════════════════════

  it('T3DOC-03 — un seul candidat PROBABLE : pas de rattachement forcé par T1, passage T3 ; preuves insuffisantes → « À traiter »', async () => {
    const compte = await make.account();
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const doc = await make.assetFile(compte, { assetId: null });
    const { replay } = await analyser(compte, doc.id, sortie({ assets: [{ id: maison.id, label: 'Maison', confidence: 'probable', score: 0.6 }] }), {
      extra: [T3_ABSTENTION],
    });
    expect((await liens(doc.id)).filter((l) => l[1] === 'PRIMARY')).toEqual([]);
    expect(appelsT3(replay)).toBe(1);
    // T3 ne relit pas le fichier : aucune pièce jointe dans l'appel T3.
    const appel = replay.calls.find((c) => c.operationCode === 't3_link_ambiguity')!;
    expect(appel.attachments).toEqual([]);
    expect(appel.prompt).toMatch(/DOCUMENT_ASSET/);
    const [a] = await actionsLink(doc.id);
    expect(a).toMatchObject({ action_kind: 'ARBITRATE', active: true });
    expect(a.proposals.map((p) => Number(p.value))).toEqual([maison.id]);
  });

  it('T3DOC-04 — résolution déterministe dans T3 : rattachement SANS appel modèle (identifiant saisi après l’analyse)', async () => {
    const compte = await make.account();
    const polo = await make.asset(compte, { category: 'VEHICULE', name: 'Polo' });
    const clio = await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    const doc = await make.assetFile(compte, { assetId: null });
    const { replay } = await analyser(compte, doc.id, sortie({
      assets: [{ id: polo.id, label: 'Polo', confidence: 'probable', score: 0.6 }, { id: clio.id, label: 'Clio', confidence: 'probable', score: 0.6 }],
      texte: ['Carte grise AB-123-CD'],
    }), { drain: false });
    // L'immatriculation est saisie dans la fiche après l'analyse T1.
    await sql`UPDATE assets SET registration_number = 'AB-123-CD' WHERE id = ${polo.id}`;
    await drainQueues();
    expect(appelsT3(replay)).toBe(0);
    expect(await liens(doc.id)).toContainEqual([polo.id, 'PRIMARY', 'AI', 1]);
    expect(await resolution(doc.id)).toMatchObject({ status: 'RESOLVED', method: 'DETERMINISTIC' });
    expect(await actionsLink(doc.id)).toEqual([]);
  });

  it('T3DOC-05 — T3 trouve un vainqueur clair : PRIMARY par le service canonique, document_linked émis, VALIDATION_REQUIRED levé', async () => {
    const compte = await make.account();
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const studio = await make.asset(compte, { category: 'IMMOBILIER', name: 'Studio' });
    const doc = await make.assetFile(compte, { assetId: null });
    await analyser(compte, doc.id, sortie({
      assets: [{ id: maison.id, label: 'Maison', confidence: 'probable', score: 0.7 }, { id: studio.id, label: 'Studio', confidence: 'probable', score: 0.5 }],
    }), { extra: [t3Sortie([{ candidateId: maison.id, score: 0.93, confidence: 'certain' }, { candidateId: studio.id, score: 0.2, confidence: 'conflictual' }])] });

    const l = await liens(doc.id);
    expect(l.filter((x) => x[1] === 'PRIMARY')).toEqual([[maison.id, 'PRIMARY', 'AI', 0.93]]);
    expect(l).toContainEqual([studio.id, 'MENTIONED', 'AI', 0.5]);
    expect(await fichier(doc.id)).toMatchObject({ asset_id: maison.id, analysis_state: 'ANALYZED' });
    expect(await resolution(doc.id)).toMatchObject({ status: 'RESOLVED', method: 'AI' });
    expect(await evenementDocumentLinked(compte.id, doc.id)).toBe(true);
    expect(await actionsLink(doc.id)).toEqual([]);
  });

  it('T3DOC-06 / T3DOC-10 — T3 ne peut départager : aucune association, UNE seule action ; relance du même travail : aucun doublon, aucun nouvel appel', async () => {
    const compte = await make.account();
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const studio = await make.asset(compte, { category: 'IMMOBILIER', name: 'Studio' });
    const doc = await make.assetFile(compte, { assetId: null });
    const { replay } = await analyser(compte, doc.id, sortie({
      assets: [{ id: maison.id, label: 'Maison', confidence: 'probable', score: 0.6 }, { id: studio.id, label: 'Studio', confidence: 'probable', score: 0.6 }],
    }), { extra: [t3Sortie([{ candidateId: maison.id, score: 0.86, confidence: 'certain' }, { candidateId: studio.id, score: 0.84, confidence: 'certain' }])] });
    expect((await liens(doc.id)).filter((l) => l[1] !== 'MENTIONED')).toEqual([]);
    expect((await actionsLink(doc.id)).filter((a) => a.active)).toHaveLength(1);
    expect(await resolution(doc.id)).toMatchObject({ status: 'ABSTAINED', reason_code: 'AMBIGUOUS' });

    // Relances : le même travail rejoué, puis une demande planifiée.
    const { resolveDocumentAsset } = await import('@/services/ai/reconciliation');
    const r = await resolveDocumentAsset({ accountId: compte.id, fileId: doc.id, userId: compte.ownerUserId });
    expect(r).toMatchObject({ outcome: 'NO_CHANGE', aiCalled: false });
    const { requestDocumentAssetResolution } = await import('@/services/ai/reconciliation');
    await requestDocumentAssetResolution({ accountId: compte.id, userId: compte.ownerUserId, fileId: doc.id, triggerCode: 'schedule_hourly' });
    await drainQueues();
    expect(appelsT3(replay)).toBe(1);
    expect(await actionsLink(doc.id)).toHaveLength(1);
    expect((await liens(doc.id)).filter((l) => l[1] !== 'MENTIONED')).toEqual([]);
  });

  it('T3DOC-07 — aucun candidat : aucune invention, aucun appel modèle, « À traiter » À compléter', async () => {
    const compte = await make.account();
    await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const doc = await make.assetFile(compte, { assetId: null });
    const { replay } = await analyser(compte, doc.id, sortie({}));
    expect(appelsT3(replay)).toBe(0);
    expect(await liens(doc.id)).toEqual([]);
    expect(await actionsLink(doc.id)).toEqual([expect.objectContaining({ action_kind: 'COMPLETE', active: true })]);
    expect(await resolution(doc.id)).toMatchObject({ status: 'NO_CANDIDATE' });
    expect((await fichier(doc.id)).analysis_state).toBe('ANALYZED');
  });

  it('T3DOC-08 — document réellement multi-biens (A ET B) : chaque bien relié, aucun forçage vers un seul, pas de « À traiter »', async () => {
    const compte = await make.account();
    const polo = await make.asset(compte, { category: 'VEHICULE', name: 'Polo', registrationNumber: 'AB-123-CD' });
    const kangoo = await make.asset(compte, { category: 'VEHICULE', name: 'Kangoo', registrationNumber: 'EF-456-GH' });
    const doc = await make.assetFile(compte, { assetId: null });
    const { replay } = await analyser(compte, doc.id, sortie({ multiAsset: true, texte: ['Véhicules assurés : AB-123-CD, EF-456-GH'] }));
    expect(appelsT3(replay)).toBe(0);
    expect(await liens(doc.id)).toEqual([[polo.id, 'SECONDARY', 'AI', 1], [kangoo.id, 'SECONDARY', 'AI', 1]].sort((a, b) => Number(a[0]) - Number(b[0])));
    expect((await fichier(doc.id)).asset_id).toBeNull();
    expect(await resolution(doc.id)).toMatchObject({ status: 'MULTI_ASSET', method: 'DETERMINISTIC' });
    expect(await actionsLink(doc.id)).toEqual([]);
    // Le rattrapage ne le reprend pas (décision prise sur cette analyse).
    const { sweepDocumentsWithoutPrimary } = await import('@/services/ai/reconciliation/document-asset/queue');
    expect(await sweepDocumentsWithoutPrimary({ accountId: compte.id })).toBe(0);
  });

  it('T3DOC-09 — rattachement manuel existant, ou détachement par l’utilisateur : aucune modification automatique', async () => {
    const compte = await make.account();
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const studio = await make.asset(compte, { category: 'IMMOBILIER', name: 'Studio' });
    const { resolveDocumentAsset } = await import('@/services/ai/reconciliation');
    const appel = vi.fn();

    const doc = await make.assetFile(compte, { assetId: null });
    const { linkDocumentToAsset } = await import('@/services/documents/document-asset-links');
    await linkDocumentToAsset({ accountId: compte.id, fileId: doc.id, target: { assetId: studio.id }, role: 'SECONDARY', origin: 'USER' });
    await linkDocumentToAsset({ accountId: compte.id, fileId: doc.id, target: { assetId: maison.id }, role: 'MENTIONED', origin: 'AI', confidence: 0.6 });
    const avant = await liens(doc.id);
    expect(await resolveDocumentAsset({ accountId: compte.id, fileId: doc.id }, { callModel: appel })).toMatchObject({ outcome: 'SUPERSEDED', status: 'USER_DECIDED' });
    expect(await liens(doc.id)).toEqual(avant);

    const detache = await make.assetFile(compte, { assetId: null });
    await sql`UPDATE asset_files SET user_edited_fields = '{"assetId": true}'::jsonb, analysis_state = 'ANALYZED' WHERE id = ${detache.id}`;
    await linkDocumentToAsset({ accountId: compte.id, fileId: detache.id, target: { assetId: maison.id }, role: 'MENTIONED', origin: 'AI', confidence: 0.9 });
    expect(await resolveDocumentAsset({ accountId: compte.id, fileId: detache.id }, { callModel: appel })).toMatchObject({ outcome: 'SUPERSEDED' });
    expect((await liens(detache.id)).map((l) => l[1])).toEqual(['MENTIONED']);
    expect(appel).not.toHaveBeenCalled();
  });

  it('T3DOC-11 — concurrence utilisateur / IA : l’utilisateur rattache pendant l’appel au modèle, son choix gagne', async () => {
    const compte = await make.account();
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const studio = await make.asset(compte, { category: 'IMMOBILIER', name: 'Studio' });
    const doc = await make.assetFile(compte, { assetId: null });
    await analyser(compte, doc.id, sortie({
      assets: [{ id: maison.id, label: 'Maison', confidence: 'probable', score: 0.6 }, { id: studio.id, label: 'Studio', confidence: 'probable', score: 0.6 }],
    }), { drain: false });
    await sql`DELETE FROM ai_job_queue WHERE treatment = 'T3' AND target_type = 'document' AND target_id = ${String(doc.id)}`;

    const { resolveDocumentAsset } = await import('@/services/ai/reconciliation');
    const r = await resolveDocumentAsset({ accountId: compte.id, fileId: doc.id, userId: compte.ownerUserId }, {
      callModel: async () => {
        // Pendant que T3 « réfléchit », l'utilisateur rattache au Studio depuis le tiroir.
        await sql`UPDATE asset_files SET asset_id = ${studio.id}, user_edited_fields = '{"assetId": true}'::jsonb WHERE id = ${doc.id}`;
        return { task: 'LINK_AMBIGUITY', documentScope: 'SINGLE', matches: [{ candidateId: maison.id, score: 0.95, confidence: 'certain', reason: 'nom lu' }] };
      },
    });
    expect(r).toMatchObject({ outcome: 'SUPERSEDED', aiCalled: true });
    expect((await fichier(doc.id)).asset_id).toBe(studio.id);
    expect((await liens(doc.id)).filter((l) => l[0] === maison.id && l[1] === 'PRIMARY')).toEqual([]);
    expect(await actionsLink(doc.id)).toEqual([]);
  });

  it('T3DOC-12 — rattrapage planifié : document ancien (T1 terminé, sans PRIMARY, sans travail en cours) repris sans relancer T1', async () => {
    const compte = await make.account();
    const maison = await maisonLyon(compte);
    await studioLyon(compte);
    const doc = await make.assetFile(compte, { assetId: null });
    // Analyse antérieure à l'adresse de la fiche : T1 n'a rien rattaché ; puis travail perdu.
    await sql`UPDATE assets SET key_characteristics = NULL WHERE id = ${maison.id}`;
    const { replay } = await analyser(compte, doc.id, sortie({ texte: ['Chantier au 12 rue Exemple, 69003 Lyon'] }), { drain: false });
    await sql`DELETE FROM ai_job_queue WHERE treatment = 'T3' AND target_type = 'document' AND target_id = ${String(doc.id)}`;
    await sql`DELETE FROM document_asset_resolutions WHERE file_id = ${doc.id}`;
    await sql`UPDATE assets SET key_characteristics = ${JSON.stringify({ address1: '12 rue Exemple', postalCode: '69003', city: 'Lyon' })} WHERE id = ${maison.id}`;

    const { sweepDocumentsWithoutPrimary } = await import('@/services/ai/reconciliation/document-asset/queue');
    expect(await sweepDocumentsWithoutPrimary({ accountId: compte.id, triggerCode: 'schedule_hourly' })).toBe(1);
    expect(await jobsDoc(doc.id)).toEqual([expect.objectContaining({ status: 'PENDING', trigger_code: 'schedule_hourly' })]);
    // Un second passage ne remet rien en file (travail vivant).
    expect(await sweepDocumentsWithoutPrimary({ accountId: compte.id })).toBe(0);
    await drainQueues();
    expect(await liens(doc.id)).toEqual([[maison.id, 'PRIMARY', 'AI', 1]]);
    expect(replay.calls.filter((c) => c.operationCode === 't1_analyze_document')).toHaveLength(1);
    // Résolu : plus jamais repris.
    expect(await sweepDocumentsWithoutPrimary({ accountId: compte.id })).toBe(0);
  });

  it('T3DOC-12 ter — page bornée du rattrapage planifié (contrat 31C) : curseur, continuation unique, file non saturée', async () => {
    const compte = await make.account();
    await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const doc = await make.assetFile(compte, { assetId: null });
    await analyser(compte, doc.id, sortie({}), { drain: false });
    await sql`DELETE FROM ai_job_queue WHERE treatment = 'T3' AND target_type = 'document' AND target_id = ${String(doc.id)}`;
    await sql`UPDATE document_asset_resolutions SET requested_at = now() - interval '2 hours' WHERE file_id = ${doc.id}`;

    const avant = process.env.T3_DOCUMENT_SWEEP_PAGE_SIZE;
    process.env.T3_DOCUMENT_SWEEP_PAGE_SIZE = '1';
    try {
      const { buildT3Payload } = await import('@/services/ai/reconciliation/t3-job-contract');
      const { enqueue } = await import('@/services/ai/queue/job-queue.repository');
      const cycle = `e2e-${doc.id}`;
      await enqueue({
        treatment: 'T3', scope: { targetType: 'document_sweep', targetId: `${cycle}:0` }, triggerCode: 'schedule_hourly',
        payload: buildT3Payload('document_asset_sweep', { cycleId: cycle, page: 0, afterFileId: doc.id - 1 }), onlyIfNeverQueued: true,
      });
      const { runOne } = await import('@/services/ai/queue/queue-worker');
      const etat = async () => (await sql<{ status: string }[]>`
        SELECT status FROM ai_job_queue WHERE target_type = 'document_sweep' AND target_id = ${`${cycle}:0`}`)[0]?.status;
      for (let i = 0; i < 5 && (await etat()) !== 'DONE'; i += 1) await runOne('T3');
      const [page0] = await sql<{ status: string; business_result: unknown }[]>`
        SELECT status, business_result FROM ai_job_queue WHERE target_type = 'document_sweep' AND target_id = ${`${cycle}:0`}`;
      expect(page0.status).toBe('DONE');
      expect(JSON.stringify(page0.business_result)).toContain('APPLIED');
      expect(await jobsDoc(doc.id)).toEqual([expect.objectContaining({ status: 'PENDING', trigger_code: 'schedule_hourly' })]);
      // Page pleine (taille 1) : UNE continuation, différée, curseur = ce document.
      const suite = await sql<{ status: string; payload: { afterFileId: number; page: number } }[]>`
        SELECT status, payload FROM ai_job_queue WHERE target_type = 'document_sweep' AND target_id = ${`${cycle}:1`}`;
      expect(suite).toHaveLength(1);
      expect(suite[0].payload).toMatchObject({ afterFileId: doc.id, page: 1, payloadVersion: 1 });
      await sql`UPDATE ai_job_queue SET status = 'CANCELLED' WHERE target_type = 'document_sweep' AND target_id = ${`${cycle}:1`}`;
    } finally {
      if (avant === undefined) delete process.env.T3_DOCUMENT_SWEEP_PAGE_SIZE; else process.env.T3_DOCUMENT_SWEEP_PAGE_SIZE = avant;
    }
    await drainQueues();
    expect(await resolution(doc.id)).toMatchObject({ status: 'NO_CANDIDATE' });
  });
});
