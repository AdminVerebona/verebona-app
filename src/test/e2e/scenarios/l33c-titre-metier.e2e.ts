/**
 * Lot 33C — titre MÉTIER des documents sur base réelle (ticket « T1/T3 :
 * garantir le renommage métier des documents et rattraper les documents non
 * renommés »). Critères TITLE-AC1 à TITLE-AC9.
 *
 * Chaîne de production : `analyzeFileSources` (sortie T1 rejouée) → service
 * commun `DocumentTitleService` en fin d'analyse ; rattrapage T3 par
 * `sweepDocumentTitles` (même sélection que les pages planifiées) et par une
 * page réelle de la file durable (`document_title_sweep`).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import { drainQueues, sortieT1, useTargetState } from '../chain';
import type { RecordedOutput } from '../replay-gateway';

const session = vi.hoisted(() => ({ currentAccountId: 0, userId: 0 }));
vi.mock('@/lib/auth-guards', async (o) => ({
  ...(await o<object>()),
  getSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
}));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Compte = { id: number; ownerUserId: number };

const UUID_PDF = '5be5a3ca-38cf-47fc-942c-3386ea8e846b.pdf';
const MARQUE = JSON.stringify({ retainedTitle: true });
const TITRE_T1 = "Certificat d'immatriculation CUPRA LEON E-HYBRID180";

scenario('L33C', 'Titre métier des documents : renommage T1, rattrapage T3, titres utilisateur', ({ sql, make, useRecordings: rejouer }) => {
  useTargetState();

  const sortie = (p: { title?: string; assetId?: number | null } = {}) => sortieT1({
    title: p.title ?? TITRE_T1, date: '2024-04-18', documentTypeCode: 'REGISTRATION_CERTIFICATE', rubricCode: 'PROPERTY_MANAGEMENT',
    assets: p.assetId ? [{ id: p.assetId, label: 'Cupra' }] : [], facts: [], texte: ['GW-200-LE', 'CUPRA LEON E-HYBRID180'], multiAsset: false,
  });

  /** Document déposé sous un nom technique (« <uuid>.pdf »), comme le cas observé. */
  const deposer = async (compte: Compte, assetId: number | null = null) => {
    const doc = await make.assetFile(compte, { assetId });
    await sql`UPDATE asset_files SET original_filename = ${UUID_PDF}, retained_title = ${UUID_PDF}, filename = ${UUID_PDF},
                s3_bucket = 'e2e-bucket' WHERE id = ${doc.id}`;
    return doc;
  };
  const analyser = async (compte: Compte, fileId: number, output: Record<string, unknown>, extra: RecordedOutput[] = []) => {
    await sql`UPDATE asset_files SET analysis_state = NULL WHERE id = ${fileId}`;
    const replay = await rejouer([{ operationCode: 't1_analyze_document', task: 'ANALYZE_DOCUMENT', output, repeat: true }, ...extra]);
    const { analyzeFileSources } = await import('@/services/ai/source-analysis/entrypoint');
    const r = await analyzeFileSources([fileId], compte.id, { userId: compte.ownerUserId, billable: false, origin: 'e2e/l33c' });
    if (!r || r.results.length === 0) throw new Error(`[e2e] analyse du fichier ${fileId} en échec`);
    await drainQueues();
    return replay;
  };
  const fichier = async (fileId: number) => (await sql<{
    retained_title: string | null; title_source: string; original_filename: string | null; filename: string | null; s3_key: string | null;
    updated_at: Date; analysis_state: string | null; title_checked_at: Date | null; ue: Record<string, unknown> | null; last_analysis_at: Date | null;
  }[]>`
    SELECT retained_title, title_source, original_filename, filename, s3_key, updated_at, analysis_state, title_checked_at,
           user_edited_fields AS ue, last_analysis_at
      FROM asset_files WHERE id = ${fileId}`)[0];
  const evenements = async (fileId: number) => sql<{ origin: string; outcome: string; reason: string | null; old_title: string | null; new_title: string | null; created_at: Date }[]>`
    SELECT origin, outcome, reason, old_title, new_title, created_at FROM document_title_events WHERE file_id = ${fileId} ORDER BY id`;
  const runs = async (fileId: number) => Number((await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM document_analysis_runs WHERE asset_file_id = ${fileId}`)[0].n);
  const balayer = async (compte: Compte) => {
    const { sweepDocumentTitles } = await import('@/services/ai/reconciliation/document-title-sweep');
    return sweepDocumentTitles({ accountId: compte.id });
  };
  const service = async () => import('@/services/documents/document-title.service');
  /** État historique : titre technique resté en place (ancienne analyse, ancien tiroir). */
  const historique = async (fileId: number, opts: { marqueTiroir?: boolean } = {}) => {
    await sql`UPDATE asset_files SET retained_title = ${UUID_PDF}, title_source = 'SYSTEM', title_checked_at = NULL,
                user_edited_fields = ${opts.marqueTiroir ? MARQUE : null}::jsonb
              WHERE id = ${fileId}`;
  };

  // ══ T1 — parcours nominal ════════════════════════════════════════════════

  it('TITLE-AC1 / TITLE-AC9 — nouveau document « <uuid>.pdf » analysé : titre métier écrit en fin de T1 (SYSTEM), événement UPDATED origine T1', async () => {
    const compte = await make.account();
    const cupra = await make.asset(compte, { category: 'VEHICULE', name: 'Cupra', registrationNumber: 'GW-200-LE' });
    const doc = await deposer(compte, cupra.id);
    await analyser(compte, doc.id, sortie({ assetId: cupra.id }));
    const f = await fichier(doc.id);
    expect(f.retained_title).toBe(TITRE_T1);
    expect(f.title_source).toBe('SYSTEM');
    // §12 : le fichier stocké n'est pas renommé.
    expect(f.original_filename).toBe(UUID_PDF);
    expect(f.filename).toBe(UUID_PDF);
    expect(f.s3_key).toContain(`e2e/${compte.id}/`);
    expect(await evenements(doc.id)).toEqual([
      expect.objectContaining({ origin: 'T1', outcome: 'UPDATED', reason: 'NON_COMPLIANT_TITLE', old_title: UUID_PDF, new_title: TITRE_T1 }),
    ]);
  });

  it('TITLE-AC1 — le modèle renvoie lui-même le nom technique : titre reconstruit par les règles existantes, jamais l’UUID', async () => {
    const compte = await make.account();
    const doc = await deposer(compte);
    await analyser(compte, doc.id, sortie({ title: UUID_PDF }));
    const f = await fichier(doc.id);
    const { isValidBusinessTitle } = await import('@/lib/documents/document-title-rules');
    expect(f.retained_title).not.toBe(UUID_PDF);
    expect(isValidBusinessTitle(f.retained_title)).toBe(true);
    expect(f.retained_title).toMatch(/avril 2024/i);
  });

  it('TITLE-AC1 — causes racines : marque « titre modifié » posée à tort par l’ancien tiroir ET run dédupliqué ne bloquent plus le renommage T1', async () => {
    const compte = await make.account();
    const doc = await deposer(compte);
    await analyser(compte, doc.id, sortie());
    // Ancien tiroir : nom de fichier réenregistré comme titre + marque « modifié ».
    await historique(doc.id, { marqueTiroir: true });
    const n = await runs(doc.id);
    // Même source, même master : le run est DÉDUPLIQUÉ (persistAnalysisResult n'écrit rien).
    await analyser(compte, doc.id, sortie());
    expect(await runs(doc.id)).toBe(n);
    const f = await fichier(doc.id);
    expect(f.retained_title).toBe(TITRE_T1);
    expect(f.title_source).toBe('SYSTEM');
    expect(f.ue?.retainedTitle).toBeUndefined();
  });

  // ══ T3 — rattrapage ══════════════════════════════════════════════════════

  it('TITLE-AC2 / TITLE-AC3 / TITLE-AC7 / TITLE-AC9 — document historique terminé (rattaché, classé, aucune action T3) resté « <uuid>.pdf » : repris par T3 depuis les données persistées, sans T1', async () => {
    const compte = await make.account();
    const cupra = await make.asset(compte, { category: 'VEHICULE', name: 'Cupra', registrationNumber: 'GW-200-LE' });
    const doc = await deposer(compte, cupra.id);
    await analyser(compte, doc.id, sortie({ assetId: cupra.id }));
    // Tous les autres traitements sont terminés.
    const avant = (await sql<{ asset_id: number | null; rubric_code: string | null; analysis_state: string }[]>`
      SELECT asset_id, rubric_code, analysis_state FROM asset_files WHERE id = ${doc.id}`)[0];
    expect(avant).toMatchObject({ asset_id: cupra.id, rubric_code: 'PROPERTY_MANAGEMENT', analysis_state: 'ANALYZED' });
    expect(await sql`SELECT 1 FROM ai_job_queue WHERE status IN ('PENDING', 'RUNNING') AND target_id = ${String(doc.id)}`).toHaveLength(0);
    await historique(doc.id, { marqueTiroir: true });

    const n = await runs(doc.id);
    const extraction = (await sql<{ extracted_at: Date }[]>`SELECT extracted_at FROM document_extractions WHERE file_id = ${doc.id}`)[0];
    const replay = await rejouer([]);
    const c = await balayer(compte);
    expect(c.UPDATED).toBe(1);
    const f = await fichier(doc.id);
    expect(f.retained_title).toBe(TITRE_T1);
    expect(f.title_source).toBe('SYSTEM');
    // TITLE-AC3 : ni T1, ni OCR, ni nouveau run, ni nouvelle extraction, état inchangé.
    expect(replay.calls).toHaveLength(0);
    expect(await runs(doc.id)).toBe(n);
    expect((await sql<{ extracted_at: Date }[]>`SELECT extracted_at FROM document_extractions WHERE file_id = ${doc.id}`)[0].extracted_at)
      .toEqual(extraction.extracted_at);
    expect(f.analysis_state).toBe('ANALYZED');
    expect((await evenements(doc.id)).at(-1)).toMatchObject({ origin: 'T3', outcome: 'UPDATED', old_title: UUID_PDF, new_title: TITRE_T1 });
  });

  it('TITLE-AC2 — repli sur la représentation durable quand le run n’est plus lisible', async () => {
    const compte = await make.account();
    const doc = await deposer(compte);
    await analyser(compte, doc.id, sortie());
    await historique(doc.id);
    await sql`UPDATE document_analysis_runs SET raw_response_json = '{illisible' WHERE asset_file_id = ${doc.id}`;
    expect((await balayer(compte)).UPDATED).toBe(1);
    expect((await fichier(doc.id)).retained_title).toBe(TITRE_T1);
  });

  it('TITLE-AC6 — second passage : aucune écriture, aucune date modifiée, aucun événement', async () => {
    const compte = await make.account();
    const doc = await deposer(compte);
    await analyser(compte, doc.id, sortie());
    await historique(doc.id);
    expect((await balayer(compte)).UPDATED).toBe(1);
    const apres1 = await fichier(doc.id);
    const ev1 = (await evenements(doc.id)).length;

    const c2 = await balayer(compte);
    expect(c2).toEqual({ UPDATED: 0, NO_CHANGE: 0, SKIP_USER_TITLE: 0, INSUFFICIENT_DATA: 0, FAILED: 0 });
    // Appel direct (comme une page rejouée) : NO_CHANGE (lot 34E), sans écriture.
    const { ensureBusinessTitle } = await service();
    expect(await ensureBusinessTitle({ fileId: doc.id, accountId: compte.id, origin: 'T3', mode: 'repair' }))
      .toMatchObject({ outcome: 'NO_CHANGE' });
    // T1 relancé sur les mêmes données : titre identique → aucune écriture non plus.
    expect(await ensureBusinessTitle({ fileId: doc.id, accountId: compte.id, origin: 'T1', mode: 'refresh' }))
      .toMatchObject({ outcome: 'NO_CHANGE' });
    const apres2 = await fichier(doc.id);
    expect(apres2.updated_at).toEqual(apres1.updated_at);
    expect(apres2.title_checked_at).toEqual(apres1.title_checked_at);
    expect(await evenements(doc.id)).toHaveLength(ev1);
  });

  it('TITLE-AC5 — titre utilisateur jamais remplacé (même technique), par T3 comme par T1', async () => {
    const compte = await make.account();
    const doc = await deposer(compte);
    await analyser(compte, doc.id, sortie());
    await sql`UPDATE asset_files SET retained_title = ${UUID_PDF}, title_source = 'USER' WHERE id = ${doc.id}`;
    expect((await balayer(compte)).UPDATED).toBe(0); // pas même candidat
    const { ensureBusinessTitle } = await service();
    expect(await ensureBusinessTitle({ fileId: doc.id, accountId: compte.id, origin: 'T3', mode: 'repair' })).toMatchObject({ outcome: 'SKIP_USER_TITLE' });
    await analyser(compte, doc.id, sortie());
    const f = await fichier(doc.id);
    expect(f.retained_title).toBe(UUID_PDF);
    expect(f.title_source).toBe('USER');
    expect((await evenements(doc.id)).at(-1)).toMatchObject({ origin: 'T1', outcome: 'SKIP_USER_TITLE' });
  });

  it('TITLE-AC5 — concurrence : renommage utilisateur entre la lecture et l’écriture → le titre utilisateur gagne (compare-and-set)', async () => {
    const compte = await make.account();
    const doc = await deposer(compte);
    await analyser(compte, doc.id, sortie());
    await historique(doc.id);
    const { ensureBusinessTitle, persistTitle } = await service();
    // Le contrôle d'exécution est appelé juste avant l'écriture : l'utilisateur renomme à cet instant.
    const guard = {
      assertActive: async (etape: string) => {
        if (etape === 'titre du document') {
          await sql`UPDATE asset_files SET retained_title = 'Ma carte grise', title_source = 'USER' WHERE id = ${doc.id}`;
        }
      },
    } as never;
    const r = await ensureBusinessTitle({ fileId: doc.id, accountId: compte.id, origin: 'T3', mode: 'repair', guard });
    expect(r).toMatchObject({ outcome: 'SKIP_USER_TITLE', reason: 'CONCURRENT_USER_RENAME' });
    expect((await fichier(doc.id)).retained_title).toBe('Ma carte grise');
    // Écriture directe sur un état périmé : refusée.
    expect(await persistTitle({ fileId: doc.id, accountId: compte.id, expectedTitle: UUID_PDF, newTitle: TITRE_T1 })).toBe(false);
  });

  it('TITLE-AC5 / multi-instances — deux rattrapages simultanés : une seule écriture, un seul événement UPDATED', async () => {
    const compte = await make.account();
    const doc = await deposer(compte);
    await analyser(compte, doc.id, sortie());
    await historique(doc.id);
    const { ensureBusinessTitle } = await service();
    const rs = await Promise.all([1, 2].map(() => ensureBusinessTitle({ fileId: doc.id, accountId: compte.id, origin: 'T3', mode: 'repair' })));
    expect(rs.filter((r) => r.outcome === 'UPDATED')).toHaveLength(1);
    expect(rs.filter((r) => r.outcome === 'NO_CHANGE')).toHaveLength(1);
    expect((await evenements(doc.id)).filter((e) => e.origin === 'T3' && e.outcome === 'UPDATED')).toHaveLength(1);
  });

  it('TITLE-AC5 — historique : titre conforme marqué « modifié » par le tiroir avant le lot = titre utilisateur (promu USER) ; marqué mais technique = réparable', async () => {
    const compte = await make.account();
    const doc = await deposer(compte);
    await analyser(compte, doc.id, sortie());
    await sql`UPDATE asset_files SET retained_title = 'EDF', title_source = 'SYSTEM', user_edited_fields = ${MARQUE}::jsonb WHERE id = ${doc.id}`;
    await analyser(compte, doc.id, sortie());
    expect(await fichier(doc.id)).toMatchObject({ retained_title: 'EDF', title_source: 'USER' });
  });

  it('TITLE-AC5 — migration 0282 : reprise prudente de l’historique (USER si modifié à la main et non technique), rejouable', async () => {
    const compte = await make.account();
    const a = await deposer(compte);
    const b = await deposer(compte);
    const c = await deposer(compte);
    await sql`UPDATE asset_files SET retained_title = 'Carte grise de la Cupra', user_edited_fields = ${MARQUE}::jsonb, title_source = 'SYSTEM' WHERE id = ${a.id}`;
    await sql`UPDATE asset_files SET user_edited_fields = ${MARQUE}::jsonb, title_source = 'SYSTEM' WHERE id = ${b.id}`;
    await sql`UPDATE asset_files SET retained_title = 'Facture garage', original_filename = 'Facture garage', title_source = 'SYSTEM' WHERE id = ${c.id}`;
    await sql`INSERT INTO admin_audit_log (timestamp, admin_user_id, admin_email, action_type, target_type, target_id, details)
              VALUES (now(), ${compte.ownerUserId}, 'user', 'ASSET_UPDATE', 'document', ${c.id}, ${`Nom: "${UUID_PDF}" → "Facture garage"`})`;
    const migration = readFileSync(join(process.cwd(), 'src/db/migrations/0282_document_title_source.sql'), 'utf8');
    await sql.unsafe(migration);
    await sql.unsafe(migration); // idempotente
    expect((await fichier(a.id)).title_source).toBe('USER');
    expect((await fichier(b.id)).title_source).toBe('SYSTEM'); // « <uuid>.pdf » marqué : artefact du tiroir
    expect((await fichier(c.id)).title_source).toBe('USER');
  });

  it('INSUFFICIENT_DATA — sans données exploitables : aucune écriture du titre, événement unique, pas de reprise horaire tant qu’aucune nouvelle analyse', async () => {
    const compte = await make.account();
    const doc = await deposer(compte);
    await sql`UPDATE asset_files SET analysis_state = 'ANALYZED', last_analysis_at = now() - interval '1 hour', document_type = NULL WHERE id = ${doc.id}`;
    const c1 = await balayer(compte);
    expect(c1.INSUFFICIENT_DATA).toBe(1);
    expect((await fichier(doc.id)).retained_title).toBe(UUID_PDF);
    expect(await evenements(doc.id)).toEqual([expect.objectContaining({ origin: 'T3', outcome: 'INSUFFICIENT_DATA' })]);
    expect(await balayer(compte)).toMatchObject({ INSUFFICIENT_DATA: 0 });
    expect(await evenements(doc.id)).toHaveLength(1);
  });

  // ══ Balayage planifié : page réelle de la file T3 ═══════════════════════

  it('TITLE-AC7 — page bornée du rattrapage planifié (contrat 31C) : titre corrigé, continuation unique, démarreur sans cycle concurrent', async () => {
    const compte = await make.account();
    const doc = await deposer(compte);
    await analyser(compte, doc.id, sortie());
    await historique(doc.id);
    const avant = process.env.T3_TITLE_SWEEP_PAGE_SIZE;
    process.env.T3_TITLE_SWEEP_PAGE_SIZE = '1';
    try {
      const { buildT3Payload } = await import('@/services/ai/reconciliation/t3-job-contract');
      const { enqueue } = await import('@/services/ai/queue/job-queue.repository');
      const { startDocumentTitleSweep } = await import('@/services/ai/reconciliation/document-title-sweep');
      const cycle = `e2e-titre-${doc.id}`;
      await enqueue({
        treatment: 'T3', scope: { targetType: 'document_title_sweep', targetId: `${cycle}:0` }, triggerCode: 'schedule_hourly',
        payload: buildT3Payload('document_title_sweep', { cycleId: cycle, page: 0, afterFileId: doc.id - 1 }), onlyIfNeverQueued: true,
      });
      // Une page vit : la racine suivante n'ouvre pas de second cycle.
      await startDocumentTitleSweep({ cycleId: `${cycle}-bis`, triggerCode: 'schedule_hourly', guard: { assertActive: async () => {} } as never });
      expect(await sql`SELECT 1 FROM ai_job_queue WHERE target_type = 'document_title_sweep' AND target_id = ${`${cycle}-bis:0`}`).toHaveLength(0);

      const { runOne } = await import('@/services/ai/queue/queue-worker');
      const etat = async () => (await sql<{ status: string }[]>`
        SELECT status FROM ai_job_queue WHERE target_type = 'document_title_sweep' AND target_id = ${`${cycle}:0`}`)[0]?.status;
      for (let i = 0; i < 5 && (await etat()) !== 'DONE'; i += 1) await runOne('T3');
      const [page0] = await sql<{ status: string; business_result: unknown }[]>`
        SELECT status, business_result FROM ai_job_queue WHERE target_type = 'document_title_sweep' AND target_id = ${`${cycle}:0`}`;
      expect(page0.status).toBe('DONE');
      expect(JSON.stringify(page0.business_result)).toContain('APPLIED');
      expect((await fichier(doc.id)).retained_title).toBe(TITRE_T1);
      const suite = await sql<{ payload: { afterFileId: number; page: number } }[]>`
        SELECT payload FROM ai_job_queue WHERE target_type = 'document_title_sweep' AND target_id = ${`${cycle}:1`}`;
      expect(suite).toHaveLength(1);
      expect(suite[0].payload).toMatchObject({ afterFileId: doc.id, page: 1, payloadVersion: 1 });
      await sql`UPDATE ai_job_queue SET status = 'CANCELLED' WHERE target_type = 'document_title_sweep'`;
    } finally {
      if (avant === undefined) delete process.env.T3_TITLE_SWEEP_PAGE_SIZE; else process.env.T3_TITLE_SWEEP_PAGE_SIZE = avant;
    }
  });

  // ══ Tiroir (PUT /api/documents/:id) : source du titre ═══════════════════

  const enregistrer = async (compte: Compte, fileId: number, body: Record<string, unknown>) => {
    session.userId = compte.ownerUserId; session.currentAccountId = compte.id;
    const { PUT } = await import('@/app/api/documents/[id]/route');
    const res = await PUT(new NextRequest(`http://x/api/documents/${fileId}`, { method: 'PUT', body: JSON.stringify({ documentType: 'AUTRE', ...body }) }),
      { params: Promise.resolve({ id: String(fileId) }) });
    expect(res.status).toBe(200);
  };

  it('TITLE-AC5 / TITLE-AC8 — tiroir : un titre modifié devient USER (nom original conservé) ; un titre réenregistré tel qu’affiché, ou le nom de fichier renvoyé par un ancien client, ne remplace pas le titre métier', async () => {
    const compte = await make.account();
    const doc = await deposer(compte);
    // Document non analysé (aucune réanalyse déclenchée par l'enregistrement).
    await sql`UPDATE asset_files SET retained_title = ${TITRE_T1}, title_source = 'SYSTEM', document_type = 'AUTRE' WHERE id = ${doc.id}`;

    // Ancien tiroir : renvoyait le nom de fichier comme titre.
    await enregistrer(compte, doc.id, { fileName: UUID_PDF, retainedTitle: UUID_PDF, userEditedFields: { retainedTitle: true } });
    expect(await fichier(doc.id)).toMatchObject({ retained_title: TITRE_T1, title_source: 'SYSTEM', original_filename: UUID_PDF });
    expect((await fichier(doc.id)).ue?.retainedTitle).toBeUndefined();

    // Nouveau tiroir, titre inchangé (prérempli avec le titre affiché).
    await enregistrer(compte, doc.id, { fileName: TITRE_T1, retainedTitle: TITRE_T1, userEditedFields: {} });
    expect(await fichier(doc.id)).toMatchObject({ retained_title: TITRE_T1, title_source: 'SYSTEM', original_filename: UUID_PDF });

    // Renommage explicite : USER, jamais réécrit ensuite.
    await enregistrer(compte, doc.id, { fileName: 'Carte grise Cupra', retainedTitle: 'Carte grise Cupra', userEditedFields: { retainedTitle: true } });
    expect(await fichier(doc.id)).toMatchObject({ retained_title: 'Carte grise Cupra', title_source: 'USER', original_filename: UUID_PDF });
    const { ensureBusinessTitle } = await service();
    expect(await ensureBusinessTitle({ fileId: doc.id, accountId: compte.id, origin: 'T1', mode: 'refresh' })).toMatchObject({ outcome: 'SKIP_USER_TITLE' });
    expect((await fichier(doc.id)).retained_title).toBe('Carte grise Cupra');
  });

  it('TITLE-AC8 — listes : le titre métier est affiché à la place du nom technique (service de liste réel)', async () => {
    const compte = await make.account();
    const doc = await deposer(compte);
    await analyser(compte, doc.id, sortie());
    const { resolveTitle } = await import('@/services/documents/document-query.contract');
    const [row] = await sql<{ retainedTitle: string | null; webLinkTitle: string | null; originalFilename: string | null; fileName: string | null }[]>`
      SELECT retained_title AS "retainedTitle", web_link_title AS "webLinkTitle", original_filename AS "originalFilename", filename AS "fileName"
        FROM asset_files WHERE id = ${doc.id}`;
    expect(resolveTitle(row)).toBe(TITRE_T1);
    // Titre encore technique mais nom original exploitable : le nom original passe devant.
    expect(resolveTitle({ ...row, retainedTitle: UUID_PDF, originalFilename: 'Carte grise.pdf' })).toBe('Carte grise.pdf');
  });

  // ══ Préfiltre SQL = sur-ensemble de la règle JS ═════════════════════════

  it('TITLE-AC9 — préfiltre SQL du balayage : tout titre technique (règle JS) y répond sur PostgreSQL', async () => {
    const { isValidBusinessTitle, technicalTitleSqlPredicate } = await import('@/lib/documents/document-title-rules');
    const techniques = [
      UUID_PDF, '5be5a3ca38cf47fc942c3386ea8e846b', '5BE5A3CA-38CF-47FC-942C-3386EA8E846B.PDF', 'upload_12345.pdf', 'tmp_98765.pdf',
      'IMG_20240418_123456.jpg', 'IMG-20240418-WA0001.jpeg', 'PXL_20240418_101010123.jpg', 'Document (1).pdf', 'scan.pdf', 'Sans titre.docx',
      'd41d8cd98f00b204e9800998ecf8427e', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855.pdf',
      'verebona/u_42/a_123/f_789/1700000000000_facture.pdf', '1700000000000_facture-electricite.pdf', '20240418_101010.pdf',
      'aB3dE5fG7hI9jK1lM3nO5pQ', 'téléchargement (2).pdf', 'blob', 'image.png', 'upload12345.heic', '  ', 'file_1.webp',
    ];
    for (const t of techniques) expect(isValidBusinessTitle(t), t).toBe(false);
    const predicat = technicalTitleSqlPredicate('t.v');
    for (const t of techniques) {
      const [r] = await sql.unsafe(`SELECT ${predicat} AS tech FROM (SELECT $1::text AS v) t`, [t]);
      expect(r.tech, t).toBe(true);
    }
    const [r] = await sql.unsafe(`SELECT ${predicat} AS tech FROM (SELECT $1::text AS v) t`, [TITRE_T1]);
    expect(r.tech).toBe(false);
  });
});
