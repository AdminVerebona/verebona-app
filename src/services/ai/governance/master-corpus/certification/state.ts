/**
 * Lot 100B — état de CERTIFICATION en vigueur : manifeste du dépôt +
 * approbations et décisions du BO (base). Lu par la qualification 86A (cas,
 * empreinte du corpus), la non-régression 99B et le verrou A1.
 */
import type { CaseObservation } from '../../../qualification/verdict';
import type { Defect } from '../../../qualification/defects';
import { effectiveStatus, loadCorpusManifest, type ApprovalRef, type StatusDecisionRef } from './manifest';
import type { CaseStatus, CorpusManifest, ManifestEntry } from './model';
import type { CaseResult } from './coverage';

export interface CertificationState {
  manifest: CorpusManifest;
  approvals: ApprovalRef[];
  decisions: StatusDecisionRef[];
  statusOf(e: ManifestEntry): CaseStatus;
  byId: Map<string, ManifestEntry>;
}

let override: { approvals: ApprovalRef[]; decisions: StatusDecisionRef[] } | null = null;

/** Tests : approbations / décisions substituées (null : base). */
export function __setCertificationDecisionsForTests(v: { approvals: ApprovalRef[]; decisions?: StatusDecisionRef[] } | null): void {
  override = v ? { approvals: v.approvals, decisions: v.decisions ?? [] } : null;
}

export function certificationStateOf(manifest: CorpusManifest, approvals: ApprovalRef[], decisions: StatusDecisionRef[]): CertificationState {
  const memo = new Map<string, CaseStatus>();
  return {
    manifest, approvals, decisions,
    statusOf: (e) => {
      const hit = memo.get(e.id);
      if (hit) return hit;
      const s = effectiveStatus(e, approvals, decisions).status;
      memo.set(e.id, s);
      return s;
    },
    byId: new Map(manifest.entries.map((e) => [e.id, e])),
  };
}

/** État courant (manifeste du dépôt, approbations et décisions en base ; base absente : aucune approbation). */
export async function loadCertificationState(): Promise<CertificationState> {
  const manifest = loadCorpusManifest();
  if (override) return certificationStateOf(manifest, override.approvals, override.decisions);
  const repo = await import('./repository');
  const [approvals, decisions] = await Promise.all([repo.listApprovals(), repo.listDecisions()]);
  return certificationStateOf(manifest, approvals, decisions);
}

/** Empreinte de l'état des approbations (clé de mémoire de l'empreinte du corpus). */
export async function certificationStampNow(): Promise<string> {
  if (override) return `test:${override.approvals.length}:${override.approvals.map((a) => `${a.caseId}@${a.oracleFingerprint.slice(0, 8)}${a.decision[0]}`).join(',')}|${override.decisions.length}`;
  return (await import('./repository')).certificationStamp();
}

/**
 * Résultats par cas du manifeste à partir des observations d'un couple
 * (réussi seulement si TOUTES ses observations réussissent ; un échec
 * l'emporte ; sinon non concluant).
 */
export function caseResultsFrom(observations: ReadonlyArray<CaseObservation & { manifestCaseId?: string | null; criticalDefects?: Defect[]; decisions?: string[] }>): Map<string, CaseResult> {
  const par = new Map<string, Array<(typeof observations)[number]>>();
  for (const o of observations) if (o.manifestCaseId) par.set(o.manifestCaseId, [...(par.get(o.manifestCaseId) ?? []), o]);
  const out = new Map<string, CaseResult>();
  for (const [id, l] of par) {
    const outcome = l.some((o) => o.outcome === 'FAILED') ? 'FAILED' : l.every((o) => o.outcome === 'PASSED') ? 'PASSED' : 'INCONCLUSIVE';
    out.set(id, {
      caseId: id, outcome, decisions: [...new Set(l.flatMap((o) => o.decisions ?? []))],
      defects: l.flatMap((o) => o.defects), criticalDefects: l.flatMap((o) => o.criticalDefects ?? []),
      inconclusiveReason: l.find((o) => o.inconclusiveReason)?.inconclusiveReason ?? null,
    });
  }
  return out;
}
