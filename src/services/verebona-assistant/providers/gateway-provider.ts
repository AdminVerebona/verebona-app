/**
 * Provider de l'assistant, via `AiGateway` — CDC assistant §25.4, refonte §5.2.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI PAS LE SDK DIRECTEMENT
 *
 * Le stub qu'il remplace prévoyait d'appeler `@google/genai` en direct. Deux
 * raisons de ne pas le faire :
 *
 * · Le §5.2 du CDC refonte l'interdit — « aucun accès direct au SDK
 *   fournisseur hors de AiGateway ». C'est la dette n° 4 de l'anti-régression,
 *   et l'implémenter ainsi l'aurait figée.
 *
 * · Un appel direct échappe à tout ce que la passerelle apporte : comptage des
 *   jetons, imputation du coût au compte, journal d'opération, repli
 *   fournisseur, idempotence, expurgation des données sensibles. L'assistant
 *   traite des questions d'utilisateurs sur leurs propres documents — c'est
 *   précisément là qu'on veut ces garanties.
 *
 * ── LE PROMPT EST CONSTRUIT PAR L'ASSISTANT ───────────────────────────────
 *
 * L'assistant assemble son invite par couches (§17.3), il ne peut donc pas
 * employer un prompt versionné du registre. C'est exactement le cas prévu par
 * `promptOverride`, réservé aux opérations déclarées `dynamicPrompt` — un
 * prompt hors gouvernance ne peut pas être injecté ailleurs (§4.5).
 *
 * ── LA VALIDATION RESTE CHEZ L'APPELANT ───────────────────────────────────
 *
 * Le contrat le dit : « objet JSON brut, à valider par Zod côté appelant
 * (§18.5) ». La passerelle reçoit donc un schéma permissif, et l'assistant
 * applique ensuite le sien. Traduire le JSON Schema en Zod ici dupliquerait
 * une validation qui existe déjà, avec le risque qu'elles divergent.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { AiGateway } from '@/services/ai/gateway/ai-gateway';
import type {
  AssistantModelProvider,
  StructuredModelRequest,
  ModelRun,
} from './assistant-model-provider';

/**
 * Schéma permissif : la passerelle exige un `ZodType`, l'assistant valide
 * ensuite avec le sien. Accepter n'importe quel objet ici n'affaiblit rien —
 * la vraie validation vient après.
 */
const SORTIE_BRUTE = z.record(z.string(), z.unknown());

/** Codes d'erreur pour lesquels un nouvel essai a un sens. */
const REESSAYABLE = /timeout|deadline|429|rate.?limit|503|502|unavailable|overloaded/i;

export interface AssistantCallContext {
  accountId: number;
  userId?: number;
  /**
   * Opération du registre. Deux existent pour l'assistant : `understand_request`
   * pour la planification d'outils, `generate_answer` pour la réponse.
   */
  operationCode: string;
  /** Rattache l'appel à la conversation, pour la trace. */
  conversationId?: string;
}

/**
 * Contexte de l'appel courant.
 *
 * Le contrat `AssistantModelProvider` ne le transporte pas — il a été conçu
 * autour d'un SDK, qui n'a pas besoin de savoir à quel compte imputer. La
 * passerelle, elle, en a besoin : sans compte, ni le coût ni le quota ne
 * peuvent être rattachés.
 *
 * Plutôt que de modifier une interface publique et tous ses appelants, le
 * contexte est posé autour de l'appel. C'est un compromis assumé, et il est
 * signalé : un appel sans contexte échoue explicitement plutôt que de
 * s'imputer au hasard.
 */
let contexteCourant: AssistantCallContext | null = null;

export function withAssistantContext<T>(
  contexte: AssistantCallContext,
  action: () => Promise<T>,
): Promise<T> {
  const precedent = contexteCourant;
  contexteCourant = contexte;
  return action().finally(() => { contexteCourant = precedent; });
}

export class GatewayAssistantProvider implements AssistantModelProvider {
  readonly name = 'ai-gateway';

  async generateStructured<T>(req: StructuredModelRequest<T>): Promise<ModelRun<T>> {
    const debut = Date.now();

    if (!contexteCourant) {
      // Échouer franchement plutôt que d'imputer l'appel à un compte
      // arbitraire : un coût mal rattaché fausse les quotas d'un client.
      return {
        ok: false,
        raw: null,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: 0,
        modelId: req.modelId,
        error: {
          code: 'CONTEXTE_ABSENT',
          message:
            "Appel hors `withAssistantContext` : le compte à imputer est inconnu.",
          retryable: false,
        },
      };
    }

    const { accountId, userId, operationCode, conversationId } = contexteCourant;

    try {
      const reponse = await AiGateway.execute({
        useCaseCode: 'INTELLIGENT_ASSISTANT',
        operationCode,
        accountId,
        userId,
        promptVariables: {},
        // Les deux couches sont concaténées : la passerelle transmet un
        // prompt unique. La séparation système/utilisateur est portée par le
        // balisage, que le prompt-builder produit déjà.
        promptOverride: `${req.systemInstruction}\n\n---\n\n${req.userContent}`,
        outputSchema: SORTIE_BRUTE,
        // Deux questions identiques dans la même conversation méritent deux
        // réponses : sans clé distincte, la seconde serait servie depuis le
        // cache d'idempotence.
        //
        // ⚠️ `Date.now()` ne suffit pas : deux appels dans la même
        // milliseconde produisent la même clé, et le second se voit rejouer
        // la réponse du premier. Un identifiant aléatoire écarte le cas.
        idempotencyKey: conversationId
          ? `assistant:${conversationId}:${operationCode}:${randomUUID()}`
          : undefined,
      });

      return {
        ok: true,
        raw: reponse.data,
        parsed: reponse.data as T,
        inputTokens: reponse.inputTokens ?? 0,
        outputTokens: reponse.outputTokens ?? 0,
        latencyMs: reponse.durationMs ?? Date.now() - debut,
        modelId: reponse.model ?? req.modelId,
      };
    } catch (e) {
      const err = e as Error & { code?: string };
      return {
        ok: false,
        raw: null,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: Date.now() - debut,
        modelId: req.modelId,
        error: {
          code: err.code ?? 'ERREUR_PASSERELLE',
          message: err.message,
          // La passerelle gère déjà son propre repli ; ce drapeau renseigne
          // l'appelant sur l'opportunité d'une nouvelle tentative métier.
          retryable: REESSAYABLE.test(err.message),
        },
      };
    }
  }
}
