/**
 * DIAGNOSTIC DU GRAPHE DES OPÉRATIONS POUR LE BO (lot 116C, carte Trello #806
 * §4 ; AC73). LECTURE SEULE : s'exécute dans la transaction `READ ONLY` du
 * diagnostic des opérations (`diagnostics/service.ts › readOnlyExecutor`) — une
 * écriture y serait refusée par PostgreSQL lui-même.
 *
 * Pour UN compte, rend DEUX choses distinctes, jamais confondues :
 *   · `control`  ce que dit la PREUVE du contrôle de cohérence
 *                `COH-OPERATION-GRAPH` (date, résultat, version de règles) —
 *                absente : « jamais contrôlé », jamais « vérifié » ;
 *   · `live`     les écarts recalculés À L'INSTANT par le même contrôle de
 *                lecture (`auditOperationGraph`), avec leur libellé, leur
 *                gravité et la conduite à tenir.
 * Aucune réparation n'est proposée ni faite.
 */
import {
  GRAPH_CONTROL_STATE_LABELS, OPERATION_GRAPH_CHECK_ID, OPERATION_GRAPH_CHECK_VERSION, describeGraphFindings, graphControlState,
  type GraphControlProof, type GraphControlState, type GraphFindingLine,
} from './audit-model';
import { GRAPH_FINDING_OBJECT, auditOperationGraph } from './store';
import { readOnlyExecutor, type DiagExecutor } from '../diagnostics/service';

export interface OperationGraphDiagnostic {
  accountId: number;
  /** Le compte existe-t-il ? (faux : rien d'autre n'est rendu comme un état sain.) */
  accountFound: boolean;
  checkId: string;
  rulesVersion: number;
  control: { state: GraphControlState; stateLabel: string; proof: GraphControlProof | null };
  /** Écarts recalculés à l'instant (lecture seule) ; `clean` : aucun écart À CET INSTANT. */
  live: { computedAt: string; clean: boolean; blocking: number; findings: GraphFindingLine[] };
  /** Volumes du graphe du compte (pour lire un « aucun écart » : 0 partout = rien à contrôler). */
  volumes: { operations: number; relations: number; agendaLinks: number; splitPairs: number };
}

const iso = (v: unknown): string | null => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v));

export async function readOperationGraphDiagnostic(accountId: number, exec: DiagExecutor = readOnlyExecutor): Promise<OperationGraphDiagnostic> {
  return exec(async (q) => {
    const [compte] = await q(`SELECT 1 AS ok FROM accounts WHERE id = $1`, [accountId]);
    const [p] = await q(
      `SELECT last_completed_at, last_result, rules_version, last_trigger, last_mode, last_error
         FROM coherence_object_proofs WHERE account_id = $1::int AND check_id = $2 AND object_id = $1::int`, [accountId, OPERATION_GRAPH_CHECK_ID]);
    const proof: GraphControlProof | null = p ? {
      completedAt: iso(p.last_completed_at), result: (p.last_result as string | null) ?? null, rulesVersion: Number(p.rules_version),
      trigger: (p.last_trigger as string | null) ?? null, mode: (p.last_mode as string | null) ?? null, error: (p.last_error as string | null) ?? null,
    } : null;
    const state = graphControlState(proof);
    const findings = compte ? describeGraphFindings(await auditOperationGraph({ q: (text, params = []) => q(text, [...params]) as never }, accountId), GRAPH_FINDING_OBJECT) : [];
    const [v] = await q(
      `SELECT (SELECT count(*)::int FROM business_operations o WHERE o.account_id = $1 AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL) AS operations,
              (SELECT count(*)::int FROM business_operation_relations rel WHERE rel.account_id = $1 AND rel.state = 'ACTIVE') AS relations,
              (SELECT count(*)::int FROM business_operation_agenda_links g WHERE g.account_id = $1 AND g.state = 'ACTIVE') AS agenda_links,
              (SELECT count(*)::int FROM business_operation_relations rel WHERE rel.account_id = $1 AND (rel.split_apart_at IS NOT NULL OR rel.reason_code = 'USER_SPLIT')) AS split_pairs`,
      [accountId]);
    return {
      accountId, accountFound: !!compte, checkId: OPERATION_GRAPH_CHECK_ID, rulesVersion: OPERATION_GRAPH_CHECK_VERSION,
      control: { state, stateLabel: GRAPH_CONTROL_STATE_LABELS[state], proof },
      live: { computedAt: new Date().toISOString(), clean: findings.length === 0, blocking: findings.filter((f) => f.severity === 'BLOCKING').length, findings },
      volumes: { operations: Number(v?.operations ?? 0), relations: Number(v?.relations ?? 0), agendaLinks: Number(v?.agenda_links ?? 0), splitPairs: Number(v?.split_pairs ?? 0) },
    };
  });
}
