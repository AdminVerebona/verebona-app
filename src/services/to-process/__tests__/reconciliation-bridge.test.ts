/**
 * Pont réconciliation → « À traiter » et contrat de sortie.
 * CDC V2.0 §10.5, §11.1, §11.5, P-06.
 *
 * Le filtre du catalogue est testé en premier : c'est lui qui empêche la
 * première exécution sur un compte fourni de déverser des dizaines de cartes
 * sur des champs que personne ne renseignera jamais.
 */
import { describe, it, expect } from 'vitest';
import {
  confidenceToScore,
  mapReconciliationDecision,
} from '@/services/to-process/reconciliation-bridge';
import {
  summarize,
  toOptimizationOutput,
} from '@/services/to-process/optimization-contract';
import { decide } from '@/services/to-process/decision-engine';
import { AI_CONFIDENCE_THRESHOLD, REFERENTIAL_VERSION } from '@/lib/referential/v2';
import type { ReconciliationDecision } from '@/services/ai/reconciliation/types';

const decision = (
  overrides: Partial<ReconciliationDecision> = {},
): ReconciliationDecision => ({
  fieldKey: 'registrationNumber',
  currentValue: null,
  proposedValue: 'AB-123-CD',
  action: 'create_conflict',
  reasonCode: 'EQUAL_AUTHORITY_DIVERGENCE',
  confidence: 'conflictual',
  evidenceIds: [12, 34],
  deterministic: true,
  ...overrides,
});

describe('filtre du catalogue (P-06, §10.5)', () => {
  it('ignore un champ sans règle de traitement', () => {
    // `notes` n'est couvert par aucune règle du §10 : son absence est un état
    // acceptable, et il ne doit jamais remplir « À traiter ».
    expect(mapReconciliationDecision(decision({ fieldKey: 'notes' }))).toBeNull();
    expect(mapReconciliationDecision(decision({ fieldKey: 'generalCondition' }))).toBeNull();
  });

  it('traite un champ couvert par une règle', () => {
    const intent = mapReconciliationDecision(decision());
    expect(intent?.ruleCode).toBe('DATA-REGISTRATION');
  });
});

describe('traduction des six actions du moteur existant (§11.1)', () => {
  it('une contradiction devient un arbitrage', () => {
    const intent = mapReconciliationDecision(decision({ action: 'create_conflict' }));
    expect(intent?.kind).toBe('UPSERT');
    expect(intent?.actionKind).toBe('ARBITRATE');
    expect(intent?.proposals?.[0].value).toBe('AB-123-CD');
  });

  it('la valeur en place est jointe pour pouvoir être confirmée (§8.5)', () => {
    const intent = mapReconciliationDecision(
      decision({ action: 'create_conflict', currentValue: 'XY-999-ZZ' }),
    );
    const current = intent?.proposals?.find((p) => p.isCurrentValue);
    expect(current?.value).toBe('XY-999-ZZ');
  });

  it('une écriture ferme l’action devenue sans objet (§7.3)', () => {
    for (const action of ['apply', 'update', 'keep'] as const) {
      const intent = mapReconciliationDecision(decision({ action }));
      expect(intent?.kind).toBe('RESOLVE');
    }
  });

  it('un arbitrage modèle en attente ne produit rien', () => {
    // Créer une carte ici reviendrait à poser à l'utilisateur une question que
    // le modèle est en train de trancher.
    expect(mapReconciliationDecision(decision({ action: 'request_ai_review' }))).toBeNull();
  });

  it('une absence de preuve crée une complétion, mais seulement sur champ vide', () => {
    const empty = mapReconciliationDecision(
      decision({ action: 'ignore', currentValue: null }),
    );
    expect(empty?.actionKind).toBe('COMPLETE');

    const filled = mapReconciliationDecision(
      decision({ action: 'ignore', currentValue: 'AB-123-CD' }),
    );
    expect(filled).toBeNull();
  });

  it('§10.5 — un champ dont la règle refuse la complétion reste muet', () => {
    // DATA-ACQUISITION-PRICE : « absence seule ne déclenche pas
    // systématiquement une action ».
    const intent = mapReconciliationDecision(
      decision({ action: 'ignore', fieldKey: 'purchasePriceCents', currentValue: null }),
    );
    expect(intent).toBeNull();
  });
});

describe('conversion des niveaux de confiance (§11.2)', () => {
  it('« certain » passe le seuil de 90 %, « probable » non', () => {
    expect(confidenceToScore('certain')).toBeGreaterThanOrEqual(AI_CONFIDENCE_THRESHOLD);
    expect(confidenceToScore('probable')).toBeLessThan(AI_CONFIDENCE_THRESHOLD);
    expect(confidenceToScore('conflictual')).toBeLessThan(AI_CONFIDENCE_THRESHOLD);
  });

  it('une valeur seulement probable est proposée, jamais écrite', () => {
    const verdict = decide({
      targetType: 'ASSET',
      key: 'registrationNumber',
      currentValue: null,
      userValidated: false,
      proposals: [
        {
          value: 'AB-123-CD',
          label: 'AB-123-CD',
          confidence: confidenceToScore('probable'),
        },
      ],
    });
    expect(verdict.decision).toBe('ARBITRATE');
  });
});

describe('contrat de sortie (§11.5)', () => {
  const ctx = {
    objectType: 'DOCUMENT' as const,
    objectId: 42,
    fieldKey: 'rubricCode',
    currentValue: null,
    proposals: [
      { value: 'MAINTENANCE_WORKS', label: 'Entretien et travaux', confidence: 0.95 },
    ],
    promptVersion: 'classify_rubric_v1',
    pipelineVersion: 'source-analysis-v1',
    referentialVersion: REFERENTIAL_VERSION,
  };

  it('porte tous les champs énumérés par le CDC', () => {
    const verdict = decide({
      targetType: 'DOCUMENT',
      key: 'rubricCode',
      currentValue: null,
      userValidated: false,
      proposals: ctx.proposals,
    });
    const output = toOptimizationOutput(verdict, ctx);

    expect(output.objectType).toBe('DOCUMENT');
    expect(output.objectId).toBe(42);
    expect(output.fieldKey).toBe('rubricCode');
    expect(output.recommendedDecision).toBe('APPLY');
    expect(output.reasonCode).toBe('HIGH_CONFIDENCE_FILL');
    expect(output.ruleCode).toBe('DOC-RUB');
    expect(output.promptVersion).toBe('classify_rubric_v1');
    expect(output.pipelineVersion).toBe('source-analysis-v1');
    expect(output.referentialVersion).toBe(REFERENTIAL_VERSION);
  });

  it('ne rend que les propositions réellement soumises à l’utilisateur', () => {
    // Valeur protégée : le moteur joint la valeur actuelle et écarte les
    // candidats identiques. La trace doit refléter ce qui a été montré.
    const verdict = decide({
      targetType: 'DOCUMENT',
      key: 'rubricCode',
      currentValue: 'PROPERTY_MANAGEMENT',
      userValidated: true,
      proposals: ctx.proposals,
    });
    const output = toOptimizationOutput(verdict, {
      ...ctx,
      currentValue: 'PROPERTY_MANAGEMENT',
    });

    expect(output.recommendedDecision).toBe('ARBITRATE');
    expect(output.proposedValues.some((p) => p.isCurrentValue)).toBe(true);
  });

  it('résume un passage du traitement', () => {
    const outputs = [
      toOptimizationOutput(
        decide({
          targetType: 'DOCUMENT',
          key: 'rubricCode',
          currentValue: null,
          userValidated: false,
          proposals: ctx.proposals,
        }),
        ctx,
      ),
      toOptimizationOutput(
        decide({
          targetType: 'DOCUMENT',
          key: 'documentTypeCode',
          currentValue: null,
          userValidated: false,
          proposals: [],
        }),
        { ...ctx, fieldKey: 'documentTypeCode', proposals: [] },
      ),
    ];

    const summary = summarize(outputs);
    expect(summary.appliedCount).toBe(1);
    expect(summary.actionCount).toBe(1);
  });
});
