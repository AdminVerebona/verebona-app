/**
 * Contexte client d'une requête — lot 97 (CDC 12 « Application mobile » §25
 * API-02, §30 VER-01).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LECTURE ET VALIDATION DES EN-TÊTES — JAMAIS UNE BASE DE DROITS
 *
 *   X-Verebona-Client           WEB | PWA | IOS | ANDROID (casse indifférente)
 *   X-Verebona-App-Version      version marketing `1.4.0`, build optionnel
 *                               accolé : `1.4.0+52` ou `1.4.0 (52)`
 *   X-Verebona-App-Build        numéro de build (facultatif, prioritaire sur
 *                               celui accolé à la version)
 *   X-Verebona-Installation-Id  identifiant applicatif de l'installation
 *                               (UUID ou jeton opaque 16-64 [A-Za-z0-9_-])
 *
 * Ces en-têtes sont DÉCLARATIFS : n'importe quel client peut les poser. Ils
 * servent à l'observabilité (version, plateforme), au refus contrôlé d'une
 * version d'application trop ancienne (`compat.ts`) et au rattachement d'un
 * appareil. Ils ne donnent AUCUN droit : l'identité vient de la session, les
 * droits du serveur.
 *
 * Valeur absente ou invalide : champ `null` (jamais une valeur devinée) ;
 * `client` absent ou inconnu → `WEB`. Module PUR, utilisable en Edge
 * (middleware) comme en Node. LECTEUR UNIQUE (intégration 92 + 97) : le
 * registre des sessions (`lib/auth/session-client.ts`) l'utilise aussi.
 * ══════════════════════════════════════════════════════════════════════════
 */

export type ClientType = 'WEB' | 'PWA' | 'IOS' | 'ANDROID';
export type MobilePlatform = 'ios' | 'android';

export const CLIENT_HEADERS = {
  client: 'x-verebona-client',
  appVersion: 'x-verebona-app-version',
  appBuild: 'x-verebona-app-build',
  installationId: 'x-verebona-installation-id',
} as const;

export interface ClientContext {
  client: ClientType;
  /** `client` lu tel quel était valide (sinon `WEB` par défaut). */
  declared: boolean;
  /** Version marketing normalisée (`1.4.0`), ou null. */
  appVersion: string | null;
  /** Numéro de build (chiffres), ou null. */
  build: string | null;
  installationId: string | null;
  /** Anomalies de forme relevées (observabilité ; jamais bloquant ici). */
  issues: string[];
}

interface HeaderSource {
  headers: { get(name: string): string | null };
}

const CLIENTS: readonly ClientType[] = ['WEB', 'PWA', 'IOS', 'ANDROID'];
const VERSION = /^(\d{1,4})(?:\.(\d{1,4}))?(?:\.(\d{1,4}))?(?:\s*(?:\+|\()\s*(\d{1,9})\s*\)?)?$/;
const BUILD = /^\d{1,9}$/;
const INSTALLATION = /^[A-Za-z0-9_-]{16,64}$/;

/** Plateforme mobile native d'un type de client, ou null (Web, PWA). */
export function mobilePlatformOf(client: ClientType): MobilePlatform | null {
  return client === 'IOS' ? 'ios' : client === 'ANDROID' ? 'android' : null;
}

/** `1.4` → `1.4.0` ; null si hors format. Le build accolé est rendu à part. */
export function parseAppVersion(raw: string | null | undefined): { version: string; build: string | null } | null {
  if (typeof raw !== 'string') return null;
  const m = VERSION.exec(raw.trim());
  if (!m) return null;
  const parts = [m[1], m[2] ?? '0', m[3] ?? '0'].map((p) => String(Number(p)));
  return { version: parts.join('.'), build: m[4] ? String(Number(m[4])) : null };
}

/** Identifiant d'installation valide, ou null. */
export function parseInstallationId(raw: unknown): string | null {
  return typeof raw === 'string' && INSTALLATION.test(raw.trim()) ? raw.trim() : null;
}

/** Lit et valide les en-têtes du client (pur). */
export function readClientContext(request: HeaderSource): ClientContext {
  const issues: string[] = [];
  const rawClient = request.headers.get(CLIENT_HEADERS.client)?.trim().toUpperCase() ?? '';
  const declared = (CLIENTS as readonly string[]).includes(rawClient);
  if (rawClient && !declared) issues.push('client_invalide');
  const client: ClientType = declared ? (rawClient as ClientType) : 'WEB';

  const rawVersion = request.headers.get(CLIENT_HEADERS.appVersion);
  const parsed = parseAppVersion(rawVersion);
  if (rawVersion && !parsed) issues.push('version_invalide');

  const rawBuild = request.headers.get(CLIENT_HEADERS.appBuild)?.trim() ?? '';
  let build = parsed?.build ?? null;
  if (rawBuild) {
    if (BUILD.test(rawBuild)) build = String(Number(rawBuild));
    else issues.push('build_invalide');
  }

  const rawInstallation = request.headers.get(CLIENT_HEADERS.installationId);
  const installationId = parseInstallationId(rawInstallation);
  if (rawInstallation && !installationId) issues.push('installation_invalide');

  return { client, declared, appVersion: parsed?.version ?? null, build, installationId, issues };
}

/**
 * Compare deux versions `a.b.c` (numériquement, champ par champ).
 * Négatif si a < b, 0 si égales, positif si a > b.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => Number(x) || 0);
  const pb = b.split('.').map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
