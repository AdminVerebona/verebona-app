/**
 * Lot 113AJ (Trello #735, P1 pré-MEP, alerte BO n° 89) — COH-MISSING-PROPERTIES
 * et COH-MISSING-PROPERTIES-EQUIPMENT : ne plus déclarer « réparé » sans
 * modification réelle.
 *
 * Cause démontrée : le moteur qualifiait la tentative d'après le seul
 * recontrôle (`recheckOutcome`) — recontrôle CONSISTENT (toutes les
 * propriétés DÉCIDÉES, abstentions comprises) ou anomalie DIFFÉRENTE
 * (`MISSING_PROPERTY_ARBITRATION_FAILED` après la 3e panne IA,
 * `MISSING_PROPERTY_ABSTENTION` après des abstentions ambiguës) → journal
 * REPAIRED, alors que `recoverMissingProperties` n'avait rien écrit. La
 * Supervision (`repeated_repairs`) comptait ces lignes.
 *
 * Qualification PROPRE à ces deux contrôles (`qualifyRepair`), d'après ce que
 * le service a réellement fait (`result.written`, `abstained`, `undecided`,
 * `status`) :
 *   WRITTEN            au moins une écriture canonique effective → REPAIRED,
 *                      références exactes aux lignes `canonical_field_writes` ;
 *   TECHNICAL_FAILURE  AI_FAILED (panne, disjoncteur), BUDGET_EXHAUSTED,
 *                      RETRY_SCHEDULED, CONTRACT_PENDING, MEMORY_UNAVAILABLE →
 *                      FAILED (cause explicite), jamais REPAIRED ;
 *   INEFFECTIVE        analyse menée, propriétés restées non décidées ;
 *   ABSTAINED          analyse menée, abstentions justifiées, rien d'écrit
 *                      (décisions conservées : le contexte inchangé n'est
 *                      plus resoumis — anti-boucle par empreinte existante) ;
 *   UNCHANGED          rien à changer (plus rien en attente, objet disparu).
 * La preuve de contrôle n'est plus REPAIRED sans écriture : CONSISTENT / GONE
 * (ou le constat restant).
 *
 * Historique : les lignes REPAIRED antérieures ne sont PAS modifiées (audit) ;
 * elles sont requalifiées à la LECTURE (`effectiveRepairSql`) : seule une
 * ligne dont `result.written` est non vide compte comme réparation.
 */
import type { ControlResult, Inspection, RepairJournalOutcome, RepairQualification, RepairResult, Sql } from '../types';
import { rows } from '../util';

export type MissingPropertiesRepairEffect = 'WRITTEN' | 'ABSTAINED' | 'UNCHANGED' | 'TECHNICAL_FAILURE' | 'INEFFECTIVE';

/** Statuts de `recoverMissingProperties` sans arbitrage abouti (échec technique / IA, budget, contrat, journal). */
const TECHNICAL_STATUSES: ReadonlySet<string> = new Set(['AI_FAILED', 'BUDGET_EXHAUSTED', 'RETRY_SCHEDULED', 'CONTRACT_PENDING', 'MEMORY_UNAVAILABLE']);

const JOURNAL: Readonly<Record<MissingPropertiesRepairEffect, RepairJournalOutcome>> = {
  WRITTEN: 'REPAIRED', TECHNICAL_FAILURE: 'FAILED', INEFFECTIVE: 'INEFFECTIVE', ABSTAINED: 'ABSTAINED', UNCHANGED: 'UNCHANGED',
};

const taille = (v: unknown): number => (Array.isArray(v) ? v.length : typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Effet RÉEL d'une reprise (PUR) : priorité à l'écriture effective, puis à l'échec technique. */
export function repairEffectOf(r: { status?: unknown; written?: unknown; abstained?: unknown; undecided?: unknown } | null | undefined): MissingPropertiesRepairEffect {
  if (!r) return 'UNCHANGED';
  if (taille(r.written) > 0) return 'WRITTEN';
  if (TECHNICAL_STATUSES.has(String(r.status ?? ''))) return 'TECHNICAL_FAILURE';
  if (taille(r.undecided) > 0) return 'INEFFECTIVE';
  if (taille(r.abstained) > 0) return 'ABSTAINED';
  return 'UNCHANGED';
}

/**
 * Qualification d'une tentative (PURE) — `qualifyRepair` des deux contrôles.
 * Jamais REPAIRED sans écriture ; un échec IA n'est jamais une réparation.
 */
export function qualifyMissingPropertiesRepair(p: {
  repair: RepairResult | null; recheck: Inspection | null; generic: { journal: 'REPAIRED' | 'INEFFECTIVE'; result: ControlResult };
}): RepairQualification {
  const res = p.repair?.result as Record<string, unknown> | undefined;
  const effect = repairEffectOf(res);
  const journal = JOURNAL[effect];
  let result = p.generic.result;
  if (effect === 'WRITTEN') {
    // Écriture effective : la propriété écrite a quitté l'attente (entrées changées) ; ce qui reste est un constat.
    if (result === 'REPAIR_INEFFECTIVE') result = 'FINDING';
  } else if (result === 'REPAIRED') {
    result = p.recheck?.verdict === 'GONE' ? 'GONE' : 'CONSISTENT';
  }
  const error = effect === 'TECHNICAL_FAILURE'
    ? `${String(res?.status ?? 'AI_FAILED')}: ${String(res?.cause ?? 'aucun arbitrage T3 abouti').slice(0, 300)} — aucune propriété écrite`
    : null;
  return { journal, result, error };
}

/**
 * Prédicat SQL d'une VRAIE réparation (alias `a` de `coherence_repairs`) —
 * requalification à la lecture : `result.written` non vide (résultat borné
 * à 4 000 caractères : l'extrait tronqué commence par `written`).
 */
export function effectiveMissingPropertiesRepairSql(a: string): string {
  return `(${a}.outcome = 'REPAIRED' AND ((jsonb_typeof(${a}.result -> 'written') = 'array' AND jsonb_array_length(${a}.result -> 'written') > 0)
           OR (jsonb_typeof(${a}.result) = 'object' AND ${a}.result ->> 'truncated' = 'true' AND COALESCE(${a}.result ->> 'excerpt', '') LIKE '%"written":["%')))`;
}

/** Résumé BORNÉ de la reprise pour le journal des réparations (effet, références exactes d'abord). */
export function repairJournalResult(r: {
  status: string; cause?: string | null; persisted?: boolean; calls: number; contextFingerprint: string | null; runIds: number[];
  written: Array<{ key: string; canonicalWriteId?: number | null; decisionId?: number; runId?: number }>;
  abstained: Array<{ key: string; cause: string }>; undecided: string[];
}): Record<string, unknown> {
  return {
    effect: repairEffectOf(r), written: r.written.map((w) => w.key),
    writes: r.written.slice(0, 40).map((w) => ({ key: w.key, canonicalWriteId: w.canonicalWriteId ?? null, decisionId: w.decisionId ?? null, runId: w.runId ?? null })),
    status: r.status, cause: r.cause?.slice(0, 300) ?? null, persisted: r.persisted ?? true,
    counts: { written: r.written.length, abstained: r.abstained.length, undecided: r.undecided.length },
    abstained: r.abstained.slice(0, 20), undecided: r.undecided.slice(0, 20), calls: r.calls, runs: r.runIds.slice(0, 10), contextFingerprint: r.contextFingerprint,
  };
}

// ── Réparations répétées : champ réécrit et écrivain de l'effacement ────────

type Json = Record<string, unknown>;
const court = (v: unknown, n = 60): string => {
  const s = v === null || v === undefined ? '∅' : typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n)}…` : s;
};
const vide = (v: unknown): boolean => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

/**
 * Explication des réparations répétées RÉELLES (lecture seule, bornée) : par
 * objet, les propriétés réécrites, les valeurs avant / après, les lignes
 * `canonical_field_writes` des restaurations et, entre deux restaurations,
 * l'ÉCRIVAIN qui a remis la valeur à vide (origine, source, utilisateur ou
 * traitement) — ou l'absence de toute écriture journalisée (effacement hors
 * du writer canonique, à rechercher dans le journal du domaine).
 */
export function explainRepeatedMissingProperties(type: 'ASSET' | 'EQUIPMENT', checkId: string) {
  return async (sql: Sql, objects: ReadonlyArray<{ accountId: number; objectId: number }>, since: Date): Promise<Json> => {
    const objets = objects.slice(0, 10);
    if (!objets.length) return {};
    const reparations = await rows(sql, `
      SELECT r.id, r.account_id, r.object_id, r.created_at, r.result FROM coherence_repairs r
       WHERE r.check_id = $1 AND r.created_at >= $2 AND (r.account_id, r.object_id) IN (SELECT * FROM unnest($3::int[], $4::bigint[]))
         AND ${effectiveMissingPropertiesRepairSql('r')}
       ORDER BY r.account_id, r.object_id, r.id`, [checkId, since, objets.map((o) => o.accountId), objets.map((o) => o.objectId)]);
    const details: Json[] = [];
    const lignes: string[] = [];
    for (const o of objets) {
      const reps = reparations.filter((r) => Number(r.account_id) === o.accountId && Number(r.object_id) === o.objectId);
      const parCle = new Map<string, number>();
      for (const r of reps) {
        const res = (r.result ?? {}) as Json;
        const cles = Array.isArray(res.written) ? (res.written as unknown[]).map(String) : [];
        for (const k of new Set(cles)) parCle.set(k, (parCle.get(k) ?? 0) + 1);
      }
      const champs: Json[] = [];
      for (const [cle, n] of [...parCle].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
        const ecritures = await rows(sql, type === 'ASSET'
          ? `SELECT id, created_at, old_value, new_value, origin, source_type, source_id, actor_user_id IS NOT NULL AS par_utilisateur FROM canonical_field_writes
              WHERE account_id = $1 AND asset_id = $2 AND target_type IS NULL AND canonical_key = $3 AND outcome = 'written' AND NOT dry_run AND created_at >= $4
              ORDER BY id LIMIT 200`
          : `SELECT id, created_at, old_value, new_value, origin, source_type, source_id, actor_user_id IS NOT NULL AS par_utilisateur FROM canonical_field_writes
              WHERE account_id = $1 AND target_type = 'EQUIPMENT' AND target_id = $2 AND canonical_key = $3 AND outcome = 'written' AND NOT dry_run AND created_at >= $4
              ORDER BY id LIMIT 200`, [o.accountId, o.objectId, cle, since]);
        const restaurations = ecritures.filter((w) => w.source_type === 'coherence_missing_property' && !vide(w.new_value));
        const derniere = restaurations.length ? Number(restaurations[restaurations.length - 1].id) : Number.POSITIVE_INFINITY;
        const effacements = ecritures.filter((w) => vide(w.new_value) && !vide(w.old_value) && Number(w.id) < derniere);
        const valeurs = [...new Set(restaurations.map((w) => JSON.stringify(w.new_value)))];
        const ecrivains = effacements.slice(-5).map((w) => ({
          canonicalWriteId: Number(w.id), at: new Date(w.created_at as string).toISOString(), origin: String(w.origin),
          source: [w.source_type, w.source_id].filter((x) => x != null).join(':') || null, byUser: w.par_utilisateur === true, before: court(w.old_value),
        }));
        champs.push({
          key: cle, restorations: n, sameValue: valeurs.length === 1, values: valeurs.slice(0, 3).map((v) => court(JSON.parse(v))),
          canonicalWriteIds: restaurations.slice(-10).map((w) => Number(w.id)),
          erasure: ecrivains.length ? 'JOURNALED' : 'NOT_JOURNALED', erasedBy: ecrivains,
        });
        const origineTexte = ecrivains.length
          ? `remis à vide par ${ecrivains.map((e) => `${e.byUser ? 'l’utilisateur' : e.origin}${e.source ? ` (${e.source})` : ''} le ${e.at.slice(0, 10)} (écriture n° ${e.canonicalWriteId})`).join(', ')}`
          : 'aucune remise à vide journalisée dans canonical_field_writes : effacement hors du writer canonique, à rechercher dans le journal du domaine';
        lignes.push(`Compte ${o.accountId} · ${type === 'ASSET' ? 'bien' : 'équipement'} ${o.objectId} : « ${cle} » restauré ${n} fois${valeurs.length === 1 ? ` (même valeur ${court(JSON.parse(valeurs[0]))})` : ''} — écritures n° ${restaurations.slice(-10).map((w) => w.id).join(', ') || '—'} ; ${origineTexte}`);
      }
      details.push({ accountId: o.accountId, objectId: o.objectId, realRepairs: reps.length, fields: champs });
    }
    return { evidence: details, summary: lignes.slice(0, 20).join('\n') };
  };
}
