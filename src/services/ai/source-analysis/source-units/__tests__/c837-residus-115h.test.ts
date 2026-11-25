/**
 * Carte Trello #837 — RÉSIDUS DU LOT 115H (#785) : tests unitaires ciblés des
 * règles PURES et des gardes de livraison. Le comportement SQL (concurrence,
 * pannes, volumes) est prouvé par le scénario PostgreSQL réel
 * `src/test/e2e/scenarios/c837-t1-residus-115h.e2e.ts`.
 *
 *   U01  A1 — point d'admission commun (fichier, action utile, compte, traitement, budget) ;
 *   U02  A2 — DONE ≠ acquis : seul un résultat MÉTIER réussi satisfait une demande ;
 *   U03  A3 — identité CANONIQUE (action + preuves), canal = provenance ;
 *   U04  A4 — une échéance n'est une « reprise programmée » que si une reprise reste admissible ;
 *   U05  C2 — empreinte VERSIONNÉE de toutes les dépendances lues ;
 *   U06  C3 — la garde de version porte sur le CODE RÉEL des prédicats ;
 *   U07  D4 — historique sourcé (rapport d'exécution) ≠ état actuel ;
 *   U08  D1/D2/D3 — textes du BO : suites corrélées, inconnu ≠ 0, classement INCOMPLET.
 */
import { describe, expect, it } from 'vitest';
import { decideRequeueAdmission } from '../retry-policy';
import { doneJobSatisfies } from '../jobs';
import { requeueActionOf, requeueEvidenceFingerprint, requeueRequestKey } from '../requeue-identity';
import { coverageIssueOf, scheduleAdmissible, splitHistoricalAndCurrent } from '../coverage-issue';
import { combineEvidenceParts, EVIDENCE_DEPENDENCIES_VERSION } from '../evidence-version';
import {
  T1_COVERAGE_RULES_VERSION, T1_RULE_PREDICATES, T1_RULES_PREDICATE_SIGNATURES, T1_RULES_VERSION_SIGNATURES, t1AlertConditionsSignature,
} from '../historical-reassessment';
import { predicatesSignature, predicateText, rulesGuardViolation } from './fixtures/c837-rules-signature';
import { readFileSync } from 'node:fs';
import { historicalText, issuesText, reassessmentText, type ReassessmentReport } from '@/app/admin/ai-executions/_components/T1CompletenessPanel';

describe('C837-U01 — A1 : point d’admission commun, avant tout enfilement', () => {
  const base = { action: 'COMPLETENESS_REREAD' as const, qualityState: 'VERIFICATION_INCOMPLETE' };
  it('cas admissible : aucun motif', () => {
    expect(decideRequeueAdmission({ ...base, filePresent: true, fileAlive: true, accountEligible: true, treatmentRunnable: true, costCapReached: false })).toBeNull();
  });
  it('fichier absent ou supprimé : refus DÉFINITIF (source non relisible)', () => {
    expect(decideRequeueAdmission({ ...base, filePresent: false })).toEqual({ block: 'SOURCE_NOT_AVAILABLE', temporary: false });
    expect(decideRequeueAdmission({ ...base, filePresent: true, fileAlive: false })).toEqual({ block: 'SOURCE_NOT_AVAILABLE', temporary: false });
  });
  it('action sans objet (document complet) : refus définitif ; la nouvelle extraction de COHÉRENCE reste utile', () => {
    expect(decideRequeueAdmission({ ...base, qualityState: 'COMPLETE' })).toEqual({ block: 'NOTHING_TO_RETRY', temporary: false });
    expect(decideRequeueAdmission({ action: 'COHERENCE_REEXTRACT', qualityState: 'COMPLETE' })).toBeNull();
  });
  it('compte non éligible, traitement suspendu, budget IA épuisé : refus TEMPORAIRES (la demande reste due)', () => {
    expect(decideRequeueAdmission({ ...base, accountEligible: false })).toEqual({ block: 'ACCOUNT_NOT_ELIGIBLE', temporary: true });
    expect(decideRequeueAdmission({ ...base, treatmentRunnable: false })).toEqual({ block: 'AI_TREATMENT_BLOCKED', temporary: true });
    expect(decideRequeueAdmission({ ...base, costCapReached: true })).toEqual({ block: 'ACCOUNT_AI_BUDGET_REACHED', temporary: true });
  });
  it('aucune origine n’a de privilège : la fonction ne reçoit même pas l’origine', () => {
    const source = readFileSync('src/services/ai/source-analysis/source-units/retry-policy.ts', 'utf8');
    const corps = predicateText(source, 'decideRequeueAdmission')!;
    for (const mot of ['BO', 'SCHEDULER', 'requestedBy', 'origin']) expect(corps).not.toContain(mot);
  });
});

describe('C837-U02 — A2 : DONE ≠ acquis', () => {
  it('seuls APPLIED et NO_CHANGE satisfont une demande ; DONE en échec métier, sans résultat, remplacé… non', () => {
    expect(doneJobSatisfies('APPLIED')).toBe(true);
    expect(doneJobSatisfies('NO_CHANGE')).toBe(true);
    for (const r of ['FAILED', 'ABSTAIN', 'SUPERSEDED', 'TARGET_GONE', 'DONE', null, undefined]) expect(doneJobSatisfies(r as string | null)).toBe(false);
  });
  it('le contrôle final ne requalifie plus un DONE en « en file » (queued exige un travail vivant)', () => {
    const jobs = readFileSync('src/services/ai/source-analysis/source-units/jobs.ts', 'utf8');
    expect(jobs).toContain("const queued = !termine && (issue.status === 'ACCEPTED' || issue.status === 'ALREADY_RUNNING');");
    expect(jobs).toContain("} else if (travail.state === 'DONE') {");
  });
});

describe('C837-U03 — A3 : identité canonique de la demande', () => {
  it('compte/document (ligne) + action + empreinte ; le canal n’en fait pas partie', () => {
    const fp = requeueEvidenceFingerprint({ qualityState: 'VERIFICATION_INCOMPLETE', sourceSha256: 'aa', dependencies: 'e2:x' });
    const cle = requeueRequestKey({ action: 'COMPLETENESS_REREAD', evidenceFingerprint: fp });
    expect(cle).toBe(`COMPLETENESS_REREAD:${fp}`);
    expect(cle).not.toMatch(/BO|SCHEDULER|t1-completeness-retry/);
  });
  it('action selon l’origine technique : la cohérence a SA propre action (demande distincte justifiée)', () => {
    expect(requeueActionOf('coherence-control')).toBe('COHERENCE_REEXTRACT');
    for (const o of ['t1-completeness-retry', 't1-coverage-reverify']) expect(requeueActionOf(o)).toBe('COMPLETENESS_REREAD');
  });
  it('migration 1805 / 1970 absente : refus visible (fail-closed), plus de poursuite sans identité', () => {
    const jobs = readFileSync('src/services/ai/source-analysis/source-units/jobs.ts', 'utf8');
    expect(jobs).toContain("if (!(await requeueRequestsReady())) return indisponible();");
    expect(jobs).toContain("return refuser('IDENTITY_UNAVAILABLE', true, tentativesLues);");
    const id = readFileSync('src/services/ai/source-analysis/source-units/requeue-identity.ts', 'utf8');
    expect(id).not.toContain('(non bloquant)');
  });
});

describe('C837-U04 — A4 : échéance historique ≠ reprise admissible', () => {
  const doc = (over: Record<string, unknown> = {}) => ({
    qualityState: 'INCOMPLETE_FINAL', retryAttempts: 2, maxRetries: 2, nextRetryAt: '2026-11-30T10:00:00.000Z',
    verification: { pagesMissing: [3] }, lastRetryResult: null, ...over,
  });
  it('plafond atteint sans continuation : la date n’est PAS une reprise programmée (BO, API, exports concordent)', () => {
    expect(scheduleAdmissible(doc())).toBe(false);
    const v = coverageIssueOf(doc());
    expect(v.issue).toBe('CAP_REACHED');
    expect(v.reason).toContain('échéance historique');
    expect(splitHistoricalAndCurrent(doc()).current.retryScheduled).toBe(false);
  });
  it('plafond à 0 ou abaissé, refus définitif consigné : jamais « programmée »', () => {
    expect(scheduleAdmissible(doc({ maxRetries: 0, retryAttempts: 0 }))).toBe(false);
    expect(scheduleAdmissible(doc({ maxRetries: 1, retryAttempts: 2 }))).toBe(false);
    expect(scheduleAdmissible(doc({ retryAttempts: 0, lastRetryResult: 'REQUEUE_NOT_ADMISSIBLE:RETRY_CAP_REACHED' }))).toBe(false);
  });
  it('reprise restante, ou continuation d’unités jamais examinées au plafond : « programmée » (distinction conservée)', () => {
    expect(coverageIssueOf(doc({ retryAttempts: 1, qualityState: 'INCOMPLETE_RETRYABLE' })).issue).toBe('REPAIR_SCHEDULED');
    expect(scheduleAdmissible(doc({ verification: { pendingRepairUnits: 3 } }))).toBe(true);
  });
  it('refus d’admission temporaire : anomalie technique nommée, jamais « plafond »', () => {
    const v = coverageIssueOf(doc({ nextRetryAt: null, qualityState: 'VERIFICATION_INCOMPLETE', retryAttempts: 0, lastRetryResult: 'REQUEUE_NOT_ADMISSIBLE:ACCOUNT_AI_BUDGET_REACHED' }));
    expect(v.issue).toBe('TECHNICAL_ANOMALY');
    expect(v.reason).toContain('plafond de coût IA');
  });
});

describe('C837-U05 — C2 : empreinte versionnée et exhaustive des preuves', () => {
  const parts = { facts: '3:aa', decisions: '1:bb', candidates: '0:cc', tables: '4:dd', anchors: '12:ee', extraction: '1:ff', raw: '1:gg' };
  it('stable, versionnée, et sensible à CHAQUE famille même à compteurs égaux', () => {
    const a = combineEvidenceParts(parts);
    expect(a.startsWith(`e${EVIDENCE_DEPENDENCIES_VERSION}:`)).toBe(true);
    expect(combineEvidenceParts({ ...parts })).toBe(a);
    for (const k of Object.keys(parts) as Array<keyof typeof parts>) {
      const [n] = parts[k].split(':');
      // Même NOMBRE de lignes, contenu différent (décision changée, fait corrigé, cellule, ancrage, texte original…).
      expect(combineEvidenceParts({ ...parts, [k]: `${n}:zz` }), k).not.toBe(a);
    }
  });
  it('l’empreinte d’une demande change avec les dépendances, compteurs et état inchangés', () => {
    const base = { qualityState: 'COMPLETE_WITH_UNRESOLVED', unresolvedUnits: 2, sourceSha256: 'same', layerVersion: 3 };
    expect(requeueEvidenceFingerprint({ ...base, dependencies: combineEvidenceParts(parts) }))
      .not.toBe(requeueEvidenceFingerprint({ ...base, dependencies: combineEvidenceParts({ ...parts, decisions: '1:changed' }) }));
  });
  it('aucun contenu de document ne transite : seul un hachage calculé EN BASE est rendu', () => {
    const src = readFileSync('src/services/ai/source-analysis/source-units/evidence-version.ts', 'utf8');
    expect(src).toContain("md5(coalesce(string_agg(md5((");
    expect(src).not.toMatch(/console\.(log|info|warn)\([^)]*(full_text|content_text|value_text)/);
  });
});

describe('C837-U06 — C3 : la garde de version porte sur le code réel des prédicats', () => {
  it('l’empreinte du code en vigueur est celle enregistrée pour la version courante', () => {
    const { signature, missing } = predicatesSignature(T1_RULE_PREDICATES);
    expect(missing).toEqual([]);
    expect(rulesGuardViolation({ version: T1_COVERAGE_RULES_VERSION, recorded: T1_RULES_PREDICATE_SIGNATURES, current: signature })).toBeNull();
  });
  it('prédicat MODIFIÉ et inventaire INCHANGÉ : la garde échoue (version et rattrapage imposés)', () => {
    const fichier = 'src/services/ai/source-analysis/source-units/historical-reassessment.ts';
    const lire = (f: string) => {
      const s = readFileSync(f, 'utf8');
      // Condition métier modifiée seule : une perte de normalisation ne maintient plus l'alerte qu'au-delà de 1.
      return f === fichier ? s.replace('if (p.normalisationLosses > 0) return p.open', 'if (p.normalisationLosses > 1) return p.open') : s;
    };
    const modifie = predicatesSignature(T1_RULE_PREDICATES, lire).signature;
    // L'inventaire (métadonnées des familles) n'a pas bougé : l'ancienne garde serait passée.
    expect(T1_RULES_VERSION_SIGNATURES[T1_COVERAGE_RULES_VERSION]).toBe(t1AlertConditionsSignature());
    expect(rulesGuardViolation({ version: T1_COVERAGE_RULES_VERSION, recorded: T1_RULES_PREDICATE_SIGNATURES, current: modifie }))
      .toContain('incrémenter T1_COVERAGE_RULES_VERSION');
  });
  it('commentaire ou mise en forme seuls : aucune version imposée', () => {
    const fichier = 'src/services/ai/source-analysis/source-units/coverage-issue.ts';
    const lire = (f: string) => {
      const s = readFileSync(f, 'utf8');
      return f === fichier ? s.replace("  if (p.qualityState === 'COMPLETE') return voir(", "  // commentaire ajouté\n  if (p.qualityState === 'COMPLETE')   return voir(") : s;
    };
    expect(predicatesSignature(T1_RULE_PREDICATES, lire).signature).toBe(predicatesSignature(T1_RULE_PREDICATES).signature);
  });
  it('version courante incrémentée par cette livraison, historique conservé', () => {
    expect(T1_COVERAGE_RULES_VERSION).toBe(3);
    expect(Object.keys(T1_RULES_VERSION_SIGNATURES).map(Number)).toEqual([1, 2, 3]);
  });
});

describe('C837-U07 — D4 : historique sourcé ≠ état actuel', () => {
  it('sans rapport d’exécution : face historique INDISPONIBLE, jamais reconstituée depuis la couverture', () => {
    const r = splitHistoricalAndCurrent({ qualityState: 'COMPLETE_WITH_UNRESOLVED', anomalies: [], retryAttempts: 1, maxRetries: 2 });
    expect(r.historical).toEqual({ source: 'UNAVAILABLE', reportId: null, qualityState: null, anomalies: [], reportedAt: null });
    expect(r.current.changedSinceAnalysis).toBeNull();
  });
  it('rapport ancien VERIFICATION_INCOMPLETE, état actuel réconcilié : les deux sont visibles et distincts', () => {
    const r = splitHistoricalAndCurrent({
      qualityState: 'COMPLETE_WITH_UNRESOLVED', anomalies: [], retryAttempts: 0, maxRetries: 2,
      analysisReport: { reportId: 7208, createdAt: '2026-11-12T09:00:00.000Z', qualityState: 'VERIFICATION_INCOMPLETE', anomalies: ['COVERAGE_UNVERIFIED'] },
    });
    expect(r.historical).toMatchObject({ source: 'ANALYSIS_REPORT', reportId: 7208, qualityState: 'VERIFICATION_INCOMPLETE' });
    expect(r.current).toMatchObject({ qualityState: 'COMPLETE_WITH_UNRESOLVED', changedSinceAnalysis: true });
    const texte = historicalText({ qualityState: 'COMPLETE_WITH_UNRESOLVED', historical: { ...r.historical, anomalies: [...r.historical.anomalies] }, current: r.current });
    expect(texte).toContain('rapport n° 7208');
    expect(texte).toContain('état actuel différent');
  });
});

describe('C837-U08 — D1/D2/D3 : textes du BO', () => {
  const bilan: ReassessmentReport = {
    rulesVersion: 3, available: true, documents: 4, byOutcome: { RECONCILED: 4 }, transitions: [], unitsRequalified: 0,
    alertsClosed: 0, alertsMaintained: 0, alertsOpened: 0, retriesScheduled: 1, retriesCancelled: 0, errors: 0, remaining: 0, openAlerts: 0,
    totalDurationMs: 1000, aiCalls: 0, aiCost: 0, firstAt: null, lastAt: null, repairsScheduled: 2, repairsCompleted: 1,
    repairs: { executed: 2, businessSucceeded: 1, businessFailed: 1, unknown: 0, unitsRepaired: 3, residualsRemaining: 1 },
    followUps: { correlation: 'EXPLICIT', requests: 1, jobs: 1, calls: 3, costMicros: 500, callsWithUnknownCost: 1, jobsWithUnknownCalls: 0, uncorrelatedDocumentCalls: 2, callsByKind: { TEXT_REPAIR: 2, FULL_ANALYSIS: 1 } },
  };
  it('passe déterministe (0) isolée des suites ; inconnu affiché INCONNU ; programmé ≠ réussi ≠ échec métier', () => {
    const t = reassessmentText(bilan).join('\n');
    expect(t).toContain('passe déterministe : 0 appel IA');
    expect(t).toContain('1 appel(s) au coût INCONNU');
    expect(t).toContain('2 appel(s) du document non rattaché(s) (exclus)');
    expect(t).toContain('2 programmée(s) · 2 exécutée(s) · 1 réussie(s) (succès métier prouvé) · 1 sans succès métier');
    expect(reassessmentText({ ...bilan, followUps: { ...bilan.followUps!, correlation: 'UNAVAILABLE' } }).join('\n')).toContain('coût INCONNU, jamais 0');
  });
  it('classement INCOMPLET : jamais « total exhaustif » ; cause et progression affichées', () => {
    const t = issuesText({ RESOLVED: 2000 }, true, 2000, { cause: 'SQL_ERROR', scanned: 2000, expected: 5200 });
    expect(t).toContain('CLASSEMENT INCOMPLET (erreur de lecture : 2000/5200');
    expect(t).not.toContain('exhaustif');
    expect(issuesText({ RESOLVED: 3 }, false, 3)).toContain('total exhaustif');
  });
});
