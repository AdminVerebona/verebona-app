/**
 * GET /api/cron/ai/corpus-run — campagne de mesure. CDC §11.1.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LA MESURE DOIT S'EXÉCUTER OÙ TOURNE LE MOTEUR
 *
 * `npm run corpus:run` suppose un accès à la base depuis le poste, ce qui
 * n'existe pas en préproduction. Mais il y a plus grave : la campagne mesure
 * l'état des DRAPEAUX du processus qui l'exécute.
 *
 * Lancée depuis un poste, elle mesurerait la configuration de ce poste — pas
 * celle du serveur. On comparerait deux moteurs qui ne sont pas ceux qui
 * traitent les documents réels.
 *
 * Cette route s'exécute dans le processus serveur : elle mesure exactement ce
 * qui tourne.
 *
 * ── PARAMÈTRES ────────────────────────────────────────────────────────────
 *
 *   ?dry=1           chaîne seule, aucun appel modèle — gratuit
 *   ?baseline=1      enregistre le résultat comme référence
 *   ?compare=1       compare à la référence et rend un verdict de bascule
 *   ?categories=dpe,carte_grise
 *
 * ── LE COÛT EST RÉEL ──────────────────────────────────────────────────────
 *
 * Hors `dry`, chaque cas consomme un appel modèle facturé au compte technique
 * `CORPUS_ACCOUNT_ID`. Vingt-huit cas par campagne, deux campagnes pour une
 * comparaison.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { NextRequest, NextResponse } from 'next/server';
import { ensureMigrations, pgClient } from '@/db';
import { getFlagMode } from '@/services/ai/flags/ai-feature-flags';
import {
  runCorpus,
  isSafeToSwitch,
  type CorpusRun,
} from '@/services/ai/governance/corpus/corpus-runner';
// `detectRegressions` vit dans le comparateur : le harnais l'utilise sans le
// réexporter.
import { detectRegressions } from '@/services/ai/governance/corpus/corpus-comparator';
import {
  createAnalysisRunner,
  createDryRunner,
} from '@/services/ai/governance/corpus/analysis-runner';
import '@/services/ai/governance/corpus/corpus-cases';

export const dynamic = 'force-dynamic';
export const maxDuration = 800;

/**
 * La référence est conservée en base, pas sur le disque.
 *
 * Un conteneur applicatif est éphémère : un fichier écrit lors d'une campagne
 * aurait disparu à la suivante, et la comparaison n'aurait jamais lieu.
 */
async function lireReference(): Promise<CorpusRun | null> {
  try {
    const [row] = await pgClient<{ payload: string }[]>`
      SELECT payload FROM ai_corpus_baseline WHERE id = 1
    `;
    return row ? (JSON.parse(row.payload) as CorpusRun) : null;
  } catch {
    return null;
  }
}

async function ecrireReference(run: CorpusRun): Promise<void> {
  await pgClient`
    CREATE TABLE IF NOT EXISTS ai_corpus_baseline (
      id         INTEGER PRIMARY KEY,
      payload    TEXT        NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  const payload = JSON.stringify(run);
  await pgClient`
    INSERT INTO ai_corpus_baseline (id, payload, created_at) VALUES (1, ${payload}, now())
    ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, created_at = now()
  `;
}

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }

  await ensureMigrations();

  const p = req.nextUrl.searchParams;
  const dry = p.get('dry') === '1';
  const baseline = p.get('baseline') === '1';
  const compare = p.get('compare') === '1';
  const categories = p.get('categories')?.split(',').map((c) => c.trim()).filter(Boolean);

  const mode = getFlagMode('AI_UNIFIED_SOURCE_ANALYSIS');
  const label = dry ? 'vérification à blanc' : `moteur ${mode === 'enabled' ? 'unifié' : 'historique'}`;

  // Le compte technique n'est requis que pour une campagne réelle.
  if (!dry) {
    const compte = Number(process.env.CORPUS_ACCOUNT_ID);
    if (!Number.isInteger(compte) || compte <= 0) {
      return NextResponse.json(
        {
          error: 'CORPUS_ACCOUNT_ID absente ou invalide.',
          code: 'NO_CORPUS_ACCOUNT',
          remede:
            'Renseigner un compte technique. Rattacher la campagne à un compte ' +
            'client fausserait la mesure de coût qu\'elle produit.',
        },
        { status: 409 },
      );
    }
  }

  let run: CorpusRun;
  try {
    run = await runCorpus(dry ? createDryRunner() : createAnalysisRunner(), { label, categories });
  } catch (e) {
    return NextResponse.json(
      { error: 'Campagne impossible.', code: 'RUN_FAILED', cause: (e as Error).message },
      { status: 500 },
    );
  }

  // ══════════════════════════════════════════════════════════════════════
  // UNE RÉFÉRENCE VIDE EST PIRE QUE PAS DE RÉFÉRENCE
  //
  // La campagne a enregistré une référence de 0 cas alors que les 28 avaient
  // échoué. Une comparaison ultérieure aurait alors conclu que le nouveau
  // moteur améliore tout — puisque la référence ne contenait rien.
  //
  // On refuse donc d'écraser la référence quand la campagne n'a rien mesuré,
  // et on dit pourquoi.
  // ══════════════════════════════════════════════════════════════════════
  let referenceEnregistree = false;
  let refusReference: string | undefined;

  if (baseline && !dry) {
    if (run.summary.total === 0) {
      refusReference =
        `Aucun cas mesuré sur ${run.errors.length} tenté(s) : référence non ` +
        'enregistrée. Corriger la cause avant de relancer.';
    } else if (run.errors.length > run.summary.total) {
      refusReference =
        `Plus d'erreurs (${run.errors.length}) que de cas mesurés ` +
        `(${run.summary.total}) : référence non enregistrée.`;
    } else {
      await ecrireReference(run);
      referenceEnregistree = true;
    }
  }

  const reponse: Record<string, unknown> = {
    drapeau: mode,
    label,
    dry,
    resume: run.summary,
    erreurs: run.errors,
    // Les cas non conformes seulement : servir les 28 rendrait la réponse
    // illisible là où seuls les écarts intéressent.
    nonConformes: run.results
      .filter((r) => !r.expectedMatch)
      .map((r) => ({
        cas: r.caseId,
        typeCorrect: r.documentTypeCorrect,
        fuite: r.crossAssetLeak ? r.leakedAssets : undefined,
        champsIncorrects: r.fields
          .filter((f) => f.verdict !== 'match')
          .map((f) => ({ champ: f.field, verdict: f.verdict, attendu: f.expected, observe: f.observed })),
      })),
    referenceEnregistree,
    ...(refusReference ? { refusReference } : {}),
  };

  if (compare) {
    const avant = await lireReference();
    if (!avant) {
      reponse.comparaison = {
        erreur: 'Aucune référence enregistrée. Lancer d\'abord ?baseline=1 sur le moteur historique.',
      };
    } else {
      const verdict = isSafeToSwitch(avant, run);
      reponse.comparaison = {
        reference: { label: avant.label, date: avant.startedAt, conformes: avant.summary.passed },
        actuel: { label: run.label, conformes: run.summary.passed },
        ecarts: detectRegressions(avant.results, run.results),
        basculeSure: verdict.safe,
        motifs: verdict.reasons,
      };
    }
  }

  return NextResponse.json(reponse);
}
