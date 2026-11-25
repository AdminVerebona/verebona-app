/**
 * Carte Trello #837 (points B4 et C2) — VERSION DES PREUVES D'UN DOCUMENT T1.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI
 *
 * L'empreinte des preuves du lot 115H (`requeueEvidenceFingerprint`) ne
 * retenait que des CODES et des COMPTEURS (état de qualité, anomalies, nombre
 * d'unités non résolues, pages manquantes, empreinte du fichier, version de
 * couche). Une modification significative qui laisse ces compteurs égaux —
 * décision de valeur changée, fait corrigé, candidat modifié, cellule de
 * tableau, provenance (ancrage) ré-écrite, nouveau texte original d'un même
 * fichier — était donc INVISIBLE : la campagne et les demandes de reprise la
 * considéraient comme « déjà vue ».
 *
 * CE QUE CE MODULE APPORTE
 *
 * Une empreinte STABLE et VERSIONNÉE (`EVIDENCE_DEPENDENCIES_VERSION`) des
 * données EFFECTIVEMENT confrontées par la réconciliation, la re-vérification
 * et la règle des reprises, table par table :
 *   · faits (valeurs, libellés, clés, extrait, emplacement, ancrages
 *     `source_unit_ids`, statut, confiance) ;
 *   · décisions de valeur (unité, nature, valeur normalisée, décision,
 *     validité, statut) ;
 *   · candidats « événement de référence » (clé, contenu, statut) ;
 *   · cellules de tableau ;
 *   · unités de la couche A — leur IDENTITÉ et leur CONTENU (texte, valeur,
 *     emplacement), JAMAIS leur état de couverture : ce dernier est le
 *     RÉSULTAT du recalcul, pas une preuve ;
 *   · métadonnées de l'extraction (montant, date, fournisseur, version de
 *     prompt, texte intégral) et extraction brute du fichier (empreinte du
 *     fichier ET du texte original lu).
 *
 * Le hachage est calculé EN BASE (`md5` ligne à ligne, puis sur la liste
 * ordonnée) : aucun contenu de document ne transite ni n'est journalisé ici,
 * seule l'empreinte hexadécimale est rendue. Une table absente (schéma
 * ancien) donne la marque `absent` — jamais une erreur, jamais une empreinte
 * vide confondue avec « aucune donnée ».
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'node:crypto';

/** Version de la définition de l'empreinte : la changer invalide toutes les empreintes stockées. */
export const EVIDENCE_DEPENDENCIES_VERSION = 2;

type Sql = { unsafe: (q: string, p?: never[]) => Promise<unknown> };
type Row = Record<string, unknown>;

/**
 * Projection hachée de chaque table : SEULES les colonnes lues par la
 * confrontation (pas d'horodatage technique, pas d'identifiant de ligne
 * réattribué à la réécriture de couche, pas d'état de couverture calculé).
 * `to_jsonb(t) -> 'col'` : une colonne absente d'un schéma ancien vaut NULL
 * au lieu de faire échouer la lecture.
 */
const DEPENDANCES: ReadonlyArray<{ part: string; table: string; projection: string; order: string }> = [
  {
    part: 'facts', table: 'document_facts',
    projection: `jsonb_build_array(t.id, to_jsonb(t)->'status', to_jsonb(t)->'confidence', to_jsonb(t)->'value_text',
      to_jsonb(t)->'normalized_value', to_jsonb(t)->'raw_value', to_jsonb(t)->'value_number', to_jsonb(t)->'label',
      to_jsonb(t)->'attribute', to_jsonb(t)->'fact_key', to_jsonb(t)->'canonical_key', to_jsonb(t)->'raw_key',
      to_jsonb(t)->'excerpt', to_jsonb(t)->'location', to_jsonb(t)->'source_unit_ids', to_jsonb(t)->'evidence_origin')`,
    order: 't.id',
  },
  {
    part: 'decisions', table: 'document_value_decisions',
    projection: `jsonb_build_array(t.id, to_jsonb(t)->'status', to_jsonb(t)->'validity', to_jsonb(t)->'source_unit_id',
      to_jsonb(t)->'value_kind', to_jsonb(t)->'normalized_value', to_jsonb(t)->'raw_value', to_jsonb(t)->'decision',
      to_jsonb(t)->'related_fact_ids', to_jsonb(t)->'related_candidate_keys')`,
    order: 't.id',
  },
  {
    part: 'candidates', table: 'document_operation_candidates',
    projection: `jsonb_build_array(t.id, to_jsonb(t)->'status', to_jsonb(t)->'candidate_key', to_jsonb(t)->'payload')`,
    order: 't.id',
  },
  {
    part: 'tables', table: 'document_table_cells',
    projection: `(to_jsonb(t) - 'created_at' - 'updated_at')`,
    order: 't.id',
  },
  {
    // Ancrages : identité et contenu des unités, jamais leur état de couverture (résultat du recalcul).
    part: 'anchors', table: 'document_source_units',
    projection: `jsonb_build_array(t.source_unit_id, t.kind, t.page, t.ordinal, t.parent_unit_id, md5(coalesce(t.content_text, '')),
      t.label, t.value_text, t.payload, t.location, t.salient)`,
    order: 't.source_unit_id',
  },
  {
    part: 'extraction', table: 'document_extractions',
    projection: `jsonb_build_array(to_jsonb(t)->'amount_cents', to_jsonb(t)->'document_date', to_jsonb(t)->'supplier_siret',
      to_jsonb(t)->'supplier_name', to_jsonb(t)->'prompt_version', md5(coalesce(to_jsonb(t)->>'full_text', '')))`,
    order: 't.id',
  },
  {
    // Nouveau texte original d'un même fichier : l'empreinte du fichier ne bouge pas, celle du texte lu, si.
    part: 'raw', table: 'document_raw_extracts',
    projection: `jsonb_build_array(to_jsonb(t)->'source_sha256', md5((to_jsonb(t) - 'created_at' - 'updated_at' - 'id')::text))`,
    order: 't.id',
  },
];

export interface EvidenceDependencies {
  version: number;
  /** Empreinte globale (préfixée par la version). */
  fingerprint: string;
  /** Empreinte par famille de preuve (`absent` : table absente ou illisible). */
  parts: Record<string, string>;
}

/** Combinaison pure des empreintes par famille (testée). */
export function combineEvidenceParts(parts: Readonly<Record<string, string>>): string {
  const cles = Object.keys(parts).sort();
  const h = createHash('sha256').update(cles.map((k) => `${k}=${parts[k]}`).join('\u0001')).digest('hex').slice(0, 32);
  return `e${EVIDENCE_DEPENDENCIES_VERSION}:${h}`;
}

/**
 * Empreinte de TOUTES les dépendances lues d'un document (compte ET document :
 * aucune lecture intercomptes). Ne lève jamais.
 */
export async function loadEvidenceDependencies(sql: Sql, accountId: number, fileId: number): Promise<EvidenceDependencies> {
  const parts: Record<string, string> = {};
  // Présence des tables lue d'abord : dans une transaction, une table absente ferait échouer TOUTE la transaction.
  let presentes: Set<string>;
  try {
    const r = (await sql.unsafe(
      `/* c837:evidence-tables */ SELECT t AS name FROM unnest($1::text[]) t WHERE to_regclass(t) IS NOT NULL`,
      [DEPENDANCES.map((d) => d.table)] as never[],
    )) as Row[];
    presentes = new Set(r.map((x) => String(x.name)));
    // Double de test sans réponse : toutes les tables sont tentées (chaque lecture reste tolérante hors transaction).
    if (r.length === 0) presentes = new Set(DEPENDANCES.map((d) => d.table));
  } catch {
    presentes = new Set(DEPENDANCES.map((d) => d.table));
  }
  for (const d of DEPENDANCES) {
    if (!presentes.has(d.table)) { parts[d.part] = 'absent'; continue; }
    try {
      const rows = (await sql.unsafe(
        `/* c837:evidence-deps */ SELECT md5(coalesce(string_agg(md5((${d.projection})::text), ',' ORDER BY ${d.order}), '')) AS h,
                COUNT(*)::int AS n
           FROM ${d.table} t WHERE t.account_id = $1 AND t.file_id = $2`,
        [accountId, fileId] as never[],
      )) as Row[];
      const r = rows[0];
      parts[d.part] = r && typeof r.h === 'string' ? `${Number(r.n ?? 0)}:${r.h}` : 'absent';
    } catch {
      parts[d.part] = 'absent';
    }
  }
  return { version: EVIDENCE_DEPENDENCIES_VERSION, fingerprint: combineEvidenceParts(parts), parts };
}
