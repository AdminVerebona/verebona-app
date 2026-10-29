/**
 * Description de l'appareil d'une session — lot 92 (CDC 18 §20.2, §20.4 ;
 * CDC 12 mobile §6 AUTH-13/14, §25 API-02).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUI EST DÉCLARATIF, CE QUI NE L'EST PAS
 *
 * Tout ce module décrit l'appareil POUR L'AFFICHAGE (« Appareils connectés »)
 * et pour reconnaître un appareil déjà vu. Rien ici n'est une base de droits :
 *
 *   · `client_type` (WEB | PWA | IOS | ANDROID) vient de l'en-tête déclaratif
 *     `X-Verebona-Client` (casse indifférente, posé par le client web et par
 *     la coque native) ; absent ou inconnu → WEB ;
 *   · version d'application : `X-Verebona-App-Version` (+ `-App-Build`),
 *     normalisée, sinon ignorée ;
 *   · identifiant d'appareil first-party, opaque, sans fingerprinting :
 *     UNIQUEMENT l'identifiant du cookie signé `vb_device` (lot 53A,
 *     `device-trust.ts`), et seulement s'il est PROUVÉ par le serveur
 *     (`authenticDeviceId` : au moins une entrée signée valable, ou
 *     identifiant qui vient d'être déposé par cette réponse). Navigateur ET
 *     application (la WebView Capacitor reçoit le même cookie HttpOnly) ;
 *     une réinstallation efface le cookie : nouvel appareil (AUTH-13).
 *     Lot 96B (décision PO P5) : l'en-tête DÉCLARATIF
 *     `X-Verebona-Installation-Id` n'alimente PLUS `device_key` — sinon un
 *     client pouvait se faire passer pour un appareil « déjà vu » (alerte
 *     supprimée) ou remplacer la session d'un autre appareil. Il ne sert
 *     qu'au rattachement push (`mobile_push_installations`, lot 97).
 *     Jamais stocké en clair : seule une empreinte HMAC (`device_key`) va en
 *     base (les lignes antérieures `device_source = 'installation'` restent
 *     lisibles, elles ne sont plus produites) ;
 *   · libellés « iPhone », « PC Windows », « Chrome »… dérivés du User-Agent ;
 *     illisible → « Appareil » / « Navigateur web » (CDC §37).
 * Aucune IP, aucune localisation (SESS-09).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHmac } from 'node:crypto';
import { authenticDeviceId } from './device-trust';
import { readClientContext, type ClientType } from '@/lib/mobile/client-context';

/*
 * Intégration 92 + 97 : lecture UNIQUE des en-têtes déclaratifs
 * (`X-Verebona-Client`, `-App-Version`, `-App-Build`, `-Installation-Id`) par
 * `lib/mobile/client-context.ts › readClientContext` (lot 97) — mêmes règles
 * pour le registre des sessions, le contrôle de version mobile et le push.
 */
export type SessionClientType = ClientType;
export const SESSION_CLIENT_TYPES: readonly SessionClientType[] = ['WEB', 'PWA', 'IOS', 'ANDROID'];

interface HeaderReader { get(name: string): string | null }
interface RequestLike {
  headers: HeaderReader;
  cookies?: { get(name: string): { value: string } | undefined };
}

export function resolveClientType(headers: HeaderReader): SessionClientType {
  return readClientContext({ headers }).client;
}

/** Version d'application normalisée (`1.4.0`, build accolé `1.4.0 (52)`), sinon `null`. */
export function readAppVersion(headers: HeaderReader): string | null {
  const c = readClientContext({ headers });
  if (!c.appVersion) return null;
  return c.build ? `${c.appVersion} (${c.build})` : c.appVersion;
}

/** Empreinte HMAC d'un identifiant d'appareil — jamais l'identifiant en clair. */
export function deviceKeyFor(source: 'installation' | 'cookie', id: string): string {
  return createHmac('sha256', `verebona/session-device/v1/${process.env.JWT_SECRET || 'dev'}`)
    .update(`${source}:${id}`)
    .digest('base64url')
    .slice(0, 32);
}

export interface SessionDeviceLabels { deviceLabel: string; browserLabel: string }

/** Libellés lisibles (français simple) — CDC §20.2 ; UA illisible : libellés génériques. */
export function describeSessionDevice(userAgent: string | null | undefined, clientType: SessionClientType): SessionDeviceLabels {
  const ua = userAgent ?? '';
  const ipad = /iPad/.test(ua) || (/Macintosh/.test(ua) && /Mobile\//.test(ua));
  const device =
    /iPhone|iPod/.test(ua) ? 'iPhone'
    : ipad ? 'iPad'
    : /Android/.test(ua) ? (/Mobile/.test(ua) ? 'Téléphone Android' : 'Tablette Android')
    : /CrOS/.test(ua) ? 'Chromebook'
    : /Windows/.test(ua) ? 'PC Windows'
    : /Mac OS X|Macintosh/.test(ua) ? 'Mac'
    : /Linux/.test(ua) ? 'PC Linux'
    : null;

  if (clientType === 'IOS' || clientType === 'ANDROID') {
    return {
      deviceLabel: device ?? (clientType === 'IOS' ? 'iPhone' : 'Téléphone Android'),
      browserLabel: 'Application Verebona',
    };
  }
  const browser =
    /EdgiOS|EdgA|Edg\//.test(ua) ? 'Edge'
    : /OPR\/|Opera/.test(ua) ? 'Opera'
    : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
    : /FxiOS|Firefox\//.test(ua) ? 'Firefox'
    : /CriOS|Chrome\/|Chromium\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : null;
  return { deviceLabel: device ?? 'Appareil', browserLabel: browser ?? 'Navigateur web' };
}

export interface SessionClientInfo extends SessionDeviceLabels {
  clientType: SessionClientType;
  appVersion: string | null;
  /** Empreinte de l'identifiant d'appareil first-party ; `null` si aucun n'est connu. */
  deviceKey: string | null;
  deviceSource: 'installation' | 'cookie' | null;
}

/**
 * Identifiant d'appareil PROUVÉ de la requête : celui que le serveur vient de
 * déposer sur la réponse (`deviceId`, connexion), sinon celui d'un cookie
 * `vb_device` authentique. Le cookie n'est envoyé qu'aux routes `/api/auth/*`.
 */
export function provenDeviceId(request: RequestLike, deviceId?: string | null): string | null {
  return deviceId ?? authenticDeviceId(request.cookies?.get('vb_device')?.value ?? null);
}

/**
 * Description de l'appareil qui fait la requête. `deviceId` : identifiant
 * `vb_device` qui vient d'être déposé (connexion).
 */
export function readSessionClient(request: RequestLike, opts: { deviceId?: string | null } = {}): SessionClientInfo {
  const clientType = resolveClientType(request.headers);
  const cookieId = provenDeviceId(request, opts.deviceId);
  const [deviceSource, deviceKey]: [SessionClientInfo['deviceSource'], string | null] = cookieId
    ? ['cookie', deviceKeyFor('cookie', cookieId)] : [null, null];
  return {
    clientType,
    appVersion: readAppVersion(request.headers),
    deviceKey,
    deviceSource,
    ...describeSessionDevice(request.headers.get('user-agent'), clientType),
  };
}
