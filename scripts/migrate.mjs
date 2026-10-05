#!/usr/bin/env node
/**
 * Étape de migration du déploiement (APP-PERF-16).
 *
 *   node scripts/migrate.mjs            applique, puis répare les index invalides
 *   node scripts/migrate.mjs --check    lecture seule : état du schéma
 *   node scripts/migrate.mjs --no-repair
 *
 * Lancée par Scalingo via le Procfile (`postdeploy`) : APRÈS le build, AVANT
 * que la nouvelle version reçoive du trafic. Code de sortie non nul → le
 * déploiement échoue et l'ancienne version continue de servir (CA-01).
 *
 *   0  schéma prêt (ou seulement des index optionnels manquants : dégradé)
 *   1  migration critique non appliquée, ou verrou non obtenu avec du
 *      critique en attente
 *   2  configuration / connexion impossible
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI DU JAVASCRIPT QUI CHARGE DU TYPESCRIPT
 *
 * Sur Scalingo les devDependencies (dont `tsx`) sont élaguées. Le moteur de
 * migration (`src/db/migration-index.ts`) est volontairement SANS IMPORT et en
 * syntaxe TypeScript effaçable : Node le charge directement par retrait des
 * types (natif à partir de Node 22.18, option `--experimental-strip-types`
 * à partir de 22.6 — ajoutée ici automatiquement au besoin). C'est le MÊME
 * code que le démarrage web : aucune seconde implémentation à faire diverger.
 *
 * Poste de développement en Node 20.12+ (lot 24) : pas de retrait natif des
 * types ; le fichier est alors transpilé par le paquet `typescript`
 * (devDependency, présent après `npm install`) — voir `chargerMoteur`. Sur
 * Scalingo (Node 24, devDeps élaguées) c'est le retrait natif qui sert.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ══════════════════════════════════════════════════════════════════════════
 * BUDGET DE TEMPS ET INDEX (lot 24b)
 *
 * Scalingo arrête un postdeploy au bout de 20 minutes (statut -128 : le
 * déploiement échoue). Tout le passage tient donc dans un budget
 * (`MIGRATION_DEPLOY_BUDGET_MS`, 15 min par défaut) : attente du verrou de
 * l'exécutant et délai de chaque construction CONCURRENTLY en sont bornés.
 * Les constructions ont un délai LONG (`MIGRATION_INDEX_LOCK_TIMEOUT`, 10min) :
 * elles attendent la fin des transactions de l'ancienne version, qui sert
 * encore. Un index OPTIONNEL qui ne se construit pas dans ce cadre ne fait
 * pas échouer le déploiement (`degraded`, code 0) : l'application le
 * construira en arrière-plan une fois l'ancienne version arrêtée.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Variables (aucune obligatoire hormis DATABASE_URL) : MIGRATION_LOCK_WAIT_MS
 * (défaut 600000 ici), MIGRATION_LOCK_TIMEOUT (10s), MIGRATION_STATEMENT_TIMEOUT
 * (0), MIGRATION_INDEX_LOCK_TIMEOUT (10min), MIGRATION_DEPLOY_BUDGET_MS (900000).
 * Recette seulement : MIGRATIONS_DIR (dossier des fichiers), MIGRATIONS_SCHEMA
 * (search_path de la connexion).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ici = path.dirname(fileURLToPath(import.meta.url));
const racine = path.resolve(ici, '..');
const args = new Set(process.argv.slice(2));
const log = (m) => console.log(`[migrate] ${m}`);

// Retrait des types : natif (Node ≥ 22.18), via l'option (≥ 22.6, ré-exécution),
// sinon transpilation locale (poste Node 20.12+, voir chargerMoteur).
if (!process.features?.typescript && !process.env.__VEREBONA_MIGRATE_REEXEC) {
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj > 22 || (maj === 22 && min >= 6)) {
    const r = spawnSync(
      process.execPath,
      ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', fileURLToPath(import.meta.url), ...process.argv.slice(2)],
      { stdio: 'inherit', env: { ...process.env, __VEREBONA_MIGRATE_REEXEC: '1' } },
    );
    process.exit(r.status ?? 2);
  }
}

/**
 * Charge le moteur de migration. Retrait des types disponible → import direct.
 * Sinon (poste local Node 20.12–22.5) : transpilation du fichier par le
 * paquet `typescript` (devDependency) puis import en module ESM `data:`.
 * Possible car le moteur n'a AUCUN import statique (seulement des `node:*`
 * dynamiques, autorisés depuis une URL `data:`). On n'enregistre pas de
 * chargeur global (tsx) : Node 20.19+ (require(esm)) le fait échouer.
 */
async function chargerMoteur() {
  const fichier = path.join(racine, 'src/db/migration-index.ts');
  if (process.features?.typescript || process.env.__VEREBONA_MIGRATE_REEXEC) {
    // URL de fichier : un chemin absolu Windows (C:\…) n'est pas un spécifier ESM valide.
    return import(pathToFileURL(fichier).href);
  }
  let ts;
  try {
    ts = (await import('typescript')).default;
  } catch (e) {
    console.error(
      `[migrate] Node ${process.versions.node} : pas de retrait natif des types et paquet \`typescript\` absent `
      + `(lancez \`npm install\`, ou utilisez Node ≥ 22.6). ${e?.message ?? e}`,
    );
    process.exit(2);
  }
  const { outputText } = ts.transpileModule(readFileSync(fichier, 'utf-8'), {
    fileName: fichier,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText, 'utf-8').toString('base64')}`);
}

// Poste local : `.env.local` / `.env` si DATABASE_URL n'est pas déjà posée.
if (!process.env.DATABASE_URL) {
  for (const f of ['.env.local', '.env']) {
    const p = path.join(racine, f);
    if (existsSync(p)) { try { process.loadEnvFile(p); } catch { /* ignoré */ } }
    if (process.env.DATABASE_URL) break;
  }
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('[migrate] DATABASE_URL absente.');
  process.exit(2);
}

const moteur = await chargerMoteur();
const { default: postgres } = await import('postgres');

const entier = (nom, defaut) => {
  const brut = (process.env[nom] ?? '').trim();
  if (!brut) return defaut;
  const n = Number(brut);
  if (!Number.isInteger(n) || n < 0) { console.error(`[migrate] ${nom}=« ${brut} » invalide.`); process.exit(2); }
  return n;
};
const schema = (process.env.MIGRATIONS_SCHEMA ?? '').trim();
if (schema && !/^[a-z_][a-z0-9_]*$/.test(schema)) {
  console.error(`[migrate] MIGRATIONS_SCHEMA=« ${schema} » invalide.`);
  process.exit(2);
}

const debut = Date.now();
// Budget : sous les 20 min du postdeploy Scalingo (19 min au plus).
const budgetMs = Math.min(entier('MIGRATION_DEPLOY_BUDGET_MS', 900_000), 1_140_000);
const indexLockTimeout = process.env.MIGRATION_INDEX_LOCK_TIMEOUT?.trim() || moteur.MIGRATION_INDEX_LOCK_TIMEOUT_DEPLOY;
if (!moteur.isPgDuration(indexLockTimeout)) {
  console.error(`[migrate] MIGRATION_INDEX_LOCK_TIMEOUT=« ${indexLockTimeout} » invalide (attendu : 500ms, 10s, 10min, 0).`);
  process.exit(2);
}

// Nom visible dans pg_stat_activity (diagnostic des index bloqués) : rôle et
// conteneur seulement (`CONTAINER` posé par Scalingo, ex. postdeploy-1).
const conteneur = (process.env.DB_PROCESS_ROLE || process.env.CONTAINER || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40);
const sql = postgres(url, {
  max: 2,
  prepare: false,
  connect_timeout: 15,
  onnotice: () => undefined,
  connection: {
    application_name: conteneur ? `verebona-migrate:${conteneur}` : 'verebona-migrate',
    ...(schema ? { search_path: schema } : {}),
  },
});

let code = 0;
try {
  const fichiers = await moteur.readMigrationFiles(process.env.MIGRATIONS_DIR || path.join(racine, 'src', 'db', 'migrations'));
  const catalogue = moteur.migrationCatalog(fichiers);
  if (args.has('--check')) {
    const st = await moteur.readSchemaState(sql, catalogue);
    log(`${fichiers.length} fichier(s) ; en attente : ${st.pendingCritical.length} critique(s), ${st.pendingOptional.length} optionnel(s).`);
    for (const f of st.pendingCritical) log(`  critique  ${f}`);
    for (const f of st.pendingOptional) log(`  optionnel ${f}`);
    code = st.pendingCritical.length > 0 ? 1 : 0;
  } else {
    log(`budget ${Math.round(budgetMs / 1000)} s ; délai des constructions d'index ${indexLockTimeout} (borné par le budget).`);
    const r = await moteur.runMigrations(sql, fichiers, {
      lockWaitMs: entier('MIGRATION_LOCK_WAIT_MS', 600_000),
      lockTimeout: process.env.MIGRATION_LOCK_TIMEOUT?.trim() || undefined,
      statementTimeout: process.env.MIGRATION_STATEMENT_TIMEOUT?.trim() || undefined,
      indexLockTimeout,
      deadline: debut + budgetMs,
      repairIndexes: !args.has('--no-repair'),
      log: { info: log, warn: (m) => console.warn(`[migrate] ${m}`), error: (m) => console.error(`[migrate] ${m}`) },
    });
    for (const i of r.repair?.repaired ?? []) log(`index invalide ${i} reconstruit.`);
    for (const q of r.repair?.requeued ?? []) console.warn(`[migrate] index ${q.index} non reconstruit (${q.reason}) : ${q.filename} remis en file (maintenance en arrière-plan).`);
    if (r.pendingCritical.length === 0 && r.pendingOptional.length > 0) {
      log(`${r.pendingOptional.length} index optionnel(s) en attente (${r.pendingOptional.join(', ')}) : déploiement NON bloqué, `
        + 'construction en arrière-plan par l\'application une fois l\'ancienne version arrêtée.');
    }
    for (const i of r.repair?.unknown ?? []) console.error(`[migrate] index INVALIDE hors migrations : ${i} (DROP INDEX CONCURRENTLY puis recréer).`);
    if (r.firstCriticalFailure) {
      const f = r.firstCriticalFailure;
      console.error(`[migrate] PREMIÈRE CAUSE : ${f.filename} (${f.code ?? 'sans code'}) : ${f.message}`);
    }
    // Mesures (APP-PERF-16 §MESURES) : une ligne JSON exploitable.
    console.log(`[migrate] ${JSON.stringify({
      outcome: r.outcome, durationMs: r.durationMs, lockWaitMs: r.lockWaitMs, lockAcquired: r.lockAcquired,
      applied: r.applied.length, deferred: r.deferred.length, failures: r.failures.length,
      budgetMs, indexLockTimeout,
      pendingCritical: r.pendingCritical.length, pendingOptional: r.pendingOptional.length,
      commit: process.env.APP_COMMIT || process.env.SOURCE_VERSION || process.env.CONTAINER_VERSION || null,
    })}`);
    code = r.outcome === 'ready' || r.outcome === 'degraded' ? 0 : 1;
  }
} catch (e) {
  console.error(`[migrate] impossible : ${e?.message ?? e}`);
  code = 2;
} finally {
  await sql.end({ timeout: 5 }).catch(() => undefined);
}
process.exit(code);
