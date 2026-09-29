/**
 * Drapeaux et commutateurs effectifs — CDC 15 décision D-01, HC-01.
 *
 * Le PO ne connaît pas les valeurs réellement déployées des drapeaux `AI_*`
 * en préproduction et en production. Chaque environnement étant un
 * déploiement distinct, la seule source fiable est le processus lui-même :
 * cette fonction lit ses variables et rend, pour chacune, la valeur brute et
 * l'interprétation RÉELLEMENT appliquée par le code (une faute de frappe vaut
 * `legacy`, et c'est précisément ce qu'il faut voir).
 *
 * Lecture seule, aucun secret : uniquement des variables de bascule.
 */
import { AI_FLAGS, parseFlagMode, type AiFlag, type FlagMode } from './ai-feature-flags';
import { USE_CASE_FLAGS } from './use-case-flags';
import { parseEnvironment, type AiEnvironment } from '../config/environment';
import { rolloutSnapshot, type RolloutSnapshotEntry } from '@/services/canonical/rollout';

type Env = Record<string, string | undefined>;

export interface FlagSnapshotEntry {
  name: string;
  /** Valeur brute lue (`null` : absente, défaut du code). */
  raw: string | null;
  /** Interprétation appliquée par le code. */
  mode: FlagMode;
  /** Valeur présente mais non reconnue : lue `legacy`. */
  invalid: boolean;
  description: string;
}

export interface FlagsSnapshot {
  environment: {
    /** `NEXT_PUBLIC_APP_ENV` brut. */
    appEnv: string | null;
    /** Environnement IA déduit (`null` : illisible, démarrage refusé hors test). */
    aiEnvironment: AiEnvironment | null;
  };
  /** Un drapeau par usage IA (`AI_FLAGS`). */
  aiFlags: FlagSnapshotEntry[];
  /** Bascules techniques hors `AI_FLAGS` (file durable T1). */
  technical: FlagSnapshotEntry[];
  /** Commutateurs de déploiement du CDC 15 (`canonical/rollout.ts`). */
  rollout: RolloutSnapshotEntry[];
  generatedAt: string;
}

const RECONNUES = new Set(['legacy', 'shadow', 'enabled', 'true', '1']);

/** Libellé de l'usage piloté par chaque drapeau. */
function flagDescription(flag: AiFlag): string {
  const usage = (Object.entries(USE_CASE_FLAGS) as Array<[string, AiFlag]>).find(([, f]) => f === flag)?.[0];
  const sansObservation = flag === 'AI_INTELLIGENT_ASSISTANT' || flag === 'AI_HOME_MASCOT';
  return `Usage ${usage ?? '—'}${sansObservation ? ' — sans mode observation (shadow refusé au démarrage)' : ''}.`;
}

function entry(name: string, raw: string | undefined, description: string): FlagSnapshotEntry {
  const present = raw !== undefined && raw !== '';
  return {
    name,
    raw: present ? raw! : null,
    mode: parseFlagMode(raw),
    invalid: present && !RECONNUES.has(raw!.toLowerCase()),
    description,
  };
}

/** Instantané des drapeaux et commutateurs de CE processus (pur, testable). */
export function buildFlagsSnapshot(env: Env = process.env, now: Date = new Date()): FlagsSnapshot {
  const durable = entry(
    'AI_DURABLE_QUEUE', env.AI_DURABLE_QUEUE,
    'File durable T1 (ai_job_queue) au lieu de la file en mémoire. Pas de mode observation.',
  );
  // `isDurableQueueEnabled` ne connaît que enabled/true/1 : `shadow` y vaut legacy.
  if (durable.mode === 'shadow') durable.mode = 'legacy';

  return {
    environment: {
      appEnv: env.NEXT_PUBLIC_APP_ENV ?? null,
      aiEnvironment: parseEnvironment(env.NEXT_PUBLIC_APP_ENV),
    },
    aiFlags: AI_FLAGS.map((f) => entry(f, env[f], flagDescription(f))),
    technical: [durable],
    rollout: rolloutSnapshot(env),
    generatedAt: now.toISOString(),
  };
}
