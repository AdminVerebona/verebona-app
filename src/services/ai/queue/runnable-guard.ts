/**
 * Garde d'exécution IA — CDC BO IA OPS-011, OPS-008, OPS-024, WF-07, WF-08,
 * MOD-012, T5-015.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN SEUL POINT DE CONTRÔLE, SUR LE CHEMIN DE TOUS LES APPELS
 *
 * Jusqu'ici, l'arrêt d'urgence et l'état d'un traitement n'étaient lus que par
 * `claimNext()` (file durable), T5 et T6. T2, T3, T4 et T1 en file mémoire
 * appelaient la gateway sans rien vérifier : le bouton « Désactiver T3 » était
 * sans effet. La garde est donc placée en tête d'`AiGateway.execute` — le
 * passage obligé de tout appel modèle (§5.2) — et non chez chaque appelant,
 * où elle finirait par manquer quelque part.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CACHE DE CINQ SECONDES
 *
 * La garde est sur le chemin chaud : deux lectures en base par appel modèle
 * ralentiraient tout, pour une information qui change quelques fois par an.
 * Cinq secondes bornent le délai de prise d'effet d'un arrêt d'urgence sur
 * les AUTRES instances ; sur l'instance qui reçoit la commande, le cache est
 * vidé immédiatement (`invalidateRuntimeGuardCache`).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * BASE ILLISIBLE : ON LAISSE PASSER (fail-open), AVEC LE DERNIER ÉTAT CONNU
 *
 * Même doctrine que `config-resolver` : une console d'administration ne doit
 * pas pouvoir casser le produit qu'elle administre. Si la lecture échoue, la
 * dernière photographie connue est conservée ; à défaut, l'appel passe. Un
 * arrêt d'urgence déjà lu reste donc appliqué pendant une panne de base ; seul
 * un démarrage à froid sans base laisse passer — et dans ce cas, rien d'autre
 * ne fonctionne de toute façon.
 */
import { pgClient } from '@/db';
import { AiGatewayError } from '../gateway/errors';
import type { Treatment } from '../config/treatments';

export type RuntimeTreatmentState = 'ENABLED' | 'DISABLED' | 'SUSPENDED';

export interface RuntimeSnapshot {
  emergencyStop: boolean;
  /** Absence de ligne = jamais configuré = activé (même règle que `canStart`). */
  states: Partial<Record<Treatment, RuntimeTreatmentState>>;
}

const CACHE_TTL_MS = 5_000;
const LOOKUP_TIMEOUT_MS = 1_500;

const OPEN: RuntimeSnapshot = { emergencyStop: false, states: {} };

type Loader = () => Promise<RuntimeSnapshot>;

let cache: { expiresAt: number; snapshot: RuntimeSnapshot } | null = null;
let lastKnown: RuntimeSnapshot | null = null;
let injectedLoader: Loader | null = null;

async function loadFromDatabase(): Promise<RuntimeSnapshot> {
  const [stop, states] = await Promise.all([
    pgClient.unsafe(`SELECT active FROM ai_emergency_stop WHERE id = TRUE LIMIT 1`, [] as never[]),
    pgClient.unsafe(`SELECT treatment, state FROM ai_treatment_state`, [] as never[]),
  ]);
  const snapshot: RuntimeSnapshot = {
    emergencyStop: Boolean((stop as unknown as Array<Record<string, unknown>>)[0]?.active),
    states: {},
  };
  for (const r of states as unknown as Array<Record<string, unknown>>) {
    snapshot.states[String(r.treatment) as Treatment] = String(r.state) as RuntimeTreatmentState;
  }
  return snapshot;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      const t = setTimeout(() => reject(new Error('délai de lecture dépassé')), ms);
      t.unref?.();
    }),
  ]);
}

/**
 * Remplace la source de l'état runtime — réservé aux tests.
 *
 * En test, sans source injectée, la garde laisse tout passer sans ouvrir de
 * connexion : aucun test unitaire ne doit toucher la base (src/test/setup.ts).
 */
export function setRuntimeSnapshotLoader(loader: Loader | null): void {
  injectedLoader = loader;
  invalidateRuntimeGuardCache();
}

/** Vidé à chaque commande d'exploitation, pour une prise d'effet immédiate ici. */
export function invalidateRuntimeGuardCache(): void {
  cache = null;
}

export async function getRuntimeSnapshot(): Promise<RuntimeSnapshot> {
  if (cache && cache.expiresAt > Date.now()) return cache.snapshot;

  const loader: Loader | null = injectedLoader
    ?? (process.env.NODE_ENV === 'test' ? null : loadFromDatabase);
  if (!loader) return OPEN;

  try {
    const snapshot = await withTimeout(loader(), LOOKUP_TIMEOUT_MS);
    lastKnown = snapshot;
    cache = { expiresAt: Date.now() + CACHE_TTL_MS, snapshot };
    return snapshot;
  } catch (e) {
    // Fail-open documenté en tête de module. Le dernier état connu est
    // réutilisé pour une courte durée, puis relu.
    console.warn('[ai-guard] état runtime illisible (dernier état connu conservé) :', (e as Error).message);
    const snapshot = lastKnown ?? OPEN;
    cache = { expiresAt: Date.now() + CACHE_TTL_MS, snapshot };
    return snapshot;
  }
}

/**
 * Motif de blocage d'un traitement, ou `null` s'il peut appeler l'IA.
 *
 * Fonction pure : l'arrêt d'urgence prime (§4.3) ; il ne modifie aucun état
 * local, il se superpose.
 */
export function blockReason(snapshot: RuntimeSnapshot, treatment: Treatment): string | null {
  if (snapshot.emergencyStop) return 'arrêt d\'urgence engagé';
  const state = snapshot.states[treatment];
  if (state === 'DISABLED') return `traitement ${treatment} désactivé`;
  if (state === 'SUSPENDED') return `traitement ${treatment} suspendu (circuit breaker)`;
  return null;
}

/**
 * Lève `AI_BLOCKED` (non récupérable) si le traitement ne peut pas appeler l'IA.
 *
 * Non récupérable : la boucle de repli de la gateway s'arrête net, et les
 * appelants retombent sur leur chemin sans IA (T2 déterministe — MOD-012,
 * WF-08 étape 47 ; T6 message déterministe ; T1/T3/T4 échec propre de
 * l'exécution, reprise plus tard).
 */
export async function assertTreatmentRunnable(
  treatment: Treatment,
  operationCode = 'n/a',
): Promise<void> {
  const reason = blockReason(await getRuntimeSnapshot(), treatment);
  if (reason) {
    throw new AiGatewayError(
      'AI_BLOCKED', operationCode,
      `Appel IA refusé : ${reason} (CDC BO IA OPS-011 / WF-07 / WF-08).`,
      { recoverable: false },
    );
  }
}

/** Variante booléenne, pour les points d'entrée qui veulent éviter de lancer du travail. */
export async function isTreatmentRunnable(treatment: Treatment): Promise<boolean> {
  return blockReason(await getRuntimeSnapshot(), treatment) === null;
}
