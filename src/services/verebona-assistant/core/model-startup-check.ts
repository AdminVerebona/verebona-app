/**
 * Contrôle du registre de modèles — CDC §15.14 (et §15.11, §15.12).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * AU DÉMARRAGE ET À CHAQUE CHANGEMENT DE CONFIGURATION, PLUS AU 1er MESSAGE
 *
 * Le contrôle ne s'exécutait qu'au premier message, et ne vérifiait ni les
 * prix ni la compatibilité avec les sorties structurées. Il s'exécute
 * désormais :
 *   · au démarrage (`instrumentation-node.ts`) ;
 *   · à l'activation ou à la restauration d'une version de configuration du
 *     BO IA (`config-version.service`) ;
 * et vérifie, pour chaque opération modèle de l'assistant, sur la chaîne
 * EFFECTIVE (configuration versionnée, sinon code) :
 *   1. alias résolus (défaut, et escalade si le repli est actif) ;
 *   2. modèles autorisés : pas d'alias « latest » (lot 35B : plus aucune
 *      condition preview — ni flag VEREBONA_ASSISTANT_ALLOW_PREVIEW_MODELS,
 *      ni réglage « preview_models_allowed » ; un modèle absent du registre
 *      n'est plus « traité comme preview ») ;
 *   3. prix présents : SIGNALÉ seulement (lot 35B — un modèle sans tarif
 *      connu reste utilisable, coût non calculable ; jamais bloquant) ;
 *   4. compatibilité avec les sorties structurées (schéma JSON déclaré,
 *      modèle Gemini) ;
 *   5. défaut ≠ escalade sans décision explicite ;
 *   6. (lot 23, §15.12 ; lot 35B) cohérence avec les EXCEPTIONS du
 *      registre des modèles : interdit, exclusion documentée pour le prompt,
 *      rollback existant et stable ; déprécié et anomalie connue signalés.
 *
 * Le DERNIER REGISTRE VALIDE est conservé (alias → modèles, date) : en cas
 * d'échec, il est journalisé et joint à l'alerte, pour un rollback direct.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { AI_OPERATIONS, type AiOperationDefinition } from '@/services/ai/registry/operations';
import { ASSISTANT_OPERATIONS, assertConfigAtStartup } from '../config/assistant-config';
import { isAssistantFlagOn } from '../config/assistant-flags.server';
import { configuredAliases, MODEL_REGISTRY_VERSION, resolveAliases, type ResolvedAliases } from '../registries/model-registry';
import { checkModelUses } from '@/services/ai/registry/models';

export interface RegistrySnapshot {
  checkedAt: string;
  version: typeof MODEL_REGISTRY_VERSION;
  aliases: Record<string, string>;
  operations: ResolvedAliases[];
}

export interface RegistryCheck {
  ok: boolean;
  errors: string[];
  warnings: string[];
  snapshot: RegistrySnapshot;
}

export interface RegistryCheckDeps {
  operations?: Record<string, AiOperationDefinition | undefined>;
  resolve?: (op: string) => Promise<{ primaryModel: string; fallbackModels: string[] }>;
  hasPrice?: (provider: string, model: string) => boolean;
}

async function defaultHasPrice(): Promise<(provider: string, model: string) => boolean> {
  const { getCachedPrice } = await import('@/services/ai/gateway/cost-catalog');
  return (provider, model) => Boolean(getCachedPrice(provider, model));
}

/** Contrôle complet du registre (pur si les dépendances sont injectées). */
export async function checkModelRegistry(deps: RegistryCheckDeps = {}): Promise<RegistryCheck> {
  const operations = deps.operations ?? AI_OPERATIONS;
  const hasPrice = deps.hasPrice ?? await defaultHasPrice();
  const errors: string[] = [];
  const warnings: string[] = [];
  const resolved: ResolvedAliases[] = [];
  const escaladeActive = isAssistantFlagOn('fallback_model');

  for (const code of ASSISTANT_OPERATIONS) {
    const op = operations[code];
    if (!op) { errors.push(`Opération « ${code} » absente du référentiel`); continue; }
    const r = await resolveAliases(code, deps.resolve);
    resolved.push(r);

    // 1. Alias résolus.
    if (!r.default) errors.push(`${code} : alias par défaut non résolu`);
    if (escaladeActive && !r.escalation) warnings.push(`${code} : alias d'escalade non résolu (aucune escalade possible)`);

    const modeles = [r.default, r.escalation].filter((m): m is string => Boolean(m));
    for (const m of modeles) {
      // 2. Modèles autorisés.
      if (/latest/i.test(m)) errors.push(`${code} : alias fournisseur « latest » interdit (${m}) (§15.13)`);
      // 3. Prix : signalé, jamais bloquant (lot 35B — coût non calculable).
      if (!hasPrice(op.provider, m)) {
        warnings.push(`${code} : aucun prix connu pour ${op.provider}/${m} — coûts non calculables (§15.14)`);
      }
      // 4. Sorties structurées.
      if (!/^gemini-/i.test(m)) errors.push(`${code} : modèle ${m} sans sortie structurée connue (§15.14)`);
    }
    if (!op.outputSchema || op.outputSchema === 'none' || op.outputFormat === 'text') {
      errors.push(`${code} : aucun schéma de sortie structurée déclaré (§18.1)`);
    }
    // 6. Exceptions du registre : interdit, exclusion documentée, rollback.
    for (const issue of checkModelUses(modeles.map((m) => ({ where: code, model: m, promptCode: op.masterPromptCode ?? op.promptCode ?? null })))) {
      (issue.level === 'error' ? errors : warnings).push(`${issue.message} (§15.12)`);
    }
    // 5. Défaut et escalade identiques.
    if (r.default && r.default === r.escalation && process.env.VEREBONA_ASSISTANT_ALLOW_SAME_MODEL !== 'true') {
      errors.push(`${code} : modèle d'escalade identique au modèle par défaut (§15.14)`);
    }
  }

  const aliases = configuredAliases();
  const principal = resolved.find((x) => x.operationCode === 't2_answer');
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    snapshot: {
      checkedAt: new Date().toISOString(),
      version: MODEL_REGISTRY_VERSION,
      aliases: {
        [aliases.default]: principal?.default ?? '',
        [aliases.escalation]: principal?.escalation ?? '',
      },
      operations: resolved,
    },
  };
}

// ── Verdict du processus et dernier registre valide ──────────────────────

export type StartupVerdict = { ok: true } | { ok: false; error: string };

let verdict: StartupVerdict | null = null;
let dernierValide: RegistrySnapshot | null = null;

/** Dernier registre valide (rollback, §15.14). */
export function lastValidRegistry(): RegistrySnapshot | null {
  return dernierValide;
}

export function currentStartupVerdict(): StartupVerdict | null {
  return verdict;
}

/**
 * Contrôle complet (limites V1 + registre) : au démarrage et à chaque
 * changement de configuration. Ne lève jamais ; un échec est journalisé,
 * signalé au BO IA (alerte) et rend l'assistant indisponible (503) plutôt
 * que de le laisser tourner hors des règles.
 */
export async function runAssistantStartupCheck(
  trigger: 'startup' | 'config_change' | 'first_message',
  deps: RegistryCheckDeps & { raiseAlert?: (a: import('@/services/ai/alerts/alerts.repository').AlertInput) => Promise<boolean> } = {},
): Promise<RegistryCheck> {
  const erreursStatiques: string[] = [];
  try {
    assertConfigAtStartup(undefined, deps.operations ?? AI_OPERATIONS);
  } catch (e) {
    erreursStatiques.push((e as Error).message);
  }
  const check = await checkModelRegistry(deps).catch((e): RegistryCheck => ({
    ok: false, errors: [`contrôle impossible : ${(e as Error).message}`], warnings: [],
    snapshot: { checkedAt: new Date().toISOString(), version: MODEL_REGISTRY_VERSION, aliases: {}, operations: [] },
  }));
  check.errors.unshift(...erreursStatiques);
  check.ok = check.errors.length === 0;

  for (const w of check.warnings) console.warn(`[verebona-assistant] registre de modèles (${trigger}) : ${w}`);
  if (check.ok) {
    dernierValide = check.snapshot;
    verdict = { ok: true };
    return check;
  }
  verdict = { ok: false, error: check.errors.join(' | ') };
  console.error(
    `[verebona-assistant] CONTRÔLE DU REGISTRE EN ÉCHEC (§15.14, ${trigger}) :\n - ${check.errors.join('\n - ')}\n`
    + `Dernier registre valide : ${dernierValide ? JSON.stringify(dernierValide.aliases) : 'aucun'}`,
  );
  const alerter = deps.raiseAlert ?? (async (a) => (await import('@/services/ai/alerts/alerts.repository')).raiseAlert(a));
  await alerter({
    kind: 'anomaly',
    code: 'assistant_model_registry_invalid',
    treatment: 'T2',
    severity: 'critical',
    message: `Assistant : registre de modèles invalide (${trigger}) — ${check.errors[0] ?? 'erreur'}`,
    details: { errors: check.errors, lastValid: dernierValide },
    drilldownHref: '/admin/ai-config',
    dedupeKey: `assistant:model_registry:${check.snapshot.checkedAt.slice(0, 13)}:${trigger}`,
  }).catch(() => false);
  return check;
}

/** Réservé aux tests. */
export function resetModelStartupForTests(): void {
  verdict = null;
  dernierValide = null;
}
