/**
 * Carte #843 — ASSISTANT T2, écarts restants après #807 : AGENDA, EXPORTS, FORMULATIONS LIBRES, VISIBILITÉ,
 * INSTRUMENTATION — de bout en bout sur PostgreSQL réel. Aucun appel à un fournisseur d'IA ; seul le DÉPÔT du ZIP
 * (stockage objet) est simulé : le manifeste du moteur d'export officiel est capturé tel quel.
 *
 *   T06  E03  retrait CIBLÉ d'un lien d'échéance (avant / après, autres liens intacts, aucune échéance en double) ;
 *             lien absent → dit ; échéance sans date ; série → limite dite ; Duo (B ajoute un lien entre-temps) ;
 *   T07  E08  « factures de la maison sans devis avant le 01/01/2024 » → contenu EXACT (manifeste du moteur) ;
 *             « sans anciens devis » → question, rien de généré ; document supprimé entre l'aperçu et la
 *             génération → dit exclu ; équipement ; Standard (ZIP brut) / Premium (dossier en file) / autre compte ;
 *             aucune confirmation d'écriture ;
 *   T08       formulations libres (indices du modèle) : nouveaux gestes → plan à confirmer ; cible ambiguë →
 *             question ; coordonnées bancaires par le sens → jamais ;
 *   T09  E05  une opération déclarée dans l'Assistant figure bien dans la liste des opérations (texte vrai) ;
 *   T10  E11  trace T2 instrumentée : version servie, source et empreinte du prompt, SHA du build ; lecture du
 *             prompt impossible → « UNKNOWN », jamais une identité inventée.
 */
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';

process.env.OVH_S3_ACCESS_KEY_ID ??= 'e2e';
process.env.OVH_S3_SECRET_ACCESS_KEY ??= 'e2e';
process.env.OVH_S3_BUCKET ??= 'e2e-bucket';
process.env.OVH_S3_ENDPOINT ??= 'https://s3.e2e.invalid';

const h = vi.hoisted(() => ({ manifestes: [] as Array<{ docs: number[]; liens: number[] }> }));

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));
vi.mock('@/services/export-upload.service', async (o) => ({
  ...(await o<object>()), uploadExportFile: async (_b: Buffer, key: string) => key,
}));
// Moteur d'export officiel : le MANIFESTE réellement construit est capturé (contenu exact de l'archive).
vi.mock('@/services/export-zip.service', async (o) => ({
  ...(await o<object>()),
  buildExportZip: async (manifest: { includedDocuments: Array<{ id: number }>; includedWebLinks: Array<{ id: number }> }) => {
    h.manifestes.push({ docs: manifest.includedDocuments.map((d) => d.id).sort((a, b) => a - b), liens: manifest.includedWebLinks.map((d) => d.id) });
    return Buffer.from('zip');
  },
}));
vi.mock('@/services/exports/export-support-notifier', () => ({ notifySupportOfExportFailure: async () => true }));

type Compte = { id: number; ownerUserId: number };
type Json = Record<string, any>;
const TODAY = '2026-11-25';

scenario('C843-T2-AGENDA-EXPORT', 'Carte #843 — Assistant T2 : Agenda, exports, formulations libres, visibilité, instrumentation', ({ sql, make }) => {
  const compte = async (plan: 'standard' | 'premium' | 'premium_duo' = 'premium'): Promise<Compte> => {
    const a = await make.account({ plan });
    return { id: a.id, ownerUserId: a.ownerUserId };
  };
  const membre = async (c: Compte): Promise<number> => {
    const u = await make.user();
    await sql`INSERT INTO account_memberships (account_id, user_id, role, status) VALUES (${c.id}, ${u.id}, 'member', 'active')`;
    return u.id as number;
  };
  const bien = async (c: Compte, name: string, category = 'IMMOBILIER', subtype = 'Maison') => {
    const b = await make.asset(c as never, { name, category });
    await sql`UPDATE assets SET status = 'EN_SERVICE', subtype = ${subtype}, deleted_at = NULL WHERE id = ${b.id}`;
    return b.id as number;
  };
  const demander = async (c: Compte, message: string, userId = c.ownerUserId) => {
    const { prepareCommand } = await import('@/services/verebona-assistant/commands/plan.service');
    return prepareCommand({ accountId: c.id, userId, planType: 'PREMIUM', message, clientRequestId: `c843b-${Math.random()}`, locale: 'fr-FR' } as never);
  };
  const confirmer = async (c: Compte, planId: string, userId = c.ownerUserId) => {
    const { confirmCommandPlan } = await import('@/services/verebona-assistant/commands/plan.service');
    return confirmCommandPlan({ planId, accountId: c.id, userId });
  };
  const planDe = (r: Awaited<ReturnType<typeof demander>>) => {
    if (!r || r.kind !== 'plan') throw new Error(`plan attendu, reçu ${JSON.stringify(r)}`);
    return r;
  };
  const liens = async (itemId: number) => ({
    biens: (await sql<Json[]>`SELECT asset_id::int AS id FROM agenda_asset_links WHERE agenda_item_id = ${itemId} ORDER BY asset_id`).map((r) => r.id),
    docs: (await sql<Json[]>`SELECT asset_file_id::int AS id FROM agenda_file_links WHERE agenda_item_id = ${itemId} ORDER BY asset_file_id`).map((r) => r.id),
  });
  const document = async (c: Compte, assetId: number, p: { titre: string; type?: string; legacy?: string; date?: string; equipmentId?: number; web?: boolean }) => {
    const f = await make.assetFile(c as never, { assetId });
    await sql`UPDATE asset_files SET retained_title = ${p.titre}, document_type_code = ${p.type ?? null}, document_type = ${p.legacy ?? 'AUTRE'},
      document_date = ${p.date ?? null}, equipment_id = ${p.equipmentId ?? null},
      is_web_link = ${p.web === true}, web_link_url = ${p.web ? 'https://exemple.fr/notice' : null}, web_link_title = ${p.web ? p.titre : null}
      WHERE id = ${f.id}`;
    return f.id as number;
  };
  const exporter = async (c: Compte, message: string, deps: Partial<import('@/services/verebona-assistant/commands/export-request').ExportDeps> = {}) => {
    const exp = await import('@/services/verebona-assistant/commands/export-request');
    return exp.answerExportRequest({ accountId: c.id, userId: c.ownerUserId, message, locale: 'fr-FR' } as never, { ...(await exp.sqlExportDeps()), rateLimited: () => null, ...deps });
  };
  const generations = (c: Compte) => sql<Json[]>`SELECT export_type, status, manifest_payload FROM export_generation WHERE account_id = ${c.id} ORDER BY id`;

  it('T06 — E03 : retrait ciblé d’un lien d’échéance ; lien absent ; sans date ; série ; Duo', async () => {
    const c = await compte('premium_duo');
    const b = await membre(c);
    const maison = await bien(c, 'Maison');
    const polo = await bien(c, 'Polo', 'VEHICULE', 'Voiture');
    const facture = await document(c, maison, { titre: 'Facture garage' });
    const item = await make.agendaItem(c as never, { title: 'Vidange', startDate: '2031-03-12', assetIds: [maison, polo] });
    await sql`INSERT INTO agenda_file_links (agenda_item_id, asset_file_id) VALUES (${item.id}, ${facture})`;

    const r = planDe(await demander(c, 'Retire le bien Polo de l’échéance Vidange'));
    expect(r.plan.actions[0].command).toBe('UPDATE_AGENDA_ITEM');
    expect(r.preview.summary).toBe('Modifier l’échéance « Vidange » du 12 mars 2031 : Bien retiré : Polo. Confirmez-vous ?');
    expect(r.plan.actions[0].effects).toContain('Seuls les liens nommés sont retirés : les autres liens de l’échéance, l’échéance elle-même et les objets retirés (bien, pièce, équipement, document) sont conservés.');
    expect(await liens(item.id)).toEqual({ biens: [maison, polo], docs: [facture] });
    expect(await confirmer(c, r.plan.planId)).toMatchObject({ ok: true, status: 'EXECUTED' });
    // Seul le lien nommé est retiré ; l'échéance, le bien Polo, le document et l'autre lien restent.
    expect(await liens(item.id)).toEqual({ biens: [maison], docs: [facture] });
    expect(await sql<Json[]>`SELECT id FROM assets WHERE id = ${polo} AND deleted_at IS NULL`).toHaveLength(1);
    expect(Number((await sql<Json[]>`SELECT count(*)::int AS n FROM agenda_items WHERE account_id = ${c.id}`)[0].n)).toBe(1);

    // Un lien qui n'est pas posé : dit, rien n'est proposé. « Supprime l'échéance » reste une suppression.
    expect(await demander(c, 'Retire le bien Polo de l’échéance Vidange')).toMatchObject({ kind: 'need_info', message: expect.stringMatching(/Ce lien n’est pas posé sur l’échéance « Vidange »/) });
    expect(planDe(await demander(c, 'Supprime l’échéance Vidange')).plan.actions[0].command).toBe('DELETE_AGENDA_ITEM');

    // Document retiré d'une échéance SANS date.
    const sansDate = await make.agendaItem(c as never, { title: 'Ramonage', assetIds: [maison] });
    await sql`INSERT INTO agenda_file_links (agenda_item_id, asset_file_id) VALUES (${sansDate.id}, ${facture})`;
    const rd = planDe(await demander(c, 'Modifie l’échéance Ramonage : retirer le document Facture garage'));
    expect(await confirmer(c, rd.plan.planId)).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect(await liens(sansDate.id)).toEqual({ biens: [maison], docs: [] });
    expect((await sql<Json[]>`SELECT deleted_at FROM asset_files WHERE id = ${facture}`)[0].deleted_at).toBeNull();

    // Série : l'Agenda ne sait pas la modifier d'un geste — limite dite, rien proposé.
    await sql`UPDATE agenda_items SET series_key = 'serie-c843' WHERE id = ${item.id}`;
    const autre = await make.agendaItem(c as never, { title: 'Vidange', startDate: '2032-03-12', assetIds: [maison] });
    await sql`UPDATE agenda_items SET series_key = 'serie-c843' WHERE id = ${autre.id}`;
    expect(await demander(c, 'Modifie toute la série des rappels Vidange : description Apporter le carnet')).toMatchObject({
      kind: 'need_info', message: expect.stringMatching(/^L’Agenda ne permet pas de modifier toute une série d’un seul geste/),
    });

    // Retrait qui rendrait les liens incohérents (le document appartient à la Maison, la Polo resterait seule) : dit
    // AVANT toute proposition.
    const { updateAgendaItem } = await import('@/services/agenda/AgendaWriteService');
    await updateAgendaItem(item.id, { assetIds: [maison, polo] }, c.id, c.ownerUserId);
    expect(await demander(c, 'Retire le bien Maison de l’échéance Vidange du 12 mars 2031')).toMatchObject({
      kind: 'need_info', message: expect.stringMatching(/^Ce retrait laisserait sur l’échéance un document, une pièce ou un équipement du bien retiré/),
    });

    // Duo : A prépare le retrait du document ; B modifie l'échéance entre-temps → conflit, rien d'écrasé, proposition relue.
    const pa = planDe(await demander(c, 'Retire le document Facture garage de l’échéance Vidange du 12 mars 2031'));
    await new Promise((x) => setTimeout(x, 5));
    await updateAgendaItem(item.id, { description: 'Prévenu par B' }, c.id, b);
    const ca = await confirmer(c, pa.plan.planId);
    expect(ca).toMatchObject({ ok: true, status: 'FAILED', results: [{ conflict: true }] });
    expect(await liens(item.id)).toEqual({ biens: [maison, polo], docs: [facture] });
    if (!ca.ok) throw new Error('confirmation attendue');
    expect(ca.refreshedPlan?.actions[0].effects).toContain('Document retiré : Facture garage');
    expect(await confirmer(c, ca.refreshedPlan!.planId)).toMatchObject({ ok: true, status: 'EXECUTED' });
    // La modification de B est conservée ; seul le document nommé est retiré.
    expect(await liens(item.id)).toEqual({ biens: [maison, polo], docs: [] });
    expect((await sql<Json[]>`SELECT description FROM agenda_items WHERE id = ${item.id}`)[0].description).toBe('Prévenu par B');
    expect(TODAY).toBeTruthy();
  });

  it('T07 — E08 : sélection fine des documents d’un export — contenu exact, question, revalidation, offres, autre compte', async () => {
    const std = await compte('standard');
    const maison = await bien(std, 'Maison');
    const [chaudiere] = await sql<Json[]>`INSERT INTO equipments (asset_id, name, status, created_at, updated_at) VALUES (${maison}, 'Chaudière', 'EN_SERVICE', now(), now()) RETURNING id`;
    const f2023 = await document(std, maison, { titre: 'Facture chaudière', type: 'WORKS_INVOICE', date: '2023-05-10', equipmentId: Number(chaudiere.id) });
    const f2024 = await document(std, maison, { titre: 'Facture toiture', type: 'REPAIR_INVOICE', date: '2024-03-02' });
    const fAncienne = await document(std, maison, { titre: 'Vieille facture', legacy: 'FACTURE', date: '2019-01-01' });
    const d2022 = await document(std, maison, { titre: 'Devis isolation', type: 'WORKS_QUOTE', date: '2022-11-30' });
    const d2024 = await document(std, maison, { titre: 'Devis fenêtres', type: 'WORKS_QUOTE', date: '2024-06-01' });
    const attest = await document(std, maison, { titre: 'Attestation assurance', date: '2024-01-15' });
    const lien = await document(std, maison, { titre: 'Notice en ligne', web: true });
    const avantMetier = await sql<Json[]>`SELECT id, retained_title, deleted_at, document_date FROM asset_files WHERE account_id = ${std.id} ORDER BY id`;

    // « Factures de la maison sans devis avant le 01/01/2024 » : génération directe (aucun plan), contenu EXACT.
    h.manifestes.length = 0;
    const r = await exporter(std, 'Exporte les factures de la maison sans les devis avant le 01/01/2024');
    expect(r).toMatchObject({ kind: 'done', code: 'EXPORT_BRUT' });
    expect(h.manifestes).toEqual([{ docs: [f2023, f2024, fAncienne].sort((a, b) => a - b), liens: [] }]);
    expect(r!.message).toMatch(/Documents inclus \(3\) : /);
    expect(r!.message).toMatch(/« Devis isolation » \(30\/11\/2022\) — devis avant le 01\/01\/2024 : retiré à votre demande/);
    expect(r!.message).toMatch(/« Devis fenêtres » \(01\/06\/2024\) — non demandé/);
    expect(r!.message).toMatch(/« Notice en ligne » — non demandé|Documents exclus \(\d\)/);
    const [g] = await generations(std);
    expect(g).toMatchObject({ export_type: 'EXPORT_BRUT', status: 'ready' });
    expect(JSON.parse(g.manifest_payload).customDocIds.sort((a: number, b: number) => a - b)).toEqual([f2023, f2024, fAncienne].sort((a, b) => a - b));
    // Lecture seule : aucune proposition, aucune donnée métier modifiée.
    expect(await sql`SELECT 1 FROM verebona_command_plans WHERE account_id = ${std.id}`).toHaveLength(0);
    expect(await sql<Json[]>`SELECT id, retained_title, deleted_at, document_date FROM asset_files WHERE account_id = ${std.id} ORDER BY id`).toEqual(avantMetier);

    // « Sans les anciens devis » : borne floue → question, RIEN n'est généré.
    const q = await exporter(std, 'Exporte les données brutes de la maison sans les anciens devis');
    expect(q).toMatchObject({ kind: 'need_info', message: expect.stringMatching(/Que voulez-vous dire par « anciens devis » \?.*Rien n’a été lancé/) });
    expect(await generations(std)).toHaveLength(1);

    // Factures + devis, sans les devis anciens ; équipement nommé.
    h.manifestes.length = 0;
    await exporter(std, 'Exporte les factures et les devis de la maison, sans les devis avant le 01/01/2024');
    expect(h.manifestes[0].docs).toEqual([f2023, f2024, fAncienne, d2024].sort((a, b) => a - b));
    h.manifestes.length = 0;
    await exporter(std, 'Exporte les factures de l’équipement Chaudière de la maison');
    expect(h.manifestes[0].docs).toEqual([f2023]);

    // Document SUPPRIMÉ entre l'aperçu (sélection) et la génération : revalidé par le moteur, dit exclu.
    h.manifestes.length = 0;
    const exp = await import('@/services/verebona-assistant/commands/export-request');
    const reel = await exp.sqlExportDeps();
    const rv = await exporter(std, 'Exporte les factures de la maison', {
      listDocuments: async (p) => {
        const docs = await reel.listDocuments!(p);
        await sql`UPDATE asset_files SET deleted_at = now() WHERE id = ${fAncienne}`;
        return docs;
      },
    });
    expect(h.manifestes[0].docs).toEqual([f2023, f2024].sort((a, b) => a - b));
    expect(rv!.message).toMatch(/Documents inclus \(2\)/);
    expect(rv!.message).toMatch(/« Vieille facture » \(01\/01\/2019\) — supprimé ou devenu inaccessible avant la génération/);

    // Offre Standard : un dossier prêt à l'emploi est refusé par le service (rien en file) ; ZIP brut permis (ci-dessus).
    const dossier = await exporter(std, 'Exporte le dossier complet de la maison avec les factures');
    expect(dossier?.kind).toBe('refused');
    expect((await generations(std)).filter((x) => x.export_type !== 'EXPORT_BRUT')).toHaveLength(0);

    // Premium : le dossier est mis en file AVEC la sélection (moteur officiel, `customDocIds`).
    const prem = await compte('premium');
    const m2 = await bien(prem, 'Villa');
    const pf = await document(prem, m2, { titre: 'Facture plomberie', type: 'REPAIR_INVOICE', date: '2024-02-02' });
    await document(prem, m2, { titre: 'Devis cuisine', type: 'WORKS_QUOTE', date: '2021-02-02' });
    const rq = await exporter(prem, 'Exporte le dossier complet de la villa avec les factures');
    expect(rq).toMatchObject({ kind: 'done' });
    expect(rq!.message).toMatch(/Documents choisis \(1\)/);
    // La génération mise en file porte la sélection, transmise au moteur officiel (`customDocIds`).
    expect(JSON.stringify(await sql`SELECT * FROM export_generation WHERE account_id = ${prem.id}`).replace(/\\/g, '')).toMatch(new RegExp(`"customDocIds":\\[${pf}\\]`));

    // Autre compte : le bien est introuvable, rien n'est généré chez personne.
    const autre = await compte('standard');
    expect(await exporter(autre, 'Exporte les factures de la maison')).toMatchObject({ kind: 'need_info' });
    expect(await generations(autre)).toHaveLength(0);
    expect([attest, lien, d2022]).toHaveLength(3);
  });

  it('T08 — formulations libres : indices du modèle → mêmes gestes, même confirmation ; ambiguïté → question', async () => {
    const c = await compte('premium');
    const maison = await bien(c, 'Maison');
    const { prepareFromActionHints, sqlActionHintsDeps } = await import('@/services/verebona-assistant/commands/action-hints');
    const deps = await sqlActionHintsDeps();
    const input = (message: string) => ({ accountId: c.id, userId: c.ownerUserId, planType: 'PREMIUM', message, clientRequestId: `c843h-${Math.random()}`, locale: 'fr-FR' } as never);
    await sql`INSERT INTO equipments (asset_id, name, status, created_at, updated_at) VALUES (${maison}, 'Chaudière', 'EN_SERVICE', now(), now())`;

    const p = await prepareFromActionHints(input('Pour la chaudière, c’est une Viessmann, numéro VS-9'), [{
      operation: 'UPDATE', entityType: 'equipment', targetHint: 'la chaudière', evidencePhrase: null,
      fieldChanges: [{ fieldHint: 'marque', value: 'Viessmann', unit: null }, { fieldHint: 'numéro de série', value: 'VS-9', unit: null }],
    }], { allowWrites: true }, deps);
    expect(p).toMatchObject({ kind: 'plan' });
    if (p?.kind !== 'plan') throw new Error('plan attendu');
    expect(p.preview.actions[0].preview).toMatch(/^Modifier l’équipement « Chaudière » \(Maison\) : Marque : \(vide\) → Viessmann ; Numéro de série : \(vide\) → VS-9\.$/);
    // Rien n'est écrit sans confirmation.
    expect((await sql<Json[]>`SELECT count(*)::int AS n FROM canonical_field_writes WHERE account_id = ${c.id}`)[0].n).toBe(0);

    // Cible ambiguë (deux équipements « Chaudière ») : question, aucun plan.
    const villa = await bien(c, 'Villa');
    await sql`INSERT INTO equipments (asset_id, name, status, created_at, updated_at) VALUES (${villa}, 'Chaudière', 'EN_SERVICE', now(), now())`;
    const amb = await prepareFromActionHints(input('la chaudière est une Bosch'), [{
      operation: 'UPDATE', entityType: 'equipment', targetHint: 'chaudière', evidencePhrase: null, fieldChanges: [{ fieldHint: 'marque', value: 'Bosch', unit: null }],
    }], { allowWrites: true }, deps);
    expect(amb).toMatchObject({ kind: 'need_info', message: expect.stringMatching(/Plusieurs équipements correspondent/) });

    // Coordonnées bancaires par le sens : jamais (la demande suit le parcours existant).
    const { createSupplierForAccount } = await import('@/services/suppliers/supplier-write.facade');
    await createSupplierForAccount({ accountId: c.id, userId: c.ownerUserId, input: { name: 'Plomberie Durand' } });
    expect(await prepareFromActionHints(input('son iban a changé'), [{
      operation: 'UPDATE', entityType: 'supplier', targetHint: 'Plomberie Durand', evidencePhrase: null, fieldChanges: [{ fieldHint: 'iban', value: '[coordonnées bancaires masquées]', unit: null }],
    }], { allowWrites: true }, deps)).toBeNull();
    // Compte en lecture seule : aucune écriture proposée par le sens.
    expect(await prepareFromActionHints(input('x'), [{
      operation: 'UPDATE', entityType: 'equipment', targetHint: 'chaudière', evidencePhrase: null, fieldChanges: [{ fieldHint: 'marque', value: 'Bosch', unit: null }],
    }], { allowWrites: false }, deps)).toBeNull();
  });

  it('T09 — E05 : une opération déclarée dans l’Assistant figure dans la liste des opérations (le texte dit vrai)', async () => {
    const c = await compte('premium');
    await bien(c, 'Clio', 'VEHICULE', 'Voiture');
    const r = planDe(await demander(c, 'Déclare une intervention « Vidange » réalisée le 12 mars 2025 pour la Clio'));
    expect(r.plan.actions[0].effects.join(' ')).toMatch(/Vous la retrouverez sur sa fiche et dans la liste des opérations de votre compte/);
    expect(await confirmer(c, r.plan.planId)).toMatchObject({ ok: true, status: 'EXECUTED' });
    const { readOperationList } = await import('@/services/business-operations/graph/reference-event-list');
    const { operationListQueryOf } = await import('@/lib/reference-events/operation-list');
    const page = await readOperationList(c.id, operationListQueryOf(new URLSearchParams()));
    expect(page.total).toBe(1);
    expect(JSON.stringify(page.items)).toMatch(/Vidange/);
  });

  it('T10 — E11 : trace T2 instrumentée (version servie, source et empreinte du prompt, SHA) ; jamais une identité inventée', async () => {
    const c = await compte('premium');
    process.env.APP_COMMIT = 'c843abcdef0123456789';
    const { recordAiRun } = await import('@/services/verebona-assistant/core/usage-tracking.service');
    const { resetPromptIdentityCache, promptIdentityFor } = await import('@/services/verebona-assistant/core/prompt-instrumentation');
    resetPromptIdentityCache();
    // Identité du prompt effectif (même résolution que la passerelle), mise en cache comme au fil des appels.
    const resolue = await promptIdentityFor('t2_understand');
    console.info(`[C843-T10] prompt résolu : source ${resolue.source}, version ${resolue.version ?? '—'}, empreinte ${resolue.fingerprint ?? '—'}`);
    const requestId = `c843-e11-${Date.now()}`;
    await recordAiRun({
      requestId, accountId: c.id, messageId: null, promptId: 't2_master_v1', promptVersion: 'appelant', routeReason: 'test', operationCode: 't2_understand',
      resolvedModelId: 'modele', fallbackUsed: true, inputTokens: 1, outputTokens: 1, costMicros: 0, latencyMs: 1, attemptNumber: 1, status: 'ok',
      promptHash: 'variables', servedPromptVersion: 't2_master_v1@file', instrument: true,
    } as never);
    const [run] = await sql<Json[]>`SELECT prompt_version, served_prompt_version, prompt_source, prompt_text_fingerprint, app_commit, fallback_used, prompt_hash
      FROM verebona_ai_runs WHERE request_id = ${requestId}`;
    expect(run).toMatchObject({ prompt_version: 'appelant', served_prompt_version: 't2_master_v1@file', app_commit: 'c843abcdef0123456789', fallback_used: true, prompt_hash: 'variables' });
    // Sans version BO active : le fichier du dépôt — source dite, empreinte du texte réellement résolu (16 hex).
    // Si la résolution échoue dans cet environnement : empreinte nulle (jamais inventée).
    expect(run.prompt_source).toBe('REPO_FILE');
    if (resolue.version === 't2_master_v1@file') expect(run.prompt_text_fingerprint).toBe(resolue.fingerprint);
    else expect(run.prompt_text_fingerprint).toBeNull();
    expect(resolue.version === 't2_master_v1@file' || resolue.source === 'UNKNOWN').toBe(true);
    // Version servie différente de la version résolue (activation BO entre deux lectures) : DRIFT, aucune empreinte.
    const r2 = `${requestId}-b`;
    await recordAiRun({
      requestId: r2, accountId: c.id, messageId: null, promptId: 't2_master_v1', promptVersion: 'x', routeReason: 'test', operationCode: 't2_understand',
      resolvedModelId: 'modele', fallbackUsed: false, inputTokens: 1, outputTokens: 1, costMicros: 0, latencyMs: 1, attemptNumber: 1, status: 'ok',
      promptHash: 'v', servedPromptVersion: 't2_master_v1@pv999:autre', instrument: true,
    } as never);
    const [run2] = await sql<Json[]>`SELECT prompt_source, prompt_text_fingerprint FROM verebona_ai_runs WHERE request_id = ${r2}`;
    if (resolue.version) expect(run2).toEqual({ prompt_source: 'BO_VERSION:DRIFT', prompt_text_fingerprint: null });
    else expect(run2).toEqual({ prompt_source: 'BO_VERSION', prompt_text_fingerprint: null });
    delete process.env.APP_COMMIT;
  });
});
