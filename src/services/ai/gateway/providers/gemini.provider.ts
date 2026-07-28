/**
 * Adaptateur Gemini — CDC §5.2, §9.1.
 *
 * ⚠️ SEUL MODULE DU DÉPÔT AUTORISÉ À IMPORTER `@google/generative-ai`.
 * Contrainte vérifiée par la règle ESLint `no-restricted-imports`
 * (eslint.config.mjs) et par `scripts/check-legacy-ai.mjs` en CI.
 * Critère d'acceptation n°4 du CDC §12.
 */
import { GoogleGenerativeAI, type Part } from '@google/generative-ai';
import type { AiProvider, ProviderCallInput, ProviderCallOutput } from './provider.port';
import { AiGatewayError } from '../errors';
import { prepareAttachmentParts, cleanupTemporaryFiles } from './gemini-files';

export class GeminiProvider implements AiProvider {
  readonly name = 'gemini';

  isConfigured(): boolean {
    return Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY);
  }

  async call(input: ProviderCallInput): Promise<ProviderCallOutput> {
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY;
    if (!apiKey) {
      throw new AiGatewayError('PROVIDER_UNAVAILABLE', 'n/a', 'GEMINI_API_KEY absente', { recoverable: false });
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: input.model });

    // PDF et vidéo via Files API, images en inline, bureautique extraite côté serveur.
    const { parts, temporaryFileUris } = await prepareAttachmentParts(input.attachments, apiKey);

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
