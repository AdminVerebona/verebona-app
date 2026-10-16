/**
 * Lot 65A — purge S3 des fichiers supprimés depuis plus de 30 jours, branchée
 * sur la tâche planifiée interne `deleted-files-purge` (décision PO du 16/10),
 * sur PostgreSQL 16 réel, S3 SIMULÉ.
 *
 * L65-PURGE-E2E-01 Fichier supprimé il y a 31 jours : objet S3 et versions
 *                  supprimés, ligne supprimée, miniature confiée à la file de
 *                  purge (déclencheur 0241), lien fournisseur détaché.
 * L65-PURGE-E2E-02 Jamais touchés : fichier vivant, supprimé il y a 29 jours,
 *                  source secondaire d'un document vivant ou supprimé depuis
 *                  moins de 30 jours ; secondaire d'un principal purgé : purgée
 *                  ensuite.
 * L65-PURGE-E2E-03 Objet encore référencé : autre ligne (copie de transmission
 *                  en repli, autre compte) ou vignette de bien promue — la
 *                  ligne part, l'objet reste.
 * L65-PURGE-E2E-04 Erreurs S3 : panne → ligne conservée, échec tracé, pas de
 *                  nouvelle tentative dans le même passage (reprise au
 *                  suivant) ; objet déjà absent
 *                  (404) → acquis ; lots bornés et idempotence.
 * L65-PURGE-E2E-05 Tâche planifiée : exécution par le moteur (bail),
 *                  compte rendu visible dans le BO, suspension / réactivation
 *                  depuis le BO (journalisées), tâche critique non suspendable,
 *                  tâche suspendue ni planifiée ni exécutable.
 * L65-PURGE-E2E-06 File `pending_blob_deletions` : objet encore utilisé par une
 *                  autre ligne → demande close sans suppression ; la ligne
 *                  d'origine de la demande (dépôt écarté) ne compte pas.
 * L65-PURGE-E2E-07 Purge d'un compte : versions, dossiers d'export et vignette
 *                  de bien téléversée confiés à la file (plus d'objets
 *                  orphelins) ; une clé partagée avec un autre compte reste.
 */
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import { uid } from '../factories';

const APP = 'https://app.e2e.verebona.test';
const s3 = vi.hoisted(() => ({
  deleted: [] as Array<{ bucket: string; key: string }>,
  /** Clés dont la suppression échoue (panne) ou qui sont déjà absentes. */
  failing: new Set<string>(),
  missing: new Set<string>(),
}));

// S3 simulé pour la tâche planifiée (client « worker » de la configuration centrale).
vi.mock('@/lib/s3-config', async (orig) => ({
  ...(await orig<typeof import('@/lib/s3-config')>()),
  isS3Configured: () => true,
  getS3Bucket: () => 'bucket-e2e',
  getS3Client: () => ({
    send: async (cmd: { input: { Bucket: string; Key: string } }) => {
      const { Bucket, Key } = cmd.input;
      if (s3.failing.has(Key)) throw Object.assign(new Error('ServiceUnavailable'), { $metadata: { httpStatusCode: 503 } });
      if (s3.missing.has(Key)) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
      s3.deleted.push({ bucket: Bucket, key: Key });
      return {};
    },
  }),
}));
afterAll(() => { s3.failing.clear(); s3.missing.clear(); });

const DAY = 24 * 60 * 60 * 1000;

function req(path: string, init: { body?: unknown; cookie?: string; method?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', origin: APP, host: 'app.e2e.verebona.test' };
  if (init.cookie) headers.cookie = init.cookie;
  return new NextRequest(`${APP}${path}`, {
    method: init.method ?? 'POST', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

scenario('L65-PURGE', 'Stockage : purge sûre des fichiers supprimés depuis plus de 30 jours', ({ sql, make }) => {
  beforeEach(() => { s3.deleted.length = 0; s3.failing.clear(); s3.missing.clear(); });

  /** Fichier d'un compte, supprimé il y a `days` jours (null = vivant). */
  async function fichier(acc: { id: number; ownerUserId: number }, days: number | null, over: { key?: string; bucket?: string | null } = {}) {
    const key = over.key ?? `verebona/u_${acc.ownerUserId}/${uid('f')}.pdf`;
    const [f] = await sql<{ id: number }[]>`
      INSERT INTO asset_files (user_id, account_id, s3_key, s3_bucket, mime_type, upload_status, deleted_at)
      VALUES (${acc.ownerUserId}, ${acc.id}, ${key}, ${over.bucket === undefined ? 'bucket-e2e' : over.bucket}, 'application/pdf', 'COMPLETED',
              ${days === null ? null : new Date(Date.now() - days * DAY).toISOString()}::timestamptz)
      RETURNING id`;
    return { id: f.id, key };
  }
  const existe = async (id: number) => (await sql`SELECT 1 FROM asset_files WHERE id = ${id}`).length === 1;
  const purge = async (opts: Record<string, unknown> = {}) => (await import('@/lib/cleanup-job')).runCleanupJob(opts);
  /** Purge limitée aux fichiers de ce test : les autres scénarios partagent la base. */
  const isolate = async (ids: number[]) => {
    await sql`UPDATE asset_files SET purge_last_attempt_at = now() + interval '1 hour'
               WHERE deleted_at IS NOT NULL AND NOT (id = ANY(${ids}))`;
  };
  const deletedKeys = () => s3.deleted.map((d) => d.key);

  it('L65-PURGE-E2E-01 — supprimé depuis 31 jours : objet, versions et ligne supprimés ; miniature en file ; fournisseur détaché', async () => {
    const acc = await make.account();
    const f = await fichier(acc, 31);
    const vKey = `${f.key}.v1`;
    await sql`INSERT INTO document_versions (file_id, account_id, user_id, version_number, s3_key, s3_bucket, s3_region, file_size, sha256_hash)
              VALUES (${f.id}, ${acc.id}, ${acc.ownerUserId}, 1, ${vKey}, 'bucket-e2e', 'gra', 10, 'h')`;
    const thumbKey = `derivatives/${uid('t')}.webp`;
    await sql`INSERT INTO asset_file_thumbnails (file_id, account_id, source_key, status, s3_key)
              VALUES (${f.id}, ${acc.id}, ${f.key}, 'READY', ${thumbKey})`;
    const bien = await make.asset(acc);
    const [eq] = await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name) VALUES (${bien.id}, 'Chaudière') RETURNING id`;
    const [sup] = await sql<{ id: number }[]>`INSERT INTO suppliers (account_id, created_by_user_id, name, normalized_name)
              VALUES (${acc.id}, ${acc.ownerUserId}, 'Plombier', ${uid('plombier')}) RETURNING id`;
    await sql`INSERT INTO equipment_suppliers (equipment_id, supplier_id, source_document_id) VALUES (${eq.id}, ${sup.id}, ${f.id})`;
    await isolate([f.id]);

    const r = await purge();
    expect(r).toMatchObject({ success: true, filesDeletedFromDB: 1, filesDeletedFromS3: 2, filesRetained: 0, objectsKeptShared: 0 });
    expect(s3.deleted).toEqual(expect.arrayContaining([{ bucket: 'bucket-e2e', key: f.key }, { bucket: 'bucket-e2e', key: vKey }]));
    expect(await existe(f.id)).toBe(false);
    expect(await sql`SELECT 1 FROM document_versions WHERE file_id = ${f.id}`).toHaveLength(0);
    // Miniature : supprimée par la cascade, son objet confié à la file de purge.
    expect(await sql`SELECT 1 FROM pending_blob_deletions WHERE storage_path = ${thumbKey} AND processed_at IS NULL`).toHaveLength(1);
    // Lien fournisseur conservé, détaché du document purgé.
    const [es] = await sql`SELECT source_document_id FROM equipment_suppliers WHERE equipment_id = ${eq.id}`;
    expect(es.source_document_id).toBeNull();

    // Rejoué : plus rien.
    s3.deleted.length = 0;
    expect(await purge()).toMatchObject({ filesDeletedFromDB: 0, filesDeletedFromS3: 0 });
    expect(s3.deleted).toHaveLength(0);
  });

  it('L65-PURGE-E2E-02 — vivant, < 30 jours, secondaires protégées : jamais touchés', async () => {
    const acc = await make.account();
    const vivant = await fichier(acc, null);
    const recent = await fichier(acc, 29);
    // Source secondaire masquée (deleted_at ancien) d'un principal VIVANT.
    const lead = await fichier(acc, null);
    const sec = await fichier(acc, 120);
    await sql`UPDATE asset_files SET grouped_into_file_id = ${lead.id}, grouped_at = deleted_at WHERE id = ${sec.id}`;
    // Secondaire d'un principal supprimé il y a 10 jours : protégée aussi.
    const lead2 = await fichier(acc, 10);
    const sec2 = await fichier(acc, 90);
    await sql`UPDATE asset_files SET grouped_into_file_id = ${lead2.id}, grouped_at = deleted_at WHERE id = ${sec2.id}`;
    // Principal supprimé il y a 40 jours : principal puis secondaire purgés.
    const lead3 = await fichier(acc, 40);
    const sec3 = await fichier(acc, 90);
    await sql`UPDATE asset_files SET grouped_into_file_id = ${lead3.id}, grouped_at = deleted_at WHERE id = ${sec3.id}`;
    await isolate([vivant.id, recent.id, lead.id, sec.id, lead2.id, sec2.id, lead3.id, sec3.id]);

    await purge();
    await purge(); // la secondaire devient autonome quand son principal part
    for (const f of [vivant, recent, lead, sec, lead2, sec2]) expect(await existe(f.id), String(f.id)).toBe(true);
    for (const f of [vivant, recent, lead, sec, lead2, sec2]) expect(deletedKeys()).not.toContain(f.key);
    expect(await existe(lead3.id)).toBe(false);
    expect(await existe(sec3.id)).toBe(false);
    expect(deletedKeys()).toEqual(expect.arrayContaining([lead3.key, sec3.key]));
  });

  it('L65-PURGE-E2E-03 — objet encore référencé (autre compte, vignette de bien) : la ligne part, l’objet reste', async () => {
    const a = await make.account();
    const b = await make.account();
    // Transmission dont la copie S3 a échoué : le destinataire garde la clé source.
    const source = await fichier(a, 45);
    const copie = await fichier(b, null, { key: source.key });
    // Vignette de bien promue depuis un document ensuite supprimé.
    const photo = await fichier(a, 45);
    const bien = await make.asset(a);
    await sql`UPDATE assets SET thumbnail_url = ${photo.key} WHERE id = ${bien.id}`;
    // Deux lignes supprimées partageant une clé : l'objet part avec la dernière.
    const k = `verebona/partage/${uid('k')}.pdf`;
    const d1 = await fichier(a, 50, { key: k });
    const d2 = await fichier(a, 50, { key: k });
    await isolate([source.id, photo.id, d1.id, d2.id]);

    const r = await purge();
    expect(await existe(source.id)).toBe(false);
    expect(await existe(photo.id)).toBe(false);
    expect(await existe(copie.id)).toBe(true);
    expect(deletedKeys()).not.toContain(source.key);
    expect(deletedKeys()).not.toContain(photo.key);
    expect(deletedKeys().filter((x) => x === k)).toHaveLength(1);
    expect(await existe(d1.id)).toBe(false);
    expect(await existe(d2.id)).toBe(false);
    expect(r.objectsKeptShared).toBe(3);
  });

  it('L65-PURGE-E2E-04 — panne S3 : ligne conservée et tracée, reprise au passage suivant ; 404 acquis ; lots bornés', async () => {
    const acc = await make.account();
    const panne = await fichier(acc, 60);
    const absent = await fichier(acc, 60);
    const sansBucket = await fichier(acc, 60, { bucket: null });
    s3.failing.add(panne.key);
    s3.missing.add(absent.key);
    await isolate([panne.id, absent.id, sansBucket.id]);

    const r1 = await purge({ batchSize: 1, maxBatches: 10 });
    expect(r1).toMatchObject({ success: false, filesRetained: 1, filesDeletedFromDB: 2 });
    expect(await existe(panne.id)).toBe(true);
    expect(await existe(absent.id)).toBe(false);
    expect(await existe(sansBucket.id)).toBe(false);
    expect(s3.deleted).toEqual(expect.arrayContaining([{ bucket: 'bucket-e2e', key: sansBucket.key }]));
    const [t] = await sql<{ purge_attempts: number; purge_last_error: string | null; deleted_at: Date }[]>`
      SELECT purge_attempts, purge_last_error, deleted_at FROM asset_files WHERE id = ${panne.id}`;
    expect(t.purge_attempts).toBe(1);
    expect(t.purge_last_error).toMatch(/ServiceUnavailable/);
    expect(t.deleted_at).not.toBeNull();
    const { cleanupNote } = await import('@/lib/cleanup-job');
    expect(cleanupNote(r1)).toMatch(/1 en échec S3/);
    expect(cleanupNote(r1)).not.toContain(panne.key);

    // Dans un même passage (lots de 1, 10 lots), le fichier en échec n'a été
    // tenté qu'UNE fois (r1.filesRetained = 1). Passage suivant, S3 toujours
    // en panne : nouvelle tentative, comptée.
    const r2 = await purge();
    expect(r2.filesRetained).toBe(1);
    expect((await sql`SELECT purge_attempts FROM asset_files WHERE id = ${panne.id}`)[0].purge_attempts).toBe(2);

    // Passage suivant, S3 rétabli : purgé.
    s3.failing.clear();
    await sql`UPDATE asset_files SET purge_last_attempt_at = now() - interval '1 day' WHERE id = ${panne.id}`;
    const r3 = await purge();
    expect(r3.filesDeletedFromDB).toBe(1);
    expect(await existe(panne.id)).toBe(false);

    // Bornes : 3 fichiers, lots de 1, 2 lots au plus → il en reste.
    const fs = [await fichier(acc, 70), await fichier(acc, 70), await fichier(acc, 70)];
    await isolate(fs.map((f) => f.id));
    const r4 = await purge({ batchSize: 1, maxBatches: 2 });
    expect(r4).toMatchObject({ filesDeletedFromDB: 2, more: true });
    expect((await purge()).filesDeletedFromDB).toBe(1);
  });

  it('L65-PURGE-E2E-05 — tâche planifiée : moteur, compte rendu BO, suspension depuis le BO', async () => {
    const acc = await make.account();
    const f = await fichier(acc, 33);
    await isolate([f.id]);
    const { SCHEDULED_TASKS } = await import('@/services/scheduling/scheduled-tasks.catalog');
    const def = SCHEDULED_TASKS.find((t) => t.code === 'deleted-files-purge')!;
    expect(def).toMatchObject({ schedule: { kind: 'daily', at: [6, 25] } });
    expect(def.critical).toBeUndefined();

    const { runTaskNow } = await import('@/services/scheduling/scheduled-task-runner');
    const r = await runTaskNow('deleted-files-purge', { waitMs: 30_000 });
    expect(r).toMatchObject({ status: 'finished', outcome: { status: 'ok' } });
    expect(await existe(f.id)).toBe(false);
    expect(deletedKeys()).toContain(f.key);
    const [st] = await sql<{ last_note: string; last_status: string }[]>`SELECT last_note, last_status FROM scheduled_task_state WHERE code = 'deleted-files-purge'`;
    expect(st.last_status).toBe('ok');
    expect(st.last_note).toMatch(/1 fichier\(s\) purgé\(s\) ; 1 objet\(s\) supprimé\(s\) du stockage/);
    expect(st.last_note).not.toContain(f.key);

    // BO : liste avec compte rendu, suspension confirmée et journalisée.
    const admin = await make.user({ email: `${uid('adm65p')}@verebona.test`, role: 'ADMIN' });
    await sql`UPDATE users SET role = 'ADMIN', is_active = true, status = 'ACTIVE' WHERE id = ${admin.id}`;
    const { generateAccessToken } = await import('@/lib/jwt');
    const tok = generateAccessToken({ id: admin.id, email: admin.email, role: 'ADMIN' as never, planType: 'STANDARD' as never, status: 'ACTIVE' as never, hasActiveAccount: true });
    const cookie = `access_token=${await tok}`;
    const { GET } = await import('@/app/api/admin/ops/scheduled-tasks/route');
    const { POST: toggle } = await import('@/app/api/admin/ops/scheduled-tasks/[code]/enabled/route');
    const { POST: run } = await import('@/app/api/admin/ops/scheduled-tasks/[code]/run/route');
    const bascule = (code: string, body: unknown) => toggle(req(`/api/admin/ops/scheduled-tasks/${code}/enabled`, { body, cookie }), { params: Promise.resolve({ code }) });
    const lancer = (code: string) => run(req(`/api/admin/ops/scheduled-tasks/${code}/run`, { body: {}, cookie }), { params: Promise.resolve({ code }) });
    const vue = async () => (await (await GET(req('/api/admin/ops/scheduled-tasks', { method: 'GET', cookie }))).json())
      .tasks.find((t: { code: string }) => t.code === 'deleted-files-purge');

    expect(await vue()).toMatchObject({ enabled: true, adminDisabled: false, adminToggle: true, lastNote: expect.stringMatching(/purgé/) });
    expect((await bascule('deleted-files-purge', { enabled: false })).status).toBe(400); // confirmation exigée
    const off = await bascule('deleted-files-purge', { enabled: false, confirmed: true, reason: 'Vérification' });
    expect(off.status).toBe(200);
    expect((await off.json()).task).toMatchObject({ enabled: false, adminDisabled: true });
    // Suspendue : ni exécutable à la main, ni prise par le calendrier.
    const refus = await lancer('deleted-files-purge');
    expect(refus.status).toBe(409);
    expect((await refus.json()).code).toBe('TASK_ADMIN_DISABLED');
    await sql`UPDATE scheduled_task_state SET next_run_at = now() - interval '1 minute' WHERE code = 'deleted-files-purge'`;
    const { pgTaskStateStore } = await import('@/services/scheduling/scheduled-task-state');
    expect((await pgTaskStateStore.due()).map((d) => d.code)).not.toContain('deleted-files-purge');
    expect(await pgTaskStateStore.claim('deleted-files-purge', 'x', 'e2e', 60_000, 'schedule', true)).toBe(false);
    // Tâche critique : jamais suspendue depuis le BO.
    const crit = await bascule('notifications-dispatch', { enabled: false, confirmed: true });
    expect(crit.status).toBe(409);
    expect((await crit.json()).code).toBe('TASK_CRITICAL');
    // Réactivation.
    const on = await bascule('deleted-files-purge', { enabled: true });
    expect(on.status).toBe(200);
    expect((await on.json()).task).toMatchObject({ enabled: true, adminDisabled: false });
    expect((await pgTaskStateStore.due()).map((d) => d.code)).toContain('deleted-files-purge');
    const audits = await sql<{ action_type: string; result: string }[]>`
      SELECT action_type, result FROM admin_audit_log WHERE admin_user_id = ${admin.id} ORDER BY id`;
    expect(audits.map((x) => `${x.action_type}:${x.result}`)).toEqual([
      'SCHEDULED_TASK_DISABLE:SUCCESS', 'SCHEDULED_TASK_RUN:DENIED', 'SCHEDULED_TASK_DISABLE:DENIED', 'SCHEDULED_TASK_ENABLE:SUCCESS',
    ]);
    await sql`UPDATE scheduled_task_state SET next_run_at = now() + interval '1 day' WHERE code = 'deleted-files-purge'`;
  });

  it('L65-PURGE-E2E-06 — file de purge : objet encore utilisé → demande close sans suppression', async () => {
    const a = await make.account();
    const b = await make.account();
    const vivant = await fichier(b, null);
    const ecarte = await fichier(a, 0); // dépôt écarté : la demande vient de sa propre ligne
    const libre = `exports/${uid('x')}.zip`;
    const at = new Date(Date.now() - 1000).toISOString();
    const [p1] = await sql<{ id: number }[]>`INSERT INTO pending_blob_deletions (file_id, storage_path, scheduled_for, created_at)
              VALUES (NULL, ${vivant.key}, ${at}::timestamptz, ${at}::timestamptz) RETURNING id`;
    const [p2] = await sql<{ id: number }[]>`INSERT INTO pending_blob_deletions (file_id, storage_path, scheduled_for, created_at)
              VALUES (${ecarte.id}, ${ecarte.key}, ${at}::timestamptz, ${at}::timestamptz) RETURNING id`;
    const [p3] = await sql<{ id: number }[]>`INSERT INTO pending_blob_deletions (file_id, storage_path, scheduled_for, created_at)
              VALUES (NULL, ${libre}, ${at}::timestamptz, ${at}::timestamptz) RETURNING id`;
    const supprimes: string[] = [];
    const { purgePendingBlobs, KEPT_STILL_REFERENCED } = await import('@/services/storage/blob-purge.service');
    const r = await purgePendingBlobs({ deleteObject: async (k) => { supprimes.push(k); } });
    expect(r.kept).toBeGreaterThanOrEqual(1);
    expect(supprimes).toEqual(expect.arrayContaining([ecarte.key, libre]));
    expect(supprimes).not.toContain(vivant.key);
    const etats = await sql<{ id: number; processed_at: Date | null; error_message: string | null }[]>`
      SELECT id, processed_at, error_message FROM pending_blob_deletions WHERE id = ANY(${[p1.id, p2.id, p3.id]}) ORDER BY id`;
    expect(etats[0]).toMatchObject({ error_message: KEPT_STILL_REFERENCED });
    expect(etats[0].processed_at).not.toBeNull();
    expect(etats[1]).toMatchObject({ error_message: null });
    expect(etats[2]).toMatchObject({ error_message: null });
  });

  it('L65-PURGE-E2E-07 — purge d’un compte : versions, exports, vignette en file ; clé partagée conservée', async () => {
    const acc = await make.account();
    const autre = await make.account();
    const bien = await make.asset(acc);
    const f = await fichier(acc, null);
    const partage = await fichier(acc, null);
    const copie = await fichier(autre, null, { key: partage.key });
    const vKey = `${f.key}.v1`;
    await sql`INSERT INTO document_versions (file_id, account_id, user_id, version_number, s3_key, s3_bucket, s3_region, file_size, sha256_hash)
              VALUES (${f.id}, ${acc.id}, ${acc.ownerUserId}, 1, ${vKey}, 'bucket-e2e', 'gra', 10, 'h')`;
    const pdf = `exports/${uid('e')}.pdf`;
    await sql`INSERT INTO export_generation (asset_id, account_id, user_id, export_type, status, output_payload)
              VALUES (${bien.id}, ${acc.id}, ${acc.ownerUserId}, 'ASSET_FILE', 'ready', ${JSON.stringify({ pdfS3Key: pdf })})`;
    const vignette = `verebona/u_${acc.ownerUserId}/a_${bien.id}/thumbnail/${uid('v')}.webp`;
    await sql`UPDATE assets SET thumbnail_url = ${vignette} WHERE id = ${bien.id}`;

    const { scheduleDeletion, executeScheduledDeletion } = await import('@/services/account/scheduled-deletion.service');
    const s = await scheduleDeletion({ accountId: acc.id, userId: acc.ownerUserId, reason: 'ADMIN', delayDays: 0 });
    expect((await executeScheduledDeletion(s.id)).status).toBe('executed');
    const enFile = (await sql<{ storage_path: string }[]>`
      SELECT storage_path FROM pending_blob_deletions WHERE processed_at IS NULL
         AND storage_path = ANY(${[f.key, partage.key, vKey, pdf, vignette]})`).map((x) => x.storage_path);
    expect(enFile).toEqual(expect.arrayContaining([f.key, partage.key, vKey, pdf, vignette]));

    const supprimes: string[] = [];
    const { purgePendingBlobs } = await import('@/services/storage/blob-purge.service');
    await purgePendingBlobs({ deleteObject: async (k) => { supprimes.push(k); } });
    expect(supprimes).toEqual(expect.arrayContaining([f.key, vKey, pdf, vignette]));
    expect(supprimes).not.toContain(partage.key);
    expect(await existe(copie.id)).toBe(true);
  });
});
