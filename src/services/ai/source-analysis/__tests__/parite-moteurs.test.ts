/**
 * Parité des effets de bord entre les deux moteurs — CDC refonte §10.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QU'UNE BASCULE PERD NE SE VOIT PAS
 *
 * L'ancien pipeline produit une dizaine d'effets au-delà de l'analyse :
 * quotas, états, lots, diffusion temps réel, notification, détection de
 * doublon. Le nouveau doit tous les reproduire.
 *
 * Aucun ne se manifeste au moment de la bascule. Ils se manifestent plus
 * tard : une notification qui n'arrive plus, un quota décompté deux fois,
 * un doublon facturé.
 *
 * Deux ont déjà été trouvés manquants — la notification de fin de lot, puis
 * la détection de doublon. Ces tests figent la parité pour que le troisième
 * ne passe pas inaperçu.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const NOUVEAU = read('src/services/ai/source-analysis/pipeline.ts');

describe('effets de bord repris du moteur historique', () => {
  it('décompte les crédits d’analyse', () => {
    expect(NOUVEAU).toContain('consumeAnalysisCredits');
  });

  it('contrôle le quota avant de démarrer', () => {
    expect(NOUVEAU).toContain('canConsumeAnalysis');
  });

  it('écrit l’état d’analyse et le diffuse', () => {
    expect(NOUVEAU).toMatch(/analysisState: state/);
    expect(NOUVEAU).toMatch(/broadcast\(id, \{ type: 'state_update'/);
  });

  it('émet la notification de fin de lot', () => {
    // Perdue à la première revue : l'analyse serait devenue muette.
    expect(NOUVEAU).toContain('notifyLotCompleted');
  });

  it('détecte les doublons', () => {
    // Perdue à la deuxième revue.
    expect(NOUVEAU).toContain('detectFusionCandidates');
  });
});

describe('un doublon ne coûte rien à l’utilisateur', () => {
  it('passe en FUSION_SUGGESTED plutôt qu’en ANALYZED', () => {
    // C'est cet état que `to-process.service` et le tableau de bord lisent
    // pour proposer la fusion.
    expect(NOUVEAU).toContain("setState(groupSourceIds, 'FUSION_SUGGESTED')");
  });

  it('n’entre pas dans le total analysé', () => {
    // Sans cela, déposer deux fois la même facture consomme deux analyses.
    expect(NOUVEAU).toMatch(/!persisted\.deduplicated && !estDoublon\) analysedCount\+\+/);
  });

  it('la détection ne fait jamais échouer l’analyse', () => {
    // Elle a réussi et ses résultats sont écrits ; un doublon non détecté
    // se rattrape.
    const bloc = NOUVEAU.slice(
      NOUVEAU.indexOf('detectFusionCandidates'),
      NOUVEAU.indexOf('if (!estDoublon)'),
    );
    expect(bloc).toMatch(/catch/);
  });

  it('n’est cherché que sur un document réellement analysé', () => {
    // Un document en échec ou à valider n'a pas de doublon à chercher.
    expect(NOUVEAU).toMatch(/if \(etatFinal === 'ANALYZED'\)/);
  });
});

describe('l’enchaînement aval reste par événement (§10.2)', () => {
  it('le pipeline n’importe ni la réconciliation ni l’agenda', () => {
    // L'indirection est ce qui permet le mode observation : un import direct
    // le rendrait impossible.
    expect(NOUVEAU).toContain('emitSourceAnalyzed');
    expect(NOUVEAU).not.toMatch(/from '\.\.\/reconciliation'/);
    expect(NOUVEAU).not.toMatch(/reconcileAsset/);
  });
});
