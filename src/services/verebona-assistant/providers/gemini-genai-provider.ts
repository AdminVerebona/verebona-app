/**
 * Provider Gemini via @google/genai (Interactions API, stateless store=false) — CDC §25.4.
 *
 * ⚠️ Le SDK cible `@google/genai` n'est pas encore installé dans le repo (actuellement
 *    `@google/generative-ai`). Ajouter la dépendance avant d'activer la Phase 3 :
 *      npm i @google/genai
 *    Conserver `@google/generative-ai` pour les traitements doc-ai existants (§15.10).
 *
 * Contraintes appliquées :
 *  - store=false (pas de conservation Google, historique maîtrisé côté Verebona — §25.4) ;
 *  - pas de previous_interaction_id (§25.4) ;
 *  - sortie structurée JSON Schema (§18.1) ;
 *  - niveau PAYANT uniquement (le gratuit est interdit en prod — §29.5).
 */
import type { AssistantModelProvider, StructuredModelRequest, ModelRun } from './assistant-model-provider';

export class GeminiGenAIProvider implements AssistantModelProvider {
  readonly name = 'google-genai';

  constructor(private readonly apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY) {
    if (!this.apiKey) {
      // Ne pas throw à la construction (le fake provider peut être utilisé en dev).
      console.warn('[verebona] GeminiGenAIProvider: clé API absente — provider inactif.');
    }
  }

  async generateStructured<T>(req: StructuredModelRequest<T>): Promise<ModelRun<T>> {
    const started = Date.now();
    if (!this.apiKey) {
      return {
        ok: false, raw: null, inputTokens: 0, outputTokens: 0, latencyMs: 0, modelId: req.modelId,
        error: { code: 'PROVIDER_UNCONFIGURED', message: 'GEMINI_API_KEY manquant', retryable: false },
      };
    }

    try {
      // TODO(CDC §25.4) — implémentation @google/genai (Interactions API) :
      //
      //   import { GoogleGenAI } from '@google/genai';
      //   const ai = new GoogleGenAI({ apiKey: this.apiKey });
      //   const res = await ai.interactions.create({
      //     model: req.modelId,
      //     store: false,                         // stateless (§25.4)
      //     input: [
      //       { role: 'system', content: req.systemInstruction },
      //       { role: 'user',   content: req.userContent },
      //     ],
      //     responseSchema: req.jsonSchema,       // structured output (§18.1)
      //     maxOutputTokens: req.maxOutputTokens,
      //   }, { signal: AbortSignal.timeout(req.timeoutMs) });
      //   const raw = JSON.parse(res.output_text);
      //   return { ok:true, raw, parsed: raw as T, inputTokens: res.usage.inputTokens,
      //            outputTokens: res.usage.outputTokens, latencyMs: Date.now()-started, modelId: req.modelId };
      //
      throw new Error('GeminiGenAIProvider non implémenté — brancher @google/genai (Phase 3)');
    } catch (e) {
      const err = e as Error;
      const retryable = /timeout|429|503|unavailable/i.test(err.message);
      return {
        ok: false, raw: null, inputTokens: 0, outputTokens: 0,
        latencyMs: Date.now() - started, modelId: req.modelId,
        error: { code: retryable ? 'PROVIDER_RETRYABLE' : 'PROVIDER_ERROR', message: err.message, retryable },
      };
    }
  }
}
