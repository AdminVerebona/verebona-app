/**
 * BO › Exploitation › Application mobile — lot 97 (CDC 12 §25 API-07/08,
 * §30, §31 OBS-04/05/07, §19, §27).
 *
 * LECTURE SEULE : configuration effective (versions minimales, liens stores,
 * interrupteurs), état des fichiers d'association et du fournisseur push
 * (configuré ou non, JAMAIS une valeur secrète), appareils enregistrés par
 * plateforme / statut / version (versions actives), livraisons push mobiles
 * des 7 derniers jours (envoyées, en échec, jetons invalides, ignorées par
 * motif). Tout réglage se fait par variable Scalingo (doc
 * `docs/exploitation/application-mobile-serveur.md`).
 */
import { pgClient } from '@/db';
import { appLinksStatus, APP_LINK_EXCLUSIONS, APP_LINK_ROUTES } from '@/lib/mobile/app-links';
import { MOBILE_FEATURES, readMobileServerConfig, type MobileFeature } from '@/lib/mobile/mobile-config';
import { fcmConfigStatus } from '@/lib/mobile/push-provider';
import { serverPushEnvironment, mobilePushStaleDays } from '@/lib/mobile/push-installations';

export interface MobileOpsReport {
  environment: string;
  config: {
    minVersions: Record<'ios' | 'android', string | null>;
    storeUrls: Record<'ios' | 'android', string | null>;
    features: Array<{ key: MobileFeature; label: string; ios: boolean; android: boolean; serverEnforced: boolean }>;
    issues: string[];
  };
  push: {
    providerConfigured: boolean;
    providerIssue: string | null;
    /**
     * Lot 94 (décision PO M3) : Web Push SUPPRIMÉ (aucun envoi, aucune
     * permission, aucun abonnement). Traces de l'ancien dispositif, en
     * lecture seule, pour constater qu'il n'a jamais servi (ou plus) :
     * lignes de la table dormante `push_subscriptions` et envois réussis
     * historiques vers un navigateur (`notification_deliveries`).
     */
    webPushLegacy: { available: boolean; subscriptions: number; stillActive: number; sentEver: number; lastSentAt: string | null };
    staleDays: number;
  };
  appLinks: ReturnType<typeof appLinksStatus> & { routes: typeof APP_LINK_ROUTES; exclusions: readonly string[] };
  installations: {
    available: boolean;
    byPlatformStatus: Array<{ platform: string; status: string; n: number }>;
    activeVersions: Array<{ platform: string; appVersion: string | null; n: number }>;
  };
  deliveries7d: Array<{ status: string; code: string | null; n: number }>;
}

export async function getMobileOpsReport(): Promise<MobileOpsReport> {
  const cfg = readMobileServerConfig();
  const fcm = fcmConfigStatus();
  const env = serverPushEnvironment();
  let available = true;
  let byPlatformStatus: MobileOpsReport['installations']['byPlatformStatus'] = [];
  let activeVersions: MobileOpsReport['installations']['activeVersions'] = [];
  let deliveries7d: MobileOpsReport['deliveries7d'] = [];
  const webPushLegacy: MobileOpsReport['push']['webPushLegacy'] = { available: true, subscriptions: 0, stillActive: 0, sentEver: 0, lastSentAt: null };
  try {
    const [s] = await pgClient<{ n: number; actifs: number }[]>`
      SELECT count(*)::int AS n, count(*) FILTER (WHERE status = 'active')::int AS actifs FROM push_subscriptions`;
    const [d] = await pgClient<{ n: number; dernier: Date | null }[]>`
      SELECT count(*)::int AS n, max(sent_at) AS dernier FROM notification_deliveries
       WHERE channel = 'push' AND status = 'sent' AND push_subscription_id IS NOT NULL`;
    webPushLegacy.subscriptions = s?.n ?? 0;
    webPushLegacy.stillActive = s?.actifs ?? 0;
    webPushLegacy.sentEver = d?.n ?? 0;
    webPushLegacy.lastSentAt = d?.dernier ? new Date(d.dernier).toISOString() : null;
  } catch (e) {
    if ((e as { code?: string }).code !== '42P01' && (e as { code?: string }).code !== '42703') throw e;
    webPushLegacy.available = false;
  }
  try {
    byPlatformStatus = (await pgClient<{ platform: string; status: string; n: number }[]>`
      SELECT platform, status, count(*)::int AS n FROM mobile_push_installations
       WHERE environment = ${env} GROUP BY platform, status ORDER BY platform, status`).map((r) => ({ ...r }));
    activeVersions = (await pgClient<{ platform: string; app_version: string | null; n: number }[]>`
      SELECT platform, app_version, count(*)::int AS n FROM mobile_push_installations
       WHERE environment = ${env} AND status = 'active' GROUP BY platform, app_version
       ORDER BY platform, n DESC LIMIT 30`).map((r) => ({ platform: r.platform, appVersion: r.app_version, n: r.n }));
    deliveries7d = (await pgClient<{ status: string; code: string | null; n: number }[]>`
      SELECT status, last_error_code AS code, count(*)::int AS n FROM notification_deliveries
       WHERE mobile_push_installation_id IS NOT NULL AND created_at > now() - interval '7 days'
       GROUP BY status, last_error_code ORDER BY n DESC LIMIT 30`).map((r) => ({ ...r }));
  } catch (e) {
    if ((e as { code?: string }).code !== '42P01' && (e as { code?: string }).code !== '42703') throw e;
    available = false;
  }
  return {
    environment: env,
    config: {
      minVersions: { ios: cfg.minVersions.ios?.raw ?? null, android: cfg.minVersions.android?.raw ?? null },
      storeUrls: cfg.storeUrls,
      features: (Object.keys(MOBILE_FEATURES) as MobileFeature[]).map((key) => ({
        key, label: MOBILE_FEATURES[key].label, ios: cfg.features.ios[key], android: cfg.features.android[key], serverEnforced: MOBILE_FEATURES[key].server,
      })),
      issues: cfg.issues,
    },
    push: {
      providerConfigured: fcm.configured,
      providerIssue: fcm.issue,
      webPushLegacy,
      staleDays: mobilePushStaleDays(),
    },
    appLinks: { ...appLinksStatus(), routes: APP_LINK_ROUTES, exclusions: APP_LINK_EXCLUSIONS },
    installations: { available, byPlatformStatus, activeVersions },
    deliveries7d,
  };
}
