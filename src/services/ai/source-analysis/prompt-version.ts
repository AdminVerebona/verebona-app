/**
 * Version du prompt d'extraction T1 (`extract_source`) — une seule
 * déclaration pour le registre, les traces, les preuves et la connaissance.
 *
 * v4 : texte lu et observations visuelles distingués (provenance
 * TEXT_EXTRACTION / VISUAL_ANALYSIS, preuve visuelle sans faux extrait).
 * v5 : règle de titre R9 — « <Type> <ce qu'il concerne> », jamais un numéro
 *      seul (« Facture N° … » rendait les documents indiscernables).
 *      Nouveau code de prompt plutôt que retouche de v4 : une version v4
 *      ACTIVE en base (`ai_prompt_versions`) primerait sur le fichier.
 */
export const EXTRACT_SOURCE_PROMPT_VERSION = 'extract_source_v5';
