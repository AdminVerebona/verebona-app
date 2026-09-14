/**
 * Reprise des actions « À traiter » V1 → V2 — CDC V2.0 §15.3, Annexe B.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * QUATRE FAMILLES VERS DEUX NATURES, ET UNE QUI DISPARAÎT
 *
 * Le §15.3 donne la table, mais elle n'est pas une simple correspondance :
 *
 *   · « À confirmer » → « À arbitrer » LORSQUE des propositions existent ;
 *   · « À rattacher » → « À arbitrer » si une cible est proposée, « À
 *     compléter » sinon ;
 *   · « À compléter » → conservé SI la règle métier le justifie ;
 *   · « mis de côté » → supprimé, et l'action réévaluée.
 *
 * Trois des quatre lignes portent une condition. Une reprise nominale —
 * confirmer devient arbitrer, rattacher devient arbitrer — produirait des
 * cartes « À arbitrer » sans rien à arbitrer, que l'utilisateur ne pourrait ni
 * résoudre ni faire disparaître (ATP-05).
 *
 * ── CE QUI N'EST PAS REPRIS EST UN CHOIX, PAS UN OUBLI ────────────────────
 *
 * Une action V1 portant sur une donnée absente du catalogue §10 n'est PAS
 * reprise. P-06 l'exige : « une règle métier explicite doit justifier À
 * compléter ». La V1 créait des éléments sur des champs simplement vides ; les
 * reprendre remplirait la file V2 de ce que la V2 refuse précisément d'y
 * mettre.
 *
 * La reprise fait donc DIMINUER le nombre d'actions. C'est le résultat
 * attendu, pas une perte.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { getToProcessItems } from '@/services/to-process.service';
import type { ActionKind, ActionProposal } from './action-model';
import { findRule } from './rules-catalog';
import { upsertAction } from './to-process-action.service';

/** Élément V1, réduit à ce dont la reprise a besoin. */
export interface LegacyItem {
  family: 'arbitrate' | 'attach' | 'confirm' | 'complete';
  status: 'active' | 'snoozed';
  objectType: string;
  objectId: number;
  fieldKey?: string | null;
  proposals?: Array<{ value: string | number | boolean | null; label: string }>;
}

export interface MigrationIntent {
  targetType: 'DOCUMENT' | 'ASSET' | 'EQUIPMENT' | 'AGENDA_ITEM' | 'SUPPLIER';
  targetId: number;
  fieldKey: string;
  actionKind: ActionKind;
  ruleCode: string;
  proposals: ActionProposal[];
}

const OBJECT_TYPE_MAP: Record<string, MigrationIntent['targetType']> = {
  document: 'DOCUMENT',
  asset: 'ASSET',
  equipment: 'EQUIPMENT',
  agenda: 'AGENDA_ITEM',
  supplier: 'SUPPLIER',
};

export type SkipReason =
  /** §15.3 : « Supprimer les états snoozed / mis de côté ». */
  | 'SNOOZED_DROPPED'
  /** P-06 : aucune règle du catalogue §10 ne couvre cette donnée. */
  | 'NO_RULE'
  /** ATP-05 : un arbitrage sans proposition n'est pas affichable. */
  | 'NO_PROPOSAL'
  | 'UNKNOWN_OBJECT_TYPE';

/**
 * Traduit un élément V1 en intention V2, ou dit pourquoi il ne l'est pas.
 *
 * Fonction pure : c'est la seule partie de la reprise où une erreur se voit
 * six mois plus tard, sous la forme d'une carte que personne ne sait résoudre.
 */
export function mapLegacyItem(
  item: LegacyItem,
): { intent: MigrationIntent } | { skipped: SkipReason } {
  // §15.3, dernière ligne : « mis de côté » n'existe plus. L'action n'est pas
  // reprise ; si le problème existe toujours, le traitement d'optimisation la
  // recréera au passage suivant — cette fois sans possibilité de la masquer.
  if (item.status === 'snoozed') return { skipped: 'SNOOZED_DROPPED' };

  const targetType = OBJECT_TYPE_MAP[item.objectType];
  if (!targetType) return { skipped: 'UNKNOWN_OBJECT_TYPE' };

  const fieldKey = item.fieldKey ?? defaultFieldKey(item.family);
  if (!fieldKey) return { skipped: 'NO_RULE' };

  const rule = findRule(targetType, fieldKey);
  if (!rule) return { skipped: 'NO_RULE' };

  const proposals: ActionProposal[] = (item.proposals ?? []).map((p) => ({
    value: p.value,
    label: p.label,
    // Les propositions V1 ne portaient pas de score comparable au seuil du
    // §11.2. Les créditer d'une confiance élevée les ferait écrire sans
    // arbitrage au premier passage du moteur ; 0 les laisse à l'arbitrage,
    // ce qu'elles étaient déjà.
    confidence: 0,
  }));

  // « À arbitrer » et « À confirmer » supposent une proposition (§15.3).
  // Sans proposition, la nature bascule vers « À compléter » — et seulement si
  // la règle l'autorise.
  const wantsArbitration = item.family === 'arbitrate' || item.family === 'confirm'
    || (item.family === 'attach' && proposals.length > 0);

  if (wantsArbitration) {
    if (proposals.length === 0) {
      if (rule.completePriority === null) return { skipped: 'NO_PROPOSAL' };
      return {
        intent: { targetType, targetId: item.objectId, fieldKey, actionKind: 'COMPLETE', ruleCode: rule.code, proposals: [] },
      };
    }
    return {
      intent: { targetType, targetId: item.objectId, fieldKey, actionKind: 'ARBITRATE', ruleCode: rule.code, proposals },
    };
  }

  // « À compléter » et « À rattacher » sans cible.
  if (rule.completePriority === null) return { skipped: 'NO_RULE' };
  return {
    intent: { targetType, targetId: item.objectId, fieldKey, actionKind: 'COMPLETE', ruleCode: rule.code, proposals: [] },
  };
}

/**
 * Donnée visée par une famille V1 qui ne la précisait pas.
 *
 * La V1 raisonnait par objet et par motif, pas par champ : « à rattacher »
 * signifiait toujours « pas de bien ». Cette table rend explicite ce qui
 * était implicite, et c'est elle qu'il faudra étendre si de nouveaux motifs
 * V1 apparaissent avant la bascule.
 */
function defaultFieldKey(family: LegacyItem['family']): string | null {
  if (family === 'attach') return 'assetIds';
  return null;
}

export interface LegacyMigrationReport {
  scanned: number;
  created: number;
  updated: number;
  skipped: Record<SkipReason, number>;
  dryRun: boolean;
}

/**
 * Reprend les actions V1 d'un compte.
 *
 * Idempotente par construction : `upsertAction` met à jour l'action existante
 * pour le même triplet objet + donnée + nature (§7.3). Relancer la reprise ne
 * duplique donc rien, ce qui permet de la jouer d'abord à blanc, puis pour de
 * bon, puis une seconde fois après correction d'un cas particulier.
 */
export async function migrateLegacyActions(
  accountId: number,
  options: { dryRun?: boolean } = {},
): Promise<LegacyMigrationReport> {
  const report: LegacyMigrationReport = {
    scanned: 0,
    created: 0,
    updated: 0,
    skipped: {
      SNOOZED_DROPPED: 0, NO_RULE: 0, NO_PROPOSAL: 0, UNKNOWN_OBJECT_TYPE: 0,
    },
    dryRun: options.dryRun === true,
  };

  const view = await getToProcessItems(accountId);

  for (const raw of view.items as unknown as LegacyItem[]) {
    report.scanned += 1;
    const result = mapLegacyItem(raw);

    if ('skipped' in result) {
      report.skipped[result.skipped] += 1;
      continue;
    }
    if (options.dryRun) {
      report.created += 1;
      continue;
    }

    const upserted = await upsertAction({
      accountId,
      targetType: result.intent.targetType,
      targetId: result.intent.targetId,
      fieldKey: result.intent.fieldKey,
      actionKind: result.intent.actionKind,
      ruleCode: result.intent.ruleCode,
      proposals: result.intent.proposals,
    });

    if (upserted.status === 'CREATED') report.created += 1;
    else if (upserted.status === 'UPDATED') report.updated += 1;
    else report.skipped.NO_PROPOSAL += 1;
  }

  return report;
}
