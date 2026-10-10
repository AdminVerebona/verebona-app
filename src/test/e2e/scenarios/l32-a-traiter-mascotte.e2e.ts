/**
 * Lot 32 (agent A) — « À traiter », mascotte et compteur, sur PostgreSQL réel.
 *
 *   · L32-1  : « Quel est le numéro d’immatriculation de ce bien ? — Vélo Jean
 *              Fourche — RK469970GP » → « La valeur n’a pas pu être
 *              appliquée. » Reproduit par la chaîne de production (analyse T1
 *              rejouée → preuve → T3 → pont → carte), corrigé : aucune carte
 *              pour un vélo, résolution par la route pour une voiture,
 *              carte historique retirée avec un message utile, migration 0270,
 *              balayage ;
 *   · MASC2  : la mascotte lit la MÊME source que la file (contrat structuré,
 *              ciblage par ID) ; après résolution, mascotte = file = pastille ;
 *   · L32-6  : pastille (`/api/to-process`) = page (`/api/v2/to-process`)
 *              = mascotte, avant et après résolution / création ;
 *   · PO6    : pré-génération durable (0271, tâche `mascot-pregeneration`).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { analyserDocument, sortieT1, useTargetState } from '../chain';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));
vi.mock('@/db', async (o) => ({ ...(await o<object>()), ensureMigrations: async () => {} }));

interface Carte { id: number; public_id: string; rule_code: string; action_kind: string; active: boolean; resolution_reason: string | null; proposals: Array<{ value: unknown; label: string }> }

scenario('L32-A', 'Immatriculation d’un vélo, mascotte à deux niveaux, compteur synchronisé, pré-génération durable', ({ sql, make, useRecordings }) => {
  useTargetState();
  const session = { userId: 0, currentAccountId: 0 };
  const T3_ABSTENTION = { operationCode: 't3_link_ambiguity', task: 'LINK_AMBIGUITY', output: { task: 'LINK_AMBIGUITY', matches: [] }, repeat: true };

  async function routes() {
    const { SessionService } = await import('@/lib/session-service');
    vi.spyOn(SessionService, 'getSession').mockImplementation(async () => ({ userId: session.userId, currentAccountId: session.currentAccountId, role: 'USER', email: '' }) as never);
    const { NextRequest } = await import('next/server');
    const resolve = await import('@/app/api/v2/to-process/[publicId]/resolve/route');
    const page = await import('@/app/api/v2/to-process/route');
    const pastille = await import('@/app/api/to-process/route');
    return {
      resolve: async (publicId: string, body: unknown) => {
        const res = await resolve.POST(new NextRequest(`http://app.test/api/v2/to-process/${publicId}/resolve`, {
          method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
        }), { params: Promise.resolve({ publicId }) });
        return { status: res.status, body: await res.json() as Record<string, unknown> };
      },
      page: async () => (await (await page.GET(new NextRequest('http://app.test/api/v2/to-process'))).json()) as { total: number; actions: Array<{ publicId: string }> },
      pastille: async () => ((await (await pastille.GET(new NextRequest('http://app.test/api/to-process'))).json()) as { total: number }).total,
    };
  }

  const cartes = async (assetId: number): Promise<Carte[]> => (await sql<Carte[]>`
    SELECT id, public_id, rule_code, action_kind, resolved_at IS NULL AS active, resolution_reason, proposals_json AS proposals
      FROM to_process_actions WHERE target_type = 'ASSET' AND target_id = ${assetId} ORDER BY id`)
    .map((c) => ({ ...c, proposals: (typeof c.proposals === 'string' ? JSON.parse(c.proposals) : c.proposals) ?? [] }));

  const plaque = async (assetId: number) => (await sql<{ r: string | null; kc: string | null }[]>`
    SELECT registration_number AS r, key_characteristics AS kc FROM assets WHERE id = ${assetId}`)[0];

  /** Document du bien qui cite un numéro « probable » (le cas de la recette). */
  async function analyserImmat(compte: { id: number; ownerUserId: number }, assetId: number, label: string, valeur: string) {
    const doc = await make.assetFile(compte, { assetId });
    await analyserDocument(sql, useRecordings, {
      accountId: compte.id, userId: compte.ownerUserId, fileId: doc.id, linkedAssetId: assetId, extra: [T3_ABSTENTION],
      output: sortieT1({
        title: `Facture d’achat ${label}`, date: '2026-03-14', documentTypeCode: 'PURCHASE_INVOICE', rubricCode: 'ACQUISITION_OWNERSHIP',
        assets: [{ id: assetId, label }],
        facts: [{ canonicalKey: 'registrationNumber', value: valeur, valueType: 'string', excerpt: `N° ${valeur}`, assetId, confidence: 'probable' }],
      }),
    });
    return doc;
  }

  // ── L32-1 ───────────────────────────────────────────────────────────────

  it('L32-1 — vélo : la preuve « immatriculation » ne produit NI carte NI écriture ; voiture : carte, résolue par la route', async () => {
    const compte = await make.account();
    session.userId = compte.ownerUserId; session.currentAccountId = compte.id;
    const velo = await make.asset(compte, { category: 'VEHICULE', name: 'Vélo Jean Fourche' });
    await sql`UPDATE assets SET subtype = 'Vélo' WHERE id = ${velo.id}`;
    const clio = await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    await sql`UPDATE assets SET subtype = 'Voiture' WHERE id = ${clio.id}`;

    await analyserImmat(compte, velo.id, 'Vélo Jean Fourche', 'RK469970GP');
    await analyserImmat(compte, clio.id, 'Clio', 'GK-482-RT');

    // Vélo : aucune carte d'immatriculation, aucune valeur écrite.
    expect((await cartes(velo.id)).filter((c) => c.rule_code === 'DATA-REGISTRATION')).toEqual([]);
    const v = await plaque(velo.id);
    expect(v.r).toBeNull();
    expect(JSON.parse(v.kc ?? '{}').registrationNumber).toBeUndefined();

    // Voiture (témoin) : la valeur « probable » est PROPOSÉE (carte À arbitrer).
    const [carte] = (await cartes(clio.id)).filter((c) => c.rule_code === 'DATA-REGISTRATION' && c.active);
    expect(carte).toBeTruthy();
    expect(carte.proposals.map((p) => p.value)).toContain('GK-482-RT');

    // Avant le lot 32 : FIELD_NOT_RESOLVABLE (422) → « La valeur n’a pas pu être appliquée. ».
    const r = await routes();
    const ok = await r.resolve(carte.public_id, { mode: 'arbitrate', value: 'GK-482-RT' });
    expect(ok).toMatchObject({ status: 200, body: { ok: true, previousValue: null } });
    expect((await plaque(clio.id)).r).toBe('GK-482-RT');
    expect(JSON.parse((await plaque(clio.id)).kc!)).toMatchObject({ registrationNumber: 'GK-482-RT', registrationNumber__origin: 'USER' });
    expect((await cartes(clio.id)).find((c) => c.id === carte.id)).toMatchObject({ active: false, resolution_reason: 'USER_ARBITRATED' });

    // Annuler : la valeur précédente (vide) revient, la MÊME carte est rouverte.
    const undo = await r.resolve(carte.public_id, { mode: 'undo', previousValue: null });
    expect(undo.status).toBe(200);
    expect((await plaque(clio.id)).r).toBeNull();
    expect((await cartes(clio.id)).find((c) => c.id === carte.id)).toMatchObject({ active: true });

    // Valeur forgée (non proposée) : refus explicite, rien d'écrit.
    const forge = await r.resolve(carte.public_id, { mode: 'arbitrate', value: 'ZZ-999-ZZ' });
    expect(forge).toMatchObject({ status: 400, body: { error: 'INVALID_VALUE' } });
    expect(String(forge.body.message)).toMatch(/pas valide/);
  });

  it('L32-1 — carte historique sur un vélo (avant correctif) : retirée au clic, avec un message utile ; jamais appliquée', async () => {
    const compte = await make.account();
    session.userId = compte.ownerUserId; session.currentAccountId = compte.id;
    const velo = await make.asset(compte, { category: 'VEHICULE', name: 'Vélo Jean Fourche' });
    await sql`UPDATE assets SET subtype = 'Vélo' WHERE id = ${velo.id}`;
    const { upsertAction } = await import('@/services/to-process/to-process-action.service');
    await upsertAction({
      accountId: compte.id, targetType: 'ASSET', targetId: velo.id, fieldKey: 'registrationNumber', actionKind: 'ARBITRATE',
      ruleCode: 'DATA-REGISTRATION', proposals: [{ value: 'RK469970GP', label: 'RK469970GP', confidence: 0.6 }],
    });
    const [carte] = await cartes(velo.id);
    const r = await routes();
    const res = await r.resolve(carte.public_id, { mode: 'arbitrate', value: 'RK469970GP' });
    expect(res).toMatchObject({ status: 422, body: { error: 'FIELD_NOT_APPLICABLE', message: 'Cette information ne s’applique pas à ce bien : la carte a été retirée.' } });
    expect((await cartes(velo.id))[0]).toMatchObject({ active: false, resolution_reason: 'OBSOLETE' });
    expect((await plaque(velo.id)).r).toBeNull();
    const [ev] = await sql<{ details: { reason: string } }[]>`SELECT details FROM to_process_action_events WHERE action_id = ${carte.id}`;
    expect(ev.details.reason).toBe('FIELD_NOT_APPLICABLE');
    // Compteur = page : la carte retirée n'est plus comptée.
    expect(await r.pastille()).toBe((await r.page()).total);
  });

  it('L32-1 — migration 0270 (idempotente) et balayage horaire : cartes d’immatriculation sans objet fermées', async () => {
    const compte = await make.account();
    const velo = await make.asset(compte, { category: 'VEHICULE', name: 'VTT' });
    await sql`UPDATE assets SET subtype = 'vélo' WHERE id = ${velo.id}`;
    const moto = await make.asset(compte, { category: 'VEHICULE', name: 'Moto' });
    await sql`UPDATE assets SET subtype = 'Moto' WHERE id = ${moto.id}`;
    const { upsertAction } = await import('@/services/to-process/to-process-action.service');
    for (const b of [velo, moto]) {
      await upsertAction({ accountId: compte.id, targetType: 'ASSET', targetId: b.id, fieldKey: 'registrationNumber', actionKind: 'COMPLETE', ruleCode: 'DATA-REGISTRATION', proposals: [] });
    }
    const migration = readFileSync(join(process.cwd(), 'src/db/migrations/0270_to_process_registration_non_applicable.sql'), 'utf8');
    await sql.begin(async (t) => { await t.unsafe(migration); });
    await sql.begin(async (t) => { await t.unsafe(migration); }); // idempotente
    expect((await cartes(velo.id))[0]).toMatchObject({ active: false, resolution_reason: 'OBSOLETE' });
    expect((await cartes(moto.id))[0]).toMatchObject({ active: true });
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM to_process_action_events WHERE target_id = ${velo.id} AND details->>'migration' = '0270'`;
    expect(n).toBe(1);

    // Balayage : la catégorie change ensuite (moto → vélo) : la carte est fermée au passage suivant.
    await sql`UPDATE assets SET subtype = 'Vélo' WHERE id = ${moto.id}`;
    const { closeInapplicableAssetFieldActions } = await import('@/services/to-process/producers.service');
    expect(await closeInapplicableAssetFieldActions(compte.id)).toBe(1);
    expect((await cartes(moto.id))[0]).toMatchObject({ active: false, resolution_reason: 'OBSOLETE' });
    expect(await closeInapplicableAssetFieldActions(compte.id)).toBe(0);
  });

  // ── MASC2 / L32-6 ───────────────────────────────────────────────────────

  it('MASC2-AC10 / L32-6 — mascotte, page et pastille lisent la même file ; après résolution et création, tous à jour ensemble', async () => {
    const compte = await make.account();
    session.userId = compte.ownerUserId; session.currentAccountId = compte.id;
    const clio = await make.asset(compte, { category: 'VEHICULE', name: 'Clio', registrationNumber: 'AB-123-CD', keyCharacteristics: { registrationNumber: 'AB-123-CD', registrationNumber__origin: 'USER' } });
    await sql`UPDATE assets SET subtype = 'Voiture' WHERE id = ${clio.id}`;
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    await make.assetFile(compte, { assetId: maison.id });
    const { upsertAction } = await import('@/services/to-process/to-process-action.service');
    // Deux valeurs : OPEN_CHOICES ; une complétion : OPEN_TODO_CARD.
    await upsertAction({
      accountId: compte.id, targetType: 'ASSET', targetId: clio.id, fieldKey: 'registrationNumber', actionKind: 'ARBITRATE', ruleCode: 'DATA-REGISTRATION',
      proposals: [{ value: 'GK-482-RT', label: 'GK-482-RT', confidence: 0.6 }, { value: 'AB-123-CD', label: 'AB-123-CD', confidence: 1, isCurrentValue: true }],
    });
    await upsertAction({ accountId: compte.id, targetType: 'ASSET', targetId: maison.id, fieldKey: 'acquisitionPrice', actionKind: 'ARBITRATE', ruleCode: 'DATA-ACQUISITION-PRICE', proposals: [{ value: 320000, label: '320 000 €', confidence: 0.6 }] });
    // Lot 34 (MASC3) : la mascotte n'affiche que les DO_FIRST — les deux
    // actions du scénario le sont (la priorité vient sinon du catalogue).
    await sql`UPDATE to_process_actions SET priority = 'DO_FIRST' WHERE account_id = ${compte.id}`;

    const { getMascotPresentation } = await import('@/services/home/mascot/mascot.service');
    const r = await routes();
    const avant = await getMascotPresentation(compte.id, 'display');
    const pageAvant = await r.page();
    expect(avant.todo?.total).toBe(2);
    expect(await r.pastille()).toBe(2);
    expect(pageAvant.total).toBe(2);
    // Même source, même ordre, ciblage par ID.
    expect(avant.todo!.items.map((i) => i.todoId)).toEqual(pageAvant.actions.map((a) => a.publicId));
    const immat = avant.todo!.items.find((i) => i.todoType === 'DATA-REGISTRATION')!;
    expect(immat).toMatchObject({ actionType: 'OPEN_CHOICES', entityType: 'ASSET', entityId: clio.id, targetField: 'registrationNumber', assetId: clio.id, title: 'Numéro d’immatriculation à vérifier', subtitle: 'Clio' });
    expect(immat.availableChoices!.map((c) => c.value)).toEqual(['GK-482-RT', 'AB-123-CD']);
    // MASC2-AC09 : une seule proposition → la carte, pas de sélecteur.
    expect(avant.todo!.items.find((i) => i.todoType === 'DATA-ACQUISITION-PRICE')).toMatchObject({ actionType: 'OPEN_TODO_CARD' });

    // Résolution depuis la mascotte = même route que la file.
    expect((await r.resolve(immat.todoId, { mode: 'arbitrate', value: 'GK-482-RT' })).status).toBe(200);
    const apres = await getMascotPresentation(compte.id, 'display');
    expect(apres.todo!.items.map((i) => i.todoId)).not.toContain(immat.todoId);
    expect(apres.todo!.total).toBe(1);
    expect(await r.pastille()).toBe(1);
    expect((await r.page()).total).toBe(1);
    expect(apres.contextHash).not.toBe(avant.contextHash);

    // Création d'une action : les trois lectures la voient ensemble.
    await upsertAction({ accountId: compte.id, targetType: 'ASSET', targetId: clio.id, fieldKey: 'acquisitionPrice', actionKind: 'ARBITRATE', ruleCode: 'DATA-ACQUISITION-PRICE', proposals: [{ value: 18500, label: '18 500 €', confidence: 0.6 }] });
    const recree = await getMascotPresentation(compte.id, 'display');
    expect(recree.todo!.total).toBe(2); // total de la file (jamais affiché, MASC3)
    expect(recree.todo!.items.every((i) => i.priority === 'DO_FIRST')).toBe(true);
    expect(await r.pastille()).toBe(2);
    expect((await r.page()).total).toBe(2);
  });

  // ── PO6 ─────────────────────────────────────────────────────────────────

  it('PO6 — pré-génération durable : demande enregistrée, traitée une fois par la tâche, situation notée ; échéance du jour signalée', async () => {
    const compte = await make.account();
    const bien = await make.asset(compte, { category: 'VEHICULE', name: 'Cupra' });
    await make.assetFile(compte, { assetId: bien.id });
    const Q = await import('@/services/home/mascot/pregen-queue');
    await Q.requestMascotPregeneration(compte.id, 'TO_PROCESS_ITEM_UPDATED');
    await Q.requestMascotPregeneration(compte.id, 'DOCUMENT_ANALYSIS_COMPLETED'); // rafale : une seule ligne
    const lignes = await sql<{ reason: string; processed_at: Date | null }[]>`SELECT reason, processed_at FROM home_mascot_pregen_requests WHERE account_id = ${compte.id}`;
    expect(lignes).toEqual([{ reason: 'DOCUMENT_ANALYSIS_COMPLETED', processed_at: null }]);

    // Le délai de regroupement (3 s) est passé.
    await sql`UPDATE home_mascot_pregen_requests SET requested_at = now() - interval '10 seconds' WHERE account_id = ${compte.id}`;
    const r1 = await Q.runMascotPregeneration({ batch: 200 });
    expect(r1.claimed).toBeGreaterThanOrEqual(1);
    const [fait] = await sql<{ processed_at: Date | null; last_status: string; last_context_hash: string | null }[]>`
      SELECT processed_at, last_status, last_context_hash FROM home_mascot_pregen_requests WHERE account_id = ${compte.id}`;
    expect(fait.processed_at).not.toBeNull();
    expect(fait.last_context_hash).toMatch(/^[0-9a-f]{32}$/);
    // Rien de nouveau : rien à reprendre.
    expect(await Q.processMascotPregenerationFor(compte.id)).toBeNull();

    // Échéance arrivée à sa date : le compte est signalé par la tâche quotidienne.
    const today = (await import('@/services/home/mascot/collector')).todayParis();
    await sql`INSERT INTO agenda_items (account_id, title, start_date, home_category) VALUES (${compte.id}, 'Contrôle technique', ${today}, 'action')`;
    expect(await Q.enqueueDeadlineSituations(today, 60)).toBeGreaterThanOrEqual(1);
    const [d] = await sql<{ reason: string; pending: boolean }[]>`
      SELECT reason, (processed_at IS NULL OR requested_at > processed_at) AS pending FROM home_mascot_pregen_requests WHERE account_id = ${compte.id}`;
    expect(d).toEqual({ reason: 'deadline', pending: true });
  });
});
