/**
 * Faux provider déterministe — CDC §25.5 (« tester avec un faux provider »).
 * Utilisé par le jeu d'évaluation (§35) et les tests d'orchestration hors réseau.
 */
import type { AssistantModelProvider, StructuredModelRequest, ModelRun } from './assistant-model-provider';

export interface FakeScript {
  /** Réponse brute renvoyée telle quelle (déjà conforme au schéma attendu). */
  raw: unknown;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  fail?: { code: string; message: string; retryable: boolean };
}

export class FakeAssistantProvider implements AssistantModelProvider {
  readonly name = 'fake';
  private queue: FakeScript[] = [];

  enqueue(script: FakeScript): this {
    this.queue.push(script);
    return this;
  }

  async generateStructured<T>(req: StructuredModelRequest<T>): Promise<ModelRun<T>> {
    const s = this.queue.shift();
    if (!s) throw new Error('FakeAssistantProvider: file vide (aucune réponse scriptée)');
    if (s.fail) {
      return {
        ok: false, raw: null, inputTokens: s.inputTokens ?? 0, outputTokens: 0,
        latencyMs: s.latencyMs ?? 1, modelId: req.modelId, error: s.fail,
      };
    }
    return {
      ok: true, raw: s.raw, parsed: s.raw as T,
      inputTokens: s.inputTokens ?? 100, outputTokens: s.outputTokens ?? 40,
      latencyMs: s.latencyMs ?? 5, modelId: req.modelId,
    };
  }
}
