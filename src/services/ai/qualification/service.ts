/**
 * Lecture de la qualification par couple — lot 86A (CDC Pilotage IA V2 P5 :
 * BO-06, ACT-02, VER-02/03 ; décisions PO n° 12, 14, 15). Lecture seule.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * `listQualificationEvidence(filter)` — API STABLE POUR LE FICHIER GLOBAL (86B)
 *
 * Rend les preuves historisées (plus récentes d'abord), chacune avec :
 *   · identité du couple : environnement, traitement, opération, rang,
 *     modèle demandé, modèle SERVI (et version déclarée par le fournisseur),
 *     version / révision de configuration testée, rôle (candidat / référence) ;
 *   · profil effectif construit (paramètres envoyés, délai) ;
 *   · signature et empreintes : prompt, contrat, corpus, évaluateur,
 *     capacités ; version des seuils ;
 *   · verdict (ADMISSIBLE / REFUSED / INCONCLUSIVE), motifs par étape
 *     (DEC-01), métriques (qualité par catégorie, délai P95 et plafond,
 *     coût par résultat valide, concurrence, comparaison à l'historique) ;
 *   · `currentState` : état COURANT par rapport à la configuration active
 *     (ADMISSIBLE / REFUSED / INCONCLUSIVE si la signature est encore la
 *     même ; OBSOLETE sinon, avec les parties changées) — une preuve
 *     attachée à un autre prompt ou contrat n'est jamais présentée active.
 * Aucun contenu de document, de prompt ni de réponse ; aucune donnée de
 * compte (les cas exposent au plus un identifiant de compte et de capture,
 * hors de cette fonction). Paramètres : `EvidenceFilter` (`repository.ts`),
 * `{ latestPerCouple: true }` pour une preuve par couple.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { getAiEnvironment, type AiEnvironment } from '../config/environment';
import type { ConfigVersionWithEntries } from '../config/config-types';
import { AI_OPERATIONS } from '../registry/operations';
import { couplesWithState, defaultMasterReader } from './context';
import * as repo from './repository';
import { manualChoiceLabel, STATE_LABELS } from './states';
import { describeThresholds, DEFECT_LABELS, QUALIFICATION_THRESHOLDS } from './thresholds';
import { campaignAllowed } from './campaign';

export type { QualificationEvidenceRecord } from './repository';

/** Preuves historisées par couple, avec leur état courant (voir l'en-tête). */
export async function listQualificationEvidence(filter: repo.EvidenceFilter = {}): Promise<repo.QualificationEvidenceRecord[]> {
  const environment = (filter.environment ?? getAiEnvironment()) as AiEnvironment;
  const rows = await repo.readEvidence({ ...filter, environment });
  if (!rows.length) return rows;
  const { getActiveVersion } = await import('../config/config-version.repository');
  const active = await getActiveVersion(environment).catch(() => null);
  if (!active) return rows.map((r) => ({ ...r, currentState: 'OBSOLETE', currentStateChanged: ['configuration active absente'] }));
  const couples = await couplesWithState(active, { readMasterFile: await defaultMasterReader(), operationCodes: [...new Set(rows.map((r) => r.operationCode))] });
  const parCouple = new Map(couples.map((c) => [repo.coupleKey(c.operationCode, c.model, c.rank), c]));
  return rows.map((r) => {
    const c = parCouple.get(repo.coupleKey(r.operationCode, r.model, r.rank));
    if (!c) return { ...r, currentState: 'OBSOLETE', currentStateChanged: ['couple absent de la configuration active'] };
    if (c.signature !== r.signature) return { ...r, currentState: 'OBSOLETE', currentStateChanged: c.state.state === 'OBSOLETE' ? c.state.changed : ['signature différente'] };
    return { ...r, currentState: r.verdict === 'ADMISSIBLE' ? 'ADMISSIBLE' : r.verdict === 'REFUSED' ? 'REFUSED' : 'INCONCLUSIVE', currentStateChanged: [] };
  });
}

/** Vue BO : seuils (lecture), couples d'une version et leur état, candidates, campagnes. */
export async function qualificationOverview(opts: { versionId?: number | null } = {}) {
  const environment = getAiEnvironment();
  await repo.interruptStaleCampaigns(QUALIFICATION_THRESHOLDS.campaign.staleAfterMs).catch(() => undefined);
  const cfg = await import('../config/config-version.repository');
  const active = await cfg.getActiveVersion(environment).catch(() => null);
  const version: ConfigVersionWithEntries | null = opts.versionId ? await cfg.getVersion(opts.versionId) : active;
  const couples = version ? await couplesWithState(version, { readMasterFile: await defaultMasterReader() }) : [];
  const versions = await cfg.listVersions(environment).catch(() => []);
  const candidates = versions.filter((v) => v.origin === 'auto').slice(0, 20).map((v) => ({
    id: v.id, visibleNumber: v.visibleNumber, label: v.label, state: v.candidateState ?? null, reason: v.candidateReason ?? null,
    active: v.active, createdAt: v.createdAt.toISOString(),
  }));
  return {
    readAt: new Date().toISOString(),
    environment,
    campaignsAllowed: campaignAllowed(environment),
    thresholds: describeThresholds(),
    defectLabels: DEFECT_LABELS,
    stateLabels: STATE_LABELS,
    version: version ? { id: version.id, visibleNumber: version.visibleNumber, label: version.label, active: version.active, origin: version.origin ?? 'manual', candidateState: version.candidateState ?? null } : null,
    activeVersionId: active?.id ?? null,
    couples: couples.map((c) => ({
      treatment: c.treatment, operationCode: c.operationCode, operationLabel: AI_OPERATIONS[c.operationCode]?.label ?? c.operationCode,
      rank: c.rank, slot: c.slot, model: c.model, profile: c.profile, technicalRefusal: c.technicalRefusal, signature: c.signature,
      state: c.state.state, stateLabel: c.state.label, evidenceId: c.state.evidenceId, verdictAt: c.state.verdictAt, changed: c.state.changed,
      // ACT-02 : un choix manuel sans preuve admissible est signalé « non testé », jamais présenté qualifié.
      choiceLabel: (version?.origin ?? 'manual') === 'manual' ? manualChoiceLabel(c.state) : null,
    })),
    candidates,
    campaigns: (await repo.listCampaigns(20)).map((c) => ({
      id: c.id, kind: c.kind, status: c.status, trigger: c.trigger, createdAt: c.createdAt, finishedAt: c.finishedAt,
      restorePointId: c.restorePointId, restorePointAt: c.restorePointAt, refusal: c.refusal, error: c.error,
      couples: Array.isArray(c.summary.couples) ? (c.summary.couples as unknown[]).length : null,
      activatedVersionId: (c.summary.activatedVersionId as number | null | undefined) ?? null,
    })),
  };
}

/** Détail d'une campagne : demande, résumé, preuves et cas (empreintes, défauts — jamais de contenu). */
export async function campaignDetail(id: number) {
  const c = await repo.getCampaignRow(id);
  if (!c) return null;
  const evidence = await repo.readEvidence({ campaignId: id, limit: 200 });
  const withCases = [];
  for (const e of evidence) withCases.push({ ...e, cases: await repo.readCases(e.id) });
  return { campaign: c, evidence: withCases };
}
