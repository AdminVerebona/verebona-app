/**
 * Lot 111B — Exports V12 : régénération remplaçante, sur PostgreSQL 16 réel.
 *
 *   L111B-E01  rejeu / double clic (création ET « Régénérer ») : demande
 *              réutilisée, aucun remplacement.
 *   L111B-E02  régénération d'une génération EN FILE : `cancelled`
 *              (REPLACED_BY_NEW_GENERATION), retirée de la file, historique
 *              « Annulé — Remplacé par la génération … » avec lien, relance
 *              refusée ; nouveau format (ZIP) et autres options acceptés.
 *   L111B-E03  périmètre : autre type sur le même bien, autre bien, autre
 *              compte → conservés ; régénération sans génération active =
 *              création simple.
 *   L111B-E04  sinistres différents conservés ; même sinistre remplacé.
 *   L111B-E05  Premium Duo : la génération de l'autre membre n'est jamais
 *              annulée ; préparation : `activeGeneration` propre à chacun.
 *   L111B-E06  deux régénérations simultanées : une seule génération active.
 *   L111B-E07  plafond de trois générations : remplacement admis, création
 *              refusée ; une génération remplacée ne compte plus.
 *   L111B-E08  annulation PENDANT LE RENDU (worker réel, rendu simulé) :
 *              arrêt effectif, la nouvelle ne démarre qu'après, puis se
 *              télécharge ; ni échec ni support ; temporaires nettoyés.
 *   L111B-E09  annulation PENDANT L'ENVOI : transfert interrompu, objet
 *              confié à la purge, aucune publication.
 *   L111B-E10  annulation PENDANT LA FINALISATION : clôture refusée, objets
 *              purgés, aucune publication.
 *   L111B-E11  REDÉMARRAGE (processus arrêté) : la nouvelle attend le bail de
 *              l'ancienne, puis l'ancienne est close `cancelled` (jamais
 *              reprise ni en échec).
 *   L111B-E12  PERTE DE BAIL d'une exécution remplacée : aucune publication
 *              tardive (préconditions de `updateOwnedGeneration`).
 *   L111B-E13  archives prêtes du même dossier conservées et téléchargeables.
 *   L111B-E14  aucune régression : export brut et archive RGPD intacts.
 *
 * Rendu Chromium et stockage OVH simulés (aucun réseau) ; le reste est réel :
 * routes, file `export_generation`, verrou par compte, worker, purge.
 */
import fs from 'node:fs';
import os from 'node:os';
import { NextRequest } from 'next/server';
import { beforeEach, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import type { AccountRow, AssetRow } from '../factories';

const h = vi.hoisted(() => {
  // Stockage jamais joint (envois simulés plus bas) ; configuration exigée au chargement des routes.
  process.env.OVH_S3_ACCESS_KEY_ID ??= 'e2e';
  process.env.OVH_S3_SECRET_ACCESS_KEY ??= 'e2e';
  process.env.OVH_S3_BUCKET ??= 'e2e-bucket';
  process.env.OVH_S3_ENDPOINT ??= 'http://127.0.0.1:9';
  process.env.EXPORTS_POST_RATE_LIMIT = '10000';
  process.env.EXPORTS_CANCEL_POLL_MS = '250';
  process.env.EXPORTS_CANCEL_GRACE_MS = '5000';
  type RenderFn = (p: { signal?: AbortSignal; onStep: (s: string) => Promise<void>; meta: { reference: string } }) => Promise<unknown>;
  return {
    session: { currentAccountId: 0, userId: 0 },
    render: null as RenderFn | null,
    uploads: [] as string[],
    uploadHook: null as ((key: string, signal?: AbortSignal) => Promise<void>) | null,
    support: [] as unknown[],
  };
});

vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: h.session.userId, currentAccountId: h.session.currentAccountId }),
    handleSessionError: (e: unknown) => { throw e; },
  },
}));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));
vi.mock('@/lib/runtime/memory-monitor', async (o) => ({
  ...(await o<object>()), admitHeavyTask: () => true, trackMemory: (_k: string, fn: () => unknown) => fn(),
}));
vi.mock('@/services/exports/export-support-notifier', () => ({
  notifySupportOfExportFailure: async (p: unknown) => { h.support.push(p); return true; },
}));
// Rendu Chromium simulé : PDF minimal ; `h.render` permet de bloquer / observer une exécution.
vi.mock('@/services/exports/v12/render/render-dossier', () => ({
  renderDossier: async (p: { signal?: AbortSignal; onStep: (s: string) => Promise<void>; meta: { reference: string } }) => {
    if (h.render) {
      const r = await h.render(p);
      if (r) return r;
    } else {
      await p.onStep('resolve_files'); await p.onStep('render_html'); await p.onStep('render_pdf');
    }
    return {
      pdf: Buffer.from('%PDF-1.7 e2e'), pageCount: 3, passes: 1, data: { export: {} }, plan: { sections: {} }, templateVersion: 'e2e-v1',
      fileBaseName: `Verebona_${p.meta.reference}`, zipEntries: [], items: [], partial: false, warnings: [],
      counts: { integratedPdf: 0, zip: 0, excluded: 0, photos: 0 },
    };
  },
}));
// Stockage OVH simulé.
vi.mock('@/services/exports/v12/storage', async (o) => ({
  ...(await o<object>()),
  s3UploadFile: async (_local: string, key: string, _type: string, opts?: { signal?: AbortSignal }) => {
    if (h.uploadHook) await h.uploadHook(key, opts?.signal);
    opts?.signal?.throwIfAborted();
    h.uploads.push(key);
  },
}));

type Json = Record<string, unknown>;
const APP = 'https://app.e2e.verebona.test';

scenario('L111B', 'Exports V12 — régénération remplaçante (identité métier, annulation coopérative, historique)', ({ sql, make }) => {
  beforeEach(async () => {
    h.render = null; h.uploads = []; h.uploadHook = null; h.support = [];
    // Chaque cas part d'une file vide (le worker draine toute la file de la base du fichier).
    await sql`UPDATE export_generation SET status = 'failed', locked_by = NULL, locked_until = NULL WHERE status IN ('queued', 'generating')`;
  });

  const route = () => import('@/app/api/assets/[id]/exports/route');
  const repo = () => import('@/services/exports/v12/generation/repository');

  async function compteDuo() {
    const compte = await make.account({ plan: 'premium_duo' });
    const membre = await make.user();
    await sql`INSERT INTO account_memberships (account_id, user_id, role, status) VALUES (${compte.id}, ${membre.id}, 'member', 'active')`;
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const voiture = await make.asset(compte, { category: 'VEHICULE', name: 'Voiture' });
    return { compte, membre, maison, voiture };
  }
  const as = (c: AccountRow, userId = c.ownerUserId) => { h.session.currentAccountId = c.id; h.session.userId = userId; };

  async function post(asset: AssetRow, body: Json): Promise<{ status: number; json: Json }> {
    const { POST } = await route();
    const res = await POST(new NextRequest(`${APP}/api/assets/${asset.id}/exports`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: APP }, body: JSON.stringify(body),
    }), { params: Promise.resolve({ id: String(asset.id) }) });
    return { status: res.status, json: await res.json() as Json };
  }
  async function history(asset: AssetRow): Promise<Json[]> {
    const { GET } = await route();
    const res = await GET(new NextRequest(`${APP}/api/assets/${asset.id}/exports`), { params: Promise.resolve({ id: String(asset.id) }) });
    return ((await res.json()) as { exports: Json[] }).exports;
  }
  const PDF = (over: Json = {}) => ({ exportType: 'DOSSIER_COMPLET', requestedOutputs: ['PDF'], options: { includePhotos: true }, ...over });
  const ZIP = (over: Json = {}) => ({ exportType: 'DOSSIER_COMPLET', requestedOutputs: ['ZIP'], options: { includePhotos: false }, ...over });

  const row = async (publicId: unknown) => (await sql<Json[]>`
    SELECT id::int AS id, status, cancel_reason, cancel_requested_at, cancelled_at, cancelled_step, replaced_by_generation_id::int AS replaced_by,
           cancel_requested_by_user_id::int AS cancel_by, file_key, output_payload, identity_key, error_code, locked_by, generation_started_at, completed_at
      FROM export_generation WHERE public_id = ${String(publicId)}`)[0];
  const active = async (accountId: number) => Number((await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM export_generation WHERE account_id = ${accountId} AND status IN ('queued', 'generating')
       AND cancel_requested_at IS NULL AND export_type <> 'EXPORT_BRUT'`)[0].n);
  const waitFor = async (cond: () => Promise<boolean>, ms = 15_000) => {
    const t0 = Date.now();
    while (!(await cond())) {
      if (Date.now() - t0 > ms) throw new Error('délai dépassé');
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const purged = async (keys: string[]) => (await sql<{ storage_path: string }[]>`
    SELECT storage_path FROM pending_blob_deletions WHERE storage_path = ANY(${keys})`).map((r) => r.storage_path);
  const workDirsOf = (id: number) => fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith(`verebona-export-${id}-`));

  it('L111B-E01 rejeu / double clic : même demande réutilisée, y compris sur « Régénérer » ; aucun remplacement', async () => {
    const { compte, maison } = await compteDuo();
    as(compte);
    const a = await post(maison, PDF());
    expect(a.status).toBe(202);
    const b = await post(maison, PDF());
    expect(b.json).toMatchObject({ publicId: a.json.publicId, reused: true, replaced: [] });
    const c = await post(maison, PDF({ regenerate: true }));
    expect(c.json).toMatchObject({ publicId: a.json.publicId, reused: true, replaced: [] });
    expect((await row(a.json.publicId)).status).toBe('queued');
    expect(await active(compte.id)).toBe(1);
  });

  it('L111B-E02 régénération d’une génération en file : cancelled + motif + lien ; nouveau format et options ; relance refusée', async () => {
    const { compte, maison } = await compteDuo();
    as(compte);
    const a = await post(maison, PDF());
    const b = await post(maison, ZIP({ regenerate: true }));
    expect(b.status).toBe(202);
    expect(b.json.publicId).not.toBe(a.json.publicId);
    expect(b.json.replaced).toEqual([{ publicId: a.json.publicId, outcome: 'cancelled' }]);
    const oldRow = await row(a.json.publicId);
    const newRow = await row(b.json.publicId);
    expect(oldRow).toMatchObject({ status: 'cancelled', cancel_reason: 'REPLACED_BY_NEW_GENERATION', cancelled_step: 'queued', replaced_by: newRow.id, cancel_by: compte.ownerUserId, file_key: null });
    expect(oldRow.completed_at).not.toBeNull();
    expect(newRow).toMatchObject({ status: 'queued', identity_key: oldRow.identity_key });
    const [logs] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM export_generation_logs WHERE generation_id = ${oldRow.id as number} AND code = 'REPLACED_BY_NEW_GENERATION'`;
    expect(logs.n).toBe(1);
    // Historique : « Annulé — Remplacé par la génération VBN-COMPLET-…-{id} », lien vers la nouvelle.
    const hist = await history(maison);
    const old = hist.find((e) => e.publicId === a.json.publicId)!;
    expect(old.generationStatus).toBe('cancelled');
    expect(old.errorMessage).toBeNull();
    expect(old.cancellation).toMatchObject({
      label: 'Annulé — Remplacé par la génération',
      replacedBy: { publicId: b.json.publicId, reference: expect.stringMatching(new RegExp(`^VBN-COMPLET-\\d{8}-${String(newRow.id).padStart(6, '0')}$`)) },
    });
    // Relance d'une génération remplacée : refusée.
    const { POST: RETRY } = await import('@/app/api/assets/[id]/exports/[exportId]/retry/route');
    const r = await RETRY(new NextRequest(`${APP}/x`, { method: 'POST', headers: { origin: APP } }), { params: Promise.resolve({ id: String(maison.id), exportId: String(oldRow.id) }) });
    expect(r.status).toBe(400);
    // Retirée de la file : le worker prend la nouvelle, jamais l'ancienne.
    const claimed = await (await repo()).claimNextGeneration('e2e-w-e02');
    expect(claimed?.id).toBe(newRow.id);
    await sql`UPDATE export_generation SET status = 'failed', locked_by = NULL WHERE id = ${newRow.id as number}`;
  });

  it('L111B-E03 périmètre : autre type, autre bien, autre compte conservés ; régénération sans génération active = création', async () => {
    const { compte, maison, voiture } = await compteDuo();
    const autre = await compteDuo();
    as(autre.compte);
    const etranger = await post(autre.maison, PDF());
    as(compte);
    const complet = await post(maison, PDF());
    const vente = await post(maison, { exportType: 'VENTE', requestedOutputs: ['PDF'], regenerate: true });
    expect(vente.status).toBe(202);
    expect(vente.json.replaced).toEqual([]); // rien d'actif pour la Vente : création simple
    const autreBien = await post(voiture, PDF({ regenerate: true }));
    expect(autreBien.json.replaced).toEqual([]);
    for (const p of [complet, vente, autreBien]) expect((await row(p.json.publicId)).status).toBe('queued');
    as(autre.compte);
    expect((await row(etranger.json.publicId)).status).toBe('queued');
  });

  it('L111B-E04 sinistres : un autre sinistre conserve la génération ; le même sinistre la remplace', async () => {
    const { compte, maison } = await compteDuo();
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    const f1 = await make.assetFile(compte, { assetId: maison.id });
    const f2 = await make.assetFile(compte, { assetId: maison.id });
    const [s1, s2] = await withBusinessOperationWrite(compte.id, async (r) => {
      const ids: number[] = [];
      for (const [i, f] of [f1, f2].entries()) {
        const c = await r.create({
          type: { code: 'CLAIM' }, status: 'REALIZED', realizedDate: `2026-0${i + 3}-12`, technicalLabel: i ? 'Vol' : 'Dégât des eaux',
          source: { kind: 'DOCUMENT', entityKey: f.id, authority: 'DOCUMENT', confidence: 'certain' },
          assets: [{ assetId: maison.id, role: 'PRIMARY', authority: 'DOCUMENT' }], reasonCode: 'E2E_L111B',
        });
        ids.push(c.id);
      }
      return ids;
    });
    as(compte);
    const sin = (claimOperationId: number, over: Json = {}) => ({ exportType: 'ASSURANCE_SINISTRE', requestedOutputs: ['PDF'], claimOperationId, ...over });
    const a = await post(maison, sin(s1));
    expect(a.status).toBe(202);
    const b = await post(maison, sin(s2, { regenerate: true }));
    expect(b.json.replaced).toEqual([]);
    expect((await row(a.json.publicId)).status).toBe('queued');
    const c = await post(maison, sin(s1, { regenerate: true, requestedOutputs: ['ZIP'] }));
    expect(c.json.replaced).toEqual([{ publicId: a.json.publicId, outcome: 'cancelled' }]);
    expect((await row(b.json.publicId)).status).toBe('queued');
  });

  it('L111B-E05 Premium Duo : jamais d’annulation de la génération de l’autre membre ; activeGeneration propre à chacun', async () => {
    const { compte, membre, maison } = await compteDuo();
    as(compte);
    const titulaire = await post(maison, PDF());
    as(compte, membre.id);
    const m1 = await post(maison, ZIP({ regenerate: true }));
    expect(m1.json.replaced).toEqual([]);
    const m2 = await post(maison, PDF({ regenerate: true, options: { includePhotos: false } }));
    expect(m2.json.replaced).toEqual([{ publicId: m1.json.publicId, outcome: 'cancelled' }]);
    expect((await row(titulaire.json.publicId)).status).toBe('queued');
    const { prepareDossier } = await import('@/services/exports/v12/preparation/load');
    const { findAccessibleAssetForExport } = await import('@/services/exports/export-access');
    const acces = (await findAccessibleAssetForExport({ currentAccountId: compte.id, userId: membre.id } as never, maison.id))!;
    const pm = await prepareDossier({ asset: acces, userId: membre.id, body: { exportType: 'DOSSIER_COMPLET' } });
    const pt = await prepareDossier({ asset: acces, userId: compte.ownerUserId, body: { exportType: 'DOSSIER_COMPLET' } });
    expect(pm.ok && pm.body.activeGeneration?.publicId).toBe(m2.json.publicId);
    expect(pt.ok && pt.body.activeGeneration?.publicId).toBe(titulaire.json.publicId);
  });

  it('L111B-E06 deux régénérations simultanées : une seule génération active, aucune double génération', async () => {
    const { compte, maison } = await compteDuo();
    as(compte);
    const a = await post(maison, PDF());
    const [x, y] = await Promise.all([post(maison, ZIP({ regenerate: true })), post(maison, PDF({ regenerate: true, options: { includePhotos: false } }))]);
    expect([x.status, y.status]).toEqual([202, 202]);
    const rows = await sql<Json[]>`SELECT id::int AS id, status, replaced_by_generation_id::int AS replaced_by FROM export_generation WHERE asset_id = ${maison.id} ORDER BY id`;
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.status === 'queued')).toHaveLength(1);
    expect(rows.filter((r) => r.status === 'cancelled')).toHaveLength(2);
    expect((await row(a.json.publicId)).status).toBe('cancelled');
    // Chaîne cohérente : chaque annulée pointe vers une génération plus récente.
    for (const r of rows.filter((x2) => x2.status === 'cancelled')) expect(Number(r.replaced_by)).toBeGreaterThan(Number(r.id));
  });

  it('L111B-E07 plafond de trois générations : remplacement admis, création refusée ; une remplacée ne compte plus', async () => {
    const { compte, maison, voiture } = await compteDuo();
    as(compte);
    for (const t of ['DOSSIER_COMPLET', 'VENTE', 'ASSURANCE_SOUSCRIPTION']) expect((await post(maison, { exportType: t, requestedOutputs: ['PDF'] })).status).toBe(202);
    expect((await post(voiture, PDF())).status).toBe(429);
    const regen = await post(maison, ZIP({ regenerate: true }));
    expect(regen.status).toBe(202);
    expect(regen.json.replaced).toHaveLength(1);
    expect(await active(compte.id)).toBe(3);
    // Une génération `generating` dont l'annulation est demandée ne compte plus.
    await sql`UPDATE export_generation SET status = 'generating', locked_by = 'e2e', locked_until = now() + interval '1 minute',
                     cancel_requested_at = now(), cancel_reason = 'REPLACED_BY_NEW_GENERATION'
               WHERE asset_id = ${maison.id} AND export_type = 'VENTE'`;
    expect((await post(voiture, PDF())).status).toBe(202);
    const { countActiveGenerations } = await repo();
    expect(await countActiveGenerations(compte.id)).toBe(3);
    await sql`UPDATE export_generation SET status = 'failed', locked_by = NULL WHERE account_id = ${compte.id} AND status IN ('queued', 'generating')`;
  });

  it('L111B-E08 annulation pendant le rendu (worker) : arrêt effectif, la nouvelle démarre ensuite et se télécharge ; ni échec ni support', async () => {
    const { compte, maison } = await compteDuo();
    as(compte);
    const a = await post(maison, PDF());
    const aRow = await row(a.json.publicId);
    let started = false;
    h.render = async (p) => {
      if (!p.meta.reference.endsWith(String(aRow.id).padStart(6, '0'))) return null; // la nouvelle : rendu normal
      await p.onStep('resolve_files');
      await p.onStep('render_html');
      await p.onStep('render_pdf');
      started = true;
      // « Chromium » occupé jusqu'à l'interruption par le signal.
      await new Promise<void>((_, reject) => p.signal?.addEventListener('abort', () => reject(new Error('navigateur fermé')), { once: true }));
      return null;
    };
    const { drainExportQueue } = await import('@/services/exports/v12/generation/worker');
    const drained = drainExportQueue('e2e-w-e08');
    await waitFor(async () => started);
    expect(workDirsOf(aRow.id as number).length).toBe(1);
    const b = await post(maison, ZIP({ regenerate: true }));
    expect(b.json.replaced).toEqual([{ publicId: a.json.publicId, outcome: 'stopping' }]);
    // Pendant l'arrêt : déjà présentée annulée dans l'historique.
    expect((await history(maison)).find((e) => e.publicId === a.json.publicId)?.generationStatus).toBe('cancelled');
    expect(await drained).toBe(2);
    const oldRow = await row(a.json.publicId);
    const newRow = await row(b.json.publicId);
    expect(oldRow).toMatchObject({ status: 'cancelled', cancelled_step: 'render_pdf', file_key: null, locked_by: null, error_code: null });
    expect(newRow.status).toBe('ready');
    expect(new Date(newRow.generation_started_at as string).getTime()).toBeGreaterThanOrEqual(new Date(oldRow.cancelled_at as string).getTime());
    expect(h.uploads.every((k) => k.includes(`/${newRow.id}/`))).toBe(true);
    expect(h.support).toEqual([]);
    expect(workDirsOf(aRow.id as number)).toEqual([]);
    // La nouvelle se télécharge.
    const dto = (await history(maison)).find((e) => e.publicId === b.json.publicId)!;
    expect(dto.downloadUrl).toMatch(/\/download\?file=pdf$/);
  });

  it('L111B-E09 annulation pendant l’envoi : transfert interrompu, objet confié à la purge, aucune publication', async () => {
    const { compte, maison } = await compteDuo();
    as(compte);
    const a = await post(maison, PDF());
    const aRow = await row(a.json.publicId);
    let attempted: string | null = null;
    let b: { json: Json } | null = null;
    h.uploadHook = async (key, signal) => {
      if (!key.includes(`/${aRow.id}/`)) return;
      attempted = key;
      b = await post(maison, ZIP({ regenerate: true }));
      // Envoi « long » interrompu par le signal du worker.
      await new Promise<void>((_, reject) => signal?.addEventListener('abort', () => reject(new Error('envoi interrompu')), { once: true }));
    };
    const { drainExportQueue } = await import('@/services/exports/v12/generation/worker');
    expect(await drainExportQueue('e2e-w-e09')).toBe(2);
    expect(attempted).not.toBeNull();
    expect(await row(a.json.publicId)).toMatchObject({ status: 'cancelled', cancelled_step: 'store_result', file_key: null });
    expect((await row(b!.json.publicId)).status).toBe('ready');
    expect(await purged([attempted!])).toEqual([attempted]);
    expect(h.support).toEqual([]);
  });

  it('L111B-E10 annulation pendant la finalisation : clôture refusée, objets purgés, aucune publication', async () => {
    const { compte, maison } = await compteDuo();
    as(compte);
    const a = await post(maison, PDF());
    const aRow = await row(a.json.publicId);
    let b: { json: Json } | null = null;
    h.uploadHook = async (key) => { if (key.includes(`/${aRow.id}/`)) b = await post(maison, PDF({ regenerate: true, options: { includePhotos: false } })); };
    const { drainExportQueue } = await import('@/services/exports/v12/generation/worker');
    expect(await drainExportQueue('e2e-w-e10')).toBe(2);
    const oldRow = await row(a.json.publicId);
    expect(oldRow).toMatchObject({ status: 'cancelled', cancelled_step: 'finalize_history', file_key: null });
    const oldKeys = h.uploads.filter((k) => k.includes(`/${aRow.id}/`));
    expect(oldKeys).toHaveLength(1);
    expect(await purged(oldKeys)).toEqual(oldKeys);
    expect((await row(b!.json.publicId)).status).toBe('ready');
  });

  it('L111B-E11 redémarrage : la nouvelle attend le bail de l’ancienne, puis l’ancienne est close cancelled (jamais reprise)', async () => {
    const { compte, maison } = await compteDuo();
    as(compte);
    const a = await post(maison, PDF());
    const { claimNextGeneration } = await repo();
    const pris = await claimNextGeneration('e2e-processus-arrete');
    expect(pris?.publicId).toBe(a.json.publicId);
    const b = await post(maison, ZIP({ regenerate: true }));
    expect(b.json.replaced).toEqual([{ publicId: a.json.publicId, outcome: 'stopping' }]);
    // Bail de l'ancienne encore valide : la nouvelle n'est pas prise.
    expect(await claimNextGeneration('e2e-w-e11')).toBeNull();
    // Processus arrêté : le bail expire.
    await sql`UPDATE export_generation SET locked_until = now() - interval '1 second' WHERE public_id = ${String(a.json.publicId)}`;
    const suivante = await claimNextGeneration('e2e-w-e11');
    expect(suivante?.publicId).toBe(b.json.publicId);
    expect(await row(a.json.publicId)).toMatchObject({ status: 'cancelled', cancelled_step: 'lease_expired', locked_by: null, error_code: null });
    await sql`UPDATE export_generation SET status = 'failed', locked_by = NULL WHERE public_id = ${String(b.json.publicId)}`;
  });

  it('L111B-E12 perte de bail d’une exécution remplacée : aucune publication tardive', async () => {
    const { compte, maison } = await compteDuo();
    as(compte);
    const a = await post(maison, PDF());
    const { claimNextGeneration } = await repo();
    const pris = (await claimNextGeneration('e2e-w-ancien'))!;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    h.render = async (p) => { await p.onStep('render_pdf'); await gate; return null; };
    const { runGeneration } = await import('@/services/exports/v12/generation/job');
    const uploads: string[] = [];
    // Exécution « figée » qui ne voit ni signal ni annulation avant l'écriture finale.
    const run = runGeneration(pris, 'e2e-w-ancien', { deps: { upload: async (_l, k) => { uploads.push(k); } } });
    await waitFor(async () => (await sql`SELECT 1 FROM export_generation_logs WHERE generation_id = ${pris.id} AND step = 'render_pdf'`).length > 0);
    const b = await post(maison, ZIP({ regenerate: true }));
    await sql`UPDATE export_generation SET locked_until = now() - interval '1 second' WHERE id = ${pris.id}`;
    const suivante = await claimNextGeneration('e2e-w-nouveau');
    expect(suivante?.publicId).toBe(b.json.publicId);
    release();
    // Exécution tardive : la relecture avant l'envoi voit l'annulation → issue « annulée », rien d'écrit.
    expect(await run).toBe('cancelled');
    const oldRow = await row(a.json.publicId);
    expect(oldRow).toMatchObject({ status: 'cancelled', file_key: null });
    expect(String(oldRow.output_payload ?? '')).not.toContain('pdfS3Key');
    expect(uploads).toEqual([]); // la relecture avant envoi a vu l'annulation
    await sql`UPDATE export_generation SET status = 'failed', locked_by = NULL WHERE public_id = ${String(b.json.publicId)}`;
  });

  it('L111B-E13 archives prêtes du même dossier conservées et téléchargeables pendant leur rétention', async () => {
    const { compte, maison } = await compteDuo();
    const key = `exports/${compte.id}/${maison.id}/x/a1/ancien.pdf`;
    const [pret] = await sql<{ public_id: string }[]>`
      INSERT INTO export_generation (asset_id, account_id, user_id, export_type, status, output_format, file_key, output_payload, expires_at, completed_at, identity_key)
      VALUES (${maison.id}, ${compte.id}, ${compte.ownerUserId}, 'DOSSIER_COMPLET', 'ready', 'PDF', ${key}, ${JSON.stringify({ pdfS3Key: key, pdfSize: 10 })},
              now() + interval '20 days', now(), ${`v1:a${compte.id}:b${maison.id}:tDOSSIER_COMPLET:c-:v-:u${compte.ownerUserId}`})
      RETURNING public_id`;
    as(compte);
    await post(maison, PDF());
    const r = await post(maison, ZIP({ regenerate: true }));
    expect(r.json.replaced).toHaveLength(1);
    expect((await row(pret.public_id)).status).toBe('ready');
    const dto = (await history(maison)).find((e) => e.publicId === pret.public_id)!;
    expect(dto.generationStatus).toBe('ready');
    expect(dto.downloadUrl).toMatch(/\/download\?file=pdf$/);
    await sql`UPDATE export_generation SET status = 'failed' WHERE account_id = ${compte.id} AND status = 'queued'`;
  });

  it('L111B-E14 aucune régression : export brut et archive RGPD « Mes données » intacts', async () => {
    const { compte, maison } = await compteDuo();
    const [brut] = await sql<{ id: number }[]>`
      INSERT INTO export_generation (asset_id, account_id, user_id, export_type, status, generation_started_at)
      VALUES (${maison.id}, ${compte.id}, ${compte.ownerUserId}, 'EXPORT_BRUT', 'generating', now()) RETURNING id`;
    const [rgpd] = await sql<{ id: number }[]>`INSERT INTO gdpr_exports (user_id, account_id, status, created_at) VALUES (${compte.ownerUserId}, ${compte.id}, 'pending', now()) RETURNING id`;
    as(compte);
    await post(maison, PDF());
    const r = await post(maison, ZIP({ regenerate: true }));
    expect(r.json.replaced).toHaveLength(1);
    const [b] = await sql<Json[]>`SELECT status, cancel_requested_at, identity_key FROM export_generation WHERE id = ${brut.id}`;
    expect(b).toMatchObject({ status: 'generating', cancel_requested_at: null, identity_key: null });
    const [g] = await sql<Json[]>`SELECT status FROM gdpr_exports WHERE id = ${rgpd.id}`;
    expect(g.status).toBe('pending');
    // Le worker ne prend jamais un export brut.
    await sql`UPDATE export_generation SET status = 'failed' WHERE account_id = ${compte.id} AND status = 'queued'`;
    expect(await (await repo()).claimNextGeneration('e2e-w-e14')).toBeNull();
  });
});
