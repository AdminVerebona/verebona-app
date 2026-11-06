/**
 * Signature iOS en CI — certificats de développement créés par la CI (lot 112, correctif 3, 06/11/2026).
 *
 *   node scripts/asc-cleanup-dev-certs.mjs
 *   (env : ASC_KEY_PATH, ASC_API_KEY_ID, ASC_API_ISSUER_ID)
 *
 * Constat du 06/11 : « Choose a certificate to revoke. Your account has reached the
 * maximum number of certificates » puis « No profiles for 'fr.verebona.app.preprod'
 * were found ». Chaque exécution part d'un runner macOS NEUF, sans trousseau : la
 * signature automatique (clé d'API) y crée un NOUVEAU certificat « Apple Development »
 * pour signer l'archive (re-signée ensuite pour la distribution TestFlight). Les
 * certificats des exécutions précédentes restent chez Apple jusqu'à la limite du
 * compte ; à la limite, Xcode ne peut plus en créer et l'archivage échoue.
 *
 * Ce script révoque, AVANT l'archivage, les seuls certificats de DÉVELOPPEMENT créés
 * par l'API (nom « Created via API », ceux que fabrique la CI). Il ne touche jamais :
 *   · aux certificats de distribution (TestFlight, App Store) ;
 *   · aux certificats de développement créés depuis un Mac (Xcode d'un développeur) ;
 * Un certificat de développement révoqué n'a aucun effet sur les builds déjà envoyés
 * à TestFlight ni sur l'app installée chez les testeurs (signée pour la distribution).
 * Aucun secret affiché.
 */
import { readFileSync } from 'node:fs';
import { ascJwt } from './asc-ensure-device.mjs';

const API = 'https://api.appstoreconnect.apple.com/v1';
const DEV_TYPES = new Set(['DEVELOPMENT', 'IOS_DEVELOPMENT']);

/** Un certificat est « de la CI » : développement ET nommé par l'API. */
export function isCiDevCertificate(c) {
  const a = c?.attributes ?? {};
  const name = `${a.name ?? ''} ${a.displayName ?? ''}`;
  return DEV_TYPES.has(a.certificateType) && /Created via API/i.test(name);
}

async function call(token, method, path) {
  const res = await fetch(`${API}${path}`, { method, headers: { authorization: `Bearer ${token}` } });
  const json = res.status === 204 ? {} : await res.json().catch(() => ({}));
  return { status: res.status, json };
}

function apiError(what, r) {
  const detail = r.json?.errors?.[0]?.detail ?? r.json?.errors?.[0]?.title ?? '';
  if (r.status === 401) return `${what} : clé d'API refusée (401). ${detail}`;
  if (r.status === 403) return `${what} : droits insuffisants (403) — la clé d'API doit avoir le rôle Admin pour révoquer des certificats. ${detail}`;
  return `${what} : réponse ${r.status} de l'API App Store Connect. ${detail}`;
}

export async function cleanup(env, { log = console.log } = {}) {
  const token = ascJwt({ keyPem: readFileSync(env.ASC_KEY_PATH, 'utf8'), keyId: env.ASC_API_KEY_ID, issuerId: env.ASC_API_ISSUER_ID });
  const list = await call(token, 'GET', '/certificates?limit=200');
  if (list.status !== 200) throw new Error(apiError('Certificats', list));
  const all = list.json.data ?? [];
  const dev = all.filter((c) => DEV_TYPES.has(c.attributes?.certificateType));
  const ci = dev.filter(isCiDevCertificate);
  log(`Certificats de développement : ${dev.length} (dont ${ci.length} créés par la CI, « Created via API »).`);
  let revoked = 0;
  for (const c of ci) {
    const r = await call(token, 'DELETE', `/certificates/${c.id}`);
    if (r.status === 204 || r.status === 404) { revoked += 1; continue; }
    throw new Error(apiError('Révocation d\'un certificat de la CI', r));
  }
  if (revoked) log(`${revoked} certificat(s) de développement de la CI révoqué(s) : Xcode en recrée un pour cette exécution.`);
  const left = dev.length - revoked;
  if (left > 0) log(`${left} certificat(s) de développement créé(s) depuis un Mac conservé(s).`);
  if (!revoked && dev.length) log('::warning::Signature iOS : aucun certificat de développement de la CI à révoquer. Si l\'archivage échoue avec « maximum number of certificates », révoquer à la main, dans Certificates, Identifiers & Profiles › Certificates, les certificats de développement qui ne servent plus.');
  // Anticipation (lot 112, correctif 4) : l'envoi à TestFlight peut, lui aussi, créer un certificat
  // de DISTRIBUTION par exécution si Xcode n'utilise pas la signature gérée par Apple. Ceux-là ne sont
  // jamais révoqués automatiquement (envoi App Store) : on prévient avant la limite.
  const dist = all.filter((c) => /DISTRIBUTION/.test(c.attributes?.certificateType ?? ''));
  log(`Certificats de distribution : ${dist.length}.`);
  if (dist.length >= 2) log(`::warning::Signature iOS : ${dist.length} certificats de distribution sur le compte. Apple en limite le nombre : à la limite, l'envoi à TestFlight échouera (« maximum number of certificates »). Révoquer alors, dans Certificates, les certificats de distribution « Created via API » inutilisés — sans effet sur les builds déjà envoyés ni sur l'app publiée.`);
  return { dev: dev.length, revoked, dist: dist.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cleanup(process.env).catch((e) => {
    console.log(`::error::Signature iOS : ${e.message}`);
    process.exit(1);
  });
}
