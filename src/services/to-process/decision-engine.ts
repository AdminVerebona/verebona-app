/**
 * Matrice de décision du traitement d'optimisation — CDC V2.0 §10.1, §11.2, §11.3.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE MODULE NE CONNAÎT NI BASE, NI IA
 *
 * Le §11.1 est net : « Le chantier ne crée pas un traitement IA
 * supplémentaire. » Ce fichier n'appelle donc aucun modèle. Il prend l'état
 * d'une donnée et les propositions produites par le pipeline existant, et
 * rend une décision.
 *
 * Cette séparation n'est pas de l'élégance. Le §11.3 énumère sept situations
 * dont trois écrivent en base et deux protègent une saisie utilisateur. Ce
 * sont précisément les règles qu'on découvre fausses le jour où un
 * utilisateur voit sa valeur remplacée sans l'avoir demandé — et une règle
 * qui ne tient que dans un pipeline asynchrone ne se teste pas.
 *
 * ── LA RÈGLE QU'IL NE FAUT PAS CASSER ─────────────────────────────────────
 *
 * P-05, AI-02, §12.2 : une valeur explicitement saisie ou validée par
 * l'utilisateur n'est JAMAIS écrasée silencieusement. Elle reste la valeur
 * active et affichée partout ; une meilleure proposition, même à 100 %, ne
 * fait qu'ouvrir un arbitrage.
 *
 * `userValidated` prime donc sur la confiance, sur la fraîcheur, et sur le
 * fait que la nouvelle valeur soit objectivement meilleure. C'est la
 * différence entre un assistant et un correcteur automatique.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { AI_CONFIDENCE_THRESHOLD } from '@/lib/referential/v2';
import type { ActionProposal, ValueOrigin, TargetType } from './action-model';
import { allowsCompletion, findRule } from './rules-catalog';

/** §11.5 — décisions possibles pour une donnée analysée. */
export type RecommendedDecision =
  /** Écrire la valeur : la donnée était vide. */
  | 'APPLY'
  /** Remplacer une valeur existante d'origine IA par une meilleure preuve. */
  | 'UPDATE'
  /** Conserver la valeur actuelle sans rien demander. */
  | 'KEEP'
  /** Soumettre les propositions à l'utilisateur. */
  | 'ARBITRATE'
  /** Demander à l'utilisateur de renseigner la donnée. */
  | 'COMPLETE'
  /** Aucune action : ni écriture, ni sollicitation. */
  | 'IGNORE';

export type DecisionReasonCode =
  | 'HIGH_CONFIDENCE_FILL'
  | 'HIGH_CONFIDENCE_OVERRIDE'
  | 'LOW_CONFIDENCE_PROPOSAL'
  | 'NO_CREDIBLE_PROPOSAL'
  | 'NO_RULE_JUSTIFIES_COMPLETION'
  | 'USER_VALUE_PROTECTED'
  | 'USER_VALUE_CONFIRMED'
  | 'CONTRADICTORY_SOURCES'
  | 'ALREADY_SATISFIED';

export interface DecisionInput {
  targetType: TargetType;
  /** `fieldKey` ou `relationKey` de la donnée analysée. */
  key: string;
  /** Valeur courante. `null` / `undefined` / `''` = absente. */
  currentValue: string | number | boolean | null | undefined;
  /** §12.1 — comment la valeur courante a été obtenue. */
  currentOrigin?: ValueOrigin | null;
  /** §12.1 — la valeur a-t-elle été explicitement saisie ou confirmée ? */
  userValidated: boolean;
  /** Confiance attachée à la valeur courante, si d'origine IA. */
  currentConfidence?: number | null;
  /** Candidats produits par le traitement d'optimisation. */
  proposals: ActionProposal[];
}

export interface Decision {
  decision: RecommendedDecision;
  reasonCode: DecisionReasonCode;
  ruleCode: string | null;
  /** Valeur à écrire pour APPLY / UPDATE. */
  valueToWrite?: string | number | boolean | null;
  /** Propositions à porter sur l'action, pour ARBITRATE. */
  proposals?: ActionProposal[];
  /** Origine à inscrire avec la valeur écrite (§12.1). */
  origin?: ValueOrigin;
  explanation: string;
}

function isEmpty(value: DecisionInput['currentValue']): boolean {
  return value === null || value === undefined || value === '';
}

/**
 * Deux propositions sont contradictoires lorsqu'elles portent des valeurs
 * différentes sans qu'aucune ne se détache.
 *
 * Le §11.3 distingue « proposition disponible sous le seuil » et
 * « contradiction entre sources non résoluble déterministement ». Les deux
 * mènent à un arbitrage, mais pas avec le même code de raison — et c'est ce
 * code qui permettra plus tard de mesurer si le pipeline hésite ou s'il se
 * contredit, deux défauts aux corrections opposées.
 */
function hasContradiction(proposals: ActionProposal[]): boolean {
  const candidates = proposals.filter((p) => !p.isCurrentValue);
  if (candidates.length < 2) return false;
  const distinct = new Set(candidates.map((p) => String(p.value)));
  if (distinct.size < 2) return false;
  const sorted = [...candidates].sort((a, b) => b.confidence - a.confidence);
  // Écart trop faible pour départager : les deux sources se valent.
  return sorted[0].confidence - sorted[1].confidence < 0.1;
}

/**
 * Applique la matrice du §11.3.
 *
 * L'ordre des branches n'est pas arbitraire : la protection de la valeur
 * utilisateur est évaluée AVANT le seuil de confiance. L'inverse ferait
 * passer une proposition à 95 % devant une saisie manuelle — exactement ce
 * que P-05 interdit.
 */
export function decide(input: DecisionInput): Decision {
  const rule = findRule(input.targetType, input.key);
  const ruleCode = rule?.code ?? null;
  const candidates = input.proposals.filter((p) => !p.isCurrentValue);
  const best = [...candidates].sort((a, b) => b.confidence - a.confidence)[0];
  const empty = isEmpty(input.currentValue);

  // ── Valeur protégée par l'utilisateur (§11.3, lignes 4 ; AI-02, AI-03) ──
  if (!empty && input.userValidated) {
    const diverging = candidates.filter((p) => String(p.value) !== String(input.currentValue));
    if (diverging.length === 0) {
      return {
        decision: 'KEEP',
        reasonCode: 'USER_VALUE_CONFIRMED',
        ruleCode,
        explanation:
          'Les propositions confirment la valeur validée par l’utilisateur : rien à faire.',
      };
    }
    return {
      decision: 'ARBITRATE',
      reasonCode: 'USER_VALUE_PROTECTED',
      ruleCode,
      // La valeur actuelle est jointe pour pouvoir être confirmée (§8.5).
      proposals: [
        ...diverging,
        {
          value: input.currentValue ?? null,
          label: String(input.currentValue),
          confidence: 1,
          isCurrentValue: true,
        },
      ],
      explanation:
        'Valeur validée par l’utilisateur conservée et active. La proposition ' +
        'divergente n’apparaît que dans l’arbitrage (§12.2).',
    };
  }

  // ── Contradiction entre sources (§11.3, avant-dernière ligne) ───────────
  if (hasContradiction(input.proposals)) {
    return {
      decision: 'ARBITRATE',
      reasonCode: 'CONTRADICTORY_SOURCES',
      ruleCode,
      proposals: candidates,
      explanation:
        'Sources contradictoires sans règle déterministe : aucune valeur n’est écrite.',
    };
  }

  // ── Donnée absente ──────────────────────────────────────────────────────
  if (empty) {
    if (!best) {
      // §10.1 et P-06 : une action de complétion n'existe que si une règle la
      // justifie. Sans règle, l'absence est un état acceptable.
      if (!allowsCompletion(input.targetType, input.key)) {
        return {
          decision: 'IGNORE',
          reasonCode: 'NO_RULE_JUSTIFIES_COMPLETION',
          ruleCode,
          explanation:
            'Aucune règle ne rend cette donnée fonctionnellement attendue : ' +
            'l’absence ne remplit pas « À traiter » (P-06).',
        };
      }
      return {
        decision: 'COMPLETE',
        reasonCode: 'NO_CREDIBLE_PROPOSAL',
        ruleCode,
        explanation: 'Aucune proposition crédible et une règle métier attend la donnée.',
      };
    }

    if (best.confidence >= AI_CONFIDENCE_THRESHOLD) {
      return {
        decision: 'APPLY',
        reasonCode: 'HIGH_CONFIDENCE_FILL',
        ruleCode,
        valueToWrite: best.value,
        origin: 'RECONCILIATION',
        explanation: `Confiance ≥ ${AI_CONFIDENCE_THRESHOLD * 100} % sur une donnée absente et non protégée.`,
      };
    }

    return {
      decision: 'ARBITRATE',
      reasonCode: 'LOW_CONFIDENCE_PROPOSAL',
      ruleCode,
      proposals: candidates,
      explanation: 'Propositions sous le seuil : présentées sans être écrites.',
    };
  }

  // ── Valeur existante, non protégée ──────────────────────────────────────
  if (!best) {
    return {
      decision: 'KEEP',
      reasonCode: 'ALREADY_SATISFIED',
      ruleCode,
      explanation: 'La donnée est renseignée et aucune proposition ne la conteste.',
    };
  }

  if (String(best.value) === String(input.currentValue)) {
    return {
      decision: 'KEEP',
      reasonCode: 'ALREADY_SATISFIED',
      ruleCode,
      explanation: 'La meilleure proposition confirme la valeur en place.',
    };
  }

  if (best.confidence >= AI_CONFIDENCE_THRESHOLD) {
    return {
      decision: 'UPDATE',
      reasonCode: 'HIGH_CONFIDENCE_OVERRIDE',
      ruleCode,
      valueToWrite: best.value,
      origin: 'RECONCILIATION',
      explanation:
        'Valeur d’origine IA remplacée par une meilleure preuve (§11.3, ligne 5). ' +
        'Une valeur utilisateur aurait été protégée.',
    };
  }

  return {
    decision: 'ARBITRATE',
    reasonCode: 'LOW_CONFIDENCE_PROPOSAL',
    ruleCode,
    proposals: candidates,
    explanation: 'Proposition divergente sous le seuil : arbitrage sans écriture.',
  };
}

/** Une décision doit-elle produire ou entretenir une action « À traiter » ? */
export function producesAction(decision: RecommendedDecision): boolean {
  return decision === 'ARBITRATE' || decision === 'COMPLETE';
}
