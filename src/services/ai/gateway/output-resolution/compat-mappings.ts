/**
 * Table de COMPATIBILITÉ explicite, versionnée et testée — lot 34D (ticket
 * « contrat runtime source unique de vérité », §« Normalisation limitée à
 * des règles explicites »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * RÈGLE
 *
 * Un mapping de compatibilité n'est jamais déduit d'une ressemblance de
 * noms. Il est :
 *   · EXPLICITE   — un contrat, un objet (chemin générique exact), un nom
 *                   source, un nom cible ;
 *   · VERSIONNÉ   — version de schéma source → version cible, et version de
 *                   la table (`COMPAT_TABLE_VERSION`) tracée avec chaque
 *                   exécution ;
 *   · TESTÉ       — chaque ligne a son test (RTC-05) ;
 *   · DÉTERMINISTE — appliqué seulement si la clé cible est ABSENTE (jamais
 *                   d'écrasement), seulement APRÈS un premier échec de
 *                   validation, et consigné (`compat_mapping`).
 *
 * Un nom de champ absent de cette table n'est JAMAIS renommé : la sortie
 * part en passe de réparation, avec le contrat runtime exact (RTC-06).
 *
 * Les équivalences d'ÉNUMÉRATION (PURCHASE_RECEIPT → RECEIPT) sont dans
 * `normalization-tables.ts` (`ENUM_SYNONYMS`), même version de table.
 * Les adaptateurs STRUCTURELS (format entier d'une ancienne version, T1 v1 →
 * v2) sont dans `contracts.ts`.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Versions de la table :
 *   1 — lot 33D : alias génériques et rapprochement casse/séparateurs (RETIRÉ) ;
 *   2 — lot 34D : renommages explicites par contrat et chemin ; synonymes
 *       d'énumération comparés à la casse près seulement.
 */
import type { OutputRepairStep } from '../diagnostics/taxonomy';

export const COMPAT_TABLE_VERSION = 2;

export interface FieldCompatMapping {
  /** Identifiant stable, cité dans les traces (`t1_document_date_to_documentDate`). */
  id: string;
  /** Contrats concernés (nom de schéma du registre). */
  contracts: readonly string[];
  /** Objet porteur, en chemin générique exact (`$`, `$.document`, `$.facts[*]`). */
  parentPath: string;
  from: string;
  to: string;
  /** Version de schéma où `from` était le nom attendu. */
  fromSchemaVersion: string;
  /** Version de schéma où `to` le remplace. */
  toSchemaVersion: string;
  description: string;
}

/**
 * Lignes de la table. Ajouter une ligne = incrémenter `COMPAT_TABLE_VERSION`
 * et ajouter son test (RTC-05).
 */
export const FIELD_COMPAT_MAPPINGS: readonly FieldCompatMapping[] = [
  {
    // Audit T1 (lot 34D) : le CDC historique (format « domaine » d'avant le
    // prompt maître, `SourceAnalysisResult.document.date`) nommait la date du
    // document `document.date`. Le contrat MODÈLE l'appelle `documentDate`
    // depuis le prompt maître (lot 12, t1_analyze_document@v2) — évolution
    // légitime : le mapper (`to-source-analysis-result.ts`) la reporte
    // explicitement dans `document.date` du domaine. Une sortie produite avec
    // l'ancien nom est migrée par CETTE ligne, et seulement elle.
    id: 't1_document_date_to_documentDate',
    contracts: ['T1AnalyzeDocumentOutput'],
    parentPath: '$.document',
    from: 'date',
    to: 'documentDate',
    fromSchemaVersion: 'cdc-historique (document.date)',
    toSchemaVersion: 't1_analyze_document@v2',
    description: 'Date du document : ancien nom `document.date` → `document.documentDate`.',
  },
];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Lignes applicables à un contrat. */
export function fieldMappingsFor(schemaName: string | null | undefined): FieldCompatMapping[] {
  if (!schemaName) return [];
  return FIELD_COMPAT_MAPPINGS.filter((m) => m.contracts.includes(schemaName));
}

/** Segments d'un chemin générique (`$.facts[*].target` → ['facts', '*', 'target']). */
function segments(path: string): string[] {
  return path.replace(/^\$\.?/, '').replace(/\[\*\]/g, '.*').split('.').filter(Boolean);
}

/** Objets d'une valeur désignés par un chemin générique (`*` = chaque élément). */
function objectsAt(root: unknown, segs: string[]): Array<{ obj: Obj; path: string }> {
  let cur: Array<{ v: unknown; path: string }> = [{ v: root, path: '$' }];
  for (const s of segs) {
    const next: Array<{ v: unknown; path: string }> = [];
    for (const { v, path } of cur) {
      if (s === '*') {
        if (Array.isArray(v)) v.forEach((x, i) => next.push({ v: x, path: `${path}[${i}]` }));
      } else if (isObj(v) && s in v) {
        next.push({ v: v[s], path: `${path}.${s}` });
      }
    }
    cur = next;
  }
  return cur.filter((x): x is { v: Obj; path: string } => isObj(x.v)).map((x) => ({ obj: x.v, path: x.path }));
}

/**
 * Applique les renommages EXPLICITES d'un contrat à `value` (copie modifiée
 * en place par l'appelant). Une clé cible déjà présente n'est jamais écrasée.
 */
export function applyFieldCompatMappings(value: unknown, schemaName: string | null | undefined, report: OutputRepairStep[]): unknown {
  const lignes = fieldMappingsFor(schemaName);
  if (lignes.length === 0 || !isObj(value)) return value;
  for (const m of lignes) {
    for (const { obj, path } of objectsAt(value, segments(m.parentPath))) {
      if (!(m.from in obj) || obj[m.to] !== undefined) continue;
      obj[m.to] = obj[m.from];
      delete obj[m.from];
      report.push({
        stage: 'compat_mapping', rule: m.id, path: `${path}.${m.to}`,
        detail: `${m.from} → ${m.to} (${m.fromSchemaVersion} → ${m.toSchemaVersion}, table v${COMPAT_TABLE_VERSION})`,
      });
    }
  }
  return value;
}
