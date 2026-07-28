/**
 * Intelligence de l'agenda — USAGE IA n°4.
 *
 * Implémente la chaîne de décision du CDC §4.4.3, dans l'ordre imposé :
 *   1. règles déterministes
 *   2. interprétation des dates extraites
 *   3. comparaison aux événements existants
 *   4. règles métier
 *   5. appel IA uniquement sur cas ambigu
 *   6. création, mise à jour ou conflit
 *
 * Critère d'acceptation n°17. Le compteur `deterministic` de chaque décision
 * permet de vérifier en production qu'aucun appel n'est émis sur un cas tranché.
 */
import { z } from 'zod';
import { AiGateway } from '../gateway/ai-gateway';
import { classifyByRules } from './rules/deterministic-classification';
import { interpretDate } from './rules/date-interpreter';
import { findDuplicate } from './dedupe.service';
import type {
  AgendaDecision, ExistingAgendaItem, HomeCategory, AgendaClassificationInput,
} from './types';
import type { AgendaCandidate } from '../source-analysis/types';

const ClassifyEventOutput = z.object({
  category: z.enum(['action', 'information']),
  reason: z.string().max(300),
});

export interface AgendaIntelligenceInput {
  accountId: number;
  userId?: number;
  assetId: number | null;
  candidates: AgendaCandidate[];
  existing: ExistingAgendaItem[];
  sourceFileId?: number;
}

/** Types de documents autorisant une création automatique d'échéance (§4.4.4). */
const AUTHORIZED_CREATION_TYPES = new Set([
  'CERTIFICAT_IMMATRICULATION', 'CARTE_GRISE', 'CONTRAT_ASSURANCE', 'AVIS_ECHEANCE',
  'CERTIFICAT_GARANTIE', 'CONTRAT_LOA', 'CONTRAT_LLD', 'DPE', 'DIAGNOSTIC',
  'RAPPORT_ENTRETIEN', 'FACTURE',
]);

export async function processAgendaCandidates(
  input: AgendaIntelligenceInput,
): Promise<AgendaDecision[]> {
  const decisions: AgendaDecision[] = [];

  for (const candidate of input.candidates) {
    decisions.push(await processOne(candidate, input));
  }

  return decisions;
}

async function processOne(
  candidate: AgendaCandidate,
  input: AgendaIntelligenceInput,
): Promise<AgendaDecision> {
  const base = {
    title: candidate.title,
    date: candidate.date,
    confidence: candidate.confidence,
    sourceFileId: input.sourceFileId,
    originFieldKey: candidate.originFieldKey,
  };

  // ── Étape 2 : interprétation de la date ────────────────────────────────
  const date = interpretDate(candidate.date);
  if (date.qualification !== 'explicit') {
    return {
      ...base, action: 'propose', category: 'information',
      reasonCode: date.qualification === 'invalid' ? 'INVALID_DATE' : 'DATE_OUT_OF_RANGE',
      deterministic: true,
    };
  }

  // ── Étape 3 : comparaison aux événements existants ─────────────────────
  const duplicate = findDuplicate(
    { title: candidate.title, date: candidate.date, originFieldKey: candidate.originFieldKey },
    input.existing,
  );

  if (duplicate.kind === 'exact') {
    // Un doublon certain n'est jamais recréé (§4.4.4).
    return {
      ...base, action: 'skip_duplicate',
      category: duplicate.item?.category ?? 'information',
      reasonCode: 'EXACT_DUPLICATE', existingItemId: duplicate.item?.id,
      deterministic: true,
    };
  }

  if (duplicate.kind === 'probable' && duplicate.item) {
    // Une échéance créée manuellement n'est ni annulée ni modifiée
    // silencieusement : la contradiction remonte à l'utilisateur (§4.4.4).
    if (duplicate.item.manual) {
      return {
        ...base, action: 'create_conflict',
        category: duplicate.item.category ?? 'information',
        reasonCode: 'MANUAL_EVENT_DIVERGENCE', existingItemId: duplicate.item.id,
        deterministic: true,
      };
    }
    return {
      ...base, action: 'update',
      category: duplicate.item.category ?? await classify(candidate, input),
      reasonCode: 'PROBABLE_DUPLICATE_MERGED', existingItemId: duplicate.item.id,
      deterministic: true,
    };
  }

  // ── Étapes 1, 4 et 5 : classification, règles métier, appel ciblé ──────
  const category = await classify(candidate, input);
  const deterministic = classifyByRules(toClassificationInput(candidate)) !== null;

  // Une date explicite issue d'un document autorisé est créée automatiquement.
  const authorized = candidate.confidence === 'certain';
  return {
    ...base,
    action: authorized ? 'create' : 'propose',
    category,
    reasonCode: authorized ? 'EXPLICIT_DATE_AUTHORIZED_SOURCE' : 'INSUFFICIENT_CONFIDENCE',
    deterministic,
  };
}

/**
 * Étape 1 puis étape 5 : les règles d'abord, le modèle seulement si elles
 * n'ont pas tranché. En cas d'échec du modèle, repli sur `action` — mieux vaut
 * afficher une échéance dans « Prochaines dates » que la masquer, comportement
 * conservé de l'existant.
 */
async function classify(
  candidate: AgendaCandidate,
  input: AgendaIntelligenceInput,
): Promise<HomeCategory> {
  const byRules = classifyByRules(toClassificationInput(candidate));
  if (byRules !== null) return byRules;

  try {
    const res = await AiGateway.execute({
      useCaseCode: 'AGENDA_INTELLIGENCE',
      operationCode: 'classify_event',
      accountId: input.accountId,
      userId: input.userId,
      sourceIds: input.sourceFileId ? [input.sourceFileId] : undefined,
      promptVariables: {
        TITLE: candidate.title,
        EXCERPT: candidate.excerpt.slice(0, 500),
      },
      outputSchema: ClassifyEventOutput,
    });
    return res.data.category;
  } catch (e) {
    console.warn('[agenda] classification modèle indisponible :', (e as Error).message);
    return 'action';
  }
}

function toClassificationInput(candidate: AgendaCandidate): AgendaClassificationInput {
  return {
    title: candidate.title,
    originType: candidate.originFieldKey ? 'asset_field' : 'document',
    originFieldKey: candidate.originFieldKey ?? null,
  };
}

export { AUTHORIZED_CREATION_TYPES };
