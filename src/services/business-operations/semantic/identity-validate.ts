/**
 * Lot 97A — VALIDATION et PLAN d'une décision T3 d'identité multi-sources
 * (contrat `t3-operation-identity-v1`). PUR.
 *
 * Une réponse invalide est REFUSÉE EN BLOC (aucune écriture, motifs tracés)
 * et n'est jamais remplacée par une heuristique du code :
 *   · sortie hors schéma ;
 *   · référence inconnue (source, Opération, document) ou hors du périmètre ;
 *   · source décidée deux fois, source à décider absente ;
 *   · déplacement vers l'Opération examinée elle-même ;
 *   · séparation ou déplacement d'une source PROTÉGÉE (rattachement voulu par
 *     l'utilisateur) — refus en bloc, comme pour T4 (lot 87B).
 * Seules les décisions CERTAINES deviennent des mutations ; les autres sont
 * tracées (`NOT_CERTAIN`) sans effet.
 */
import { T3OperationIdentityOutput, type IdentityIssue } from './identity-contract';

export interface IdentityScopeSource {
  ref: string;
  sourceId: number;
  kind: string;
  fileId: number | null;
  candidateKey: string | null;
  inScope: boolean;
  protected: boolean;
}

export interface IdentityScope {
  accountId: number;
  operationId: number;
  sources: IdentityScopeSource[];
  /** `O1` (examinée), `O2`… (voisines) → identifiants. */
  operations: Record<string, number>;
  /** `D1`… → identifiants de fichiers. */
  documents: Record<string, number>;
}

interface IdentityProblem { issue: IdentityIssue; detail: string }

export type IdentityValidation =
  | { ok: true; decision: T3OperationIdentityOutput }
  | { ok: false; problems: IdentityProblem[] };

export function validateIdentity(output: unknown, scope: IdentityScope): IdentityValidation {
  const parsed = T3OperationIdentityOutput.safeParse(output);
  if (!parsed.success) {
    return { ok: false, problems: parsed.error.issues.slice(0, 10).map((i) => ({ issue: 'SCHEMA' as const, detail: `${i.path.join('.') || '(racine)'} : ${i.message}`.slice(0, 200) })) };
  }
  const v = parsed.data;
  if (v.outcome === 'ABSTAIN') return { ok: true, decision: v };
  const problems: IdentityProblem[] = [];
  const parRef = new Map(scope.sources.map((s) => [s.ref, s]));
  const vus = new Set<string>();
  for (const d of v.sources) {
    const s = parRef.get(d.source);
    if (!s) { problems.push({ issue: 'UNKNOWN_REFERENCE', detail: `source ${d.source}` }); continue; }
    if (!s.inScope) { problems.push({ issue: 'OUT_OF_SCOPE_REFERENCE', detail: `source ${d.source} (contexte seulement)` }); continue; }
    if (vus.has(d.source)) problems.push({ issue: 'SOURCE_DECIDED_TWICE', detail: d.source });
    vus.add(d.source);
    if (d.targetOperation !== null) {
      if (d.targetOperation === 'O1') problems.push({ issue: 'TARGET_IS_EXAMINED_OPERATION', detail: d.source });
      else if (!(d.targetOperation in scope.operations)) problems.push({ issue: 'UNKNOWN_REFERENCE', detail: `Opération ${d.targetOperation}` });
    }
    for (const e of d.evidence) {
      if (e.document && !(e.document in scope.documents)) problems.push({ issue: 'UNKNOWN_REFERENCE', detail: `document ${e.document}` });
    }
    if (d.decision !== 'KEEP' && s.protected) problems.push({ issue: 'PROTECTED_OBJECT', detail: `source ${d.source} rattachée par l’utilisateur` });
  }
  for (const s of scope.sources.filter((x) => x.inScope)) {
    if (!vus.has(s.ref)) problems.push({ issue: 'SOURCE_NOT_DECIDED', detail: `source ${s.ref}` });
  }
  return problems.length ? { ok: false, problems } : { ok: true, decision: v };
}

/** Mutation appliquée par la consolidation T3 existante (décision de rattachement relue par `decideCandidate`). */
export type IdentityMutation =
  /** Le document ne relève pas de l'Opération : rattachement refusé (la source la quitte à la consolidation). */
  | { kind: 'REJECT'; sourceRef: string; fileId: number; candidateKey: string; operationId: number; reason: string }
  /** Le document relève d'une Opération voisine : rattachement confirmé vers elle. */
  | { kind: 'CONFIRM'; sourceRef: string; fileId: number; candidateKey: string; operationId: number; reason: string };

export interface IdentityPlan {
  mutations: IdentityMutation[];
  /** Décisions sans effet (non certaines) : tracées. */
  refused: Array<{ source: string; decision: string; reason: 'NOT_CERTAIN' }>;
  /** Rôle décidé par source (trace). */
  decided: Record<string, 'KEEP' | 'SEPARATE' | 'MOVE'>;
}

/** Plan d'une décision VALIDE (pur). */
export function planIdentity(decision: T3OperationIdentityOutput, scope: IdentityScope): IdentityPlan {
  const out: IdentityPlan = { mutations: [], refused: [], decided: {} };
  const parRef = new Map(scope.sources.map((s) => [s.ref, s]));
  for (const d of decision.sources) {
    out.decided[d.source] = d.decision;
    if (d.decision === 'KEEP') continue;
    if (d.confidence !== 'certain') { out.refused.push({ source: d.source, decision: d.decision, reason: 'NOT_CERTAIN' }); continue; }
    const s = parRef.get(d.source)!;
    const reason = d.reason.slice(0, 200);
    out.mutations.push({ kind: 'REJECT', sourceRef: d.source, fileId: s.fileId!, candidateKey: s.candidateKey!, operationId: scope.operationId, reason });
    if (d.decision === 'MOVE') {
      out.mutations.push({ kind: 'CONFIRM', sourceRef: d.source, fileId: s.fileId!, candidateKey: s.candidateKey!, operationId: scope.operations[d.targetOperation!], reason });
    }
  }
  return out;
}
