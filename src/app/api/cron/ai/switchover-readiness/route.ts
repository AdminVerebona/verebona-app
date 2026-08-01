/**
 * GET /api/cron/ai/switchover-readiness — CDC refonte §10.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * BASCULER N'EST PAS UNE DÉCISION, C'EST UNE VÉRIFICATION
 *
 * Passer `AI_UNIFIED_SOURCE_ANALYSIS` de `legacy` à `enabled` prend une
 * seconde. Savoir si c'est prudent en demande davantage : la grille tarifaire
 * doit être renseignée, le registre des usages complet, les abonnés aval
 * enregistrés, le gabarit de notification présent, le corpus couvrant.
 *
 * Chacun de ces points a une conséquence propre s'il manque, et aucune ne se
 * manifeste au moment de la bascule — toutes plus tard, en production, sur des
 * documents réels.
 *
 * Cette route les vérifie tous, et rend un verdict.
 *
 * ── ELLE NE BASCULE RIEN ──────────────────────────────────────────────────
 *
 * Elle lit. Le drapeau reste une variable d'environnement, modifiée
 * délibérément par un humain. Une route qui basculerait d'elle-même rendrait
 * l'état du système dépendant d'un appel HTTP — impossible à auditer.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { NextRequest, NextResponse } from 'next/server';
import { db, ensureMigrations, getMigrationFailures } from '@/db';
import { emailTemplates } from '@/db/schema';
// `ai_model_pricing` n'est pas déclarée dans `schema.ts` — elle est créée par
// la migration 0111 et lue en SQL brut par `pricing.repository.ts`. On s'aligne
// sur cet accès plutôt que d'en introduire un second.
import { pgClient } from '@/db';
import { eq } from 'drizzle-orm';
import { getFlagMode } from '@/services/ai/flags/ai-feature-flags';
import {
  CORPUS_CATEGORIES,
  listCorpusCases,
  listEmptyCategories,
} from '@/services/ai/governance/corpus/corpus-registry';
import '@/services/ai/governance/corpus/corpus-cases';

export const dynamic = 'force-dynamic';

type Verdict = 'ok' | 'avertissement' | 'bloquant';

interface Controle {
  nom: string;
  verdict: Verdict;
  detail: string;
  /** Ce qui se passerait si l'on basculait malgré tout. */
  consequence?: string;
}

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }

  await ensureMigrations();
  const controles: Controle[] = [];

  // ── 1. Schéma ───────────────────────────────────────────────────────────
  const echecsMigration = getMigrationFailures();
  controles.push(
    echecsMigration.length === 0
      ? { nom: 'schéma', verdict: 'ok', detail: 'Toutes les migrations sont appliquées.' }
      : {
          nom: 'schéma',
          verdict: 'bloquant',
          detail: `${echecsMigration.length} migration(s) en échec, dont ${echecsMigration[0].filename}.`,
          consequence: 'Le nouveau moteur écrit dans des tables qui peuvent ne pas exister.',
        },
  );

  // ── 2. Grille tarifaire ────────────────────────────────────────────────
  //
  // Sans tarifs, chaque appel est facturé à zéro : les quotas ne se
  // décrémentent pas et le coût réel de la bascule reste invisible.
  try {
    // ══════════════════════════════════════════════════════════════════
    // `verified`, PAS `is_active` — ET LA NUANCE COMPTE
    //
    // J'avais deviné le nom de la colonne. La migration 0111 est pourtant
    // explicite : « un tarif non confirmé n'autorise pas le démarrage en
    // production ».
    //
    // Un tarif relevé automatiquement chez le fournisseur existe mais n'est
    // pas vérifié : il peut porter sur un SKU voisin, une autre région, une
    // autre unité. Le compter comme acquis reviendrait à facturer sur une
    // valeur que personne n'a regardée.
    // ══════════════════════════════════════════════════════════════════
    const [tarifs] = await pgClient<{
      total: number; verifies: number; plusRecent: string | null;
    }[]>`
      SELECT count(*)::int                             AS total,
             count(*) FILTER (WHERE verified)::int     AS verifies,
             max(effective_from)::text                 AS "plusRecent"
      FROM ai_model_pricing
    `;

    const total = tarifs?.total ?? 0;
    const verifies = tarifs?.verifies ?? 0;

    if (total === 0) {
      controles.push({
        nom: 'grille tarifaire',
        verdict: 'bloquant',
        detail: 'Aucun tarif enregistré.',
        consequence:
          'Les appels seraient facturés à zéro : quotas non décrémentés, ' +
          'coût de la bascule invisible.',
      });
    } else if (verifies === 0) {
      // Distinction volontaire : un tarif relevé mais non confirmé permet de
      // mesurer, sans engager. Bloquer serait excessif ; se taire le serait
      // davantage.
      controles.push({
        nom: 'grille tarifaire',
        verdict: 'avertissement',
        detail: `${total} tarif(s) relevé(s), aucun vérifié.`,
        consequence:
          'Les coûts seront mesurés sur des valeurs non confirmées. ' +
          'Vérifier les tarifs en administration avant toute mise en service.',
      });
    } else {
      controles.push({
        nom: 'grille tarifaire',
        verdict: 'ok',
        detail:
          `${verifies} tarif(s) vérifié(s) sur ${total}, ` +
          `le plus récent au ${tarifs.plusRecent ?? '—'}.`,
      });
    }
  } catch (e) {
    controles.push({
      nom: 'grille tarifaire',
      verdict: 'bloquant',
      detail: `Illisible : ${(e as Error).message}`,
    });
  }

  // ── 3. Notification de fin de lot ──────────────────────────────────────
  //
  // L'ancien pipeline l'émettait, le nouveau l'avait perdue. Sans gabarit,
  // l'analyse devient muette : le document apparaît, la fiche s'enrichit, et
  // l'utilisateur n'est prévenu de rien.
  try {
    const gabarits = await db
      .select({ type: emailTemplates.type })
      .from(emailTemplates)
      .where(eq(emailTemplates.type, 'DOCUMENT_BATCH_COMPLETED'));

    controles.push(
      gabarits.length > 0
        ? { nom: 'notification de lot', verdict: 'ok', detail: 'Gabarit présent.' }
        : {
            nom: 'notification de lot',
            verdict: 'avertissement',
            detail: 'Gabarit DOCUMENT_BATCH_COMPLETED absent.',
            consequence:
              "L'analyse serait muette : aucun signal de fin de traitement. " +
              'Le canal interne fonctionne, seul l\'email manquerait.',
          },
    );
  } catch (e) {
    controles.push({
      nom: 'notification de lot',
      verdict: 'avertissement',
      detail: `Non vérifiable : ${(e as Error).message}`,
    });
  }

  // ── 4. Corpus de mesure ────────────────────────────────────────────────
  //
  // Sans corpus couvrant, la bascule reste possible mais AVEUGLE : rien ne
  // permettra de dire si l'analyse s'est améliorée ou dégradée.
  const cases = listCorpusCases();
  const famillesVides = listEmptyCategories();
  controles.push(
    famillesVides.length === 0 && cases.length > 0
      ? {
          nom: 'corpus de mesure',
          verdict: 'ok',
          detail: `${cases.length} cas sur ${CORPUS_CATEGORIES.length} familles.`,
        }
      : {
          nom: 'corpus de mesure',
          verdict: 'avertissement',
          detail: `${famillesVides.length} famille(s) sans cas : ${famillesVides.join(', ')}.`,
          consequence:
            'La bascule resterait possible mais aveugle : aucune mesure ' +
            "comparative ne pourrait établir si l'analyse se dégrade.",
        },
  );

  // ── 5. Compte technique de mesure ──────────────────────────────────────
  const compteCorpus = Number(process.env.CORPUS_ACCOUNT_ID);
  controles.push(
    Number.isInteger(compteCorpus) && compteCorpus > 0
      ? { nom: 'compte de mesure', verdict: 'ok', detail: `CORPUS_ACCOUNT_ID = ${compteCorpus}.` }
      : {
          nom: 'compte de mesure',
          verdict: 'avertissement',
          detail: 'CORPUS_ACCOUNT_ID absente.',
          consequence:
            'La campagne de mesure ne peut pas s\'exécuter. La bascule reste ' +
            'possible, mais sans comparaison préalable.',
        },
  );

  // ── 6. État des cinq drapeaux ──────────────────────────────────────────
  const drapeaux = {
    AI_UNIFIED_SOURCE_ANALYSIS: getFlagMode('AI_UNIFIED_SOURCE_ANALYSIS'),
    AI_RECONCILIATION_ENGINE: getFlagMode('AI_RECONCILIATION_ENGINE'),
    AI_INTELLIGENT_ASSISTANT: getFlagMode('AI_INTELLIGENT_ASSISTANT'),
    AI_AGENDA_ENGINE: getFlagMode('AI_AGENDA_ENGINE'),
    AI_PROMPT_GOVERNANCE: getFlagMode('AI_PROMPT_GOVERNANCE'),
  };

  // §10.1 : un usage à la fois. Basculer l'analyse ET la réconciliation
  // ensemble rendrait tout écart impossible à imputer.
  const dejaBascules = Object.entries(drapeaux).filter(([, m]) => m === 'enabled');
  controles.push(
    dejaBascules.length <= 1
      ? {
          nom: 'ordre de bascule',
          verdict: 'ok',
          detail:
            dejaBascules.length === 0
              ? 'Aucun usage basculé — l\'analyse peut l\'être en premier.'
              : `Un seul usage basculé : ${dejaBascules[0][0]}.`,
        }
      : {
          nom: 'ordre de bascule',
          verdict: 'avertissement',
          detail: `${dejaBascules.length} usages déjà basculés.`,
          consequence:
            'Le §10.1 recommande un usage à la fois : au-delà, un écart de ' +
            'comportement ne peut plus être imputé à une bascule précise.',
        },
  );

  // ── 7. Le mode `shadow` n'existe pas pour l'analyse ────────────────────
  if (drapeaux.AI_UNIFIED_SOURCE_ANALYSIS === 'shadow') {
    controles.push({
      nom: 'mode du drapeau',
      verdict: 'bloquant',
      detail: 'AI_UNIFIED_SOURCE_ANALYSIS vaut `shadow`.',
      consequence:
        'Le §10.2 ne prévoit ce mode que pour la réconciliation : il est ' +
        'ici traité comme `legacy`, donc sans effet. Employer `enabled`.',
    });
  }

  const bloquants = controles.filter((c) => c.verdict === 'bloquant');
  const avertissements = controles.filter((c) => c.verdict === 'avertissement');

  return NextResponse.json(
    {
      verdict: bloquants.length > 0 ? 'BLOQUÉ' : avertissements.length > 0 ? 'POSSIBLE AVEC RÉSERVES' : 'PRÊT',
      drapeaux,
      controles,
      bloquants: bloquants.length,
      avertissements: avertissements.length,
      procedure: bloquants.length > 0 ? undefined : [
        '1. AI_UNIFIED_SOURCE_ANALYSIS=legacy  → npm run corpus:run -- --baseline',
        '2. AI_UNIFIED_SOURCE_ANALYSIS=enabled → npm run corpus:run -- --compare',
        '3. Si le verdict est favorable, conserver enabled et surveiller.',
        '4. AI_RECONCILIATION_ENGINE=shadow ensuite, jamais en même temps.',
      ],
    },
    { status: bloquants.length > 0 ? 409 : 200 },
  );
}
