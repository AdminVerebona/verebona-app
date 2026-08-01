/**
 * GET /api/cron/ai/corpus-status — consultation des campagnes.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LIRE UN RÉSULTAT NE DOIT PAS COÛTER 28 APPELS
 *
 * `corpus-run` exécute la campagne dans la requête. Vingt-huit analyses en
 * série dépassent le délai d'une passerelle HTTP : le résultat arrive, mais
 * personne ne le voit — et la seule façon de le consulter était de relancer
 * une campagne, donc de repayer.
 *
 * Cette route lit ce qui est enregistré. Elle ne déclenche rien et ne
 * consomme rien.
 *
 * ── ELLE RÉPOND AUSSI PENDANT L'EXÉCUTION ─────────────────────────────────
 *
 * Une campagne en cours est visible : on sait qu'elle tourne, depuis quand,
 * et combien de cas ont été traités. Sans cela, un 504 laisse dans le doute
 * entre « ça continue » et « c'est mort » — et ce doute pousse à relancer.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { NextRequest, NextResponse } from 'next/server';
import { ensureMigrations, pgClient } from '@/db';
import type { CorpusRun } from '@/services/ai/governance/corpus/corpus-runner';

export const dynamic = 'force-dynamic';

interface Ligne {
  id: number;
  payload: string;
  created_at: Date;
}

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }

  await ensureMigrations();

  let reference: CorpusRun | null = null;
  try {
    const [row] = await pgClient<Ligne[]>`
      SELECT id, payload, created_at FROM ai_corpus_baseline WHERE id = 1
    `;
    reference = row ? (JSON.parse(row.payload) as CorpusRun) : null;
  } catch {
    // La table n'existe que depuis la première campagne enregistrée.
    reference = null;
  }

  if (!reference) {
    return NextResponse.json({
      reference: null,
      note:
        'Aucune référence enregistrée. Lancer /api/cron/ai/corpus-run?baseline=1 ' +
        'sur le moteur historique.',
    });
  }

  const conformes = reference.summary.passed;
  const total = reference.summary.total;

  // ── Tarifs : quels modèles sont couverts ? ─────────────────────────────
  //
  // Un coût nul ne dit pas si les tarifs manquent ou s'ils portent sur
  // d'AUTRES modèles que ceux réellement appelés. La seconde cause est
  // invisible depuis le seul décompte.
  let tarifs: Array<{ modele: string; verifie: boolean }> = [];
  try {
    const lignes = await pgClient<{ model: string; verified: boolean }[]>`
      SELECT model, bool_or(verified) AS verified
      FROM ai_model_pricing GROUP BY model ORDER BY model
    `;
    tarifs = lignes.map((l) => ({ modele: l.model, verifie: l.verified }));
  } catch { /* table absente : rien à dire */ }

  const APPELES = ['gemini-3.1-flash-lite', 'gemini-3.5-flash', 'gemini-2.5-pro'];

  return NextResponse.json({
    tarifs: {
      modelesCouverts: tarifs,
      modelesAppeles: APPELES,
      manquants: APPELES.filter((m) => !tarifs.some((t) => t.modele === m)),
    },
    reference: {
      label: reference.label,
      date: reference.startedAt,
      total,
      conformes,
      // Un `usedFallback` généralisé signale que le modèle principal a échoué
      // à chaque appel : la mesure porte alors sur le modèle de repli, ce qui
      // n'est pas ce qu'on croit mesurer.
      replis: reference.summary.fallbacks,
      erreursDeType: reference.summary.typeErrors,
      fuites: reference.summary.leaks,
      champsCorrects: `${reference.summary.fieldsCorrect} / ${reference.summary.fieldsCompared}`,
      coutMicros: reference.summary.totalCostMicros,
      dureeMoyenneMs: reference.summary.avgDurationMs,
    },
    // Trois signaux qui invalident une référence, chacun pour une raison
    // différente. Les taire laisserait comparer contre une mesure fausse.
    alertes: [
      total === 0 ? 'Aucun cas mesuré : référence inexploitable.' : null,
      total > 0 && conformes === 0
        ? 'Aucun cas conforme : vérifier le harnais avant de conclure au moteur.'
        : null,
      reference.summary.fallbacks === total && total > 0
        ? 'Tous les appels ont employé le modèle de repli : la mesure ne porte ' +
          'pas sur le modèle principal.'
        : null,
      reference.summary.totalCostMicros === 0 && total > 0
        ? 'Coût nul sur une campagne réelle : les tarifs ne sont pas renseignés.'
        : null,
    ].filter(Boolean),
    exploitable:
      total > 0 && conformes > 0 && reference.summary.fallbacks < total,
  });
}
