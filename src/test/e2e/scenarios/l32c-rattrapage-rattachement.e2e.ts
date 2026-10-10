/**
 * Lot 32C — rattachement document ↔ bien sur base réelle.
 *
 *   · ticket « Rattrapage des documents déjà ABSTAINED / NO_CANDIDATE » :
 *     version du moteur T3 DOCUMENT_ASSET persistée, rattrapage horaire des
 *     anciennes abstentions SANS relancer T1, déterministe d'abord, décision
 *     utilisateur jamais rejugée, pas de boucle horaire, invalidation par les
 *     identifiants canoniques des biens — T3RV-01 à 08 ;
 *   · PO 8 / PO 10 : incohérence « rattaché à A, contient B » → « À traiter »
 *     LINK-ASSET-CONFLICT, jamais de déplacement automatique — PO8-xx, PO10-xx ;
 *   · PO 9 : un document de plusieurs biens apparaît dans chaque liste —
 *     PO9-xx.
 *
 * Chaîne de production : `analyzeFileSources` (sortie T1 rejouée) → abonné
 * `source_analyzed` → file durable T3 vidée par l'exécutant de production.
 */
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { drainQueues, sortieT1, useTargetState } from '../chain';
import type { RecordedOutput } from '../replay-gateway';
import { DOCUMENT_ASSET_RESOLUTION_VERSION } from '@/services/ai/reconciliation/document-asset/version';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Compte = { id: number; ownerUserId: number };
/** Version courante du moteur DOCUMENT_ASSET (3 depuis le lot 34E). */
const VERSION = DOCUMENT_ASSET_RESOLUTION_VERSION;

scenario('L32C', 'Rattachement document ↔ bien : rattrapage versionné T3, incohérences, documents multi-biens', ({ sql, make, useRecordings: rejouer }) => {
  useTargetState();

  const T3_ABSTENTION: RecordedOutput = {
    operationCode: 't3_link_ambiguity', task: 'LINK_AMBIGUITY', output: { task: 'LINK_AMBIGUITY', matches: [] }, repeat: true,
  };

  const analyser = async (compte: Compte, fileId: number, output: Record<string, unknown>, opts: { extra?: RecordedOutput[]; drain?: boolean } = {}) => {
    await sql`UPDATE asset_files SET s3_bucket = 'e2e-bucket', original_filename = coalesce(original_filename, ${`doc-${fileId}.pdf`}),
                analysis_state = NULL WHERE id = ${fileId}`;
    const replay = await rejouer([{ operationCode: 't1_analyze_document', task: 'ANALYZE_DOCUMENT', output }, ...(opts.extra ?? [])]);
    const { analyzeFileSources } = await import('@/services/ai/source-analysis/entrypoint');
    const r = await analyzeFileSources([fileId], compte.id, { userId: compte.ownerUserId, billable: false, origin: 'e2e/l32c' });
    if (!r || r.results.length === 0) throw new Error(`[e2e] analyse du fichier ${fileId} en échec`);
    if (opts.drain !== false) await drainQueues();
    return { r, replay, warnings: r.results[0].warnings.map((w) => w.code) };
  };
  const sortie = (p: { assets?: Array<{ id: number; label: string; confidence?: 'certain' | 'probable'; score?: number }>; texte?: string[] }) => {
    const out = sortieT1({
      title: 'Facture d’entretien', date: '2026-09-14', documentTypeCode: 'MAINTENANCE_INVOICE', rubricCode: 'MAINTENANCE_WORKS',
      assets: (p.assets ?? []).map((a) => ({ id: a.id, label: a.label })), facts: [], texte: p.texte, multiAsset: false,
    });
    const ents = (out.entities as { assets: Array<Record<string, unknown>> }).assets;
    (p.assets ?? []).forEach((a, i) => { ents[i].confidence = a.confidence ?? 'certain'; ents[i].score = a.score ?? 0.97; });
    return out;
  };

  const liens = async (fileId: number) => (await sql<{ asset_id: number; link_role: string; origin: string }[]>`
    SELECT asset_id, link_role, origin FROM document_asset_links WHERE file_id = ${fileId} AND status = 'ACTIVE' ORDER BY asset_id, id`)
    .map((l) => [Number(l.asset_id), l.link_role, l.origin]);
  const fichier = async (fileId: number) => (await sql<{ asset_id: number | null; analysis_state: string | null; ue: Record<string, unknown> | null }[]>`
    SELECT asset_id, analysis_state, user_edited_fields AS ue FROM asset_files WHERE id = ${fileId}`)[0];
  const resolution = async (fileId: number) => (await sql<{ status: string; method: string | null; resolution_version: number | null; evaluated_at: Date | null; runs: number }[]>`
    SELECT status, method, resolution_version, evaluated_at, runs FROM document_asset_resolutions WHERE file_id = ${fileId}`)[0];
  const jobsDoc = async (fileId: number) => sql<{ id: number; status: string }[]>`
    SELECT id, status FROM ai_job_queue WHERE treatment = 'T3' AND target_type = 'document' AND target_id = ${String(fileId)} ORDER BY id`;
  const actions = async (fileId: number, rule: string) => (await sql<{ id: number; public_id: string; active: boolean; reason: string | null; proposals: unknown; question: string | null; ctx: Record<string, unknown> | null }[]>`
    SELECT id, public_id, resolved_at IS NULL AS active, resolution_reason AS reason, proposals_json AS proposals, question, trigger_context AS ctx
      FROM to_process_actions WHERE target_type = 'DOCUMENT' AND target_id = ${fileId} AND rule_code = ${rule} ORDER BY id`)
    .map((a) => ({ ...a, proposals: ((typeof a.proposals === 'string' ? JSON.parse(a.proposals) : a.proposals) ?? []) as Array<{ value: unknown; label: string; isCurrentValue?: boolean }> }));
  const appels = (replay: { calls: Array<{ operationCode?: string }> }, op: string) => replay.calls.filter((c) => c.operationCode === op).length;
  const balayer = async (compte: Compte) => {
    const { sweepDocumentsWithoutPrimary } = await import('@/services/ai/reconciliation/document-asset/queue');
    return sweepDocumentsWithoutPrimary({ accountId: compte.id, triggerCode: 'schedule_hourly' });
  };
  /** Simule une décision prise par l'ANCIEN moteur (avant la 0274) : pas de version, journal des biens vidé. */
  const ancienneVersion = async (compte: Compte, fileId: number) => {
    await sql`UPDATE document_asset_resolutions SET resolution_version = NULL, evaluated_at = NULL, identifiers_fingerprint = NULL,
                decided_at = now() WHERE file_id = ${fileId}`;
    await sql`DELETE FROM document_asset_identifier_changes WHERE account_id = ${compte.id}`;
    // Lot 34E : décision historique, sans contexte d'évaluation.
    await sql`UPDATE document_asset_resolutions SET knowledge_revision = NULL, context_fingerprint = NULL WHERE file_id = ${fileId}`;
  };

  const ADRESSE = { address1: '12 rue Exemple', postalCode: '69003', city: 'Lyon' };
  const maisonSansAdresse = (compte: Compte, name = 'Maison') => make.asset(compte, { category: 'IMMOBILIER', name });

  // ══ Ticket « rattrapage des abstentions » ═══════════════════════════════

  it('T3RV-01 / T3RV-06 / T3RV-07 — ancienne abstention (ABSTAINED, sans version) + adresse désormais exploitable : APPLY déterministe sans IA ni T1, carte LINK-ASSET fermée', async () => {
    const compte = await make.account();
    const maison = await maisonSansAdresse(compte);
    const studio = await maisonSansAdresse(compte, 'Studio');
    const doc = await make.assetFile(compte, { assetId: null });
    // Première analyse : deux candidats probables, T3 s'abstient → carte « À quel bien… ? ».
    await analyser(compte, doc.id, sortie({
      assets: [{ id: maison.id, label: 'Maison', confidence: 'probable', score: 0.6 }, { id: studio.id, label: 'Studio', confidence: 'probable', score: 0.6 }],
      texte: ['Intervention au 12 rue Exemple, 69003 Lyon'],
    }), { extra: [T3_ABSTENTION] });
    expect(await resolution(doc.id)).toMatchObject({ status: 'ABSTAINED', resolution_version: VERSION });
    expect((await actions(doc.id, 'LINK-ASSET')).filter((a) => a.active)).toHaveLength(1);

    // L'adresse est renseignée ; la décision est celle de l'ancien moteur.
    await sql`UPDATE assets SET key_characteristics = ${JSON.stringify(ADRESSE)} WHERE id = ${maison.id}`;
    await ancienneVersion(compte, doc.id);

    const replay = await rejouer([T3_ABSTENTION]);
    expect(await balayer(compte)).toBe(1);
    await drainQueues();
    expect(appels(replay, 't3_link_ambiguity')).toBe(0); // T3RV-06 : aucun appel IA
    expect(appels(replay, 't1_analyze_document')).toBe(0); // T3RV-AC4 : T1 jamais relancé
    expect(await liens(doc.id)).toContainEqual([maison.id, 'PRIMARY', 'AI']);
    expect((await fichier(doc.id)).asset_id).toBe(maison.id);
    expect(await resolution(doc.id)).toMatchObject({ status: 'RESOLVED', method: 'DETERMINISTIC', resolution_version: VERSION });
    // T3RV-07 : plus aucune action LINK-ASSET active.
    expect((await actions(doc.id, 'LINK-ASSET')).filter((a) => a.active)).toEqual([]);
    expect((await fichier(doc.id)).analysis_state).toBe('ANALYZED');
    // Résolu : plus jamais repris.
    expect(await balayer(compte)).toBe(0);
  });

  it('T3RV-02 — ancien NO_CANDIDATE : même comportement quand le moteur sait désormais résoudre', async () => {
    const compte = await make.account();
    const maison = await maisonSansAdresse(compte);
    const doc = await make.assetFile(compte, { assetId: null });
    await analyser(compte, doc.id, sortie({ texte: ['Chantier : 12 rue Exemple 69003 Lyon'] }));
    expect(await resolution(doc.id)).toMatchObject({ status: 'NO_CANDIDATE' });
    expect((await actions(doc.id, 'LINK-ASSET')).filter((a) => a.active)).toHaveLength(1);

    await sql`UPDATE assets SET key_characteristics = ${JSON.stringify(ADRESSE)} WHERE id = ${maison.id}`;
    await ancienneVersion(compte, doc.id);
    const replay = await rejouer([]);
    expect(await balayer(compte)).toBe(1);
    await drainQueues();
    expect(appels(replay, 't3_link_ambiguity')).toBe(0);
    expect(await resolution(doc.id)).toMatchObject({ status: 'RESOLVED', method: 'DETERMINISTIC' });
    expect((await fichier(doc.id)).asset_id).toBe(maison.id);
    expect((await actions(doc.id, 'LINK-ASSET')).filter((a) => a.active)).toEqual([]);
  });

  it('T3RV-03 / T3RV-AC7 — abstention de la version COURANTE, extraction inchangée : aucun nouveau travail d’heure en heure, même après une modification de bien sans effet sur ses identifiants', async () => {
    const compte = await make.account();
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison', keyCharacteristics: ADRESSE });
    const studio = await make.asset(compte, { category: 'IMMOBILIER', name: 'Studio', keyCharacteristics: { address1: '8 avenue Foch', postalCode: '69006' } });
    const doc = await make.assetFile(compte, { assetId: null });
    await analyser(compte, doc.id, sortie({
      assets: [{ id: maison.id, label: 'Maison', confidence: 'probable', score: 0.6 }, { id: studio.id, label: 'Studio', confidence: 'probable', score: 0.6 }],
    }), { extra: [T3_ABSTENTION] });
    const avant = await resolution(doc.id);
    expect(avant).toMatchObject({ status: 'ABSTAINED', resolution_version: VERSION });

    // Trois « heures » : rien à rejouer.
    for (let h = 0; h < 3; h += 1) expect(await balayer(compte)).toBe(0);
    expect(await jobsDoc(doc.id)).toHaveLength(1); // le seul travail : celui de l'analyse

    // Bien modifié hors identifiants (surface) : journalisé, mais empreinte inchangée → confirmation, aucun travail.
    await sql`UPDATE assets SET key_characteristics = ${JSON.stringify({ ...ADRESSE, livingArea: 120 })} WHERE id = ${maison.id}`;
    // Lot 34E : la connaissance du compte a évolué (journal 0292)…
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM account_knowledge_changes WHERE account_id = ${compte.id} AND kind = 'ASSET'`;
    expect(n).toBeGreaterThan(0);
    await sql`UPDATE document_asset_resolutions SET evaluated_at = evaluated_at - interval '1 hour' WHERE file_id = ${doc.id}`;
    expect(await balayer(compte)).toBe(0);
    expect(await jobsDoc(doc.id)).toHaveLength(1);
    const apres = await resolution(doc.id);
    expect(apres.status).toBe('ABSTAINED');
    expect(apres.runs).toBe(avant.runs);
    expect(new Date(apres.evaluated_at!).getTime()).toBeGreaterThan(new Date(avant.evaluated_at!).getTime() - 3_600_000);
    // … mais le contexte pertinent est identique : CONFIRMED_NO_CHANGE, révision avancée ; l'heure suivante, plus rien.
    expect((await sql<{ e: { result: string; aiCalled: boolean } }[]>`SELECT last_evaluation AS e FROM document_asset_resolutions WHERE file_id = ${doc.id}`)[0].e)
      .toMatchObject({ result: 'CONFIRMED_NO_CHANGE', aiCalled: false });
    expect(await balayer(compte)).toBe(0);
  });

  it('T3RV-04 — même version, NOUVELLE extraction : réévaluation autorisée', async () => {
    const compte = await make.account();
    await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const doc = await make.assetFile(compte, { assetId: null });
    await analyser(compte, doc.id, sortie({}));
    expect(await resolution(doc.id)).toMatchObject({ status: 'NO_CANDIDATE', resolution_version: VERSION });
    expect(await balayer(compte)).toBe(0);
    await sql`UPDATE document_extractions SET extracted_at = now() + interval '1 minute' WHERE file_id = ${doc.id}`;
    expect(await balayer(compte)).toBe(1);
    await drainQueues();
    expect(await resolution(doc.id)).toMatchObject({ status: 'NO_CANDIDATE', resolution_version: VERSION });
  });

  it('T3RV-05 / T3RV-AC6 — ancienne abstention puis choix OU retrait par l’utilisateur : aucun rattachement automatique', async () => {
    const compte = await make.account();
    const maison = await maisonSansAdresse(compte);
    const choisi = await make.assetFile(compte, { assetId: null });
    const retire = await make.assetFile(compte, { assetId: null });
    for (const d of [choisi, retire]) await analyser(compte, d.id, sortie({ texte: ['12 rue Exemple 69003 Lyon'] }));
    await sql`UPDATE assets SET key_characteristics = ${JSON.stringify(ADRESSE)} WHERE id = ${maison.id}`;
    for (const d of [choisi, retire]) await ancienneVersion(compte, d.id);
    // Choix (lien USER vers un autre bien, sans colonne) ; retrait explicite (marque utilisateur).
    const autre = await make.asset(compte, { category: 'IMMOBILIER', name: 'Autre' });
    const { linkDocumentToAsset } = await import('@/services/documents/document-asset-links');
    await linkDocumentToAsset({ accountId: compte.id, fileId: choisi.id, target: { assetId: autre.id }, role: 'SECONDARY', origin: 'USER' });
    await sql`UPDATE asset_files SET user_edited_fields = '{"assetId": true}'::jsonb WHERE id = ${retire.id}`;

    expect(await balayer(compte)).toBe(0);
    // Même un travail explicite ne rejuge pas : USER_DECIDED, rien d'écrit.
    const { resolveDocumentAsset } = await import('@/services/ai/reconciliation/document-asset/resolve-document-asset.service');
    for (const d of [choisi, retire]) {
      const r = await resolveDocumentAsset({ accountId: compte.id, fileId: d.id });
      expect(r).toMatchObject({ outcome: 'SUPERSEDED', status: 'USER_DECIDED', aiCalled: false });
      expect((await fichier(d.id)).asset_id).toBeNull();
      expect((await liens(d.id)).filter((l) => l[0] === maison.id)).toEqual([]);
      expect(await resolution(d.id)).toMatchObject({ status: 'USER_DECIDED', resolution_version: VERSION });
    }
    // Décision utilisateur, même avec une version future du moteur : jamais reprise.
    await sql`UPDATE document_asset_resolutions SET resolution_version = 1 WHERE file_id IN (${choisi.id}, ${retire.id})`;
    expect(await balayer(compte)).toBe(0);
  });

  it('T3RV-08 — identifiant canonique d’un bien complété APRÈS une abstention de la version courante : invalidation, rattachement déterministe', async () => {
    const compte = await make.account();
    const maison = await maisonSansAdresse(compte);
    const doc = await make.assetFile(compte, { assetId: null });
    await analyser(compte, doc.id, sortie({ texte: ['Travaux : 12 rue Exemple 69003 Lyon'] }));
    expect(await resolution(doc.id)).toMatchObject({ status: 'NO_CANDIDATE', resolution_version: VERSION });
    expect(await balayer(compte)).toBe(0);

    await sql`UPDATE assets SET key_characteristics = ${JSON.stringify(ADRESSE)} WHERE id = ${maison.id}`;
    const replay = await rejouer([]);
    expect(await balayer(compte)).toBe(1);
    await drainQueues();
    expect(appels(replay, 't3_link_ambiguity') + appels(replay, 't1_analyze_document')).toBe(0);
    expect(await resolution(doc.id)).toMatchObject({ status: 'RESOLVED', method: 'DETERMINISTIC' });
    expect((await actions(doc.id, 'LINK-ASSET')).filter((a) => a.active)).toEqual([]);
  });

  it('T3RV-AC8 — rattrapage paginé : page bornée, puis la suite', async () => {
    const compte = await make.account();
    const maison = await maisonSansAdresse(compte);
    const docs = [await make.assetFile(compte, { assetId: null }), await make.assetFile(compte, { assetId: null })];
    for (const d of docs) await analyser(compte, d.id, sortie({ texte: ['12 rue Exemple 69003 Lyon'] }));
    await sql`UPDATE assets SET key_characteristics = ${JSON.stringify(ADRESSE)} WHERE id = ${maison.id}`;
    for (const d of docs) await ancienneVersion(compte, d.id);
    const { sweepDocumentsWithoutPrimary } = await import('@/services/ai/reconciliation/document-asset/queue');
    expect(await sweepDocumentsWithoutPrimary({ accountId: compte.id, limit: 1 })).toBe(1);
    expect(await sweepDocumentsWithoutPrimary({ accountId: compte.id, limit: 1 })).toBe(1); // le premier a un travail vivant
    expect(await sweepDocumentsWithoutPrimary({ accountId: compte.id, limit: 1 })).toBe(0);
    await drainQueues();
    for (const d of docs) expect((await fichier(d.id)).asset_id).toBe(maison.id);
  });

  // ══ PO 8 / PO 10 : incohérence de rattachement ══════════════════════════

  const deuxMaisons = async (compte: Compte) => ({
    a: await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison A', keyCharacteristics: { address1: '3 chemin des Vignes', postalCode: '33000' } }),
    b: await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison B', keyCharacteristics: ADRESSE }),
  });
  const resoudre = async (compte: Compte, publicId: string, value: unknown) => {
    const { resolveArbitration } = await import('@/services/to-process/resolve-action.service');
    return resolveArbitration(compte.id, publicId, value, { userId: compte.ownerUserId });
  };

  it('PO8-01 — document rattaché à A contenant l’adresse de B : action « À traiter » dédiée, A conservé, aucune duplication à la réanalyse', async () => {
    const compte = await make.account();
    const { a, b } = await deuxMaisons(compte);
    const doc = await make.assetFile(compte, { assetId: a.id });
    const out = sortie({ texte: ['Intervention au 12 rue Exemple, 69003 Lyon'] });
    const { warnings } = await analyser(compte, doc.id, out);
    expect(warnings).toContain('ASSET_TARGET_CONTRADICTION');
    expect((await fichier(doc.id)).asset_id).toBe(a.id); // jamais de déplacement automatique
    const [carte] = await actions(doc.id, 'LINK-ASSET-CONFLICT');
    expect(carte).toMatchObject({
      active: true,
      question: 'Ce document est rattaché à « Maison A » mais contient l’adresse de « Maison B ». Quel bien garder ?',
      ctx: expect.objectContaining({ currentAssetId: a.id, suggestedAssetId: b.id, basis: 'IDENTIFIER', kinds: ['ADDRESS'] }),
    });
    expect(carte.proposals.map((p) => p.value)).toEqual([`MOVE:${b.id}`, 'IGNORE', 'KEEP']);
    // L'adresse (sensible) n'apparaît nulle part sur la carte.
    expect(JSON.stringify(carte)).not.toContain('rue Exemple');
    // Réanalyse : même carte, mise à jour.
    await analyser(compte, doc.id, out);
    expect(await actions(doc.id, 'LINK-ASSET-CONFLICT')).toHaveLength(1);
    // Aucune carte LINK-ASSET : le document est rattaché.
    expect((await actions(doc.id, 'LINK-ASSET')).filter((x) => x.active)).toEqual([]);
  });

  it('PO8-02 — « Rattacher à B » : déplacement par l’utilisateur (colonne, liens), carte close ; « Annuler » rétablit A et rouvre la carte', async () => {
    const compte = await make.account();
    const { a, b } = await deuxMaisons(compte);
    const doc = await make.assetFile(compte, { assetId: a.id });
    await analyser(compte, doc.id, sortie({ texte: ['12 rue Exemple 69003 Lyon'] }));
    const [carte] = await actions(doc.id, 'LINK-ASSET-CONFLICT');
    // Requête forgée vers un autre bien : refusée.
    expect(await resoudre(compte, carte.public_id, `MOVE:${a.id}`)).toMatchObject({ ok: false, error: 'INVALID_VALUE' });
    const r = await resoudre(compte, carte.public_id, `MOVE:${b.id}`);
    expect(r.ok).toBe(true);
    const f = await fichier(doc.id);
    expect(f.asset_id).toBe(b.id);
    expect(f.ue).toMatchObject({ assetId: true });
    const l = await liens(doc.id);
    expect(l.filter((x) => x[0] === a.id)).toEqual([]);
    expect(l.filter((x) => x[0] === b.id && x[1] === 'PRIMARY').length).toBeGreaterThan(0);
    expect((await actions(doc.id, 'LINK-ASSET-CONFLICT'))[0]).toMatchObject({ active: false, reason: 'USER_ARBITRATED' });

    const { undoArbitration } = await import('@/services/to-process/resolve-action.service');
    expect((await undoArbitration(compte.id, carte.public_id, r.previousValue)).ok).toBe(true);
    expect((await fichier(doc.id)).asset_id).toBe(a.id);
    expect((await liens(doc.id)).filter((x) => x[0] === b.id && x[1] === 'PRIMARY')).toEqual([]);
    expect((await actions(doc.id, 'LINK-ASSET-CONFLICT'))[0]).toMatchObject({ active: true });
  });

  it('PO8-03 — « Garder A » : décision utilisateur explicite, le même couple n’est plus reproposé ; « Ignorer » : idem (Non applicable)', async () => {
    const compte = await make.account();
    const { a } = await deuxMaisons(compte);
    const garde = await make.assetFile(compte, { assetId: a.id });
    const ignore = await make.assetFile(compte, { assetId: a.id });
    const out = sortie({ texte: ['12 rue Exemple 69003 Lyon'] });
    for (const d of [garde, ignore]) await analyser(compte, d.id, out);

    const [c1] = await actions(garde.id, 'LINK-ASSET-CONFLICT');
    expect((await resoudre(compte, c1.public_id, 'KEEP')).ok).toBe(true);
    expect(await fichier(garde.id)).toMatchObject({ asset_id: a.id, ue: expect.objectContaining({ assetId: true }) });
    expect((await actions(garde.id, 'LINK-ASSET-CONFLICT'))[0]).toMatchObject({ active: false, reason: 'USER_ARBITRATED' });

    const [c2] = await actions(ignore.id, 'LINK-ASSET-CONFLICT');
    expect((await resoudre(compte, c2.public_id, 'IGNORE')).ok).toBe(true);
    expect((await actions(ignore.id, 'LINK-ASSET-CONFLICT'))[0]).toMatchObject({ active: false, reason: 'NOT_APPLICABLE' });
    expect((await fichier(ignore.id)).asset_id).toBe(a.id);

    // Réanalyse identique : aucune nouvelle carte.
    for (const d of [garde, ignore]) {
      await analyser(compte, d.id, out);
      expect((await actions(d.id, 'LINK-ASSET-CONFLICT')).filter((x) => x.active)).toEqual([]);
    }
  });

  it('PO8-04 — carte devenue sans objet (document rattaché ailleurs par l’utilisateur) : close au balayage ; résolution tardive « périmée »', async () => {
    const compte = await make.account();
    const { a } = await deuxMaisons(compte);
    const c = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison C' });
    const doc = await make.assetFile(compte, { assetId: a.id });
    const doc2 = await make.assetFile(compte, { assetId: a.id });
    for (const d of [doc, doc2]) await analyser(compte, d.id, sortie({ texte: ['12 rue Exemple 69003 Lyon'] }));
    await sql`UPDATE asset_files SET asset_id = ${c.id} WHERE id IN (${doc.id}, ${doc2.id})`;
    const [carte2] = await actions(doc2.id, 'LINK-ASSET-CONFLICT');
    expect(await resoudre(compte, carte2.public_id, 'KEEP')).toMatchObject({ ok: false, error: 'STALE' });
    expect((await fichier(doc2.id)).asset_id).toBe(c.id);
    const { produceAccountActions } = await import('@/services/to-process/producers.service');
    await produceAccountActions(compte.id);
    expect((await actions(doc.id, 'LINK-ASSET-CONFLICT'))[0]).toMatchObject({ active: false, reason: 'OBSOLETE' });
  });

  it('PO10-01 — rattachement utilisateur (lien USER) et réanalyse CERTAINE désignant un autre bien : « À traiter », jamais de déplacement', async () => {
    const compte = await make.account();
    const polo = await make.asset(compte, { category: 'VEHICULE', name: 'Polo' });
    const clio = await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    const doc = await make.assetFile(compte, { assetId: null });
    const { linkDocumentToAsset } = await import('@/services/documents/document-asset-links');
    await linkDocumentToAsset({ accountId: compte.id, fileId: doc.id, target: { assetId: polo.id }, role: 'PRIMARY', origin: 'USER' });
    const { warnings } = await analyser(compte, doc.id, sortie({ assets: [{ id: clio.id, label: 'Clio' }] }));
    expect(warnings).toContain('ASSET_TARGET_CONTRADICTION');
    expect((await liens(doc.id)).filter((x) => x[1] === 'PRIMARY')).toEqual([[polo.id, 'PRIMARY', 'USER']]);
    const [carte] = await actions(doc.id, 'LINK-ASSET-CONFLICT');
    expect(carte).toMatchObject({
      active: true, question: 'Ce document est rattaché à « Polo » mais l’analyse indique qu’il concerne « Clio ». Quel bien garder ?',
    });
    // Réanalyse qui confirme Polo : carte close.
    await analyser(compte, doc.id, sortie({ assets: [{ id: polo.id, label: 'Polo' }] }));
    expect((await actions(doc.id, 'LINK-ASSET-CONFLICT'))[0]).toMatchObject({ active: false, reason: 'OBSOLETE' });
  });

  // ══ PO 9 : un document de plusieurs biens dans chaque liste ══════════════

  it('PO9-01 — document de A lié à B (SECONDARY) : dans les listes et compteurs de A ET de B, une seule fois ; jamais via MENTIONED', async () => {
    const compte = await make.account();
    const a = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison A' });
    const b = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison B' });
    const c = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison C' });
    const commun = await make.assetFile(compte, { assetId: a.id });
    const propreA = await make.assetFile(compte, { assetId: a.id });
    const multi = await make.assetFile(compte, { assetId: null });
    await sql`UPDATE asset_files SET upload_status = 'COMPLETED' WHERE id IN (${commun.id}, ${propreA.id}, ${multi.id})`;
    const { linkDocumentToAsset } = await import('@/services/documents/document-asset-links');
    await linkDocumentToAsset({ accountId: compte.id, fileId: commun.id, target: { assetId: b.id }, role: 'SECONDARY', origin: 'AI' });
    // Lien PRIMARY doublon de la colonne (USER) : toujours une seule ligne.
    await linkDocumentToAsset({ accountId: compte.id, fileId: commun.id, target: { assetId: c.id }, role: 'MENTIONED', origin: 'AI' });
    await linkDocumentToAsset({ accountId: compte.id, fileId: multi.id, target: { assetId: a.id }, role: 'SECONDARY', origin: 'AI' });
    await linkDocumentToAsset({ accountId: compte.id, fileId: multi.id, target: { assetId: b.id }, role: 'SECONDARY', origin: 'AI' });

    const { getDocumentFeed } = await import('@/services/documents/rubric-query.service');
    const feed = (assetIds: number[], biens: string[] = []) => getDocumentFeed({
      accountId: compte.id, assetIds, ids: null, filters: { biens, rubrics: [], types: [] },
      sort: 'added', direction: 'desc', grouped: false, limit: 50,
    } as never);
    const ids = (r: { documents: Array<{ id: number }> }) => r.documents.map((d) => d.id).sort((x, y) => x - y);

    const ficheA = await feed([a.id]);
    expect(ids(ficheA)).toEqual([commun.id, propreA.id, multi.id].sort((x, y) => x - y));
    expect(ficheA.meta?.scopeTotal).toBe(3);
    const ficheB = await feed([b.id]);
    expect(ids(ficheB)).toEqual([commun.id, multi.id].sort((x, y) => x - y));
    expect(ficheB.meta?.scopeTotal).toBe(2);
    // MENTIONED : jamais dans la liste du bien cité.
    expect(ids(await feed([c.id]))).toEqual([]);
    // Le document affiche ses deux biens.
    const doc = ficheB.documents.find((d) => d.id === commun.id)!;
    expect(doc.assetNames).toEqual(['Maison A', 'Maison B']);

    // Page globale : facette « bien » et filtre.
    const global = await feed([]);
    const facette = Object.fromEntries(global.meta!.facets.biens.map((f) => [f.value, f.count]));
    expect(facette).toMatchObject({ [String(a.id)]: 3, [String(b.id)]: 2 });
    expect(facette[String(c.id)]).toBeUndefined();
    expect(global.meta?.scopeTotal).toBe(3);
    const filtreB = await feed([], [String(b.id)]);
    expect(ids(filtreB)).toEqual([commun.id, multi.id].sort((x, y) => x - y));
    expect(filtreB.meta?.total).toBe(2);

    // Ancienne vue groupée (/api/documents/browse) : même périmètre.
    const { listDocumentsGrouped } = await import('@/services/documents/document-query.service');
    const browse = await listDocumentsGrouped({ accountId: compte.id, assetIds: [b.id] } as never);
    const vus = browse.groups.flatMap((g: { documents: Array<{ id: number }> }) => g.documents.map((d) => d.id));
    expect(vus.sort((x: number, y: number) => x - y)).toEqual([commun.id, multi.id].sort((x, y) => x - y));

    // Retrait du lien (REMOVED) : le document quitte la liste de B.
    const { unlinkDocument } = await import('@/services/documents/document-asset-links');
    await unlinkDocument({ accountId: compte.id, fileId: commun.id, target: { assetId: b.id } });
    expect(ids(await feed([b.id]))).toEqual([multi.id]);
  });
});
