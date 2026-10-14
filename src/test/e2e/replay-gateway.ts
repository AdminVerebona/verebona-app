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
  /**
   * Lot 33D — appel visé : `analysis` (défaut) ou `repair` (passe de
   * réparation ciblée). Un enregistrement d'analyse n'est jamais consommé par
   * une réparation, et inversement.
   */
  callKind?: 'analysis' | 'repair';
  /** Lot 33D — métadonnées natives simulées (finish_reason MAX_TOKENS…). */
  meta?: import('@/services/ai/gateway/providers/provider.port').ProviderResponseMeta;
  /**
   * Lot 33D — erreur fournisseur simulée (délai, 429, 400 sur le schéma…) :
   * l'appel lève au lieu de rendre `output`.
   */
  error?: { message: string; status?: number; code?: string; recoverable?: boolean };
  /**
   * Lot 52B — filtre sur le structured output de l'appel : `true` ne répond
   * qu'à un appel portant un `responseSchema`, `false` qu'à un appel sans
   * (essai diagnostique de la passerelle). Absent : les deux.
   */
  whenStructured?: boolean;
}

const cle = (operationCode: string, task?: string, callKind?: 'analysis' | 'repair') =>
  `${callKind === 'repair' ? 'repair:' : ''}${operationCode}::${task ?? '*'}`;

/**
 * Lot 54 — répondeurs PAR DÉFAUT (opération, branche), consultés seulement
 * quand aucun enregistrement ne correspond. Posés explicitement par un
 * harnais (`chain.ts` : T4 simulé « bien élevé » pour les scénarios dont T4
 * n'est pas le sujet), retirés par lui. Un scénario qui enregistre ses
 * propres sorties les voit toujours passer en premier.
 */
const repondeurs = new Map<string, (input: ProviderCallInput) => unknown>();
export function setDefaultResponder(operationCode: string, task: string | undefined, fn: ((input: ProviderCallInput) => unknown) | null): void {
  const k = cle(operationCode, task);
  if (fn) repondeurs.set(k, fn); else repondeurs.delete(k);
}

/**
 * Lot 54 — T4 CLASSIFY_EVENT simulé : accepte l'événement, reprend la
 * catégorie de l'indice déterministe transmis (sinon `action`) et accepte la
 * récurrence envisagée par le serveur — le comportement antérieur au lot 54.
 * Contrat v2 si le contexte structuré v2 est injecté, sinon sortie v1.
 */
export function t4AcceptingResponder(input: ProviderCallInput): unknown {
  const i = input.prompt.indexOf('\nEXECUTION_CONTEXT\n');
  const ctx = i >= 0 ? JSON.parse(input.prompt.slice(i + '\nEXECUTION_CONTEXT\n'.length).split('\n')[0]) as { event_context?: Record<string, unknown> } : null;
  const ec = ctx?.event_context ?? {};
  const hint = (ec.ruleHint as { category?: string } | undefined)?.category;
  const homeCategory = hint === 'information' ? 'information' : 'action';
  const base = { task: 'CLASSIFY_EVENT', businessType: null, homeCategory, confidence: hint ? 'certain' : 'probable', reason: 'T4 simulé (e2e)' };
  if (!ctx || !('recurrenceCandidate' in ec)) return base;
  return { ...base, agendaDecision: 'accept', recurrenceDecision: ec.recurrenceCandidate ? 'accept' : 'not_applicable', recurrenceReason: ec.recurrenceCandidate ? 'T4 simulé (e2e)' : null };
}

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
      const k = cle(r.operationCode, r.task, r.callKind);
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
    const kind = input.callKind;
    const r = this.take(cle(op, input.task, kind), input) ?? this.take(cle(op, undefined, kind), input);
    const defaut = !r && kind !== 'repair' ? repondeurs.get(cle(op, input.task)) : undefined;
    if (defaut) return { rawText: JSON.stringify(defaut(input)), inputTokens: 0, outputTokens: 0 };
    if (!r) {
      throw new Error(
        `[replay] aucune sortie enregistrée pour l'opération « ${op} »`
        + `${input.task ? ` (TASK ${input.task})` : ''}${kind === 'repair' ? ' (réparation)' : ''} — aucun appel réseau n'est permis en E2E.`,
      );
    }
    if (r.error) {
      if (r.error.code === 'TIMEOUT') {
        const { AiGatewayError } = await import('@/services/ai/gateway/errors');
        throw new AiGatewayError('TIMEOUT', op, r.error.message, { recoverable: r.error.recoverable ?? true });
      }
      throw Object.assign(new Error(r.error.message), { ...(r.error.status ? { status: r.error.status } : {}), ...(r.error.code ? { code: r.error.code } : {}) });
    }
    const rawText = typeof r.output === 'string' ? r.output : JSON.stringify(r.output);
    return { rawText, inputTokens: r.inputTokens ?? 0, outputTokens: r.outputTokens ?? 0, ...(r.meta ? { meta: r.meta } : {}) };
  }

  private take(k: string, input: ProviderCallInput): RecordedOutput | null {
    const file = this.files.get(k) ?? [];
    const i = file.findIndex((r) => (!r.promptIncludes || input.prompt.includes(r.promptIncludes))
      && (r.whenStructured === undefined || r.whenStructured === (input.responseSchema !== undefined)));
    if (i >= 0) {
      const [r] = file.splice(i, 1);
      if (r.repeat) this.derniers.set(k, r);
      return r;
    }
    const dernier = this.derniers.get(k) ?? null;
    return dernier && (dernier.whenStructured === undefined || dernier.whenStructured === (input.responseSchema !== undefined)) ? dernier : null;
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
