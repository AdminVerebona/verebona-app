/**
 * Lot 75L — BUG P1 « Téléchargement des documents : utiliser le nom affiché
 * dans Verebona » — sur base PostgreSQL réelle.
 *
 *   · `/api/files/[id]/download` (bibliothèque, fiches bien / équipement /
 *     pièce, tiroir) : nom affiché + extension réelle, dans la réponse JSON ET
 *     dans l'en-tête `response-content-disposition` de l'URL signée ;
 *   · `/api/files/[id]/view` (aperçu, « ouvrir ») : même nom, en `inline` ;
 *   · renommage par l'écran (PUT /api/documents/[id]) répercuté au
 *     téléchargement suivant, sans toucher à la clé ni au nom d'origine ;
 *   · document historique (sans titre), titre technique, image, accents ;
 *   · export « Mes données » : collecte réelle → noms affichés, doublons (2).
 */
import { beforeAll, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import type { AccountRow } from '../factories';

vi.hoisted(() => {
  process.env.OVH_S3_ACCESS_KEY_ID ??= 'e2e';
  process.env.OVH_S3_SECRET_ACCESS_KEY ??= 'e2e';
  process.env.OVH_S3_BUCKET ??= 'e2e-bucket';
  process.env.OVH_S3_ENDPOINT ??= 'http://127.0.0.1:9';
});
const session = vi.hoisted(() => ({ userId: 0, currentAccountId: 0 as number | null }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    requireAdmin: async () => session.userId,
    tryGetSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    handleSessionError: (e: unknown) => { throw e; },
    assertOwnership: () => undefined,
  },
}));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));
vi.mock('@/lib/asset-quota-guard', () => ({ assetModificationDecision: async () => ({ allowed: true }) }));

const req = (url: string, init?: { method?: string; body?: unknown }) => new NextRequest(`http://localhost${url}`, {
  method: init?.method ?? 'GET',
  ...(init?.body !== undefined ? { body: JSON.stringify(init.body), headers: { 'content-type': 'application/json' } } : {}),
});
const ctx = (v: number) => ({ params: Promise.resolve({ id: String(v) }) });

/** Content-Disposition porté par l'URL signée (paramètre S3 `response-content-disposition`). */
const dispositionOf = (url: string) => new URL(url).searchParams.get('response-content-disposition') ?? '';
const utf8Name = (cd: string) => decodeURIComponent(/filename\*=UTF-8''([^;]+)/.exec(cd)?.[1] ?? '');
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

scenario('L75L', 'Téléchargement : nom affiché dans Verebona, partout', ({ sql, make }) => {
  let acc: AccountRow;
  const ids: Record<string, number> = {};

  async function fichier(nom: string, cols: { original: string | null; titre: string | null; mime?: string; assetId?: number | null; equipmentId?: number | null }) {
    const f = await make.assetFile(acc, { assetId: cols.assetId ?? null, mimeType: cols.mime ?? 'application/pdf' });
    const cle = `verebona/u_${acc.ownerUserId}/a7f82c91-4d23-4b1e-9c55-${String(f.id).padStart(12, '0')}.${(cols.original ?? 'x.pdf').split('.').pop()}`;
    await sql`UPDATE asset_files SET s3_bucket = 'e2e-bucket', s3_key = ${cle}, filename = ${cle.split('/').pop()!},
                original_filename = ${cols.original}, retained_title = ${cols.titre}, equipment_id = ${cols.equipmentId ?? null},
                upload_status = 'COMPLETED', document_type = 'FACTURE', size = 10 WHERE id = ${f.id}`;
    ids[nom] = f.id;
  }

  beforeAll(async () => {
    acc = await make.account({ plan: 'premium' });
    const bien = await make.asset(acc, { category: 'IMMOBILIER', name: 'Maison L75L' });
    const [equip] = await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name) VALUES (${bien.id}, 'Chaudière') RETURNING id`;
    // Associé SIMULTANÉMENT au bien et à l'équipement.
    await fichier('facture', { original: 'FACT_2026_001.pdf', titre: 'Facture entretien chaudière', assetId: bien.id, equipmentId: equip.id });
    await fichier('historique', { original: 'Bail signé.pdf', titre: null, assetId: bien.id });
    await fichier('technique', { original: 'Assurance habitation.pdf', titre: 'a7f82c91-4d23-4b1e-9c55-0d2f3e4a5b6c', assetId: bien.id });
    await fichier('image', { original: 'IMG_1234.JPEG', titre: 'Photo façade', mime: 'image/jpeg', assetId: bien.id });
    await fichier('bureautique', { original: 'devis', titre: 'Devis', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', assetId: bien.id });
    await fichier('doublon', { original: 'autre.pdf', titre: 'Facture entretien chaudière', assetId: bien.id });
    session.userId = acc.ownerUserId;
    session.currentAccountId = acc.id;
  });

  async function telecharger(id: number) {
    const dl = await import('@/app/api/files/[id]/download/route');
    const res = await dl.GET(req(`/api/files/${id}/download`), ctx(id));
    expect(res.status, `download ${id}`).toBe(200);
    const body = await res.json() as { downloadUrl: string; filename: string };
    const cd = dispositionOf(body.downloadUrl);
    expect(cd.startsWith('attachment;')).toBe(true);
    expect(utf8Name(cd), 'filename* = nom renvoyé').toBe(body.filename);
    return body.filename;
  }

  it('L75L-AC1/AC2/AC5 nom affiché + extension réelle, sans UUID ni double extension (download)', async () => {
    expect(await telecharger(ids.facture)).toBe('Facture entretien chaudière.pdf');
    expect(await telecharger(ids.historique)).toBe('Bail signé.pdf');
    const tech = await telecharger(ids.technique);
    expect(tech).toBe('Assurance habitation.pdf');
    expect(tech).not.toMatch(UUID);
    expect(await telecharger(ids.image)).toBe('Photo façade.jpeg');
    expect(await telecharger(ids.bureautique)).toBe('Devis.docx');
  });

  it('L75L-AC7 aperçu / ouverture (view) : même nom, en inline', async () => {
    const view = await import('@/app/api/files/[id]/view/route');
    const res = await view.GET(req(`/api/files/${ids.facture}/view`), ctx(ids.facture));
    expect(res.status).toBe(200);
    const body = await res.json() as { viewUrl: string; filename: string };
    const cd = dispositionOf(body.viewUrl);
    expect(cd.startsWith('inline;')).toBe(true);
    expect(utf8Name(cd)).toBe('Facture entretien chaudière.pdf');
    expect(body.filename).toBe('Facture entretien chaudière.pdf');
  });

  it('L75L-AC3/AC9 renommage dans Verebona répercuté immédiatement ; stockage intact', async () => {
    const [avant] = await sql<{ s3_key: string; original_filename: string; filename: string }[]>`
      SELECT s3_key, original_filename, filename FROM asset_files WHERE id = ${ids.facture}`;
    const put = await import('@/app/api/documents/[id]/route');
    // Charge utile du tiroir (DocumentDrawer) : `fileName` = `retainedTitle`.
    const titre = "Attestation d’assurance l'été 2026";
    const res = await put.PUT(req(`/api/documents/${ids.facture}`, { method: 'PUT', body: { fileName: titre, retainedTitle: titre, documentType: 'FACTURE' } }), ctx(ids.facture));
    expect(res.status).toBe(200);
    expect(await telecharger(ids.facture)).toBe("Attestation d’assurance l'été 2026.pdf");
    const [apres] = await sql<{ s3_key: string; original_filename: string; filename: string }[]>`
      SELECT s3_key, original_filename, filename FROM asset_files WHERE id = ${ids.facture}`;
    expect(apres).toEqual(avant);
  });

  it('L75L-AC8 export « Mes données » : collecte réelle, noms affichés, doublons sans écrasement', async () => {
    const { collectUserData } = await import('@/services/gdpr/export-collector');
    const { planDocumentFiles } = await import('@/services/gdpr/export-content');
    const data = await collectUserData(acc.ownerUserId);
    const plan = planDocumentFiles(data.documents.filter((d) => Object.values(ids).includes(d.id)), 10_000);
    const paths = plan.include.map((d) => d.path).sort();
    expect(paths).toEqual([
      "documents/Attestation d’assurance l'été 2026.pdf",
      'documents/Assurance habitation.pdf',
      'documents/Bail signé.pdf',
      'documents/Devis.docx',
      'documents/Facture entretien chaudière.pdf',
      'documents/Photo façade.jpeg',
    ].sort());
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths.join('|')).not.toMatch(UUID);
  });
});
