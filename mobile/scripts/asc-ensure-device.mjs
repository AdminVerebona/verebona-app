/**
 * Signature iOS en CI — appareil technique (lot 101-septies, 31/10/2026).
 *
 *   node scripts/asc-ensure-device.mjs
 *   (env : ASC_KEY_PATH, ASC_API_KEY_ID, ASC_API_ISSUER_ID, APPLE_TEAM_ID)
 *
 * Avec la signature automatique, `xcodebuild archive` crée d'abord un profil de
 * DÉVELOPPEMENT, qu'Apple refuse de générer tant que l'équipe n'a aucun appareil
 * enregistré (« Your team has no devices from which to generate a provisioning
 * profile »). L'envoi à TestFlight re-signe ensuite pour la distribution, sans
 * dépendre de cet appareil.
 *
 * Ce script interroge l'API App Store Connect : si au moins un appareil iOS actif
 * existe, il ne fait rien ; sinon il enregistre UN appareil technique au nom
 * explicite (identifiant stable dérivé de l'équipe, donc jamais créé deux fois).
 * Les vrais iPhone de test peuvent être ajoutés ensuite sans rien changer ici.
 * Aucun secret n'est affiché.
 */
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const API = 'https://api.appstoreconnect.apple.com/v1';
export const TECH_DEVICE_NAME = 'CI Verebona appareil technique (ne pas supprimer)';

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

/** Jeton ES256 de l'API App Store Connect (20 min au plus, exigence Apple). */
export function ascJwt({ keyPem, keyId, issuerId, now = Math.floor(Date.now() / 1000) }) {
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iss: issuerId, iat: now, exp: now + 600, aud: 'appstoreconnect-v1' }));
  const data = `${header}.${payload}`;
  const signature = sign('sha256', Buffer.from(data), { key: createPrivateKey(keyPem), dsaEncoding: 'ieee-p1363' });
  return `${data}.${b64url(signature)}`;
}

/** UDID technique au format des iPhone récents (8 hex - 16 hex), stable pour une équipe. */
export function techUdid(teamId) {
  const h = createHash('sha256').update(`verebona-ci-device:${teamId}`).digest('hex').toUpperCase();
  return `00008030-${h.slice(0, 16)}`;
}

async function call(token, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

function explainError(status, json) {
  const detail = json?.errors?.[0]?.detail ?? json?.errors?.[0]?.title ?? '';
  if (status === 401) return `clé d'API refusée (401) : vérifier ASC_API_KEY_ID, ASC_API_ISSUER_ID et le fichier .p8. ${detail}`;
  if (status === 403) return `droits insuffisants (403) : la clé d'API doit avoir le rôle Admin (App Store Connect › Utilisateurs et accès › Intégrations) pour gérer appareils, certificats et profils. ${detail}`;
  return `réponse ${status} de l'API App Store Connect. ${detail}`;
}

export async function ensureDevice(env, { log = console.log } = {}) {
  const keyPem = readFileSync(env.ASC_KEY_PATH, 'utf8');
  const token = ascJwt({ keyPem, keyId: env.ASC_API_KEY_ID, issuerId: env.ASC_API_ISSUER_ID });
  const list = await call(token, 'GET', '/devices?filter[platform]=IOS&filter[status]=ENABLED&limit=1');
  if (list.status !== 200) throw new Error(explainError(list.status, list.json));
  if ((list.json.data ?? []).length > 0) {
    log('Au moins un appareil iOS est enregistré : rien à faire.');
    return 'present';
  }
  const created = await call(token, 'POST', '/devices', {
    data: { type: 'devices', attributes: { name: TECH_DEVICE_NAME, platform: 'IOS', udid: techUdid(env.APPLE_TEAM_ID) } },
  });
  if (created.status === 409) { log('Appareil technique déjà enregistré.'); return 'present'; }
  if (created.status !== 201) throw new Error(explainError(created.status, created.json));
  log(`Appareil technique enregistré (« ${TECH_DEVICE_NAME} ») : la signature automatique peut générer son profil.`);
  return 'created';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ensureDevice(process.env).catch((e) => {
    console.log(`::error::Appareil iOS pour la signature : ${e.message}`);
    process.exit(1);
  });
}
