/**
 * APP-PERF-30 / APP-PERF-28 — presign et confirm reprenables et idempotents,
 * sur PostgreSQL réel (index unique 0241, verrou consultatif du compte,
 * file durable T1).
 *
 * Le stockage n'est JAMAIS appelé : l'URL signée est calculée localement
 * (identifiants factices) et la vérification de l'objet est simulée.
 *
 * T-01 : réponse de confirmation perdue puis reprise ⇒ document existant.
 * T-02 : deux confirmations simultanées, même clé ⇒ une opération logique,
 *        un seul travail d'analyse, quota cohérent.
 * T-03 : mise en file échouée après confirmation ⇒ la reprise met en file,
 *        sans document ni analyse doublés.
 */
import { expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';

// Miniatures (APP-PERF-27/06) : file de fond hors périmètre de ce scénario.
// Lancée par la confirmation, elle concurrençait les assertions et
// interrogeait la base après la fin du test.
vi.mock('@/services/documents/thumbnails/thumbnail.service', async (o) => ({
  ...(await o<typeof import('@/services/documents/thumbnails/thumbnail.service')>()),
  enqueueThumbnails: () => undefined,
}));

process.env.OVH_S3_ACCESS_KEY_ID ??= 'e2e';
process.env.OVH_S3_SECRET_ACCESS_KEY ??= 'e2e';
process.env.OVH_S3_BUCKET ??= 'e2e-bucket';
process.env.OVH_S3_ENDPOINT ??= 'https://s3.e2e.invalid';

const session = { userId: 0, currentAccountId: 0 };
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ ...session }),
    handleSessionError: () => new Response('unauthorized', { status: 401 }),
  },
}));
const evenements = vi.hoisted(() => ({ emis: [] as unknown[] }));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()),
  emitBusinessEvent: async () => {},
  emitBusinessEvents: async (l: unknown[]) => { evenements.emis.push(...l); },
}));
const credit = vi.hoisted(() => ({ panne: 0 }));
vi.mock('@/services/commercial-model.service', async (o) => ({
  ...(await o<object>()),
  canConsumeAnalysis: async () => {
    if (credit.panne > 0) { credit.panne -= 1; throw new Error('base indisponible (simulée)'); }
    return { allowed: true };
  },
}));
vi.mock('@/services/entitlements.service', async (o) => ({ ...(await o<object>()), canAddDocument: async () => ({ allowed: true }) }));
vi.mock('@/lib/write-access-guard', () => ({ refuserSiLectureSeule: async () => null }));
vi.mock('@/services/document-ai/fusion-detector', () => ({ detectFusionCandidates: async () => [] }));
const objet = vi.hoisted(() => ({ verifier: vi.fn(async () => ({ kind: 'ok' })) }));
vi.mock('@/lib/upload-object-check', () => ({ verificationObjetActive: () => true, verifierObjetDepose: objet.verifier }));

const HASH = 'b'.repeat(64);
const post = (url: string, body: unknown) => new NextRequest(`http://x${url}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const op = () => crypto.randomUUID();

scenario('APP-PERF-30', 'Dépôt reprenable et idempotent (presign, confirm, file T1)', ({ sql, make }) => {
  beforeEach(() => { evenements.emis.length = 0; credit.panne = 0; objet.verifier.mockClear(); });

  const compte = async () => {
    const c = await make.account({ plan: 'premium' });
    session.userId = c.ownerUserId;
    session.currentAccountId = c.id;
    return c;
  };
  const presign = async (body: Record<string, unknown>) => {
    const { POST } = await import('@/app/api/files/presign/route');
    const res = await POST(post('/api/files/presign', {
      filename: 'facture.pdf', mimeType: 'application/pdf', size: 1234, sha256Hash: HASH, assetId: null, ...body,
    }));
    return { status: res.status, body: await res.json() };
  };
  const confirmer = async (body: Record<string, unknown>) => {
    const { POST } = await import('@/app/api/files/confirm/route');
    const res = await POST(post('/api/files/confirm', { documentType: 'FACTURE', supplier: 'EDF', ...body }));
    return { status: res.status, body: await res.json() };
  };
  const jobs = async (fileId: number) => Number((await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM ai_job_queue WHERE treatment = 'T1' AND target_type = 'asset_file' AND target_id = ${String(fileId)}`)[0].n);
  const lignes = async (operationId: string) => sql<{ id: number; upload_status: string; deleted_at: Date | null }[]>`
    SELECT id, upload_status, deleted_at FROM asset_files WHERE upload_operation_id = ${operationId}`;

  it('presign rejoué : même document, nouvelle URL ; même clé + autre fichier ⇒ 409', async () => {
    await compte();
    const id = op();
    const a = await presign({ operationId: id });
    expect(a.status).toBe(201);
    // Endpoint selon la config S3 partagée par les scénarios du même processus.
    expect(a.body.uploadUrl).toMatch(/X-Amz-Signature=/);
    const b = await presign({ operationId: id });
    expect(b).toMatchObject({ status: 200, body: { fileId: a.body.fileId, s3Key: a.body.s3Key, reprise: true, uploadStatus: 'PENDING' } });
    expect(await presign({ operationId: id, size: 9999 })).toMatchObject({ status: 409, body: { error: 'IDEMPOTENCY_KEY_REUSED' } });
    expect(await lignes(id)).toHaveLength(1);
  });

  it('presign simultanés, même clé : une seule ligne (verrou + relecture ; index unique 0242_idx_1 en filet)', async () => {
    await compte();
    const id = op();
    const [a, b] = await Promise.all([presign({ operationId: id }), presign({ operationId: id })]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.fileId).toBe(b.body.fileId);
    expect(await lignes(id)).toHaveLength(1);
  });

  it('lot 24b : SANS l’index unique 0242_idx_1 (optionnel, construction différée) — ni doublon ni 500', async () => {
    await sql.unsafe(`DROP INDEX IF EXISTS asset_files_user_upload_operation_uidx`);
    try {
      await compte();
      // presign simultanés, même clé : sérialisés par le verrou de l'opération, relecture avant insertion.
      const id = op();
      const rs = await Promise.all(Array.from({ length: 6 }, () => presign({ operationId: id })));
      expect(rs.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 201]);
      expect(new Set(rs.map((r) => r.body.fileId)).size).toBe(1);
      expect(await lignes(id)).toHaveLength(1);

      // Clé attachée à la confirmation d'un dépôt préparé sans clé, alors qu'une
      // autre ligne la porte déjà : 409 explicite, rien n'est réécrit.
      const { body: sansCle } = await presign({});
      expect(await confirmer({ fileId: sansCle.fileId, operationId: id }))
        .toMatchObject({ status: 409, body: { code: 'IDEMPOTENCY_KEY_REUSED' } });
      expect(await lignes(id)).toHaveLength(1);
      // Clé neuve : acceptée normalement.
      const neuve = op();
      expect((await confirmer({ fileId: sansCle.fileId, operationId: neuve })).status).toBe(200);
      expect(await lignes(neuve)).toHaveLength(1);
    } finally {
      await sql.unsafe(
        `CREATE UNIQUE INDEX IF NOT EXISTS asset_files_user_upload_operation_uidx ON asset_files (user_id, upload_operation_id) WHERE upload_operation_id IS NOT NULL`,
      );
    }
  });

  it('T-01 : réponse de confirmation perdue, rejeu ⇒ document existant, ni événement ni analyse en plus', async () => {
    await compte();
    const id = op();
    const { body: p } = await presign({ operationId: id });
    const premier = await confirmer({ fileId: p.fileId, operationId: id });
    expect(premier).toMatchObject({ status: 200, body: { success: true, file: { id: p.fileId, uploadStatus: 'COMPLETED' } } });
    expect(premier.body.replay).toBeUndefined();

    // La réponse « s'est perdue » : le client rejoue la même confirmation.
    const rejeu = await confirmer({ fileId: p.fileId, operationId: id });
    expect(rejeu).toMatchObject({ status: 200, body: { replay: true, file: { id: p.fileId, uploadStatus: 'COMPLETED' } } });
    // Le presign rejoué ensuite annonce « déjà confirmé » (aucun renvoi).
    expect(await presign({ operationId: id })).toMatchObject({ status: 200, body: { fileId: p.fileId, uploadStatus: 'COMPLETED' } });

    expect(evenements.emis).toHaveLength(1);
    expect(await jobs(p.fileId)).toBe(1);
    expect(await lignes(id)).toHaveLength(1);
    // Mêmes clé et fichier, autres métadonnées : refus, rien n'est réécrit.
    expect(await confirmer({ fileId: p.fileId, operationId: id, supplier: 'Engie' }))
      .toMatchObject({ status: 409, body: { code: 'IDEMPOTENCY_PAYLOAD_MISMATCH' } });
    const [f] = await sql<{ supplier: string }[]>`SELECT supplier FROM asset_files WHERE id = ${p.fileId}`;
    expect(f.supplier).toBe('EDF');
  });

  it('T-02 : deux confirmations simultanées ⇒ une opération, un travail, quota compté une fois', async () => {
    const c = await compte();
    const id = op();
    const { body: p } = await presign({ operationId: id });
    const [a, b] = await Promise.all([
      confirmer({ fileId: p.fileId, operationId: id }),
      confirmer({ fileId: p.fileId, operationId: id }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect([a.body.replay, b.body.replay].filter(Boolean)).toHaveLength(1);
    expect(evenements.emis).toHaveLength(1);
    expect(await jobs(p.fileId)).toBe(1);
    const [{ total }] = await sql<{ total: number }[]>`
      SELECT coalesce(sum(size), 0)::int AS total FROM asset_files
       WHERE account_id = ${c.id} AND upload_status = 'COMPLETED' AND deleted_at IS NULL`;
    expect(total).toBe(1234);
  });

  it('T-03 : mise en file échouée après confirmation ⇒ le rejeu la reprend, sans doublon', async () => {
    await compte();
    const id = op();
    const { body: p } = await presign({ operationId: id });
    credit.panne = 1; // la mise en file échoue APRÈS le passage en COMPLETED
    expect((await confirmer({ fileId: p.fileId, operationId: id })).status).toBe(200);
    expect(await jobs(p.fileId)).toBe(0);
    const [avant] = await sql<{ analysis_state: string | null }[]>`SELECT analysis_state FROM asset_files WHERE id = ${p.fileId}`;
    expect(avant.analysis_state).toBeNull(); // repris aussi par `analysis-recovery`

    expect(await confirmer({ fileId: p.fileId, operationId: id })).toMatchObject({ status: 200, body: { replay: true } });
    expect(await jobs(p.fileId)).toBe(1);
    // Un rejeu de plus ne crée ni travail ni document.
    await confirmer({ fileId: p.fileId, operationId: id });
    expect(await jobs(p.fileId)).toBe(1);
    expect(evenements.emis).toHaveLength(1);
  });

  it('CA-03 : confirmation depuis un autre compte refusée ; objet absent ⇒ 409, rien de confirmé', async () => {
    await compte();
    const id = op();
    const { body: p } = await presign({ operationId: id });

    const autre = await make.account();
    session.currentAccountId = autre.id; // même utilisateur, autre compte courant
    expect(await confirmer({ fileId: p.fileId, operationId: id })).toMatchObject({ status: 403, body: { code: 'FORBIDDEN' } });
    session.userId = autre.ownerUserId;
    expect(await confirmer({ fileId: p.fileId, operationId: id })).toMatchObject({ status: 403 });

    const [moi] = await sql<{ user_id: number; account_id: number }[]>`SELECT user_id, account_id FROM asset_files WHERE id = ${p.fileId}`;
    session.userId = moi.user_id;
    session.currentAccountId = moi.account_id;
    objet.verifier.mockResolvedValueOnce({ kind: 'absent' } as never);
    expect(await confirmer({ fileId: p.fileId, operationId: id })).toMatchObject({ status: 409, body: { code: 'OBJECT_MISSING' } });
    expect((await lignes(id))[0].upload_status).toBe('PENDING');
    // L'objet arrive (nouveau transfert) : la même opération se confirme.
    expect((await confirmer({ fileId: p.fileId, operationId: id })).status).toBe(200);
  });

  it('objet de taille différente : dépôt écarté, opération close', async () => {
    await compte();
    const id = op();
    const { body: p } = await presign({ operationId: id });
    objet.verifier.mockResolvedValueOnce({ kind: 'taille', attendue: 1234, reelle: 99_999_999 } as never);
    expect(await confirmer({ fileId: p.fileId, operationId: id })).toMatchObject({ status: 422, body: { code: 'OBJECT_MISMATCH' } });
    const [l] = await lignes(id);
    expect(l.deleted_at).not.toBeNull();
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM pending_blob_deletions WHERE file_id = ${p.fileId}`;
    expect(n).toBe(1);
    expect(await confirmer({ fileId: p.fileId, operationId: id })).toMatchObject({ status: 409, body: { code: 'FILE_DISCARDED' } });
    expect(await presign({ operationId: id })).toMatchObject({ status: 409, body: { error: 'OPERATION_CLOSED' } });
  });

  it('client antérieur (sans clé) : presign puis confirm inchangés', async () => {
    await compte();
    const { status, body: p } = await presign({});
    expect(status).toBe(201);
    expect((await confirmer({ fileId: p.fileId })).status).toBe(200);
    expect(await confirmer({ fileId: p.fileId })).toMatchObject({ status: 400, body: { code: 'INVALID_STATUS' } });
  });

  it('migration 0241 : plus aucune empreinte de repli', async () => {
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM asset_files WHERE sha256_hash = 'placeholder-hash'`;
    expect(n).toBe(0);
  });
});
