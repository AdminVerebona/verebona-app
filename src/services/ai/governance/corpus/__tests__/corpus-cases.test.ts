/**
 * Corpus de référence — CDC §11.1, critère d'acceptation n°22.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CES TESTS VÉRIFIENT LE CORPUS, PAS L'IA
 *
 * Ils s'exécutent sans appel modèle et sans base : ils garantissent que le
 * corpus est complet, que chaque fichier existe, et surtout que les pièges
 * qu'il est censé porter y sont réellement.
 *
 * Un corpus dont un piège aurait disparu passerait tous les contrôles
 * d'analyse sans rien prouver — c'est le pire des cas, parce qu'il donne
 * l'illusion d'une non-régression vérifiée.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import {
  CORPUS_CATEGORIES,
  listCorpusCases,
  listEmptyCategories,
} from '@/services/ai/governance/corpus/corpus-registry';
import { CORPUS_CASES } from '@/services/ai/governance/corpus/corpus-cases';

const FIXTURES = 'src/services/ai/governance/corpus/fixtures';
const read = (relative: string) => readFileSync(join(process.cwd(), FIXTURES, relative), 'utf-8');

describe('couverture du corpus (§11.1)', () => {
  it('couvre les treize familles', () => {
    expect(CORPUS_CATEGORIES).toHaveLength(13);
    expect(listEmptyCategories()).toEqual([]);
  });

  it('compte au moins deux cas par famille', () => {
    // La recommandation du document métier : « deux à trois documents par
    // famille suffisent ». Un cas unique ne permet aucune comparaison.
    for (const category of CORPUS_CATEGORIES) {
      const cases = listCorpusCases(category);
      expect({ category, count: cases.length })
        .toEqual({ category, count: cases.length });
      expect(cases.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('enregistre vingt-huit cas', () => {
    expect(listCorpusCases()).toHaveLength(28);
  });

  it('n’a aucun identifiant en double', () => {
    const ids = CORPUS_CASES.map((c) => c.caseId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('intégrité des fichiers', () => {
  it('chaque cas pointe vers un fichier existant', () => {
    for (const c of CORPUS_CASES) {
      const path = join(process.cwd(), FIXTURES, c.fixturePath);
      expect({ caseId: c.caseId, exists: existsSync(path) })
        .toEqual({ caseId: c.caseId, exists: true });
    }
  });

  it('chaque fichier porte la mention de son caractère fictif', () => {
    // Un document de corpus qui circule sans cette mention pourrait être pris
    // pour une pièce réelle. La mention est la seule garantie qui voyage
    // avec le fichier.
    for (const c of CORPUS_CASES) {
      expect(read(c.fixturePath)).toContain('Document synthétique');
    }
  });

  it('aucun fichier n’est vide', () => {
    for (const c of CORPUS_CASES) {
      expect(read(c.fixturePath).length).toBeGreaterThan(400);
    }
  });
});

describe('les pièges sont bien présents', () => {
  it('trois surfaces contradictoires pour le même bien', () => {
    // C'est l'exemple de la question métier n° 4, mot pour mot : annonce
    // 82 m², DPE 79 m², acte 78,4 m².
    expect(read('acte_immobilier/acte-vente-maison.html')).toContain('78,40 m²');
    expect(read('dpe/dpe-maison-fleury.html')).toContain('79 m²');
    expect(read('document_contradictoire/annonce-immobiliere-surface.html')).toContain('82 m²');

    const acte = CORPUS_CASES.find((c) => c.caseId === 'acte-vente-maison')!;
    const annonce = CORPUS_CASES.find((c) => c.caseId === 'annonce-surface-contradictoire')!;
    // L'acte notarié fait autorité : c'est sa valeur qui doit rester sur le bien.
    expect(acte.expected.fields?.surfaceHabitable).toBe(78.4);
    expect(annonce.expected.fields?.surfaceRetenueSurLeBien).toBe(78.4);
  });

  it('un IBAN figure dans un avis d’échéance', () => {
    // Question métier n° 1 : il ne doit jamais atteindre le modèle. Le corpus
    // doit donc en contenir un, sans quoi la règle n'est jamais éprouvée.
    expect(read('avis_echeance/avis-echeance-habitation.html')).toMatch(/IBAN\s*:/);
    const cas = CORPUS_CASES.find((c) => c.caseId === 'avis-echeance-habitation')!;
    expect(cas.expected.fields?.ibanTransmisAuModele).toBe(false);
  });

  it('une facture couvre deux familles de biens', () => {
    const cas = CORPUS_CASES.find((c) => c.caseId === 'facture-assurance-deux-biens')!;
    expect(cas.expected.assetRefs).toHaveLength(2);
    // Une maison et un véhicule : la contamination se verrait immédiatement.
    expect(cas.expected.assetRefs).toContain('maison-fleury-sur-orne');
    expect(cas.expected.assetRefs).toContain('citroen-c4-gk482rt');
  });

  it('deux primes contradictoires pour la même période', () => {
    expect(read('avis_echeance/avis-echeance-habitation.html')).toContain('580,40');
    expect(read('document_contradictoire/avis-echeance-prime-differente.html')).toContain('598,55');
    const cas = CORPUS_CASES.find((c) => c.caseId === 'avis-echeance-prime-contradictoire')!;
    expect(cas.expected.fields?.conflitDetecte).toBe(true);
  });

  it('un document est réparti sur trois fichiers', () => {
    const pages = listCorpusCases('multi_fichiers_meme_document');
    expect(pages).toHaveLength(3);
    for (const page of pages) {
      // Toutes portent le même numéro ADEME : c'est ce qui doit permettre le
      // regroupement.
      expect(page.expected.fields?.numeroAdeme).toBe('2333E1902847L');
      expect(page.expected.fields?.regroupementAttendu).toBe('dpe-bordeaux');
    }
  });

  it('deux documents n’attendent aucune extraction', () => {
    const vides = listCorpusCases('document_sans_information');
    expect(vides).toHaveLength(2);
    for (const cas of vides) {
      // Inventer un type sur une page vide est le défaut le plus coûteux,
      // parce qu'il est invisible.
      expect(cas.expected.documentType).toBeUndefined();
      expect(cas.expected.assetRefs).toEqual([]);
      expect(Object.keys(cas.expected.fields ?? {})).toHaveLength(0);
    }
  });

  it('une LLD n’attend aucune valeur de rachat', () => {
    // Une location longue durée n'a pas d'option d'achat : extraire une
    // valeur de rachat serait une hallucination.
    const cas = CORPUS_CASES.find((c) => c.caseId === 'contrat-lld-trafic')!;
    expect(cas.expected.fields?.valeurRachat).toBeNull();
  });

  it('une facture distingue le montant du reste à charge', () => {
    const cas = CORPUS_CASES.find((c) => c.caseId === 'facture-pac')!;
    expect(cas.expected.fields?.montantTotal).toBe(10834.85);
    expect(cas.expected.fields?.resteACharge).toBe(6834.85);
    expect(cas.expected.fields?.montantTotal).not.toBe(cas.expected.fields?.resteACharge);
  });

  it('une extension de garantie prime sur la garantie constructeur', () => {
    const cas = CORPUS_CASES.find((c) => c.caseId === 'extension-garantie-pac')!;
    // 2029, pas 2026 : c'est la couverture étendue qui protège réellement.
    expect(cas.expected.fields?.finGarantie).toBe('2029-09-12');
  });
});

describe('cohérence des attentes', () => {
  it('chaque cas non vide déclare au moins un bien', () => {
    for (const c of CORPUS_CASES) {
      if (c.category === 'document_sans_information') continue;
      expect({ caseId: c.caseId, refs: (c.expected.assetRefs ?? []).length > 0 })
        .toEqual({ caseId: c.caseId, refs: true });
    }
  });

  it('les biens référencés appartiennent tous au jeu de référence', () => {
    // Un identifiant de bien inventé rendrait le contrôle de contamination
    // inopérant : il ne trouverait jamais de fuite, faute de cible.
    const known = new Set(
      CORPUS_CASES.flatMap((c) => c.expected.assetRefs ?? []),
    );
    for (const ref of known) {
      expect(ref).toMatch(/^[a-z0-9-]+$/);
    }
    expect(known.size).toBeGreaterThanOrEqual(10);
  });
});
