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
import { T4_MASTER_PROMPT_CODE, T4_TASKS } from './t4-contract';

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

export const T4_EXECUTION_SPEC: StructuredContextSpec = {
  masterPromptCode: T4_MASTER_PROMPT_CODE,
  treatment: 'T4',
  knownTasks: [...T4_TASKS],
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
  },
  // Fichier du dépôt (`t4_master_v1.txt`, sans emplacement) et nouvelles
  // versions du BO : contexte structuré. Une version BO antérieure au lot 34D
  // reste LEGACY_TEMPLATE (migration 0290, explicite).
  defaults: {
    mode: 'STRUCTURED_CONTEXT',
    inputContractVersion: 't4_input_v1',
    outputContractVersion: 't4_output_v1',
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
