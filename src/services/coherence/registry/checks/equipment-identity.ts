/**
 * COH-EQUIPMENT-IDENTITY — identité PRODUIT d'un équipement (marque, série,
 * modèle, référence commerciale, désignation, numéro de série) — lot 101A
 * (ticket « Continuité conversationnelle et série d'un équipement », point H).
 *
 * Constats (lecture seule, sans IA) sur la fiche canonique de l'équipement
 * et les faits T1 actifs qui le CIBLENT :
 *   · IDENTITY_VALUE_INCOMPATIBLE         valeur d'une autre nature (prix,
 *     offre commerciale, date, VIN, libellé générique en modèle…) ;
 *   · INCOMPATIBLE_MODELS                 plusieurs modèles incompatibles dans
 *     les sources de l'équipement (MG23K3515AK ≠ MC32J7035AK) — une variante
 *     d'écriture ou une valeur plus précise n'en est pas un ;
 *   · STRUCTURED_VS_DOCUMENT_CONFLICT     modèle de la fiche incompatible avec
 *     un modèle établi par un document rattaché ;
 *   · SERIES_MODEL_REFERENCE_INCONSISTENT série / modèle / référence de la
 *     fiche qui ne désignent pas le même produit ;
 *   · PROPERTY_FROM_OTHER_OBJECT_DOCUMENT propriété issue d'un document
 *     rattaché à un AUTRE objet (et pas à celui-ci) ;
 *   · SECONDARY_PRODUCT_ON_PAGE           modèle projeté depuis une page
 *     fournisseur qui en présente un autre, compatible avec la fiche.
 *
 * Autoréparation (règles générales C-Q2) SEULEMENT si elle est FIABLE et que
 * la valeur est d'origine AUTOMATIQUE : valeur d'une autre nature retirée de
 * la fiche, libellé générique déplacé en désignation commerciale — par le
 * writer canonique (`writeCanonicalEntityFields`, origine SYSTEM_RULE,
 * contrôle optimiste, journal `canonical_field_writes`, annulable). Une
 * valeur saisie par l'utilisateur (USER, ADMIN, colonne historique) n'est
 * JAMAIS modifiée : constat seul. Les conflits de modèles restent des
 * conflits, avec leur provenance (faits, documents) — aucune valeur inventée.
 */
import type { CoherenceCheck, Inspection, RepairResult } from '../types';
import { hashOf, idsOf, intArray, rows } from '../util';
import {
  PRODUCT_IDENTITY_KEYS, compareProductCodes, groupProductCodes, identityValueProblem, productCodesIn, normalizeProductCode,
} from '@/services/canonical/product-identity';

export const EQUIPMENT_IDENTITY_CHECK_ID = 'COH-EQUIPMENT-IDENTITY';

const CLES = [...PRODUCT_IDENTITY_KEYS];
const HUMAINES = new Set(['USER', 'ADMIN', 'IMPORT']);

/** Valeur canonique d'une propriété d'identité (lue par la vue canonique). */
export interface IdentityField { key: string; value: string; origin: string }
/** Fait T1 actif qui cible l'équipement. */
export interface IdentityFact {
  factId: number; fileId: number; key: string; value: string; confidence: string;
  sourceType: string | null; ruleCode: string | null;
  /** Le document est rattaché à CET équipement / à un AUTRE objet seulement. */
  linkedToThis: boolean; linkedToOther: boolean;
}

export type IdentityAnomaly =
  | 'IDENTITY_VALUE_INCOMPATIBLE' | 'INCOMPATIBLE_MODELS' | 'STRUCTURED_VS_DOCUMENT_CONFLICT'
  | 'SERIES_MODEL_REFERENCE_INCONSISTENT' | 'PROPERTY_FROM_OTHER_OBJECT_DOCUMENT' | 'SECONDARY_PRODUCT_ON_PAGE';

/** Écriture de réparation FIABLE (valeur automatique seulement). */
export interface IdentityRepairWrite { key: string; value: string | null; expectedCurrent: string; motive: string }

export interface IdentityDiagnosis {
  anomalies: Array<{ anomaly: IdentityAnomaly; key: string; factIds: number[]; fileIds: number[]; protectedValue?: boolean; problem?: string }>;
  repairs: IdentityRepairWrite[];
}

const codeDe = (v: string) => productCodesIn(v)[0] ?? normalizeProductCode(v);

/** Diagnostic d'un équipement (PUR, testé sans base). */
export function diagnoseEquipmentIdentity(fields: readonly IdentityField[], facts: readonly IdentityFact[]): IdentityDiagnosis {
  const out: IdentityDiagnosis = { anomalies: [], repairs: [] };
  const champ = (k: string) => fields.find((f) => f.key === k) ?? null;

  // 1. Valeurs d'une autre nature sur la fiche.
  for (const f of fields) {
    const pb = identityValueProblem(f.key, f.value);
    if (!pb) continue;
    const protege = HUMAINES.has(f.origin);
    out.anomalies.push({ anomaly: 'IDENTITY_VALUE_INCOMPATIBLE', key: f.key, factIds: [], fileIds: [], protectedValue: protege, problem: pb });
    if (protege) continue;
    if (pb === 'GENERIC_LABEL') {
      if (!champ('productDesignation')) out.repairs.push({ key: 'productDesignation', value: f.value, expectedCurrent: '', motive: `${f.key}:GENERIC_LABEL` });
      out.repairs.push({ key: f.key, value: null, expectedCurrent: f.value, motive: `${f.key}:GENERIC_LABEL` });
    } else if (pb !== 'FREE_TEXT') {
      out.repairs.push({ key: f.key, value: null, expectedCurrent: f.value, motive: `${f.key}:${pb}` });
    }
  }

  // 2. Série / modèle / référence de la fiche : même produit ?
  const codes = ['productSeries', 'modelName', 'productReference']
    .map((k) => champ(k)).filter((x): x is IdentityField => !!x && !identityValueProblem(x.key, x.value));
  for (let i = 0; i < codes.length; i += 1) {
    for (let j = i + 1; j < codes.length; j += 1) {
      if (compareProductCodes(codeDe(codes[i].value), codeDe(codes[j].value)) === 'INCOMPATIBLE') {
        out.anomalies.push({ anomaly: 'SERIES_MODEL_REFERENCE_INCONSISTENT', key: `${codes[i].key}+${codes[j].key}`, factIds: [], fileIds: [] });
      }
    }
  }

  // 3. Faits : documents d'autres objets, modèles incompatibles, page fournisseur.
  const faitsModele = facts.filter((f) => (f.key === 'modelName' || f.key === 'productReference') && !identityValueProblem(f.key, f.value));
  const autres = facts.filter((f) => f.linkedToOther && !f.linkedToThis);
  if (autres.length) {
    out.anomalies.push({ anomaly: 'PROPERTY_FROM_OTHER_OBJECT_DOCUMENT', key: [...new Set(autres.map((f) => f.key))].join('+'), factIds: autres.map((f) => f.factId), fileIds: [...new Set(autres.map((f) => f.fileId))] });
  }
  const groupes = groupProductCodes(faitsModele.map((f) => codeDe(f.value)));
  const modeleFiche = champ('modelName') ?? champ('productReference');
  if (groupes.length > 1) {
    // Page fournisseur : un code incompatible avec la fiche, sur une page qui porte aussi un code compatible.
    const fiche = modeleFiche && !identityValueProblem(modeleFiche.key, modeleFiche.value) ? codeDe(modeleFiche.value) : null;
    const pages = new Set(faitsModele.filter((f) => f.sourceType === 'web_link').map((f) => f.fileId));
    const secondaires = fiche ? faitsModele.filter((f) => pages.has(f.fileId) && compareProductCodes(fiche, codeDe(f.value)) === 'INCOMPATIBLE'
      && faitsModele.some((g) => g.fileId === f.fileId && compareProductCodes(fiche, codeDe(g.value)) !== 'INCOMPATIBLE')) : [];
    if (secondaires.length) {
      out.anomalies.push({ anomaly: 'SECONDARY_PRODUCT_ON_PAGE', key: 'modelName', factIds: secondaires.map((f) => f.factId), fileIds: [...new Set(secondaires.map((f) => f.fileId))] });
    } else {
      out.anomalies.push({ anomaly: 'INCOMPATIBLE_MODELS', key: 'modelName', factIds: faitsModele.map((f) => f.factId), fileIds: [...new Set(faitsModele.map((f) => f.fileId))] });
    }
  }
  if (modeleFiche && !identityValueProblem(modeleFiche.key, modeleFiche.value)) {
    const contraires = faitsModele.filter((f) => f.linkedToThis && f.confidence === 'certain' && compareProductCodes(codeDe(modeleFiche.value), codeDe(f.value)) === 'INCOMPATIBLE'
      && !faitsModele.some((g) => g.fileId === f.fileId && compareProductCodes(codeDe(modeleFiche.value), codeDe(g.value)) !== 'INCOMPATIBLE'));
    if (contraires.length) {
      out.anomalies.push({ anomaly: 'STRUCTURED_VS_DOCUMENT_CONFLICT', key: modeleFiche.key, factIds: contraires.map((f) => f.factId), fileIds: [...new Set(contraires.map((f) => f.fileId))], protectedValue: HUMAINES.has(modeleFiche.origin) });
    }
  }
  return out;
}

const OBJETS_SQL = `e.archived_at IS NULL AND EXISTS (SELECT 1 FROM assets a WHERE a.id = e.asset_id AND a.account_id = $1 AND a.deleted_at IS NULL)
  AND (coalesce(e.key_characteristics, '{}'::jsonb) ?| $2::text[]
       OR EXISTS (SELECT 1 FROM equipment_cil_specs s WHERE s.equipment_id = e.id AND (s.brand IS NOT NULL OR s.model IS NOT NULL OR s.serial_number IS NOT NULL))
       OR EXISTS (SELECT 1 FROM document_facts f WHERE f.account_id = $1 AND f.status = 'active' AND f.target_type = 'EQUIPMENT'
                    AND f.target_entity_id = e.id AND f.canonical_key = ANY($2::text[])))`;

export const equipmentIdentityCheck: CoherenceCheck = {
  id: EQUIPMENT_IDENTITY_CHECK_ID,
  version: 1,
  status: 'ACTIVE',
  title: 'Identité produit d’un équipement : série, modèle, référence, numéro de série cohérents et propres à l’équipement',
  domain: 'equipements',
  level: 'N2',
  objectType: 'equipment',
  scope: 'équipements actuels du compte qui portent une propriété d’identité produit (fiche ou fait T1 qui les cible)',
  sources: ['equipments', 'equipment_cil_specs', 'document_facts', 'document_asset_links', 'document_extractions'],
  applicability: 'compte éligible ; équipement non archivé d’un bien non supprimé',
  invariant: 'chaque propriété d’identité a la forme de sa propriété, désigne le produit de l’équipement et provient d’une source rattachée à cet équipement ; deux modèles incompatibles ne coexistent jamais sans conflit',
  anomalies: ['IDENTITY_VALUE_INCOMPATIBLE', 'INCOMPATIBLE_MODELS', 'STRUCTURED_VS_DOCUMENT_CONFLICT', 'SERIES_MODEL_REFERENCE_INCONSISTENT', 'PROPERTY_FROM_OTHER_OBJECT_DOCUMENT', 'SECONDARY_PRODUCT_ON_PAGE'],
  autoRepairWhen: 'valeur d’origine AUTOMATIQUE manifestement d’une autre nature (prix, offre, date, VIN) retirée ; libellé générique automatique déplacé en désignation commerciale',
  forbiddenRepairs: [
    'modifier une valeur saisie par l’utilisateur (USER, ADMIN, IMPORT, colonne historique)',
    'choisir un modèle parmi des modèles incompatibles',
    'déduire une série d’un modèle ou un modèle d’un numéro de série',
    'convertir en masse les anciens modèles en séries',
  ],
  services: ['canonical/entity-state#writeCanonicalEntityFields'],
  chain: ['T1', 'PERSISTENCE'],
  triggers: ['SOURCE_ANALYZED', 'ASSET_UPDATED'],
  frequency: 'campagne exhaustive quotidienne + contrôle ciblé après analyse d’un document ou modification du bien',
  criticality: 'MEDIUM',
  tests: ['L101A-U-COH-IDENTITY', 'L101A-E2E-COH'],

  async listObjects(ctx, accountId, afterId, limit) {
    return idsOf(await rows(ctx.sql, `SELECT e.id FROM equipments e WHERE ${OBJETS_SQL} AND e.id > $3 ORDER BY e.id LIMIT $4`, [accountId, CLES, afterId, limit]));
  },

  async objectsForEvent(ctx, accountId, e) {
    const ids: number[] = [];
    if (e.entityId != null && e.type === 'SOURCE_ANALYZED') {
      ids.push(...idsOf(await rows(ctx.sql, `
        SELECT DISTINCT f.target_entity_id AS id FROM document_facts f
         WHERE f.account_id = $1 AND f.file_id = $2 AND f.status = 'active' AND f.target_type = 'EQUIPMENT' AND f.target_entity_id IS NOT NULL
        UNION SELECT l.equipment_id FROM document_asset_links l WHERE l.account_id = $1 AND l.file_id = $2 AND l.status = 'ACTIVE' AND l.equipment_id IS NOT NULL`,
      [accountId, e.entityId])));
    }
    const bien = e.type === 'ASSET_UPDATED' ? e.entityId : e.assetId ?? null;
    if (bien != null) ids.push(...idsOf(await rows(ctx.sql, `SELECT e.id FROM equipments e WHERE e.asset_id = $1`, [bien])));
    if (!ids.length) return [];
    return idsOf(await rows(ctx.sql, `SELECT e.id FROM equipments e WHERE ${OBJETS_SQL} AND e.id = ANY($3::int[]) ORDER BY e.id`, [accountId, CLES, intArray(ids)]));
  },

  async inspect(ctx, accountId, ids) {
    const out = new Map<number, Inspection>();
    const { getCanonicalEntityState } = await import('@/services/canonical/entity-state');
    const faits = await rows(ctx.sql, `
      SELECT f.id::float8 AS "factId", f.file_id AS "fileId", f.target_entity_id AS "equipmentId", f.canonical_key AS key,
             coalesce(f.value_text, f.value_number::text, '') AS value, f.confidence, f.projection_rule AS "ruleCode",
             x.source_type AS "sourceType",
             EXISTS (SELECT 1 FROM document_asset_links l WHERE l.file_id = f.file_id AND l.status = 'ACTIVE' AND l.equipment_id = f.target_entity_id) AS "linkedToThis",
             EXISTS (SELECT 1 FROM document_asset_links l WHERE l.file_id = f.file_id AND l.status = 'ACTIVE'
                       AND ((l.equipment_id IS NOT NULL AND l.equipment_id <> f.target_entity_id))) AS "linkedToOther"
        FROM document_facts f
        JOIN asset_files af ON af.id = f.file_id AND af.account_id = f.account_id AND af.deleted_at IS NULL
        LEFT JOIN document_extractions x ON x.id = f.extraction_id
       WHERE f.account_id = $1 AND f.status = 'active' AND f.target_type = 'EQUIPMENT'
         AND f.target_entity_id = ANY($2::int[]) AND f.canonical_key = ANY($3::text[])`,
    [accountId, intArray(ids), CLES]);
    for (const id of ids) {
      const etat = await getCanonicalEntityState({ type: 'EQUIPMENT', id }, accountId, ctx.sql as never).catch(() => null);
      if (!etat || etat.archived) { out.set(id, { verdict: 'GONE' }); continue; }
      const champs: IdentityField[] = CLES.flatMap((k) => {
        const st = etat.fields[k];
        return st && st.value !== null && st.value !== undefined && String(st.value).trim() !== '' ? [{ key: k, value: String(st.value), origin: String(st.origin) }] : [];
      });
      const sesFaits: IdentityFact[] = faits.filter((f) => Number(f.equipmentId) === id).map((f) => ({
        factId: Number(f.factId), fileId: Number(f.fileId), key: String(f.key), value: String(f.value ?? ''), confidence: String(f.confidence ?? ''),
        sourceType: f.sourceType == null ? null : String(f.sourceType), ruleCode: f.ruleCode == null ? null : String(f.ruleCode),
        linkedToThis: f.linkedToThis === true, linkedToOther: f.linkedToOther === true,
      }));
      const d = diagnoseEquipmentIdentity(champs, sesFaits);
      if (!d.anomalies.length) { out.set(id, { verdict: 'CONSISTENT' }); continue; }
      const resume = d.anomalies.map((a) => ({ anomaly: a.anomaly, key: a.key, factIds: a.factIds.slice(0, 10), fileIds: a.fileIds.slice(0, 10), protectedValue: a.protectedValue ?? false, problem: a.problem ?? null }));
      const inputHash = hashOf({ id, a: resume, r: d.repairs });
      // Réparable : seulement des valeurs automatiques manifestement incompatibles.
      const reparable = d.repairs.length > 0 && d.anomalies.every((a) => a.anomaly === 'IDENTITY_VALUE_INCOMPATIBLE' && !a.protectedValue && a.problem !== 'FREE_TEXT');
      out.set(id, {
        verdict: reparable ? 'REPAIRABLE' : d.anomalies.some((a) => a.anomaly === 'INCOMPATIBLE_MODELS' || a.anomaly === 'STRUCTURED_VS_DOCUMENT_CONFLICT') ? 'AMBIGUOUS' : 'FINDING',
        anomaly: d.anomalies[0].anomaly,
        faultyLink: d.anomalies.some((a) => a.anomaly === 'SECONDARY_PRODUCT_ON_PAGE' || a.anomaly === 'INCOMPATIBLE_MODELS') ? 'T1' : 'PERSISTENCE',
        expected: 'propriétés d’identité de la forme attendue, d’un seul produit, issues de sources rattachées à l’équipement',
        observed: resume,
        detail: { anomalies: resume.length, repairs: d.repairs.map((r) => ({ key: r.key, motive: r.motive, clear: r.value === null })) },
        inputHash,
      });
    }
    return out;
  },

  async repair(ctx, accountId, items) {
    const out = new Map<number, RepairResult>();
    const { getCanonicalEntityState, writeCanonicalEntityFields } = await import('@/services/canonical/entity-state');
    for (const { id } of items) {
      // Relecture (état courant) : le diagnostic est recalculé, jamais rejoué tel quel.
      const etat = await getCanonicalEntityState({ type: 'EQUIPMENT', id }, accountId, ctx.sql as never);
      if (!etat) { out.set(id, { called: false, service: 'writeCanonicalEntityFields', result: { skipped: 'GONE' } }); continue; }
      const champs: IdentityField[] = CLES.flatMap((k) => {
        const st = etat.fields[k];
        return st && st.value !== null && st.value !== undefined && String(st.value).trim() !== '' ? [{ key: k, value: String(st.value), origin: String(st.origin) }] : [];
      });
      const d = diagnoseEquipmentIdentity(champs, []);
      if (!d.repairs.length) { out.set(id, { called: false, service: 'writeCanonicalEntityFields', result: { skipped: 'NOTHING_RELIABLE' } }); continue; }
      const r = await writeCanonicalEntityFields({
        target: { type: 'EQUIPMENT', id }, accountId, origin: 'SYSTEM_RULE',
        writes: d.repairs.map((w) => ({ key: w.key, value: w.value, expectedCurrent: w.expectedCurrent === '' ? null : w.expectedCurrent })),
        source: { type: 'coherence', id: EQUIPMENT_IDENTITY_CHECK_ID }, traceId: ctx.correlationId,
      });
      out.set(id, {
        called: true, service: 'writeCanonicalEntityFields', aiCalls: 0,
        result: { outcomes: r.fields.map((x) => ({ key: x.key, outcome: x.outcome })) },
        rollbackRef: `canonical_field_writes:trace_id=${ctx.correlationId}`,
      });
    }
    return out;
  },
};
