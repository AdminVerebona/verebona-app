/**
 * Contrat d'EXÉCUTION de T4 — lot 34D (ticket « T4 : découpler le contrat
 * d'exécution du texte du prompt maître »). T4 UNIQUEMENT.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CONTRAT D'ENTRÉE STRICT + PROMPT MÉTIER LIBRE + CONTRAT DE SORTIE STRICT
 *
 * Le prompt maître T4 ne transporte plus les données : en mode
 * STRUCTURED_CONTEXT, le serveur construit le contexte d'exécution à partir
 * de ce contrat, le VALIDE avant tout appel fournisseur (0 appel si le
 * contrat est violé) et l'injecte une seule fois, dans un bloc
 * `EXECUTION_CONTEXT` déterministe. Le prompt n'a plus besoin d'aucun
 * emplacement `{{X}}` ni d'aucun titre imposé (« BRANCHE TASK = … ») : il
 * porte seulement le rôle, les règles métier et la logique des TASK.
 *
 * Ce module DÉCRIT le contrat (données) ; le mécanisme est générique
 * (`master-prompts/structured-context.ts`) : un autre traitement pourrait un
 * jour déclarer le sien après audit, sans `if (T4)` dans le moteur.
 *
 * Exigences par TASK — alignées sur les appelants RÉELS (aucune sémantique
 * modifiée) :
 *
 *   champ                 CLASSIFY_EVENT        VERIFY_COMPLETION      TEMPORAL_AMBIGUITY
 *   ────────────────────  ────────────────────  ─────────────────────  ──────────────────
 *   task                  imposé par le serveur (toutes les branches)
 *   event_context         requis (objet)        —                      —
 *   event_catalog         requis (liste ≥ 1)    —                      —
 *   evidence              optionnel, nullable   requis (objet :        —
 *                         (extrait ≤ 500 car.)  excerpt, dates)
 *   agenda_item           —                     requis (objet)         —
 *   document_type         —                     requis (objet)         —
 *   temporal_context      —                     —                      requis (objet)
 *   temporal_candidates   —                     —                      requis (liste ≥ 1)
 *
 * « — » : sans objet pour la branche — jamais injecté (aucune donnée
 * dupliquée ni transmise inutilement). Sources : `classify-event.ts`,
 * `verify-completion.ts`, `temporal-ambiguity.ts` (variables historiques
 * `EVENT_CONTEXT`, `EVIDENCE`… : mêmes données, mêmes formes).
 *
 * Contrat de SORTIE : les contrats runtime du registre (`t4-contract.ts`,
 * `gateway/output-resolution/runtime-contract.ts`) — même mécanisme que T1 à
 * T6 (schéma fournisseur dérivé, validation, réparation, replis).
 *
 * Versions INDÉPENDANTES (ticket « Versioning indépendant ») : le prompt
 * (version BO), `t4_input_vN` et `t4_output_vN` évoluent séparément.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { z } from 'zod';
import type { StructuredContextSpec } from '../../master-prompts/structured-context';
import { T4_MASTER_PROMPT_CODE, T4_OPTIONAL_TASKS, T4_TASKS } from './t4-contract';
import { RECURRENCE_MODES } from '../rules/recurrence';
import { T4AgendaRepresentationInput } from '@/services/business-operations/semantic/contract';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Contrat d'entrée T4 v1 (lot 34D) : formes des données fournies par les appelants actuels. */
const T4_INPUT_V1_FIELDS = {
  document_type: {
    legacyVariable: 'DOCUMENT_TYPE',
    description: 'Type du document de preuve (code, libellé, preuves de réalisation admises).',
    schema: z.looseObject({
      code: z.string().nullable(),
      label: z.string().nullable(),
      completionProofs: z.array(z.unknown()),
    }),
  },
  agenda_item: {
    legacyVariable: 'AGENDA_ITEM',
    description: 'Occurrence agenda à vérifier (titre, date, type métier, récurrence, fenêtre serveur).',
    schema: z.looseObject({ title: z.string().min(1), date: z.string().min(1) }),
  },
  event_catalog: {
    legacyVariable: 'EVENT_CATALOG',
    description: 'Catalogue fermé des types métier (businessType, libellé, natures).',
    schema: z.array(z.looseObject({ businessType: z.string().min(1), label: z.string(), natures: z.array(z.string()) })).min(1),
  },
  event_context: {
    legacyVariable: 'EVENT_CONTEXT',
    description: 'Événement à classer (titre, date, description, champ d’origine, nature, type métier).',
    schema: z.looseObject({ title: z.string().min(1), date: z.string().nullable().optional() }),
  },
  evidence: {
    legacyVariable: 'EVIDENCE',
    description: 'Preuve : extrait court (CLASSIFY_EVENT) ou preuve ciblée datée (VERIFY_COMPLETION).',
    schema: z.union([z.string(), z.looseObject({ excerpt: z.string() })]),
  },
  temporal_candidates: {
    legacyVariable: 'TEMPORAL_CANDIDATES',
    description: 'Candidats temporels fournis par le serveur (identifiant, date, interprétation).',
    schema: z.array(z.object({ candidateId: z.number().int().positive(), date: isoDate, interpretation: z.string() })).min(1),
  },
  temporal_context: {
    legacyVariable: 'TEMPORAL_CONTEXT',
    description: 'Contexte de l’ambiguïté de date (titre, extrait, date extraite, mention).',
    schema: z.looseObject({}),
  },
} as const;

/**
 * Lot 54 — candidat de récurrence transmis à T4 (ticket « T4 décisionnaire »,
 * §1) : le serveur DIT pourquoi il envisage une récurrence (mention de la
 * source, ou dates passées régulières) ; T4 décide (`recurrenceDecision`). Aucun
 * extrait documentaire long : `excerpt` ≤ 300 caractères.
 */
const recurrenceCandidateSchema = z.object({
  mode: z.enum(RECURRENCE_MODES),
  frequency: z.string().min(1),
  interval: z.number().int().positive(),
  startDate: isoDate.nullable().optional(),
  endDate: isoDate.nullable().optional(),
  occurrenceCount: z.number().int().positive().nullable().optional(),
  excerpt: z.string().max(300).nullable().optional(),
  history: z.array(isoDate).optional(),
}).nullable();

/**
 * Contrat d'entrée T4 v2 (lot 54) : v1 + `event_context.recurrenceCandidate`,
 * `event_context.documentType` et `document_type` OPTIONNEL pour
 * CLASSIFY_EVENT. VERIFY_COMPLETION et TEMPORAL_AMBIGUITY : inchangés.
 */
const T4_INPUT_V2_FIELDS = {
  ...T4_INPUT_V1_FIELDS,
  event_context: {
    legacyVariable: 'EVENT_CONTEXT',
    description: 'Événement à classer (titre, date, description, champ d’origine, nature, type métier, type documentaire) et récurrence envisagée par le serveur (`recurrenceCandidate` : mode, fréquence, intervalle, bornes, historique), ou null.',
    schema: z.looseObject({
      title: z.string().min(1),
      date: z.string().nullable().optional(),
      documentType: z.string().nullable().optional(),
      recurrenceCandidate: recurrenceCandidateSchema,
    }),
  },
} as const;

/**
 * Contrat d'entrée T4 v3 (lot 97A) : v2 + `agenda_representation` pour la
 * branche FACULTATIVE AGENDA_REPRESENTATION (demande
 * `87B-t4-representation-agenda-multi-evenements`) — contexte large et borné
 * de la réévaluation sémantique d'une Opération (`semantic/context.ts`).
 * Les trois branches historiques sont inchangées.
 */
const T4_INPUT_V3_FIELDS = {
  ...T4_INPUT_V2_FIELDS,
  agenda_representation: {
    legacyVariable: 'AGENDA_REPRESENTATION',
    description: 'Représentation Agenda d’une Opération (contrat t4-agenda-representation-v1) : Opération examinée (O1) et voisines, éléments d’agenda (A…, `inScope` = à décider), éléments restaurables (R…), documents (D…), décisions de l’utilisateur, décisions antérieures, bornes du contexte.',
    schema: T4AgendaRepresentationInput,
  },
} as const;

const T4_V2_TASK_RULES = {
  CLASSIFY_EVENT: {
    required: ['event_context', 'event_catalog'],
    optional: ['evidence', 'document_type'],
    schemas: {
      evidence: z.string().max(2000).nullable(),
      document_type: z.looseObject({ code: z.string().nullable(), label: z.string().nullable() }),
    },
  },
  VERIFY_COMPLETION: {
    required: ['agenda_item', 'document_type', 'evidence'],
    optional: [],
    schemas: {
      evidence: z.looseObject({ excerpt: z.string(), documentDate: isoDate.nullable(), occurrenceDate: isoDate.nullable() }),
    },
  },
  TEMPORAL_AMBIGUITY: {
    required: ['temporal_context', 'temporal_candidates'],
    optional: [],
  },
} as const;

export const T4_EXECUTION_SPEC: StructuredContextSpec = {
  masterPromptCode: T4_MASTER_PROMPT_CODE,
  treatment: 'T4',
  knownTasks: [...T4_TASKS, ...T4_OPTIONAL_TASKS],
  optionalTasks: [...T4_OPTIONAL_TASKS],
  inputContracts: {
    t4_input_v1: {
      version: 't4_input_v1',
      fields: T4_INPUT_V1_FIELDS,
      tasks: {
        CLASSIFY_EVENT: {
          required: ['event_context', 'event_catalog'],
          optional: ['evidence'],
          schemas: { evidence: z.string().max(2000).nullable() },
        },
        VERIFY_COMPLETION: {
          required: ['agenda_item', 'document_type', 'evidence'],
          optional: [],
          schemas: {
            evidence: z.looseObject({ excerpt: z.string(), documentDate: isoDate.nullable(), occurrenceDate: isoDate.nullable() }),
          },
        },
        TEMPORAL_AMBIGUITY: {
          required: ['temporal_context', 'temporal_candidates'],
          optional: [],
        },
      },
    },
    t4_input_v2: {
      version: 't4_input_v2',
      fields: T4_INPUT_V2_FIELDS,
      tasks: {
        CLASSIFY_EVENT: {
          required: ['event_context', 'event_catalog'],
          optional: ['evidence', 'document_type'],
          schemas: {
            evidence: z.string().max(2000).nullable(),
            // Type documentaire de la source, s'il est connu (sans preuves de réalisation).
            document_type: z.looseObject({ code: z.string().nullable(), label: z.string().nullable() }),
          },
        },
        VERIFY_COMPLETION: {
          required: ['agenda_item', 'document_type', 'evidence'],
          optional: [],
          schemas: {
            evidence: z.looseObject({ excerpt: z.string(), documentDate: isoDate.nullable(), occurrenceDate: isoDate.nullable() }),
          },
        },
        TEMPORAL_AMBIGUITY: {
          required: ['temporal_context', 'temporal_candidates'],
          optional: [],
        },
      },
    },
    // Lot 97A : v2 + AGENDA_REPRESENTATION (branche facultative, choisie explicitement au BO).
    t4_input_v3: {
      version: 't4_input_v3',
      fields: T4_INPUT_V3_FIELDS,
      tasks: {
        ...T4_V2_TASK_RULES,
        AGENDA_REPRESENTATION: { required: ['agenda_representation'], optional: [] },
      },
    },
  },
  outputContracts: {
    t4_output_v1: {
      version: 't4_output_v1',
      byTask: {
        CLASSIFY_EVENT: { schemaName: 'T4ClassifyEventOutput', contractVersion: 1 },
        VERIFY_COMPLETION: { schemaName: 'T4VerifyCompletionOutput', contractVersion: 1 },
        TEMPORAL_AMBIGUITY: { schemaName: 'T4TemporalAmbiguityOutput', contractVersion: 1 },
      },
    },
    // Lot 54 : CLASSIFY_EVENT décide de l'existence Agenda et de la récurrence.
    t4_output_v2: {
      version: 't4_output_v2',
      byTask: {
        CLASSIFY_EVENT: { schemaName: 'T4ClassifyEventV2Output', contractVersion: 2 },
        VERIFY_COMPLETION: { schemaName: 'T4VerifyCompletionOutput', contractVersion: 1 },
        TEMPORAL_AMBIGUITY: { schemaName: 'T4TemporalAmbiguityOutput', contractVersion: 1 },
      },
    },
    // Lot 61 : CLASSIFY_EVENT évalue aussi l'intervention « À traiter »
    // demandée par le serveur (`event_context.toProcessAssessment`).
    t4_output_v3: {
      version: 't4_output_v3',
      byTask: {
        CLASSIFY_EVENT: { schemaName: 'T4ClassifyEventV3Output', contractVersion: 3 },
        VERIFY_COMPLETION: { schemaName: 'T4VerifyCompletionOutput', contractVersion: 1 },
        TEMPORAL_AMBIGUITY: { schemaName: 'T4TemporalAmbiguityOutput', contractVersion: 1 },
      },
    },
    // Lot 97A : v3 + AGENDA_REPRESENTATION (représentation Agenda multi-événements, contrat t4-agenda-representation-v1).
    t4_output_v4: {
      version: 't4_output_v4',
      byTask: {
        CLASSIFY_EVENT: { schemaName: 'T4ClassifyEventV3Output', contractVersion: 3 },
        VERIFY_COMPLETION: { schemaName: 'T4VerifyCompletionOutput', contractVersion: 1 },
        TEMPORAL_AMBIGUITY: { schemaName: 'T4TemporalAmbiguityOutput', contractVersion: 1 },
        AGENDA_REPRESENTATION: { schemaName: 'T4AgendaRepresentationOutput', contractVersion: 1 },
      },
    },
  },
  // Lot 97A : défauts INCHANGÉS (v2 / v3, trois TASK) — AGENDA_REPRESENTATION n'est jamais autorisée
  // par défaut ; le PO la coche au BO avec t4_input_v3 / t4_output_v4 (guide du PO).
  // Fichier du dépôt (`t4_master_v1.txt`, sans emplacement — texte de
  // référence v2 depuis le lot 54) et nouvelles versions créées depuis ce
  // texte : contexte structuré v2 (lot 61 : sortie `t4_output_v3`). Une
  // version BO active antérieure garde SA configuration (v2 : lue sans
  // intervention, variante prudente). Une version BO antérieure au lot 34D reste
  // LEGACY_TEMPLATE (migration 0290, explicite) ; une version structurée v1
  // reste v1 (réactivable).
  defaults: {
    mode: 'STRUCTURED_CONTEXT',
    inputContractVersion: 't4_input_v2',
    outputContractVersion: 't4_output_v3',
    allowedTasks: [...T4_TASKS],
  },
  errorCodes: {
    missingField: 'T4_INPUT_CONTRACT_MISSING_FIELD',
    invalidType: 'T4_INPUT_CONTRACT_INVALID_TYPE',
    taskNotAllowed: 'T4_TASK_NOT_ALLOWED',
    outputMissing: 'T4_OUTPUT_CONTRACT_MISSING',
    versionNotFound: 'T4_CONTRACT_VERSION_NOT_FOUND',
    buildFailed: 'T4_EXECUTION_CONTEXT_BUILD_FAILED',
  },
};
