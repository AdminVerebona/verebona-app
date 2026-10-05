/**
 * MIG-02 — montants potentiellement ×100 (CDC 15 §14 point 2, T1-03 ;
 * décision D-16) : « ne jamais corriger en masse sans preuve ».
 *
 * Champs visés : clés `money_eur` du registre dans la famille du bien
 * (prix d'achat, valeur estimée, prime d'assurance, loyer…), valeur V en
 * euros lue par la vue canonique.
 *
 * DÉTECTION (suspect) :
 *   · preuve du MÊME bien et du MÊME champ (`field_evidence`, clé canonique
 *     ou alias, preuve non retirée) de montant E avec V = 100 × E ;
 *   · ou montant documentaire d'un document du bien (`asset_files.amount_cents`
 *     par `asset_id`, `linked_asset_id` ou lien N-N actif) égal à V : V euros
 *     = 100 × (amount_cents / 100) — le montant en centimes a été lu en euros.
 *   Une preuve du même champ de montant EXACTEMENT V écarte le soupçon.
 *
 * CORRECTION AUTOMATIQUE (APPLIED, `EXACT_EVIDENCE_X100`) — TOUTES les
 * conditions :
 *   1. V = 100 × E exactement (au centime) pour une preuve du même bien et du
 *      même champ ;
 *   2. PROVENANCE ÉTABLIE (relecture lot 17) : la DERNIÈRE écriture du champ
 *      a produit V ET vient de cette preuve — `ai_field_updates.evidence_id`
 *      = la preuve, ou document source de l'écriture (`asset_file_id`,
 *      journal 0216 `source_type = document`) = document de la preuve ;
 *   3. origine de la valeur en place DOCUMENT_EXTRACTION ou RECONCILIATION —
 *      JAMAIS IMPORT ni SYSTEM_RULE (la valeur ne vient pas d'une lecture de
 *      document : ×100 non démontré) ;
 *   4. aucune écriture humaine du champ depuis la preuve (journal 0216) ;
 *   5. prompt de la preuve antérieur à `extract_source_v5` (normaliseurs ×100
 *      historiques) ou non versionné.
 *   Écriture : `writeCanonicalAssetField` (valeur V / 100, MÊME origine
 *   automatique, contrôle optimiste sur V, journal 0216 et miroirs).
 *
 * Tout autre suspect → AMBIGUOUS + carte MIG-REVIEW (garder V / corriger en
 * V / 100). Valeur d'origine humaine PROUVÉE (`origin-proof.ts`) →
 * SKIPPED_USER (MIG-09 : jamais écrasée, pas de carte : c'est la saisie de
 * l'utilisateur) ; origine humaine seulement PRÉSUMÉE (aucune information,
 * ou USER posé par MIG-03 faute de preuve IA) → AMBIGUOUS + carte
 * `HUMAN_ORIGIN_PRESUMED` : l'utilisateur tranche.
 */
import { isEmptyValue, parseKc, writeCanonicalAssetFields, type AssetRowJson } from '@/services/canonical/asset-state';
import { assetBackupRows, writeBackups } from '../backup';
import { indexKcAliases, readFieldState, rowFamily } from '@/services/canonical/asset-state/canonical-asset-view';
import { listFields, normalizeValue } from '@/services/canonical/registry';
import { humanWriteSince, loadHistory, writtenFromEvidence, type FieldWriteEvent } from '../history';
import { humanOriginProof } from '../origin-proof';
import { fetchAssetRows, iterateBatches } from '../iterate';
import { emptyCounts, type ReportEntry, type ReviewCardRequest, type StepContext, type StepResult } from '../types';

const STEP = 'MIG-02' as const;

export interface AmountEvidence {
  id: number;
  key: string;
  /** Montant en euros (normalisé). */
  eur: number;
  promptVersion: string | null;
  extractedAt: number;
  /** Document de la preuve (`field_evidence.source_id`). */
  sourceId: number | null;
}

/** Version de prompt antérieure à `extract_source_v5` (ou non versionnée). */
export function beforeV5(promptVersion: string | null): boolean {
  if (!promptVersion) return true;
  const m = /extract_source_v(\d+)/.exec(promptVersion);
  return !!m && Number(m[1]) < 5;
}

const cents = (x: number) => Math.round(x * 100);

export interface AmountDecision {
  entry: ReportEntry;
  card?: ReviewCardRequest;
  correction?: { key: string; from: number; to: number; evidenceId: number; origin: string; promptVersion: string | null };
}

/** Décisions pour un bien (pure, testée). */
export function planAmounts(
  row: AssetRowJson,
  ctx: { evidences: AmountEvidence[]; documentAmountsCents: number[]; history: Map<string, FieldWriteEvent[]> | undefined },
): AmountDecision[] {
  const family = rowFamily(row.category);
  const kc = parseKc(row.key_characteristics);
  const aliases = indexKcAliases(kc, family);
  const out: AmountDecision[] = [];
  const base = { step: STEP, accountId: Number(row.account_id), assetId: Number(row.id), entityType: 'asset' as const, entityId: Number(row.id) };
  for (const def of listFields(family).filter((d) => d.valueType === 'money_eur')) {
    const st = readFieldState(def, kc, row, aliases.get(def.key));
    if (!st || isEmptyValue(st.value) || typeof st.value !== 'number' || st.value <= 0) continue;
    const v = st.value;
    const preuves = ctx.evidences.filter((e) => e.key === def.key);
    if (preuves.some((e) => cents(e.eur) === cents(v))) continue; // valeur soutenue telle quelle
    const x100 = preuves.filter((e) => e.eur > 0 && cents(e.eur) * 100 === cents(v));
    const doc = ctx.documentAmountsCents.some((c) => c * 100 === cents(v));
    if (x100.length === 0 && !doc) continue;
    const corrige = Math.round(cents(v) / 100) / 100;
    const detail = { evidenceIds: x100.map((e) => e.id), documentAmount: doc, origin: st.origin, from: st.from };
    const events = ctx.history?.get(def.key);
    const preuveOrigine = humanOriginProof(kc, st.fromName && st.from === 'alias' ? st.fromName : def.key, def.key, v, events);
    if (preuveOrigine === 'PROVEN') {
      out.push({ entry: { ...base, fieldKey: def.key, before: v, after: v, decision: 'SKIPPED_USER', reason: 'HUMAN_VALUE_SUSPECT_X100', details: detail } });
      continue;
    }
    const carte = (motif: string): AmountDecision => ({
      entry: { ...base, fieldKey: def.key, before: v, after: null, decision: 'AMBIGUOUS', reason: motif, details: detail },
      card: { step: STEP, accountId: base.accountId, assetId: base.assetId, key: def.key, reason: motif, current: v,
        candidates: [{ value: corrige, label: `Corriger en ${corrige.toLocaleString('fr-FR')} € (montant lu ×100)` }] },
    });
    if (preuveOrigine === 'PRESUMED') { out.push(carte('HUMAN_ORIGIN_PRESUMED')); continue; }
    if (st.origin !== 'DOCUMENT_EXTRACTION' && st.origin !== 'RECONCILIATION') { out.push(carte('AUTOMATIC_ORIGIN_NOT_DOCUMENTARY')); continue; }
    const preuve = x100.sort((a, b) => b.extractedAt - a.extractedAt).find((e) => writtenFromEvidence(events, def.key, v, e));
    if (!preuve) {
      out.push(carte(x100.length ? 'PROVENANCE_NOT_ESTABLISHED' : 'DOCUMENT_AMOUNT_X100_NOT_FIELD_ATTRIBUTABLE'));
      continue;
    }
    const exacte = !humanWriteSince(events, preuve.extractedAt) && beforeV5(preuve.promptVersion);
    if (exacte) {
      out.push({
        entry: { ...base, fieldKey: def.key, before: v, after: corrige, decision: 'APPLIED', reason: 'EXACT_EVIDENCE_X100',
          details: { ...detail, evidenceId: preuve.id, promptVersion: preuve.promptVersion } },
        correction: { key: def.key, from: v, to: corrige, evidenceId: preuve.id, origin: st.origin, promptVersion: preuve.promptVersion },
      });
      continue;
    }
    out.push(carte(!beforeV5(preuve.promptVersion) ? 'EVIDENCE_X100_RECENT_PROMPT' : 'HUMAN_WRITE_SINCE_EVIDENCE'));
  }
  return out;
}

export async function runMig02(ctx: StepContext): Promise<StepResult> {
  const counts = emptyCounts();
  let cards = 0;
  const moneyKeys = [...new Set(['IMMOBILIER', 'VEHICULE', 'OBJECT'].flatMap((f) => listFields(f as never).filter((d) => d.valueType === 'money_eur')
    .flatMap((d) => [d.key, ...d.aliases]))) ];
  const r = await iterateBatches(ctx, fetchAssetRows(ctx), async (rows) => {
    const ids = rows.map((x) => x.id);
    const history = await loadHistory(ctx.sql, ids);
    const ev = await ctx.sql<Array<{ id: number; assetId: number; fieldKey: string; canonicalKey: string | null; value: string | null;
      promptVersion: string | null; extractedAt: Date; sourceId: number | null }>>`
      SELECT id, asset_id AS "assetId", field_key AS "fieldKey", canonical_key AS "canonicalKey", value_json #>> '{}' AS value,
             prompt_version AS "promptVersion", extracted_at AS "extractedAt",
             CASE WHEN source_type = 'document' THEN source_id END AS "sourceId"
        FROM field_evidence
       WHERE asset_id = ANY(string_to_array(${ids.join(',')}, ',')::int[]) AND coalesce(lifecycle_status, 'ACTIVE') <> 'WITHDRAWN'
         AND (canonical_key = ANY(ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(moneyKeys)}::jsonb))) OR field_key = ANY(ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(moneyKeys)}::jsonb))))`;
    const docs = await ctx.sql<Array<{ assetId: number; amountCents: number }>>`
      SELECT DISTINCT a.id AS "assetId", f.amount_cents::bigint AS "amountCents"
        FROM assets a JOIN asset_files f ON f.account_id = a.account_id AND f.deleted_at IS NULL AND f.amount_cents IS NOT NULL
       WHERE a.id = ANY(string_to_array(${ids.join(',')}, ',')::int[])
         AND (f.asset_id = a.id OR f.linked_asset_id = a.id
              OR EXISTS (SELECT 1 FROM document_asset_links l WHERE l.file_id = f.id AND l.asset_id = a.id AND l.status = 'ACTIVE'))`;
    const vues = ctx.preview ? await ctx.preview(rows) : rows;
    for (const [i, row] of rows.entries()) {
      const vue = vues[i];
      const family = rowFamily(row.category);
      const evidences: AmountEvidence[] = [];
      for (const e of ev.filter((x) => Number(x.assetId) === row.id)) {
        const key = listFields(family).find((d) => d.valueType === 'money_eur'
          && (d.key === (e.canonicalKey ?? e.fieldKey) || d.aliases.includes(e.fieldKey)));
        if (!key) continue;
        const unit = key.aliasUnits?.[e.fieldKey];
        const n = normalizeValue(key.key, e.value, unit ? { sourceUnit: unit } : {});
        if (n.ok && typeof n.value === 'number') {
          evidences.push({ id: Number(e.id), key: key.key, eur: n.value, promptVersion: e.promptVersion, extractedAt: new Date(e.extractedAt).getTime(),
            sourceId: e.sourceId == null ? null : Number(e.sourceId) });
        }
      }
      const decisions = planAmounts(vue, {
        evidences, history: history.get(row.id),
        documentAmountsCents: docs.filter((d) => Number(d.assetId) === row.id).map((d) => Number(d.amountCents)),
      });
      for (const d of decisions) {
        let entry = d.entry;
        if (ctx.apply && d.correction) {
          // Copie restaurable (fiche et colonnes miroirs) dans la transaction de la primitive.
          const res = await writeCanonicalAssetFields({
            assetId: row.id, accountId: Number(row.account_id), origin: d.correction.origin as never, emitEvent: false,
            source: { type: 'migration', id: STEP },
            writes: [{ key: d.correction.key, value: d.correction.to, expectedCurrent: d.correction.from,
              trace: { evidenceId: d.correction.evidenceId, reasonCode: 'MIG02_EXACT_EVIDENCE_X100', promptVersion: d.correction.promptVersion } }],
          }, {
            mutate: async ({ row: avant, kc, results, tx }) => {
              const ecrit = results.find((x) => x.outcome === 'written');
              if (!ecrit) return;
              await writeBackups(tx, { runId: ctx.runId, step: STEP, accountId: Number(row.account_id) },
                assetBackupRows(row.id, parseKc(avant.key_characteristics), kc, avant, ecrit.mirrors));
            },
          }, ctx.sql as never);
          const f = res.fields[0];
          if (!f || f.outcome !== 'written') {
            // La valeur a changé entre la lecture et l'écriture, ou elle est protégée : rien n'est tranché.
            entry = { ...entry, decision: f?.outcome === 'protected' ? 'SKIPPED_USER' : 'AMBIGUOUS', after: null,
              reason: `WRITE_${(f?.outcome ?? 'NOT_FOUND').toUpperCase()}` };
          }
        }
        counts[entry.decision] += 1;
        await ctx.report(entry);
        if (d.card && await ctx.card(d.card) !== 'SKIPPED') cards += 1;
      }
    }
  });
  return { step: STEP, scanned: r.scanned, counts, cursor: r.cursor, cards, complete: r.exhausted };
}
