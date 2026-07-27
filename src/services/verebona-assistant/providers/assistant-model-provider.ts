/**
 * Abstraction provider — CDC §25.5.
 *
 * Le code métier NE DÉPEND PAS d'un SDK Gemini. Cette interface permet de migrer de
 * SDK, tester avec un faux provider, changer de modèle et isoler la gestion d'erreurs.
 */

export interface StructuredModelRequest<T> {
  modelId: string;
  systemInstruction: string;
  /** Prompt construit par le prompt-builder (couches 3–8 sérialisées — §17.3). */
  userContent: string;
  /** JSON Schema de la sortie attendue (§18.1). */
  jsonSchema: Record<string, unknown>;
  maxOutputTokens: number;
  timeoutMs: number;
  /** Interactions API : stateless obligatoire en V1 (§25.4). */
  store: false;
  /** Zod parse côté appelant ; le provider renvoie l'objet brut + tokens. */
  _resultType?: T;
}

export interface ModelRun<T> {
  ok: boolean;
  /** Objet JSON brut (à valider par Zod côté appelant — §18.5). */
  raw: unknown;
  parsed?: T;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  modelId: string;
  error?: { code: string; message: string; retryable: boolean };
}

export interface AssistantModelProvider {
  readonly name: string;
  generateStructured<T>(request: StructuredModelRequest<T>): Promise<ModelRun<T>>;
}
