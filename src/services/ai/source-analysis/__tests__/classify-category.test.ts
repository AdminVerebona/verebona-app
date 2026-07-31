/**
 * Classement par catégorie — CDC 5 §7.1, §4.3, §8.2.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * TROIS RÈGLES QUI COÛTENT CHER SI ELLES SAUTENT
 *
 * · Le déterminisme d'abord. Un DPE n'admet qu'une catégorie : l'appeler au
 *   modèle serait payer pour une déduction. Sur un parc de documents, la
 *   différence est celle entre quelques appels et des milliers.
 *
 * · Le modèle ne choisit que parmi des candidates. Libre, il proposerait des
 *   catégories que l'interface refuserait d'afficher — et le document
 *   resterait « à classer » sans que rien ne l'explique.
 *
 * · La confiance n'est jamais exposée (§8.2). Elle sert à mesurer le modèle,
 *   pas à décorer une interface.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { buildCompatibilityIndex } from '@/services/documents/classification-rules';
import { decideCategory } from '@/services/documents/reclassify.service';

const ETAPE = readFileSync(
  join(process.cwd(), 'src/services/ai/source-analysis/steps/classify-category.step.ts'),
  'utf-8',
);
const PIPELINE = readFileSync(
  join(process.cwd(), 'src/services/ai/source-analysis/pipeline.ts'),
  'utf-8',
);

const ASSOCIATIONS = [
  { typeCode: 'DPE', categoryCode: 'CONFORMITE_CONTROLES' },
  { typeCode: 'GARANTIE', categoryCode: 'GARANTIES_NOTICES' },
  { typeCode: 'FACTURE', categoryCode: 'ACHAT_VALEUR' },
  { typeCode: 'FACTURE', categoryCode: 'ENTRETIEN_REPARATIONS' },
];
const TOUTES = ['CONFORMITE_CONTROLES', 'GARANTIES_NOTICES', 'ACHAT_VALEUR', 'ENTRETIEN_REPARATIONS'];
const index = buildCompatibilityIndex(ASSOCIATIONS, TOUTES);

describe('déterminisme avant modèle (§4.3)', () => {
  it('un type à catégorie unique ne sollicite pas le modèle', () => {
    // La règle est celle de la reprise mécanique, réemployée telle quelle :
    // deux implémentations de la même règle finiraient par diverger.
    expect(decideCategory('DPE', index, index))
      .toEqual({ decision: 'classify', categoryCode: 'CONFORMITE_CONTROLES' });
    expect(ETAPE).toContain('decideCategory');
  });

  it('l’étape sort avant l’appel quand la règle a tranché', () => {
    const posVerdict = ETAPE.indexOf("verdict.decision === 'classify'");
    const posAppel = ETAPE.indexOf('AiGateway.execute');
    expect(posVerdict).toBeGreaterThan(-1);
    expect(posVerdict).toBeLessThan(posAppel);
  });

  it('une déduction est marquée « certain », pas estimée', () => {
    const bloc = ETAPE.slice(posBloc(), ETAPE.indexOf('AiGateway.execute'));
    expect(bloc).toMatch(/confidence: 'certain'/);
  });

  function posBloc() { return ETAPE.indexOf("verdict.decision === 'classify'"); }
});

describe('le modèle ne choisit que parmi des candidates', () => {
  it('les candidates sont transmises dans l’invite', () => {
    expect(ETAPE).toContain('CANDIDATE_CATEGORIES');
  });

  it('un code hors liste est refusé', () => {
    // Sans ce garde-fou, un classement inaffichable serait écrit et le
    // document resterait « à classer » sans explication.
    expect(ETAPE).toMatch(/if \(!candidates\.includes\(propose\)\)/);
  });

  it('le refus ne rend aucune catégorie', () => {
    const bloc = ETAPE.slice(
      ETAPE.indexOf('if (!candidates.includes(propose))'),
      ETAPE.indexOf('return {\n    category: {'),
    );
    expect(bloc).toMatch(/deterministic: false/);
    expect(bloc).not.toMatch(/category: \{/);
  });

  it('les candidates tiennent compte des biens rattachés (§4.4)', () => {
    expect(ETAPE).toContain('documentCategoryAssetAssociations');
  });
});

describe('écriture du classement (§5.2)', () => {
  it('passe par updateClassification, jamais par une écriture directe', () => {
    // Ce service applique les verrouillages : une catégorie posée par
    // l'utilisateur n'est pas écrasée par le modèle.
    expect(PIPELINE).toContain('updateClassification');
    expect(PIPELINE).not.toMatch(/update\(assetFiles\)[\s\S]{0,200}documentCategoryId/);
  });

  it('déclare l’origine AI', () => {
    expect(PIPELINE).toMatch(/source: 'AI'/);
  });

  it('n’interrompt pas l’analyse en cas d’échec', () => {
    // L'analyse a réussi et les résultats sont écrits : un classement manqué
    // se rattrape, une analyse perdue non.
    const bloc = PIPELINE.slice(
      PIPELINE.indexOf('await updateClassification({'),
      PIPELINE.indexOf('// Étape 9 (suite)'),
    );
    expect(bloc).toMatch(/\.catch\(/);
  });

  it('consigne la version du pipeline', () => {
    // Sans elle, le signal d'échec du §5.2 ne dit pas QUELLE version s'est
    // trompée — donc jamais si une évolution a corrigé ou aggravé.
    expect(PIPELINE).toContain('pipelineVersion: PIPELINE_VERSION');
  });
});

describe('§8.2 — la confiance ne remonte pas au front', () => {
  it('elle est convertie pour le stockage seulement', () => {
    expect(PIPELINE).toContain('confidenceToScore');
    expect(PIPELINE).toMatch(/categoryConfidence: confidenceToScore/);
  });

  it('le contrat de consultation ne la porte pas', () => {
    // Vérifié à la source : l'omission est structurelle, le compilateur
    // refuserait de l'ajouter dans une route.
    const contrat = readFileSync(
      join(process.cwd(), 'src/services/documents/document-query.contract.ts'),
      'utf-8',
    );
    expect(contrat).not.toMatch(/categoryConfidence\s*[?:]/);
    expect(contrat).not.toMatch(/typeConfidence\s*[?:]/);
  });
});
