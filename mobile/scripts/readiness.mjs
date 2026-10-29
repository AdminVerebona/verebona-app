/**
 * Configuration de build mobile posée ? — correctif CI du 29/10/2026.
 *
 *   node scripts/readiness.mjs android|ios [--strict] [--publish]
 *
 * Lancé par les workflows mobile-android.yml / mobile-ios.yml AVANT la
 * compilation, dans l'environnement GitHub visé (mobile-preprod ou
 * production-mobile). Il vérifie que les variables et secrets nécessaires
 * existent (présence seulement : AUCUNE valeur n'est affichée) et que la
 * configuration se résout (origine https, version 1.2.3, isolation préprod/prod).
 *
 *   · sans --strict (push sur main) : si quelque chose manque, le build est
 *     simplement SAUTÉ (ready=false) avec la liste des éléments manquants dans
 *     le résumé du workflow — les contrôles du projet mobile restent bloquants ;
 *   · avec --strict (lancement manuel) : échec explicite, car un build a été
 *     demandé alors que la configuration n'est pas posée.
 */
import { appendFileSync } from 'node:fs';
import { resolveBuildConfig } from '../config/environments.mjs';

/** Éléments requis par plateforme : [nom, type, seulement si publication]. */
export const REQUIRED = Object.freeze({
  android: [
    ['VEREBONA_APP_ORIGIN', 'variable'],
    ['GOOGLE_SERVICES_JSON_BASE64', 'secret'],
    ['ANDROID_UPLOAD_KEYSTORE_BASE64', 'secret'],
    ['ANDROID_UPLOAD_KEYSTORE_PASSWORD', 'secret'],
    ['ANDROID_UPLOAD_KEY_ALIAS', 'secret'],
    ['ANDROID_UPLOAD_KEY_PASSWORD', 'secret'],
    ['PLAY_SERVICE_ACCOUNT_JSON', 'secret', true],
  ],
  ios: [
    ['VEREBONA_APP_ORIGIN', 'variable'],
    ['APPLE_TEAM_ID', 'variable'],
    ['GOOGLE_SERVICE_INFO_PLIST_BASE64', 'secret'],
    ['ASC_API_KEY_P8_BASE64', 'secret'],
    ['ASC_API_KEY_ID', 'secret'],
    ['ASC_API_ISSUER_ID', 'secret'],
  ],
});

/**
 * @param {'android' | 'ios'} platform
 * @param {Record<string, string | undefined>} env
 * @param {{ publish?: boolean }} [opts]
 * @returns {{ ready: boolean, problems: string[] }}
 */
export function checkReadiness(platform, env, opts = {}) {
  const required = REQUIRED[platform];
  if (!required) return { ready: false, problems: [`Plateforme inconnue : ${platform}`] };
  const problems = [];
  for (const [name, kind, onlyIfPublish] of required) {
    if (onlyIfPublish && !opts.publish) continue;
    if (!(env[name] ?? '').trim()) problems.push(kind === 'secret' ? `Secret ${name} absent de l'environnement GitHub.` : `Variable ${name} absente de l'environnement GitHub.`);
  }
  if ((env.VEREBONA_APP_ORIGIN ?? '').trim()) {
    try {
      resolveBuildConfig(env);
    } catch (e) {
      problems.push(...String(e.message).split('\n- ').slice(1));
    }
  }
  return { ready: problems.length === 0, problems };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [platform] = process.argv.slice(2);
  const strict = process.argv.includes('--strict');
  const publish = process.argv.includes('--publish');
  const { ready, problems } = checkReadiness(/** @type {any} */ (platform), process.env, { publish });
  const target = `${platform} — ${process.env.VEREBONA_ENV ?? '?'}`;

  const summary = ready
    ? `### Mobile ${target} : configuration complète, build lancé.\n`
    : `### Mobile ${target} : build ${strict ? 'refusé' : 'sauté'} — configuration non posée\n\n`
      + problems.map((p) => `- ${p}`).join('\n')
      + `\n\nÀ poser dans GitHub › Settings › Environments (voir docs/mobile/builds-et-secrets.md). `
      + (strict ? '' : 'Les contrôles du projet mobile ont bien été exécutés.\n');
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `ready=${ready}\n`);
  console.log(summary);

  if (!ready) {
    for (const p of problems) console.log(`::${strict ? 'error' : 'warning'}::${p}`);
    if (strict) process.exit(1);
  }
}
