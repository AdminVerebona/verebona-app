/**
 * Lot 34 (34H2) — base réelle.
 *
 * Point 6 « Préparation des dossiers » (ex-« Informations complémentaires ») :
 *   DOSS-08 : un compte Standard qui appelle DIRECTEMENT l'API d'écriture
 *             reçoit 403 `PREMIUM_REQUIRED` et rien n'est modifié ;
 *   DOSS-09 : Premium, Premium Duo et essai écrivent (droit fonctionnel, pas
 *             le nom de l'offre) ;
 *   DOSS-10 : downgrade Premium → Standard : données conservées, lisibles,
 *             plus modifiables ;
 *   DOSS-11 : upgrade Standard → Premium : écriture rendue immédiatement,
 *             anciennes données présentes ;
 *   DOSS-12 : la source des dossiers lit toujours les mêmes informations.
 *
 * Point 11 « À traiter », vue Cartes :
 *   L34-11-1 : vignette du document dans la réponse de la file (URL signée,
 *              mêmes vignettes que l'accueil), une signature par dérivé et par
 *              heure ; sans miniature : pas d'URL et génération demandée ;
 *   L34-11-2 : sans `withThumbnails` (pastille, mascotte), aucune vignette.
 */
import { beforeAll, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';

const session = vi.hoisted(() => ({ currentAccountId: 0, userId: 0 }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    handleSessionError: () => new Response(null, { status: 401 }),
  },
}));
vi.mock('@/services/verebona-assistant/events/business-events', () => ({
  emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));
const misesEnFile = vi.hoisted(() => [] as number[]);
vi.mock('@/services/documents/thumbnails/thumbnail.service', async (o) => ({
  ...(await o<object>()),
  enqueueThumbnail: (id: number) => { misesEnFile.push(id); return true; },
}));

scenario('L34H2', 'Préparation des dossiers (droit Dossiers) et vignettes de « À traiter »', ({ sql, make }) => {
  beforeAll(() => {
    process.env.OVH_S3_ACCESS_KEY_ID ??= 'e2e';
    process.env.OVH_S3_SECRET_ACCESS_KEY ??= 'e2e';
    process.env.OVH_S3_BUCKET ??= 'e2e-bucket';
    process.env.OVH_S3_ENDPOINT ??= 'http://127.0.0.1:9';
  });

  async function routes() {
    return import('@/app/api/assets/[id]/additional-infos/route');
  }
  function as(c: { id: number; ownerUserId: number }) {
    session.currentAccountId = c.id;
    session.userId = c.ownerUserId;
  }
  async function patch(assetId: number, body: unknown) {
    const { PATCH } = await routes();
    return PATCH(new NextRequest(`http://x/api/assets/${assetId}/additional-infos`, {
      method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
    }), { params: Promise.resolve({ id: String(assetId) }) });
  }
  async function get(assetId: number) {
    const { GET } = await routes();
    const res = await GET(new NextRequest(`http://x/api/assets/${assetId}/additional-infos`), { params: Promise.resolve({ id: String(assetId) }) });
    return { status: res.status, body: await res.json() as { commercial: Record<string, unknown> | null; version: number } };
  }
  const ligne = async (assetId: number) =>
    (await sql<{ commercial: Record<string, unknown> | null; version: number }[]>`
      SELECT commercial_json AS commercial, version FROM asset_additional_infos WHERE asset_id = ${assetId}`)[0] ?? null;

  it('DOSS-08 — Standard : appel API direct refusé (403 PREMIUM_REQUIRED), aucune donnée créée ni modifiée', async () => {
    const c = await make.account({ plan: 'standard' });
    const bien = await make.asset(c, { category: 'VEHICULE' });
    as(c);
    const res = await patch(bien.id, { commercial: { desiredSalePriceCents: 1_200_000 } });
    expect(res.status).toBe(403);
    const corps = await res.json();
    expect(corps.code).toBe('PREMIUM_REQUIRED');
    expect(corps.message).toMatch(/Premium et Premium Duo/);
    expect(await ligne(bien.id)).toBeNull();
    // Corps invalide : le refus de droit passe AVANT la lecture du corps.
    const { PATCH } = await routes();
    const brut = await PATCH(new NextRequest(`http://x/api/assets/${bien.id}/additional-infos`, { method: 'PATCH', body: '{pas du json' }), { params: Promise.resolve({ id: String(bien.id) }) });
    expect(brut.status).toBe(403);
    // La lecture reste ouverte (tiroir visible, données consultables).
    expect((await get(bien.id)).status).toBe(200);
  });

  it('DOSS-09 — Premium, Premium Duo et essai écrivent (droit fonctionnel, pas le nom de l’offre)', async () => {
    for (const plan of ['premium', 'premium_duo'] as const) {
      const c = await make.account({ plan });
      const bien = await make.asset(c, { category: 'VEHICULE' });
      as(c);
      const res = await patch(bien.id, { commercial: { desiredSalePriceCents: 900_000 } });
      expect(res.status, plan).toBe(200);
      expect((await ligne(bien.id))?.commercial?.desiredSalePriceCents).toBe(900_000);
    }
    const essai = await make.account();
    await sql`INSERT INTO account_subscriptions (account_id, plan_code, status, trial_ends_at)
              VALUES (${essai.id}, 'premium', 'trialing', now() + interval '10 days')`;
    const bien = await make.asset(essai, { category: 'VEHICULE' });
    as(essai);
    expect((await patch(bien.id, { commercial: { salePitch: 'Très bon état' } })).status).toBe(200);
  });

  it('DOSS-10 / DOSS-11 / DOSS-12 — downgrade : données conservées, écriture refusée ; upgrade : écriture immédiate', async () => {
    const c = await make.account({ plan: 'premium' });
    const bien = await make.asset(c, { category: 'VEHICULE' });
    as(c);
    expect((await patch(bien.id, { commercial: { desiredSalePriceCents: 1_500_000, salePitch: 'Première main' } })).status).toBe(200);
    const avant = await ligne(bien.id);

    // Downgrade (même mécanique que le changement d'offre : plan de l'abonnement).
    await sql`UPDATE account_subscriptions SET plan_code = 'standard' WHERE account_id = ${c.id}`;
    const lu = await get(bien.id);
    expect(lu.status).toBe(200);
    expect(lu.body.commercial).toMatchObject({ desiredSalePriceCents: 1_500_000, salePitch: 'Première main' });
    const refus = await patch(bien.id, { commercial: { desiredSalePriceCents: null, salePitch: null } });
    expect(refus.status).toBe(403);
    expect(await ligne(bien.id)).toEqual(avant);

    // DOSS-12 : la source des dossiers lit toujours ces informations (mapping inchangé).
    const { loadExportSource } = await import('@/services/exports/v12/data/source');
    const source = await loadExportSource({ assetId: bien.id, accountId: c.id, userId: c.ownerUserId, exportType: 'DOSSIER_COMPLET' });
    expect(JSON.stringify(source.additionalInfo)).toContain('1500000');
    expect(JSON.stringify(source.additionalInfo)).toContain('Première main');

    // Upgrade : droits relus à chaque requête — écriture rendue sans délai ni migration.
    await sql`UPDATE account_subscriptions SET plan_code = 'premium' WHERE account_id = ${c.id}`;
    const ok = await patch(bien.id, { commercial: { availabilityComment: 'Remise en main propre' } });
    expect(ok.status).toBe(200);
    const apres = await ligne(bien.id);
    expect(apres?.commercial).toMatchObject({ desiredSalePriceCents: 1_500_000, salePitch: 'Première main', availabilityComment: 'Remise en main propre' });
  });

  it('L34-11-1 / L34-11-2 — « À traiter » : vignette signée dans la réponse de la file, une signature par dérivé et par heure', async () => {
    const c = await make.account({ plan: 'premium' });
    const bien = await make.asset(c, { category: 'VEHICULE', name: 'Cupra' });
    const image = await make.assetFile(c, { assetId: bien.id, name: 'facture.png', mimeType: 'image/png' });
    const pdf = await make.assetFile(c, { assetId: bien.id, name: 'contrat.pdf' });
    await sql`UPDATE asset_files SET upload_status = 'COMPLETED' WHERE account_id = ${c.id}`;
    const evt = await make.agendaItem(c, { title: 'Contrôle technique', assetIds: [bien.id] });
    for (const [type, id, key] of [['DOCUMENT', image.id, 'endDate'], ['DOCUMENT', pdf.id, 'endDate'], ['AGENDA_ITEM', evt.id, 'status']] as const) {
      await sql`INSERT INTO to_process_actions (account_id, target_type, target_id, field_key, action_kind, rule_code, question)
                VALUES (${c.id}, ${type}, ${id}, ${key}, 'COMPLETE', 'DATA-ACQUISITION-PRICE', 'Question ?')`;
    }
    const png = await sharp({ create: { width: 800, height: 1100, channels: 3, background: '#ffffff' } }).png().toBuffer();
    const { generateThumbnail } = await import('@/services/documents/thumbnails/thumbnail.service');
    expect(await generateThumbnail(image.id, {
      readObject: async () => png,
      putObject: async () => undefined,
      deleteObject: async () => undefined,
      renderPdf: async () => { throw new Error('non utilisé'); },
    })).toBe('READY');

    const { resetThumbnailUrlMemo, thumbnailUrlStats } = await import('@/services/documents/thumbnails/thumbnail-url');
    resetThumbnailUrlMemo();
    misesEnFile.length = 0;
    as(c);
    const { GET } = await import('@/app/api/v2/to-process/route');
    const lire = async () => (await (await GET(new NextRequest('http://x/api/v2/to-process?order=priority'))).json()) as {
      actions: Array<{ targetType: string; targetId: number; target: { thumbnailUrl?: string | null } }>;
    };
    const page = await lire();
    const deImage = page.actions.find((a) => a.targetType === 'DOCUMENT' && a.targetId === image.id)!;
    const dePdf = page.actions.find((a) => a.targetType === 'DOCUMENT' && a.targetId === pdf.id)!;
    const deEvt = page.actions.find((a) => a.targetType === 'AGENDA_ITEM')!;
    expect(deImage.target.thumbnailUrl).toMatch(/derivatives\/thumbnails\/.*X-Amz-Signature=/);
    expect(dePdf.target.thumbnailUrl).toBeNull();
    expect(deEvt.target.thumbnailUrl ?? null).toBeNull();
    // PDF sans miniature : génération demandée (rattrapage), comme l'accueil.
    expect(misesEnFile).toContain(pdf.id);
    expect(misesEnFile).not.toContain(image.id);
    // Lectures suivantes : même URL (cache navigateur), aucune nouvelle signature.
    for (let i = 0; i < 3; i++) {
      const encore = await lire();
      expect(encore.actions.find((a) => a.targetId === image.id && a.targetType === 'DOCUMENT')!.target.thumbnailUrl).toBe(deImage.target.thumbnailUrl);
    }
    expect(thumbnailUrlStats().signed).toBe(1);

    // L34-11-2 : pastille, accueil, mascotte — sans vignette.
    const { getToProcessPage } = await import('@/services/to-process/to-process-query.service');
    const sans = await getToProcessPage(c.id);
    expect(sans.actions.every((a) => !('thumbnailUrl' in a.target))).toBe(true);
  });
});
