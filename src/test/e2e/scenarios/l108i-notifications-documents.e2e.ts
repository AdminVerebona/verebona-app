/**
 * Lot 108I — une seule notification maximum par document pour le cycle
 * normal d'import et d'analyse, sur PostgreSQL 16 réel (pipeline T1 et file
 * durable réels, sorties modèle rejouées).
 *
 *   L108I-E2E-01 ajout : la route de signalement (interface ancienne) ne crée
 *                plus rien ; la route historique « notify-analyzed » non plus ;
 *   L108I-E2E-02 analyse asynchrone NON suivie : UNE notification « analysé »
 *                (clé stable document × T1) qui ouvre le document ; la
 *                réanalyse technique (relance T1 de la récupération des
 *                montants, 108B) puis une réanalyse demandée réussissent sans
 *                aucune nouvelle notification (lots `silent`, motif tracé) ;
 *   L108I-E2E-03 analyse SUIVIE dans l'application (relève visible du bandeau
 *                `GET …/analysis-status?suivi=1`) : aucune notification, motif
 *                `followed_in_app` ; relève masquée, autre compte, autre
 *                membre : aucun suivi posé (sans fuite) ;
 *   L108I-E2E-04 échec définitif : notifié même si l'analyse est suivie
 *                (action utile) ; historique intact (lignes non réécrites).
 */
import { afterAll, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import { sortieT1, useTargetState } from '../chain';

const session = vi.hoisted(() => ({ userId: 0, currentAccountId: 0 as number | null }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    handleSessionError: (e: unknown) => { throw e; },
  },
}));
vi.mock('@/lib/auth-guards', async (o) => ({
  ...(await o<object>()),
  getSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
}));

scenario('L108I', 'Notifications des documents : une seule maximum par document', ({ sql, make, useRecordings: enregistrer }) => {
  useTargetState();
  type Compte = Awaited<ReturnType<typeof make.account>>;
  const as = (c: Compte, userId = c.ownerUserId) => { session.userId = userId; session.currentAccountId = c.id; };

  const ecartes: number[] = [];
  const ecarterLesAutresJobsT1 = async () => {
    const rows = await sql<{ id: number }[]>`
      UPDATE ai_job_queue SET available_at = now() + interval '1 day'
       WHERE treatment = 'T1' AND status = 'PENDING' AND available_at <= now() RETURNING id`;
    ecartes.push(...rows.map((r) => Number(r.id)));
  };
  afterAll(async () => {
    if (ecartes.length) await sql`UPDATE ai_job_queue SET available_at = now() WHERE id = ANY(${ecartes})`;
  });

  const fichier = async (c: Compte, titre: string) => {
    const f = await make.assetFile(c);
    await sql`UPDATE asset_files SET s3_bucket = 'e2e-bucket', original_filename = ${`${titre}.pdf`}, retained_title = ${titre},
                upload_status = 'COMPLETED', analysis_state = NULL WHERE id = ${f.id}`;
    return f;
  };
  const succes = (title: string) => ({
    operationCode: 't1_analyze_document', task: 'ANALYZE_DOCUMENT',
    output: sortieT1({ title, date: '2026-03-14', documentTypeCode: 'MAINTENANCE_INVOICE', assets: [], facts: [] }),
  });
  const resultats = (userId: number) => sql<{ event_type: string; dedupe_key: string; payload_json: Record<string, unknown> }[]>`
    SELECT event_type, dedupe_key, payload_json FROM notification_outbox
     WHERE recipient_user_id = ${userId} AND category = 'documents' ORDER BY created_at, id`;
  const lotsDe = (fileId: number) => sql<{ id: number; notification_state: string; notification_skip_reason: string | null }[]>`
    SELECT l.id, l.notification_state, l.notification_skip_reason FROM document_lots l
      JOIN document_lot_items i ON i.lot_id = l.id WHERE i.asset_file_id = ${fileId} ORDER BY l.id`;
  async function traiter() {
    const { processPending } = await import('@/lib/notifications');
    for (let i = 0; i < 60; i++) {
      const s = await processPending(100);
      const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM notification_outbox
        WHERE status = 'processing' OR (status = 'pending' AND (scheduled_for IS NULL OR scheduled_for <= now()))`;
      if (s.claimed === 0 && n === 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  /** Lot en attente fabriqué (document déjà dans son état d'issue). */
  const lotEnAttente = async (c: Compte, fileIds: number[], o: { followed?: 'now' | 'old' } = {}) => {
    const followed = o.followed === 'now' ? sql`now()` : o.followed === 'old' ? sql`now() - interval '10 minutes'` : sql`NULL`;
    const [lot] = await sql<{ id: number }[]>`INSERT INTO document_lots (account_id, status, notification_state, notification_user_id, followed_at, created_at)
      VALUES (${c.id}, 'committed', 'awaiting', ${c.ownerUserId}, ${followed}, now() - interval '1 hour') RETURNING id`;
    for (const [i, id] of fileIds.entries()) {
      await sql`INSERT INTO document_lot_items (lot_id, asset_file_id, position, analysis_status) VALUES (${lot.id}, ${id}, ${i}, 'completed')`;
    }
    return lot.id;
  };
  const statut = async (fileId: number, query = '') => {
    const { GET } = await import('@/app/api/documents/[id]/analysis-status/route');
    return GET(new NextRequest(`http://localhost/api/documents/${fileId}/analysis-status${query}`), { params: Promise.resolve({ id: String(fileId) }) });
  };

  it('L108I-E2E-01 ajout réussi : aucune notification créée (route de signalement et route historique inertes)', async () => {
    const c = await make.account();
    const f = await fichier(c, 'Facture chaudière');
    as(c);
    const { POST } = await import('@/app/api/documents/upload-notification/route');
    const r = await POST(new NextRequest('http://localhost/api/documents/upload-notification', {
      method: 'POST', body: JSON.stringify({ fileIds: [f.id], lotId: 'lot-108i' }), headers: { 'content-type': 'application/json' },
    }));
    expect(r.status).toBe(202);
    expect(await r.json()).toMatchObject({ emitted: false });
    const { POST: ancien } = await import('@/app/api/documents/[id]/notify-analyzed/route');
    expect((await ancien(new NextRequest(`http://localhost/api/documents/${f.id}/notify-analyzed`, { method: 'POST' }))).status).toBe(202);
    await traiter();
    expect(await resultats(c.ownerUserId)).toEqual([]);
    expect(await sql`SELECT 1 FROM notifications WHERE user_id = ${c.ownerUserId}`).toHaveLength(0);
  });

  it('L108I-E2E-02 asynchrone non suivie : UNE notification ; réanalyse technique (108B) et réanalyse demandée : aucune', async () => {
    await ecarterLesAutresJobsT1();
    const c = await make.account();
    const f = await fichier(c, 'Facture pneus');
    const { enqueueFileAnalyses, registerSourceAnalysisHandler } = await import('@/services/ai/source-analysis/queue/t1-handler');
    const { runOne } = await import('@/services/ai/queue/queue-worker');
    registerSourceAnalysisHandler();

    // Premier dépôt : analyse en file, utilisateur parti (aucune relève).
    await enqueueFileAnalyses([f.id], c.id, { origin: 'files/confirm', userId: c.ownerUserId, processingVisibility: 'USER' });
    await enregistrer([succes('Facture pneus')]);
    expect(await runOne('T1')).toBe(true);
    await traiter();
    let res = await resultats(c.ownerUserId);
    expect(res.map((x) => x.event_type)).toEqual(['DOCUMENT_BATCH_COMPLETED']);
    expect(res[0].dedupe_key).toBe(`document:analysis-success:t1:${f.id}:u${c.ownerUserId}`);
    expect(res[0].payload_json).toMatchObject({ analysedCount: 1, assetFileId: f.id });
    const { getCatalogEntry } = await import('@/lib/notifications/catalog');
    expect(getCatalogEntry('DOCUMENT_BATCH_COMPLETED')!.deepLink(res[0].payload_json)).toContain(`document%3A${f.id}`);

    // Relance T1 de la récupération des montants (108B, technique) : réussie, muette.
    const { AMOUNT_RECOVERY_T1_ORIGIN } = await import('@/services/business-operations/tco/amount-recovery.service');
    await enqueueFileAnalyses([f.id], c.id, { origin: AMOUNT_RECOVERY_T1_ORIGIN, billable: false, processingVisibility: 'TECHNICAL', resume: true });
    await enregistrer([succes('Facture pneus')]);
    expect(await runOne('T1')).toBe(true);
    // Réanalyse demandée depuis la fiche (utilisateur) : réussie, muette aussi (déjà annoncé).
    await enqueueFileAnalyses([f.id], c.id, { origin: 'documents/analyze', userId: c.ownerUserId, processingVisibility: 'USER' });
    await enregistrer([succes('Facture pneus')]);
    expect(await runOne('T1')).toBe(true);
    await traiter();
    res = await resultats(c.ownerUserId);
    expect(res.map((x) => x.event_type)).toEqual(['DOCUMENT_BATCH_COMPLETED']);
    const lots = await lotsDe(f.id);
    expect(lots).toHaveLength(3);
    expect(lots[0].notification_state).toBe('notified');
    expect(lots.slice(1).map((l) => [l.notification_state, l.notification_skip_reason])).toEqual([['silent', 'reanalysis'], ['silent', 'reanalysis']]);
    expect(await sql`SELECT 1 FROM notifications WHERE user_id = ${c.ownerUserId}`).toHaveLength(1);
  });

  it('L108I-E2E-03 analyse suivie (relève visible) : aucune notification ; relève masquée, autre compte, autre membre : aucun suivi', async () => {
    const c = await make.account();
    const autre = await make.account();
    const suivi = await fichier(c, 'Attestation assurance');
    const nonSuivi = await fichier(c, 'Contrat entretien');
    await sql`UPDATE asset_files SET analysis_state = 'ANALYZING' WHERE id IN (${suivi.id}, ${nonSuivi.id})`;
    const lotSuivi = await lotEnAttente(c, [suivi.id]);
    const lotNonSuivi = await lotEnAttente(c, [nonSuivi.id]);

    // Relève masquée (sans `suivi=1`) : rien.
    as(c);
    expect((await statut(nonSuivi.id)).status).toBe(200);
    // Autre compte : 404, aucun suivi posé (pas d'énumération).
    as(autre);
    expect((await statut(suivi.id, '?suivi=1')).status).toBe(404);
    // Membre du compte qui n'est pas le destinataire : aucun suivi.
    as(c, autre.ownerUserId);
    await statut(suivi.id, '?suivi=1');
    const lu = async (id: number) => (await sql<{ f: boolean }[]>`SELECT followed_at IS NOT NULL AS f FROM document_lots WHERE id = ${id}`)[0].f;
    expect(await lu(lotSuivi)).toBe(false);
    expect(await lu(lotNonSuivi)).toBe(false);
    // Destinataire, page visible : suivi posé.
    as(c);
    expect((await statut(suivi.id, '?suivi=1')).status).toBe(200);
    expect(await lu(lotSuivi)).toBe(true);

    await sql`UPDATE asset_files SET analysis_state = 'ANALYZED' WHERE id IN (${suivi.id}, ${nonSuivi.id})`;
    const { settleLotNotificationsForFiles } = await import('@/services/ai/source-analysis/lot-notification');
    await settleLotNotificationsForFiles([suivi.id, nonSuivi.id]);
    await settleLotNotificationsForFiles([suivi.id, nonSuivi.id]); // idempotent
    await traiter();
    const res = await resultats(c.ownerUserId);
    expect(res.map((x) => [x.event_type, (x.payload_json as { assetFileId?: number }).assetFileId])).toEqual([['DOCUMENT_BATCH_COMPLETED', nonSuivi.id]]);
    expect((await sql<{ notification_state: string; notification_skip_reason: string }[]>`
      SELECT notification_state, notification_skip_reason FROM document_lots WHERE id = ${lotSuivi}`)[0])
      .toEqual({ notification_state: 'silent', notification_skip_reason: 'followed_in_app' });

    // Suivi trop ancien (utilisateur parti depuis) : la notification part.
    const ancien = await fichier(c, 'Facture vidange');
    await sql`UPDATE asset_files SET analysis_state = 'ANALYZED' WHERE id = ${ancien.id}`;
    await lotEnAttente(c, [ancien.id], { followed: 'old' });
    await settleLotNotificationsForFiles([ancien.id]);
    await traiter();
    expect((await resultats(c.ownerUserId)).map((x) => (x.payload_json as { assetFileId?: number }).assetFileId)).toEqual([nonSuivi.id, ancien.id]);
  });

  it('L108I-E2E-04 échec définitif suivi : toujours notifié ; historique intact', async () => {
    const c = await make.account();
    const f = await fichier(c, 'Devis toiture');
    // Historique : une ancienne « Document ajouté » (lot 32) reste affichée.
    await sql`INSERT INTO notifications (user_id, type, payload_json, dedupe_key, created_at)
              VALUES (${c.ownerUserId}, 'DOCUMENT_UPLOAD_COMPLETED', ${JSON.stringify({ count: 1, documentTitle: 'Ancien' })}, ${`l108i:hist:${f.id}`}, now() - interval '2 days')`;
    await sql`UPDATE asset_files SET analysis_state = 'ANALYSIS_FAILED', analysis_fail_reason = 'x' WHERE id = ${f.id}`;
    await lotEnAttente(c, [f.id], { followed: 'now' });
    const { settleLotNotificationsForFiles } = await import('@/services/ai/source-analysis/lot-notification');
    await settleLotNotificationsForFiles([f.id]);
    await traiter();
    expect((await resultats(c.ownerUserId)).map((x) => x.event_type)).toEqual(['DOCUMENT_BATCH_FAILED']);

    // Compteur non lu / « Tout lu » : code inchangé (routes non touchées) ;
    // les deux lignes sont là, non lues, l'historique n'est pas réécrit.
    const lignes = await sql<{ type: string; unread: boolean }[]>`
      SELECT type, read_at IS NULL AS unread FROM notifications WHERE user_id = ${c.ownerUserId} ORDER BY created_at`;
    expect(lignes).toEqual([{ type: 'DOCUMENT_UPLOAD_COMPLETED', unread: true }, { type: 'DOCUMENT_BATCH_FAILED', unread: true }]);
  });
});
