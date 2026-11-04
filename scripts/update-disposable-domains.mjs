/**
 * Mise à jour du RÉFÉRENTIEL DES DOMAINES D'E-MAILS JETABLES — lot 109F.
 *
 *   npm run disposable-domains:update                 # dernière version publiée (branche main)
 *   npm run disposable-domains:update -- --ref <sha>  # version précise (reproductible)
 *   npm run disposable-domains:update -- --from-dir <dossier> [--ref <sha>]
 *        # fichiers déjà téléchargés (disposable_email_blocklist.conf, LICENSE.txt)
 *   … -- --check                                      # vérifie seulement, n'écrit rien
 *
 * Source : https://github.com/disposable-email-domains/disposable-email-domains
 * (fichier `disposable_email_blocklist.conf`, licence CC0 1.0 — domaine public).
 * Destination (VERSIONNÉE dans le dépôt, jamais téléchargée en exploitation) :
 *   src/lib/auth/disposable-email/data/disposable-domains.json
 *   src/lib/auth/disposable-email/data/source.json
 *   src/lib/auth/disposable-email/data/LICENSE-disposable-email-domains.txt
 *
 * Garde-fous (sinon RIEN n'est écrit : le référentiel précédent, valide, reste
 * en place) : téléchargement complet, au moins MIN_DOMAINS domaines, baisse
 * de plus de MAX_DROP_RATIO par rapport à la version en place refusée (sauf
 * `--allow-drop`), aucun domaine « sentinelle » (grands fournisseurs, relais
 * de confidentialité : voir SENTINELS, copie de la liste d'autorisation
 * locale), forme de chaque domaine. Écriture atomique (fichier temporaire
 * puis renommage).
 *
 * Normalisation (identique à `normalizeEmailDomain`, vérifiée par le test
 * l109f) : minuscules, espaces retirés, point final retiré, forme
 * internationale convertie en ASCII (punycode, `domainToASCII`), doublons
 * retirés, tri.
 *
 * Outil de développement : aucune exécution en exploitation. Après la mise à
 * jour : `npx vitest run src/lib/auth/disposable-email` puis commit des trois
 * fichiers (docs/exploitation/emails-jetables.md, « Mise à jour »).
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { domainToASCII, fileURLToPath } from 'node:url';

const REPOSITORY = 'https://github.com/disposable-email-domains/disposable-email-domains';
const RAW = 'https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains';
const LIST_FILE = 'disposable_email_blocklist.conf';
const LICENSE_FILE = 'LICENSE.txt';
const MIN_DOMAINS = 1000;
const MAX_DROP_RATIO = 0.2;
/** Ne doivent JAMAIS figurer dans le référentiel (copie de `LOCAL_ALLOWLIST`, policy.ts). */
const SENTINELS = [
  'privaterelay.appleid.com', 'icloud.com', 'me.com', 'mac.com',
  'gmail.com', 'googlemail.com', 'outlook.com', 'outlook.fr', 'hotmail.com', 'hotmail.fr', 'live.com', 'live.fr', 'msn.com',
  'yahoo.com', 'yahoo.fr', 'aol.com', 'orange.fr', 'wanadoo.fr', 'free.fr', 'sfr.fr', 'neuf.fr', 'bbox.fr', 'laposte.net',
  'gmx.fr', 'gmx.com', 'gmx.de', 'proton.me', 'protonmail.com', 'pm.me', 'tutanota.com', 'tuta.io', 'mailo.com', 'fastmail.com',
  'mozmail.com', 'duck.com', 'simplelogin.com', 'aleeas.com', 'slmail.me', 'anonaddy.me', 'addy.io', 'passmail.net',
];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, 'src/lib/auth/disposable-email/data');
const target = {
  list: path.join(dataDir, 'disposable-domains.json'),
  source: path.join(dataDir, 'source.json'),
  license: path.join(dataDir, 'LICENSE-disposable-email-domains.txt'),
};

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name) => process.argv.includes(name);
function fail(msg) {
  console.error(`[disposable-domains] ÉCHEC : ${msg}\nAucun fichier modifié : le référentiel en place reste utilisé.`);
  process.exit(1);
}

export function normalizeDomain(raw) {
  let d = String(raw).normalize('NFC').replace(/[\s​-‍﻿]+/g, '').toLowerCase().replace(/\.+$/, '');
  if (/[^\x00-\x7f]/.test(d)) {
    const ascii = domainToASCII(d);
    if (ascii) d = ascii;
  }
  return d;
}
const DOMAIN_RE = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;

function resolveRef(ref) {
  if (/^[0-9a-f]{40}$/.test(ref)) return ref;
  try {
    const out = execFileSync('git', ['ls-remote', REPOSITORY, ref === 'main' ? 'refs/heads/main' : ref], { encoding: 'utf8', timeout: 60_000 });
    const sha = out.split(/\s+/)[0];
    if (/^[0-9a-f]{40}$/.test(sha)) return sha;
  } catch { /* ignoré : message ci-dessous */ }
  fail(`impossible de résoudre la référence « ${ref} » en identifiant de version (git ls-remote). Passez --ref <sha de 40 caractères>.`);
}

async function download(sha, file) {
  const url = `${RAW}/${sha}/${file}`;
  const res = await fetch(url).catch((e) => fail(`téléchargement impossible (${url}) : ${e?.message ?? e}. Astuce : téléchargez avec curl puis --from-dir.`));
  if (!res.ok) fail(`téléchargement refusé (${url}) : HTTP ${res.status}`);
  return res.text();
}

async function main() {
  const fromDir = arg('--from-dir');
  const sha = resolveRef(arg('--ref') || 'main');
  const rawList = fromDir ? readFileSync(path.join(fromDir, LIST_FILE), 'utf8') : await download(sha, LIST_FILE);
  const license = fromDir ? readFileSync(path.join(fromDir, LICENSE_FILE), 'utf8') : await download(sha, LICENSE_FILE);
  if (!/CC0 1\.0/.test(license)) fail('la licence en amont n’est plus CC0 1.0 : vérification humaine requise avant toute mise à jour.');

  const invalid = [];
  const set = new Set();
  for (const line of rawList.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const d = normalizeDomain(t);
    if (!DOMAIN_RE.test(d)) { invalid.push(t); continue; }
    set.add(d);
  }
  if (invalid.length > 0) console.warn(`[disposable-domains] ${invalid.length} ligne(s) ignorée(s) (forme invalide) : ${invalid.slice(0, 5).join(', ')}`);
  const domains = [...set].sort();
  if (domains.length < MIN_DOMAINS) fail(`seulement ${domains.length} domaines (minimum ${MIN_DOMAINS}) : fichier tronqué ?`);
  const sentinel = SENTINELS.filter((s) => set.has(s));
  if (sentinel.length) fail(`domaines légitimes présents dans la liste : ${sentinel.join(', ')}. Signalez-le en amont ; ne pas mettre à jour.`);

  if (existsSync(target.list) && !has('--allow-drop')) {
    const previous = JSON.parse(readFileSync(target.list, 'utf8'));
    const before = Array.isArray(previous) ? previous.length : 0;
    if (before > 0 && domains.length < before * (1 - MAX_DROP_RATIO)) {
      fail(`le nombre de domaines baisse de ${before} à ${domains.length} (> ${MAX_DROP_RATIO * 100} %). Vérifiez, puis relancez avec --allow-drop.`);
    }
  }

  const body = `${JSON.stringify(domains, null, 0).replace(/","/g, '",\n"').replace(/^\[/, '[\n').replace(/\]$/, '\n]')}\n`;
  const sha256 = createHash('sha256').update(domains.join('\n')).digest('hex');
  const fetchedAt = new Date().toISOString();
  const source = {
    schema: 'verebona-disposable-domains/1',
    name: 'disposable-email-domains',
    repository: REPOSITORY,
    file: LIST_FILE,
    license: 'CC0-1.0',
    licenseFile: 'LICENSE-disposable-email-domains.txt',
    ref: sha,
    version: `dea-${sha.slice(0, 7)}`,
    fetchedAt,
    count: domains.length,
    sha256,
    updateCommand: `npm run disposable-domains:update -- --ref ${sha}`,
  };
  console.log(`[disposable-domains] ${domains.length} domaines, version ${source.version}, empreinte ${sha256.slice(0, 12)}…`);
  if (has('--check')) { console.log('[disposable-domains] --check : rien n’est écrit.'); return; }

  for (const [file, content] of [[target.list, body], [target.license, license], [target.source, `${JSON.stringify(source, null, 2)}\n`]]) {
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, content);
    renameSync(tmp, file);
  }
  console.log('[disposable-domains] référentiel écrit. Lancez : npx vitest run src/lib/auth/disposable-email');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => fail(e?.message ?? String(e)));
}
