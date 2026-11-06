/**
 * Lot 113A (#692, régression P1) — « À traiter » : la carte « À quel bien
 * rattacher ce document ? » propose directement les biens du compte, sur
 * PostgreSQL réel (file réelle `getToProcessPage`, routes réelles, session
 * simulée).
 *
 *   L113A-E2E-01 carte SANS candidat (COMPLETE, cas observé : garantie Electro
 *                DEMO) : biens éligibles en choix nommés — archivé, verrouillé,
 *                supprimé et bien d'un autre compte exclus ; ordre par nom.
 *   L113A-E2E-02 carte AVEC candidats de l'analyse (ARBITRATE) : candidats
 *                d'abord (en évidence), puis les autres biens éligibles.
 *   L113A-E2E-03 clic sur un bien (route `/resolve`, mode `arbitrate`) : le
 *                document est rattaché à CE bien, carte résolue, compteur
 *                diminué, trace d'historique ; second clic : refus
 *                ALREADY_RESOLVED, aucun doublon (ni trace ni écriture).
 *   L113A-E2E-04 droits : bien archivé, verrouillé ou d'un autre compte
 *                refusé (INVALID_VALUE), rien écrit, carte toujours ouverte ;
 *                session d'un autre compte : carte introuvable.
 *   L113A-E2E-05 consultation (vignette / « Voir le document » : route de
 *                revalidation des liens) : aucun rattachement, carte intacte.
 *   L113A-E2E-06 aucun bien éligible : état EMPTY (aucun bouton) ; « Annuler »
 *                rouvre la MÊME carte.
 *   L113A-E2E-07 non-régression : les autres familles de cartes (conflit de
 *                rattachement, donnée documentaire) ne reçoivent aucun choix
 *                de bien ; sans `withAssetChoices` (accueil, mascotte) rien ne
 *                change.
 */
import { expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';

const etat = vi.hoisted(() => ({ session: { userId: 0, currentAccountId: 0 as number | null } }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: etat.session.userId, currentAccountId: etat.session.currentAccountId }),
    handleSessionError: (e: unknown) => { throw e; },
  },
}));

scenario('L113A-RATTACHEMENT', 'À traiter : boutons des biens pour rattacher un document', ({ sql, make }) => {
  type Compte = Awaited<ReturnType<typeof make.account>>;

  const svc = () => import('@/services/to-process/to-process-query.service');
  const page = async (compte: Compte, withAssetChoices = true) => (await svc()).getToProcessPage(compte.id, { withLinks: true, withAssetChoices });
  const carte = async (compte: Compte, publicId: string) => (await page(compte)).actions.find((a) => a.publicId === publicId);

  const document = async (compte: Compte, titre: string) => {
    const f = await make.assetFile(compte, { assetId: null });
    await sql`UPDATE asset_files SET retained_title = ${titre}, document_type_code = 'WARRANTY_CERTIFICATE', upload_status = 'COMPLETED' WHERE id = ${f.id}`;
    return f.id;
  };
  /** Carte LINK-ASSET par le producteur canonique (même chemin que T3). */
  const carteRattachement = async (compte: Compte, fileId: number, proposals: Array<{ value: number; label: string; confidence: number }> = []) => {
    const { upsertAction } = await import('@/services/to-process/to-process-action.service');
    const r = await upsertAction({
      accountId: compte.id, targetType: 'DOCUMENT', targetId: fileId, relationKey: 'assetIds',
      actionKind: proposals.length ? 'ARBITRATE' : 'COMPLETE', ruleCode: 'LINK-ASSET', proposals,
      triggerContext: { current: '', producer: 'T3_DOCUMENT_ASSET' },
    });
    expect(r.status).toBe('CREATED');
    const [row] = await sql<{ public_id: string }[]>`
      SELECT public_id::text FROM to_process_actions WHERE account_id = ${compte.id} AND target_id = ${fileId}
         AND rule_code = 'LINK-ASSET' AND resolved_at IS NULL`;
    return row.public_id;
  };
  const resoudre = async (compte: Compte, publicId: string, body: Record<string, unknown>) => {
    etat.session = { userId: compte.ownerUserId, currentAccountId: compte.id };
    const { POST } = await import('@/app/api/v2/to-process/[publicId]/resolve/route');
    const res = await POST(new NextRequest(`http://localhost/api/v2/to-process/${publicId}/resolve`, {
      method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
    }), { params: Promise.resolve({ publicId }) });
    return { status: res.status, body: (await res.json()) as { ok?: boolean; code?: string; previousValue?: unknown } };
  };
  const rattachement = async (fileId: number) => (await sql<{ asset_id: number | null; edited: Record<string, unknown> | null }[]>`
    SELECT asset_id, user_edited_fields AS edited FROM asset_files WHERE id = ${fileId}`)[0];
  const traces = async (publicId: string) => (await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM to_process_action_events e JOIN to_process_actions a ON a.id = e.action_id
     WHERE a.public_id::text = ${publicId} AND e.event = 'RESOLVED_ARBITRATION'`)[0].n;
  const ouverte = async (publicId: string) => (await sql<{ open: boolean }[]>`
    SELECT resolved_at IS NULL AS open FROM to_process_actions WHERE public_id::text = ${publicId}`)[0].open;

  /** Compte type : 3 biens éligibles, 1 archivé, 1 verrouillé, 1 supprimé. */
  const compteType = async () => {
    const compte = await make.account();
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const appart = await make.asset(compte, { category: 'IMMOBILIER', name: 'Appartement Lyon' });
    const auto = await make.asset(compte, { category: 'VEHICULE', name: 'Peugeot 3008' });
    const archive = await make.asset(compte, { category: 'IMMOBILIER', name: 'Ancien studio' });
    const verrou = await make.asset(compte, { category: 'VEHICULE', name: 'Clio verrouillée' });
    const supprime = await make.asset(compte, { category: 'OBJET', name: 'Vélo supprimé' });
    await sql`UPDATE assets SET status = 'ARCHIVED' WHERE id = ${archive.id}`;
    await sql`UPDATE assets SET lock_state = 'SOFT' WHERE id = ${verrou.id}`;
    await sql`UPDATE assets SET deleted_at = now() WHERE id = ${supprime.id}`;
    return { compte, maison, appart, auto, archive, verrou, supprime };
  };

  it('L113A-E2E-01 — carte sans candidat : biens éligibles en choix nommés (archivé, verrouillé, supprimé, autre compte exclus)', async () => {
    const t = await compteType();
    const autre = await make.account();
    await make.asset(autre, { category: 'IMMOBILIER', name: 'Maison du voisin' });
    const doc = await document(t.compte, 'Certificat de garantie Electro DEMO — Lave-linge Bosch');
    const id = await carteRattachement(t.compte, doc);
    const c = await carte(t.compte, id);
    expect(c, 'carte publiée').toBeTruthy();
    expect(c!.actionKind).toBe('COMPLETE');
    expect(c!.assetChoices?.status).toBe('OK');
    expect(c!.assetChoices!.items).toEqual([
      { assetId: t.appart.id, label: 'Appartement Lyon', suggested: false },
      { assetId: t.maison.id, label: 'Maison', suggested: false },
      { assetId: t.auto.id, label: 'Peugeot 3008', suggested: false },
    ]);
    // « Voir le document » reste disponible (lien de consultation de l'objet).
    expect(c!.links?.object).toMatchObject({ kind: 'document', id: doc });
  }, 120_000);

  it('L113A-E2E-02 — carte avec candidats : candidats de l’analyse d’abord, puis les autres biens', async () => {
    const t = await compteType();
    const doc = await document(t.compte, 'Facture Electro DEMO lave-vaisselle');
    const id = await carteRattachement(t.compte, doc, [
      { value: t.auto.id, label: 'Peugeot 3008', confidence: 0.4 },
      { value: t.maison.id, label: 'Maison', confidence: 0.7 },
    ]);
    const c = await carte(t.compte, id);
    expect(c!.actionKind).toBe('ARBITRATE');
    expect(c!.assetChoices!.items.map((i) => [i.assetId, i.suggested])).toEqual([
      [t.maison.id, true], [t.auto.id, true], [t.appart.id, false],
    ]);
    // Candidat devenu inéligible (archivé) : jamais proposé. La carte ne
    // conserve que les deux meilleurs candidats (`selectDisplayedProposals`) :
    // l'archivé (0,8) et Maison (0,7) ; Peugeot redevient un bien « autre ».
    const doc2 = await document(t.compte, 'Facture Electro DEMO sèche-linge');
    const id2 = await carteRattachement(t.compte, doc2, [
      { value: t.auto.id, label: 'Peugeot 3008', confidence: 0.4 },
      { value: t.maison.id, label: 'Maison', confidence: 0.7 },
      { value: t.archive.id, label: 'Ancien studio', confidence: 0.8 },
    ]);
    expect((await carte(t.compte, id2))!.assetChoices!.items.map((i) => [i.assetId, i.suggested])).toEqual([
      [t.maison.id, true], [t.appart.id, false], [t.auto.id, false],
    ]);
  }, 120_000);

  it('L113A-E2E-03 — clic sur un bien : rattachement canonique, carte résolue, compteur, historique ; second clic sans doublon', async () => {
    const t = await compteType();
    const doc = await document(t.compte, 'Certificat de garantie Bosch');
    const autreDoc = await document(t.compte, 'Notice Bosch');
    const id = await carteRattachement(t.compte, doc);
    await carteRattachement(t.compte, autreDoc);
    const avant = (await page(t.compte)).total;

    const r = await resoudre(t.compte, id, { mode: 'arbitrate', value: t.maison.id });
    expect(r).toMatchObject({ status: 200, body: { ok: true } });
    const lien = await rattachement(doc);
    expect(lien.asset_id).toBe(t.maison.id);
    expect(lien.edited?.assetId).toBe(true);
    expect(await ouverte(id)).toBe(false);
    expect(await traces(id)).toBe(1);
    const apres = await page(t.compte);
    expect(apres.total).toBe(avant - 1);
    expect(apres.actions.some((a) => a.publicId === id)).toBe(false);
    // L'autre document n'est pas touché.
    expect((await rattachement(autreDoc)).asset_id).toBeNull();

    // Double clic / seconde requête : refus, aucune trace ni écriture en plus.
    const bis = await resoudre(t.compte, id, { mode: 'arbitrate', value: t.appart.id });
    expect(bis).toMatchObject({ status: 409, body: { code: 'ALREADY_RESOLVED' } });
    expect((await rattachement(doc)).asset_id).toBe(t.maison.id);
    expect(await traces(id)).toBe(1);
  }, 120_000);

  it('L113A-E2E-04 — droits : bien archivé, verrouillé ou d’un autre compte refusé ; autre session : carte introuvable', async () => {
    const t = await compteType();
    const autre = await make.account();
    const etranger = await make.asset(autre, { category: 'IMMOBILIER', name: 'Maison du voisin' });
    const doc = await document(t.compte, 'Garantie sans bien');
    const id = await carteRattachement(t.compte, doc);
    for (const refuse of [t.archive.id, t.verrou.id, t.supprime.id, etranger.id]) {
      const r = await resoudre(t.compte, id, { mode: 'arbitrate', value: refuse });
      expect(r, `bien ${refuse}`).toMatchObject({ status: 400, body: { code: 'INVALID_VALUE' } });
    }
    expect((await rattachement(doc)).asset_id).toBeNull();
    expect(await ouverte(id)).toBe(true);
    expect(await traces(id)).toBe(0);
    // Session d'un autre compte : la carte n'existe pas pour lui.
    const intrus = await resoudre(autre, id, { mode: 'arbitrate', value: etranger.id });
    expect(intrus).toMatchObject({ status: 404, body: { code: 'NOT_FOUND' } });
    expect((await rattachement(doc)).asset_id).toBeNull();
  }, 120_000);

  it('L113A-E2E-05 — consultation du document (vignette, « Voir le document ») : aucun rattachement', async () => {
    const t = await compteType();
    const doc = await document(t.compte, 'Garantie à consulter');
    const id = await carteRattachement(t.compte, doc, [{ value: t.maison.id, label: 'Maison', confidence: 0.6 }]);
    etat.session = { userId: t.compte.ownerUserId, currentAccountId: t.compte.id };
    const { POST } = await import('@/app/api/v2/to-process/[publicId]/links/route');
    const res = await POST(new NextRequest(`http://localhost/api/v2/to-process/${id}/links`, {
      method: 'POST', body: JSON.stringify({ target: { kind: 'document', id: doc } }), headers: { 'content-type': 'application/json' },
    }), { params: Promise.resolve({ publicId: id }) });
    expect(((await res.json()) as { status?: string }).status).toBe('ok');
    expect((await rattachement(doc)).asset_id).toBeNull();
    expect(await ouverte(id)).toBe(true);
    expect(await traces(id)).toBe(0);
    expect((await carte(t.compte, id))?.assetChoices?.status).toBe('OK');
  }, 120_000);

  it('L113A-E2E-06 — aucun bien éligible : état EMPTY ; « Annuler » rouvre la même carte', async () => {
    const compte = await make.account();
    const archive = await make.asset(compte, { category: 'IMMOBILIER', name: 'Seul bien archivé' });
    await sql`UPDATE assets SET status = 'ARCHIVED' WHERE id = ${archive.id}`;
    const doc = await document(compte, 'Garantie orpheline');
    const id = await carteRattachement(compte, doc);
    expect((await carte(compte, id))?.assetChoices).toEqual({ status: 'EMPTY', items: [] });

    // Un bien éligible apparaît : choix proposé, rattachement, puis annulation.
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    expect((await carte(compte, id))?.assetChoices?.items.map((i) => i.assetId)).toEqual([maison.id]);
    const r = await resoudre(compte, id, { mode: 'arbitrate', value: maison.id });
    expect(r.body.ok).toBe(true);
    const u = await resoudre(compte, id, { mode: 'undo', previousValue: r.body.previousValue ?? null });
    expect(u.body.ok).toBe(true);
    expect(await ouverte(id)).toBe(true);
    expect((await rattachement(doc)).asset_id).toBeNull();
    const [n] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM to_process_actions WHERE account_id = ${compte.id} AND rule_code = 'LINK-ASSET'`;
    expect(n.n).toBe(1);
  }, 120_000);

  it('L113A-E2E-07 — non-régression : autres familles sans choix de bien ; sans option, file inchangée', async () => {
    const t = await compteType();
    const doc = await document(t.compte, 'Contrat sans date de fin');
    const lie = await document(t.compte, 'Facture rattachée');
    await sql`UPDATE asset_files SET asset_id = ${t.maison.id} WHERE id = ${lie}`;
    const { upsertAction } = await import('@/services/to-process/to-process-action.service');
    await upsertAction({
      accountId: t.compte.id, targetType: 'DOCUMENT', targetId: doc, fieldKey: 'warrantyEndDate',
      actionKind: 'COMPLETE', ruleCode: 'DATA-WARRANTY-END', proposals: [],
    });
    await upsertAction({
      accountId: t.compte.id, targetType: 'DOCUMENT', targetId: lie, relationKey: 'assetConflict',
      actionKind: 'ARBITRATE', ruleCode: 'LINK-ASSET-CONFLICT',
      proposals: [{ value: `MOVE:${t.appart.id}`, label: 'Rattacher à Appartement Lyon', confidence: 0.9 }],
      triggerContext: { currentAssetId: t.maison.id, suggestedAssetId: t.appart.id },
    });
    const idLink = await carteRattachement(t.compte, await document(t.compte, 'Garantie à rattacher'));
    const p = await page(t.compte);
    for (const a of p.actions) {
      if (a.publicId === idLink) expect(a.assetChoices?.status).toBe('OK');
      else expect(a.assetChoices, a.ruleCode).toBeUndefined();
    }
    // Accueil / mascotte : aucune lecture supplémentaire, vue inchangée.
    const sans = await page(t.compte, false);
    expect(sans.actions.every((a) => a.assetChoices === undefined)).toBe(true);
    expect(sans.total).toBe(p.total);
  }, 120_000);
});
