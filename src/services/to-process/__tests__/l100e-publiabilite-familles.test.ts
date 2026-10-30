/**
 * Lot 100E — décision PO A7 (règles « À traiter » généralisées à TOUTES les
 * familles, deux conditions cumulatives) et A6 (passage automatique au
 * correctif, contrôle par contrôle). Tests SANS base (le scénario e2e
 * `l100e-a-traiter-familles.e2e.ts` couvre l'exécution réelle).
 *
 *  L100E-U-CONTRACT  contrat commun : chaque règle déclarée, famille future non déclarée SIGNALÉE (jamais affichée en silence)
 *  L100E-U-PUB       blocages techniques de toutes les familles, prémisses, définition SQL unique
 *  L100E-U-COH       COH-TODO-PUBLISHABILITY : verdicts, délégations (une anomalie = une chaîne), registre, couverture
 *  L100E-U-MODE      A6 : contrôle non qualifié à blanc dans une campagne corrective AUTO, puis correctif
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CARD_FAMILY_LABELS, DECLARED_RULES, HOLD_CAUSE_LABELS, PUBLISHABILITY_CHECK_ID, PUBLISHABILITY_CONTRACTS, cardPremiseStillHolds, familyCardStanding,
  familyOf, heldCardSql, holdCauseSql, isPublishable, noLongerUsefulSql, publicationStandingSql, publishableCardSql, targetAliveSql, undeclaredCatalogRules, undeclaredRules,
  type TechnicalHoldCause,
} from '../publishability';
import { PROCESSING_RULES } from '../rules-catalog';
import { COHERENCE_REGISTRY, getCheck } from '@/services/coherence/registry';
import { COVERAGE_INVENTORY } from '@/services/coherence/registry/coverage';
import { publishabilityVerdict } from '@/services/coherence/registry/checks/to-process-publishability';
import { adoptDeployedRegistry, effectiveCheckMode, withQualification } from '@/services/coherence/orchestrator';

const ROOT = join(__dirname, '../../../..');
const lire = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('L100E-U-CONTRACT — contrat commun de publication (A7)', () => {
  it('L100E-U-CONTRACT-01 — chaque règle du catalogue a un contrat ; aucun contrat orphelin', () => {
    expect(undeclaredRules(PROCESSING_RULES)).toEqual([]);
    const codes = new Set(PROCESSING_RULES.map((r) => r.code));
    expect(DECLARED_RULES.filter((c) => !codes.has(c))).toEqual([]);
  });

  it('L100E-U-CONTRACT-02 — les familles du PO sont toutes couvertes : documents, agenda, équipements, fournisseurs, événements de référence', () => {
    const familles = new Set(Object.values(PUBLISHABILITY_CONTRACTS).map((c) => c.family));
    for (const f of ['DOCUMENTS', 'AGENDA', 'EQUIPEMENTS', 'FOURNISSEURS', 'EVENEMENTS_DE_REFERENCE'] as const) expect(familles.has(f), f).toBe(true);
    // Toute cible du catalogue a au moins une règle déclarée.
    const cibles = new Set(PROCESSING_RULES.map((r) => r.targetType));
    for (const t of cibles) expect(PROCESSING_RULES.some((r) => r.targetType === t && PUBLISHABILITY_CONTRACTS[r.code]), t).toBe(true);
    expect(familyOf('OPERATION-MATCH')).toBe('EVENEMENTS_DE_REFERENCE');
    // Jamais le mot « Opération » dans un libellé de famille.
    for (const l of Object.values(CARD_FAMILY_LABELS)) expect(l).not.toMatch(/op[ée]ration/i);
  });

  it('L100E-U-CONTRACT-03 — famille FUTURE sans règle déclarée : signalée par ce test, retenue (jamais montrée en silence)', () => {
    const futur = [...PROCESSING_RULES, { code: 'FUTURE-FAMILY-RULE' }];
    expect(undeclaredRules(futur)).toEqual(['FUTURE-FAMILY-RULE']);
    expect(undeclaredCatalogRules(futur)).toEqual(['FUTURE-FAMILY-RULE']);
    expect(holdCauseSql('a', undeclaredCatalogRules(futur))).toContain("WHEN a.rule_code IN ('FUTURE-FAMILY-RULE') THEN 'RULE_NOT_DECLARED'");
    // Catalogue complet : aucune règle retenue pour ce motif ; un code HORS catalogue (carte héritée) garde le contrat commun.
    expect(undeclaredCatalogRules()).toEqual([]);
    expect(holdCauseSql('a')).not.toContain('RULE_NOT_DECLARED');
    expect(HOLD_CAUSE_LABELS.RULE_NOT_DECLARED).toMatch(/sans règle de publication déclarée/);
  });

  it('L100E-U-CONTRACT-04 — qui nettoie : ce contrôle (avec un service de la famille) ou un contrôle existant du registre (une anomalie = une chaîne)', () => {
    for (const [code, c] of Object.entries(PUBLISHABILITY_CONTRACTS)) {
      if (c.cleanup.by === PUBLISHABILITY_CHECK_ID) {
        expect('service' in c.cleanup && c.cleanup.service, code).toBeTruthy();
        expect(c.noLongerUseful, code).not.toBeNull();
        expect(c.reason, code).toBeTruthy();
      } else if (!c.cleanup.by.startsWith('SWEEP:')) {
        expect(getCheck(c.cleanup.by), `${code} → ${c.cleanup.by}`).toBeDefined();
      }
    }
    // Familles « état » : leur producteur (même décision que le balayage horaire).
    expect(PUBLISHABILITY_CONTRACTS['DATA-AGENDA-DATE'].cleanup).toEqual({ by: PUBLISHABILITY_CHECK_ID, service: 'produceAgendaActions' });
    expect(PUBLISHABILITY_CONTRACTS['LINK-EQUIP-ASSET'].cleanup).toEqual({ by: PUBLISHABILITY_CHECK_ID, service: 'produceEquipmentActions' });
    expect(PUBLISHABILITY_CONTRACTS['SUPPLIER-IDENTITY'].cleanup).toEqual({ by: PUBLISHABILITY_CHECK_ID, service: 'produceSupplierActions' });
    expect(PUBLISHABILITY_CONTRACTS['OPERATION-AMOUNT'].cleanup).toEqual({ by: 'COH-TODO-OPERATION-CARDS' });
  });
});

describe('L100E-U-PUB — une seule définition « publiable », toutes familles', () => {
  it('L100E-U-PUB-01 — familles « état » : erreur ou décision différée qui garde la carte = blocage technique (Supervision)', () => {
    expect(familyCardStanding({ outcome: 'ERROR', effect: 'ERROR' })).toMatchObject({ kind: 'TECHNICAL_HOLD', cause: 'EVALUATION_ERROR' });
    expect(familyCardStanding({ outcome: 'CREATE_ACTION', effect: 'ERROR' })).toMatchObject({ kind: 'TECHNICAL_HOLD', cause: 'EVALUATION_ERROR' });
    expect(familyCardStanding({ outcome: 'DEFER', effect: 'KEPT', reasonCode: 'QUALIFICATION_PENDING' })).toMatchObject({ kind: 'TECHNICAL_HOLD', cause: 'DECISION_DEFERRED' });
    // Carte justifiée ou décision sans carte : publiable.
    for (const d of [{ outcome: 'CREATE_ACTION', effect: 'CREATED' }, { outcome: 'CREATE_ACTION', effect: 'KEPT' }, { outcome: 'DEFER', effect: 'NONE' }]) {
      expect(isPublishable(familyCardStanding(d)), JSON.stringify(d)).toBe(true);
    }
    expect(familyCardStanding(null).kind).toBe('NO_DECISION');
    for (const c of ['DECISION_DEFERRED', 'RULE_NOT_DECLARED', 'EVALUATION_ERROR'] as TechnicalHoldCause[]) expect(HOLD_CAUSE_LABELS[c].length).toBeGreaterThan(10);
  });

  it('L100E-U-PUB-02 — SQL : dernière décision de la MÊME règle sur la MÊME cible, documentaire ou de famille', () => {
    const h = holdCauseSql('t');
    expect(h).toContain('FROM document_rule_evaluations d');
    expect(h).toContain('FROM to_process_decisions f');
    expect(h).toContain('f.target_type = t.target_type AND f.target_id = t.target_id AND f.rule_code = t.rule_code');
    expect(h).toContain("WHEN g.outcome = 'DEFER' AND g.effect = 'KEPT' THEN 'DECISION_DEFERRED'");
    expect(heldCardSql('t')).toBe(`(${h} IS NOT NULL)`);
  });

  it('L100E-U-PUB-03 — publiable = prémisse de la famille vraie ET aucun blocage technique (cible disparue : orphelins, comme avant) ; même SQL pour le statut', () => {
    const p = publishableCardSql('t');
    expect(p).toBe(`(NOT ${noLongerUsefulSql('t')} AND NOT ${heldCardSql('t')})`);
    expect(targetAliveSql('t')).toContain('FROM substructures tr');
    const s = publicationStandingSql('t');
    // Ordre : cible disparue, carte devenue inutile (nettoyée), PUIS blocage technique (supervisé).
    expect(s.indexOf("'TARGET_GONE'")).toBeLessThan(s.indexOf("'NO_LONGER_USEFUL'"));
    expect(s.indexOf("'NO_LONGER_USEFUL'")).toBeLessThan(s.indexOf("'HELD:'"));
  });

  it('L100E-U-PUB-04 — prémisses (conditions 1 et 2) : réponse connue ou intérêt disparu, par famille', () => {
    const n = noLongerUsefulSql('a');
    // Agenda : date saisie ailleurs, élément réalisé / annulé, « Sans échéance ».
    expect(n).toMatch(/a\.rule_code = 'DATA-AGENDA-DATE' AND EXISTS \(SELECT 1 FROM agenda_items i[\s\S]*i\.start_date IS NOT NULL OR NULLIF\(i\.manual_status, ''\) IS NOT NULL OR i\.no_deadline = true/);
    // Équipements : rattaché à un bien vivant, ou inactif.
    expect(n).toMatch(/'LINK-EQUIP-ASSET' AND EXISTS \(SELECT 1 FROM equipments e[\s\S]*s\.deleted_at IS NULL\) OR e\.archived_at IS NOT NULL/);
    // Fournisseurs : plus aucune revue ouverte.
    expect(n).toMatch(/'SUPPLIER-IDENTITY' AND NOT EXISTS \(SELECT 1 FROM supplier_review_items r[\s\S]*r\.status = 'open'/);
    // Événements de référence : fusionnés / invalidés, candidat disparu.
    expect(n).toMatch(/'OPERATION-AMOUNT' AND EXISTS \(SELECT 1 FROM business_operations o[\s\S]*merged_into_operation_id IS NOT NULL OR o\.invalidated_at IS NOT NULL/);
    expect(n).toMatch(/'OPERATION-MATCH' AND NOT EXISTS \(SELECT 1 FROM document_operation_candidates c/);
    // Documents : déjà rattaché (bien, équipement).
    expect(n).toMatch(/'LINK-ASSET' AND \(EXISTS \(SELECT 1 FROM asset_files f JOIN assets s/);
    // Bien seulement CITÉ (MENTIONED) : pas un rattachement.
    expect(n).toContain("l.link_role IN ('PRIMARY', 'SECONDARY')");
    // Familles jugées par leur moteur : aucune prémisse recopiée ici.
    // (LINK-ELT : un document peut concerner plusieurs équipements — un premier rattachement ne tranche rien.)
    for (const c of ['DATA-CONTRACT-END', 'DOC-RUB', 'ENTITY-FIELD', 'MIG-REVIEW', 'LINK-ELT']) expect(n).not.toContain(`'${c}'`);
  });

  it('L100E-U-PUB-05 — création / conservation : prémisse relue avant d’écrire ; une lecture impossible ne bloque jamais', async () => {
    const vue: string[] = [];
    const client = (stale: boolean) => ({ unsafe: async (q: string) => { vue.push(q); return [{ stale }]; } });
    const carte = { accountId: 1, targetType: 'AGENDA_ITEM', targetId: 7, ruleCode: 'DATA-AGENDA-DATE', actionKind: 'COMPLETE', fieldKey: 'date' };
    expect(await cardPremiseStillHolds(carte, client(true))).toBe(false);
    expect(await cardPremiseStillHolds(carte, client(false))).toBe(true);
    expect(vue[0]).toContain('FROM agenda_items i');
    expect(await cardPremiseStillHolds(carte, { unsafe: async () => { throw new Error('panne'); } })).toBe(true);
    // Règle sans prémisse à la création (moteur de famille) : aucune lecture.
    vue.length = 0;
    expect(await cardPremiseStillHolds({ ...carte, ruleCode: 'DATA-CONTRACT-END', targetType: 'DOCUMENT' }, client(true))).toBe(true);
    expect(vue).toEqual([]);
    expect(lire('src/services/to-process/to-process-action.service.ts')).toMatch(/cardPremiseStillHolds\([\s\S]*code: 'NO_LONGER_USEFUL'/);
  });

  it('L100E-U-PUB-06 — lecteurs inchangés (page, compteur, pastille, notifications, assistant) : même définition ; aucun appel IA à la lecture', () => {
    expect(lire('src/services/to-process/to-process-query.service.ts').match(/publishableCardCondition\(\)/g)?.length).toBe(2);
    expect(lire('src/lib/notifications/scheduled/to-process-digest.ts')).toContain("publishableCardSql('a')");
    expect(lire('src/services/verebona-assistant/core/account-state.ts')).toContain("publishableCardSql('t')");
    expect(lire('src/services/to-process/publishability.ts')).not.toMatch(/AiGateway|interpretT1Knowledge|assessDeadlinePertinence/);
  });
});

describe('L100E-U-COH — COH-TODO-PUBLISHABILITY (nettoyage rétroactif, point D)', () => {
  it('L100E-U-COH-01 — verdicts : utile → cohérent ; inutile → réparable (ou délégué) ; technique → délégué, jamais fermé ; règle non déclarée → constat', () => {
    expect(publishabilityVerdict({ standing: 'PUBLISHABLE', ruleCode: 'DATA-AGENDA-DATE', owner: null })).toEqual({ verdict: 'CONSISTENT' });
    expect(publishabilityVerdict({ standing: 'NO_LONGER_USEFUL', ruleCode: 'DATA-AGENDA-DATE', owner: null })).toMatchObject({ verdict: 'REPAIRABLE', anomaly: 'CARD_NO_LONGER_USEFUL' });
    expect(publishabilityVerdict({ standing: 'NO_LONGER_USEFUL', ruleCode: 'AGENDA-PROPOSAL', owner: null })).toEqual({ verdict: 'CONSISTENT', delegatedTo: 'COH-TODO-AGENDA-PROPOSAL-CARDS' });
    expect(publishabilityVerdict({ standing: 'TARGET_GONE', ruleCode: 'LINK-EQUIP-ASSET', owner: null })).toEqual({ verdict: 'CONSISTENT', delegatedTo: 'COH-TODO-ORPHAN-CARDS' });
    expect(publishabilityVerdict({ standing: 'HELD:EVALUATION_ERROR', ruleCode: 'LINK-EQUIP-ASSET', owner: 'COH-TODO-RELEVANCE-CARDS' }))
      .toEqual({ verdict: 'CONSISTENT', delegatedTo: 'COH-TODO-RELEVANCE-CARDS', cause: 'EVALUATION_ERROR' });
    expect(publishabilityVerdict({ standing: 'HELD:RULE_NOT_DECLARED', ruleCode: 'X', owner: null })).toMatchObject({ verdict: 'FINDING', anomaly: 'CARD_RULE_NOT_DECLARED' });
    expect(publishabilityVerdict({ standing: 'HELD:DECISION_DEFERRED', ruleCode: 'AGENDA-DONE', owner: null })).toMatchObject({ verdict: 'FINDING', anomaly: 'CARD_HELD_WITHOUT_RETRY' });
  });

  it('L100E-U-COH-02 — registre : ajouté EN FIN, versions (stock réexaminé), couverture du domaine « À traiter »', () => {
    // Ajouté en fin de registre au lot 100E ; seuls des contrôles plus récents (lot 101A et suivants) le suivent.
    const ids = COHERENCE_REGISTRY.map((c) => c.id);
    expect(ids.slice(ids.indexOf(PUBLISHABILITY_CHECK_ID) + 1)).toEqual(['COH-EQUIPMENT-IDENTITY']);
    const c = getCheck(PUBLISHABILITY_CHECK_ID)!;
    expect(c).toMatchObject({ status: 'ACTIVE', version: 1, objectType: 'to_process_action' });
    expect(c.forbiddenRepairs).toEqual(expect.arrayContaining(['écrire une valeur de l’objet', 'fermer une carte retenue pour cause technique', 'rouvrir une carte fermée par l’utilisateur']));
    expect(getCheck('COH-TODO-RELEVANCE-CARDS')!.version).toBe(3);
    expect(COVERAGE_INVENTORY.find((d) => d.domain === 'a-traiter')!.checks).toContain(PUBLISHABILITY_CHECK_ID);
    // Jamais une donnée de l'objet écrite par la fermeture générique : seules la carte et son événement.
    const src = lire('src/services/to-process/publishability.ts');
    const fermeture = src.slice(src.indexOf('export async function closeCardsNoLongerUseful'), src.indexOf('// ═══', src.indexOf('export async function closeCardsNoLongerUseful')));
    expect(fermeture).toMatch(/UPDATE to_process_actions a SET resolved_at = now\(\)/);
    expect(fermeture).toContain(`AND \${noLongerUsefulSql('a')}`);
    expect(fermeture).not.toMatch(/UPDATE (agenda_items|equipments|assets|asset_files|supplier_review_items)/);
  });
});

describe('L100E-U-MODE — A6 : nouvelle famille à blanc, puis correctif (mode AUTO)', () => {
  const versions = [{ id: 'A', version: 1 }, { id: 'B', version: 2 }];

  it('L100E-U-MODE-01 — campagne corrective AUTO : un contrôle non qualifié est à blanc ; réglage explicite ou campagne à blanc : inchangé', () => {
    const q = withQualification(versions, { mode: 'CORRECTIVE', auto: true, qualified: new Set(['A']) });
    expect(q).toEqual([{ id: 'A', version: 1 }, { id: 'B', version: 2, dryRun: true }]);
    expect(effectiveCheckMode({ mode: 'CORRECTIVE', checks: q }, 'A')).toBe('CORRECTIVE');
    expect(effectiveCheckMode({ mode: 'CORRECTIVE', checks: q }, 'B')).toBe('DRY_RUN');
    expect(withQualification(versions, { mode: 'CORRECTIVE', auto: false, qualified: new Set() })).toEqual(versions);
    expect(withQualification(versions, { mode: 'DRY_RUN', auto: true, qualified: new Set() })).toEqual(versions);
    expect(effectiveCheckMode({ mode: 'DRY_RUN', checks: q }, 'A')).toBe('DRY_RUN');
  });

  it('L100E-U-MODE-02 — version déployée en cours de campagne AUTO : contrôle ajouté / modifié à blanc, inchangé : mode conservé', () => {
    const c = {
      id: 1, kind: 'DAILY', mode: 'CORRECTIVE', status: 'RUNNING', phase: 'TRAVERSE', campaignDate: null, scope: null, trigger: 't', startedAt: new Date(), deadlineAt: null,
      cursorAccountId: 0, cursorCheckIndex: 0, cursorObjectId: 0, accounts: { visited: 0, skipped: {} }, counters: {}, metrics: {} as never,
      registryVersion: 'r1-ancien', checks: [{ id: 'A', version: 1 }, { id: 'B', version: 1 }], cursorCheckId: 'A', rulesChanges: [],
    } as never as Parameters<typeof adoptDeployedRegistry>[0];
    const nouveau = [{ id: 'A', version: 1 }, { id: 'B', version: 2 }, { id: 'N', version: 1 }] as never[];
    expect(adoptDeployedRegistry(c, nouveau, 'r1-nouveau', new Date(), { autoQualify: true })).toBe(true);
    expect(c.checks).toEqual([{ id: 'A', version: 1 }, { id: 'B', version: 2, dryRun: true }, { id: 'N', version: 1, dryRun: true }]);
    const orch = lire('src/services/coherence/orchestrator.ts');
    expect(orch).toContain('contexte(c, effectiveCheckMode(c, check.id)');
    expect(orch).toMatch(/c\.kind = 'DAILY' AND c\.status = 'COMPLETE'[\s\S]*c\.checks @> jsonb_build_array/);
  });
});
