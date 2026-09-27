/**
 * Adaptateur Gemini — CDC §5.2, §9.1.
 *
 * ⚠️ SEUL MODULE DU DÉPÔT AUTORISÉ À IMPORTER `@google/generative-ai`.
 * Contrainte vérifiée par la règle ESLint `no-restricted-imports`
 * (eslint.config.mjs) et par `scripts/check-legacy-ai.mjs` en CI.
 * Critère d'acceptation n°4 du CDC §12.
 */
import { GoogleGenerativeAI, type GenerationConfig, type Part } from '@google/generative-ai';
import type { AiProvider, AttachmentSession, ProviderCallInput, ProviderCallOutput } from './provider.port';
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

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: input.model,
      // Température fixée dans le code (GEN-011), plafond de sortie et niveau
      // de raisonnement administrés (§2.1). `thinkingConfig` n'est pas typé
      // par la version 0.24 du SDK, mais `generationConfig` est transmis tel
      // quel à l'API REST, qui le reconnaît.
      generationConfig: buildGenerationConfig(input) as GenerationConfig,
    });

    // PDF et vidéo via Files API, images en inline, bureautique extraite côté
    // serveur. La clé est transmise : l'upload et le nettoyage utilisent la
    // même clé administrée que la génération. Avec une session (passerelle),
    // la préparation est faite une fois pour toute la chaîne, et c'est la
    // session — non l'appel — qui supprime les fichiers temporaires.
    const session = input.attachmentSession instanceof GeminiAttachmentSession
      ? input.attachmentSession
      : null;
    const { parts, temporaryFileUris } = session
      ? { parts: await session.parts(apiKey), temporaryFileUris: [] as string[] }
      : await prepareAttachmentParts(input.attachments, apiKey);

    try {
      const contents: Part[] = [{ text: input.prompt }, ...parts];
      const result = await withTimeout(model.generateContent(contents), input.timeoutMs, input.model);

      const usage = result.response.usageMetadata;
      return {
        rawText: result.response.text(),
        inputTokens: usage?.promptTokenCount ?? 0,
        outputTokens: usage?.candidatesTokenCount ?? 0,
      };
    } finally {
      // Nettoyage systématique, y compris en cas d'échec (CDC §5.2).
      await cleanupTemporaryFiles(temporaryFileUris, apiKey);
    }
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number, model: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, rej) => {
        timer = setTimeout(
          () => rej(new AiGatewayError('TIMEOUT', 'n/a', `Délai dépassé (${ms} ms) sur ${model}`, { recoverable: true })),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
