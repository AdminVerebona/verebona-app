/**
 * Circuit breaker et reprise — CDC BO IA MOD-007 à MOD-014, WF-09.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE COMPTEUR EST PAR MODÈLE, LE DISJONCTEUR PAR TRAITEMENT
 *
 * Deux granularités qu'il serait tentant de confondre, et que le CDC sépare
 * soigneusement.
 *
 * MOD-007 : « chaque modèle possède un compteur indépendant d'échecs
 * consécutifs ». MOD-010 : « les circuit breakers sont indépendants par
 * traitement ». Un même modèle sert plusieurs traitements — si son compteur
 * était porté par le traitement, une panne fournisseur remonterait cinq fois
 * et le premier succès n'en effacerait qu'un cinquième.
 *
 * MOD-009 impose la subtilité qui décide de tout : « un échec du principal
 * compte même si un fallback réussit ». Le compteur mesure la santé du MODÈLE,
 * pas l'issue de la demande. Une chaîne qui aboutit grâce au repli n'est pas un
 * échec de la demande — MOD-003 —, mais reste un échec du principal.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LES SONDES NE PORTENT AUCUNE DONNÉE UTILISATEUR
 *
 * MOD-013. Ce n'est pas une précaution de confidentialité seulement : une sonde
 * qui rejouerait une vraie demande consommerait le quota d'un compte pour un
 * test d'exploitation, et pourrait écrire à partir d'un modèle qu'on soupçonne
 * défaillant.
 */

export const FAILURE_ALERT_THRESHOLD = 10;

/** Compteurs d'échecs consécutifs, par modèle. */
export type ModelFailures = Record<string, number>;

/**
 * Enregistre l'issue d'un appel sur un modèle.
 *
 * Un succès remet SON compteur à zéro, et lui seul (MOD-008, MOD-014). Remettre
 * à zéro les autres au premier succès masquerait une panne partielle : le
 * fallback fonctionne, on croirait le principal rétabli.
 */
export function recordModelOutcome(
  failures: ModelFailures,
  model: string,
  succeeded: boolean,
): ModelFailures {
  const next = { ...failures };
  if (succeeded) delete next[model];
  else next[model] = (next[model] ?? 0) + 1;
  return next;
}

/** MOD-008 : dix échecs consécutifs déclenchent une alerte informationnelle. */
export function alertingModels(failures: ModelFailures): string[] {
  return Object.entries(failures)
    .filter(([, n]) => n >= FAILURE_ALERT_THRESHOLD)
    .map(([model]) => model)
    .sort();
}

/**
 * Le disjoncteur doit-il s'ouvrir ?
 *
 * Seul l'échec COMPLET de la chaîne l'ouvre : le WF-09 précise qu'un « fallback
 * réussi sur une demande empêche de considérer cette demande comme échec
 * complet ». Ouvrir sur un échec du principal suspendrait un traitement qui
 * fonctionne, simplement moins bien.
 */
export function shouldOpen(chainFailedCompletely: boolean): boolean {
  return chainFailedCompletely;
}

/**
 * Planning progressif des sondes (WF-09).
 *
 * Rapproché au début — une panne fournisseur dure souvent quelques minutes —
 * puis espacé, pour ne pas marteler un service durablement indisponible.
 * Plafonné, afin qu'un incident long ne repousse pas la reprise bien après le
 * retour à la normale.
 */
const PROBE_SCHEDULE_SECONDS = [30, 60, 120, 300, 600, 900] as const;

export function nextProbeDelay(probeAttempts: number): number {
  const i = Math.min(Math.max(probeAttempts, 0), PROBE_SCHEDULE_SECONDS.length - 1);
  return PROBE_SCHEDULE_SECONDS[i];
}

/**
 * Ordre des modèles à sonder : principal, puis repli 1, puis repli 2 (WF-09).
 *
 * Toujours dans cet ordre, même si le principal vient d'échouer : MOD-002 veut
 * que « chaque nouvelle exécution reparte du modèle principal ; le fallback
 * n'est pas sticky ». Sonder d'abord le repli qui marchait reviendrait à rendre
 * le repli collant par la porte de derrière.
 */
export function probeOrder(
  primary: string | null,
  fallback1: string | null,
  fallback2: string | null,
): string[] {
  return [primary, fallback1, fallback2].filter((m): m is string => Boolean(m));
}

export interface ProbeOutcome {
  /** Modèle qui a répondu, `null` si aucun. */
  recoveredWith: string | null;
  failures: ModelFailures;
  /** Le traitement peut-il être réactivé ? MOD-014 : au premier succès. */
  reactivate: boolean;
}

/**
 * Applique le résultat d'une campagne de sondes.
 *
 * `results` est l'issue de chaque modèle sondé, dans l'ordre. La campagne
 * s'arrête au premier succès — sonder les suivants ne changerait rien à la
 * décision et coûterait des appels sur un fournisseur qu'on vient de solliciter.
 */
export function applyProbeResults(
  failures: ModelFailures,
  results: Array<{ model: string; succeeded: boolean }>,
): ProbeOutcome {
  let next = failures;
  let recoveredWith: string | null = null;

  for (const r of results) {
    next = recordModelOutcome(next, r.model, r.succeeded);
    if (r.succeeded) { recoveredWith = r.model; break; }
  }

  return { recoveredWith, failures: next, reactivate: recoveredWith !== null };
}

/**
 * Réactivation forcée par un administrateur (WF-09, exceptions).
 *
 * « Reset circuit breaker, mais les alertes modèles persistent jusqu'au succès
 * de chacun. » Les compteurs sont donc conservés tels quels : un administrateur
 * peut décider de rouvrir le service, il ne peut pas décider qu'un modèle va
 * bien. Effacer les compteurs ferait disparaître l'alerte sans que rien n'ait
 * été vérifié.
 */
export function forceReactivation(failures: ModelFailures): ModelFailures {
  return { ...failures };
}
