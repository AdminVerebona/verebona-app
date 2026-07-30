/**
 * Campagne sur le corpus de référence — CDC §11.1.
 *
 *   npm run corpus:run                    # moteur courant
 *   npm run corpus:run -- --baseline      # enregistre la référence
 *   npm run corpus:run -- --compare       # compare à la référence
 *
 * Le mode `--compare` est celui qui décide d'une bascule : il répond à la
 * seule question utile, « le nouveau moteur fait-il mieux ou moins bien ? ».
 * Il sort en code 1 si la bascule n'est pas sûre.
 */
import '@/lib/load-env';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import {
  runCorpus,
  formatReport,
  formatComparison,
  isSafeToSwitch,
  type CorpusRun,
} from '@/services/ai/governance/corpus/corpus-runner';
import { createAnalysisRunner } from '@/services/ai/governance/corpus/analysis-runner';
import '@/services/ai/governance/corpus/corpus-cases';

const BASELINE = 'src/services/ai/governance/corpus/baseline.json';

async function main() {
  const args = process.argv.slice(2);
  const saveBaseline = args.includes('--baseline');
  const compare = args.includes('--compare');
  const label = process.env.AI_UNIFIED_SOURCE_ANALYSIS === 'enabled'
    ? 'moteur unifié' : 'moteur historique';

  const run = await runCorpus(createAnalysisRunner(), { label });
  console.log(formatReport(run));

  if (saveBaseline) {
    const path = join(process.cwd(), BASELINE);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(run, null, 2), 'utf-8');
    console.log(`[corpus] Référence enregistrée : ${BASELINE}\n`);
    process.exit(0);
  }

  if (compare) {
    const path = join(process.cwd(), BASELINE);
    if (!existsSync(path)) {
      console.error('[corpus] Aucune référence enregistrée. Lancez d’abord --baseline.\n');
      process.exit(1);
    }
    const before: CorpusRun = JSON.parse(readFileSync(path, 'utf-8'));
    console.log(formatComparison(before, run));

    const verdict = isSafeToSwitch(before, run);
    if (!verdict.safe) {
      console.error('[corpus] ✗ Bascule DÉCONSEILLÉE :');
      for (const r of verdict.reasons) console.error(`      · ${r}`);
      console.error('');
      process.exit(1);
    }
    console.log('[corpus] ✓ Aucune régression détectée.\n');
  }

  process.exit(0);
}

main().catch((e) => {
  const cause = (e as { cause?: { message?: string } }).cause;
  console.error('[corpus] échec :', e.message);
  if (cause?.message) console.error('[corpus] cause :', cause.message);
  process.exit(1);
});
