/**
 * Lot 59, point 2 — vignette par défaut d'un bien sur PostgreSQL réel.
 *
 *  L59-2-E2E-01  bien sans vignette choisie : la première photo rattachée
 *                (colonne `asset_id`, `linked_asset_id` ou lien PRIMARY /
 *                SECONDARY actif) ; un bien seulement CITÉ n'en profite pas ;
 *  L59-2-E2E-02  jamais une image classée comme un autre document, ni un
 *                fichier supprimé, ignoré, brouillon, en cours d'envoi ou
 *                d'un AUTRE compte ;
 *  L59-2-E2E-03  accueil : `effectiveThumbnailUrl` = vignette choisie, sinon
 *                la photo ; aucune écriture en base (`assets.thumbnail_url`
 *                inchangé).
 */
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

scenario('L59-2-VIGNETTE', 'Vignette par défaut d’un bien : la première photo rattachée', ({ sql, make }) => {
  const image = async (accountId: number, owner: number, over: { assetId?: number | null; linked?: number | null; type?: string | null; mime?: string; deleted?: boolean; ignored?: boolean; draft?: boolean; status?: string; jour: number }) => {
    const [f] = await sql<{ id: number }[]>`
      INSERT INTO asset_files (user_id, account_id, asset_id, linked_asset_id, s3_key, mime_type, document_type_code,
                               upload_status, is_ignored, is_draft, deleted_at, uploaded_at)
      VALUES (${owner}, ${accountId}, ${over.assetId ?? null}, ${over.linked ?? null}, ${`e2e/${accountId}/photo-${over.jour}-${Math.random().toString(36).slice(2)}.jpg`},
              ${over.mime ?? 'image/jpeg'}, ${over.type === undefined ? 'PHOTO' : over.type}, ${over.status ?? 'COMPLETED'},
              ${over.ignored ?? false}, ${over.draft ?? false}, ${over.deleted ? new Date().toISOString() : null}::timestamptz,
              ${new Date(Date.UTC(2026, 0, over.jour + 1)).toISOString()}::timestamptz)
      RETURNING id`;
    return f.id;
  };

  it('L59-2-E2E-01 / 02 — règle de choix et isolation des comptes', async () => {
    const { loadDefaultAssetPhotos } = await import('@/services/assets/default-asset-photo');
    const A = await make.account();
    const B = await make.account();
    const maison = await make.asset(A, { category: 'LOGEMENT', name: 'Maison' });
    const voiture = await make.asset(A, { name: 'Voiture' });
    const velo = await make.asset(A, { name: 'Vélo' });
    const cite = await make.asset(A, { name: 'Cité seulement' });
    const vide = await make.asset(A, { name: 'Sans photo' });

    // Maison : écartées (facture scannée, supprimée, ignorée, brouillon, envoi en cours, HEIC), puis deux photos.
    await image(A.id, A.ownerUserId, { assetId: maison.id, type: 'INVOICE', jour: 1 });
    await image(A.id, A.ownerUserId, { assetId: maison.id, deleted: true, jour: 2 });
    await image(A.id, A.ownerUserId, { assetId: maison.id, ignored: true, jour: 3 });
    await image(A.id, A.ownerUserId, { assetId: maison.id, draft: true, jour: 4 });
    await image(A.id, A.ownerUserId, { assetId: maison.id, status: 'PENDING', jour: 5 });
    await image(A.id, A.ownerUserId, { assetId: maison.id, mime: 'image/heic', jour: 6 });
    const premiere = await image(A.id, A.ownerUserId, { assetId: maison.id, jour: 7 });
    await image(A.id, A.ownerUserId, { assetId: maison.id, jour: 8 });
    // Voiture : par la colonne `linked_asset_id` ; vélo : lien N-N SECONDARY ; « cité » : MENTIONED seulement.
    const liee = await image(A.id, A.ownerUserId, { assetId: maison.id, linked: voiture.id, jour: 9 });
    const nn = await image(A.id, A.ownerUserId, { assetId: null, jour: 10 });
    await sql`INSERT INTO document_asset_links (account_id, file_id, asset_id, link_role, origin, status)
              VALUES (${A.id}, ${nn}, ${velo.id}, 'SECONDARY', 'USER', 'ACTIVE'),
                     (${A.id}, ${nn}, ${cite.id}, 'MENTIONED', 'AI', 'ACTIVE')`;
    // Compte B : une photo plus ancienne ne doit jamais remonter chez A.
    await image(B.id, B.ownerUserId, { assetId: null, jour: 0 });

    const m = await loadDefaultAssetPhotos(A.id, [maison.id, voiture.id, velo.id, cite.id, vide.id]);
    expect(m.get(maison.id)?.fileId).toBe(premiere);
    expect(m.get(voiture.id)?.fileId).toBe(liee);
    expect(m.get(velo.id)?.fileId).toBe(nn);
    expect(m.has(cite.id)).toBe(false);
    expect(m.has(vide.id)).toBe(false);
    // Biens de A demandés au nom de B : rien.
    expect((await loadDefaultAssetPhotos(B.id, [maison.id, voiture.id])).size).toBe(0);
  });

  it('L59-2-E2E-03 — accueil : vignette choisie prioritaire, sinon la photo ; aucune écriture', async () => {
    const { buildHomeSummary } = await import('@/services/home/HomeSummaryService');
    const A = await make.account();
    const avecPhoto = await make.asset(A, { name: 'Avec photo' });
    const choisie = await make.asset(A, { name: 'Vignette choisie' });
    const sans = await make.asset(A, { name: 'Sans rien' });
    await sql`UPDATE assets SET thumbnail_url = 'verebona/choisie.webp' WHERE id = ${choisie.id}`;
    const photo = await image(A.id, A.ownerUserId, { assetId: avecPhoto.id, jour: 1 });
    await image(A.id, A.ownerUserId, { assetId: choisie.id, jour: 1 });
    const [{ s3_key: cle }] = await sql<{ s3_key: string }[]>`SELECT s3_key FROM asset_files WHERE id = ${photo}`;

    const s = await buildHomeSummary(A.id);
    const par = new Map(s.assets.items.map((a) => [a.id, a]));
    expect(par.get(avecPhoto.id)?.effectiveThumbnailUrl).toBe(cle);
    expect(par.get(avecPhoto.id)?.thumbnailUrl).toBeNull();
    expect(par.get(choisie.id)?.effectiveThumbnailUrl).toBe('verebona/choisie.webp');
    expect(par.get(sans.id)?.effectiveThumbnailUrl).toBeNull();
    const [{ thumbnail_url }] = await sql<{ thumbnail_url: string | null }[]>`SELECT thumbnail_url FROM assets WHERE id = ${avecPhoto.id}`;
    expect(thumbnail_url).toBeNull();
  });
});
