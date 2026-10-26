/**
 * Test de connexion fournisseur — CDC BO IA SCR-10, WF-21.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * TROIS VÉRIFICATIONS, PAS UNE
 *
 * Le WF-21 demande de vérifier « credential, API, modèles accessibles,
 * compatibilité et génération minimale ». Ce n'est pas du zèle : les trois
 * échouent séparément, et confondre leurs causes fait chercher au mauvais
 * endroit.
 *
 *   · authentification — la clé est-elle reconnue ;
 *   · catalogue — le compte voit-il des modèles ;
 *   · génération — un appel minimal aboutit-il vraiment.
 *
 * Le 18 septembre, la clé était valide, l'API répondait, et la génération
 * échouait : `gemini-2.5-flash-lite` avait cessé d'être servi aux comptes
 * récents. Un test qui se serait arrêté à l'authentification aurait conclu que
 * tout allait bien.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * AUCUNE DONNÉE UTILISATEUR, ET UN COÛT TECHNIQUE
 *
 * Le prompt du test est une constante sans rapport avec le moindre compte. Le
 * SCR-10 veut que « le test soit loggé et son coût classé technique » : il est
 * donc tracé comme non facturable, au même titre que les sondes du MOD-013.
 */
import { recordCallTrace } from '../telemetry/ai-trace.service';
import type { TestDetail } from './credential.repository';
import { calcCostMicros } from '../gateway/cost-catalog';
import { buildGenerationConfig } from '../gateway/providers/gemini-generation-config';
import {
  PROBE_MAX_OUTPUT_TOKENS, PROBE_PROMPT, PROBE_REASONING, PROBE_TIMEOUT_MS,
  classifyProbeFailure, classifyProbeResponse, sanitizeProviderError, type ProbeOutcome,
} from './probe-classification';

/**
 * Corps de la génération minimale du test (lot 49, ticket 11) : mêmes
 * paramètres que la sonde — raisonnement `minimal` explicite, plafond 512.
 */
export function providerTestGenerationBody(model: string): Record<string, unknown> {
  // Lot 85C : constructeur unique (capacités du modèle) ; niveau refusé
  // d'avance pour ce modèle → même épreuve sans réglage de raisonnement.
  let built: Record<string, unknown>;
  try {
    built = buildGenerationConfig({ model, maxOutputTokens: PROBE_MAX_OUTPUT_TOKENS, reasoning: PROBE_REASONING });
  } catch {
    built = buildGenerationConfig({ model, maxOutputTokens: PROBE_MAX_OUTPUT_TOKENS, reasoning: null });
  }
  const { temperature: _t, ...generationConfig } = built;
  return { contents: [{ parts: [{ text: PROBE_PROMPT }] }], generationConfig };
}

const MODELS_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

interface ProviderTestResult {
  ok: boolean;
  detail: TestDetail;
}

/**
 * Teste une clé sans la révéler.
 *
 * Le secret circule en paramètre et n'est jamais journalisé : un message
 * d'erreur du fournisseur peut contenir l'URL appelée, clé comprise, et cette
 * URL ne doit pas atterrir dans un log d'exploitation.
 */
/**
 * Modèles employés par la configuration effective (principal et replis de
 * chaque traitement), ou par le référentiel du code pour un traitement sans
 * version. Ce sont eux que la clé doit servir — PROV-UI-03 « compatibilité ».
 */
export async function configuredModelsInUse(): Promise<string[]> {
  const [{ TREATMENTS, TREATMENT_DEFINITIONS }, { resolveTreatmentConfig }, { listOperationsByUseCase }] = await Promise.all([
    import('../config/treatments'),
    import('../config/config-resolver'),
    import('../registry/operations'),
  ]);
  const out = new Set<string>();
  for (const t of TREATMENTS) {
    const entry = await resolveTreatmentConfig(t).catch(() => null);
    if (entry?.primaryModel) {
      for (const m of [entry.primaryModel, entry.fallback1, entry.fallback2]) if (m) out.add(m);
      continue;
    }
    for (const op of listOperationsByUseCase(TREATMENT_DEFINITIONS[t].useCaseCode)) {
      if (op.provider === 'none' || !op.active) continue;
      for (const m of [op.primaryModel, ...op.fallbackModels]) if (m) out.add(m);
    }
  }
  return [...out].sort();
}

/** Modèles configurés absents de la liste du fournisseur (pur). */
export function missingConfiguredModels(listed: string[], configured: string[]): string[] {
  const servis = new Set(listed.map((n) => n.replace(/^models\//, '')));
  return configured.filter((m) => !servis.has(m));
}

export async function testProviderKey(
  secret: string,
  model: string,
  accountId: number,
  userId: number,
  /** Injectable en test ; par défaut, la configuration effective. */
  configured?: string[],
): Promise<ProviderTestResult> {
  const started = Date.now();
  const detail: TestDetail = {
    authenticated: false, modelsListed: null, generationOk: false, model,
  };
  // Lot 82C (LOG-01) : la génération de test est capturée comme tout appel modèle.
  let generationSent = false;

  try {
    // 1. Authentification et catalogue.
    const listing = await fetch(`${MODELS_ENDPOINT}?pageSize=1000&key=${encodeURIComponent(secret)}`, {
      method: 'GET',
      signal: AbortSignal.timeout(15_000),
    });

    if (!listing.ok) {
      detail.error = `Authentification refusée (${listing.status}).`;
      await trace(accountId, userId, model, false, Date.now() - started, detail.error);
      return { ok: false, detail };
    }

    detail.authenticated = true;
    const body = await listing.json().catch(() => ({}));
    detail.modelsListed = Array.isArray(body?.models) ? body.models.length : null;

    // PROV-UI-03 (lot IA 2) : compatibilité — chaque modèle de la
    // configuration effective doit être servi par CETTE clé. Une clé qui en
    // ignore un couperait ce traitement dès son activation.
    if (Array.isArray(body?.models)) {
      const listed = (body.models as Array<{ name?: unknown }>).map((m) => String(m?.name ?? ''));
      const missing = missingConfiguredModels(listed, configured ?? await configuredModelsInUse());
      if (missing.length > 0) {
        detail.missingModels = missing;
        detail.error = `Modèles configurés non servis par cette clé : ${missing.join(', ')}.`;
        await trace(accountId, userId, model, false, Date.now() - started, detail.error);
        return { ok: false, detail };
      }
    }

    // 2. Génération minimale — la seule qui prouve que le modèle est servi.
    generationSent = true;
    const generation = await fetch(
      `${MODELS_ENDPOINT}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(secret)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(providerTestGenerationBody(model)),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      },
    );

    if (!generation.ok) {
      const texte = await generation.text().catch(() => '');
      // Le message du fournisseur est conservé : c'est lui qui dit « no longer
      // available to new users » plutôt qu'un « erreur 404 » inexploitable.
      detail.error = `Génération refusée (${generation.status}) : ${nettoyer(texte, secret)}`;
      await trace(accountId, userId, model, false, Date.now() - started, detail.error, undefined, { sent: true, responseRaw: null });
      // Lot 32B (§1.H) : état opérationnel du modèle POUR CETTE CLÉ (empreinte,
      // jamais la clé) — ignoré tant que la clé n'est pas l'active. Lot 49 :
      // CLASSÉ — une erreur de clé, de quota ou de serveur n'est pas une
      // panne du modèle (non concluant, état conservé).
      await recordOperational(model, secret, classifyProbeFailure(texte || `HTTP ${generation.status}`, {
        model, secret, httpStatus: generation.status,
      }));
      return { ok: false, detail };
    }

    detail.generationOk = true;
    // PROV-UI-03 : jetons réels de la génération de test, tracés (coût
    // technique, jamais métier) plutôt qu'un zéro.
    const reponse = (await generation.json().catch(() => ({}))) as {
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
    };
    const texteGenere = (reponse.candidates?.[0]?.content?.parts ?? [])
      .filter((x) => typeof x.text === 'string' && x.thought !== true).map((x) => x.text).join('');
    // Réponse vide : non concluant (lot 49), jamais une indisponibilité.
    await recordOperational(model, secret, classifyProbeResponse(texteGenere));
    const usage = reponse.usageMetadata;
    await trace(accountId, userId, model, true, Date.now() - started, undefined, {
      inputTokens: Number(usage?.promptTokenCount ?? 0),
      outputTokens: Number(usage?.candidatesTokenCount ?? 0),
    }, { sent: true, responseRaw: texteGenere });
    return { ok: true, detail };
  } catch (e) {
    detail.error = nettoyer((e as Error).message ?? 'erreur inconnue', secret);
    await trace(accountId, userId, model, false, Date.now() - started, detail.error, undefined, { sent: generationSent, responseRaw: null });
    return { ok: false, detail };
  }
}

async function recordOperational(model: string, secret: string, outcome: ProbeOutcome): Promise<void> {
  const { recordOperationalCheck } = await import('./model-operational.service');
  await recordOperationalCheck({ model, secret, outcome, source: 'provider_test' });
}

/**
 * Retire le secret d'un message avant qu'il ne soit conservé.
 *
 * Les erreurs de `fetch` citent volontiers l'URL appelée — laquelle porte la
 * clé en paramètre. Sans ce nettoyage, un test raté écrirait le credential dans
 * la table de traces et dans les journaux.
 */
function nettoyer(message: string, secret: string): string {
  return sanitizeProviderError(message, secret);
}

async function trace(
  accountId: number, userId: number, model: string,
  ok: boolean, durationMs: number, error?: string,
  tokens: { inputTokens: number; outputTokens: number } = { inputTokens: 0, outputTokens: 0 },
  /** Lot 82C : génération transmise ou non, et réponse brute (capture complète). */
  exchange: { sent: boolean; responseRaw: string | null } = { sent: false, responseRaw: null },
): Promise<void> {
  const body = providerTestGenerationBody(model);
  await recordCallTrace({
    traceId: crypto.randomUUID(),
    useCaseCode: 'AI_GOVERNANCE',
    operationCode: 'provider_test',
    accountId,
    userId,
    provider: 'gemini',
    model,
    promptVersion: 'provider-test-v1',
    usedFallback: false,
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    costMicros: tokens.inputTokens + tokens.outputTokens > 0
      ? calcCostMicros(model, tokens.inputTokens, tokens.outputTokens, 'gemini')
      : 0,
    durationMs,
    status: ok ? 'success' : 'error',
    errorMessage: error,
    // SCR-10 : « le test est loggé et son coût est technique ». Non facturable,
    // comme les sondes — sans quoi une rotation de clé gonflerait la dépense
    // métier du jour.
    billable: false,
    shadow: false,
    capture: {
      origin: 'provider_test', callKind: 'test',
      // Corps transmis tel quel (jamais la clé : elle est dans l'URL, non capturée).
      sent: exchange.sent ? [{
        kind: 'test', prompt: PROBE_PROMPT, generationConfig: { model, ...(body.generationConfig as Record<string, unknown>) },
        timeoutMs: PROBE_TIMEOUT_MS, outcome: ok ? 'SUCCESS' : 'FAILED', error: error ?? null,
      }] : [],
      params: { model, endpoint: 'generateContent (test du fournisseur)' },
      responseRaw: exchange.responseRaw, attemptDurationMs: durationMs, executionElapsedMs: durationMs,
      ...(error ? { diagnostic: { error } } : {}),
    },
  });
}
