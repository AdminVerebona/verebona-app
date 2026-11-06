/**
 * Garde-fou des droits signés du partage (lot 111P, réécrit au lot 112 correctif 4, 06/11/2026).
 *
 *   node scripts/signed-entitlements-guard.mjs <groupe> <nom>=<droits.json> [<nom>=<droits.json> …]
 *
 * Les droits viennent de `codesign -d --entitlements - --xml <bundle>` convertis en JSON
 * par `plutil -convert json`. Constat du 06/11 : la version shell lisait les clés avec
 * `plutil -extract com.apple.security.application-groups …` ; or `plutil` prend le POINT
 * pour un séparateur de chemin (com → apple → security…) : la clé n'était jamais trouvée
 * et le garde-fou refusait l'envoi (« droits signés de App.app : aucun ») alors que le
 * binaire portait bien le groupe. Lire le JSON évite toute interprétation des points
 * et rend le contrôle testable hors macOS.
 *
 * Contrôles (inchangés) : le groupe d'apps attendu figure dans
 * com.apple.security.application-groups de chaque bundle ; app et extension sont signées
 * par la même équipe (sinon Keychain non partagé). keychain-access-groups est affiché.
 */
import { appendFileSync, readFileSync } from 'node:fs';

export function readEntitlements(json) {
  const e = json && typeof json === 'object' ? json : {};
  const arr = (v) => (Array.isArray(v) ? v.map(String) : []);
  return {
    groups: arr(e['com.apple.security.application-groups']),
    keychain: arr(e['keychain-access-groups']),
    team: typeof e['com.apple.developer.team-identifier'] === 'string' ? e['com.apple.developer.team-identifier'] : '',
  };
}

/** @param {string} group @param {Array<{name: string, json: unknown}>} bundles */
export function guard(group, bundles) {
  const errors = [];
  const lines = [];
  const summary = [];
  const teams = new Set();
  for (const b of bundles) {
    const r = readEntitlements(b.json);
    if (!r.groups.includes(group)) {
      errors.push(`Envoi refusé — ${group} absent de com.apple.security.application-groups (droits signés de ${b.name} : ${r.groups.length ? r.groups.join(', ') : 'aucun'}). Cocher le groupe d'apps sur l'identifiant de ${b.name} (developer.apple.com › Identifiers).`);
      continue;
    }
    if (r.team) teams.add(r.team);
    lines.push(`${b.name} : application-groups=[${r.groups.join(' ')}] keychain-access-groups=[${r.keychain.join(' ')}] équipe=${r.team || '?'}`);
    summary.push(`- ${b.name} : groupe d'apps ${group} ✓ · keychain-access-groups : ${r.keychain.length ? r.keychain.join(' ') : "aucun (le groupe d'apps sert de groupe Keychain)"} · équipe ${r.team || '?'}`);
  }
  if (!errors.length && teams.size > 1) errors.push(`Envoi refusé — app et extension signées par deux équipes différentes (${[...teams].join(' / ')}) : Keychain non partagé.`);
  return { errors, lines, summary };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [group, ...pairs] = process.argv.slice(2);
  const bundles = pairs.map((p) => {
    const i = p.indexOf('=');
    const name = p.slice(0, i);
    let json = null;
    try { json = JSON.parse(readFileSync(p.slice(i + 1), 'utf8')); } catch { /* illisible : contrôlé ci-dessous */ }
    if (json == null) { console.log(`::error::Envoi refusé — droits signés illisibles pour ${name}.`); process.exit(1); }
    return { name, json };
  });
  const r = guard(group, bundles);
  for (const l of r.lines) console.log(l);
  if (process.env.GITHUB_STEP_SUMMARY && r.summary.length) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${r.summary.join('\n')}\n`);
  for (const e of r.errors) console.log(`::error::${e}`);
  if (r.errors.length) process.exit(1);
  console.log(`Droits signés du partage contrôlés : ${group} dans l'app et l'extension.`);
}
