/**
 * Harnais de corpus — accord avec les prompts réels.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LA CAMPAGNE MESURAIT LE HARNAIS, PAS LE MOTEUR
 *
 * Résultat de la première campagne réelle : 2 conformes sur 28, tous les
 * champs `missing`, 26 erreurs de type, 28 replis.
 *
 * Trois désaccords, tous du côté du harnais :
 *
 *   · il envoyait `documentText` et `candidateAssets` ; le gabarit attend
 *     `EXTRACTED_CONTENT`, `ASSET_CONTEXT`, `SOURCE_KIND`, `EXISTING_TITLES`.
 *     Le modèle recevait un prompt aux marqueurs non substitués ;
 *
 *   · il attendait `fields` sous forme d'objet ; le prompt rend un TABLEAU
 *     de `{ fieldKey, value }` ;
 *
 *   · il lisait `documentType` dans la sortie d'extraction, qui n'en produit
 *     aucun — c'est une opération distincte.
 *
 * Les deux seuls cas conformes étaient `document_sans_information` : on
 * n'attendait rien d'eux, et le harnais ne rendait rien.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const RUNNER = read('src/services/ai/governance/corpus/analysis-runner.ts');
const PROMPT_EXTRACT = read('src/services/ai/prompts/source-analysis/extract_source_v2.txt');
const PROMPT_CLASSIFY = read('src/services/ai/prompts/source-analysis/classify_document_v2.txt');

/** Marqueurs réellement attendus par un gabarit. */
const marqueurs = (gabarit: string) =>
  [...new Set([...gabarit.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]))];

describe('le harnais alimente tous les marqueurs des prompts', () => {
  it('couvre ceux de extract_source', () => {
    // Un marqueur non substitué laisse « {{EXTRACTED_CONTENT}} » dans le
    // prompt envoyé : le modèle ne voit pas le document.
    for (const m of marqueurs(PROMPT_EXTRACT)) {
      expect(RUNNER, `marqueur ${m} non alimenté`).toContain(m);
    }
  });

  it('couvre ceux de classify_document', () => {
    for (const m of marqueurs(PROMPT_CLASSIFY)) {
      expect(RUNNER, `marqueur ${m} non alimenté`).toContain(m);
    }
  });

  it('n’emploie plus les noms inventés', () => {
    expect(RUNNER).not.toMatch(/documentText:/);
    expect(RUNNER).not.toMatch(/candidateAssets:/);
  });
});

describe('le type vient de la bonne opération', () => {
  it('classify_document est appelée', () => {
    // extract_source ne rend aucun documentType.
    expect(RUNNER).toMatch(/operationCode: 'classify_document'/);
  });

  it('le type est lu dans sa réponse, pas dans l’extraction', () => {
    expect(RUNNER).toMatch(/classification\.data\.documentType/);
    expect(RUNNER).not.toMatch(/extraction\.data\.documentType/);
  });

  it('les deux appels ont des clés d’idempotence distinctes', () => {
    // Une clé commune ferait servir la réponse d'extraction à la
    // classification.
    expect(RUNNER).toMatch(/:extract`/);
    expect(RUNNER).toMatch(/:classify`/);
  });
});

describe('la sortie du prompt est aplatie vers la forme comparée', () => {
  it('le tableau fieldKey/value est parcouru', () => {
    expect(RUNNER).toMatch(/for \(const f of sortie\.fields \?\? \[\]\)/);
    expect(RUNNER).toMatch(/champs\[f\.fieldKey\] = f\.value/);
  });

  it('un fieldKey explicite l’emporte sur un champ de tête', () => {
    // Le cas de corpus nomme la clé qu'il attend : elle fait autorité.
    expect(RUNNER).toMatch(/champs\[cle\] === undefined/);
  });

  it('le coût cumule les deux appels', () => {
    expect(RUNNER).toMatch(/extraction\.costMicros \?\? 0\) \+ \(classification\.costMicros/);
  });
});

describe('le vocabulaire des champs est imposé au corpus, libre ailleurs', () => {
  // ══════════════════════════════════════════════════════════════════════
  // 6 CHAMPS CORRECTS SUR 83
  //
  // `fieldKey` était un `z.string()` sans vocabulaire : le modèle nommait
  // librement — l'exemple du prompt étant `registrationNumber`, en anglais —
  // tandis que le corpus attend `immatriculation`.
  //
  // Il extrayait probablement les bonnes valeurs. Le comparateur ne les
  // reconnaissait pas.
  // ══════════════════════════════════════════════════════════════════════
  const ETAPE = read('src/services/ai/source-analysis/steps/extract-source.step.ts');

  it('le prompt accepte une liste de clés', () => {
    expect(PROMPT_EXTRACT).toContain('{{EXPECTED_FIELDS}}');
  });

  it('le prompt reste utilisable sans liste', () => {
    // Le pipeline réel n'en a pas encore : sans cette règle, son marqueur
    // vide changerait le comportement en production.
    expect(PROMPT_EXTRACT).toMatch(/Si aucune liste n'est fournie, nomme librement/);
  });

  it('la liste ne restreint pas ce qui est extrait', () => {
    // Une information hors liste doit remonter quand même — sinon on
    // mesurerait la capacité à suivre une consigne, pas à extraire.
    expect(PROMPT_EXTRACT).toMatch(/ne restreint pas ce que tu extrais/);
  });

  it('le harnais transmet les clés attendues par le cas', () => {
    expect(RUNNER).toMatch(/EXPECTED_FIELDS: Object\.keys\(corpusCase\.expected\.fields/);
  });

  it('le pipeline réel alimente la variable, vide', () => {
    // Non alimentée, elle laisserait « {{EXPECTED_FIELDS}} » dans le prompt
    // envoyé en production.
    expect(ETAPE).toMatch(/EXPECTED_FIELDS: ''/);
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

  it('elle reste distincte entre extraction et classification', () => {
    // Une clé commune ferait servir la réponse d'extraction à la
    // classification.
    expect(RUNNER).toMatch(/:extract`/);
    expect(RUNNER).toMatch(/:classify`/);
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
