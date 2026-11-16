/**
 * Lot 115B (Trello #800) — BO Notifications : diagnostic exhaustif, copiable
 * et téléchargeable des échecs, sur PostgreSQL 16 réel, par les VRAIES routes
 * du BO (garde administrateur réelle ; seule la lecture du cookie de session
 * est simulée) et le VRAI dispatcher (fournisseur push simulé, aucun réseau).
 *
 * L'incident témoin du 16/11/2026 est reconstitué : 72 livraisons
 * `failed · mobile_push_config`, 3 `skipped_unavailable ·
 * mobile_push_not_configured`, 1 `mobile_push_not_in_catalog`, et 7 tentatives
 * du « Récapitulatif quotidien À traiter » à 08:30 / 08:45 / 09:01.
 *
 *   L115B-E2E-01  agrégat cliquable : les 72 `mobile_push_config` donnent 72
 *                 lignes de livraison auditables, pagination exhaustive à
 *                 curseur, aucun doublon, aucun plafonnement silencieux (CA01)
 *   L115B-E2E-02  nouvelle erreur FCM (OAuth 401, THIRD_PARTY_AUTH_ERROR,
 *                 quota, jeton invalide) : étape, code, statut HTTP et cause
 *                 intelligibles dans le BO ET dans le JSON (CA02)
 *   L115B-E2E-03  les 3 `not_configured` et le `not_in_catalog` ne sont PAS
 *                 étiquetés échecs fournisseur (CA03)
 *   L115B-E2E-04  les 7 tentatives du récapitulatif = UN événement de
 *                 référence, pas sept (CA04)
 *   L115B-E2E-05  copier / télécharger : recherche filtrée ET diagnostic
 *                 individuel (CA05)
 *   L115B-E2E-06  mêmes totaux écran / export, manifeste de complétude,
 *                 aucune troncature silencieuse (CA06)
 *   L115B-E2E-07  critère invalide : code de diagnostic et erreur, jamais
 *                 « aucun résultat » (CA07)
 *   L115B-E2E-08  secrets absents des deux exports ; audit ; RBAC ; isolation
 *                 intercomptes et séparation des environnements (CA08)
 *   L115B-E2E-09  consultation et export n'envoient rien (CA09)
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { scenario } from '../scenario';
import type { MobilePushMessage, MobilePushProvider, MobilePushSendResult } from '@/lib/mobile/push-provider';

type Json = Record<string, any>;

/** Fournisseur simulé : le comportement est choisi par le préfixe du jeton. */
const envoi = { messages: [] as MobilePushMessage[] };
const fournisseur: MobilePushProvider = {
  name: 'fcm',
  async send(m: MobilePushMessage): Promise<MobilePushSendResult> {
    envoi.messages.push(m);
    if (m.token.startsWith('oauth401-')) {
      // Échec AVANT l'appel FCM : obtention du jeton d'accès refusée.
      return { ok: false, kind: 'config', code: 'oauth_401', statusCode: 401, step: 'oauth_fournisseur' };
    }
    if (m.token.startsWith('apns-')) {
      return { ok: false, kind: 'config', code: 'THIRD_PARTY_AUTH_ERROR', statusCode: 400, step: 'reponse_fournisseur' };
    }
    if (m.token.startsWith('quota-')) {
      return { ok: false, kind: 'transient', code: 'QUOTA_EXCEEDED', statusCode: 429, step: 'reponse_fournisseur' };
    }
    if (m.token.startsWith('bad-')) {
      return { ok: false, kind: 'invalid_token', code: 'UNREGISTERED', statusCode: 404, step: 'reponse_fournisseur' };
    }
    if (m.token.startsWith('reseau-')) {
      return { ok: false, kind: 'transient', code: 'timeout', step: 'appel_fournisseur' };
    }
    return { ok: true, messageId: `projects/e2e/messages/${envoi.messages.length}` };
  },
};

scenario('L115B', 'BO — diagnostic exhaustif des échecs de notification (#800)', ({ sql, make }) => {
  const session = { userId: 0, role: 'USER', email: '', expired: false };
  let NextRequest: typeof import('next/server').NextRequest;
  type Route = (r: import('next/server').NextRequest, c?: unknown) => Promise<Response>;
  let diagnostic: Route;
  let exportDiag: Route;
  let dossier: Route;

  const req = (url: string) => new NextRequest(`http://app.test${url}`, { headers: { origin: 'http://app.test', host: 'app.test' } });
  const as = (u: { id: number; email: string }, role: string) => { session.userId = u.id; session.role = role; session.email = u.email; session.expired = false; };

  const TAG = `l115b-${randomUUID().slice(0, 8)}`;
  /** Jamais exposé : il sert à prouver l'expurgation. */
  const SECRET = `-----BEGIN PRIVATE KEY-----MII${randomUUID().replace(/-/g, '')}-----END PRIVATE KEY-----`;
  const JETON_FCM = `fcm-token-${'z'.repeat(80)}`;

  let admin: { id: number; email: string };
  let simple: { id: number; email: string };
  let compte: { id: number; ownerUserId: number };
  let autreCompte: { id: number; ownerUserId: number };
  /** Événement de référence du récapitulatif, porteur de 7 tentatives. */
  let recapId = '';
  /** Événement de référence des 72 échecs historiques. */
  const historiques: string[] = [];
  let installationLocale = '';
  let installationProd = '';

  /** Lit le rapport du BO (JSON de l'écran). */
  const lire = async (qs: string): Promise<{ status: number; body: Json }> => {
    const res = await diagnostic(req(`/api/admin/notifications/diagnostic?${qs}`));
    return { status: res.status, body: await res.json() as Json };
  };
  /** Lit le texte copiable. */
  const copier = async (qs: string): Promise<{ status: number; type: string | null; texte: string }> => {
    const res = await diagnostic(req(`/api/admin/notifications/diagnostic?${qs}&format=texte`));
    return { status: res.status, type: res.headers.get('content-type'), texte: res.status === 200 ? await res.text() : '' };
  };
  /** Télécharge le périmètre filtré (flux JSON). */
  const telecharger = async (qs: string) => {
    const res = await exportDiag(req(`/api/admin/notifications/diagnostic/export?${qs}`));
    const texte = await res.text();
    return {
      status: res.status,
      disposition: res.headers.get('content-disposition'),
      type: res.headers.get('content-type'),
      total: res.headers.get('x-diagnostic-total'),
      id: res.headers.get('x-diagnostic-id'),
      texte,
    };
  };

  beforeAll(async () => {
    ({ NextRequest } = await import('next/server'));
    const { SessionService } = await import('@/lib/session-service');
    vi.spyOn(SessionService, 'getSession').mockImplementation(async () => {
      if (session.expired) throw new Error('INVALID_TOKEN');
      return { userId: session.userId, role: session.role, email: session.email } as never;
    });
    diagnostic = (await import('@/app/api/admin/notifications/diagnostic/route')).GET as Route;
    exportDiag = (await import('@/app/api/admin/notifications/diagnostic/export/route')).GET as Route;
    dossier = (await import('@/app/api/admin/notifications/diagnostic/[outboxId]/route')).GET as Route;

    const { setMobilePushProviderForTests } = await import('@/lib/mobile/push-provider');
    setMobilePushProviderForTests(fournisseur);

    const a = await make.user({ role: 'ADMIN' });
    const u = await make.user();
    admin = { id: a.id, email: a.email };
    simple = { id: u.id, email: u.email };
    const acc = await make.account({ name: `Famille ${TAG}` });
    compte = { id: acc.id, ownerUserId: acc.ownerUserId };
    const acc2 = await make.account({ name: `Autre famille ${TAG}` });
    autreCompte = { id: acc2.id, ownerUserId: acc2.ownerUserId };

    // Appareils : un local (environnement du serveur de test) et un marqué
    // « production », pour vérifier la séparation des environnements.
    const { registerPushInstallation } = await import('@/lib/mobile/push-installations');
    const idLocal = randomUUID();
    await registerPushInstallation({
      userId: compte.ownerUserId, accountId: compte.id, sessionId: null, installationId: idLocal,
      platform: 'android', appVersion: '1.3.0', build: '77', pushToken: `apns-${JETON_FCM}`,
    });
    const [lLocal] = await sql<Array<{ id: string }>>`SELECT id::text FROM mobile_push_installations WHERE installation_id = ${idLocal}`;
    installationLocale = lLocal.id;

    const idProd = randomUUID();
    await registerPushInstallation({
      userId: autreCompte.ownerUserId, accountId: autreCompte.id, sessionId: null, installationId: idProd,
      platform: 'ios', appVersion: '1.3.0', build: '77', pushToken: `apns-prod-${JETON_FCM}`,
    });
    await sql`UPDATE mobile_push_installations SET environment = 'production' WHERE installation_id = ${idProd}`;
    const [lProd] = await sql<Array<{ id: string }>>`SELECT id::text FROM mobile_push_installations WHERE installation_id = ${idProd}`;
    installationProd = lProd.id;

    /* ── L'incident témoin, reconstitué ────────────────────────────────── */

    // (a) 68 échecs HISTORIQUES `mobile_push_config` : aucune trace structurée
    //     (antérieurs à la migration 1745). Le message porte un secret, pour
    //     prouver que l'expurgation s'applique aussi à l'historique.
    //     68 historiques + 3 OAuth neufs + 1 THIRD_PARTY_AUTH_ERROR (tous
    //     classés `mobile_push_config` par le code) = les 72 du relevé.
    for (let i = 0; i < 68; i++) {
      const [o] = await sql<Array<{ id: string }>>`
        INSERT INTO notification_outbox (event_type, category, account_id, recipient_user_id, dedupe_key, status, attempt_count, created_at, processed_at, last_error)
        VALUES ('DEADLINE_DUE_IN_7_DAYS', 'deadlines', ${compte.id}, ${compte.ownerUserId}, ${`${TAG}:hist:${i}`}, 'failed', 1,
                now() - make_interval(hours => ${30 + i}), now() - make_interval(hours => ${30 + i}), 'mobile_push_config')
        RETURNING id::text`;
      historiques.push(o.id);
      await sql`
        INSERT INTO notification_deliveries (outbox_id, user_id, channel, mobile_push_installation_id, status, last_error_code, last_error_message, attempt_count, attempted_at, created_at)
        VALUES (${o.id}::uuid, ${compte.ownerUserId}, 'push', ${installationLocale}::uuid, 'failed', 'mobile_push_config',
                ${`échec d’envoi avec ${SECRET} pour ${JETON_FCM}`}, 1,
                now() - make_interval(hours => ${30 + i}), now() - make_interval(hours => ${30 + i}))`;
    }

    // (b) 3 échecs NEUFS, produits par le vrai dispatcher : OAuth 401 refusé
    //     avant l'appel FCM.
    const { emit } = await import('@/lib/notifications');
    const { processPending } = await import('@/lib/notifications');
    await sql`UPDATE mobile_push_installations SET push_token_enc = push_token_enc WHERE id = ${installationLocale}::uuid`;
    for (let i = 0; i < 3; i++) {
      // Jeton « oauth401- » : le fournisseur simulé refuse à l'étape OAuth.
      const idN = randomUUID();
      await registerPushInstallation({
        userId: compte.ownerUserId, accountId: compte.id, sessionId: null, installationId: idN,
        platform: 'android', appVersion: '1.3.0', build: '77', pushToken: `oauth401-${JETON_FCM}-${i}`,
      });
      await sql`UPDATE mobile_push_installations SET status = 'logged_out'
                 WHERE user_id = ${compte.ownerUserId} AND installation_id <> ${idN}`;
      await emit({
        type: 'DEADLINE_DUE_IN_7_DAYS', recipientUserIds: [compte.ownerUserId], accountId: compte.id,
        entityType: 'agenda', entityId: `${TAG}-oauth-${i}`, payload: { count: 1, date: '2026-12-01' },
        dedupeKey: `${TAG}:oauth:${i}`, scheduledFor: new Date(),
      });
      for (let n = 0; n < 10; n++) if ((await processPending(50)).claimed === 0) break;
    }
    // L'appareil « apns- » (THIRD_PARTY_AUTH_ERROR) et les autres cas FCM sont
    // remis en service pour les tentatives suivantes.
    await sql`UPDATE mobile_push_installations SET status = 'active' WHERE id = ${installationLocale}::uuid`;

    // (c) 1 cas par erreur FCM caractéristique (CA02), par le vrai dispatcher.
    for (const [suffixe, cle] of [['apns', 'apns'], ['quota', 'quota'], ['bad', 'jeton'], ['reseau', 'reseau']] as const) {
      const idN = randomUUID();
      await registerPushInstallation({
        userId: compte.ownerUserId, accountId: compte.id, sessionId: null, installationId: idN,
        platform: 'ios', appVersion: '1.3.0', build: '77', pushToken: `${suffixe}-${JETON_FCM}-${cle}`,
      });
      await sql`UPDATE mobile_push_installations SET status = 'logged_out'
                 WHERE user_id = ${compte.ownerUserId} AND installation_id <> ${idN}`;
      await emit({
        type: 'DEADLINE_DUE_IN_7_DAYS', recipientUserIds: [compte.ownerUserId], accountId: compte.id,
        entityType: 'agenda', entityId: `${TAG}-${cle}`, payload: { count: 1, date: '2026-12-02' },
        dedupeKey: `${TAG}:fcm:${cle}`, scheduledFor: new Date(),
      });
      for (let n = 0; n < 10; n++) if ((await processPending(50)).claimed === 0) break;
    }

    // (d) 3 `mobile_push_not_configured` : fournisseur ABSENT au moment du
    //     traitement — cas distinct d'un échec FCM (#800 §1).
    setMobilePushProviderForTests(null);
    await sql`UPDATE mobile_push_installations SET status = 'active' WHERE user_id = ${compte.ownerUserId}`;
    await sql`UPDATE mobile_push_installations SET status = 'logged_out'
               WHERE user_id = ${compte.ownerUserId} AND id <> ${installationLocale}::uuid`;
    for (let i = 0; i < 3; i++) {
      await emit({
        type: 'DEADLINE_DUE_IN_7_DAYS', recipientUserIds: [compte.ownerUserId], accountId: compte.id,
        entityType: 'agenda', entityId: `${TAG}-nc-${i}`, payload: { count: 1, date: '2026-12-03' },
        dedupeKey: `${TAG}:nc:${i}`, scheduledFor: new Date(),
      });
      for (let n = 0; n < 10; n++) if ((await processPending(50)).claimed === 0) break;
    }
    setMobilePushProviderForTests(fournisseur);

    // (e) 1 `mobile_push_not_in_catalog` : type d'événement dont le catalogue
    //     interdit le push mobile — potentiellement conforme, jamais un échec.
    const [oCat] = await sql<Array<{ id: string }>>`
      INSERT INTO notification_outbox (event_type, category, account_id, recipient_user_id, dedupe_key, status, attempt_count, created_at, processed_at, outcome_reason)
      VALUES ('NEWS_PUBLISHED', 'news', ${compte.id}, ${compte.ownerUserId}, ${`${TAG}:catalogue`}, 'skipped', 1, now() - interval '2 hours', now() - interval '2 hours', 'mobile_push_not_in_catalog')
      RETURNING id::text`;
    await sql`
      INSERT INTO notification_deliveries (outbox_id, user_id, channel, mobile_push_installation_id, status, last_error_code, failure_step, failure_category, attempt_count, attempted_at, created_at)
      VALUES (${oCat.id}::uuid, ${compte.ownerUserId}, 'push', ${installationLocale}::uuid, 'skipped_unavailable', 'mobile_push_not_in_catalog', 'catalogue', 'ignore', 1, now() - interval '2 hours', now() - interval '2 hours')`;

    // (f) Le récapitulatif du 15/11 : UN événement de référence, 7 tentatives
    //     de livraison à 08:30, 08:45 et 09:01 (CA04).
    const [oRecap] = await sql<Array<{ id: string }>>`
      INSERT INTO notification_outbox (event_type, category, account_id, recipient_user_id, dedupe_key, status, attempt_count, created_at, processed_at, last_error)
      VALUES ('TO_PROCESS_DAILY_DIGEST', 'to_process', ${compte.id}, ${compte.ownerUserId}, ${`${TAG}:digest:2026-11-15`}, 'failed', 3,
              timestamptz '2026-11-15 08:25:00+01', timestamptz '2026-11-15 09:01:30+01', 'mobile_push_config')
      RETURNING id::text`;
    recapId = oRecap.id;
    const heures = ['08:30:00', '08:30:05', '08:45:00', '08:45:04', '09:01:00', '09:01:10', '09:01:20'];
    for (const h of heures) {
      await sql`
        INSERT INTO notification_deliveries (outbox_id, user_id, channel, mobile_push_installation_id, status, last_error_code, last_error_message, attempt_count, attempted_at, created_at)
        VALUES (${recapId}::uuid, ${compte.ownerUserId}, 'push', ${installationLocale}::uuid, 'failed', 'mobile_push_config', 'mobile_push_config', 1,
                ${`2026-11-15 ${h}+01`}::timestamptz, ${`2026-11-15 ${h}+01`}::timestamptz)`;
    }

    // (g) Un échec de l'AUTRE compte, sur un appareil « production » : il ne
    //     doit jamais apparaître dans un périmètre « local » ni dans celui du
    //     premier compte.
    const [oAutre] = await sql<Array<{ id: string }>>`
      INSERT INTO notification_outbox (event_type, category, account_id, recipient_user_id, dedupe_key, status, attempt_count, created_at, processed_at)
      VALUES ('DEADLINE_DUE_IN_7_DAYS', 'deadlines', ${autreCompte.id}, ${autreCompte.ownerUserId}, ${`${TAG}:autre`}, 'failed', 1, now() - interval '3 hours', now() - interval '3 hours')
      RETURNING id::text`;
    await sql`
      INSERT INTO notification_deliveries (outbox_id, user_id, channel, mobile_push_installation_id, status, last_error_code, failure_step, provider_name, provider_status_code, provider_error_code, failure_category, attempt_count, attempted_at, created_at)
      VALUES (${oAutre.id}::uuid, ${autreCompte.ownerUserId}, 'push', ${installationProd}::uuid, 'failed', 'mobile_push_config', 'reponse_fournisseur', 'fcm', 403, 'PERMISSION_DENIED', 'config', 1, now() - interval '3 hours', now() - interval '3 hours')`;

    as(admin, 'ADMIN');
  });

  afterAll(async () => {
    const { setMobilePushProviderForTests } = await import('@/lib/mobile/push-provider');
    setMobilePushProviderForTests(undefined);
    vi.restoreAllMocks();
  });

  /* ── L115B-E2E-01 ───────────────────────────────────────────────────── */

  it('L115B-E2E-01 — les 72 échecs `mobile_push_config` ouvrent 72 livraisons auditables, paginées sans doublon (CA01)', async () => {
    as(admin, 'ADMIN');
    const base = `periode=30j&compteId=${compte.id}&code=mobile_push_config&statutLivraison=failed`;
    const r = await lire(base);
    expect(r.status).toBe(200);
    // 69 historiques + 3 OAuth neufs = 72 ; le récapitulatif a ses 7 tentatives.
    expect(r.body.total).toBe(72 + 7);

    // L'agrégat cliquable annonce exactement ce que le détail rendra.
    const sans = await lire(`periode=30j&compteId=${compte.id}`);
    const agregat = (sans.body.agregats as Json[]).find((a) => a.code === 'mobile_push_config' && a.statut === 'failed' && a.canal === 'push');
    expect(agregat).toBeDefined();
    expect(agregat!.livraisons).toBe(72 + 7);

    // Pagination exhaustive à curseur : toutes les lignes, aucune en double.
    const vues = new Set<string>();
    let curseur: string | null = null;
    let pages = 0;
    do {
      const page: { status: number; body: Json } = await lire(`${base}&taille=25${curseur ? `&curseur=${encodeURIComponent(curseur)}` : ''}`);
      expect(page.status).toBe(200);
      for (const l of page.body.lignes as Json[]) {
        expect(vues.has(l.id), 'aucune livraison rendue deux fois').toBe(false);
        vues.add(l.id);
      }
      curseur = page.body.curseurSuivant as string | null;
      pages += 1;
    } while (curseur && pages < 20);
    expect(vues.size).toBe(72 + 7);
    expect(pages).toBeGreaterThan(1);

    // Chaque ligne porte son événement de référence, sa date et son appareil.
    const une = (r.body.lignes as Json[])[0];
    expect(une.evenementId).toMatch(/^[0-9a-f-]{36}$/);
    expect(une.creeLe.paris).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(une.creeLe.iso).toMatch(/Z$/);
    expect(une.appareilId).not.toBeNull();
  });

  /* ── L115B-E2E-02 ───────────────────────────────────────────────────── */

  it('L115B-E2E-02 — une nouvelle erreur FCM porte étape, code, statut HTTP et cause ; aucune cause fausse si indéterminée (CA02)', async () => {
    as(admin, 'ADMIN');
    const r = await lire(`periode=30j&compteId=${compte.id}&canal=push&taille=500`);
    const lignes = r.body.lignes as Json[];
    const parCode = (c: string) => lignes.find((l) => l.codeFournisseur === c);

    // OAuth 401 : l'étape est l'obtention du jeton d'accès, PAS l'appel FCM.
    const oauth = parCode('oauth_401');
    expect(oauth, 'un échec OAuth est enregistré').toBeDefined();
    expect(oauth!.etape).toBe('oauth_fournisseur');
    expect(oauth!.statutHttp).toBe(401);
    expect(oauth!.categorieEchec).toBe('config');
    expect(oauth!.fournisseur).toBe('fcm');
    expect(oauth!.nature).toBe('echec_reel');
    expect(oauth!.famille).toBe('configuration');

    // THIRD_PARTY_AUTH_ERROR (route APNs) : configuration, et non jeton.
    const apns = parCode('THIRD_PARTY_AUTH_ERROR');
    expect(apns).toBeDefined();
    expect(apns!.etape).toBe('reponse_fournisseur');
    expect(apns!.statutHttp).toBe(400);
    expect(apns!.categorieEchec).toBe('config');

    // Quota : transitoire, 429.
    const quota = parCode('QUOTA_EXCEEDED');
    expect(quota).toBeDefined();
    expect(quota!.statutHttp).toBe(429);
    expect(quota!.categorieEchec).toBe('transient');

    // Jeton invalide : la livraison est « expirée », pas un échec fournisseur.
    const jeton = parCode('UNREGISTERED');
    expect(jeton).toBeDefined();
    expect(jeton!.statut).toBe('expired');
    expect(jeton!.nature).toBe('jeton_expire');
    expect(jeton!.statutHttp).toBe(404);

    // Réseau : aucune réponse HTTP — le statut reste VIDE, rien n'est inventé.
    const reseau = parCode('timeout');
    expect(reseau).toBeDefined();
    expect(reseau!.etape).toBe('appel_fournisseur');
    expect(reseau!.statutHttp).toBeNull();

    // Historique : étape et statut absents, et c'est dit.
    const hist = lignes.find((l) => l.evenementId === historiques[0]);
    expect(hist).toBeDefined();
    expect(hist!.etape).toBeNull();
    expect(hist!.statutHttp).toBeNull();
    expect(hist!.codeFournisseur).toBeNull();
    expect(hist!.instrumentationStructuree).toBe(false);
    expect(r.body.champsNonEnregistres.join(' ')).toContain('Étape fautive non enregistrée');

    // Les mêmes faits figurent dans le JSON téléchargé.
    const t = await telecharger(`periode=30j&compteId=${compte.id}&canal=push&codeFournisseur=oauth_401`);
    const doc = JSON.parse(t.texte) as Json;
    expect(doc.livraisons.length).toBeGreaterThan(0);
    expect(doc.livraisons[0].etape).toBe('oauth_fournisseur');
    expect(doc.livraisons[0].statutHttp).toBe(401);
  });

  /* ── L115B-E2E-03 ───────────────────────────────────────────────────── */

  it('L115B-E2E-03 — `not_configured` et `not_in_catalog` ne sont pas quatre échecs fournisseur FCM (CA03)', async () => {
    as(admin, 'ADMIN');
    const r = await lire(`periode=30j&compteId=${compte.id}&canal=push&taille=500`);
    const lignes = r.body.lignes as Json[];
    const nc = lignes.filter((l) => l.code === 'mobile_push_not_configured');
    const cat = lignes.filter((l) => l.code === 'mobile_push_not_in_catalog');
    expect(nc.length).toBe(3);
    expect(cat.length).toBe(1);
    for (const l of [...nc, ...cat]) {
      expect(l.statut).toBe('skipped_unavailable');
      expect(l.nature).toBe('ignore_volontaire');
      expect(l.natureLibelle).toBe('Ignoré volontairement');
      expect(l.famille).not.toBe('fournisseur');
      expect(l.statutHttp).toBeNull();
    }
    expect(nc[0].famille).toBe('configuration');
    expect(nc[0].etape).toBe('configuration');
    expect(cat[0].famille).toBe('catalogue');
    expect(cat[0].etape).toBe('catalogue');

    // Aucun d'eux n'est compté dans les échecs réels.
    const echecs = await lire(`periode=30j&compteId=${compte.id}&nature=echec_reel&taille=500`);
    for (const l of echecs.body.lignes as Json[]) {
      expect(['mobile_push_not_configured', 'mobile_push_not_in_catalog']).not.toContain(l.code);
    }

    // Et l'état de configuration correspondant est exposé, sans secret.
    expect(Object.keys(r.body.configurationPush)).toContain('Compte de service lisible');
    expect(r.body.configurationPush['Droits et API réellement vérifiés']).toBe(false);
  });

  /* ── L115B-E2E-04 ───────────────────────────────────────────────────── */

  it('L115B-E2E-04 — les 7 tentatives de 08:30 / 08:45 / 09:01 sont UN événement de référence, pas sept (CA04)', async () => {
    as(admin, 'ADMIN');
    const r = await lire(`periode=dates&depuis=2026-11-15T00:00:00Z&jusqu=2026-11-16T00:00:00Z&compteId=${compte.id}&evenement=TO_PROCESS_DAILY_DIGEST&taille=100`);
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(7);
    // Le point de la carte : sept lignes « Échec », UN seul événement.
    expect(r.body.synthese.evenementsDistincts).toBe(1);
    // Les tentatives de l'événement ne sont pas multipliées par les livraisons.
    expect(r.body.synthese.tentativesEvenements).toBe(3);
    const heures = (r.body.lignes as Json[]).map((l) => l.creeLe.paris.slice(11, 16)).sort();
    expect(heures).toEqual(['08:30', '08:30', '08:45', '08:45', '09:01', '09:01', '09:01']);

    // Le dossier individuel regroupe les tentatives sous l'événement porteur.
    const res = await dossier(req(`/api/admin/notifications/diagnostic/${recapId}`), { params: Promise.resolve({ outboxId: recapId }) });
    expect(res.status).toBe(200);
    const d = await res.json() as Json;
    expect(d.evenement.id).toBe(recapId);
    expect(d.evenement.tentatives).toBe(3);
    expect(d.livraisons.length).toBe(7);
    expect(d.synthese.evenementsDistincts).toBe(1);
    // « Communiqué » n'est pas revendiqué : aucune livraison acceptée.
    expect(d.synthese.parNature.accepte_par_prestataire).toBe(0);
  });

  /* ── L115B-E2E-05 ───────────────────────────────────────────────────── */

  it('L115B-E2E-05 — copier et télécharger, sur la recherche comme sur un diagnostic individuel (CA05)', async () => {
    as(admin, 'ADMIN');
    const qs = `periode=30j&compteId=${compte.id}&code=mobile_push_config&statutLivraison=failed`;

    // Page volontairement bornée : la copie doit l'avouer.
    const c = await copier(`${qs}&taille=10`);
    expect(c.status).toBe(200);
    expect(c.type).toMatch(/^text\/plain/);
    expect(c.texte).toContain('Identifiant du diagnostic : DIAG-NOTIF-');
    expect(c.texte).toContain('Synthèse chiffrée');
    expect(c.texte).toContain('Causes par statut et code');
    expect(c.texte).toContain('Chronologie des tentatives');
    expect(c.texte).toContain('Complétude');
    expect(c.texte).toContain('Éléments non disponibles');
    // Copie bornée à la page : elle le dit et renvoie au téléchargement.
    expect(c.texte).toContain('Télécharger les résultats filtrés');

    const t = await telecharger(qs);
    expect(t.status).toBe(200);
    expect(t.type).toMatch(/^application\/json/);
    expect(t.disposition).toContain('verebona-notifications-diagnostic-');
    expect(t.disposition).toMatch(/\.json/);
    const doc = JSON.parse(t.texte) as Json;
    expect(doc.schema).toBe('verebona.notifications.diagnostic/1');
    expect(doc.perimetre.identifiantDiagnostic).toBe(t.id);
    expect(doc.livraisons.length).toBe(72 + 7);
    expect(doc.manifeste.attendu).toBe(72 + 7);
    expect(doc.manifeste.exporte).toBe(72 + 7);
    expect(doc.synthese.livraisons).toBe(72 + 7);
    expect(doc.agregats.length).toBeGreaterThan(0);
    expect(doc.configurationPush).toBeDefined();
    expect(doc.file).toBeDefined();

    // Diagnostic individuel : copie et téléchargement.
    const ctx = { params: Promise.resolve({ outboxId: recapId }) };
    const texteUn = await dossier(req(`/api/admin/notifications/diagnostic/${recapId}?format=texte`), ctx);
    expect(texteUn.status).toBe(200);
    const brut = await texteUn.text();
    expect(brut).toContain('Diagnostic d’un événement de référence');
    expect(brut).toContain('Chronologie des tentatives');
    const jsonUn = await dossier(req(`/api/admin/notifications/diagnostic/${recapId}?download=1`), ctx);
    expect(jsonUn.headers.get('content-disposition')).toContain('verebona-notifications-diagnostic-evenement-');
    const docUn = JSON.parse(await jsonUn.text()) as Json;
    expect(docUn.schema).toBe('verebona.notifications.diagnostic/1');
    expect(docUn.livraisons.length).toBe(7);

    // Jamais « Opération » : « événement de référence ».
    expect(brut).not.toMatch(/Opération/);
    expect(c.texte).not.toMatch(/Opération/);
  });

  /* ── L115B-E2E-06 ───────────────────────────────────────────────────── */

  it('L115B-E2E-06 — mêmes totaux écran / export, manifeste explicite, aucune troncature silencieuse (CA06)', async () => {
    as(admin, 'ADMIN');
    for (const qs of [
      `periode=30j&compteId=${compte.id}`,
      `periode=30j&compteId=${compte.id}&canal=push&nature=echec_reel`,
      `periode=30j&compteId=${compte.id}&famille=deduplication`,
      `periode=30j&compteId=${compte.id}&evenement=TO_PROCESS_DAILY_DIGEST`,
    ]) {
      const ecran = await lire(`${qs}&taille=10`);
      const fichier = await telecharger(qs);
      const doc = JSON.parse(fichier.texte) as Json;
      expect(doc.synthese.livraisons, qs).toBe(ecran.body.total);
      expect(Number(fichier.total), qs).toBe(ecran.body.total);
      expect(doc.livraisons.length, qs).toBe(ecran.body.total);
      expect(doc.manifeste.exporte, qs).toBe(doc.manifeste.attendu);
      // Références identiques, et non seulement le même compte.
      const refsFichier = new Set((doc.livraisons as Json[]).map((l) => l.id));
      for (const l of ecran.body.lignes as Json[]) expect(refsFichier.has(l.id), qs).toBe(true);
      // Écran borné : il l'annonce au lieu de laisser croire à l'exhaustivité.
      if (ecran.body.total > 10) {
        expect((ecran.body.lignes as Json[]).length).toBe(10);
        expect(ecran.body.curseurSuivant).not.toBeNull();
        const section = (ecran.body.sections as Json[]).find((s) => s.nom === 'livraisons');
        expect(section!.statut).toBe('PARTIAL');
        expect(section!.motif).toContain('Télécharger les résultats filtrés');
      }
    }

    // Manifeste : jamais « COMPLETE » si une trace nécessaire manque.
    const avecHistorique = JSON.parse((await telecharger(`periode=30j&compteId=${compte.id}&code=mobile_push_config`)).texte) as Json;
    expect(avecHistorique.manifeste.statut).toBe('PARTIAL');
    expect(avecHistorique.manifeste.champsNonEnregistres.length).toBeGreaterThan(0);

    // Périmètre vide : document valide, section NOT_APPLICABLE, pas d'erreur.
    const vide = await telecharger(`periode=24h&compteId=${compte.id}&code=un_code_inexistant`);
    expect(vide.status).toBe(200);
    const docVide = JSON.parse(vide.texte) as Json;
    expect(docVide.livraisons).toEqual([]);
    expect(docVide.manifeste.attendu).toBe(0);
    expect((docVide.completude.sections as Json[]).find((s) => s.nom === 'livraisons')!.statut).toBe('NOT_APPLICABLE');
  });

  /* ── L115B-E2E-07 ───────────────────────────────────────────────────── */

  it('L115B-E2E-07 — un critère refusé rend son code de diagnostic, jamais « aucun résultat » (CA07)', async () => {
    as(admin, 'ADMIN');
    for (const [qs, code] of [
      ['periode=siecle', 'PERIODE_INVALIDE'],
      ['canal=sms', 'CANAL_INVALIDE'],
      ['famille=divers', 'FAMILLE_INVALIDE'],
      ['nature=peut-etre', 'NATURE_INVALIDE'],
      ['environnement=recette', 'ENVIRONNEMENT_INVALIDE'],
      ['periode=dates', 'DATES_REQUISES'],
      ['curseur=cassé', 'CURSEUR_INVALIDE'],
      ['utilisateurId=sept', 'UTILISATEUR_INVALIDE'],
    ] as const) {
      const r = await lire(qs);
      expect(r.status, qs).toBe(400);
      expect(r.body.code, qs).toBe(code);
      expect(typeof r.body.error).toBe('string');
      // Surtout : pas de liste vide qui ressemblerait à « aucun échec ».
      expect(r.body.lignes, qs).toBeUndefined();
      expect(r.body.total, qs).toBeUndefined();
    }
    // Même règle sur l'export et sur un identifiant d'événement invalide.
    expect((await telecharger('canal=sms')).status).toBe(400);
    const mauvais = await dossier(req('/api/admin/notifications/diagnostic/pas-un-uuid'), { params: Promise.resolve({ outboxId: 'pas-un-uuid' }) });
    expect(mauvais.status).toBe(400);
    expect((await mauvais.json() as Json).code).toBe('IDENTIFIANT_INVALIDE');
    const inconnu = randomUUID();
    const absent = await dossier(req(`/api/admin/notifications/diagnostic/${inconnu}`), { params: Promise.resolve({ outboxId: inconnu }) });
    expect(absent.status).toBe(404);
    expect((await absent.json() as Json).code).toBe('INTROUVABLE');
  });

  /* ── L115B-E2E-08 ───────────────────────────────────────────────────── */

  it('L115B-E2E-08 — aucun secret dans l’interface ni dans les deux exports ; audit, droits, environnements, comptes (CA08)', async () => {
    as(admin, 'ADMIN');
    const qs = `periode=30j&compteId=${compte.id}&taille=500`;
    const ecran = JSON.stringify((await lire(qs)).body);
    const copie = (await copier(qs)).texte;
    const fichier = (await telecharger(`periode=30j&compteId=${compte.id}`)).texte;

    for (const [nom, sortie] of [['écran', ecran], ['copie', copie], ['fichier', fichier]] as const) {
      expect(sortie, nom).not.toContain(SECRET);
      expect(sortie, nom).not.toContain('BEGIN PRIVATE KEY');
      expect(sortie, nom).not.toContain(JETON_FCM);
      expect(sortie, nom).not.toContain('FIREBASE_SERVICE_ACCOUNT_JSON=');
      // Aucune adresse de courriel, dans aucune sortie.
      expect(sortie, nom).not.toContain(admin.email);
      expect(sortie, nom).not.toContain(simple.email);
      expect(sortie, nom).not.toMatch(/@[A-Za-z0-9.-]+\.[a-z]{2,}/);
    }
    // Le jeton d'appareil n'existe que comme booléen.
    const l = ((await lire(qs)).body.lignes as Json[]).find((x) => x.canal === 'push');
    expect(typeof l!.appareilJetonPresent).toBe('boolean');

    // Séparation des environnements : l'appareil « production » reste dehors.
    const local = await lire(`periode=30j&environnement=local&taille=500`);
    for (const x of local.body.lignes as Json[]) expect(x.appareilEnvironnement).toBe('local');
    const prod = await lire('periode=30j&environnement=production&taille=500');
    for (const x of prod.body.lignes as Json[]) expect(x.appareilEnvironnement).toBe('production');

    // Isolation intercomptes : le périmètre d'un compte n'en montre pas un autre.
    const unCompte = await lire(`periode=30j&compteId=${compte.id}&taille=500`);
    for (const x of unCompte.body.lignes as Json[]) expect(x.compteId).toBe(compte.id);
    const exportUnCompte = JSON.parse((await telecharger(`periode=30j&compteId=${compte.id}`)).texte) as Json;
    for (const x of exportUnCompte.livraisons as Json[]) expect(x.compteId).toBe(compte.id);

    // Droits : un utilisateur simple ne lit rien, une session expirée non plus.
    as(simple, 'USER');
    expect((await lire(`periode=30j&compteId=${compte.id}`)).status).toBe(403);
    expect((await telecharger(`periode=30j&compteId=${compte.id}`)).status).toBe(403);
    expect((await dossier(req(`/api/admin/notifications/diagnostic/${recapId}`), { params: Promise.resolve({ outboxId: recapId }) })).status).toBe(403);
    session.expired = true;
    expect((await lire(`periode=30j`)).status).toBe(401);
    as(admin, 'ADMIN');

    // Journal d'audit : consultations ET exports, avec périmètre et volume.
    const lignesAudit = await sql<Array<{ action_type: string; result: string; details: string | null; admin_email: string }>>`
      SELECT action_type, result, details, admin_email FROM admin_audit_log
       WHERE action_type IN ('NOTIFICATION_DIAGNOSTIC_READ', 'NOTIFICATION_DIAGNOSTIC_EXPORT')
       ORDER BY id`;
    expect(lignesAudit.some((a) => a.action_type === 'NOTIFICATION_DIAGNOSTIC_READ' && a.result === 'SUCCESS')).toBe(true);
    expect(lignesAudit.some((a) => a.action_type === 'NOTIFICATION_DIAGNOSTIC_EXPORT' && a.result === 'SUCCESS')).toBe(true);
    expect(lignesAudit.some((a) => a.result === 'FAILURE')).toBe(true);
    const unExport = lignesAudit.find((a) => a.action_type === 'NOTIFICATION_DIAGNOSTIC_EXPORT' && a.result === 'SUCCESS')!;
    expect(unExport.details ?? '').toContain('attendu');
    expect(unExport.details ?? '').toContain('perimetre');
    // Le journal lui-même ne porte aucun secret.
    for (const a of lignesAudit) expect(a.details ?? '').not.toContain(JETON_FCM);
  });

  /* ── L115B-E2E-09 ───────────────────────────────────────────────────── */

  it('L115B-E2E-09 — consulter ou exporter n’envoie rien et ne réémet rien (CA09)', async () => {
    as(admin, 'ADMIN');
    const avantMessages = envoi.messages.length;
    const [{ n: avantLivraisons }] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM notification_deliveries`;
    const [{ n: avantFile }] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM notification_outbox`;

    await lire(`periode=30j&compteId=${compte.id}&taille=500`);
    await copier(`periode=30j&compteId=${compte.id}`);
    await telecharger(`periode=30j&compteId=${compte.id}`);
    await dossier(req(`/api/admin/notifications/diagnostic/${recapId}`), { params: Promise.resolve({ outboxId: recapId }) });

    expect(envoi.messages.length, 'aucun appel au fournisseur push').toBe(avantMessages);
    const [{ n: apresLivraisons }] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM notification_deliveries`;
    const [{ n: apresFile }] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM notification_outbox`;
    expect(apresLivraisons).toBe(avantLivraisons);
    expect(apresFile).toBe(avantFile);
  });
});
