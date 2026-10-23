/**
 * COH-DOC-EXTRACT-CHAIN — point d'extension DÉCLARÉ de la chaîne
 * « document → extract → T1 → aval » (arbitrage C-Q7, §3.2). Lot suivant.
 *
 * Statut PLANNED : jamais exécuté, jamais compté comme couvert — l'inventaire
 * de couverture le signale comme lacune explicite (CA-19 : un domaine non
 * contrôlé n'est jamais réputé conforme).
 *
 * Contrat prévu (C-Q7) — interroger l'extract PUIS confronter à T1 et à son
 * exploitation aval, et ne reprendre que le maillon défaillant :
 *   1. EXTRACT : extract absent, incomplet ou suspect (couverture des unités
 *      sources, `document_extraction_coverage`) → réextraction source par
 *      les services existants (`t1-completeness-retry`, relecture) ;
 *   2. T1 : fait significatif (montant, date, échéance, caractéristique)
 *      présent dans une unité source mais absent des faits / indices T1 →
 *      réinterprétation T1 CIBLÉE de ces unités (passe de réparation
 *      existante, `source-units/repair.ts`) — le contrat de sortie qui
 *      permettrait de distinguer « omis » de « non exploité à dessein » est
 *      demandé à l'équipe IA (`demandes-ia/82B-t1-omissions-extract.md`) ;
 *   3. aval : fait présent dans T1 mais non exploité → contrôles du registre
 *      du domaine concerné (TCO, « À traiter », liens, Agenda), sans
 *      réextraction (déjà en place : COH-TCO-EXTRACTED-EXPENSES,
 *      COH-TODO-DOCUMENT-FIELDS, COH-DOC-LINKS).
 * Garde-fous prévus : aucune relance systématique, aucune boucle (empreinte
 * des entrées), aucune information inventée, plafonds IA de la file.
 */
import type { CoherenceCheck } from '../types';

export const extractChainCheck: CoherenceCheck = {
  id: 'COH-DOC-EXTRACT-CHAIN',
  version: 0,
  status: 'PLANNED',
  title: 'Chaîne document → extract → T1 → aval (omissions de l’extraction)',
  domain: 'documents-t1',
  level: 'N3',
  objectType: 'document',
  scope: 'documents analysés du compte (unités sources, faits T1, indices financiers)',
  sources: ['document_raw_extracts', 'document_source_units', 'document_extraction_coverage', 'document_facts', 'document_unresolved_facts', 'document_operation_candidates'],
  applicability: 'lot suivant (C-Q7) — contrat T1 demandé à l’équipe IA',
  invariant: 'tout fait significatif présent dans l’extract est repris par T1 ou écarté avec un motif, puis exploité en aval',
  anomalies: ['EXTRACT_INCOMPLETE', 'FACT_OMITTED_BY_T1', 'FACT_NOT_EXPLOITED'],
  autoRepairWhen: 'maillon défaillant établi : réextraction source, réinterprétation T1 ciblée, ou réparation aval — jamais tous les maillons',
  forbiddenRepairs: ['relancer T1 sur tout le document sans diagnostic', 'inventer une valeur absente ou ambiguë', 'boucler sur une même omission'],
  services: ['ai/source-analysis/source-units/jobs (t1-completeness-retry)', 'ai/source-analysis/source-units/repair'],
  chain: ['EXTRACT', 'T1', 'T3', 'T4', 'PERSISTENCE'],
  triggers: ['SOURCE_ANALYZED'],
  frequency: 'à définir au lot suivant (mesures de coût IA)',
  criticality: 'HIGH',
  tests: [],
};
