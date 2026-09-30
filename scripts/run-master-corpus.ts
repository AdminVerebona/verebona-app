/**
 * Corpus des prompts maîtres — CDC 15 §30, D-08, D-17, HC-06.
 *
 *   npm run ai:corpus                                    # fichiers du dépôt, REJEU, rapport (CI)
 *   npm run ai:corpus -- --check-fingerprints            # + empreintes de référence (ai:verify)
 *   npm run ai:corpus -- --update-fingerprints           # après corpus vert : met à jour la référence
 *   npm run ai:corpus -- --version 42 --record           # REJEU sur les textes de la version 42, en base
 *   npm run ai:corpus -- --active --record               # REJEU sur la version effective
 *   npm run ai:corpus -- --live --record --account 7     # PASSAGE RÉEL (préprod) sur la version effective
 *   options : --treatment T1 (répétable) · --source ci|preprod|prod|local · --json
 *
 * Ce que garantit chaque type d'exécution :
 *   · REJEU (sans modèle) : le texte évalué se rend sur chaque branche ; les
 *     sorties enregistrées SYNTHÉTIQUES (D-08) passent la validation
 *     discriminée et les contrôles serveur. Ne dit rien de la réaction du
 *     modèle au texte. Suffit pour le texte du dépôt (empreinte de référence).
 *   · RÉEL (`--live`, préprod) : la passerelle réelle appelle le modèle avec
 *     le texte de la version EFFECTIVE sur le sous-ensemble critique (cas à
 *     variables réelles, `live.ts`) ; sorties contrôlées et comparées aux
 *     attentes. Exigé par la garde pour un texte master de version (D-17).
 *     Coût : un appel par cas, imputé au compte technique `--account`.
 *
 * Aucune modification du schéma : la table 0224 doit exister (sinon message
 * explicite). Sortie 0 : tout vert (et empreintes conformes si demandé).
 */
import { execSync } from 'child_process';
import { loadEnvQuietly } from './lib/quiet-env';

const args = process.argv.slice(2);
const val = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const has = (name: string) => args.includes(name);
const needsDb = has('--version') || has('--active') || has('--record') || has('--live');

function gitSha(): string | null {
  try { return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null; } catch { return null; }
}

async function main() {
  // Environnement chargé sans bruit : le rejeu du dépôt n'a pas besoin de la base.
  loadEnvQuietly();
  const { runMasterCorpus } = await import('@/services/ai/governance/master-corpus/runner');
  const { readMasterFileFromRepo, loadMasterCorpusCases } = await import('@/services/ai/governance/master-corpus/cases');
  type Treatment = import('@/services/ai/config/treatments').Treatment;

  const json = has('--json');
  const treatments = args.flatMap((a, i) => (a === '--treatment' && args[i + 1] ? [args[i + 1] as Treatment] : []));
  let configVersionId: number | null = null;
  let texts: Record<string, { text: string; source: 'file' | 'config' }> | undefined;

  if (needsDb) {
    if (!process.env.DATABASE_URL) {
      console.error('[ai:corpus] DATABASE_URL absente : --version, --active, --live et --record exigent la base.');
      process.exit(2);
    }
    const { corpusTableReady } = await import('@/services/ai/governance/master-corpus/repository');
    if (has('--record') && !(await corpusTableReady().catch(() => false))) {
      console.error('[ai:corpus] table ai_master_corpus_runs absente (migration 0224 non appliquée) : rien ne peut être enregistré. '
        + 'Ce script ne modifie jamais le schéma : appliquer les migrations (démarrage de l’application), puis relancer.');
      process.exit(2);
    }
  }
  const effective = has('--live') || has('--active');
  if (has('--version') || effective) {
    const repo = await import('@/services/ai/config/config-version.repository');
    const { getAiEnvironment } = await import('@/services/ai/config/environment');
    const version = has('--version')
      ? await repo.getVersion(Number(val('--version')))
      : await repo.getEffectiveVersion(getAiEnvironment());
    if (!version) { console.error(`[ai:corpus] version ${val('--version') ?? 'effective'} introuvable.`); process.exit(2); }
    if (has('--live') && has('--version')) {
      console.error('[ai:corpus] --live s’exécute sur la version EFFECTIVE (celle que la passerelle sert) : retirer --version.');
      process.exit(2);
    }
    configVersionId = version.id;
    const { effectiveMasterText } = await import('@/services/ai/governance/master-corpus/activation-guard');
    texts = {};
    for (const e of version.entries) {
      const m = effectiveMasterText(e, readMasterFileFromRepo);
      if (m) texts[m.masterPromptCode] = { text: m.text, source: m.source };
    }
  }

  let live;
  if (has('--live')) {
    const account = Number(val('--account'));
    if (!Number.isInteger(account) || account <= 0) {
      console.error('[ai:corpus] --live exige --account <id> (compte technique auquel le coût des appels est imputé).');
      process.exit(2);
    }
    const { buildLiveRunner } = await import('@/services/ai/governance/master-corpus/live');
    live = await buildLiveRunner(loadMasterCorpusCases(readMasterFileFromRepo), { accountId: account, userId: Number(val('--user') ?? 0) || 0 });
  }

  const results = await runMasterCorpus({
    readMasterFile: readMasterFileFromRepo, texts, treatments: treatments.length ? treatments : undefined, live,
  });

  if (has('--record')) {
    const { recordCorpusRun } = await import('@/services/ai/governance/master-corpus/repository');
    const { getAiEnvironment } = await import('@/services/ai/config/environment');
    const env = getAiEnvironment();
    const source = (val('--source') ?? (env === 'production' ? 'prod' : env)) as import('@/services/ai/governance/master-corpus/repository').CorpusRunSource;
    if (!['ci', 'preprod', 'prod', 'local'].includes(source)) { console.error(`[ai:corpus] source « ${source} » inconnue.`); process.exit(2); }
    if (has('--live') && source !== 'preprod') console.warn('  ⚠ passage réel hors préproduction : la garde ne l’acceptera pas (D-17).');
    for (const r of results) {
      const id = await recordCorpusRun(r, { configVersionId, source, environment: env, gitSha: gitSha(), runMode: has('--live') ? 'live' : 'replay' });
      if (!json) console.log(`  enregistré #${id} — ${r.masterPromptCode} (${has('--live') ? 'réel' : 'rejeu'}, ${source})`);
    }
  }

  let drift: string[] = [];
  if (has('--check-fingerprints') || has('--update-fingerprints')) {
    const fp = await import('@/services/ai/governance/master-corpus/fingerprints');
    if (texts) { console.error('[ai:corpus] empreintes de référence : fichiers du dépôt seulement (sans --version/--active/--live).'); process.exit(2); }
    if (has('--update-fingerprints')) {
      fp.writeFingerprints(results);
      console.log(`[ai:corpus] référence mise à jour : ${fp.FINGERPRINTS_PATH}`);
    } else {
      drift = fp.fingerprintDrift(results, fp.readFingerprints());
    }
  }

  if (json) console.log(JSON.stringify({ results, fingerprintDrift: drift }, null, 2));
  else print(results, configVersionId, Boolean(live), drift);
  process.exit(results.every((r) => r.status === 'PASSED') && drift.length === 0 ? 0 : 1);
}

function print(
  results: import('@/services/ai/governance/master-corpus/runner').MasterCorpusResult[],
  versionId: number | null, live: boolean, drift: string[],
) {
  console.log(`[ai:corpus] ${live ? 'PASSAGE RÉEL' : 'rejeu'} — ${versionId ? `version ${versionId}` : 'fichiers du dépôt'} — ${results.length} master(s)`);
  for (const r of results) {
    const schema = r.cases.filter((c) => c.level === 'schema').length;
    console.log(`${r.status === 'PASSED' ? '✓' : '✗'} ${r.treatment} ${r.masterPromptCode} [${r.textSource} ${r.textSha256.slice(0, 12)}] `
      + `${r.casesPassed}/${r.casesTotal} cas · branches ${r.branchesPassed.join(', ') || '—'} / ${r.branchesRequired.join(', ')}`
      + (schema ? ` · ${schema} cas au niveau schéma seul` : '')
      + (r.skipped?.length ? ` · hors passage réel : ${r.skipped.join(', ')}` : ''));
    for (const f of r.failures) console.log(`    ✗ ${f}`);
  }
  if (drift.length) {
    console.log('✗ Empreintes de référence : master(s) modifié(s) sans corpus enregistré :');
    for (const d of drift) console.log(`    ✗ ${d}`);
    console.log('  Relancer le corpus, puis `npm run ai:corpus -- --update-fingerprints` (et committer fingerprints.json).');
  }
}

main().catch((e) => { console.error('[ai:corpus]', e); process.exit(1); });
