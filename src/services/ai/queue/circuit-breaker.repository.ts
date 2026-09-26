/**
 * Circuit breaker branché au runtime — CDC BO IA MOD-007 à MOD-014,
 * OPS-019 à OPS-026, WF-09.
 *
 * `circuit-breaker.ts` porte les règles (fonctions pures, testées) ; ce module
 * les applique à `ai_treatment_state`. Trois points d'entrée :
 *
 *   · `noteGatewayOutcome` — appelé par la gateway après CHAQUE appel : issue
 *     de chaque modèle sollicité (MOD-007, MOD-009) et issue de la chaîne ;
 *   · `suspendTreatment` — ouverture du disjoncteur au seuil d'échecs complets ;
 *   · `runDueProbes` — sondes du boucleur de file, réactivation au premier
 *     succès (MOD-013, MOD-014).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * MOD-011 : LA SUSPENSION N'INTERROMPT RIEN
 *
 * `setTreatmentState('SUSPENDED')` remet les exécutions en cours en file — ce
 * qui est juste pour une désactivation manuelle (WF-07) et faux pour le
 * disjoncteur : « les exécutions déjà en cours terminent ; seules les
 * nouvelles ne démarrent plus ». `suspendTreatment` écrit donc l'état SANS
 * aucun appel de remise en file. Un test vérifie cette absence.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LA TÉLÉMÉTRIE DU DISJONCTEUR NE PÉNALISE JAMAIS UN APPEL
 *
 * L'enregistrement est lancé sans être attendu (`void`), et ses erreurs sont
 * avalées : une base lente ne doit ni ralentir ni faire échouer une réponse
 * IA déjà obtenue. Le prix est une précision « au mieux » des compteurs, ce
 * qui suffit pour une alerte à dix échecs et un seuil de suspension.
 */
import { pgClient } from '@/db';
import type { Treatment } from '../config/treatments';
import {
  alertingModels, applyProbeResults, nextProbeDelay, probeOrder, reopenPlan,
  type ModelFailures,
} from './circuit-breaker';
import { invalidateRuntimeGuardCache } from './runnable-guard';

type Row = Record<string, unknown>;

/**
 * Échecs COMPLETS consécutifs d'un traitement avant ouverture du disjoncteur.
 *
 * OPS-022 laisse ce critère « code-defined ». Cinq, parce qu'un échec complet
 * est déjà la défaillance de toute la chaîne (principal + replis, souvent
 * trois modèles, donc jusqu'à quinze appels en échec) : un seul peut être un
 * incident fugace — délai réseau, document pathologique —, cinq d'affilée sans
 * aucun succès intercalé signalent une indisponibilité. Plus bas, un lot de
 * quelques documents illisibles suspendrait T1 ; plus haut, T2 afficherait de
 * longues secondes d'attente inutiles à chaque utilisateur avant la coupure.
 * Distinct du seuil d'ALERTE par modèle (dix, MOD-008), qui n'arrête rien.
 */
export const CHAIN_FAILURE_SUSPEND_THRESHOLD = 5;

/** Prompt de sonde : aucune donnée utilisateur (MOD-013), réponse minuscule. */
export const PROBE_PROMPT = 'Réponds exactement : OK';
const PROBE_TIMEOUT_MS = 20_000;

export interface ModelAttempt {
  model: string;
  succeeded: boolean;
}

// ── Enregistrement des issues ───────────────────────────────────────────────

/**
 * Applique en base la règle de `recordModelOutcome` pour une tentative.
 *
 * Mêmes effets que la fonction pure (succès : SON compteur supprimé ; échec :
 * +1), mais en une instruction atomique — lire le jsonb puis le réécrire
 * perdrait des incréments entre deux appels concurrents du même traitement.
 * Le succès ne crée pas de ligne : il n'y a rien à effacer sur un traitement
 * qui n'a jamais échoué.
 */
export async function recordModelAttempt(
  treatment: Treatment, model: string, succeeded: boolean,
): Promise<void> {
  if (succeeded) {
    await pgClient.unsafe(
      `UPDATE ai_treatment_state
          SET model_failures = model_failures - $2::text
        WHERE treatment = $1 AND model_failures ? $2::text`,
      [treatment, model] as never[],
    );
    return;
  }
  await pgClient.unsafe(
    `INSERT INTO ai_treatment_state (treatment, model_failures)
     VALUES ($1, jsonb_build_object($2::text, 1))
     ON CONFLICT (treatment) DO UPDATE SET
       model_failures = ai_treatment_state.model_failures || jsonb_build_object(
         $2::text, COALESCE((ai_treatment_state.model_failures ->> $2::text)::int, 0) + 1
       )`,
    [treatment, model] as never[],
  );
}

/**
 * Issue de la chaîne complète. Rend `true` si le disjoncteur vient de s'ouvrir.
 *
 * OPS-022 : seul un échec COMPLET compte — un repli réussi remet le compteur
 * à zéro, puisqu'il interrompt la série d'échecs complets consécutifs.
 */
export async function recordChainOutcome(
  treatment: Treatment, succeeded: boolean,
): Promise<boolean> {
  if (succeeded) {
    await pgClient.unsafe(
      `UPDATE ai_treatment_state SET consecutive_chain_failures = 0
        WHERE treatment = $1 AND consecutive_chain_failures > 0`,
      [treatment] as never[],
    );
    return false;
  }
  const rows = await pgClient.unsafe(
    `INSERT INTO ai_treatment_state (treatment, consecutive_chain_failures)
     VALUES ($1, 1)
     ON CONFLICT (treatment) DO UPDATE SET
       consecutive_chain_failures = ai_treatment_state.consecutive_chain_failures + 1
     RETURNING consecutive_chain_failures, state`,
    [treatment] as never[],
  );
  const r = (rows as unknown as Row[])[0];
  const count = Number(r?.consecutive_chain_failures ?? 0);
  if (count < CHAIN_FAILURE_SUSPEND_THRESHOLD || r?.state !== 'ENABLED') return false;
  return suspendTreatment(
    treatment,
    `${count} échecs complets consécutifs de la chaîne de modèles (seuil ${CHAIN_FAILURE_SUSPEND_THRESHOLD})`,
  );
}

/**
 * Ouvre le disjoncteur d'un traitement (WF-09 étape 50).
 *
 * Conditionné à l'état ENABLED : une suspension automatique ne doit jamais
 * écraser une désactivation manuelle — à la réactivation automatique, le
 * traitement serait rallumé contre la décision d'un administrateur.
 *
 * AUCUNE remise en file (MOD-011, OPS-023) : les exécutions déjà en cours
 * terminent. La prochaine sonde est planifiée selon `nextProbeDelay(0)`.
 */
export async function suspendTreatment(treatment: Treatment, reason: string): Promise<boolean> {
  // Anti-oscillation (migration 0178, `reopenPlan`) : une réouverture peu
  // après une réactivation par sonde allonge le délai de la première sonde.
  // Lecture tolérante : avant la migration 0178, plan « ouverture fraîche ».
  let plan = reopenPlan(null, 0);
  try {
    const cur = (await pgClient.unsafe(
      `SELECT breaker_last_reactivated_at, breaker_reopen_count
         FROM ai_treatment_state WHERE treatment = $1`,
      [treatment] as never[],
    )) as unknown as Row[];
    const r = cur[0];
    plan = reopenPlan(
      r?.breaker_last_reactivated_at ? new Date(String(r.breaker_last_reactivated_at)) : null,
      Number(r?.breaker_reopen_count ?? 0),
    );
  } catch { /* colonnes absentes : plan par défaut */ }

  const rows = await pgClient.unsafe(
    `UPDATE ai_treatment_state
        SET state = 'SUSPENDED', suspended_reason = $2, suspended_at = NOW(),
            suspended_by_breaker = TRUE, probe_attempts = $4::int,
            next_probe_at = NOW() + make_interval(secs => $3::int),
            updated_by = NULL, updated_at = NOW()
      WHERE treatment = $1 AND state = 'ENABLED'
      RETURNING treatment`,
    [treatment, reason, plan.delaySeconds, plan.probeAttempts] as never[],
  );
  const opened = (rows as unknown as Row[]).length > 0;
  if (opened) {
    await pgClient.unsafe(
      `UPDATE ai_treatment_state SET breaker_reopen_count = $2::int WHERE treatment = $1`,
      [treatment, plan.reopens] as never[],
    ).catch(() => { /* avant 0178 : sans compteur */ });
    invalidateRuntimeGuardCache();
    console.error(
      `[circuit-breaker] ${treatment} SUSPENDU — ${reason}`
      + `${plan.reopens > 0 ? ` (réouverture n° ${plan.reopens} peu après une réactivation : première sonde dans ${plan.delaySeconds} s)` : ''}.`,
    );
  }
  return opened;
}

// ── Point d'entrée de la gateway ────────────────────────────────────────────

export interface GatewayOutcome {
  treatment: Treatment;
  attempts: ModelAttempt[];
  /**
   * `true` : un modèle a répondu ; `false` : ALL_MODELS_FAILED ; `null` : la
   * chaîne a été interrompue par une erreur non récupérable (configuration,
   * blocage) — ni succès ni échec de disponibilité, le compteur n'est pas touché.
   */
  chainSucceeded: boolean | null;
}

type OutcomeRecorder = (o: GatewayOutcome) => Promise<void>;

async function recordGatewayOutcome(o: GatewayOutcome): Promise<void> {
  for (const a of o.attempts) {
    await recordModelAttempt(o.treatment, a.model, a.succeeded);
  }
  if (o.chainSucceeded !== null) await recordChainOutcome(o.treatment, o.chainSucceeded);
}

let injectedRecorder: OutcomeRecorder | null = null;

/** Remplace l'enregistreur — réservé aux tests (aucune base en test unitaire). */
export function setGatewayOutcomeRecorder(recorder: OutcomeRecorder | null): void {
  injectedRecorder = recorder;
}

/** Lancé sans attente par la gateway : ne ralentit ni ne fait échouer l'appel. */
export function noteGatewayOutcome(o: GatewayOutcome): void {
  const recorder = injectedRecorder
    ?? (process.env.NODE_ENV === 'test' ? null : recordGatewayOutcome);
  if (!recorder || o.attempts.length === 0) return;
  void recorder(o).catch((e) => {
    console.warn('[circuit-breaker] enregistrement impossible (non bloquant) :', (e as Error).message);
  });
}

// ── Sondes (WF-09 étapes 54 à 57) ───────────────────────────────────────────

export type ProbeFn = (model: string) => Promise<boolean>;

/**
 * Sonde par défaut : un appel minimal, sans donnée utilisateur, via le port
 * fournisseur (la gateway n'est pas utilisée : sa garde refuserait justement
 * l'appel d'un traitement suspendu, et une sonde n'appartient à aucun compte).
 *
 * OPS-026 : la sonde n'est rattachée à aucun compte, elle n'est donc PAS
 * écrite dans `ai_usage_event` (compte obligatoire) et n'entre jamais dans le
 * coût métier ; elle est journalisée en log technique.
 */
async function defaultProbe(model: string): Promise<boolean> {
  const { getAiProvider } = await import('../gateway/providers');
  const provider = getAiProvider();
  try {
    const out = await provider.call({
      model, prompt: PROBE_PROMPT, attachments: [],
      timeoutMs: PROBE_TIMEOUT_MS, maxOutputTokens: 16,
    });
    return out.rawText.trim().length > 0;
  } catch (e) {
    console.warn(`[circuit-breaker] sonde ${model} en échec :`, (e as Error).message);
    return false;
  }
}

/** Modèles à sonder pour un traitement : configuration effective, sinon le code. */
async function modelsForTreatment(treatment: Treatment): Promise<string[]> {
  const [{ getTreatment }, { listOperationsByUseCase }, { resolveOperationConfig }] = await Promise.all([
    import('../config/treatments'),
    import('../registry/operations'),
    import('../config/config-resolver'),
  ]);
  const op = listOperationsByUseCase(getTreatment(treatment).useCaseCode)
    .find((o) => o.provider !== 'none' && o.active);
  if (!op) return [];
  const c = await resolveOperationConfig(op.operationCode);
  return probeOrder(c.primaryModel, c.fallbackModels[0] ?? null, c.fallbackModels[1] ?? null);
}

export interface ProbeReport {
  treatment: Treatment;
  reactivated: boolean;
  recoveredWith: string | null;
}

/**
 * Sonde les traitements suspendus par le disjoncteur dont l'échéance est
 * passée. Appelé à chaque tour du boucleur de file.
 *
 * Principal, puis repli 1, puis repli 2 (MOD-002 : jamais le repli d'abord) ;
 * arrêt au premier succès, qui réactive (MOD-014) et n'efface que le compteur
 * du modèle qui a répondu (`applyProbeResults`). Sinon, la prochaine sonde
 * est repoussée selon le planning progressif — jusqu'à recovery (MOD-013).
 *
 * Les écritures sont conditionnées à `state = 'SUSPENDED' AND
 * suspended_by_breaker` : si un administrateur a désactivé ou réactivé le
 * traitement pendant la sonde, sa décision l'emporte.
 */
export async function runDueProbes(probe: ProbeFn = defaultProbe): Promise<ProbeReport[]> {
  const rows = await pgClient.unsafe(
    `SELECT treatment, model_failures, probe_attempts
       FROM ai_treatment_state
      WHERE state = 'SUSPENDED' AND suspended_by_breaker = TRUE
        AND next_probe_at IS NOT NULL AND next_probe_at <= NOW()`,
    [] as never[],
  );

  const reports: ProbeReport[] = [];
  for (const r of rows as unknown as Row[]) {
    const treatment = String(r.treatment) as Treatment;
    const failures = (r.model_failures ?? {}) as ModelFailures;
    const attempts = Number(r.probe_attempts ?? 0);

    const results: ModelAttempt[] = [];
    for (const model of await modelsForTreatment(treatment)) {
      const succeeded = await probe(model);
      results.push({ model, succeeded });
      if (succeeded) break;
    }
    const outcome = applyProbeResults(failures, results);

    if (outcome.reactivate) {
      await pgClient.unsafe(
        `UPDATE ai_treatment_state
            SET state = 'ENABLED', suspended_reason = NULL, suspended_at = NULL,
                suspended_by_breaker = FALSE, next_probe_at = NULL, probe_attempts = 0,
                consecutive_chain_failures = 0, model_failures = $2::jsonb,
                updated_by = NULL, updated_at = NOW()
          WHERE treatment = $1 AND state = 'SUSPENDED' AND suspended_by_breaker = TRUE`,
        [treatment, JSON.stringify(outcome.failures)] as never[],
      );
      // Horodatage de la réactivation : une réouverture dans l'heure sera
      // comptée comme oscillation (`reopenPlan`). Tolérant avant 0178.
      await pgClient.unsafe(
        `UPDATE ai_treatment_state SET breaker_last_reactivated_at = NOW() WHERE treatment = $1`,
        [treatment] as never[],
      ).catch(() => {});
      invalidateRuntimeGuardCache();
      console.info(`[circuit-breaker] ${treatment} réactivé par sonde (${outcome.recoveredWith}).`);
    } else {
      await pgClient.unsafe(
        `UPDATE ai_treatment_state
            SET probe_attempts = probe_attempts + 1, model_failures = $2::jsonb,
                next_probe_at = NOW() + make_interval(secs => $3::int), updated_at = NOW()
          WHERE treatment = $1 AND state = 'SUSPENDED' AND suspended_by_breaker = TRUE`,
        [treatment, JSON.stringify(outcome.failures), nextProbeDelay(attempts + 1)] as never[],
      );
    }
    reports.push({ treatment, reactivated: outcome.reactivate, recoveredWith: outcome.recoveredWith });
  }
  return reports;
}

// ── Supervision (MOD-008, OPS-019) ──────────────────────────────────────────

export interface ModelAlert {
  treatment: Treatment;
  model: string;
  consecutiveFailures: number;
}

/** Modèles ayant atteint le seuil d'alerte, par traitement (MOD-010 : indépendants). */
export async function getModelAlerts(): Promise<ModelAlert[]> {
  const rows = await pgClient.unsafe(
    `SELECT treatment, model_failures FROM ai_treatment_state ORDER BY treatment`,
    [] as never[],
  );
  const alerts: ModelAlert[] = [];
  for (const r of rows as unknown as Row[]) {
    const failures = (r.model_failures ?? {}) as ModelFailures;
    for (const model of alertingModels(failures)) {
      alerts.push({
        treatment: String(r.treatment) as Treatment,
        model,
        consecutiveFailures: Number(failures[model]),
      });
    }
  }
  return alerts;
}
