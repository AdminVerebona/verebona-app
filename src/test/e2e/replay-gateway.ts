/**
 * Rejeu des sorties modèle enregistrées — harnais E2E (CDC 15 T2-41, D-17).
 *
 * « 100 % bloquant en CI sur sorties enregistrées » (décision D-17) : la CI
 * n'appelle jamais de modèle. Ce fournisseur remplace Gemini DERRIÈRE la
 * passerelle réelle — idempotence, configuration, validation de sortie,
 * traces en base restent exercées — et rend, pour chaque appel, la sortie
 * enregistrée correspondant à son opération (et à sa branche TASK quand le
 * prompt maître en impose une).
 *
 * Aucun réseau : un appel sans enregistrement lève immédiatement, avec la
 * clé manquante. Mieux vaut un scénario rouge qu'un scénario vert par
 * accident.
 *
 * Format d'un enregistrement (fichier JSON de `recordings/` ou objet) :
 *   { "operationCode": "t1_analyze_document", "task": "ANALYZE_DOCUMENT",
 *     "output": { … } | "texte brut", "inputTokens": 1200, "outputTokens": 300 }
 * Plusieurs enregistrements pour la même clé sont rendus dans l'ordre ; le
 * dernier est réutilisé ensuite si `repeat` est vrai.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AiProvider, ProviderCallInput, ProviderCallOutput } from '@/services/ai/gateway/providers/provider.port';

export interface RecordedOutput {
  operationCode: string;
  /** Branche TASK/MODE ; absente : n'importe laquelle (appel hors master). */
  task?: string;
  /** Sortie du modèle : objet (sérialisé en JSON) ou texte brut. */
  output: unknown;
  inputTokens?: number;
  outputTokens?: number;
  /** Réutiliser cet enregistrement une fois la file de sa clé épuisée. */
  repeat?: boolean;
  /** Filtre optionnel sur le prompt envoyé (sous-chaîne attendue). */
  promptIncludes?: string;
}

const cle = (operationCode: string, task?: string) => `${operationCode}::${task ?? '*'}`;

export class ReplayProvider implements AiProvider {
  readonly name = 'replay';
  /** Appels reçus, dans l'ordre — pour les assertions des scénarios. */
  readonly calls: ProviderCallInput[] = [];
  private readonly files = new Map<string, RecordedOutput[]>();
  private readonly derniers = new Map<string, RecordedOutput>();

  constructor(recordings: RecordedOutput[] = []) {
    this.add(...recordings);
  }

  isConfigured(): boolean { return true; }

  add(...recordings: RecordedOutput[]): this {
    for (const r of recordings) {
      const k = cle(r.operationCode, r.task);
      const file = this.files.get(k) ?? [];
      file.push(r);
      this.files.set(k, file);
    }
    return this;
  }

  /** Enregistrements non consommés (un scénario peut exiger qu'il n'en reste aucun). */
  pending(): RecordedOutput[] {
    return [...this.files.values()].flat();
  }

  async call(input: ProviderCallInput): Promise<ProviderCallOutput> {
    this.calls.push(input);
    const op = input.operationCode ?? '?';
    const r = this.take(cle(op, input.task), input) ?? this.take(cle(op), input);
    if (!r) {
      throw new Error(
        `[replay] aucune sortie enregistrée pour l'opération « ${op} »`
        + `${input.task ? ` (TASK ${input.task})` : ''} — aucun appel réseau n'est permis en E2E.`,
      );
    }
    const rawText = typeof r.output === 'string' ? r.output : JSON.stringify(r.output);
    return { rawText, inputTokens: r.inputTokens ?? 0, outputTokens: r.outputTokens ?? 0 };
  }

  private take(k: string, input: ProviderCallInput): RecordedOutput | null {
    const file = this.files.get(k) ?? [];
    const i = file.findIndex((r) => !r.promptIncludes || input.prompt.includes(r.promptIncludes));
    if (i >= 0) {
      const [r] = file.splice(i, 1);
      if (r.repeat) this.derniers.set(k, r);
      return r;
    }
    return this.derniers.get(k) ?? null;
  }
}

/** Charge les enregistrements d'un dossier (`*.json` : objet ou tableau). */
export async function loadRecordings(dir: string): Promise<RecordedOutput[]> {
  const out: RecordedOutput[] = [];
  for (const f of (await readdir(dir)).filter((x) => x.endsWith('.json')).sort()) {
    const parsed = JSON.parse(await readFile(join(dir, f), 'utf-8')) as RecordedOutput | RecordedOutput[];
    out.push(...(Array.isArray(parsed) ? parsed : [parsed]));
  }
  return out;
}

/**
 * Installe le rejeu comme fournisseur de la passerelle et le rend. À appeler
 * dans chaque scénario qui déclenche un traitement IA.
 */
export async function installReplayGateway(recordings: RecordedOutput[] = []): Promise<ReplayProvider> {
  const { setAiProvider } = await import('@/services/ai/gateway/providers');
  const provider = new ReplayProvider(recordings);
  setAiProvider(provider);
  return provider;
}
