/**
 * Contrôle « Besoin d'aide » — CDC Centre d'aide V1 §2.1, §6, §13, ARCH-03.
 *
 * « Le build ou la recette doit échouer si un identifiant utilisé par un
 * raccourci n'existe plus, n'est pas publié dans l'environnement cible ou ne
 * peut pas être résolu vers une URL valide. »
 *
 * Lit le catalogue publié par le site public de l'environnement cible et
 * vérifie chaque ID de `HELP_SHORTCUT_IDS`, puis que chaque article ouvre bien
 * une page (HTTP 200, sans redirection).
 *
 *   HELP_CATALOG_URL=https://preprod.verebona.fr/aide/catalogue.json npx tsx scripts/check-help-shortcuts.ts
 *
 * Sans `HELP_CATALOG_URL`, l'URL est déduite de NEXT_PUBLIC_PUBLIC_SITE_URL.
 * Sans l'une ni l'autre : échec en CI (variable de dépôt à renseigner une
 * fois), simple avertissement en local.
 */
import {
  HELP_SHORTCUT_IDS, helpCatalogUrl, parseCatalog, resolveShortcuts, unresolvedShortcuts,
} from '../src/lib/help-center/catalog';

async function main(): Promise<number> {
  const explicit = process.env.HELP_CATALOG_URL;
  const site = process.env.NEXT_PUBLIC_PUBLIC_SITE_URL;
  const url = explicit || (site ? helpCatalogUrl(site) : null);
  if (!url) {
    // En CI, l'absence de configuration est un échec : le §2.1 exige que ce
    // contrôle bloque. Localement, un simple avertissement.
    if (process.env.CI) {
      console.error('✗ HELP_CATALOG_URL absente (variable de dépôt) : contrôle des raccourcis impossible.');
      return 1;
    }
    console.log('⚠ HELP_CATALOG_URL absente : contrôle des raccourcis « Besoin d’aide » non exécuté.');
    return 0;
  }

  const res = await fetch(url);
  if (!res.ok) {
    console.error(`✗ Catalogue illisible (${res.status}) : ${url}`);
    return 1;
  }
  const catalog = parseCatalog(await res.json());
  if (!catalog) {
    console.error(`✗ Catalogue au format inattendu : ${url}`);
    return 1;
  }

  const errors = unresolvedShortcuts(catalog).map((e) => `${e.id} : ${e.reason} dans « ${catalog.environment} »`);
  // Le catalogue de préproduction publie aussi les articles bloqués, pour la
  // recette. Un raccourci doit pourtant mener à un article publiable EN
  // PRODUCTION : sinon il disparaîtrait à la mise en production.
  const byId = new Map(catalog.articles.map((a) => [a.id, a]));
  for (const id of HELP_SHORTCUT_IDS) {
    const a = byId.get(id);
    if (a && a.status !== 'published') errors.push(`${id} : article bloqué, non publié en production`);
  }
  const origin = new URL(url).origin;
  for (const s of resolveShortcuts(catalog)) {
    const page = await fetch(`${origin}${s.path}`, { redirect: 'manual' });
    if (page.status !== 200) errors.push(`${s.id} : ${s.path} répond ${page.status}`);
  }

  if (errors.length) {
    console.error(`✗ Raccourcis « Besoin d’aide » non résolus (catalogue ${catalog.version}) :\n  · ${errors.join('\n  · ')}`);
    return 1;
  }
  console.log(`✓ ${HELP_SHORTCUT_IDS.length} raccourcis résolus dans « ${catalog.environment} » (catalogue ${catalog.version}).`);
  return 0;
}

main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
