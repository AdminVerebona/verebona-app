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
import type { CoupleRoutingStatus } from './static-matrix';

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

const RESOLUTION_REASONS: Record<SchemaAlertResolutionAll, string> = {
  SCHEMA_ACCEPTED_AGAIN: 'Le fournisseur a répondu à un appel réel portant ce schéma — résolution automatique.',
  SCHEMA_SUPERSEDED: 'Le contrat, le schéma transmis ou l’adaptateur de ce couple a changé (ou ce type d’appel est retiré) : ce refus ne concerne plus les appels actuels — résolution automatique. Les refus restent dans l’historique des appels.',
  // Lot 115 (carte #784, §E1) — texte nouveau, à valider par le PO.
  SCHEMA_MODEL_WITHDRAWN: 'Ce modèle n’est plus configuré pour ce type d’appel et n’est plus au référentiel des modèles : ce refus ne concerne plus les appels actuels — résolution automatique. Les refus restent dans l’historique des appels.',
};

/** Résout l'alerte non résolue d'un couple. Rend le nombre d'alertes résolues ; ne lève jamais. */
export async function resolveSchemaIncompatibilityAlert(keyId: string, code: SchemaAlertResolutionAll): Promise<number> {
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

export type SchemaAlertResolutionAll = SchemaAlertResolution | 'SCHEMA_MODEL_WITHDRAWN';

export interface SchemaAlertReevaluation {
  /** Alertes de compatibilité non résolues examinées. */
  examined: number;
  /** Alertes résolues, par motif. */
  resolved: Record<SchemaAlertResolutionAll, number>;
  /** Alertes conservées : le couple est toujours refusé et toujours transmis. */
  keptActive: number;
  /** Alertes conservées faute de pouvoir conclure (couple illisible). */
  keptUndetermined: number;
  /**
   * Lot 115 (carte #784, §E1) — alertes conservées parce que le ROUTAGE RÉEL
   * n'a pas pu être établi, ou que le modèle est hors chaîne mais toujours
   * déclaré : une indisponibilité ponctuelle ou un état inconnu ne ferme
   * JAMAIS une alerte (et ne la rouvre donc pas le lendemain).
   */
  keptRoutingUnknown: number;
  /** Alertes levées pour un couple refusé qui n'en avait pas (alerte non écrite lors du refus). */
  raised: number;
  /**
   * Lot 115 (carte #784, §E1) — alertes qu'on s'est ABSTENU de lever parce que
   * le routage réel du couple n'a pas pu être établi : les lever rouvrirait au
   * passage suivant ce qui vient d'être clos. Le prochain passage, routage
   * lisible, lèvera ce qui doit l'être.
   */
  raiseSkippedRoutingUnknown: number;
  /** Lecture interrompue (migration absente, base illisible) : rien n'a été modifié au-delà de ce compte. */
  unavailable: boolean;
  /**
   * Lot 115 (carte #784, §E2) — RATTRAPAGE REPRENABLE. `done` : l'ensemble a
   * été parcouru en entier. Sinon le budget de ce passage est épuisé et
   * `resumeFromAlertId` dit où reprendre — aucune alerte n'est sautée, aucune
   * n'est traitée deux fois.
   */
  done: boolean;
  resumeFromAlertId: number | null;
  /**
   * Bilan AVANT / APRÈS (carte #784, §E2) : alertes de ce code non résolues au
   * début et à la fin du passage, et couples par état. `null` : non mesurable.
   */
  before: { openAlerts: number | null; couplesByState: Record<string, number> | null };
  after: { openAlerts: number | null };
  /** Couples refusés PARCOURUS pour le rattrapage (parcours exhaustif, jamais borné à 2 000). */
  couplesScanned: number;
}

const PAGE = 100;

/**
 * Budget d'UN passage, en nombre d'alertes examinées. Il ne tronque RIEN en
 * silence : `done: false` et `resumeFromAlertId` disent qu'il reste à faire.
 * La valeur par défaut couvre très largement les volumétries citées par la
 * carte (> 5 000 alertes) ; le passage quotidien et le BO peuvent la réduire.
 */
export const REEVAL_DEFAULT_MAX_ALERTS = 100_000;

/** Alertes de ce code non résolues (bilan). `null` : non mesurable. */
async function countOpenAlerts(): Promise<number | null> {
  try {
    const rows = (await pgClient.unsafe(
      `SELECT COUNT(*)::int AS n FROM ai_alerts WHERE code = $1 AND resolved_at IS NULL`,
      [SCHEMA_COMPAT_ALERT_CODE] as never[],
    )) as unknown as Row[];
    return rows[0] ? Number(rows[0].n) : null;
  } catch {
    return null;
  }
}

/**
 * RÉÉVALUATION des alertes de compatibilité — automatique (passage quotidien
 * des évaluateurs de la file, réservé en base : une seule instance) ou à la
 * demande (BO). CIBLÉE (ce seul code d'alerte), PAGINÉE (par identifiant),
 * IDEMPOTENTE (une alerte résolue n'est plus relue ; un second passage ne
 * change rien). Aucun appel fournisseur, aucune réanalyse de document.
 */
export async function reevaluateSchemaCompatAlerts(
  opts: {
    maxPages?: number; maxAlerts?: number; fromAlertId?: number;
    /**
     * Lot 115 (carte #784, §E1) — lecture de la chaîne de modèles réellement
     * configurée pour une opération (injectable : scénarios de bout en bout et
     * tests). Par défaut, la configuration résolue de l'opération.
     */
    readChain?: (operationCode: string) => Promise<readonly string[]>;
  } = {},
): Promise<SchemaAlertReevaluation> {
  const out: SchemaAlertReevaluation = {
    examined: 0, resolved: { SCHEMA_ACCEPTED_AGAIN: 0, SCHEMA_SUPERSEDED: 0, SCHEMA_MODEL_WITHDRAWN: 0 },
    keptActive: 0, keptUndetermined: 0, keptRoutingUnknown: 0, raised: 0, raiseSkippedRoutingUnknown: 0, unavailable: false,
    done: false, resumeFromAlertId: null,
    before: { openAlerts: null, couplesByState: null }, after: { openAlerts: null }, couplesScanned: 0,
  };
  const [S, M] = await Promise.all([import('./store'), import('./static-matrix')]);
  // Bilan AVANT (carte #784, §E2) : jamais une remise à zéro, un constat.
  out.before.openAlerts = await countOpenAlerts();
  out.before.couplesByState = await S.countCouples().catch(() => null);
  // Budget d'un passage : le `maxPages` historique reste honoré s'il est fourni.
  const budget = opts.maxAlerts ?? (opts.maxPages !== undefined ? opts.maxPages * PAGE : REEVAL_DEFAULT_MAX_ALERTS);
  const ouvertes = new Set<string>();
  /**
   * Statut de routage par (opération, modèle), calculé UNE fois par passage :
   * la configuration ne change pas sous nos pieds au milieu d'un rattrapage, et
   * un couple fréquent ne relit pas la configuration à chaque alerte.
   */
  const routage = new Map<string, CoupleRoutingStatus>();
  const statutRoutage = async (operationCode: string, model: string): Promise<CoupleRoutingStatus> => {
    const k = `${operationCode}\u0000${model}`;
    const vu = routage.get(k);
    if (vu) return vu;
    const s = await M.coupleRoutingStatus({ operationCode, model }, opts.readChain);
    routage.set(k, s);
    return s;
  };
  let cursor = Math.max(0, Math.floor(opts.fromAlertId ?? 0));
  try {
    // Parcours PAGINÉ et EXHAUSTIF des alertes non résolues, par identifiant
    // croissant (ordre stable : une résolution ne déplace pas une ligne). Le
    // curseur est la DONNÉE elle-même — une interruption ne perd aucun travail
    // et n'en refait aucun : les alertes déjà résolues ne sont plus relues.
    for (;;) {
      if (out.examined >= budget) { out.resumeFromAlertId = cursor; break; }
      const rows = (await pgClient.unsafe(
        `SELECT id, details FROM ai_alerts WHERE code = $1 AND resolved_at IS NULL AND id > $2 ORDER BY id LIMIT $3`,
        [SCHEMA_COMPAT_ALERT_CODE, cursor, Math.min(PAGE, budget - out.examined)] as never[],
      )) as unknown as Row[];
      if (rows.length === 0) { out.done = true; break; }
      for (const r of rows) {
        cursor = Number(r.id);
        out.examined++;
        const keyId = String((r.details as { keyId?: unknown } | null)?.keyId ?? '');
        const couple = keyId ? await S.getCouple(keyId) : null;
        // Couple illisible : l'alerte est CONSERVÉE (on ne ferme jamais sur une absence de preuve).
        if (!couple) { out.keptUndetermined++; if (keyId) ouvertes.add(keyId); continue; }
        if (couple.state === 'QUALIFIED') {
          out.resolved.SCHEMA_ACCEPTED_AGAIN += await resolveSchemaIncompatibilityAlert(keyId, 'SCHEMA_ACCEPTED_AGAIN');
          continue;
        }
        if (!M.isCurrentCouple(couple.key)) {
          out.resolved.SCHEMA_SUPERSEDED += await resolveSchemaIncompatibilityAlert(keyId, 'SCHEMA_SUPERSEDED');
          continue;
        }
        // Lot 115 (carte #784, §E1) : le couple est bien celui que la passerelle projette — mais le
        // MODÈLE est-il encore routé ? Preuve de retrait : on clôt avec ce motif. État inconnu ou
        // indisponibilité : on CONSERVE (et le lendemain, même constat : aucune réouverture).
        const routeStatus = await statutRoutage(couple.key.operationCode, couple.key.model);
        if (routeStatus === 'WITHDRAWN') {
          out.resolved.SCHEMA_MODEL_WITHDRAWN += await resolveSchemaIncompatibilityAlert(keyId, 'SCHEMA_MODEL_WITHDRAWN');
          continue;
        }
        if (routeStatus === 'UNKNOWN') { out.keptRoutingUnknown++; ouvertes.add(keyId); continue; }
        out.keptActive++;
        ouvertes.add(keyId);
      }
    }
    // Couple refusé, toujours transmis, sans alerte ouverte : alerte levée (une fois).
    // Lot 115 (carte #784, §B1 et §E2) : PARCOURS EXHAUSTIF de la mémoire, page par page et par
    // `key_id` — la lecture bornée aux 2 000 refus les plus récents omettait les refus anciens, qui
    // restaient donc sans alerte. Un refus ancien est désormais traité comme un refus récent.
    let apres: string | null = null;
    for (;;) {
      const page = await S.scanCouples({ states: ['REJECTED_CONFIRMED', 'NEEDS_RECHECK'], afterKeyId: apres });
      if (page === null) { out.unavailable = true; return out; }
      if (page.length === 0) break;
      for (const c of page) {
        out.couplesScanned++;
        apres = c.keyId;
        if (ouvertes.has(c.keyId) || !M.isCurrentCouple(c.key)) continue;
        // Lot 115 (carte #784, §E1) : une alerte n'est levée que si le modèle est RÉELLEMENT routé.
        //   · WITHDRAWN : le couple ne sert plus — aucune alerte à lever ;
        //   · UNKNOWN   : on ne sait pas. Lever ici ROUVRIRAIT, dès le passage suivant, une alerte
        //     que l'on vient de clore faute de routage lisible — ce que la carte interdit
        //     explicitement (« ne pas rouvrir le lendemain une alerte à cause disparue »). On
        //     s'abstient et on le COMPTE : le prochain passage, routage lisible, lèvera ce qui doit l'être.
        const statut = await statutRoutage(c.key.operationCode, c.key.model);
        if (statut !== 'ACTIVE') { if (statut === 'UNKNOWN') out.raiseSkippedRoutingUnknown++; continue; }
        if (await raiseSchemaIncompatibilityAlert(c)) out.raised++;
      }
    }
  } catch (e) {
    const code = (e as { code?: string } | null)?.code;
    if (code !== '42P01' && code !== '42703') throw e;
    out.unavailable = true;
  }
  out.after.openAlerts = await countOpenAlerts();
  return out;
}
