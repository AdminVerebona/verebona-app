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
