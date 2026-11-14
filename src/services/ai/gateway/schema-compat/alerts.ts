/**
 * Lot 114 (carte #776, travail 11 — AC18) — ALERTES DE COMPATIBILITÉ DE
 * SCHÉMA : une alerte de CONDITION par couple refusé, et leur réévaluation.
 *
 *   · UNE alerte non résolue par couple (`raiseConditionAlert`, clé sans
 *     date) : levée quand le couple PASSE en refus ; les appels suivants, qui
 *     partent sans schéma à cause du refus mémorisé, n'en lèvent aucune —
 *     pas de doublon par appel, ni par passage quotidien ;
 *   · résolue automatiquement quand la cause a disparu : le fournisseur a
 *     accepté le schéma lors d'un appel réel (`SCHEMA_ACCEPTED_AGAIN`), ou le
 *     couple n'est plus celui que la passerelle transmet — contrat, schéma
 *     projeté ou adaptateur changés, opération retirée (`SCHEMA_SUPERSEDED`) ;
 *   · une alerte dont le couple est toujours refusé et toujours transmis
 *     reste ACTIVE ; rien n'est supprimé, aucune remise à zéro : les refus
 *     HTTP 400 restent dans les traces d'appels et dans la matrice.
 *
 * Périmètre : compatibilité de SCHÉMA seulement. Les alertes de couverture et
 * de reprise T1 (carte #775), de disponibilité des modèles (#771) et de
 * tarifs (#770) ne sont ni lues ni touchées ici.
 */
import { pgClient } from '@/db';
import { SCHEMA_COMPAT_STATE_LABELS, type SchemaCoupleState } from './policy';

type Row = Record<string, unknown>;

/** Code de l'alerte « schéma de sortie refusé par le fournisseur ». */
export const SCHEMA_COMPAT_ALERT_CODE = 'ai_schema_incompatibility';

const conditionKeyOf = (keyId: string): string => `ai:schema-compat:${keyId}`;

/** Traitement (T1…T6) d'un code d'opération maître (`t1_analyze_document` → `T1`) ; `null` sinon. */
function treatmentOf(operationCode: string): string | null {
  const m = /^t([1-6])_/.exec(operationCode);
  return m ? `T${m[1]}` : null;
}

/** Texte de l'alerte (à valider par le PO). Aucun contenu : opération, modèle, contrat, empreintes. */
export function schemaIncompatibilityMessage(s: SchemaCoupleState): string {
  const k = s.key;
  const motif = s.reason === 'EXPLICIT_SCHEMA_REJECTION'
    ? 'le fournisseur a refusé le schéma de sortie'
    : 'le fournisseur a refusé la requête portant le schéma de sortie (HTTP 400 sans précision), puis a répondu au même modèle sans schéma';
  const prochain = s.nextRetestAt ? ` Prochain essai avec schéma au plus tôt le ${new Date(s.nextRetestAt).toISOString().slice(0, 16).replace('T', ' ')} UTC.` : '';
  return `${k.operationCode} · ${k.model} : ${motif}. Les appels continuent en mode JSON, validés par le même contrat `
    + `(${k.contractId} v${k.contractVersion}, ${k.schemaHash}) ; le schéma imposé n’est plus transmis à ce couple.${prochain} `
    + 'La cause interne du refus n’est pas indiquée par le fournisseur. Suivi : BO › Exécutions IA › Schémas structurés.';
}

/** Lève (ou met à jour) l'alerte de condition d'un couple refusé. Ne lève jamais d'erreur. */
export async function raiseSchemaIncompatibilityAlert(s: SchemaCoupleState): Promise<boolean> {
  try {
    const { raiseConditionAlert } = await import('../../alerts/alerts.repository');
    const k = s.key;
    const r = await raiseConditionAlert({
      kind: 'anomaly', code: SCHEMA_COMPAT_ALERT_CODE, treatment: treatmentOf(k.operationCode), severity: 'warning',
      message: schemaIncompatibilityMessage(s),
      details: {
        keyId: s.keyId, provider: k.provider, model: k.model, operationCode: k.operationCode, contractId: k.contractId,
        contractVersion: k.contractVersion, schemaHash: k.schemaHash, providerSchemaHash: k.providerSchemaHash, adapterVersion: k.adapterVersion,
        state: s.state, stateLabel: SCHEMA_COMPAT_STATE_LABELS[s.state], reason: s.reason, rejectionCount: s.rejectionCount,
        consecutiveRejections: s.consecutiveRejections, nextRetestAt: s.nextRetestAt ? new Date(s.nextRetestAt).toISOString() : null,
        policyVersion: s.policyVersion,
      },
      drilldownHref: `/admin/ai-executions?vue=technique&tab=schemas&schemaOperation=${encodeURIComponent(k.operationCode)}`,
      conditionKey: conditionKeyOf(s.keyId),
      fallbackDedupeKey: `${conditionKeyOf(s.keyId)}:${new Date(s.lastRejectedAt ?? Date.now()).toISOString().slice(0, 10)}`,
    });
    return r.created;
  } catch {
    return false;
  }
}

export type SchemaAlertResolution = 'SCHEMA_ACCEPTED_AGAIN' | 'SCHEMA_SUPERSEDED';

const RESOLUTION_REASONS: Record<SchemaAlertResolution, string> = {
  SCHEMA_ACCEPTED_AGAIN: 'Le fournisseur a répondu à un appel réel portant ce schéma — résolution automatique.',
  SCHEMA_SUPERSEDED: 'Le contrat, le schéma transmis ou l’adaptateur de ce couple a changé (ou ce type d’appel est retiré) : ce refus ne concerne plus les appels actuels — résolution automatique. Les refus restent dans l’historique des appels.',
};

/** Résout l'alerte non résolue d'un couple. Rend le nombre d'alertes résolues ; ne lève jamais. */
export async function resolveSchemaIncompatibilityAlert(keyId: string, code: SchemaAlertResolution): Promise<number> {
  try {
    const rows = (await pgClient.unsafe(
      `SELECT id FROM ai_alerts WHERE code = $1 AND condition_key = $2 AND resolved_at IS NULL`,
      [SCHEMA_COMPAT_ALERT_CODE, conditionKeyOf(keyId)] as never[],
    )) as unknown as Row[];
    if (rows.length === 0) return 0;
    const { resolveAlerts } = await import('../../alerts/alerts.repository');
    return await resolveAlerts(rows.map((r) => Number(r.id)), { code, reason: RESOLUTION_REASONS[code] });
  } catch {
    return 0;
  }
}

export interface SchemaAlertReevaluation {
  /** Alertes de compatibilité non résolues examinées. */
  examined: number;
  /** Alertes résolues, par motif. */
  resolved: Record<SchemaAlertResolution, number>;
  /** Alertes conservées : le couple est toujours refusé et toujours transmis. */
  keptActive: number;
  /** Alertes conservées faute de pouvoir conclure (couple illisible). */
  keptUndetermined: number;
  /** Alertes levées pour un couple refusé qui n'en avait pas (alerte non écrite lors du refus). */
  raised: number;
  /** Lecture interrompue (migration absente, base illisible) : rien n'a été modifié au-delà de ce compte. */
  unavailable: boolean;
}

const PAGE = 100;

/**
 * RÉÉVALUATION des alertes de compatibilité — automatique (passage quotidien
 * des évaluateurs de la file, réservé en base : une seule instance) ou à la
 * demande (BO). CIBLÉE (ce seul code d'alerte), PAGINÉE (par identifiant),
 * IDEMPOTENTE (une alerte résolue n'est plus relue ; un second passage ne
 * change rien). Aucun appel fournisseur, aucune réanalyse de document.
 */
export async function reevaluateSchemaCompatAlerts(opts: { maxPages?: number } = {}): Promise<SchemaAlertReevaluation> {
  const out: SchemaAlertReevaluation = {
    examined: 0, resolved: { SCHEMA_ACCEPTED_AGAIN: 0, SCHEMA_SUPERSEDED: 0 }, keptActive: 0, keptUndetermined: 0, raised: 0, unavailable: false,
  };
  const [S, M] = await Promise.all([import('./store'), import('./static-matrix')]);
  const ouvertes = new Set<string>();
  let cursor = 0;
  try {
    for (let page = 0; page < (opts.maxPages ?? 50); page++) {
      const rows = (await pgClient.unsafe(
        `SELECT id, details FROM ai_alerts WHERE code = $1 AND resolved_at IS NULL AND id > $2 ORDER BY id LIMIT $3`,
        [SCHEMA_COMPAT_ALERT_CODE, cursor, PAGE] as never[],
      )) as unknown as Row[];
      if (rows.length === 0) break;
      for (const r of rows) {
        cursor = Number(r.id);
        out.examined++;
        const keyId = String((r.details as { keyId?: unknown } | null)?.keyId ?? '');
        const couple = keyId ? await S.getCouple(keyId) : null;
        if (!couple) { out.keptUndetermined++; if (keyId) ouvertes.add(keyId); continue; }
        const code: SchemaAlertResolution | null = couple.state === 'QUALIFIED' ? 'SCHEMA_ACCEPTED_AGAIN'
          : !M.isCurrentCouple(couple.key) ? 'SCHEMA_SUPERSEDED' : null;
        if (code === null) { out.keptActive++; ouvertes.add(keyId); continue; }
        out.resolved[code] += await resolveSchemaIncompatibilityAlert(keyId, code);
      }
      if (rows.length < PAGE) break;
    }
    // Couple refusé, toujours transmis, sans alerte ouverte : alerte levée (une fois).
    const refuses = await S.loadRejectedCouples();
    if (refuses === null) { out.unavailable = true; return out; }
    for (const c of refuses) {
      if (ouvertes.has(c.keyId) || !M.isCurrentCouple(c.key)) continue;
      if (await raiseSchemaIncompatibilityAlert(c)) out.raised++;
    }
  } catch (e) {
    const code = (e as { code?: string } | null)?.code;
    if (code !== '42P01' && code !== '42703') throw e;
    out.unavailable = true;
  }
  return out;
}
