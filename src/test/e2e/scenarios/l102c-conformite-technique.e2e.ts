/**
 * Lot 102C — conformité légale, écarts techniques (ticket « Mise en
 * conformité », P1 / P2), sur PostgreSQL 16 réel (migrations 0915 → 0917),
 * stockage objet SIMULÉ en mémoire, Resend SIMULÉ, horloge passée aux
 * traitements.
 *
 * L102C-E2E-01 Export RGPD dans TOUS les états restreints (lecture seule
 *              post-essai, post-abonnement, post-rétractation, suppression
 *              demandée) : demande, état, téléchargement de CHAQUE partie.
 * L102C-E2E-02 Tous les originaux en parties bornées (aucun omis), manifeste
 *              global + manifeste par partie ; purge de toutes les parties à
 *              l'expiration ; parties confiées à la file de purge à la
 *              suppression du compte.
 * L102C-E2E-03 Copie de données réelles : restauration d'un point de
 *              PRODUCTION refusée par défaut (aucune écriture) ; autorisation
 *              BO journalisée ; copie tracée, Supervision ; purge à
 *              l'échéance par le workflow de suppression ; anomalie résolue.
 * L102C-E2E-04 Copie de base détectée au démarrage (base « production »
 *              servie en préproduction), clôture BO journalisée.
 * L102C-E2E-05 Prospection : réglage désactivé par défaut (aucun bloc) ;
 *              « client existant » + case d'opposition : preuve, opposition
 *              appliquée ; la séquence 100G n'envoie qu'aux informés non
 *              opposés ; consentement : case non pré-cochée, consentement
 *              prouvé.
 */
import { NextRequest } from 'next/server';
import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { scenario } from '../scenario';
import { uid } from '../factories';

const etat = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_APP_ENV = 'preprod';
  process.env.RESEND_API_KEY = 're_e2e_simule_102c';
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.e2e.verebona.test';
  process.env.APP_URL = 'https://app.e2e.verebona.test';
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'secret-e2e-l102c-xxxxxxxxxxxxxxxxxxxx';
  process.env.GDPR_EXPORT_PART_MAX_BYTES = '100';
  return {
    objects: new Map<string, Buffer>(),
    session: { userId: 0 },
    calls: [] as Array<{ to: string; subject: string }>,
  };
});

// `after` (Next.js) hors requête : exécuté juste après, comme en service.
vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: (fn: () => unknown) => { void Promise.resolve().then(fn).catch(() => undefined); },
}));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: etat.session.userId, role: 'USER' }),
    handleSessionError: () => new Response('unauthorized', { status: 401 }),
  },
}));
// Lot 103C : stockage de l'export RGPD en flux disque ↔ stockage (profil worker).
vi.mock('@/services/gdpr/gdpr-storage', async () => {
  const fs = await import('node:fs');
  const { createHash } = await import('node:crypto');
  return {
    downloadStoredFileToPath: async (key: string, _bucket: string | null, dest: string) => {
      const b = etat.objects.get(key);
      if (!b) return { ok: false, reason: 'NOT_FOUND', detail: 'NOT_FOUND' };
      await fs.promises.writeFile(dest, b);
      return { ok: true, bytes: b.length, sha256: createHash('sha256').update(b).digest('hex') };
    },
    uploadFileFromPath: async (local: string, key: string) => { etat.objects.set(key, await fs.promises.readFile(local)); },
    deleteStoredFile: async (key: string) => { etat.objects.delete(key); return true; },
  };
});
vi.mock('@/services/export-upload.service', () => ({
  getExportSignedUrl: async (key: string, ttl: number, name?: string) => `https://s3.e2e.invalid/${key}?ttl=${ttl}&nom=${encodeURIComponent(name ?? '')}`,
}));
vi.mock('@/lib/notifications/event-service', () => ({ emit: async () => undefined }));
vi.mock('resend', () => ({
  Resend: class {
    emails = {
      send: async (p: { to: string; subject: string }) => { etat.calls.push(p); return { data: { id: `em_102c_${etat.calls.length}` }, error: null }; },
    };
  },
}));

type Json = Record<string, any>;
const req = (url: string, method = 'GET') => new NextRequest(`http://app.test${url}`, { method, headers: { origin: 'http://app.test', host: 'app.test' } });

scenario('L102C', 'Conformité : export restreint, stockage, copies de données réelles, prospection', ({ sql, make }) => {
  let admin: { id: number; email: string };
  beforeAll(async () => {
    admin = await make.user({ role: 'ADMIN' });
  });
  beforeEach(() => { etat.calls.length = 0; });

  /** Compte dans un état restreint donné, avec `n` documents de 40 octets chacun. */
  async function compte(state: 'trial_readonly' | 'subscription_ended' | 'withdrawal' | 'pending_deletion', n = 5) {
    const acc = await make.account({ plan: null });
    if (state === 'trial_readonly') {
      await sql`INSERT INTO account_subscriptions (account_id, plan_code, status, trial_consumed, trial_ends_at) VALUES (${acc.id}, 'premium', 'readonly', true, now() - interval '3 days')`;
    } else if (state === 'subscription_ended' || state === 'withdrawal') {
      await sql`INSERT INTO account_subscriptions (account_id, plan_code, status, first_billed_at) VALUES (${acc.id}, 'premium', 'canceled', now() - interval '40 days')`;
    } else {
      await sql`INSERT INTO account_subscriptions (account_id, plan_code, status) VALUES (${acc.id}, 'standard', 'active')`;
      await sql`UPDATE users SET status = 'PENDING_DELETION' WHERE id = ${acc.ownerUserId}`;
    }
    const files: number[] = [];
    for (let i = 0; i < n; i++) {
      const f = await make.assetFile(acc, { name: `${uid('doc')}.pdf` });
      const key = `e2e/${acc.id}/orig-${f.id}.pdf`;
      etat.objects.set(key, Buffer.from(`%PDF-${String(f.id).padStart(35, '0')}`)); // 40 octets
      await sql`UPDATE asset_files SET s3_key = ${key}, size = 40, original_filename = ${`facture-${i + 1}.pdf`} WHERE id = ${f.id}`;
      files.push(f.id);
    }
    return { ...acc, files };
  }

  async function exporter(userId: number) {
    etat.session.userId = userId;
    const route = await import('@/app/api/users/me/gdpr-export/route');
    const post = await route.POST(req('/api/users/me/gdpr-export', 'POST'));
    expect([200, 202]).toContain(post.status);
    // Lot 103C : la génération est faite par le worker durable (ici, un tour explicite).
    const { drainGdprExportQueue } = await import('@/services/gdpr/gdpr-export.job');
    await drainGdprExportQueue('e2e-l102c', { maxJobs: 5 });
    for (let i = 0; i < 50; i++) {
      const body = await (await route.GET(req('/api/users/me/gdpr-export'))).json() as Json;
      if (body.export?.status === 'ready') return body;
      if (body.export?.status === 'error') throw new Error('export en échec');
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('export non prêt');
  }

  it('L102C-E2E-01/02 — export dans chaque état restreint : toutes les parties, tous les originaux, manifestes', async () => {
    const download = (await import('@/app/api/users/me/gdpr-export/download/route')).GET;
    for (const state of ['trial_readonly', 'subscription_ended', 'withdrawal', 'pending_deletion'] as const) {
      const acc = await compte(state);
      const body = await exporter(acc.ownerUserId);
      // 5 documents de 40 octets, parties ≤ 100 octets → 3 parties (2 + 2 + 1).
      expect(body.parts.map((p: Json) => p.number)).toEqual([1, 2, 3]);
      expect(body.parts.map((p: Json) => p.documents)).toEqual([2, 2, 1]);
      expect(body.parts[1].downloadUrl).toBe('/api/users/me/gdpr-export/download?part=2');

      const zips: JSZip[] = [];
      for (const p of body.parts as Json[]) {
        const res = await download(req(p.downloadUrl));
        expect(res.status, `${state} partie ${p.number}`).toBe(302);
        const loc = res.headers.get('location')!;
        expect(loc).toMatch(/ttl=300/);
        const key = decodeURIComponent(new URL(loc).pathname.slice(1));
        zips.push(await JSZip.loadAsync(etat.objects.get(key)!));
      }
      expect((await download(req('/api/users/me/gdpr-export/download?part=9'))).status).toBe(404);
      expect((await download(req('/api/users/me/gdpr-export/download?part=abc'))).status).toBe(400);

      const manifest = JSON.parse(await zips[0].file('manifest.json')!.async('string')) as Json;
      expect(manifest.version).toBe(3);
      expect(manifest.status).toBe('COMPLET');
      expect(manifest.documents.included).toBe(5);
      expect(manifest.documents.skipped).toEqual([]);
      expect(manifest.parts).toHaveLength(3);
      expect(await zips[0].file('LISEZ-MOI.txt')!.async('string')).toMatch(/découpée en 3 parties/);
      // Chaque original présent exactement une fois, à l'endroit annoncé par le manifeste.
      const tous = new Set<string>();
      for (const [i, z] of zips.entries()) {
        const pm = JSON.parse(await z.file(`manifest-partie-${i + 1}.json`)!.async('string')) as Json;
        expect(pm).toMatchObject({ part: i + 1, totalParts: 3 });
        for (const d of pm.documents as Json[]) {
          const contenu = await z.file(d.path)!.async('nodebuffer');
          expect(contenu.length).toBe(40);
          tous.add(d.path);
        }
        if (i === 0) expect(z.file('donnees/users.json')).not.toBeNull();
        else expect(z.file('donnees/users.json')).toBeNull();
        if (i > 0) expect(z.file('manifest.json')).toBeNull();
      }
      expect(tous.size).toBe(5);
    }
  });

  it('L102C-E2E-02 — expiration : toutes les parties supprimées ; suppression du compte : parties en file de purge', async () => {
    const acc = await compte('trial_readonly', 3);
    await exporter(acc.ownerUserId);
    const keys = (await sql<{ s3_key: string }[]>`
      SELECT p.s3_key FROM gdpr_export_parts p JOIN gdpr_exports e ON e.id = p.export_id WHERE e.user_id = ${acc.ownerUserId}`).map((r) => r.s3_key);
    expect(keys).toHaveLength(2);
    for (const k of keys) expect(etat.objects.has(k)).toBe(true);

    // Suppression du compte : chaque partie confiée à la file de purge.
    const acc2 = await compte('subscription_ended', 3);
    await exporter(acc2.ownerUserId);
    const keys2 = (await sql<{ s3_key: string }[]>`
      SELECT p.s3_key FROM gdpr_export_parts p JOIN gdpr_exports e ON e.id = p.export_id WHERE e.user_id = ${acc2.ownerUserId}`).map((r) => r.s3_key);
    const { scheduleDeletion, executeScheduledDeletion } = await import('@/services/account/scheduled-deletion.service');
    const s = await scheduleDeletion({ accountId: acc2.id, userId: acc2.ownerUserId, reason: 'ADMIN', delayDays: 0 });
    expect((await executeScheduledDeletion(s.id)).status).toBe('executed');
    const enFile = (await sql<{ storage_path: string }[]>`SELECT storage_path FROM pending_blob_deletions WHERE storage_path = ANY(${keys2})`).map((r) => r.storage_path);
    expect(enFile.sort()).toEqual([...keys2].sort());

    // Expiration de l'archive : toutes les parties supprimées du stockage.
    await sql`UPDATE gdpr_exports SET expires_at = now() - interval '1 minute' WHERE user_id = ${acc.ownerUserId}`;
    const { purgeExpiredExports } = await import('@/services/gdpr/gdpr-export.service');
    expect(await purgeExpiredExports({ userId: acc.ownerUserId })).toBe(1);
    for (const k of keys) expect(etat.objects.has(k)).toBe(false);
    const [st] = await sql<{ status: string }[]>`SELECT status FROM gdpr_exports WHERE user_id = ${acc.ownerUserId} ORDER BY id DESC LIMIT 1`;
    expect(st.status).toBe('expired');
  });

  it('L102C-E2E-03 — point de PRODUCTION : refusé par défaut, autorisé (journalisé), tracé, purgé à l’échéance', async () => {
    const backupId = '2b1f4c1e-0000-4000-8000-000000000102';
    const manifest = { version: 2, backupId, environment: 'production', label: 'copie prod', tables: [], snapshot: { at: '2033-01-01T00:00:00Z' }, dataKey: 'x' };
    const storage = {
      bucket: 'b',
      client: {
        async send(c: { constructor: { name: string }; input: Json }) {
          if (c.constructor.name === 'ListObjectsV2Command') return { Contents: [{ Key: 'backups/2033-01-01.json', LastModified: new Date() }], IsTruncated: false };
          if (c.constructor.name === 'GetObjectCommand') return { Body: { transformToString: async () => JSON.stringify(manifest) } };
          throw new Error(`commande inattendue : ${c.constructor.name}`);
        },
      },
    };
    const { restoreDatabaseBackup } = await import('@/services/backup/database-restore.service');
    const avant = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM accounts`)[0].n;
    await expect(restoreDatabaseBackup(sql, backupId, { reason: 'test refus L102C', storage: storage as never, skipSafetyBackup: true }))
      .rejects.toThrow(/autre environnement[\s\S]*refusé par défaut/);
    expect((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM accounts`)[0].n).toBe(avant);

    const svc = await import('@/services/admin/production-copies/production-copies.service');
    await expect(svc.authorizeRestoreImport({ backupId, reason: 'court', admin, manifestEnvironment: 'production' })).rejects.toMatchObject({ code: 'REASON_REQUIRED' });
    // Lot 104A (P1-F) : politique prudente — refus tant que la propagation des suppressions
    // de production n'est pas configurée ET vérifiée (scénarios complets : l104a-legal-finition).
    await expect(svc.authorizeRestoreImport({ backupId, reason: 'Analyse d’un incident de production L102C', admin, manifestEnvironment: 'production' }))
      .rejects.toMatchObject({ code: 'DELETION_PROPAGATION_NOT_READY' });
    process.env.PRODUCTION_DELETION_SIGNAL_KEY = 'cle-partagee-e2e-l102c-xxxxxxxxxxxxxxxx';
    process.env.PRODUCTION_DELETION_SIGNAL_URL = 'https://prod.e2e.verebona.test';
    await sql`INSERT INTO production_deletion_signal_state (id, last_attempt_at, last_success_at, last_status) VALUES (1, now(), now(), 'ok')
              ON CONFLICT (id) DO UPDATE SET last_success_at = now(), last_status = 'ok'`;
    const copy = await svc.authorizeRestoreImport({ backupId, reason: 'Analyse d’un incident de production L102C', admin, manifestEnvironment: 'production' });
    expect(copy).toMatchObject({ status: 'authorized', sourceEnvironment: 'production', targetEnvironment: 'preprod', responsibleEmail: admin.email });
    const [audit] = await sql<Json[]>`SELECT action_type, target_type, target_id FROM admin_audit_log WHERE action_type = 'PRODUCTION_COPY_AUTHORIZE' ORDER BY id DESC LIMIT 1`;
    expect(audit).toMatchObject({ target_type: 'PRODUCTION_COPY', target_id: copy.id });
    await expect(svc.authorizeRestoreImport({ backupId, reason: 'Seconde autorisation L102C', admin, manifestEnvironment: 'production' })).rejects.toMatchObject({ code: 'ALREADY_AUTHORIZED' });

    const decision = await svc.guardRestoreOrigin('production', backupId);
    expect(decision).toEqual({ allowed: true, origin: 'foreign_production', copyId: copy.id });

    // Import réussi (simulé : la restauration appelle markRestoreImported en fin de transaction).
    const reel = await make.account();
    const T0 = new Date('2033-02-01T10:00:00Z');
    await svc.markRestoreImported(copy.id, sql, T0);
    await sql`UPDATE production_data_copies SET account_ids = ${JSON.stringify([reel.id])}::jsonb WHERE id = ${copy.id}`;
    const [actif] = await svc.listProductionCopies();
    expect(actif).toMatchObject({ id: copy.id, status: 'active', accounts: 1, importedAt: T0.toISOString(), expiresAt: '2033-03-03T10:00:00.000Z' });
    const ouverte = async () => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM admin_anomalies WHERE fingerprint LIKE '%production-copy%' AND status = 'open'`)[0].n;
    expect(await ouverte()).toBe(1);

    // Avant l'échéance : rien. À l'échéance : comptes supprimés par le workflow existant.
    expect(await svc.purgeExpiredProductionCopies({ now: new Date('2033-03-01T00:00:00Z') })).toEqual({ purged: 0, failed: 0 });
    expect(await svc.purgeExpiredProductionCopies({ now: new Date('2033-03-04T00:00:00Z') })).toEqual({ purged: 1, failed: 0 });
    expect((await sql`SELECT 1 FROM accounts WHERE id = ${reel.id}`).length).toBe(0);
    const [purgee] = await sql<Json[]>`SELECT status, purged_at, purge_report FROM production_data_copies WHERE id = ${copy.id}`;
    expect(purgee.status).toBe('purged');
    expect(purgee.purge_report).toMatchObject({ executed: 1 });
    expect(await ouverte()).toBe(0);
    delete process.env.PRODUCTION_DELETION_SIGNAL_KEY;
    delete process.env.PRODUCTION_DELETION_SIGNAL_URL;
  });

  it('L102C-E2E-04 — copie de base détectée au démarrage, clôture BO journalisée', async () => {
    const svc = await import('@/services/admin/production-copies/production-copies.service');
    await sql`DELETE FROM environment_identity`;
    expect(await svc.startupProductionCopyCheck(sql)).toEqual({ detected: false, copyId: null });
    expect((await sql<{ environment: string }[]>`SELECT environment FROM environment_identity`)[0].environment).toBe('preprod');

    // La base a été chargée depuis la production (copie hors application).
    await sql`UPDATE environment_identity SET environment = 'production'`;
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = await svc.startupProductionCopyCheck(sql);
    err.mockRestore();
    expect(r.detected).toBe(true);
    // Redémarrage : pas de doublon.
    expect((await svc.startupProductionCopyCheck(sql)).copyId).toBe(r.copyId);
    const [c] = await sql<Json[]>`SELECT origin, status, responsible_email, source_environment FROM production_data_copies WHERE id = ${r.copyId}`;
    expect(c).toMatchObject({ origin: 'database_copy', status: 'active', responsible_email: 'détection automatique', source_environment: 'production' });

    await svc.closeProductionCopy({ id: r.copyId!, reason: 'Fausse détection : variable renommée (L102C)', admin });
    expect((await sql<{ environment: string }[]>`SELECT environment FROM environment_identity`)[0].environment).toBe('preprod');
    expect((await sql`SELECT 1 FROM admin_audit_log WHERE action_type = 'PRODUCTION_COPY_CLOSE' AND target_id = ${r.copyId}`).length).toBe(1);
    expect((await svc.startupProductionCopyCheck(sql)).detected).toBe(false);
  });

  it('L102C-E2E-05 — prospection : bloc à l’inscription selon la base légale, preuve, séquence 100G alignée', async () => {
    const notice = async () => (await (await (await import('@/app/api/public/marketing/signup-notice/route')).GET()).json() as Json).notice;
    const { saveTrialLifecycleSettings } = await import('@/services/trial-lifecycle/settings.service');
    const { recordSignupMarketingChoice } = await import('@/services/trial-lifecycle/signup-collection');
    const save = async (patch: Json) => saveTrialLifecycleSettings({ patch, admin: { id: admin.id, email: admin.email } });
    await sql`DELETE FROM trial_lifecycle_settings`;

    // Défaut : rien n'est affiché, rien n'est enregistré.
    expect(await notice()).toBeNull();
    const u0 = await make.user();
    expect(await recordSignupMarketingChoice({ userId: u0.id, context: 'signup', marketing: { checked: true } })).toEqual({ recorded: false, choice: null });

    // « Client existant » + campagne sans information à l'inscription : refusé.
    const refus = await save({ legalBasis: 'soft_opt_in', softOptInDeclared: true, commercialEnabled: true });
    expect(refus.ok).toBe(false);
    expect((await save({ legalBasis: 'soft_opt_in', softOptInDeclared: true, commercialEnabled: true, signupCollection: { enabled: true, softOptInMechanism: 'opt_out_checkbox' } })).ok).toBe(true);
    const n = await notice();
    expect(n).toMatchObject({ mechanism: 'opt_out_checkbox', checkboxLabel: 'Je ne souhaite pas recevoir ces e-mails.' });
    expect(n.privacyUrl).toMatch(/\/confidentialite$/);

    // Trois inscrits : informé non opposé, opposé à l'inscription, sans preuve (ancien formulaire).
    const END = '2033-03-10T14:05:00.000Z';
    const essai = async () => {
      const owner = await make.user({ email: `l102c-${uid('p')}@test.invalid` });
      const acc = await make.account({ owner, plan: null });
      await sql`INSERT INTO account_subscriptions (account_id, plan_code, status, trial_consumed, trial_started_at, trial_ends_at)
                VALUES (${acc.id}, 'premium', 'readonly', true, ${new Date(new Date(END).getTime() - 7 * 86_400_000).toISOString()}, ${END})`;
      return { ...acc, email: owner.email };
    };
    const informe = await essai(); const oppose = await essai(); const sansPreuve = await essai();
    expect(await recordSignupMarketingChoice({ userId: informe.ownerUserId, context: 'signup', marketing: { checked: false, noticeSha256: n.sha256 } })).toEqual({ recorded: true, choice: 'not_opposed' });
    expect(await recordSignupMarketingChoice({ userId: oppose.ownerUserId, context: 'social_signup', marketing: { checked: true, noticeSha256: n.sha256 } })).toEqual({ recorded: true, choice: 'opposed' });
    expect(await recordSignupMarketingChoice({ userId: sansPreuve.ownerUserId, context: 'signup', marketing: null })).toEqual({ recorded: false, choice: null });
    const [preuve] = await sql<Json[]>`SELECT context, legal_basis, mechanism, choice, notice_version, notice_sha256, privacy_url FROM marketing_collection_proofs WHERE user_id = ${informe.ownerUserId}`;
    expect(preuve).toMatchObject({ context: 'signup', legal_basis: 'soft_opt_in', mechanism: 'opt_out_checkbox', choice: 'not_opposed', notice_sha256: n.sha256 });
    expect((await sql`SELECT 1 FROM marketing_oppositions WHERE user_id = ${oppose.ownerUserId}`).length).toBe(1);

    // Séquence 100G (moteur unique) à J+3.
    await sql`INSERT INTO email_settings (id, emails_enabled, sender_name, sender_email, reply_to_email)
              VALUES (1, true, 'Verebona', 'bonjour@preprod.verebona.fr', 'support@verebona.fr') ON CONFLICT (id) DO UPDATE SET emails_enabled = true`;
    const { runTrialLifecycle } = await import('@/services/trial-lifecycle/sequence.service');
    await runTrialLifecycle({ now: new Date('2033-03-13T15:00:00Z'), accountIds: [informe.id, oppose.id, sansPreuve.id], deadline: Date.now() + 60_000 });
    const msg = async (accountId: number) => (await sql<Json[]>`SELECT status, reason FROM trial_lifecycle_messages WHERE account_id = ${accountId} AND milestone = 'J3'`)[0];
    expect(await msg(informe.id)).toMatchObject({ status: 'sent' });
    expect(await msg(oppose.id)).toMatchObject({ status: 'skipped', reason: 'opposition' });
    expect(await msg(sansPreuve.id)).toMatchObject({ status: 'deferred', reason: 'no_signup_information' });
    expect(etat.calls.map((c) => c.to)).toEqual([informe.email]);

    // Base « consentement » : case non pré-cochée ; consentement seulement si coché sur le bloc affiché.
    expect((await save({ legalBasis: 'consent', commercialEnabled: false })).ok).toBe(true);
    const c = await notice();
    expect(c.mechanism).toBe('consent_checkbox');
    const ok = await make.user(); const nonCoche = await make.user(); const autreBloc = await make.user();
    expect((await recordSignupMarketingChoice({ userId: ok.id, context: 'signup', marketing: { checked: true, noticeSha256: c.sha256 } })).choice).toBe('consented');
    expect((await recordSignupMarketingChoice({ userId: nonCoche.id, context: 'signup', marketing: { checked: false, noticeSha256: c.sha256 } })).choice).toBe('not_consented');
    expect((await recordSignupMarketingChoice({ userId: autreBloc.id, context: 'signup', marketing: { checked: true, noticeSha256: 'ancien' } })).choice).toBe('not_consented');
    const consentements = await sql<{ user_id: number; consented: boolean; source: string }[]>`
      SELECT user_id, consented, source FROM news_consents WHERE user_id IN (${ok.id}, ${nonCoche.id}, ${autreBloc.id})`;
    expect(consentements).toEqual([{ user_id: ok.id, consented: true, source: 'signup' }]);
  });
});
