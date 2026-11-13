/**
 * Lot 113V (#719, post-MEP) — « Aucun » dans les choix de rattachement
 * document → bien, et respect du non-rattachement explicite, sur PostgreSQL
 * réel (file réelle, route réelle `/resolve`, T1 et T3 de production, modèle
 * SIMULÉ par la passerelle rejouée — appels comptés).
 *
 *   V1  carte à 2 candidats : 2 biens en évidence + « Aucun » actionnable ;
 *       « Aucun » clôt la carte, persiste la décision (contexte, auteur,
 *       date, preuve de clôture), compteur à jour ; aucun lien ni colonne,
 *       document intact et exploitable (biens cités conservés).
 *   V2  deux clics simultanés : une seule décision ; « Annuler » rouvre la
 *       MÊME carte et rétablit l'issue T3 ; reprise idempotente.
 *   V3  réanalyse T1 et passages T3 sans élément nouveau : ni carte, ni
 *       rattachement, aucun appel au modèle ; pont documentaire et balayage
 *       ne reposent pas la question.
 *   V4  T1 désigne un bien refusé avec certitude : aucun rattachement
 *       silencieux (ni lien principal, ni colonne) — bien seulement CITÉ,
 *       aucune carte reposée. V4 bis : preuve déterministe RÉELLEMENT
 *       nouvelle (identifiant exact lu par une nouvelle analyse) → une carte
 *       qui le dit, jamais un rattachement automatique.
 *   V5  bien créé APRÈS « Aucun » et désigné par le document : UNE carte qui
 *       nomme le nouveau bien, sans rattachement automatique ni appel IA ;
 *       passage suivant : même carte, aucune relance ; « Aucun » de nouveau
 *       → plus de réexamen ; ou choix du bien → rattaché.
 *   V6  rattachement manuel ultérieur depuis le document (tiroir) : la
 *       nouvelle décision prime, aucune carte ne revient.
 *   V7  relation d'équipement conservée après « Aucun ».
 *   V8  document multi-biens : jamais converti en choix exclusif.
 *   V9  aucun bien dans le compte / document général : « Aucun » proposé, et
 *       le contrôle de cohérence ne présente pas l'absence de bien comme une
 *       anomalie.
 *   V10 isolation : session d'un autre compte → carte introuvable ; décision
 *       d'un compte sans effet sur l'autre.
 */
import { expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import { drainQueues, sortieT1, useTargetState, type FaitT1 } from '../chain';
import type { RecordedOutput } from '../replay-gateway';

const etat = vi.hoisted(() => ({ session: { userId: 0, currentAccountId: 0 as number | null } }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: etat.session.userId, currentAccountId: etat.session.currentAccountId }),
    handleSessionError: (e: unknown) => { throw e; },
  },
}));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Compte = { id: number; ownerUserId: number };
const ADR = '12 rue des Érables Fictifs, 69000 Lyon';

scenario('L113V-AUCUN', 'À traiter : « Aucun » dans les choix de rattachement, non-rattachement explicite respecté', ({ sql, make, useRecordings: rejouer }) => {
  useTargetState();

  const T3_ABS: RecordedOutput = { operationCode: 't3_link_ambiguity', task: 'LINK_AMBIGUITY', output: { task: 'LINK_AMBIGUITY', matches: [] }, repeat: true };
  const sortie = (p: { title: string; texte?: string[]; facts?: FaitT1[]; assets?: Array<{ id: number; label: string }> }) => sortieT1({
    title: p.title, date: '2025-09-15', documentTypeCode: 'OTHER', rubricCode: 'PROPERTY_MANAGEMENT', supplier: null,
    assets: p.assets ?? [], facts: p.facts ?? [], texte: p.texte, multiAsset: false,
  });
  const t1 = (out: Record<string, unknown>): RecordedOutput => ({ operationCode: 't1_analyze_document', task: 'ANALYZE_DOCUMENT', output: out });
  /** Analyse de production (T1 rejoué) d'un document existant ou nouveau. */
  const analyser = async (compte: Compte, out: Record<string, unknown>, fileId?: number) => {
    const id = fileId ?? (await make.assetFile(compte, { assetId: null })).id;
    await sql`UPDATE asset_files SET s3_bucket = 'e2e-bucket', original_filename = ${`doc-${id}.pdf`}, analysis_state = NULL WHERE id = ${id}`;
    const replay = await rejouer([t1(out), T3_ABS]);
    const { analyzeFileSources } = await import('@/services/ai/source-analysis/entrypoint');
    const r = await analyzeFileSources([id], compte.id, { userId: compte.ownerUserId, billable: false, origin: 'e2e/l113v' });
    if (!r || r.results.length === 0) throw new Error(`[e2e] analyse du fichier ${id} en échec`);
    await drainQueues();
    return { id, replay };
  };
  const passage = async (compte: Compte) => {
    const replay = await rejouer([T3_ABS]);
    const { reconcileAccount } = await import('@/services/ai/reconciliation/account-reconciliation.service');
    await reconcileAccount(compte.id, { type: 'scheduled' }, { triggerCode: 'asset_updated' });
    await drainQueues();
    return replay;
  };
  const appelsT3 = (replay: { calls: Array<{ operationCode?: string }> }) => replay.calls.filter((c) => c.operationCode === 't3_link_ambiguity').length;

  const page = async (compte: Compte) => (await import('@/services/to-process/to-process-query.service')).getToProcessPage(compte.id, { withLinks: true, withAssetChoices: true });
  /** Carte LINK-ASSET par le producteur canonique (même chemin que T3). */
  const carteRattachement = async (compte: Compte, fileId: number, proposals: Array<{ value: number; label: string; confidence: number }> = []) => {
    const { upsertAction } = await import('@/services/to-process/to-process-action.service');
    const r = await upsertAction({
      accountId: compte.id, targetType: 'DOCUMENT', targetId: fileId, relationKey: 'assetIds',
      actionKind: proposals.length ? 'ARBITRATE' : 'COMPLETE', ruleCode: 'LINK-ASSET', proposals,
      triggerContext: { current: '', producer: 'T3_DOCUMENT_ASSET' },
    });
    expect(['CREATED', 'UPDATED']).toContain(r.status);
    return (await carteOuverte(fileId))!.public_id;
  };
  const carteOuverte = async (fileId: number) => (await sql<{ id: number; public_id: string; action_kind: string; question: string; proposals: Array<{ value: number }> | null }[]>`
    SELECT id, public_id::text, action_kind, question, proposals_json AS proposals FROM to_process_actions
     WHERE target_type = 'DOCUMENT' AND target_id = ${fileId} AND rule_code = 'LINK-ASSET' AND resolved_at IS NULL`)[0] ?? null;
  const cartesLink = async (fileId: number) => (await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM to_process_actions WHERE target_type = 'DOCUMENT' AND target_id = ${fileId} AND rule_code = 'LINK-ASSET'`)[0].n;
  const resoudre = async (compte: Compte, publicId: string, body: Record<string, unknown>) => {
    etat.session = { userId: compte.ownerUserId, currentAccountId: compte.id };
    const { POST } = await import('@/app/api/v2/to-process/[publicId]/resolve/route');
    const res = await POST(new NextRequest(`http://localhost/api/v2/to-process/${publicId}/resolve`, {
      method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
    }), { params: Promise.resolve({ publicId }) });
    return { status: res.status, body: (await res.json()) as { ok?: boolean; code?: string; previousValue?: unknown } };
  };
  const aucun = (compte: Compte, publicId: string) => resoudre(compte, publicId, { mode: 'arbitrate', value: 'NONE' });
  const rattachement = async (fileId: number) => (await sql<{ asset_id: number | null; edited: Record<string, unknown> | null; deleted: boolean; state: string | null }[]>`
    SELECT asset_id, user_edited_fields AS edited, deleted_at IS NOT NULL AS deleted, analysis_state AS state FROM asset_files WHERE id = ${fileId}`)[0];
  const liens = async (fileId: number) => sql<{ asset_id: number | null; equipment_id: number | null; link_role: string; origin: string }[]>`
    SELECT asset_id, equipment_id, link_role, origin FROM document_asset_links WHERE file_id = ${fileId} AND status = 'ACTIVE' ORDER BY id`;
  const rattacheA = async (fileId: number) => (await liens(fileId)).filter((l) => l.equipment_id === null && l.link_role !== 'MENTIONED').map((l) => Number(l.asset_id));
  const resolution = async (fileId: number) => (await sql<{ status: string; reason_code: string | null; e: Record<string, unknown> | null }[]>`
    SELECT status, reason_code, last_evaluation AS e FROM document_asset_resolutions WHERE file_id = ${fileId}`)[0] ?? null;
  const decision = async (compte: Compte, fileId: number) => (await import('@/services/to-process/no-asset-decision')).readExplicitNoAssetDecision(compte.id, fileId);
  const evenementsAucun = async (fileId: number) => sql<{ actor_user_id: number | null; details: Record<string, unknown> }[]>`
    SELECT e.actor_user_id, e.details FROM to_process_action_events e JOIN to_process_actions a ON a.id = e.action_id
     WHERE a.target_id = ${fileId} AND a.rule_code = 'LINK-ASSET' AND e.event = 'NOT_APPLICABLE' AND e.details ->> 'choice' = 'NO_ASSET' ORDER BY e.id`;

  /** Compte : deux logements ; document analysé (T1) sans bien désigné ; carte à 2 candidats. */
  const monde = async () => {
    const compte = await make.account();
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const appart = await make.asset(compte, { category: 'IMMOBILIER', name: 'Appartement Lyon' });
    const { id: doc } = await analyser(compte, sortie({ title: 'Courrier de la mairie', texte: ['Information générale aux habitants'] }));
    const publicId = await carteRattachement(compte, doc, [
      { value: maison.id, label: 'Maison', confidence: 0.6 }, { value: appart.id, label: 'Appartement Lyon', confidence: 0.5 },
    ]);
    return { compte, maison, appart, doc, publicId };
  };

  it('V1 — carte à 2 candidats : 2 biens + « Aucun » ; « Aucun » clôt, persiste, met à jour le compteur ; aucun lien artificiel', async () => {
    const w = await monde();
    // Bien seulement CITÉ par l'analyse : conservé (indice, jamais un rattachement).
    const { linkDocumentToAsset } = await import('@/services/documents/document-asset-links');
    await linkDocumentToAsset({ accountId: w.compte.id, fileId: w.doc, target: { assetId: w.maison.id }, role: 'MENTIONED', origin: 'AI', confidence: 0.4, justification: { step: 'OTHER', rule: 'E2E_FIXTURE', proofs: [{ kind: 'MODEL_DESIGNATION' }] } });
    const avant = await page(w.compte);
    const c = avant.actions.find((a) => a.publicId === w.publicId)!;
    expect(c.assetChoices?.status).toBe('OK');
    expect(c.assetChoices!.items.filter((i) => i.suggested).map((i) => i.assetId).sort()).toEqual([w.maison.id, w.appart.id].sort());

    const r = await aucun(w.compte, w.publicId);
    expect(r).toMatchObject({ status: 200, body: { ok: true } });
    expect(await carteOuverte(w.doc)).toBeNull();
    const apres = await page(w.compte);
    expect(apres.total).toBe(avant.total - 1);
    expect(apres.actions.some((a) => a.publicId === w.publicId)).toBe(false);
    // Décision explicite, persistée : contexte du choix, auteur, preuve de clôture.
    const [ev] = await evenementsAucun(w.doc);
    expect(ev.actor_user_id).toBe(w.compte.ownerUserId);
    expect(ev.details).toMatchObject({ choice: 'NO_ASSET', source: 'TO_PROCESS_CARD', ruleCode: 'LINK-ASSET' });
    expect((ev.details.candidateAssetIds as number[]).sort()).toEqual([w.maison.id, w.appart.id].sort());
    expect(ev.details.offeredAssetIds).toEqual(expect.arrayContaining([w.maison.id, w.appart.id]));
    expect(ev.details.keptRelations).toEqual([{ role: 'MENTIONED', origin: 'AI', target: `asset:${w.maison.id}` }]);
    const [a] = await sql<{ reason: string }[]>`SELECT resolution_reason AS reason FROM to_process_actions WHERE public_id::text = ${w.publicId}`;
    expect(a.reason).toBe('NOT_APPLICABLE');
    // Trois états distincts : ici « non-rattachement explicitement choisi ».
    expect(await resolution(w.doc)).toMatchObject({ status: 'USER_DECIDED', reason_code: 'USER_NO_ASSET' });
    expect((await decision(w.compte, w.doc))?.actionId).toBeGreaterThan(0);
    // Document intact : aucun lien principal, aucune colonne, aucune marque « choix utilisateur », toujours analysé et visible.
    const f = await rattachement(w.doc);
    expect(f).toMatchObject({ asset_id: null, deleted: false, state: 'ANALYZED' });
    expect(f.edited?.assetId).toBeUndefined();
    expect(await rattacheA(w.doc)).toEqual([]);
    expect(await liens(w.doc)).toEqual([expect.objectContaining({ asset_id: w.maison.id, link_role: 'MENTIONED' })]);
    expect((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM document_extractions WHERE file_id = ${w.doc}`)[0].n).toBe(1);
  }, 240_000);

  it('V2 — deux clics simultanés : une seule décision ; « Annuler » rouvre la même carte ; reprise idempotente', async () => {
    const w = await monde();
    const avant = await resolution(w.doc);
    const nCartes = await cartesLink(w.doc);
    const [r1, r2] = await Promise.all([aucun(w.compte, w.publicId), aucun(w.compte, w.publicId)]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    expect(await evenementsAucun(w.doc)).toHaveLength(1);
    // « Annuler » : MÊME carte rouverte, issue T3 précédente rétablie, décision plus en vigueur.
    const u = await resoudre(w.compte, w.publicId, { mode: 'undo', previousValue: null });
    expect(u).toMatchObject({ status: 200, body: { ok: true } });
    expect((await carteOuverte(w.doc))?.public_id).toBe(w.publicId);
    expect(await cartesLink(w.doc)).toBe(nCartes);
    expect((await resolution(w.doc))?.status).toBe(avant?.status);
    expect(await decision(w.compte, w.doc)).toBeNull();
    // Second « Annuler » (reprise) : sans effet ; nouveau « Aucun » : accepté.
    expect((await resoudre(w.compte, w.publicId, { mode: 'undo', previousValue: null })).body.ok).toBe(true);
    expect((await aucun(w.compte, w.publicId)).body.ok).toBe(true);
    expect(await decision(w.compte, w.doc)).not.toBeNull();
    expect(await cartesLink(w.doc)).toBe(nCartes);
  }, 240_000);

  it('V3 — réanalyse T1, passages T3, pont et balayage sans élément nouveau : ni carte, ni rattachement, aucun appel IA', async () => {
    const w = await monde();
    const nCartes = await cartesLink(w.doc);
    expect((await aucun(w.compte, w.publicId)).body.ok).toBe(true);
    // Réanalyse T1 du MÊME document (même contenu).
    const { replay } = await analyser(w.compte, sortie({ title: 'Courrier de la mairie', texte: ['Information générale aux habitants'] }), w.doc);
    expect(appelsT3(replay)).toBe(0);
    expect(await carteOuverte(w.doc)).toBeNull();
    // Passages T3 (planifié, puis relance FORCÉE comme une reprise TCO / manuelle).
    expect(appelsT3(await passage(w.compte))).toBe(0);
    const { requestDocumentAssetResolution } = await import('@/services/ai/reconciliation/document-asset/queue');
    const forcee = await rejouer([T3_ABS]);
    await requestDocumentAssetResolution({ accountId: w.compte.id, userId: null, fileId: w.doc, triggerCode: 'manual', reprocessReason: 'MANUAL' });
    await drainQueues();
    expect(appelsT3(forcee)).toBe(0);
    expect(await carteOuverte(w.doc)).toBeNull();
    expect(await rattacheA(w.doc)).toEqual([]);
    expect((await rattachement(w.doc)).asset_id).toBeNull();
    const res = await resolution(w.doc);
    expect(res).toMatchObject({ status: 'USER_DECIDED', reason_code: 'USER_NO_ASSET' });
    expect(res!.e).toMatchObject({ result: 'USER_DECIDED', aiCalled: false, explicitNoAsset: { newAssetIds: [], newEvidenceAssetIds: [] } });
    // Pont documentaire (réévaluation d'état) et balayage horaire : la question n'est pas reposée.
    const { syncDocumentRulesFromState, documentsToReevaluate } = await import('@/services/to-process/document-rule-bridge');
    await syncDocumentRulesFromState(w.compte.id, w.doc, { create: true });
    expect(await carteOuverte(w.doc)).toBeNull();
    expect(await documentsToReevaluate(w.compte.id)).not.toContain(w.doc);
    expect(await cartesLink(w.doc)).toBe(nCartes);
  }, 300_000);

  it('V4 — T1 désigne avec certitude un bien refusé : aucun rattachement silencieux (bien seulement cité)', async () => {
    const w = await monde();
    expect((await aucun(w.compte, w.publicId)).body.ok).toBe(true);
    await analyser(w.compte, sortie({ title: 'Courrier de la mairie', texte: ['Information générale aux habitants'], assets: [{ id: w.maison.id, label: 'Maison' }] }), w.doc);
    await passage(w.compte);
    expect((await rattachement(w.doc)).asset_id).toBeNull();
    expect(await rattacheA(w.doc)).toEqual([]);
    expect((await liens(w.doc)).filter((l) => l.asset_id === w.maison.id).map((l) => l.link_role)).toEqual(['MENTIONED']);
    // Décision toujours en vigueur ; la désignation par l'analyse d'un bien déjà refusé n'est pas une
    // preuve nouvelle : aucune carte reposée.
    expect(await decision(w.compte, w.doc)).not.toBeNull();
    expect(await carteOuverte(w.doc)).toBeNull();
  }, 300_000);

  it('V4 bis — preuve réellement nouvelle (identifiant exact lu par une nouvelle analyse) : réexamen soumis, refus jamais écrasé', async () => {
    const compte = await make.account();
    const polo = await make.asset(compte, { category: 'VEHICULE', name: 'Polo', registrationNumber: 'FG-123-HJ' });
    await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const { id: doc } = await analyser(compte, sortie({ title: 'Facture garage', texte: ['Révision annuelle'] }));
    const publicId = (await carteOuverte(doc))?.public_id ?? await carteRattachement(compte, doc);
    expect((await aucun(compte, publicId)).body.ok).toBe(true);
    // Nouvelle analyse : l'immatriculation de la Polo apparaît (preuve déterministe nouvelle).
    await analyser(compte, sortie({ title: 'Facture garage', texte: ['Révision annuelle', 'Véhicule immatriculé FG-123-HJ'],
      facts: [{ canonicalKey: 'registrationNumber', value: 'FG-123-HJ', valueType: 'string', excerpt: 'Immatriculation : FG-123-HJ', assetId: null }] }), doc);
    const r = await passage(compte);
    expect(appelsT3(r)).toBe(0);
    expect((await rattachement(doc)).asset_id).toBeNull();
    expect(await rattacheA(doc)).toEqual([]);
    const c = await carteOuverte(doc);
    expect(c, 'réexamen soumis').not.toBeNull();
    expect(c!.question).toBe('Ce document contient de nouveaux éléments depuis votre choix « Aucun » : à quel bien le rattacher ?');
    expect(c!.proposals!.map((p) => Number(p.value))).toEqual([polo.id]);
    expect((await resolution(doc))!.e).toMatchObject({ explicitNoAsset: { documentChanged: true, newEvidenceAssetIds: [polo.id] } });
    // Passage suivant sans nouveauté : même carte, aucune relance.
    await passage(compte);
    expect((await carteOuverte(doc))!.id).toBe(c!.id);
  }, 300_000);

  /** Document « travaux » au 12 rue des Érables, compte sans logement : carte T3 sans candidat, puis « Aucun ». */
  const avantLogement = async () => {
    const compte = await make.account();
    const polo = await make.asset(compte, { category: 'VEHICULE', name: 'Polo' });
    const { id: doc } = await analyser(compte, sortie({ title: 'Facture plomberie', texte: [`Intervention au ${ADR}`, `Adresse du chantier : ${ADR}`] }));
    const c = (await carteOuverte(doc)) ?? { public_id: await carteRattachement(compte, doc) };
    expect((await aucun(compte, c.public_id)).body.ok).toBe(true);
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison', keyCharacteristics: { address1: '12 rue des Érables Fictifs', postalCode: '69000', city: 'Lyon' } });
    return { compte, polo, doc, maison };
  };

  it('V5 — bien créé après « Aucun » et désigné : UNE carte qui le nomme, sans rattachement ni IA, sans relance ; « Aucun » de nouveau → plus de réexamen', async () => {
    const w = await avantLogement();
    const r1 = await passage(w.compte);
    expect(appelsT3(r1)).toBe(0);
    expect((await rattachement(w.doc)).asset_id).toBeNull();
    expect(await rattacheA(w.doc)).toEqual([]);
    const c = await carteOuverte(w.doc);
    expect(c, 'réexamen soumis').not.toBeNull();
    expect(c!.action_kind).toBe('ARBITRATE');
    expect(c!.question).toBe('Vous avez ajouté « Maison » depuis votre choix « Aucun » : à quel bien rattacher ce document ?');
    expect(c!.proposals!.map((p) => Number(p.value))).toEqual([w.maison.id]);
    expect((await resolution(w.doc))!.e).toMatchObject({ explicitNoAsset: { newAssetIds: [w.maison.id] } });
    // La carte propose aussi « Aucun » (biens du compte, candidat en évidence).
    const vue = (await page(w.compte)).actions.find((a) => a.publicId === c!.public_id)!;
    expect(vue.assetChoices!.items[0]).toMatchObject({ assetId: w.maison.id, suggested: true });
    // Passage suivant : même carte, aucune nouvelle, aucune reformulation.
    expect(appelsT3(await passage(w.compte))).toBe(0);
    expect((await carteOuverte(w.doc))!.id).toBe(c!.id);
    expect(await cartesLink(w.doc)).toBe(2);
    expect((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM to_process_action_events WHERE action_id = ${c!.id} AND event = 'QUESTION_UPDATED'`)[0].n).toBe(0);
    // « Aucun » de nouveau : le nouveau bien fait partie des biens présentés — plus de réexamen.
    expect((await aucun(w.compte, c!.public_id)).body.ok).toBe(true);
    await passage(w.compte);
    expect(await carteOuverte(w.doc)).toBeNull();
    expect(await cartesLink(w.doc)).toBe(2);
    expect((await rattachement(w.doc)).asset_id).toBeNull();
  }, 360_000);

  it('V5 bis — réexamen : choisir le nouveau bien le rattache (décision explicite qui prime)', async () => {
    const w = await avantLogement();
    await passage(w.compte);
    const c = await carteOuverte(w.doc);
    expect(c).not.toBeNull();
    const r = await resoudre(w.compte, c!.public_id, { mode: 'arbitrate', value: w.maison.id });
    expect(r.body.ok).toBe(true);
    expect((await rattachement(w.doc)).asset_id).toBe(w.maison.id);
    expect(await decision(w.compte, w.doc)).toBeNull();
    await passage(w.compte);
    expect(await carteOuverte(w.doc)).toBeNull();
    expect((await rattachement(w.doc)).asset_id).toBe(w.maison.id);
  }, 360_000);

  it('V6 — rattachement manuel ultérieur depuis le document : la nouvelle décision prime, aucune carte ne revient', async () => {
    const w = await monde();
    expect((await aucun(w.compte, w.publicId)).body.ok).toBe(true);
    const { db } = await import('@/db');
    const { applyDocumentTargets } = await import('@/services/documents/document-targets');
    await db.transaction((tx) => applyDocumentTargets(tx as never, {
      accountId: w.compte.id, fileId: w.doc, mode: 'replace', selection: { assetIds: [w.appart.id], roomIds: [], equipmentIds: [] },
    }));
    expect((await rattachement(w.doc)).asset_id).toBe(w.appart.id);
    expect(await decision(w.compte, w.doc)).toBeNull();
    expect(appelsT3(await passage(w.compte))).toBe(0);
    expect(await carteOuverte(w.doc)).toBeNull();
    expect((await rattachement(w.doc)).asset_id).toBe(w.appart.id);
    // L'historique garde la décision « Aucun » (audit), la relation reflète le nouveau choix.
    expect(await evenementsAucun(w.doc)).toHaveLength(1);
  }, 300_000);

  it('V7 — relation d’équipement conservée après « Aucun »', async () => {
    const w = await monde();
    const [eq] = await sql<{ id: number }[]>`
      INSERT INTO equipments (asset_id, name, type, key_characteristics) VALUES (${w.maison.id}, 'Chaudière', 'APPLIANCE', '{}'::jsonb) RETURNING id`;
    const { linkDocumentToAsset } = await import('@/services/documents/document-asset-links');
    // Équipement CITÉ par le document (relation d'équipement sans rattachement au bien) : la carte reste ouverte.
    await linkDocumentToAsset({ accountId: w.compte.id, fileId: w.doc, target: { equipmentId: Number(eq.id) }, role: 'MENTIONED', origin: 'AI', confidence: 0.7, justification: { step: 'OTHER', rule: 'E2E_FIXTURE', proofs: [{ kind: 'MODEL_DESIGNATION' }] } });
    expect(await carteOuverte(w.doc)).not.toBeNull();
    expect((await aucun(w.compte, w.publicId)).body.ok).toBe(true);
    const equipement = async () => (await liens(w.doc)).filter((l) => l.equipment_id !== null);
    expect(await equipement()).toEqual([expect.objectContaining({ equipment_id: Number(eq.id), link_role: 'MENTIONED', origin: 'AI' })]);
    await passage(w.compte);
    expect(await equipement()).toHaveLength(1);
    // Document lié à un équipement (lien de rattachement) : il est déjà rattaché au bien porteur — aucune
    // carte « À quel bien… ? », donc rien que « Aucun » puisse effacer.
    const garantie = (await analyser(w.compte, sortie({ title: 'Garantie chaudière' }))).id;
    await linkDocumentToAsset({ accountId: w.compte.id, fileId: garantie, target: { equipmentId: Number(eq.id) }, role: 'SECONDARY', origin: 'AI', confidence: 0.9, justification: { step: 'OTHER', rule: 'E2E_FIXTURE', proofs: [{ kind: 'MODEL_DESIGNATION' }] } });
    expect(await carteOuverte(garantie)).toBeNull();
  }, 240_000);

  it('V8 — document multi-biens : jamais converti en choix exclusif', async () => {
    const w = await monde();
    const autre = (await analyser(w.compte, sortie({ title: 'Contrat d’entretien des deux logements' }))).id;
    const { linkDocumentToAsset } = await import('@/services/documents/document-asset-links');
    for (const a of [w.maison.id, w.appart.id]) {
      await linkDocumentToAsset({ accountId: w.compte.id, fileId: autre, target: { assetId: a }, role: 'SECONDARY', origin: 'AI', confidence: 1, justification: { step: 'OTHER', rule: 'E2E_FIXTURE', proofs: [{ kind: 'MODEL_DESIGNATION' }] } });
    }
    const { upsertAction } = await import('@/services/to-process/to-process-action.service');
    const r = await upsertAction({
      accountId: w.compte.id, targetType: 'DOCUMENT', targetId: autre, relationKey: 'assetIds', actionKind: 'ARBITRATE', ruleCode: 'LINK-ASSET',
      proposals: [{ value: w.maison.id, label: 'Maison', confidence: 0.6 }],
    });
    expect(r).toMatchObject({ status: 'SKIPPED', code: 'NO_LONGER_USEFUL' });
    const { syncDocumentRulesFromState } = await import('@/services/to-process/document-rule-bridge');
    await syncDocumentRulesFromState(w.compte.id, autre, { create: true });
    expect(await carteOuverte(autre)).toBeNull();
    expect((await rattacheA(autre)).sort()).toEqual([w.maison.id, w.appart.id].sort());
    // « Aucun » sur l'autre document n'y touche pas.
    expect((await aucun(w.compte, w.publicId)).body.ok).toBe(true);
    expect((await rattacheA(autre)).sort()).toEqual([w.maison.id, w.appart.id].sort());
  }, 240_000);

  it('V9 — aucun bien / document général : « Aucun » proposé, l’absence de bien n’est pas une anomalie', async () => {
    const compte = await make.account();
    const { id: doc } = await analyser(compte, sortie({ title: 'Attestation de domicile', texte: ['Document administratif'] }));
    const publicId = (await carteOuverte(doc))?.public_id ?? await carteRattachement(compte, doc);
    const avant = await page(compte);
    expect(avant.actions.find((a) => a.publicId === publicId)?.assetChoices).toEqual({ status: 'EMPTY', items: [] });
    expect((await aucun(compte, publicId)).body.ok).toBe(true);
    const { runCoherenceFor } = await import('../coherence-run');
    await runCoherenceFor(sql, [compte.id], { mode: 'DRY_RUN' });
    const [p] = await sql<{ last_result: string; finding: Record<string, unknown> | null }[]>`
      SELECT last_result, finding FROM coherence_object_proofs WHERE account_id = ${compte.id} AND check_id = 'COH-DOC-PRIMARY-LINK' AND object_id = ${doc}`;
    expect(p.last_result).toBe('CONSISTENT');
    expect(JSON.stringify(p.finding ?? {})).not.toMatch(/PRIMARY_LINK_/);
    expect((await page(compte)).total).toBe(avant.total - 1);
  }, 300_000);

  it('V10 — isolation : autre session → carte introuvable ; la décision d’un compte ne touche pas l’autre', async () => {
    const w = await monde();
    const v = await monde();
    const intrus = await aucun(v.compte, w.publicId);
    expect(intrus).toMatchObject({ status: 404, body: { code: 'NOT_FOUND' } });
    expect(await carteOuverte(w.doc)).not.toBeNull();
    expect((await aucun(w.compte, w.publicId)).body.ok).toBe(true);
    expect(await decision(v.compte, w.doc)).toBeNull();
    expect(await decision(v.compte, v.doc)).toBeNull();
    expect(await carteOuverte(v.doc)).not.toBeNull();
  }, 300_000);
});
