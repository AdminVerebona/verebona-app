/**
 * Mise à jour du RÉFÉRENTIEL DES DOMAINES D'E-MAILS JETABLES — lot 109F.
 *
 *   npm run disposable-domains:update                 # dernière version publiée (branche main)
 *   npm run disposable-domains:update -- --ref <sha>  # version précise (reproductible)
 *   npm run disposable-domains:update -- --from-dir <dossier> [--ref <sha>]
 *        # fichiers déjà téléchargés (disposable_email_blocklist.conf, LICENSE.txt)
 *   … -- --check                                      # vérifie seulement, n'écrit rien
 *   npm run disposable-domains:verify                 # lot 113H : vérifie le référentiel EMBARQUÉ
 *        # (aucun réseau) — lancé par `prebuild` (build Scalingo) et la CI : une
 *        # livraison invalide fait échouer le build, donc n'est jamais promue.
 *        # `-- --dir <dossier>` : vérifie une copie (recette « liste invalide »).
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
 * Lot 113H : les trois fichiers sont d'abord écrits à côté (fichiers
 * temporaires), RELUS et vérifiés ensemble par `verifyReferential` (même
 * contrôle que `--verify`, le prebuild et le test l109f) ; ils ne remplacent
 * le référentiel en place qu'ensuite. Si un renommage échoue, la version
 * précédente est restaurée (copie de sauvegarde le temps de l'échange) ; la
 * version précédente reste en outre dans l'historique git.
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
import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { domainToASCII, fileURLToPath } from 'node:url';

const REPOSITORY = 'https://github.com/disposable-email-domains/disposable-email-domains';
const RAW = 'https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains';
const LIST_FILE = 'disposable_email_blocklist.conf';
const LICENSE_FILE = 'LICENSE.txt';
const MIN_DOMAINS = 1000; // = MIN_VALID_LIST_SIZE (policy.ts), vérifié par le test l109f
const SOURCE_SCHEMA = 'verebona-disposable-domains/1';
const LICENSE_TARGET = 'LICENSE-disposable-email-domains.txt';
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
  license: path.join(dataDir, LICENSE_TARGET),
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

/** Corps du fichier JSON (une entrée par ligne) et empreinte SHA-256 (domaines joints par « \n »). */
export function serializeList(domains) {
  return `${JSON.stringify(domains, null, 0).replace(/","/g, '",\n"').replace(/^\[/, '[\n').replace(/\]$/, '\n]')}\n`;
}
export function listSha256(domains) {
  return createHash('sha256').update(domains.join('\n')).digest('hex');
}

/**
 * Lot 113H — CONTRÔLE D'INTÉGRITÉ du référentiel (pur, sans réseau). Rend la
 * liste des problèmes (vide = conforme) : présence et type, nombre minimal,
 * forme normalisée de chaque domaine, tri strict (donc unicité), aucune
 * sentinelle, `source.json` complet et cohérent (schéma, source, fichier,
 * licence, ref, version, date, nombre, empreinte SHA-256, commande), texte de
 * licence CC0 présent.
 * @param {{ list: unknown, source: unknown, license: unknown, now?: Date }} input
 * @returns {string[]}
 */
export function verifyReferential({ list, source, license, now = new Date() }) {
  const problems = [];
  if (!Array.isArray(list)) return ['liste des domaines absente ou illisible (tableau JSON attendu)'];
  if (list.length === 0) problems.push('liste des domaines VIDE');
  else if (list.length < MIN_DOMAINS) problems.push(`liste tronquée : ${list.length} domaines (minimum ${MIN_DOMAINS})`);
  const malformed = [];
  let unordered = 0;
  let duplicates = 0;
  for (let i = 0; i < list.length; i++) {
    const d = list[i];
    if (typeof d !== 'string' || normalizeDomain(d) !== d || !DOMAIN_RE.test(d)) { malformed.push(String(d)); continue; }
    if (i > 0 && typeof list[i - 1] === 'string') {
      if (list[i - 1] === d) duplicates++;
      else if (list[i - 1] > d) unordered++;
    }
  }
  if (malformed.length) problems.push(`${malformed.length} entrée(s) de forme invalide (ex. ${malformed.slice(0, 3).join(', ')})`);
  if (duplicates) problems.push(`${duplicates} doublon(s)`);
  if (unordered) problems.push(`liste non triée (${unordered} inversion(s))`);
  const set = new Set(list);
  const sentinel = SENTINELS.filter((x) => set.has(x));
  if (sentinel.length) problems.push(`domaines légitimes présents (liste d'autorisation) : ${sentinel.join(', ')}`);

  const s = source && typeof source === 'object' ? source : null;
  if (!s) {
    problems.push('source.json absent ou illisible');
  } else {
    const expect = (field, ok, msg) => { if (!ok) problems.push(`source.json : ${field} ${msg}`); };
    expect('schema', s.schema === SOURCE_SCHEMA, `différent de « ${SOURCE_SCHEMA} »`);
    expect('name', s.name === 'disposable-email-domains', 'inattendu');
    expect('repository', s.repository === REPOSITORY, 'inattendu');
    expect('file', s.file === LIST_FILE, 'inattendu');
    expect('license', s.license === 'CC0-1.0', 'différente de CC0-1.0');
    expect('licenseFile', s.licenseFile === LICENSE_TARGET, `différent de « ${LICENSE_TARGET} »`);
    const refOk = typeof s.ref === 'string' && /^[0-9a-f]{40}$/.test(s.ref);
    expect('ref', refOk, 'absente ou invalide (identifiant de 40 caractères attendu)');
    expect('version', refOk && s.version === `dea-${s.ref.slice(0, 7)}`, 'incohérente avec ref');
    const at = typeof s.fetchedAt === 'string' ? Date.parse(s.fetchedAt) : NaN;
    expect('fetchedAt', Number.isFinite(at) && at <= now.getTime() + 86_400_000, 'absente, invalide ou dans le futur');
    expect('count', s.count === list.length, `(${String(s.count)}) différent du nombre de domaines (${list.length})`);
    const shaOk = typeof s.sha256 === 'string' && /^[0-9a-f]{64}$/.test(s.sha256);
    expect('sha256', shaOk, 'absente ou invalide');
    if (shaOk && list.every((d) => typeof d === 'string')) expect('sha256', s.sha256 === listSha256(list), 'différente de l’empreinte de la liste');
    expect('updateCommand', refOk && typeof s.updateCommand === 'string' && s.updateCommand.includes(s.ref), 'ne cite pas ref');
  }
  if (typeof license !== 'string' || license.trim() === '') problems.push('texte de licence absent');
  else if (!/CC0 1\.0/.test(license)) problems.push('texte de licence différent de CC0 1.0');
  return problems;
}

/** Lit le référentiel embarqué d'un dossier (fichiers absents ou illisibles → `null`). */
export function readReferential(dir = dataDir) {
  const read = (file, json) => {
    try {
      const t = readFileSync(path.join(dir, file), 'utf8');
      return json ? JSON.parse(t) : t;
    } catch {
      return null;
    }
  };
  return { list: read('disposable-domains.json', true), source: read('source.json', true), license: read(LICENSE_TARGET, false) };
}

/** `--verify` : contrôle du référentiel embarqué, code de sortie 1 si invalide. */
function verifyEmbedded(dir = arg('--dir') ? path.resolve(arg('--dir')) : dataDir) {
  const ref = readReferential(dir);
  const problems = verifyReferential(ref);
  if (problems.length) {
    console.error(`[disposable-domains] RÉFÉRENTIEL EMBARQUÉ INVALIDE — livraison refusée :\n  - ${problems.join('\n  - ')}\n`
      + 'Remédiation : restaurer la dernière version valide (git checkout -- src/lib/auth/disposable-email/data) '
      + 'ou relancer npm run disposable-domains:update -- --ref <sha> (docs/exploitation/emails-jetables.md).');
    process.exit(1);
  }
  console.log(`[disposable-domains] référentiel embarqué conforme : ${ref.list.length} domaines, version ${ref.source.version}, `
    + `mis à jour le ${ref.source.fetchedAt}, empreinte ${ref.source.sha256.slice(0, 12)}…`);
}

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
  if (has('--verify')) return verifyEmbedded();
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

  const body = serializeList(domains);
  const sha256 = listSha256(domains);
  const fetchedAt = new Date().toISOString();
  const source = {
    schema: SOURCE_SCHEMA,
    name: 'disposable-email-domains',
    repository: REPOSITORY,
    file: LIST_FILE,
    license: 'CC0-1.0',
    licenseFile: LICENSE_TARGET,
    ref: sha,
    version: `dea-${sha.slice(0, 7)}`,
    fetchedAt,
    count: domains.length,
    sha256,
    updateCommand: `npm run disposable-domains:update -- --ref ${sha}`,
  };
  console.log(`[disposable-domains] ${domains.length} domaines, version ${source.version}, empreinte ${sha256.slice(0, 12)}…`);
  if (has('--check')) { console.log('[disposable-domains] --check : rien n’est écrit.'); return; }

  // Lot 113H : écriture à côté, relecture et vérification d'ensemble, PUIS échange.
  const files = [[target.list, body], [target.license, license], [target.source, `${JSON.stringify(source, null, 2)}\n`]];
  const staged = files.map(([file, content]) => {
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, content);
    return [file, tmp];
  });
  const cleanup = (paths) => { for (const p of paths) rmSync(p, { force: true }); };
  let stagedRef;
  try {
    stagedRef = {
      list: JSON.parse(readFileSync(staged[0][1], 'utf8')),
      license: readFileSync(staged[1][1], 'utf8'),
      source: JSON.parse(readFileSync(staged[2][1], 'utf8')),
    };
  } catch (e) {
    cleanup(staged.map(([, tmp]) => tmp));
    fail(`relecture des fichiers préparés impossible : ${e?.message ?? e}`);
  }
  const problems = verifyReferential(stagedRef);
  if (problems.length) {
    cleanup(staged.map(([, tmp]) => tmp));
    fail(`référentiel préparé invalide : ${problems.join(' ; ')}`);
  }
  const backups = files.filter(([file]) => existsSync(file)).map(([file]) => {
    const bak = `${file}.prev-${process.pid}`;
    copyFileSync(file, bak);
    return [file, bak];
  });
  try {
    for (const [file, tmp] of staged) renameSync(tmp, file);
    const after = verifyReferential(readReferential());
    if (after.length) throw new Error(`référentiel écrit invalide : ${after.join(' ; ')}`);
  } catch (e) {
    for (const [file, bak] of backups) copyFileSync(bak, file);
    cleanup([...staged.map(([, tmp]) => tmp), ...backups.map(([, bak]) => bak)]);
    fail(`échange interrompu (${e?.message ?? e}) : version précédente restaurée.`);
  }
  cleanup(backups.map(([, bak]) => bak));
  console.log('[disposable-domains] référentiel écrit. Lancez : npm run disposable-domains:verify && npx vitest run src/lib/auth/disposable-email');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => fail(e?.message ?? String(e)));
}
