/**
 * Lot 113U (carte Trello #720 « Analyse T1 ko ») sur PostgreSQL réel.
 *
 * Capture du 07/11/2026 09:36 (préprod, iPhone) : tiroir « Document.pdf »,
 * toast « Impossible de lancer l'analyse. Veuillez réessayer. » puis
 * « Statut : en file d'attente ». Cause démontrée ici (code d'origine) :
 * l'échec de l'analyse directe publié par le pipeline (`failSources`, `error`
 * SANS code, lu avant la remise en file → FAILED_FINAL) était relayé tel quel ;
 * le tiroir s'arrêtait à ce premier `error` (texte générique), puis relisait
 * le document déjà remis en file (« en file d'attente »).
 *
 * Vérifié :
 *   · migration 1550 rejouable ;
 *   · échec T1 en analyse directe : UN seul verdict d'erreur (ANALYSIS_FAILED,
 *     statut PENDING → information), journalisé avec sa référence ;
 *   · job vivant → ALREADY_ANALYZING (prochaine tentative) avant les contrôles
 *     d'offre ; attente technique → texte du référentiel ;
 *   · erreurs de session levées par la garde → leur code (jamais INTERNAL_ERROR) ;
 *   · document d'un autre compte → NOT_FOUND, rien de son état ;
 *   · rapport client (échec HTTP sans corps) → journal `client`, plafonné ;
 *   · lecture BO par référence / document, sans nom de fichier.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import { useTargetState } from '../chain';
import { runMigrationSql, type SqlRunner } from '@/db/migration-index';

const h = vi.hoisted(() => ({
  session: null as null | (() => Promise<unknown>),
  dia: null as null | { code: string; message: string },
}));
vi.mock('@/lib/auth-guards', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth-guards')>()),
  getSession: async () => (h.session ? h.session() : null),
}));
vi.mock('@/services/commercial-model.service', async (orig) => ({
  ...(await orig<typeof import('@/services/commercial-model.service')>()),
  canConsumeAnalysis: async () => ({ allowed: true }),
  consumeAnalysisCredits: async () => undefined,
}));
vi.mock('@/lib/write-access-guard', () => ({
  refuserSiPasDIA: async () => (h.dia ? { json: async () => h.dia } : null),
}));

type Evt = Record<string, unknown>;

scenario('L113U', 'relance d’analyse depuis le tiroir : causes précises, journal, état cohérent (#720)', ({ sql, make, useRecordings }) => {
  useTargetState();

  const ecartes: number[] = [];
  const ecarterLesAutresJobsT1 = async () => {
    const rows = await sql<{ id: number }[]>`
      UPDATE ai_job_queue SET available_at = now() + interval '1 day'
       WHERE treatment = 'T1' AND status = 'PENDING' AND available_at <= now() RETURNING id`;
    ecartes.push(...rows.map((r) => Number(r.id)));
  };
  beforeAll(ecarterLesAutresJobsT1);
  afterAll(async () => {
    if (ecartes.length) await sql`UPDATE ai_job_queue SET available_at = now() WHERE id = ANY(${ecartes})`;
  });

  const sessionDe = (c: { id: number; ownerUserId: number }) => { h.session = async () => ({ userId: c.ownerUserId, currentAccountId: c.id, email: 'e2e@x', role: 'USER', status: 'ACTIVE' }); };

  /** Document en échec d'analyse (comme le document du 06/11), analysable par l'adaptateur de production. */
  const documentEnEchec = async (c: Parameters<typeof make.assetFile>[0]) => {
    const f = await make.assetFile(c);
    await sql`UPDATE asset_files SET s3_bucket = 'e2e-bucket', original_filename = ${`Document-${f.id}.pdf`},
                analysis_state = 'ANALYSIS_FAILED', analysis_retry_count = 5 WHERE id = ${f.id}`;
    return f;
  };

  const lancer = async (fileId: number, headers: Record<string, string> = {}): Promise<Evt[]> => {
    const { POST } = await import('@/app/api/documents/[id]/analyze/route');
    const res = await POST(new NextRequest(`http://localhost/api/documents/${fileId}/analyze`, { method: 'POST', body: '{}', headers }), { params: Promise.resolve({ id: String(fileId) }) });
    expect(res.status).toBe(200);
    return (await res.text()).split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
  };
  /** Premier verdict lu par le tiroir (il s'arrête au premier `error` ou `done`). */
  const verdict = (ev: Evt[]) => ev.find((e) => e.type === 'error' || e.type === 'done')!;
  const journal = async (ref: unknown) => (await sql<Array<Record<string, unknown>>>`
    SELECT * FROM document_analysis_launch_refusals WHERE incident_ref = ${String(ref)}`)[0];

  it('migration 1550 : table créée, rejouable', async () => {
    const texte = await readFile(join(process.cwd(), 'src/db/migrations/1550_l113u_refus_lancement_analyse.sql'), 'utf-8');
    const cnx = await sql.reserve();
    try {
      const runner: SqlRunner = { unsafe: (q, p) => cnx.unsafe(q, p as never) as unknown as Promise<unknown> };
      for (const passe of [1, 2]) await expect(runMigrationSql(runner, texte), `passe ${passe}`).resolves.toBeDefined();
    } finally {
      cnx.release();
    }
    const [t] = await sql<{ ok: boolean }[]>`SELECT to_regclass('public.document_analysis_launch_refusals') IS NOT NULL AS ok`;
    expect(t.ok).toBe(true);
  });

  it('CAUSE #720 : échec T1 en analyse directe → un seul verdict (information, en file), journalisé ; plus jamais le générique', async () => {
    await ecarterLesAutresJobsT1();
    const compte = await make.account();
    const f = await documentEnEchec(compte);
    await useRecordings([]); // aucune sortie enregistrée : le master T1 échoue
    sessionDe(compte);

    const ev = await lancer(f.id, { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1) VerebonaApp/1.4.0 (52; preprod)' });
    const erreurs = ev.filter((e) => e.type === 'error');
    expect(erreurs, JSON.stringify(ev)).toHaveLength(1);
    const v = verdict(ev);
    expect(v).toMatchObject({ type: 'error', code: 'ANALYSIS_FAILED', processingStatus: 'PENDING', incidentRef: expect.stringMatching(/^AN-/) });
    // L'échec relayé du pipeline est devenu un simple changement d'état.
    expect(ev.some((e) => e.type === 'state_update' && e.analysisState === 'ANALYSIS_FAILED')).toBe(true);

    const { analyzeErrorFeedback } = await import('@/components/assets/document-analysis-feedback');
    const toast = analyzeErrorFeedback(v);
    expect(toast).toEqual({ level: 'info', message: 'L’analyse de ce document se poursuit automatiquement.' });
    expect(toast.message).not.toMatch(/Impossible de lancer/);

    // Relecture du tiroir : « en file d'attente » (job remis en file), prochaine tentative connue.
    const { getFileProcessingView } = await import('@/services/ai/processing-status/processing-status.service');
    const vue = await getFileProcessingView(f.id, compte.id);
    expect(vue).toMatchObject({ processingStatus: 'PENDING' });
    expect(vue!.nextAttemptAt).toBeTruthy();

    const ligne = await journal(v.incidentRef);
    expect(ligne).toMatchObject({
      source: 'server', code: 'ANALYSIS_FAILED', category: 'ANALYSIS', level: 'error', http_status: 200,
      asset_file_id: f.id, account_id: compte.id, user_id: compte.ownerUserId, client: 'IOS', app_version: '1.4.0 (52)', processing_status: 'PENDING',
    });
    expect(JSON.stringify(ligne.detail)).not.toMatch(/replay|modèle|gemini|prompt/i);
  });

  it('job vivant (celui de l’échec précédent ou un autre) : ALREADY_ANALYZING + prochaine tentative, AVANT le refus d’offre', async () => {
    await ecarterLesAutresJobsT1();
    const compte = await make.account();
    const f = await documentEnEchec(compte);
    const { enqueueFileAnalyses } = await import('@/services/ai/source-analysis/queue/t1-handler');
    await enqueueFileAnalyses([f.id], compte.id, { origin: 'documents/analyze:reprise', userId: compte.ownerUserId, delaySeconds: 600 });
    sessionDe(compte);
    h.dia = { code: 'TRIAL_EXPIRED', message: 'Votre essai est terminé.' };
    try {
      const v = verdict(await lancer(f.id));
      expect(v).toMatchObject({ code: 'ALREADY_ANALYZING', processingStatus: 'PENDING', nextAttemptAt: expect.any(String) });
      const { analyzeErrorFeedback } = await import('@/components/assets/document-analysis-feedback');
      const r = analyzeErrorFeedback(v);
      expect(r.level).toBe('info');
      expect(r.message).toMatch(/déjà en file d’analyse : prochaine tentative vers \d{2} h \d{2}/);
      expect(await journal(v.incidentRef)).toMatchObject({ code: 'ALREADY_ANALYZING', category: 'IN_PROGRESS', level: 'info' });
    } finally {
      h.dia = null;
    }
  });

  it('attente technique (113R) : ALREADY_ANALYZING avec ANALYSIS_WAITING_TECHNICAL → texte du référentiel, aucune relance', async () => {
    await ecarterLesAutresJobsT1();
    const compte = await make.account();
    const f = await documentEnEchec(compte);
    const { enqueueFileAnalyses } = await import('@/services/ai/source-analysis/queue/t1-handler');
    await enqueueFileAnalyses([f.id], compte.id, {
      origin: 'documents/analyze:reprise', userId: compte.ownerUserId, delaySeconds: 900,
      aiSuspension: { cause: 'TRANSFER_ACCESS_DENIED', message: 'e2e', at: new Date().toISOString(), count: 1, until: new Date(Date.now() + 900_000).toISOString(), revisionId: null, resumedAt: null, decisions: [] },
    });
    sessionDe(compte);
    const v = verdict(await lancer(f.id));
    expect(v).toMatchObject({ code: 'ALREADY_ANALYZING', userMessageCode: 'ANALYSIS_WAITING_TECHNICAL' });
    const { analyzeErrorFeedback } = await import('@/components/assets/document-analysis-feedback');
    const { USER_MESSAGES } = await import('@/lib/ai/processing-status');
    expect(analyzeErrorFeedback(v)).toMatchObject({ level: 'info', message: USER_MESSAGES.ANALYSIS_WAITING_TECHNICAL });
    const { documentStatusLabel } = await import('@/lib/documents/document-status-label');
    expect(documentStatusLabel('UPLOADED', 'PENDING', 'ANALYSIS_WAITING_TECHNICAL')).toBe('Statut : en attente technique');
  });

  it('erreurs de session levées par la garde : leur code, journalisées (aucun INTERNAL_ERROR)', async () => {
    const compte = await make.account();
    const f = await documentEnEchec(compte);
    const { analyzeErrorFeedback, LAUNCH_MESSAGES } = await import('@/components/assets/document-analysis-feedback');
    const attendu: Record<string, string> = {
      INVALID_TOKEN: LAUNCH_MESSAGES.SESSION, MFA_REQUIRED: LAUNCH_MESSAGES.MFA,
      CGUV_REACCEPTANCE_REQUIRED: LAUNCH_MESSAGES.CGUV, SESSION_UNAVAILABLE: LAUNCH_MESSAGES.UNAVAILABLE,
    };
    for (const [code, msg] of Object.entries(attendu)) {
      h.session = async () => { throw new Error(code); };
      const v = verdict(await lancer(f.id));
      expect(v, code).toMatchObject({ code });
      expect(analyzeErrorFeedback(v).message).toBe(msg);
      expect(await journal(v.incidentRef), code).toMatchObject({ code, user_id: null, account_id: null });
    }
    h.session = null;
    const v = verdict(await lancer(f.id));
    expect(v).toMatchObject({ code: 'UNAUTHORIZED' });
    expect(analyzeErrorFeedback(v).message).toBe(LAUNCH_MESSAGES.SESSION);
  });

  it('document d’un autre compte : NOT_FOUND, sans rien révéler ; refus d’offre sans job vivant : son code', async () => {
    const a = await make.account();
    const b = await make.account();
    const fb = await documentEnEchec(b);
    sessionDe(a);
    const v = verdict(await lancer(fb.id));
    expect(v).toEqual({ type: 'error', code: 'NOT_FOUND', incidentRef: expect.stringMatching(/^AN-/) });
    expect(await journal(v.incidentRef)).toMatchObject({ code: 'NOT_FOUND', account_id: a.id, asset_file_id: null });

    const fa = await documentEnEchec(a);
    h.dia = { code: 'SUBSCRIPTION_REQUIRED', message: 'Un abonnement est nécessaire.' };
    try {
      const r = verdict(await lancer(fa.id));
      expect(r).toMatchObject({ code: 'SUBSCRIPTION_REQUIRED', message: 'Un abonnement est nécessaire.' });
      expect(await journal(r.incidentRef)).toMatchObject({ category: 'PLAN', asset_file_id: fa.id });
    } finally {
      h.dia = null;
    }
  });

  it('rapport client (échec HTTP sans corps) : journal « client », document d’un autre compte écarté, plafond horaire', async () => {
    const a = await make.account();
    const b = await make.account();
    const fa = await documentEnEchec(a);
    const fb = await documentEnEchec(b);
    sessionDe(a);
    const { POST } = await import('@/app/api/documents/analyze-launch-reports/route');
    const envoyer = async (body: Record<string, unknown>, headers: Record<string, string> = {}) => {
      const res = await POST(new NextRequest('http://localhost/api/documents/analyze-launch-reports', { method: 'POST', body: JSON.stringify(body), headers }));
      return { status: res.status, body: await res.json() as Record<string, unknown> };
    };
    const { newIncidentRef } = await import('@/lib/ai/analysis-launch');
    const ref = newIncidentRef();
    expect(await envoyer({ incidentRef: ref, fileId: fa.id, httpStatus: 502, phase: 'response' }, { 'x-verebona-client': 'IOS', 'x-verebona-app-version': '1.4.0' }))
      .toEqual({ status: 200, body: { ok: true } });
    expect(await journal(ref)).toMatchObject({ source: 'client', code: 'HTTP_502', category: 'UNAVAILABLE', http_status: 502, asset_file_id: fa.id, client: 'IOS', app_version: '1.4.0' });

    const ref2 = newIncidentRef();
    await envoyer({ incidentRef: ref2, fileId: fb.id, phase: 'network', code: 'texte libre <b>' });
    expect(await journal(ref2)).toMatchObject({ code: 'NETWORK_ERROR', category: 'NETWORK', asset_file_id: null });

    expect((await envoyer({ incidentRef: 'xx' })).status).toBe(400);

    const { CLIENT_REPORTS_PER_HOUR } = await import('@/services/ai/source-analysis/launch-refusals');
    for (let i = 0; i < CLIENT_REPORTS_PER_HOUR; i++) await envoyer({ incidentRef: newIncidentRef(), phase: 'network' });
    const trop = newIncidentRef();
    expect(await envoyer({ incidentRef: trop, phase: 'network' })).toEqual({ status: 200, body: { ok: false, code: 'RATE_LIMITED' } });
    expect(await journal(trop)).toBeUndefined();
  });

  it('BO : refus retrouvé par référence et par document, métadonnées sans nom de fichier', async () => {
    const compte = await make.account();
    const f = await documentEnEchec(compte);
    h.session = async () => { throw new Error('MFA_REQUIRED'); };
    const v = verdict(await lancer(f.id));
    sessionDe(compte);
    const ev2 = verdict(await lancer(f.id)); // second refus du même document (job vivant ou échec)
    const { listLaunchRefusals } = await import('@/services/ai/source-analysis/launch-refusals');
    const parRef = await listLaunchRefusals({ incidentRef: String(v.incidentRef) });
    expect(parRef.available).toBe(true);
    expect(parRef.items).toHaveLength(1);
    expect(parRef.items[0]).toMatchObject({ code: 'MFA_REQUIRED', category: 'MFA', assetFileId: null });
    const parDoc = await listLaunchRefusals({ assetFileId: f.id });
    expect(parDoc.items.map((i) => i.incidentRef)).toContain(ev2.incidentRef);
    expect(JSON.stringify(parDoc)).not.toMatch(/Document-\d+\.pdf/);
    expect(await listLaunchRefusals({ incidentRef: 'pas une référence' })).toEqual({ available: true, items: [] });
  });
});
