/**
 * Branche UNDERSTAND du master T2 — CDC 15 §24 (A1–A6), T2-08.
 *
 * Fournie au propriétaire de la classification (Y) : `classification.adapter`
 * l'appelle (seul moteur depuis le lot 16b-2, `understand_request` retiré),
 * puis construit la route avec son propre `toIntentRoute(result.plan,
 * planType)` — les droits restent ceux du registre des intentions, jamais
 * ceux du modèle.
 *
 * Enveloppe : question masquée (§29.4), budget
 * du message (CA-07 : réparation OU escalade), plafond de sortie et délais
 * par `executeWithinBudget`, clé d'idempotence propre (`t2_understand`).
 * Contrôles serveur APRÈS validation : `requestedFacts` restreint aux clés
 * du FIELD_CATALOG (A4), le reste renvoyé en `requestedTopics` ; indices
 * sans préfixe « page: ».
 */
import { CANONICAL_FIELDS } from '@/services/canonical/registry';
import { isAiGatewayError } from '@/services/ai/gateway/errors';
import {
  callWithRepairOrEscalation, repairInstruction,
} from '@/services/verebona-assistant/core/model-call-policy';
import { maskSensitiveText, sensitiveNecessityFor } from '@/services/verebona-assistant/core/sensitive-data.policy';
import { assistantIdempotencyKey } from '@/services/verebona-assistant/core/assistant-cache-key';
import { VEREBONA_INTENTS, type VerebonaIntent } from '@/services/verebona-assistant/types/intents';
import { getIntentDefinition } from '@/services/verebona-assistant/registries/intent-registry';
import type { AssistantRequestInput, IntentRoute } from '@/services/verebona-assistant/types/contracts';
import { T2UnderstandOutput } from './t2-contract';
import { t2MasterVariables } from './t2-answer';

const SCHEMA_DESCRIPTION =
  '{"mode":"UNDERSTAND","intent":"<intention du catalogue>","confidence":"exact"|"probable"|"ambiguous",'
  + '"entityHints":[{"type":"asset","value":"…"}],"requestedFacts":["<clé du FIELD_CATALOG>"],"requestedTopics":[],'
  + '"filters":{"documentType":null,"periodStart":null,"periodEnd":null,"unlinked":null,"status":null,"supplier":null,"upcoming":null},"reason":"…"}';

/** Borne du contexte conversationnel transmis (caractères). */
const MAX_CONVERSATION_CHARS = 2000;

/** Indices acceptés par la route (types de `IntentRoute.entityHints`). */
type RouteHintType = IntentRoute['entityHints'][number]['type'];
const HINT_TYPES: Record<string, RouteHintType> = {
  asset: 'asset', document: 'document', agenda: 'agenda', supplier: 'supplier', help: 'help', period: 'period',
  // Désignations d'équipement ou de pièce : indices de BIEN, résolus par le serveur.
  equipment: 'asset', room: 'asset',
};

export interface T2Understanding {
  /** Forme attendue par `toIntentRoute` (classification.adapter, Y). */
  plan: {
    intent: VerebonaIntent;
    confidence: 'exact' | 'probable' | 'ambiguous';
    entityHints: Array<{ type: RouteHintType; value: string }>;
    reason: string;
  };
  /** Clés canoniques demandées, restreintes au FIELD_CATALOG (A4). */
  requestedFacts: string[];
  requestedTopics: string[];
  filters: T2UnderstandOutput['filters'];
  /** Réparation / escalade (trace). */
  events: string[];
}

/** Catalogue fermé des intentions, tel que le voit le modèle. */
export function describeIntentCatalog(): string {
  return VEREBONA_INTENTS.map((i) => `- ${i} : ${getIntentDefinition(i as VerebonaIntent).label}`).join('\n');
}

/** FIELD_CATALOG : clés canoniques et libellés (registre canonique, source unique). */
export function describeFieldCatalog(): string {
  const vus = new Set<string>();
  const lignes: string[] = [];
  for (const f of CANONICAL_FIELDS) {
    if (vus.has(f.key)) continue;
    vus.add(f.key);
    lignes.push(`- ${f.key} : ${f.label}`);
  }
  return lignes.join('\n');
}

const FIELD_KEYS = (): Set<string> => new Set(CANONICAL_FIELDS.map((f) => f.key));

/** Contrôles serveur de la sortie validée. Pure. */
export function toT2Understanding(out: T2UnderstandOutput, events: string[] = []): T2Understanding {
  const cles = FIELD_KEYS();
  const facts = [...new Set(out.requestedFacts.filter((k) => cles.has(k)))];
  const horsCatalogue = out.requestedFacts.filter((k) => !cles.has(k));
  return {
    plan: {
      intent: out.intent as VerebonaIntent,
      confidence: out.confidence,
      entityHints: out.entityHints
        .filter((h) => !h.value.trim().toLowerCase().startsWith('page:'))
        .map((h) => ({ type: HINT_TYPES[h.type] ?? 'asset', value: h.value }))
        .slice(0, 10),
      reason: out.reason,
    },
    requestedFacts: facts,
    requestedTopics: [...out.requestedTopics, ...horsCatalogue].slice(0, 20),
    filters: out.filters,
    events: horsCatalogue.length ? [...events, `T2_UNDERSTAND:FACTS_OUT_OF_CATALOG:${horsCatalogue.length}`] : events,
  };
}

/**
 * Classe la question par le master T2 (MODE=UNDERSTAND). Rend `null` en cas
 * d'échec — jamais une exception (même contrat que `classifyAssistantIntent`).
 */
export async function understandWithT2Master(
  message: string,
  input: AssistantRequestInput,
): Promise<T2Understanding | null> {
  if (!message.trim()) return null;
  try {
    const besoin = sensitiveNecessityFor(message);
    const conversation = input.threadContextText
      ? maskSensitiveText(input.threadContextText, besoin).text.replace(/</g, '&lt;').slice(-MAX_CONVERSATION_CHARS)
      : '(nouvelle conversation, aucun échange précédent)';
    const page = input.pageContext
      ? JSON.stringify({
        route: input.pageContext.route ?? null,
        assetId: input.pageContext.assetId ?? null,
        documentId: input.pageContext.documentId ?? null,
        supplierId: input.pageContext.supplierId ?? null,
      })
      : '(aucun contexte de page)';
    const variables = t2MasterVariables('UNDERSTAND', {
      QUESTION: maskSensitiveText(message, besoin).text.replace(/</g, '&lt;'),
      INTENTS: describeIntentCatalog(),
      FIELD_CATALOG: describeFieldCatalog(),
      PAGE_CONTEXT: page,
      CONVERSATION_CONTEXT: conversation,
    });
    const { res, events } = await callWithRepairOrEscalation({
      budget: input.aiBudget,
      schemaDescription: SCHEMA_DESCRIPTION,
      build: (v) => {
        // Réparation : jointe au contexte conversationnel (emplacement serveur),
        // jamais au catalogue ni à la question.
        const promptVariables = v.repair
          ? { ...variables, CONVERSATION_CONTEXT: `${conversation}\n\n${repairInstruction(SCHEMA_DESCRIPTION, v.repair)}` }
          : variables;
        const cle = assistantIdempotencyKey(input, 't2_understand', promptVariables);
        return {
          useCaseCode: 'INTELLIGENT_ASSISTANT' as const,
          operationCode: 't2_understand',
          accountId: input.accountId,
          userId: input.userId,
          promptVariables,
          outputSchema: T2UnderstandOutput,
          idempotencyKey: cle && v.escalation ? `${cle}:escalation` : cle,
        };
      },
      trace: {
        requestId: input.requestId ?? input.clientRequestId,
        routeReason: 'classification : aucune règle déterministe (master T2)',
        promptId: 't2_master_v1', promptVersion: 'UNDERSTAND',
      },
    });
    const r = toT2Understanding(res.data as T2UnderstandOutput, events.map((e) => `CLASSIFICATION:${e}`));
    input.aiReport?.events.push(...r.events);
    return r;
  } catch (e) {
    const detail = isAiGatewayError(e) ? `${e.code} — ${e.message}` : (e as Error).message;
    console.warn(`[assistant] Classification master indisponible (${detail}) — intention inconnue.`);
    return null;
  }
}
