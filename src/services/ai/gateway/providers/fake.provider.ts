/**
 * Fournisseur déterministe pour les tests — CDC §11.
 *
 * Permet d'exécuter la totalité des tests de non-régression sans appel réseau
 * ni coût. Les réponses sont programmées par modèle.
 */
import type { AiProvider, ProviderCallInput, ProviderCallOutput } from './provider.port';

type Responder = (input: ProviderCallInput) => ProviderCallOutput | Promise<ProviderCallOutput>;

export class FakeProvider implements AiProvider {
  readonly name = 'fake';
  private readonly responders = new Map<string, Responder>();
  readonly calls: ProviderCallInput[] = [];

  isConfigured(): boolean { return true; }

  /** Programme la réponse renvoyée pour un modèle donné. */
  on(model: string, responder: Responder): this {
    this.responders.set(model, responder);
    return this;
  }

  /** Réponse par défaut, tous modèles confondus. */
  onAny(responder: Responder): this {
    this.responders.set('*', responder);
    return this;
  }

  async call(input: ProviderCallInput): Promise<ProviderCallOutput> {
    this.calls.push(input);
    const responder = this.responders.get(input.model) ?? this.responders.get('*');
    if (!responder) throw new Error(`[fake-provider] Aucune réponse programmée pour « ${input.model} »`);
    return responder(input);
  }

  reset(): void {
    this.responders.clear();
    this.calls.length = 0;
  }
}
