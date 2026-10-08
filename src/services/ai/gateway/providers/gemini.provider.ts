/**
 * Adaptateur Gemini — CDC §5.2, §9.1.
 *
 * ⚠️ SEUL MODULE DU DÉPÔT AUTORISÉ À IMPORTER LE SDK `@google/genai`
 * (D-J5, lot 16b-3 : remplace `@google/generative-ai` 0.24, désinstallé).
 * Contrainte vérifiée par la règle ESLint `no-restricted-imports`
 * (eslint.config.mjs) et par `scripts/check-legacy-ai.mjs` en CI.
 * Critère d'acceptation n°4 du CDC §12.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * MIGRATION DU SDK À COMPORTEMENT CONSTANT
 *
 *   · même API (Gemini Developer API, `v1beta`, clé du BO), jamais Vertex AI
 *     quelle que soit l'environnement (`vertexai: false` explicite :
 *     `GOOGLE_GENAI_USE_VERTEXAI` est ignorée) ;
 *   · même requête : prompt puis pièces jointes en un seul contenu
 *     utilisateur, `generationConfig` identique (température 0, plafond de
 *     sortie, `thinkingConfig` transmis tel quel, JSON natif) — aucun réglage
 *     de sécurité ajouté ;
 *   · AUCUNE nouvelle tentative du SDK (`retryOptions` non fourni) : replis,
 *     disjoncteur et nouvelles tentatives restent ceux de la passerelle ;
 *   · même délai (course avec `timeoutMs`, erreur `TIMEOUT` récupérable) ; la
 *     requête HTTP est en plus ANNULÉE à l'expiration (`abortSignal`), au lieu
 *     de se poursuivre sans lecteur ;
 *   · même lecture de la réponse (`responseText`) : texte du premier candidat,
 *     erreur si la génération est bloquée (sécurité, récitation, langue) ou si
 *     le prompt est refusé — comme `response.text()` de l'ancien SDK ;
 *   · mêmes jetons : `usageMetadata.promptTokenCount` / `candidatesTokenCount`.
 * Les erreurs du SDK (HTTP 4xx/5xx, réseau) remontent telles quelles : la
 * passerelle les traite comme avant (`PROVIDER_UNAVAILABLE`, modèle suivant).
 * ══════════════════════════════════════════════════════════════════════════
 */
import {
  GoogleGenAI, FinishReason,
  type GenerateContentConfig, type GenerateContentResponse, type Part,
} from '@google/genai';
import type { AiProvider, AttachmentSession, ProviderCallInput, ProviderCallOutput, ProviderResponseMeta } from './provider.port';
import type { AiAttachment } from '../types';
import { AiGatewayError } from '../errors';
import { prepareAttachmentParts, cleanupTemporaryFiles } from './gemini-files';
import { getProviderSecret } from '../../provider/provider-secret';
import { buildGenerationConfig } from './gemini-generation-config';

/**
 * Préparation partagée par les tentatives d'une exécution : fichiers envoyés
 * une seule fois à la Files API, réutilisés par les replis, supprimés à la
 * libération. Un échec de préparation n'est pas mémorisé : la tentative
 * suivante réessaie, comme avant.
 */
export class GeminiAttachmentSession implements AttachmentSession {
  private prepared: Promise<{ parts: Part[]; temporaryFileUris: string[]; apiKey: string }> | null = null;
  private released = false;

  constructor(private readonly attachments: AiAttachment[]) {}

  async parts(apiKey: string): Promise<Part[]> {
    if (this.released) throw new Error('Session de pièces jointes déjà libérée');
    if (!this.prepared) {
      const p = prepareAttachmentParts(this.attachments, apiKey).then((r) => ({ ...r, apiKey }));
      this.prepared = p;
      p.catch(() => { if (this.prepared === p) this.prepared = null; });
    }
    return (await this.prepared).parts;
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    const pending = this.prepared;
    this.prepared = null;
    if (!pending) return;
    const ready = await pending.catch(() => null);
    if (ready) await cleanupTemporaryFiles(ready.temporaryFileUris, ready.apiKey);
  }
}

export class GeminiProvider implements AiProvider {
  readonly name = 'gemini';

  openAttachmentSession(attachments: AiAttachment[]): AttachmentSession {
    return new GeminiAttachmentSession(attachments);
  }

  /**
   * Vrai si une clé est disponible : clé ACTIVE du BO, sinon environnement
   * (PROV-UI-05, WF-21). Asynchrone parce que la clé administrée est en base ;
   * la lecture est mise en cache 60 s (provider-secret), donc sans coût réel
   * sur le chemin d'appel.
   */
  async isConfigured(): Promise<boolean> {
    return Boolean(await getProviderSecret(this.name));
  }

  async call(input: ProviderCallInput): Promise<ProviderCallOutput> {
    // Même source que `isConfigured` : la clé activée depuis le BO remplace
    // celle de l'environnement dès l'activation (cache vidé), sans redéploiement.
    const apiKey = await getProviderSecret(this.name);
    if (!apiKey) {
      throw new AiGatewayError('PROVIDER_UNAVAILABLE', 'n/a', 'Aucune clé Gemini (BO ni GEMINI_API_KEY)', { recoverable: false });
    }

    const genAI = new GoogleGenAI({ apiKey, vertexai: false });
    // Température fixée dans le code (GEN-011), plafond de sortie et niveau
    // de raisonnement administrés (§2.1). `thinkingConfig` est transmis tel
    // quel à l'API REST (valeurs `low` / `high` ou budget, inchangées).
    const generationConfig = buildGenerationConfig(input) as GenerateContentConfig;

    // PDF et vidéo via Files API, images en inline, bureautique extraite côté
    // serveur. La clé est transmise : l'upload et le nettoyage utilisent la
    // même clé administrée que la génération. Avec une session (passerelle),
    // la préparation est faite une fois pour toute la chaîne, et c'est la
    // session — non l'appel — qui supprime les fichiers temporaires.
    const session = input.attachmentSession instanceof GeminiAttachmentSession
      ? input.attachmentSession
      : null;
    // Lot 33D : un échec de préparation des pièces jointes est une erreur de
    // CONSTRUCTION de la requête (étape `request_build`), pas du fournisseur.
    const { parts, temporaryFileUris } = await (session
      ? session.parts(apiKey).then((p) => ({ parts: p, temporaryFileUris: [] as string[] }))
      : prepareAttachmentParts(input.attachments, apiKey)
    ).catch((e: unknown) => { throw markStage(e, 'request_build'); });

    const controller = new AbortController();
    try {
      const contents: Part[] = [{ text: input.prompt }, ...parts];
      const response = await withTimeout(
        genAI.models.generateContent({
          model: input.model,
          contents,
          config: { ...generationConfig, abortSignal: controller.signal },
        }),
        input.timeoutMs, input.model, () => controller.abort(),
      );

      const usage = response.usageMetadata;
      const meta = responseMeta(response);
      let rawText: string;
      try {
        rawText = responseText(response);
      } catch (e) {
        // Blocage (sécurité, récitation, langue) : jetons et métadonnées
        // conservés pour le rapport d'échec (lot 33D, §8).
        throw Object.assign(e as Error, {
          blocked: true, providerMeta: meta, aiStage: response.candidates?.[0] ? 'provider_generation' : 'provider_request',
          inputTokens: usage?.promptTokenCount ?? 0, outputTokens: usage?.candidatesTokenCount ?? 0,
        });
      }
      return {
        rawText,
        inputTokens: usage?.promptTokenCount ?? 0,
        outputTokens: usage?.candidatesTokenCount ?? 0,
        meta,
      };
    } finally {
      // Nettoyage systématique, y compris en cas d'échec (CDC §5.2).
      await cleanupTemporaryFiles(temporaryFileUris, apiKey);
    }
  }
}

/** Étape d'échec posée sur une erreur (lue par `diagnostics/classify`). */
function markStage(e: unknown, stage: string): unknown {
  if (e && typeof e === 'object') {
    try { Object.assign(e, { aiStage: stage }); } catch { /* erreur gelée : sans étape */ }
  }
  return e;
}

/**
 * Métadonnées natives d'une réponse (lot 33D, §7, §8) : identifiant de
 * réponse, version servie, fin de génération, raison de sécurité, jetons de
 * raisonnement. Pure, testée sans réseau.
 */
export function responseMeta(response: Pick<GenerateContentResponse, 'candidates' | 'promptFeedback' | 'usageMetadata'> & { responseId?: string; modelVersion?: string }): ProviderResponseMeta {
  const c = response.candidates?.[0];
  const ratings = (c?.safetyRatings ?? []).filter((r) => r.blocked);
  return {
    providerRequestId: response.responseId ?? null,
    modelVersion: response.modelVersion ?? null,
    finishReason: c?.finishReason ?? null,
    finishMessage: c?.finishMessage ?? null,
    safetyReason: response.promptFeedback?.blockReason
      ?? (ratings.length ? ratings.map((r) => r.category).join(',') : null)
      ?? null,
    thoughtsTokens: response.usageMetadata?.thoughtsTokenCount ?? null,
    totalTokens: response.usageMetadata?.totalTokenCount ?? null,
  };
}

async function withTimeout<T>(p: Promise<T>, ms: number, model: string, onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, rej) => {
        timer = setTimeout(
          () => {
            // L'erreur TIMEOUT est rendue AVANT l'annulation : c'est elle que
            // voit la passerelle, jamais l'erreur d'annulation du SDK.
            rej(new AiGatewayError('TIMEOUT', 'n/a', `Délai dépassé (${ms} ms) sur ${model}`, { recoverable: true }));
            onTimeout?.();
          },
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Fins de génération qui rendaient `response.text()` illisible dans l'ancien SDK. */
const BAD_FINISH_REASONS: readonly string[] = [FinishReason.RECITATION, FinishReason.SAFETY, FinishReason.LANGUAGE];

/**
 * Texte de la réponse — même règle que `response.text()` de l'ancien SDK
 * (`@google/generative-ai` 0.24) :
 *   · candidat présent : erreur si sa fin est RECITATION, SAFETY ou LANGUAGE ;
 *     sinon concaténation des parties texte du PREMIER candidat (raisonnement
 *     exclu, il n'est jamais demandé) ;
 *   · aucun candidat mais un retour sur le prompt : erreur « bloqué » ;
 *   · sinon : chaîne vide (sortie invalide pour le validateur, modèle suivant).
 */
export function responseText(response: Pick<GenerateContentResponse, 'candidates' | 'promptFeedback'>): string {
  const candidat = response.candidates?.[0];
  if (candidat) {
    if (candidat.finishReason && BAD_FINISH_REASONS.includes(candidat.finishReason)) {
      throw new Error(`[GoogleGenAI Error]: ${blockMessage(response)}`);
    }
    return (candidat.content?.parts ?? [])
      .filter((p) => typeof p.text === 'string' && p.thought !== true)
      .map((p) => p.text)
      .join('');
  }
  if (response.promptFeedback) {
    throw new Error(`[GoogleGenAI Error]: Text not available. ${blockMessage(response)}`);
  }
  return '';
}

function blockMessage(response: Pick<GenerateContentResponse, 'candidates' | 'promptFeedback'>): string {
  const candidat = response.candidates?.[0];
  if (!candidat && response.promptFeedback) {
    const f = response.promptFeedback;
    return `Response was blocked${f.blockReason ? ` due to ${f.blockReason}` : ''}${f.blockReasonMessage ? `: ${f.blockReasonMessage}` : ''}`;
  }
  if (candidat) {
    return `Candidate was blocked due to ${candidat.finishReason}${candidat.finishMessage ? `: ${candidat.finishMessage}` : ''}`;
  }
  return '';
}
