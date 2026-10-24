/**
 * Lot 54 (54C) — « BO-IA — Refonte de la gestion des versions, restauration
 * et export de la Configuration IA », §7 (tests et non-régression), sur
 * PostgreSQL 16 réel.
 *
 * Chaque cas porte l'identifiant BOIA-xx de la recette (rapport du lot 54).
 * Les configurations se distinguent par des réglages qui ne demandent aucune
 * qualification de modèle (tokens de sortie, préambule, déclencheurs) : les
 * contrôles de modèles sont couverts par les tests du lot 32B.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scenario } from '../scenario';
import { runMigrationSql, type SqlRunner } from '@/db/migration-index';

const session = vi.hoisted(() => ({ adminId: 0, email: 'admin-l54c@e2e.test' }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    requireAdmin: async () => session.adminId,
    getSession: async () => ({ userId: session.adminId, email: session.email, role: 'ADMIN' }),
    handleSessionError: () => new Response('unauthorized', { status: 401 }),
  },
}));

type Svc = typeof import('@/services/ai/config/config-version.service');
type Repo = typeof import('@/services/ai/config/config-version.repository');
type Cfg = import('@/services/ai/config/config-types').TreatmentConfig;

scenario('L54C-BOIA', 'Versions, révisions restaurables et export de la configuration IA', ({ sql, make }) => {
  let adminId = 0;
  let env = 'local';
  let svc: Svc;
  let repo: Repo;
  let activeAvant: number[] = [];
  const ids: number[] = [];

  const resolver = () => import('@/services/ai/config/config-resolver');
  /** Configuration appliquée à une NOUVELLE exécution T1 (hors file). */
  const appliquee = async () => {
    const r = await resolver();
    return r.resolveOperationConfig('t1_analyze_document');
  };
  const t1 = async (versionId: number): Promise<Cfg> => (await repo.getVersion(versionId))!.entries.find((e) => e.treatment === 'T1')!;
  const nouvelle = async (label: string, tokens: number) => {
    const v = await svc.createConfigVersion(adminId, { label: `e2e-l54c ${label}` });
    ids.push(v.id);
    const base = v.entries.find((e) => e.treatment === 'T1')!;
    await svc.saveConfiguration(v.id, {
      expectedRevision: v.currentRevisionNumber, entries: [{ ...base, maxOutputTokens: tokens, prompt: `préambule ${label}` }],
    }, adminId);
    return (await repo.getVersion(v.id))!;
  };
  const statuts = async () => sql<{ id: number; status: string }[]>`
    SELECT id, status FROM ai_config_versions WHERE environment = ${env} AND status = 'ACTIVE'`;

  beforeAll(async () => {
    const admin = await make.user({ role: 'ADMIN' });
    adminId = admin.id;
    session.adminId = admin.id;
    const { __setConfigVersionCounterStoreForTests, dbConfigVersionCounterStore } = await import('@/services/ai/config/config-cache-version');
    __setConfigVersionCounterStoreForTests(dbConfigVersionCounterStore);
    env = (await import('@/services/ai/config/environment')).getAiEnvironment();
    svc = await import('@/services/ai/config/config-version.service');
    repo = await import('@/services/ai/config/config-version.repository');
    activeAvant = (await statuts()).map((r) => Number(r.id));
  });

  afterAll(async () => {
    await sql`UPDATE ai_config_versions SET status = 'INACTIVE' WHERE environment = ${env} AND status = 'ACTIVE'`;
    if (activeAvant.length) await sql`UPDATE ai_config_versions SET status = 'ACTIVE', deleted_at = NULL WHERE id = ANY(${activeAvant})`;
    (await resolver()).invalidateConfigCache();
    const { __setConfigVersionCounterStoreForTests } = await import('@/services/ai/config/config-cache-version');
    __setConfigVersionCounterStoreForTests(null);
  });

  it('BOIA-01 — version créée NON active, modifiable, sans effet sur les exécutions', async () => {
    const avant = await appliquee();
    const v = await nouvelle('a', 1111);
    expect(v.active).toBe(false);
    expect(v.status).toBe('INACTIVE');
    expect(v.visibleNumber).toBeGreaterThan(0);
    expect(v.currentRevisionNumber).toBe(2); // r1 création, r2 enregistrement
    expect((await t1(v.id)).maxOutputTokens).toBe(1111);
    const apres = await appliquee();
    expect(apres.configVersionId).toBe(avant.configVersionId);
    expect(apres.maxOutputTokens).toBe(avant.maxOutputTokens);
  });

  it('BOIA-02 — « Activer en préproduction » : les nouvelles exécutions utilisent cette configuration', async () => {
    const v = await nouvelle('b', 2222);
    await svc.activate(v.id, adminId);
    const c = await appliquee();
    expect(c.configVersionId).toBe(v.id);
    expect(c.maxOutputTokens).toBe(2222);
    expect(c.configRevisionNumber).toBe(2);
    expect(c.promptPreamble).toBe('préambule b');
    expect((await statuts()).map((r) => r.id)).toEqual([v.id]);
  });

  it('BOIA-03 — version active modifiée et enregistrée : révision suivante appliquée sans réactivation', async () => {
    const active = (await repo.getActiveVersion(env as never))!;
    const r = await svc.saveConfiguration(active.id, {
      expectedRevision: active.currentRevisionNumber, entries: [{ ...(await t1(active.id)), maxOutputTokens: 2300 }],
    }, adminId);
    expect(r).toMatchObject({ changed: true, active: true, revisionNumber: (active.currentRevisionNumber ?? 0) + 1 });
    const c = await appliquee();
    expect([c.configVersionId, c.maxOutputTokens, c.configRevisionNumber]).toEqual([active.id, 2300, r.revisionNumber]);
    // Sauvegarde sans modification effective : aucune révision.
    const r2 = await svc.saveConfiguration(active.id, { expectedRevision: r.revisionNumber, entries: [await t1(active.id)] }, adminId);
    expect(r2).toMatchObject({ changed: false, revisionNumber: r.revisionNumber });
  });

  it('BOIA-04 — deux versions ne sont JAMAIS actives simultanément (activations concurrentes, contrainte en base)', async () => {
    const a = await nouvelle('c1', 3001);
    const b = await nouvelle('c2', 3002);
    await Promise.allSettled([svc.activate(a.id, adminId), svc.activate(b.id, adminId), svc.activate(a.id, adminId)]);
    const actives = await statuts();
    expect(actives).toHaveLength(1);
    expect([a.id, b.id]).toContain(actives[0].id);
    const autre = actives[0].id === a.id ? b.id : a.id;
    await expect(sql`UPDATE ai_config_versions SET status = 'ACTIVE' WHERE id = ${autre}`).rejects.toThrow(/single_active|unique/i);
    expect(await statuts()).toHaveLength(1);
  });

  it('BOIA-05 — restaurer une révision : contenu EXACT, nouvelle révision, historique intact (r6 → r9, r6/r7/r8 conservées)', async () => {
    const active = (await repo.getActiveVersion(env as never))!;
    let rev = active.currentRevisionNumber!;
    for (const tokens of [4001, 4002, 4003]) {
      rev = (await svc.saveConfiguration(active.id, { expectedRevision: rev, entries: [{ ...(await t1(active.id)), maxOutputTokens: tokens }] }, adminId)).revisionNumber;
    }
    const revisions = await repo.listRevisions(active.id);
    const cible = revisions.find((r) => r.revisionNumber === rev - 2)!; // tokens 4001
    const avantSha = (await repo.getRevision(cible.id))!.snapshotSha256;
    const r = await svc.restoreRevision(active.id, cible.id, adminId, { expectedRevision: rev });
    expect(r.revisionNumber).toBe(rev + 1);
    const apres = await repo.listRevisions(active.id);
    expect(apres.map((x) => x.revisionNumber)).toEqual([rev + 1, ...revisions.map((x) => x.revisionNumber)]);
    const nouvelleRev = apres[0];
    expect(nouvelleRev).toMatchObject({ kind: 'restore', restoredFromRevisionId: cible.id, restoredFromRevisionNumber: cible.revisionNumber });
    expect(nouvelleRev.snapshotSha256).toBe(avantSha);
    // Version active : appliquée sans réactivation ; la restauration est elle-même réversible.
    expect((await appliquee()).maxOutputTokens).toBe(4001);
    const r8 = apres.find((x) => x.revisionNumber === rev)!;
    await svc.restoreRevision(active.id, r8.id, adminId);
    expect((await appliquee()).maxOutputTokens).toBe(4003);
    // Révisions immuables en base.
    await expect(sql`UPDATE ai_config_revisions SET comment = 'x' WHERE id = ${cible.id}`).rejects.toThrow(/immuable/);
  });

  it('BOIA-06 — réactiver une version précédente : son dernier état redevient opérationnel ; l’autre reste conservée', async () => {
    const actuelle = (await repo.getActiveVersion(env as never))!;
    const precedente = await nouvelle('d', 5005);
    await svc.activate(precedente.id, adminId);
    expect((await appliquee()).maxOutputTokens).toBe(5005);
    await svc.activate(actuelle.id, adminId); // retour en avant
    const c = await appliquee();
    expect(c.configVersionId).toBe(actuelle.id);
    expect(c.configRevisionNumber).toBe((await repo.getVersion(actuelle.id))!.currentRevisionNumber);
    expect((await repo.getVersion(precedente.id))!.deletedAt).toBeNull();
  });

  it('BOIA-07 — supprimer une version non active : retirée de la liste, restauration toujours possible', async () => {
    const v = await nouvelle('e', 6006);
    await svc.deleteConfigVersion(v.id, adminId);
    expect((await repo.listVersions(env as never)).map((x) => x.id)).not.toContain(v.id);
    expect((await repo.listVersions(env as never, 200, { deleted: 'only' })).map((x) => x.id)).toContain(v.id);
    const revs = await repo.listRevisions(v.id);
    expect(revs.length).toBeGreaterThanOrEqual(2);
    // Jamais réactivée implicitement : activer une version supprimée est refusé.
    await expect(svc.activate(v.id, adminId)).rejects.toMatchObject({ code: 'VERSION_DELETED' });
    // Récupération : nouvelle version depuis une révision, puis remise dans la liste.
    const copie = await svc.createConfigVersion(adminId, { sourceRevisionId: revs[0].id, label: 'e2e-l54c récupérée' });
    ids.push(copie.id);
    expect(copie.entries.find((e) => e.treatment === 'T1')!.maxOutputTokens).toBe(6006);
    expect(copie.active).toBe(false);
    await svc.restoreDeletedVersion(v.id, adminId);
    const remise = (await repo.getVersion(v.id))!;
    expect([remise.deletedAt, remise.active]).toEqual([null, false]);
  });

  it('BOIA-08 — supprimer la version active est interdit (service et base)', async () => {
    const active = (await repo.getActiveVersion(env as never))!;
    await expect(svc.deleteConfigVersion(active.id, adminId)).rejects.toMatchObject({ code: 'ACTIVE_VERSION_UNDELETABLE' });
    await expect(sql`UPDATE ai_config_versions SET deleted_at = now() WHERE id = ${active.id}`).rejects.toThrow(/active_not_deleted/);
    expect((await repo.getVersion(active.id))!.deletedAt).toBeNull();
  });

  it('BOIA-09 — export : fichier conforme à la révision enregistrée au moment du clic, sans secret', async () => {
    const exp = await import('@/services/ai/config/config-export.service');
    const active = (await repo.getActiveVersion(env as never))!;
    const r = await exp.exportActiveConfiguration(adminId);
    const doc = JSON.parse(r.content) as import('@/services/ai/config/config-export.service').ConfigExportDocument;
    expect(doc).toMatchObject({ format: 'verebona-ia-config-export', formatVersion: '2.0.0' });
    expect(doc.version).toMatchObject({ id: active.id, number: active.visibleNumber });
    expect(doc.revision.number).toBe(active.currentRevisionNumber);
    expect(doc.configuration.treatments.map((t) => t.code)).toEqual(['T1', 'T2', 'T3', 'T4', 'T6']);
    const rev = (await repo.getRevision(active.currentRevisionId!))!;
    for (const e of rev.snapshot.entries) {
      const t = doc.configuration.treatments.find((x) => x.code === e.treatment)!;
      expect(t.models.maxOutputTokens).toBe(e.maxOutputTokens);
      expect(t.preamble).toBe(e.prompt);
      expect(t.triggers).toEqual(e.triggers);
      expect(t.guardrails).toEqual(e.guardrails);
      expect(t.masterPrompt?.content.length).toBeGreaterThan(0);
    }
    expect(exp.validateExportDocument(doc).filter((i) => i.blocking)).toEqual([]);
    expect(r.record.fileName).toMatch(new RegExp(`^verebona-ia-config-v${active.visibleNumber}-r${active.currentRevisionNumber}-\\d{8}-\\d{6}\\.json$`));
    expect(doc.environmentParameters.find((p) => p.kind === 'secret')).toMatchObject({ value: null });
    expect(r.content).not.toMatch(/e2e-sans-reseau|AIza|GEMINI_API_KEY=/);
    // L'export ne modifie ni ne fige la version active.
    expect((await repo.getVersion(active.id))!.currentRevisionNumber).toBe(active.currentRevisionNumber);
    expect((await exp.exportStatus(env as never)).changedSinceLastExport).toBe(false);
  });

  it('BOIA-10 — modifier après export : le fichier exporté reste identique ; « modifiée depuis le dernier export »', async () => {
    const exp = await import('@/services/ai/config/config-export.service');
    const [dernier] = await exp.listExports(env as never, 1);
    const avant = (await exp.getExportFile(dernier.id))!;
    const active = (await repo.getActiveVersion(env as never))!;
    await svc.saveConfiguration(active.id, { expectedRevision: active.currentRevisionNumber, entries: [{ ...(await t1(active.id)), maxOutputTokens: 7007 }] }, adminId);
    const apres = (await exp.getExportFile(dernier.id))!;
    expect(apres.content).toBe(avant.content);
    expect((await import('node:crypto')).createHash('sha256').update(apres.content, 'utf8').digest('hex')).toBe(dernier.contentSha256);
    const st = await exp.exportStatus(env as never);
    expect(st.changedSinceLastExport).toBe(true);
    expect(st.changes).toEqual(expect.arrayContaining(['revision', 'content']));
    await expect(sql`UPDATE ai_config_exports SET content = '{}' WHERE id = ${dernier.id}`).rejects.toThrow(/immuable/);
    await expect(sql`DELETE FROM ai_config_exports WHERE id = ${dernier.id}`).rejects.toThrow(/immuable/);
  });

  it('BOIA-11 — échec de sauvegarde, d’activation ou d’export : aucune configuration partielle, aucun export présenté comme valide', async () => {
    const exp = await import('@/services/ai/config/config-export.service');
    const active = (await repo.getActiveVersion(env as never))!;
    const lignes = async (id: number) => sql`SELECT treatment, max_output_tokens, prompt FROM ai_config_entries WHERE version_id = ${id} ORDER BY treatment`;
    // a) Échec DANS la transaction (contrôle final) : rien n'est écrit.
    const entreesAvant = await lignes(active.id);
    const nbRev = (await repo.listRevisions(active.id)).length;
    await expect(repo.writeSnapshot({
      versionId: active.id, userId: adminId, kind: 'save', expectedRevision: active.currentRevisionNumber,
      next: (c) => ({ ...c, entries: c.entries.map((e) => ({ ...e, maxOutputTokens: 9999 })) }),
      check: () => { throw new Error('panne simulée après calcul'); },
    })).rejects.toThrow(/panne simulée/);
    expect(await lignes(active.id)).toEqual(entreesAvant);
    expect(await repo.listRevisions(active.id)).toHaveLength(nbRev);
    // b) Activation en échec (prompt maître figé introuvable) : l'ancienne active reste active, rien n'est mélangé.
    const v = await nouvelle('f', 8008);
    const rev = (await repo.getRevision(v.currentRevisionId!))!;
    const casse = await svc.createConfigVersion(adminId, { sourceRevisionId: rev.id, label: 'e2e-l54c cassée' });
    ids.push(casse.id);
    await sql.begin(async (tx) => {
      await tx.unsafe(`ALTER TABLE ai_config_revisions DISABLE TRIGGER ai_config_revisions_immutable`);
      await tx`UPDATE ai_config_revisions SET snapshot = jsonb_set(snapshot, '{masterPrompts}', '{"T1": {"versionId": 999999999, "versionNumber": 1, "masterPromptCode": "t1_master_v1", "contentSha256": "x", "content": "x"}}'::jsonb)
                WHERE id = ${casse.currentRevisionId}`;
      await tx.unsafe(`ALTER TABLE ai_config_revisions ENABLE TRIGGER ai_config_revisions_immutable`);
    });
    await expect(svc.activate(casse.id, adminId)).rejects.toMatchObject({ code: 'MASTER_PROMPT_VERSION_MISSING' });
    expect((await statuts()).map((r) => r.id)).toEqual([active.id]);
    // c) Export invalide : refus, aucun export enregistré, aucun fichier.
    const nbExports = (await exp.listExports(env as never, 100)).length;
    await expect(exp.exportActiveConfiguration(adminId, { tamper: (d) => { d.configuration.treatments[0].guardrails.push({ code: 'inconnu', threshold: 1, reaction: 'alerte' }); } }))
      .rejects.toMatchObject({ code: 'EXPORT_INVALID' });
    await expect(exp.exportActiveConfiguration(adminId, { tamper: (d) => { (d.settingsOutsideVersion as unknown as Record<string, unknown>).apiKey = 'AIzaSyD-e2e-0123456789abcdefghijklmnopqrstu'; } }))
      .rejects.toMatchObject({ code: 'EXPORT_INVALID' });
    expect(await exp.listExports(env as never, 100)).toHaveLength(nbExports);
  });

  it('BOIA-12 — modifications concurrentes : jamais d’écrasement silencieux d’une sauvegarde plus récente', async () => {
    const active = (await repo.getActiveVersion(env as never))!;
    const base = active.currentRevisionNumber;
    const ligne = await t1(active.id);
    const [a, b] = await Promise.allSettled([
      svc.saveConfiguration(active.id, { expectedRevision: base, entries: [{ ...ligne, maxOutputTokens: 1201 }] }, adminId),
      svc.saveConfiguration(active.id, { expectedRevision: base, entries: [{ ...ligne, maxOutputTokens: 1202 }] }, adminId),
    ]);
    const ok = [a, b].filter((x) => x.status === 'fulfilled');
    const refus = [a, b].filter((x) => x.status === 'rejected') as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(refus[0].reason).toMatchObject({ code: 'REVISION_CONFLICT' });
    const gagnant = (ok[0] as PromiseFulfilledResult<{ revisionNumber: number }>).value;
    expect((await repo.getVersion(active.id))!.currentRevisionNumber).toBe(gagnant.revisionNumber);
    // Second auteur parti de l'ancienne révision : refusé, la sauvegarde la plus récente est intacte.
    const tokens = (await t1(active.id)).maxOutputTokens;
    await expect(svc.saveConfiguration(active.id, { expectedRevision: base, entries: [{ ...ligne, maxOutputTokens: 1299 }] }, adminId))
      .rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect((await t1(active.id)).maxOutputTokens).toBe(tokens);
    // Route : `baseRevision` obligatoire.
    const { PUT } = await import('@/app/api/admin/ai/config-versions/[id]/route');
    const { NextRequest } = await import('next/server');
    const res = await PUT(new NextRequest(`http://app.test/api/admin/ai/config-versions/${active.id}`, {
      method: 'PUT', body: JSON.stringify({ entries: [] }), headers: { 'Content-Type': 'application/json' },
    }), { params: Promise.resolve({ id: String(active.id) }) });
    expect(res.status).toBe(400);
  });

  it('BOIA-13 — traces : version ET révision réellement utilisées ; exécution démarrée = révision figée jusqu’au bout', async () => {
    const r = await resolver();
    const active = (await repo.getActiveVersion(env as never))!;
    const { runInJobContext } = await import('@/services/ai/queue/job-context');
    const pin = await r.resolveEffectivePin();
    expect(pin).toEqual({ versionId: active.id, revisionId: active.currentRevisionId });
    const avantTokens = (await appliquee()).maxOutputTokens;
    // Une sauvegarde arrive pendant l'exécution.
    const enCours = runInJobContext({ jobId: null, treatment: 'T1', configVersionId: pin.versionId, configRevisionId: pin.revisionId }, async () => {
      await svc.saveConfiguration(active.id, { expectedRevision: active.currentRevisionNumber, entries: [{ ...(await t1(active.id)), maxOutputTokens: 1313 }] }, adminId);
      return r.resolveOperationConfig('t1_analyze_document');
    });
    const figee = await enCours;
    expect([figee.maxOutputTokens, figee.configRevisionId]).toEqual([avantTokens, active.currentRevisionId]);
    const nouvelle = await appliquee();
    expect(nouvelle.maxOutputTokens).toBe(1313);
    // Trace : `configRevision` en métadonnée, cohérente avec la version.
    const { recordCallTrace } = await import('@/services/ai/telemetry/ai-trace.service');
    const compte = await make.account();
    const id = await recordCallTrace({
      traceId: 'e2e-l54c', useCaseCode: 'SOURCE_ANALYSIS', operationCode: 't1_analyze_document', accountId: compte.id, userId: null,
      provider: 'replay', model: 'm', promptVersion: 'p', usedFallback: false, inputTokens: 1, outputTokens: 1, costMicros: 0,
      durationMs: 1, status: 'success', billable: false, shadow: false,
      configVersionId: nouvelle.configVersionId, configRevisionId: nouvelle.configRevisionId, configRevisionNumber: nouvelle.configRevisionNumber,
    } as never);
    const [e] = await sql<{ config_version_id: number; metadata: { configRevision?: { id: number; number: number } } }[]>`
      SELECT config_version_id, metadata FROM ai_usage_event WHERE id = ${id}`;
    expect(e.config_version_id).toBe(active.id);
    const [rv] = await sql<{ version_id: number; revision_number: number }[]>`
      SELECT version_id, revision_number FROM ai_config_revisions WHERE id = ${e.metadata.configRevision!.id}`;
    expect([rv.version_id, rv.revision_number]).toEqual([active.id, e.metadata.configRevision!.number]);
  });

  it('BOIA-14 — reprise 0376 : configurations existantes conservées, configuration en service inchangée, idempotente', async () => {
    // Données « avant lot 54 » en préproduction (environnement distinct du test).
    await sql`UPDATE ai_config_versions SET status = 'INACTIVE' WHERE environment = 'preprod' AND status = 'ACTIVE'`;
    const ins = async (status: string, label: string, n: number | null, tokens: number) => {
      const [v] = await sql<{ id: number }[]>`
        INSERT INTO ai_config_versions (environment, status, label, visible_number, validated_at, activated_at, archived_at)
        VALUES ('preprod', ${status}, ${label}, ${n}, ${n ? sql`now()` : null}, ${status === 'ACTIVE' || status === 'VALIDATED' ? sql`now()` : null},
                ${status === 'ARCHIVED' ? sql`now()` : null}) RETURNING id`;
      for (const t of ['T1', 'T2', 'T3', 'T4', 'T6']) {
        await sql`INSERT INTO ai_config_entries (version_id, treatment, prompt, max_output_tokens, triggers)
                  VALUES (${v.id}, ${t}, ${`p-${label}-${t}`}, ${tokens}, '[{"kind":"event","code":"source_uploaded","active":true}]'::jsonb)`;
      }
      return v.id;
    };
    const base = 90_000 + Math.floor(Math.random() * 1000);
    const active = await ins('ACTIVE', 'mig-active', base, 100);
    const aTester = await ins('TO_TEST', 'mig-a-tester', null, 200);
    const brouillon = await ins('DRAFT', 'mig-brouillon', null, 300);
    const validee = await ins('VALIDATED', 'mig-validee', base + 1, 400);
    const archivee = await ins('ARCHIVED', 'mig-archivee', base + 2, 500);
    const texte = await readFile(join(process.cwd(), 'src/db/migrations/0376_ai_config_revisions.sql'), 'utf-8');
    const rejouer = async () => {
      const cnx = await sql.reserve();
      try {
        const runner: SqlRunner = { unsafe: (q, p) => cnx.unsafe(q, p as never) as unknown as Promise<unknown> };
        await runMigrationSql(runner, texte);
      } finally { cnx.release(); }
    };
    await rejouer();
    const etat = async () => sql<{ id: number; status: string; legacy_status: string; deleted: boolean; visible_number: number; current_revision_number: number }[]>`
      SELECT id, status, legacy_status, deleted_at IS NOT NULL AS deleted, visible_number, current_revision_number
        FROM ai_config_versions WHERE id = ANY(${[active, aTester, brouillon, validee, archivee]}) ORDER BY id`;
    const e1 = await etat();
    const par = new Map(e1.map((r) => [r.id, r]));
    // La configuration EFFECTIVE (« À tester » en préproduction) reste celle en service.
    expect(par.get(aTester)).toMatchObject({ status: 'ACTIVE', legacy_status: 'TO_TEST', deleted: false });
    expect(par.get(active)).toMatchObject({ status: 'INACTIVE', legacy_status: 'ACTIVE', visible_number: base });
    expect(par.get(brouillon)).toMatchObject({ status: 'INACTIVE', legacy_status: 'DRAFT' });
    expect(par.get(validee)).toMatchObject({ status: 'INACTIVE', legacy_status: 'VALIDATED', visible_number: base + 1 });
    expect(par.get(archivee)).toMatchObject({ status: 'INACTIVE', legacy_status: 'ARCHIVED', deleted: true });
    for (const r of e1) {
      expect(r.visible_number).toBeGreaterThan(0);
      expect(r.current_revision_number).toBe(1);
      const v = (await repo.getVersion(r.id))!;
      const lignes = await repo.getEntries(r.id);
      expect(v.entries).toEqual(lignes); // révision 1 = copie exacte des lignes
    }
    const rt = await repo.getRuntimeConfiguration('preprod' as never);
    expect([rt!.versionId, rt!.entries[0].maxOutputTokens, rt!.revisionNumber]).toEqual([aTester, 200, 1]);
    // Idempotente : rejouée, rien ne change.
    await rejouer();
    expect(await etat()).toEqual(e1);
    expect((await sql`SELECT 1 FROM ai_config_revisions WHERE version_id = ANY(${[active, aTester, brouillon, validee, archivee]})`).length).toBe(5);
    await sql`UPDATE ai_config_versions SET status = 'INACTIVE' WHERE id = ${aTester}`;
  });

  it('BOIA-15 — aucune publication ni activation automatique en production', async () => {
    // Lot 86B (C-Q9) : les routes 410 du workflow retiré et l'ancien package
    // sont SUPPRIMÉES ; le seul transfert est l'import manuel complet du
    // fichier global, qui refuse l'ancien package avec un message explicite.
    const { existsSync } = await import('node:fs');
    for (const f of ['config-versions/[id]/package', 'config-versions/[id]/promote', 'config-versions/[id]/demote', 'config-versions/[id]/validate', 'config-packages/import', 'config-packages']) {
      expect(existsSync(`src/app/api/admin/ai/${f}/route.ts`), f).toBe(false);
    }
    const imp = await import('@/services/ai/config/config-import.service');
    expect(imp.detectImportFormat(JSON.stringify({ schemaVersion: 'ai-config-package-v1', entries: [] }))).toMatchObject({ ok: false, code: 'LEGACY_PACKAGE_FORMAT' });
    // Export : aucune écriture hors de ses propres tables (versions inchangées).
    const avant = await sql`SELECT id, status, current_revision_id FROM ai_config_versions ORDER BY id`;
    await (await import('@/services/ai/config/config-export.service')).exportActiveConfiguration(adminId);
    expect(await sql`SELECT id, status, current_revision_id FROM ai_config_versions ORDER BY id`).toEqual(avant);
    // Console de production : activation seulement sur confirmation explicite.
    const v = await nouvelle('prod', 1500);
    const ancien = process.env.NEXT_PUBLIC_APP_ENV;
    process.env.NEXT_PUBLIC_APP_ENV = 'production';
    try {
      await expect(svc.activate(v.id, adminId)).rejects.toMatchObject({ code: 'PRODUCTION_CONFIRMATION_REQUIRED' });
    } finally { process.env.NEXT_PUBLIC_APP_ENV = ancien; }
    expect((await repo.getVersion(v.id))!.active).toBe(false);
  });

  it('BOIA-16 — non-régression T1, T2, T3, T4, T6 : chaque traitement lit sa ligne de la version active ; T5 jamais réintroduit', async () => {
    const active = (await repo.getActiveVersion(env as never))!;
    const entries = await Promise.all((['T1', 'T2', 'T3', 'T4', 'T6'] as const).map(async (t, i) => ({
      ...(active.entries.find((e) => e.treatment === t)!), maxOutputTokens: 1600 + i, prompt: `socle ${t}`,
    })));
    await svc.saveConfiguration(active.id, { expectedRevision: active.currentRevisionNumber, entries }, adminId);
    const r = await resolver();
    const ops: Array<[string, number]> = [['t1_analyze_document', 1600], ['t2_answer', 1601], ['t3_value_conflict', 1602], ['t4_classify_event', 1603], ['t6_formulate', 1604]];
    for (const [op, tokens] of ops) {
      const c = await r.resolveOperationConfig(op);
      expect([op, c.configVersionId, c.maxOutputTokens]).toEqual([op, active.id, tokens]);
    }
    // Déclencheurs métier : lus dans la même ligne qu'avant (aucune règle modifiée).
    const t1c = await r.resolveTreatmentConfig('T1');
    expect(t1c?.triggers).toEqual(entries[0].triggers);
    expect(await r.resolveTreatmentConfig('T5' as never)).toBeNull();
    const v = (await repo.getVersion(active.id))!;
    expect(v.entries.map((e) => e.treatment)).toEqual(['T1', 'T2', 'T3', 'T4', 'T6']);
    expect(await sql`SELECT 1 FROM ai_config_entries WHERE version_id = ${active.id} AND treatment = 'T5'`).toHaveLength(0);
  });

  it('BOIA-17 — prompts maîtres : figés dans la révision, appliqués à l’activation, et une activation de prompt crée une révision', async () => {
    const { contentSha256 } = await import('@/services/ai/master-prompts/master-prompt.repository');
    const actif = (await sql<{ id: number; version_number: number }[]>`
      SELECT id, version_number FROM ai_master_prompt_versions WHERE environment = ${env} AND treatment = 'T6' AND status = 'ACTIVE'`)[0];
    const n = 7000 + Math.floor(Math.random() * 500);
    const texte = `${(await import('@/services/ai/governance/master-corpus/cases')).readMasterFileFromRepo('t6_master_v1')}\n\n(e2e l54c ${n})`;
    const [ancien] = await sql<{ id: number }[]>`
      INSERT INTO ai_master_prompt_versions (environment, treatment, master_prompt_code, version_number, status, content, content_sha256, origin, activated_at, first_activated_at)
      VALUES (${env}, 'T6', 't6_master_v1', ${n}, ${actif ? 'PREVIOUS' : 'ACTIVE'}, ${texte}, ${contentSha256(texte)}, 'admin', now(), now()) RETURNING id`;
    const active = (await repo.getActiveVersion(env as never))!;
    // Une version qui retient l'ancien prompt T6 ; activée : le prompt devient actif, atomiquement.
    const v = await svc.createConfigVersion(adminId, { label: 'e2e-l54c prompts' });
    ids.push(v.id);
    await svc.saveConfiguration(v.id, { expectedRevision: v.currentRevisionNumber, masterPromptVersionIds: { T6: ancien.id } }, adminId);
    expect((await repo.getVersion(v.id))!.masterPrompts?.T6?.versionId).toBe(ancien.id);
    await svc.activate(v.id, adminId);
    const [enService] = await sql<{ id: number }[]>`SELECT id FROM ai_master_prompt_versions WHERE environment = ${env} AND treatment = 'T6' AND status = 'ACTIVE'`;
    expect(enService.id).toBe(ancien.id);
    expect((await r6()).masterPromptVersionId).toBe(ancien.id);
    // Retour à la version précédente : son prompt figé revient.
    await svc.activate(active.id, adminId);
    if (active.masterPrompts?.T6) {
      const [x] = await sql<{ id: number }[]>`SELECT id FROM ai_master_prompt_versions WHERE environment = ${env} AND treatment = 'T6' AND status = 'ACTIVE'`;
      expect(x.id).toBe(active.masterPrompts.T6.versionId);
    }
    // Réactiver un prompt depuis « Prompts maîtres » : révision « master_prompt » de la configuration active.
    const mp = await import('@/services/ai/master-prompts/master-prompt.service');
    const avant = (await repo.getActiveVersion(env as never))!.currentRevisionNumber!;
    const [ancienStatut] = await sql<{ status: string }[]>`SELECT status FROM ai_master_prompt_versions WHERE id = ${ancien.id}`;
    if (ancienStatut.status === 'PREVIOUS') {
      await mp.reactivateVersion('T6', ancien.id, adminId);
      const apres = (await repo.getActiveVersion(env as never))!;
      expect(apres.currentRevisionNumber).toBe(avant + 1);
      expect(apres.masterPrompts?.T6?.versionId).toBe(ancien.id);
      expect((await repo.listRevisions(apres.id))[0].kind).toBe('master_prompt');
    }
    // La lecture de la configuration abandonne au-delà de 1,5 s (repli voulu
    // sur le code, jamais bloquant). Sous la charge de la suite complète, ce
    // délai était parfois atteint : relecture après invalidation (3 essais).
    async function r6() {
      const r = await resolver();
      let c = await r.resolveOperationConfig('t6_formulate');
      for (let i = 0; i < 3 && c.masterPromptVersionId == null; i += 1) {
        r.invalidateConfigCache();
        c = await r.resolveOperationConfig('t6_formulate');
      }
      return c;
    }
  });

  it('BOIA-18 — instantané autonome : version de prompt maître figée disparue → son texte est rétabli à l’activation (retour arrière jamais bloqué)', async () => {
    const { contentSha256 } = await import('@/services/ai/master-prompts/master-prompt.repository');
    const texte = `${(await import('@/services/ai/governance/master-corpus/cases')).readMasterFileFromRepo('t6_master_v1')}\n\n(e2e l54c disparue)`;
    const n = 7600 + Math.floor(Math.random() * 300);
    const [p] = await sql<{ id: number }[]>`
      INSERT INTO ai_master_prompt_versions (environment, treatment, master_prompt_code, version_number, status, content, content_sha256, origin, activated_at)
      VALUES (${env}, 'T6', 't6_master_v1', ${n}, 'PREVIOUS', ${texte}, ${contentSha256(texte)}, 'admin', now()) RETURNING id`;
    const v = await svc.createConfigVersion(adminId, { label: 'e2e-l54c disparue' });
    ids.push(v.id);
    await svc.saveConfiguration(v.id, { expectedRevision: v.currentRevisionNumber, masterPromptVersionIds: { T6: p.id } }, adminId);
    await sql`DELETE FROM ai_master_prompt_versions WHERE id = ${p.id}`;
    await svc.activate(v.id, adminId);
    const [actif] = await sql<{ content: string; content_sha256: string }[]>`
      SELECT content, content_sha256 FROM ai_master_prompt_versions WHERE environment = ${env} AND treatment = 'T6' AND status = 'ACTIVE'`;
    expect([actif.content, actif.content_sha256]).toEqual([texte, contentSha256(texte)]);
  });
});
