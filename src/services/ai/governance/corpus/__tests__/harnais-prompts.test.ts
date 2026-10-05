/**
 * Harnais de corpus — accord avec le prompt réel.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LA CAMPAGNE MESURAIT LE HARNAIS, PAS LE MOTEUR
 *
 * Première campagne réelle : 2 conformes sur 28 — le harnais envoyait des
 * variables que le gabarit ne connaissait pas, lisait `fields` sous une forme
 * que le prompt ne rendait pas, et cherchait le type dans une sortie qui n'en
 * produisait aucun.
 *
 * Lot 16b-3 : les opérations d'étapes (`extract_source`, `classify_document`)
 * sont supprimées ; le harnais mesure la branche ANALYZE_DOCUMENT du prompt
 * maître T1. Les mêmes garde-fous s'appliquent : TOUTES les variables du
 * master, la forme réelle de la sortie, le type lu dans la classification.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { inspectMasterTemplate } from '../../../prompts/prompt-loader';
import { T1_PROMPT_VARIABLES } from '../../../source-analysis/master/prompt-context';
import { aplatir } from '../analysis-runner';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const RUNNER = read('src/services/ai/governance/corpus/analysis-runner.ts');
const MASTER = read('src/services/ai/prompts/source-analysis/t1_master_v1.txt');

describe('le harnais alimente tous les emplacements du master T1', () => {
  it('variables construites par la fonction de production (exactement celles du master)', () => {
    expect(RUNNER).toMatch(/buildAnalyzeDocumentVariables\(/);
    const info = inspectMasterTemplate(MASTER);
    expect(info.placeholders.filter((p) => p !== 'TASK').sort()).toEqual([...T1_PROMPT_VARIABLES].sort());
  });

  it('branche ANALYZE_DOCUMENT, normalisation tolérante comme en production', () => {
    expect(RUNNER).toMatch(/task: 'ANALYZE_DOCUMENT'/);
    expect(RUNNER).toMatch(/outputSchema: T1AnalyzeDocumentTolerantOutput/);
    expect(RUNNER).toMatch(/splitNormalisation\(/);
  });

  it('n’emploie plus les opérations d’étapes ni les noms inventés', () => {
    expect(RUNNER).not.toMatch(/operationCode: '(extract_source|classify_document)'/);
    expect(RUNNER).not.toMatch(/documentText:/);
    expect(RUNNER).not.toMatch(/candidateAssets:/);
  });
});

describe('la sortie du master est aplatie vers la forme comparée', () => {
  const sortie = {
    task: 'ANALYZE_DOCUMENT',
    document: {
      title: { value: 'Facture Pneus Clio', confidence: 'certain', evidence: {} },
      documentDate: { value: '2026-03-14', confidence: 'certain', evidence: {} },
      supplier: { name: 'Garage Martin', confidence: 'certain', evidence: {} },
      amountCents: { value: 42000, confidence: 'certain', evidence: {} },
    },
    facts: [
      { canonicalKey: 'mileage', normalizedValue: 78000 },
      { canonicalKey: null, rawKey: 'immatriculation', normalizedValue: 'AB-123-CD' },
      { canonicalKey: null, rawKey: 'title', normalizedValue: 'Titre explicite' },
      { canonicalKey: 'x', normalizedValue: null },
    ],
  } as never;

  it('faits sous leur clé canonique, à défaut leur clé lue ; valeurs nulles ignorées', () => {
    const c = aplatir(sortie);
    expect(c).toMatchObject({ mileage: 78000, immatriculation: 'AB-123-CD' });
    expect(c).not.toHaveProperty('x');
  });

  it('un fait explicite l’emporte sur un champ de tête', () => {
    const c = aplatir(sortie);
    expect(c.title).toBe('Titre explicite');
    expect(c).toMatchObject({ documentDate: '2026-03-14', dateFacture: '2026-03-14', supplier: 'Garage Martin', amountCents: 42000 });
  });

  it('le type vient de la classification du master', () => {
    expect(RUNNER).toMatch(/c\?\.canonicalType \?\? c\?\.documentTypeCode/);
  });
});

describe('chaque campagne mesure vraiment', () => {
  // ══════════════════════════════════════════════════════════════════════
  // 2 MILLISECONDES PAR CAS
  //
  // La clé d'idempotence était `corpus:<cas>:extract`, stable d'une campagne
  // à l'autre. Le prompt ayant changé — c'est l'objet même des campagnes
  // successives — la seconde a rejoué les réponses de la première.
  //
  // Coût nul, durée de 2 ms, résultats identiques au champ près. Les
  // chiffres paraissaient plausibles : c'est ce qui rendait le défaut
  // dangereux.
  // ══════════════════════════════════════════════════════════════════════
  const STATUS = read('src/app/api/cron/ai/corpus-status/route.ts');

  it('la clé d’idempotence porte un identifiant de campagne', () => {
    expect(RUNNER).toMatch(/const campagne = /);
    expect(RUNNER).toMatch(/corpus:\$\{campagne\}/);
  });

  it('un seul appel par cas, clé propre à la campagne et au cas', () => {
    expect(RUNNER).toMatch(/idempotencyKey: `corpus:\$\{campagne\}:\$\{corpusCase\.caseId\}:analyze`/);
  });

  it('une campagne trop rapide est signalée', () => {
    expect(STATUS).toMatch(/avgDurationMs < 200/);
  });

  it('et elle n’est pas exploitable', () => {
    expect(STATUS).toMatch(/avgDurationMs >= 200/);
  });
});

describe('une campagne n’est jamais perdue', () => {
  // ══════════════════════════════════════════════════════════════════════
  // 56 APPELS POUR RELIRE UN RÉSULTAT
  //
  // `?compare=1` rendait son verdict dans la réponse HTTP, que la passerelle
  // coupe à trente secondes. Le résultat était donc perdu à chaque fois, et
  // le relire supposait de relancer la campagne.
  // ══════════════════════════════════════════════════════════════════════
  const RUN = read('src/app/api/cron/ai/corpus-run/route.ts');
  const STATUS = read('src/app/api/cron/ai/corpus-status/route.ts');

  it('toute campagne réelle est enregistrée', () => {
    expect(RUN).toMatch(/ecrireRun\(run, DERNIERE\)/);
  });

  it('la référence garde son emplacement propre', () => {
    // Écraser la référence à chaque campagne ôterait tout point de
    // comparaison.
    expect(RUN).toMatch(/const REFERENCE = 1/);
    expect(RUN).toMatch(/const DERNIERE = 2/);
    expect(RUN).toMatch(/ecrireRun\(run, REFERENCE\)/);
  });

  it('l’enregistrement n’interrompt pas la campagne', () => {
    // Elle a coûté 56 appels : une écriture ratée ne doit pas la perdre.
    expect(RUN).toMatch(/ecrireRun\(run, DERNIERE\)\.catch/);
  });

  it('la consultation compose la comparaison sans exécuter', () => {
    expect(STATUS).toContain('isSafeToSwitch');
    expect(STATUS).toContain('detectRegressions');
    expect(STATUS).not.toMatch(/AiGateway|runCorpus/);
  });

  it('elle ne compare pas une campagne à elle-même', () => {
    expect(STATUS).toMatch(/derniere\.startedAt !== reference\.startedAt/);
  });
});

describe('le niveau pipeline traverse réellement le pipeline', () => {
  // ══════════════════════════════════════════════════════════════════════
  // Le runner d'opérations appelle AiGateway directement : il ne traverse
  // ni le regroupement, ni la projection, ni la persistance. Le niveau
  // pipeline passe par `analyzeFileSources`, comme la production.
  // ══════════════════════════════════════════════════════════════════════
  const PIPELINE = read('src/services/ai/governance/corpus/pipeline-runner.ts');
  const ENTREE = read('src/services/ai/source-analysis/entrypoint.ts');
  const RUNNER_SRC = read('src/services/ai/governance/corpus/corpus-runner.ts');

  it('le runner passe par le point de bascule', () => {
    // Commentaires retirés : celui du fichier explique justement pourquoi il
    // n'appelle PAS la passerelle directement. Cinquième fois dans ce projet
    // qu'un test attrape la documentation de la règle qu'il vérifie.
    const code = PIPELINE
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(code).toMatch(/await analyzeFileSources\(/);
    expect(code).not.toMatch(/AiGateway\.execute/);
  });

  it('le type de source est ouvert, avec « file » par défaut', () => {
    // Neuf appelants existants : aucun ne doit changer.
    expect(ENTREE).toMatch(/options\.sourceType \?\? 'file'/);
  });

  it('la campagne ne consomme pas les crédits du compte technique', () => {
    expect(PIPELINE).toMatch(/billable: false/);
  });

  it('les lignes créées sont supprimées, même en cas d’échec', () => {
    // Sans cela, chaque campagne laisserait 28 documents et la suivante
    // analyserait un parc qui grossit.
    expect(PIPELINE).toMatch(/finally \{/);
    expect(PIPELINE).toMatch(/await supprimerSource\(sourceId\)/);
  });

  it('le résultat est relu en base, non pris au retour', () => {
    expect(PIPELINE).toMatch(/FROM asset_files WHERE id =/);
  });

  it('lot 16b-3 : un échec est mesuré, jamais remis en file', () => {
    expect(PIPELINE).toMatch(/retryOnFailure: false/);
  });

  it('deux niveaux de mesure ne se comparent pas', () => {
    expect(RUNNER_SRC).toMatch(/ne mesurent pas la même chose/);
  });
});
