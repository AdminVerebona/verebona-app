/**
 * Lot 103C — fiabilisation de l'export RGPD « Mes données » (ticket P1,
 * recette iOS du 31/10/2026), sur PostgreSQL 16 réel (migration 0940),
 * stockage objet SIMULÉ en mémoire (pannes pilotables), notifications
 * capturées.
 *
 * L103C-E2E-01 Nominal : POST = enregistrement (202, référence) sans
 *              génération dans la requête ; worker → archive COMPLÈTE ; ZIP
 *              lisible, JSON valides, manifeste v3 concordant (SHA-256 de
 *              chaque fichier), notification unique, registre « traité ».
 * L103C-E2E-02 Table de plus de 20 000 lignes : aucune troncature.
 * L103C-E2E-03 Reprise : processus arrêté en cours (bail expiré), ancienne
 *              ligne `pending` orpheline, ancienne ligne `generating` sans
 *              bail → reprises sans action de l'utilisateur.
 * L103C-E2E-04 Double clic / POST parallèles / POST rejoué (même clé) :
 *              une seule archive, une seule demande au registre.
 * L103C-E2E-05 Registre en panne après l'insertion : génération non
 *              bloquée, dette tracée puis rejouée, aucun doublon.
 * L103C-E2E-06 Stockage : objet absent → archive PARTIELLE + inventaire ;
 *              lecture transitoire → nouvelle tentative, parties déjà
 *              déposées reprises ; dépôt impossible → ÉCHEC explicite (code,
 *              référence), puis orientation vers l'assistance ; Supervision.
 * L103C-E2E-07 Isolation : Premium Duo (conversations de l'autre membre
 *              jamais exportées), téléchargement intercompte refusé.
 */
import { NextRequest } from 'next/server';
import { beforeEach, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { createHash } from 'node:crypto';
import { scenario } from '../scenario';
import { uid } from '../factories';

const etat = vi.hoisted(() => {
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'secret-e2e-l103c-xxxxxxxxxxxxxxxxxxxx';
  process.env.GDPR_EXPORT_PART_MAX_BYTES = '100';
  process.env.GDPR_EXPORT_MAX_ATTEMPTS = '3';
  return {
    objects: new Map<string, Buffer>(),
    session: { userId: 0 },
    readFail: new Set<string>(),
    uploadFail: 0,
    uploads: [] as string[],
    registryFail: false,
    emitted: [] as Array<{ type: string; entityId: number }>,
  };
});

vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: etat.session.userId, role: 'USER' }),
    handleSessionError: () => new Response('unauthorized', { status: 401 }),
  },
}));
vi.mock('@/services/gdpr/gdpr-storage', async () => {
  const fs = await import('node:fs');
  const { createHash: h } = await import('node:crypto');
  class StorageUnavailableError extends Error { readonly code = 'STORAGE_UNAVAILABLE'; }
  return {
    StorageUnavailableError,
    downloadStoredFileToPath: async (key: string, _bucket: string | null, dest: string) => {
      if (etat.readFail.has(key)) return { ok: false, reason: 'READ_FAILED', detail: 'TIMEOUT' };
      const b = etat.objects.get(key);
      if (!b) return { ok: false, reason: 'NOT_FOUND', detail: 'NOT_FOUND' };
      await fs.promises.writeFile(dest, b);
      return { ok: true, bytes: b.length, sha256: h('sha256').update(b).digest('hex') };
    },
    uploadFileFromPath: async (local: string, key: string) => {
      if (etat.uploadFail > 0) { etat.uploadFail--; throw new StorageUnavailableError('dépôt de l’archive impossible (TIMEOUT)'); }
      etat.uploads.push(key);
      etat.objects.set(key, await fs.promises.readFile(local));
    },
    deleteStoredFile: async (key: string) => { etat.objects.delete(key); return true; },
  };
});
vi.mock('@/services/export-upload.service', () => ({
  getExportSignedUrl: async (key: string, ttl: number) => `https://s3.e2e.invalid/${key}?ttl=${ttl}`,
}));
vi.mock('@/lib/notifications/event-service', () => ({
  emit: async (e: { type: string; entityId: number }) => { etat.emitted.push({ type: e.type, entityId: e.entityId }); },
}));
vi.mock('@/services/gdpr/system-requests', async (orig) => {
  const real = await orig<typeof import('@/services/gdpr/system-requests')>();
  return {
    ...real,
    upsertSystemRequest: async (...a: Parameters<typeof real.upsertSystemRequest>) => {
      if (etat.registryFail) throw new Error('registre indisponible (simulé)');
      return real.upsertSystemRequest(...a);
    },
  };
});

type Json = Record<string, any>;
const req = (url: string, method = 'GET', headers: Record<string, string> = {}) =>
  new NextRequest(`http://app.test${url}`, { method, headers: { origin: 'http://app.test', host: 'app.test', ...headers } });
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

scenario('L103C', 'Export RGPD « Mes données » : génération durable, idempotence, exhaustivité, isolation', ({ sql, make }) => {
  beforeEach(() => {
    etat.readFail.clear();
    etat.uploadFail = 0;
    etat.uploads.length = 0;
    etat.registryFail = false;
    etat.emitted.length = 0;
  });

  const route = () => import('@/app/api/users/me/gdpr-export/route');
  const job = () => import('@/services/gdpr/gdpr-export.job');
  const drain = async (n = 5) => (await job()).drainGdprExportQueue(`e2e-103c-${uid('w')}`, { maxJobs: n });
  const latest = async (userId: number) => (await sql<Json[]>`SELECT * FROM gdpr_exports WHERE user_id = ${userId} ORDER BY id DESC LIMIT 1`)[0];

  async function compte(n = 3, opts: { plan?: 'premium_duo' } = {}) {
    const acc = await make.account(opts.plan ? { plan: opts.plan } : {});
    const files: Array<{ id: number; key: string }> = [];
    for (let i = 0; i < n; i++) {
      const f = await make.assetFile(acc, { name: `${uid('doc')}.pdf` });
      const key = `e2e/${acc.id}/orig-${f.id}.pdf`;
      etat.objects.set(key, Buffer.from(`%PDF-${String(f.id).padStart(35, '0')}`)); // 40 octets
      await sql`UPDATE asset_files SET s3_key = ${key}, size = 40, original_filename = ${`piece-${i + 1}.pdf`} WHERE id = ${f.id}`;
      files.push({ id: f.id, key });
    }
    return { ...acc, files };
  }

  async function post(userId: number, headers: Record<string, string> = {}) {
    etat.session.userId = userId;
    const res = await (await route()).POST(req('/api/users/me/gdpr-export', 'POST', headers));
    return { status: res.status, body: await res.json() as Json, requestId: res.headers.get('x-request-id') };
  }
  async function get(userId: number) {
    etat.session.userId = userId;
    return (await (await route()).GET(req('/api/users/me/gdpr-export'))).json() as Promise<Json>;
  }
  async function zips(userId: number): Promise<JSZip[]> {
    const body = await get(userId);
    const download = (await import('@/app/api/users/me/gdpr-export/download/route')).GET;
    const out: JSZip[] = [];
    for (const p of body.parts as Json[]) {
      const res = await download(req(p.downloadUrl));
      expect(res.status).toBe(302);
      const key = decodeURIComponent(new URL(res.headers.get('location')!).pathname.slice(1));
      out.push(await JSZip.loadAsync(etat.objects.get(key)!, { checkCRC32: true }));
    }
    return out;
  }

  it('L103C-E2E-01 — nominal : enregistrement, worker, archive COMPLÈTE et vérifiable, notification, registre', async () => {
    const acc = await compte(3);
    const p = await post(acc.ownerUserId);
    expect(p.status).toBe(202);
    expect(p.requestId).toBeTruthy();
    expect(p.body.requestId).toBe(p.requestId);
    expect(p.body.export.status).toBe('pending');           // rien n'a été généré dans la requête
    expect(p.body.view.kind).toBe('in_progress');
    expect(etat.uploads).toEqual([]);
    const row = await latest(acc.ownerUserId);
    expect(row.correlation_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.notify_on_ready).toBe(true);

    expect(await drain()).toBeGreaterThanOrEqual(1);
    const body = await get(acc.ownerUserId);
    expect(body.export.status).toBe('ready');
    expect(body.export.completeness).toBe('complete');
    expect(body.view.kind).toBe('ready');
    expect(body.parts.map((x: Json) => x.number)).toEqual([1, 2]); // 3 × 40 o, parties ≤ 100 o

    const z = await zips(acc.ownerUserId);
    const manifest = JSON.parse(await z[0].file('manifest.json')!.async('string')) as Json;
    expect(manifest).toMatchObject({ version: 3, status: 'COMPLET', missing: [] });
    expect(manifest.documents.included).toBe(3);
    // Chaque fichier annoncé est présent, avec la taille et l'empreinte annoncées.
    for (const t of manifest.tables as Json[]) {
      const b = await z[0].file(t.file)!.async('nodebuffer');
      expect(b.length).toBe(t.bytes);
      expect(sha(b)).toBe(t.sha256);
      const rows = JSON.parse(b.toString('utf8'));
      expect(Array.isArray(rows)).toBe(true);
      expect(rows).toHaveLength(t.rows);
    }
    for (const f of manifest.documents.files as Json[]) {
      const b = await z[f.part - 1].file(f.path)!.async('nodebuffer');
      expect(sha(b)).toBe(f.sha256);
    }
    const users = JSON.parse(await z[0].file('donnees/users.json')!.async('string')) as Json[];
    expect(users.map((u) => u.id)).toEqual([acc.ownerUserId]);
    expect(JSON.stringify(users)).not.toMatch(/password/);
    expect(await z[0].file('LISEZ-MOI.txt')!.async('string')).toMatch(/Statut : COMPLET/);

    expect(etat.emitted.filter((e) => e.type === 'GDPR_EXPORT_READY')).toHaveLength(1);
    const regs = await sql<Json[]>`SELECT status, result FROM gdpr_requests WHERE subject_user_ref = ${acc.ownerUserId}`;
    expect(regs).toHaveLength(1);
    expect(regs[0].status).toBe('done');
    expect(regs[0].result).toMatch(/complète/);
    const fin = await latest(acc.ownerUserId);
    expect(fin.registry_pending).toBe(false);
    expect(fin.locked_by).toBeNull();
    expect(fin.summary.metrics.peakRssMb).toBeGreaterThan(0);
  });

  it('L103C-E2E-02 — plus de 20 000 lignes dans une table : rien de tronqué', async () => {
    const acc = await compte(0);
    await sql`INSERT INTO notifications (user_id, type) SELECT ${acc.ownerUserId}, 'E2E_L103C' FROM generate_series(1, 20500)`;
    await post(acc.ownerUserId);
    await drain();
    const z = await zips(acc.ownerUserId);
    const manifest = JSON.parse(await z[0].file('manifest.json')!.async('string')) as Json;
    const t = (manifest.tables as Json[]).find((x) => x.table === 'notifications')!;
    expect(t.rows).toBe(20500);
    expect(t.truncated).toBe(false);
    expect(manifest.status).toBe('COMPLET');
    expect(JSON.parse(await z[0].file('donnees/notifications.json')!.async('string'))).toHaveLength(20500);
  }, 120_000);

  it('L103C-E2E-03 — reprise : bail expiré (processus arrêté), pending orpheline, generating sans bail', async () => {
    const j = await job();
    // a) Processus arrêté en pleine génération : bail pris puis jamais renouvelé.
    const a = await compte(1);
    await post(a.ownerUserId);
    const claimed = await j.claimNextGdprExport('instance-morte');
    expect(Number(claimed!.id)).toBe(Number((await latest(a.ownerUserId)).id));
    await sql`UPDATE gdpr_exports SET locked_until = now() - interval '1 second' WHERE id = ${Number(claimed!.id)}`;
    await drain();
    const ra = await latest(a.ownerUserId);
    expect(ra.status).toBe('ready');
    expect(ra.attempt_count).toBe(2);

    // b) Ancienne demande orpheline (POST interrompu après l'insertion, ancien code).
    const b = await compte(1);
    await sql`INSERT INTO gdpr_exports (user_id, account_id, status, created_at) VALUES (${b.ownerUserId}, ${b.id}, 'pending', now() - interval '2 days')`;
    // Le POST suivant ne crée pas de doublon : il renvoie la demande active…
    const pb = await post(b.ownerUserId);
    expect(pb.body.created).toBe(false);
    // … qui est bien exécutée.
    await drain();
    expect((await latest(b.ownerUserId)).status).toBe('ready');
    expect((await sql`SELECT id FROM gdpr_exports WHERE user_id = ${b.ownerUserId}`)).toHaveLength(1);

    // c) Ancienne génération SANS bail figée depuis 30 min : remise en file puis exécutée.
    const c = await compte(1);
    await sql`INSERT INTO gdpr_exports (user_id, account_id, status, started_at, attempt_count, created_at)
              VALUES (${c.ownerUserId}, ${c.id}, 'generating', now() - interval '30 minutes', 1, now() - interval '31 minutes')`;
    expect((await j.recoverGdprExports()).requeued).toBeGreaterThanOrEqual(1);
    await drain();
    expect((await latest(c.ownerUserId)).status).toBe('ready');
  });

  it('L103C-E2E-04 — double clic, POST parallèles, POST rejoué : une seule archive, un seul enregistrement RGPD', async () => {
    const acc = await compte(1);
    etat.session.userId = acc.ownerUserId;
    const r = await route();
    const res = await Promise.all([1, 2, 3].map(() => r.POST(req('/api/users/me/gdpr-export', 'POST'))));
    const bodies = await Promise.all(res.map((x) => x.json() as Promise<Json>));
    expect(new Set(bodies.map((b) => b.export.id)).size).toBe(1);
    expect(bodies.filter((b) => b.created)).toHaveLength(1);
    await drain();
    // Perte réseau après écriture : le client rejoue avec la même clé.
    const k1 = await post(acc.ownerUserId, { 'idempotency-key': 'mes-donnees-cle-0001' });
    expect(k1.body.created).toBe(true);
    const k2 = await post(acc.ownerUserId, { 'idempotency-key': 'mes-donnees-cle-0001' });
    expect(k2.body.created).toBe(false);
    expect(k2.body.export.id).toBe(k1.body.export.id);
    await drain();
    const k3 = await post(acc.ownerUserId, { 'idempotency-key': 'mes-donnees-cle-0001' }); // déjà prête : toujours la même
    expect(k3.body.export.id).toBe(k1.body.export.id);
    expect(k3.status).toBe(200);
    expect((await sql`SELECT id FROM gdpr_exports WHERE user_id = ${acc.ownerUserId}`)).toHaveLength(2);
    expect((await post(acc.ownerUserId, { 'idempotency-key': 'x' })).status).toBe(400);
    const regs = await sql<Json[]>`SELECT source_ref FROM gdpr_requests WHERE subject_user_ref = ${acc.ownerUserId}`;
    expect(regs).toHaveLength(2); // une demande par export terminé, jamais deux pour le même
  });

  it('L103C-E2E-05 — registre RGPD en panne : génération non bloquée, dette tracée puis rejouée', async () => {
    const acc = await compte(1);
    etat.registryFail = true;
    const p = await post(acc.ownerUserId);
    expect(p.status).toBe(202);
    let row = await latest(acc.ownerUserId);
    expect(row.registry_pending).toBe(true);
    expect(row.registry_error).toMatch(/registre indisponible/);
    await drain();
    row = await latest(acc.ownerUserId);
    expect(row.status).toBe('ready');
    expect(row.registry_pending).toBe(true); // toujours en dette, archive disponible quand même
    etat.registryFail = false;
    const r = await (await job()).replayGdprRegistryDebt();
    expect(r.replayed).toBeGreaterThanOrEqual(1);
    row = await latest(acc.ownerUserId);
    expect(row.registry_pending).toBe(false);
    const regs = await sql<Json[]>`SELECT id, status FROM gdpr_requests WHERE subject_user_ref = ${acc.ownerUserId}`;
    expect(regs).toHaveLength(1);
    expect(regs[0].status).toBe('done');
    expect(Number(row.request_id)).toBe(Number(regs[0].id));
    expect((await (await job()).replayGdprRegistryDebt()).replayed).toBe(0); // rejouer ne duplique rien
  });

  it('L103C-E2E-06 — stockage : PARTIEL avec inventaire, reprise des parties, ÉCHEC explicite, assistance, Supervision', async () => {
    // a) Objet absent : archive PARTIELLE, jamais présentée comme complète.
    const a = await compte(3);
    etat.objects.delete(a.files[1].key);
    await post(a.ownerUserId);
    await drain();
    const ba = await get(a.ownerUserId);
    expect(ba.export.completeness).toBe('partial');
    expect(ba.view.kind).toBe('partial');
    expect(ba.view.canRequest).toBe(true);
    expect(ba.export.missingCount).toBe(1);
    expect(ba.export.missing[0].reason).toMatch(/introuvable/);
    const za = await zips(a.ownerUserId);
    const ma = JSON.parse(await za[0].file('manifest.json')!.async('string')) as Json;
    expect(ma.status).toBe('PARTIEL');
    expect(ma.missing).toEqual([expect.objectContaining({ kind: 'document', id: a.files[1].id, reason: 'OBJECT_MISSING' })]);
    expect(ma.documents.files.map((f: Json) => f.id)).not.toContain(a.files[1].id);
    expect(await za[0].file('documents/NON-RECUPERES.txt')!.async('string')).toMatch(String(a.files[1].id));

    // b) Lecture transitoire : nouvelle tentative programmée ; la partie déjà déposée est reprise.
    const b = await compte(3);
    etat.readFail.add(b.files[0].key); // document de la partie 1 (construite en dernier)
    const u0 = etat.uploads.length;
    await post(b.ownerUserId);
    await drain();
    let rb = await latest(b.ownerUserId);
    expect(rb.status).toBe('pending');
    expect(rb.error_code).toBe('STORAGE_UNAVAILABLE');
    expect(rb.next_attempt_at).not.toBeNull();
    expect((await get(b.ownerUserId)).view.kind).toBe('in_progress');
    const uploadsAvant = etat.uploads.length;
    expect(uploadsAvant - u0).toBe(1); // partie 2 déjà déposée
    etat.readFail.clear();
    await sql`UPDATE gdpr_exports SET next_attempt_at = now() WHERE id = ${Number(rb.id)}`;
    await drain();
    rb = await latest(b.ownerUserId);
    expect(rb.status).toBe('ready');
    expect(rb.completeness).toBe('complete');
    expect(etat.uploads.length - uploadsAvant).toBe(1); // seule la partie 1 renvoyée

    // c) Dépôt impossible à chaque tentative : ÉCHEC explicite, code et référence.
    const c = await compte(1);
    etat.uploadFail = 100;
    await post(c.ownerUserId);
    for (let i = 0; i < 3; i++) {
      await drain();
      await sql`UPDATE gdpr_exports SET next_attempt_at = now() WHERE user_id = ${c.ownerUserId} AND status = 'pending'`;
    }
    const rc = await latest(c.ownerUserId);
    expect(rc.status).toBe('error');
    expect(rc.error_code).toBe('STORAGE_UNAVAILABLE');
    expect(rc.attempt_count).toBe(3);
    const bc = await get(c.ownerUserId);
    expect(bc.view.kind).toBe('interrupted');
    expect(bc.view.canRequest).toBe(true);
    expect(bc.view.reference).toBe(String(rc.correlation_id).replace(/-/g, '').slice(0, 8).toUpperCase());
    expect(JSON.stringify(bc)).not.toMatch(/TIMEOUT|dépôt/); // aucun détail technique pour l'utilisateur
    const [reg] = await sql<Json[]>`SELECT status, last_error FROM gdpr_requests WHERE subject_user_ref = ${c.ownerUserId}`;
    expect(reg.status).toBe('in_progress');
    expect(reg.last_error).toMatch(/STORAGE_UNAVAILABLE/);
    // Relance : même demande du registre ; deuxième échec → orientation vers l'assistance.
    await post(c.ownerUserId);
    for (let i = 0; i < 3; i++) {
      await drain();
      await sql`UPDATE gdpr_exports SET next_attempt_at = now() WHERE user_id = ${c.ownerUserId} AND status = 'pending'`;
    }
    const bc2 = await get(c.ownerUserId);
    expect(bc2.view.kind).toBe('needs_support');
    expect(bc2.view.canRequest).toBe(false);
    expect((await sql`SELECT id FROM gdpr_requests WHERE subject_user_ref = ${c.ownerUserId}`)).toHaveLength(1);

    // Supervision : UNE anomalie compacte, détail par export (référence, code, tentatives).
    const sup = await import('@/services/gdpr/gdpr-export-supervision');
    const cond = sup.gdprSupervisionCondition(await sup.collectGdprIssueRows());
    expect(cond).not.toBeNull();
    expect(cond!.title).toMatch(/Export RGPD « Mes données »/);
    const detail = cond!.detail as Json;
    const mine = (detail.exports as Json[]).filter((e) => e.utilisateur === c.ownerUserId);
    expect(mine.length).toBeGreaterThanOrEqual(1);
    expect(mine[0]).toMatchObject({ nature: 'echec', code: 'STORAGE_UNAVAILABLE', tentatives: 3 });
    expect(mine[0].reference).toMatch(/^[0-9A-F]{8}$/);
    expect((detail.exports as Json[]).some((e) => e.utilisateur === a.ownerUserId && e.nature === 'partiel')).toBe(true);
    expect(JSON.stringify(detail)).not.toMatch(/s3\.e2e|password|token/i);
    // Balayage réel : anomalie unique ouverte dans le domaine « Exports ».
    const { runSupervisionSweep } = await import('@/services/admin/supervision-sweep.service');
    await runSupervisionSweep();
    const anomalies = await sql<Json[]>`SELECT title, domain FROM admin_anomalies WHERE fingerprint LIKE 'exports:gdpr%' AND status = 'open'`;
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].domain).toBe('exports');
  });

  it('L103C-E2E-07 — isolation : Premium Duo et téléchargement intercompte', async () => {
    const acc = await compte(1, { plan: 'premium_duo' });
    const membre = await make.user();
    await sql`INSERT INTO account_memberships (account_id, user_id, role, status) VALUES (${acc.id}, ${membre.id}, 'member', 'active')`;
    const asset = await make.asset(acc, { name: 'Maison partagée' });
    const conv = async (userId: number, text: string) => {
      const [c] = await sql<{ id: number }[]>`
        INSERT INTO verebona_conversations (account_id, user_id, expires_at) VALUES (${acc.id}, ${userId}, now() + interval '1 day') RETURNING id`;
      await sql`INSERT INTO verebona_messages (conversation_id, account_id, role, content, expires_at)
                VALUES (${c.id}, ${acc.id}, 'user', ${text}, now() + interval '1 day')`;
      return c.id;
    };
    const convTitulaire = await conv(acc.ownerUserId, 'question privée du titulaire');
    const convMembre = await conv(membre.id, 'question privée du membre');

    await post(membre.id);
    await drain();
    const z = await zips(membre.id);
    const read = async (t: string) => {
      const f = z[0].file(`donnees/${t}.json`);
      return f ? JSON.parse(await f.async('string')) as Json[] : [];
    };
    expect((await read('users')).map((u) => u.id)).toEqual([membre.id]);
    expect((await read('assets')).map((a) => a.id)).toContain(asset.id);         // espace partagé : exporté
    expect((await read('verebona_conversations')).map((c) => c.id)).toEqual([convMembre]);
    const msgs = await read('verebona_messages');
    expect(msgs.map((m) => m.conversation_id)).toEqual([convMembre]);
    const tout = JSON.stringify(await Promise.all(Object.keys(z[0].files).filter((p) => p.endsWith('.json')).map((p) => z[0].file(p)!.async('string'))));
    expect(tout).not.toContain('question privée du titulaire');
    expect(convTitulaire).toBeGreaterThan(0);

    // Un autre utilisateur ne télécharge jamais l'archive du membre.
    const autre = await compte(0);
    etat.session.userId = autre.ownerUserId;
    const download = (await import('@/app/api/users/me/gdpr-export/download/route')).GET;
    expect((await download(req('/api/users/me/gdpr-export/download'))).status).toBe(404);
    expect((await download(req('/api/users/me/gdpr-export/download?part=2'))).status).toBe(404);
  });
});
