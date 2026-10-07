/**
 * Recherche documentaire d'UN champ manquant — cascade par champ (ticket 12
 * §G, lot 29).
 *
 * Ordre de vérité inchangé (§9) : la valeur canonique de la fiche prime ;
 * seulement quand elle est ABSENTE, un fait T1 du même champ (clé du
 * registre ou alias), extrait d'un document rattaché au bien, peut être
 * restitué — présenté comme « lu dans un document », jamais comme la valeur
 * de la fiche. Lecture ciblée par clé : ce n'est pas une recherche générique
 * de documents (ticket 8a §F).
 *
 * Prudence : texte seulement (une observation visuelle se revalide, elle ne
 * se cite pas), confiance certaine ou probable, et une seule valeur — deux
 * documents en désaccord ne donnent pas de réponse.
 */
import { pgClient } from '@/db';
import { getField, normalizeValue } from '@/services/canonical/registry';
import { canonicalKeyOf, formatCanonicalValue } from './field-reader';
import type { RetrievedSource } from '../types/sources';

export interface DocumentFieldFact {
  key: string;
  label: string;
  value: unknown;
  display: string;
  fileId: number;
  documentTitle: string | null;
  excerpt: string | null;
  confidence: string;
  sensitive: boolean;
}

interface Ligne {
  id: number; fileId: number; factKey: string | null; valueText: string | null; valueNumber: number | null;
  valueUnit: string | null; confidence: string; excerpt: string | null; title: string | null;
}

/** Valeur affichable d'un fait pour un champ du registre (pure). */
export function displayOfFact(key: string, f: Pick<Ligne, 'valueText' | 'valueNumber' | 'valueUnit'>): { value: unknown; display: string } | null {
  const def = getField(key);
  if (!def) return null;
  const brut = f.valueNumber !== null && f.valueNumber !== undefined && def.valueType !== 'string' && def.valueType !== 'date'
    ? f.valueNumber : f.valueText;
  if (brut === null || brut === undefined || String(brut).trim() === '') return null;
  const n = normalizeValue(key, brut);
  const value = n.ok ? n.value : brut;
  const display = formatCanonicalValue(def, value) ?? String(brut);
  return { value, display: n.ok || !f.valueUnit ? display : `${display} ${f.valueUnit}` };
}

/**
 * Fait documentaire d'un champ pour un bien du compte, ou `null` (aucun,
 * ou plusieurs valeurs en désaccord).
 */
export async function readDocumentFactForField(accountId: number, assetId: number, keyOrAlias: string): Promise<DocumentFieldFact | null> {
  const key = canonicalKeyOf(keyOrAlias);
  const def = key ? getField(key) : undefined;
  if (!key || !def || !def.assistantReadable) return null;
  const lignes = (await pgClient.unsafe(
    `SELECT f.id::float8 AS id, f.file_id AS "fileId", f.fact_key AS "factKey", f.value_text AS "valueText",
            f.value_number::float8 AS "valueNumber", f.value_unit AS "valueUnit", f.confidence, f.excerpt,
            coalesce(af.retained_title, af.original_filename) AS title
       FROM document_facts f
       JOIN asset_files af ON af.id = f.file_id AND af.account_id = $1 AND af.deleted_at IS NULL
      WHERE f.account_id = $1 AND f.status = 'active' AND f.fact_key IS NOT NULL
        AND coalesce(f.evidence_origin, 'TEXT_EXTRACTION') <> 'VISUAL_ANALYSIS'
        AND f.confidence IN ('certain', 'probable')
        AND (af.asset_id = $2 OR af.linked_asset_id = $2
             OR EXISTS (SELECT 1 FROM document_asset_links l WHERE l.account_id = af.account_id AND l.file_id = af.id
                         AND l.status = 'ACTIVE' AND l.asset_id = $2))
      ORDER BY (f.confidence = 'certain') DESC, af.document_date DESC NULLS LAST, f.id DESC
      LIMIT 300`,
    [accountId, assetId] as never[],
  )) as unknown as Ligne[];
  const retenus = lignes.filter((l) => l.factKey && canonicalKeyOf(l.factKey) === key)
    .map((l) => ({ l, v: displayOfFact(key, l) }))
    .filter((x): x is { l: Ligne; v: { value: unknown; display: string } } => x.v !== null);
  if (retenus.length === 0) return null;
  const valeurs = new Set(retenus.map((x) => x.v.display.toLowerCase()));
  if (valeurs.size > 1) return null;
  const { l, v } = retenus[0];
  return {
    key, label: def.label, value: v.value, display: v.display, fileId: Number(l.fileId), documentTitle: l.title,
    excerpt: l.excerpt, confidence: l.confidence, sensitive: def.sensitive === true,
  };
}

/** Source vérifiable du fait documentaire ; valeur sensible jamais en clair (modèle, traces). */
export function documentFactSource(f: DocumentFieldFact, assetId: number): RetrievedSource {
  const valeur = f.sensitive ? '(donnée protégée)' : f.display;
  const extrait = !f.sensitive && f.excerpt ? ` — « ${f.excerpt.slice(0, 200)} »` : '';
  return {
    id: `doc_${f.fileId}`,
    type: 'document',
    title: f.documentTitle ?? 'Document',
    content: `${f.label} : ${valeur}${extrait}`.slice(0, 1500),
    relevanceScore: 1,
    meta: { fileId: f.fileId, assetId, fieldKey: f.key, sensitive: f.sensitive, display: f.sensitive ? null : f.display },
  };
}
