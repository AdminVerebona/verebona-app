/**
 * T4 master — branche CLASSIFY_EVENT (CDC 15 §26, T4-10, T4-11, C1 à C5).
 *
 * Appelée seulement quand les règles déterministes (registre, règles métier
 * stables, motifs) n'ont pas tranché ET que la version de configuration met
 * T4 en architecture `master`. Le catalogue d'événements est transmis en
 * DONNÉES (EVENT_CATALOG du registre, U6) ; aucune règle par type de contrat
 * dans le prompt (C4). Sortie à trois valeurs, `unknown` compris.
 */
import { AiGateway } from '../../gateway/ai-gateway';
import { isExecutionCancelled } from '../../queue/execution-control';
import { EVENT_CATALOG } from '@/services/canonical/registry';
import type { AgendaClassification, AgendaClassificationInput } from '../types';
import { T4ClassifyEventOutput, closedWorldBusinessType, type T4ClassifyEventOutput as Out } from './t4-contract';

export interface ClassifyEventContext {
  accountId: number;
  userId?: number;
  sourceFileId?: number | null;
  excerpt?: string;
  date?: string | null;
}

/** Catalogue fermé transmis au modèle (U6). */
export function eventCatalogForPrompt(): Array<{ businessType: string; label: string; natures: string[] }> {
  return EVENT_CATALOG.map((e) => ({ businessType: e.businessType, label: e.label, natures: [...e.natures] }));
}

export function classifyEventVariables(input: AgendaClassificationInput, ctx: ClassifyEventContext): Record<string, unknown> {
  return {
    EVENT_CONTEXT: {
      title: input.title,
      date: ctx.date ?? null,
      description: input.description ?? null,
      originFieldKey: input.originFieldKey ?? null,
      nature: input.nature ?? null,
      businessType: input.businessType ?? null,
    },
    EVENT_CATALOG: eventCatalogForPrompt(),
    EVIDENCE: (ctx.excerpt ?? input.description ?? '').slice(0, 500) || null,
    AGENDA_ITEM: null, DOCUMENT_TYPE: null, TEMPORAL_CONTEXT: null, TEMPORAL_CANDIDATES: null,
  };
}

/** Traduction pure (monde fermé U6). */
export function translateClassifyEvent(out: Out): { classification: AgendaClassification; warning: string | null } {
  const allowed = new Set(EVENT_CATALOG.map((e) => e.businessType as string));
  const { output, warning } = closedWorldBusinessType(out, allowed);
  return {
    classification: {
      category: output.homeCategory, confidence: output.confidence, source: 'model',
      businessType: output.businessType ?? null, reason: output.reason,
    },
    warning,
  };
}

/** Classification par le master. Échec : repli historique `action`, ambigu. */
export async function classifyEventMaster(
  input: AgendaClassificationInput, ctx: ClassifyEventContext,
): Promise<AgendaClassification> {
  try {
    const res = await AiGateway.execute({
      useCaseCode: 'AGENDA_INTELLIGENCE',
      operationCode: 't4_classify_event',
      accountId: ctx.accountId,
      userId: ctx.userId,
      sourceIds: ctx.sourceFileId ? [ctx.sourceFileId] : undefined,
      promptVariables: classifyEventVariables(input, ctx),
      outputSchema: T4ClassifyEventOutput,
    });
    const { classification, warning } = translateClassifyEvent(res.data);
    if (warning) console.warn(`[t4_classify_event] ${warning} — type métier ignoré (U6)`);
    return classification;
  } catch (e) {
    if (isExecutionCancelled(e)) throw e;
    console.warn('[t4_classify_event] classification modèle indisponible :', (e as Error).message);
    return { category: 'action', confidence: 'ambiguous', source: 'fallback', reason: 'modèle indisponible' };
  }
}
