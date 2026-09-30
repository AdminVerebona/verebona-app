/**
 * Contrat du prompt maître T5 — Prompt Control (CDC 15 §27, §29 étape 16,
 * T5-01, T5-02, MP-16).
 *
 * Une seule consigne (`t5_master_v1`, fichier du dépôt), deux modes imposés
 * par le serveur, discriminés par `mode` :
 *   · `ANALYZE` : diagnostic seul — tout `proposedContent` vaut null ;
 *   · `MODIFY`  : pour chaque cible prompt, le PROMPT MAÎTRE COMPLET réécrit.
 *
 * Cibles : T1, T2, T3, T4, T6 — JAMAIS T5 (« Tu ne modifies JAMAIS T5
 * lui-même »). T5 n'a pas de prompt administrable : son master est le
 * fichier du dépôt, jamais un texte de version de configuration (§10, T5-003).
 *
 * Sortie TOLÉRANTE sur la forme (listes bornées, textes tronqués) : une
 * valeur hors bornes ne doit pas faire échouer un appel de 2 minutes. Seuls
 * `mode`, `verdict` et la liste des cibles sont stricts ; le serveur filtre
 * ensuite (`interpretMaster`).
 */
import { z } from 'zod';

export const T5_MASTER_PROMPT_CODE = 't5_master_v1';
export const T5_MASTER_MODES = ['ANALYZE', 'MODIFY'] as const;
export type T5MasterMode = (typeof T5_MASTER_MODES)[number];

/** Emplacements du master (hors MODE, fixé par le serveur) — déclarés au registre. */
export { T5_MASTER_VARIABLES } from '@/services/ai/registry/operations';

/** §27 R1 : cinq verdicts, dont `mixed` (plusieurs chantiers). */
export const T5_VERDICTS = ['prompt', 'code', 'donnees', 'configuration', 'mixed'] as const;
export type T5Verdict = (typeof T5_VERDICTS)[number];

const liste = (max: number, len: number) =>
  z.array(z.string()).default([]).transform((a) => a.slice(0, max).map((s) => s.slice(0, len)));

const T5Target = z.object({
  treatment: z.string(),
  reason: z.string().default('').transform((s) => s.slice(0, 1000)),
  proposedContent: z.string().nullable().default(null),
});

const base = {
  verdict: z.enum(T5_VERDICTS),
  analysis: z.string().min(1).transform((s) => s.slice(0, 4000)),
  targets: z.array(T5Target).max(8).default([]),
  requiredCodeChanges: liste(15, 500),
  requiredSchemaChanges: liste(15, 500),
  configurationRecommendations: liste(15, 500),
  risks: liste(15, 500),
  requiredTests: liste(20, 500),
};

export const T5AnalyzeOutput = z.object({ mode: z.literal('ANALYZE'), ...base });
export const T5ModifyOutput = z.object({ mode: z.literal('MODIFY'), ...base });
export const T5MasterOutput = z.discriminatedUnion('mode', [T5AnalyzeOutput, T5ModifyOutput]);
export type T5MasterOutput = z.infer<typeof T5MasterOutput>;
