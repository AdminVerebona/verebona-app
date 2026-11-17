/**
 * Lot 114 (carte #776, travail 10) — vue d'ensemble « Schémas structurés » du
 * BO (Exécutions IA) : usage réel (traces), matrice mémorisée par couple,
 * projection courante (contrôle statique), politique de réexamen, alertes de
 * compatibilité ouvertes. Aucun contenu : compteurs, codes, versions,
 * empreintes.
 */
import { SCHEMA_COMPAT_POLICY, SCHEMA_COMPAT_STATE_LABELS, type SchemaCompatState } from './policy';
import { getSchemaUsageReport, type SchemaUsageFilters, type SchemaUsageReport } from './supervision';
import { staticSchemaMatrix, isCurrentCouple, coupleRoutingStatus, type CoupleRoutingStatus, type StaticSchemaRow } from './static-matrix';

/** Libellés du statut de routage (BO) — à valider par le PO. */
export const ROUTING_STATUS_LABELS: Readonly<Record<CoupleRoutingStatus, string>> = {
  ACTIVE: 'modèle routé pour ce type d’appel',
  WITHDRAWN: 'modèle retiré du routage et du référentiel (ce refus ne concerne plus les appels actuels)',
  UNKNOWN: 'routage non établi (configuration illisible, ou modèle hors chaîne mais toujours déclaré) : rien n’est conclu',
};

export interface SchemaCompatCoupleView {
  keyId: string;
  provider: string; model: string; operationCode: string; contractId: string; contractVersion: number;
  schemaHash: string; providerSchemaHash: string | null; adapterVersion: string;
  /**
   * Lot 115 (carte #784, §A3) — empreinte du profil de génération effectif,
   * composante de l'identité du couple (`'-'` : aucun paramètre matériel, donc
   * identité inchangée depuis avant ce lot).
   */
  generationProfileHash: string;
  /** Dernière version de modèle réellement SERVIE observée ; `null` : jamais observée. */
  servedModelVersion: string | null;
  /** Le fournisseur n'a pas indiqué la version servie : incertitude MARQUÉE, rien n'est inventé. */
  versionUncertain: boolean;
  state: SchemaCompatState; stateLabel: string; reason: string | null;
  /** Le couple est celui que la passerelle transmet aujourd'hui ; sinon : état historique. */
  current: boolean;
  /**
   * Lot 115 (carte #784, §E1) — STATUT DE ROUTAGE du couple, calculé pour les
   * alertes et désormais AFFICHÉ : `ACTIVE` le modèle est dans la chaîne
   * réellement configurée de ce type d'appel ; `WITHDRAWN` il n'y est plus et
   * n'est plus au référentiel (preuve de retrait) ; `UNKNOWN` on ne sait pas
   * (configuration illisible, ou hors chaîne mais toujours déclaré) — et alors
   * rien n'est conclu, ni ici ni sur les alertes.
   */
  routingStatus: CoupleRoutingStatus;
  routingLabel: string;
  acceptedCount: number; rejectionCount: number; consecutiveRejections: number; retestCount: number;
  firstRejectedAt: string | null; lastRejectedAt: string | null; lastAcceptedAt: string | null;
  nextRetestAt: string | null; retestInProgress: boolean;
  lastHttpStatus: number | null; lastProviderCode: string | null; policyVersion: number; appVersion: string | null; updatedAt: string | null;
}

export interface SchemaCompatOverview {
  usage: SchemaUsageReport;
  /** Matrice mémorisée ; `null` : migration 1710 absente. */
  couples: SchemaCompatCoupleView[] | null;
  staticMatrix: StaticSchemaRow[];
  policy: typeof SCHEMA_COMPAT_POLICY;
  /** Alertes de compatibilité non résolues ; `null` : illisible. */
  openAlerts: number | null;
  /** Commit de l'application qui répond (à rapprocher de celui des appels). */
  appVersion: string | null;
}

const iso = (t: number | null): string | null => (t === null ? null : new Date(t).toISOString());

export async function getSchemaCompatOverview(f: SchemaUsageFilters, now: Date = new Date()): Promise<SchemaCompatOverview> {
  const [S, { getAppVersion }] = await Promise.all([import('./store'), import('../../telemetry/execution-context')]);
  const usage = await getSchemaUsageReport(f, now);
  const rows = await S.listCouples({ operationCode: f.operationCode ?? null, model: f.model ?? null }).catch(() => null);
  let openAlerts: number | null = null;
  try {
    const [{ listUnresolvedAlerts }, { SCHEMA_COMPAT_ALERT_CODE }] = await Promise.all([import('../../alerts/alerts.repository'), import('./alerts')]);
    openAlerts = (await listUnresolvedAlerts([SCHEMA_COMPAT_ALERT_CODE])).length;
  } catch { openAlerts = null; }
  // Lot 115 (carte #784, §E1) : statut de routage par (type d'appel, modèle), calculé UNE fois par couple
  // distinct — la même lecture que celle des alertes, sans la refaire par ligne affichée.
  const routage = new Map<string, CoupleRoutingStatus>();
  for (const r of rows ?? []) {
    const cle = `${r.key.operationCode}\u0000${r.key.model}`;
    if (!routage.has(cle)) routage.set(cle, await coupleRoutingStatus({ operationCode: r.key.operationCode, model: r.key.model }));
  }
  const t = now.getTime();
  return {
    usage,
    couples: rows === null ? null : rows.map((r) => ({
      keyId: r.keyId, ...r.key, generationProfileHash: r.key.generationProfileHash ?? '-',
      servedModelVersion: r.servedModelVersion ?? null, versionUncertain: r.versionUncertain === true,
      state: r.state, stateLabel: SCHEMA_COMPAT_STATE_LABELS[r.state], reason: r.reason,
      current: isCurrentCouple(r.key),
      routingStatus: routage.get(`${r.key.operationCode}\u0000${r.key.model}`) ?? 'UNKNOWN',
      routingLabel: ROUTING_STATUS_LABELS[routage.get(`${r.key.operationCode}\u0000${r.key.model}`) ?? 'UNKNOWN'],
      acceptedCount: r.acceptedCount, rejectionCount: r.rejectionCount,
      consecutiveRejections: r.consecutiveRejections, retestCount: r.retestCount, firstRejectedAt: iso(r.firstRejectedAt),
      lastRejectedAt: iso(r.lastRejectedAt), lastAcceptedAt: iso(r.lastAcceptedAt), nextRetestAt: iso(r.nextRetestAt),
      retestInProgress: r.retestClaimedUntil !== null && r.retestClaimedUntil > t, lastHttpStatus: r.lastHttpStatus,
      lastProviderCode: r.lastProviderCode, policyVersion: r.policyVersion, appVersion: r.appVersion, updatedAt: iso(r.updatedAt),
    })),
    staticMatrix: staticSchemaMatrix(),
    policy: SCHEMA_COMPAT_POLICY,
    openAlerts,
    appVersion: getAppVersion(),
  };
}
