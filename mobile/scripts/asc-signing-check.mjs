/**
 * Signature iOS en CI — diagnostic AVANT l'archivage (lot 112, correctif du 06/11/2026).
 *
 *   node scripts/asc-signing-check.mjs
 *   (env : ASC_KEY_PATH, ASC_API_KEY_ID, ASC_API_ISSUER_ID, APPLE_TEAM_ID ; lit ios/Verebona.xcconfig)
 *
 * Constat du 06/11 : `xcodebuild archive` échouait avec « No profiles for
 * 'fr.verebona.app.preprod' were found … App Development provisioning profiles »
 * alors que l'archive passait la veille, sans aucun changement de signature dans le
 * dépôt (entitlements, projet Xcode). La cause est donc côté compte Apple ou runner ;
 * Xcode ne la dit pas. Ce script interroge l'API App Store Connect avec la même clé
 * et écrit, en clair, ce qui empêche la création du profil de développement :
 *   · identifiant d'app (bundle ID) de l'app et de l'extension de partage absents ;
 *   · fonctionnalités (capabilities) des droits signés non activées sur ces identifiants ;
 *   · aucun appareil iOS actif ;
 *   · profils de développement existants invalides ;
 *   · clé sans droit suffisant (403).
 * Il ne crée ni ne modifie rien et n'affiche aucun secret. Les constats bloquants
 * sont des ::error:: (l'étape échoue avant Xcode) ; les autres des ::warning::.
 */
import { readFileSync } from 'node:fs';
import { ascJwt } from './asc-ensure-device.mjs';

const API = 'https://api.appstoreconnect.apple.com/v1';

/** Droits signés de l'app et de l'extension → fonctionnalités App Store Connect attendues. */
export const REQUIRED_CAPABILITIES = {
  app: ['ASSOCIATED_DOMAINS', 'APP_GROUPS', 'PUSH_NOTIFICATIONS'],
  extension: ['APP_GROUPS'],
};

export function readXcconfig(text) {
  const get = (k) => (new RegExp(`^${k} = (.+)$`, 'm').exec(text)?.[1] ?? '').trim();
  return { appId: get('VB_APP_ID'), shareId: get('VB_SHARE_EXTENSION_ID'), appGroup: get('VB_APP_GROUP') };
}

async function call(token, path) {
  const res = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}` } });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

function apiError(what, r) {
  const detail = r.json?.errors?.[0]?.detail ?? r.json?.errors?.[0]?.title ?? '';
  if (r.status === 401) return `${what} : clé d'API refusée (401) — ASC_API_KEY_ID, ASC_API_ISSUER_ID ou le fichier .p8 ne correspondent plus (clé révoquée ?). ${detail}`;
  if (r.status === 403) return `${what} : droits insuffisants (403) — la clé d'API doit avoir le rôle Admin (App Store Connect › Utilisateurs et accès › Intégrations) pour que Xcode crée certificats et profils. ${detail}`;
  return `${what} : réponse ${r.status} de l'API App Store Connect. ${detail}`;
}

/**
 * Analyse pure (testable) des réponses de l'API : renvoie les constats.
 * @param {{ ids: {appId: string, shareId: string}, bundles: Record<string, {id: string, capabilities: string[]}|null>,
 *           devices: number, profiles: Array<{name: string, state: string, bundle: string}> }} f
 */
export function analyse(f) {
  const errors = [];
  const warnings = [];
  const infos = [];
  for (const [role, identifier] of [['app', f.ids.appId], ['extension', f.ids.shareId]]) {
    const b = f.bundles[identifier];
    if (!b) {
      errors.push(`Identifiant d'app « ${identifier} » (${role === 'app' ? 'application' : 'extension de partage'}) introuvable dans Certificates, Identifiers & Profiles › Identifiers : Xcode ne peut créer aucun profil pour lui. Le créer (ou vérifier l'équipe APPLE_TEAM_ID).`);
      continue;
    }
    const missing = REQUIRED_CAPABILITIES[role].filter((c) => !b.capabilities.includes(c));
    if (missing.length) warnings.push(`« ${identifier} » : fonctionnalités non activées dans Identifiers : ${missing.join(', ')} (exigées par les droits signés). Xcode les active d'habitude seul ; s'il échoue, les cocher à la main.`);
    else infos.push(`« ${identifier} » : identifiant présent, fonctionnalités ${REQUIRED_CAPABILITIES[role].join(', ')} activées.`);
  }
  if (f.devices === 0) errors.push('Aucun appareil iOS actif dans Devices : Apple refuse tout profil de développement (l\'étape « Appareil iOS pour la signature automatique » aurait dû en créer un).');
  else infos.push(`${f.devices} appareil(s) iOS actif(s).`);
  const mine = f.profiles.filter((p) => p.bundle === f.ids.appId || p.bundle === f.ids.shareId);
  const invalid = mine.filter((p) => p.state !== 'ACTIVE');
  if (invalid.length) warnings.push(`Profils de développement non actifs (${invalid.map((p) => `« ${p.name} » : ${p.state}`).join(' ; ')}) : les supprimer dans Profiles pour que Xcode les recrée.`);
  infos.push(`Profils de développement trouvés pour l'app et l'extension : ${mine.length} (dont ${mine.length - invalid.length} actif(s)).`);
  return { errors, warnings, infos };
}

export async function check(env, xcconfigText, { log = console.log } = {}) {
  const ids = readXcconfig(xcconfigText);
  const token = ascJwt({ keyPem: readFileSync(env.ASC_KEY_PATH, 'utf8'), keyId: env.ASC_API_KEY_ID, issuerId: env.ASC_API_ISSUER_ID });
  const bundles = {};
  for (const identifier of [ids.appId, ids.shareId]) {
    const r = await call(token, `/bundleIds?filter[identifier]=${encodeURIComponent(identifier)}&limit=5`);
    if (r.status !== 200) throw new Error(apiError('Identifiants d\'app', r));
    const b = (r.json.data ?? []).find((x) => x.attributes?.identifier === identifier);
    if (!b) { bundles[identifier] = null; continue; }
    const caps = await call(token, `/bundleIds/${b.id}/bundleIdCapabilities?limit=50`);
    if (caps.status !== 200) throw new Error(apiError('Fonctionnalités', caps));
    bundles[identifier] = { id: b.id, capabilities: (caps.json.data ?? []).map((c) => c.attributes?.capabilityType).filter(Boolean) };
  }
  const dev = await call(token, '/devices?filter[platform]=IOS&filter[status]=ENABLED&limit=200');
  if (dev.status !== 200) throw new Error(apiError('Appareils', dev));
  const prof = await call(token, '/profiles?filter[profileType]=IOS_APP_DEVELOPMENT&include=bundleId&limit=200');
  if (prof.status !== 200) throw new Error(apiError('Profils', prof));
  const bundleOf = new Map((prof.json.included ?? []).filter((x) => x.type === 'bundleIds').map((x) => [x.id, x.attributes?.identifier]));
  const profiles = (prof.json.data ?? []).map((p) => ({
    name: p.attributes?.name ?? '?', state: p.attributes?.profileState ?? '?', bundle: bundleOf.get(p.relationships?.bundleId?.data?.id) ?? '',
  }));
  const r = analyse({ ids, bundles, devices: (dev.json.data ?? []).length, profiles });
  for (const i of r.infos) log(i);
  for (const w of r.warnings) log(`::warning::Signature iOS : ${w}`);
  for (const e of r.errors) log(`::error::Signature iOS : ${e}`);
  return r;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const text = readFileSync(new URL('../ios/Verebona.xcconfig', import.meta.url), 'utf8');
  check(process.env, text)
    .then((r) => { if (r.errors.length) process.exit(1); })
    .catch((e) => { console.log(`::error::Signature iOS : ${e.message}`); process.exit(1); });
}
