/**
 * Prompts de l'assistant — CDC §17.6.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CES TESTS FIGENT DES ARBITRAGES, PAS DU CODE
 *
 * Chaque assertion correspond à une décision prise par le responsable produit,
 * référencée par son numéro de question. Une reformulation bien intentionnée
 * peut les défaire sans que rien ne le signale : un prompt reste valide quoi
 * qu'on y écrive.
 *
 * Ils remplacent un état où CINQ prompts sur sept étaient identiques à leur
 * première ligne près — un gabarit recopié, que personne n'avait arbitré.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from 'vitest';
import { SYSTEM_PROMPT_V1 } from '@/services/verebona-assistant/prompts/system';
import { ACCOUNT_SUMMARY_PROMPT } from '@/services/verebona-assistant/prompts/account-summary';
import { ACCOUNT_COMPARISON_PROMPT } from '@/services/verebona-assistant/prompts/account-comparison';
import { ACCOUNT_TIMELINE_PROMPT } from '@/services/verebona-assistant/prompts/account-timeline';
import { PRODUCT_HELP_PROMPT } from '@/services/verebona-assistant/prompts/product-help';
import { CLARIFICATION_PROMPT } from '@/services/verebona-assistant/prompts/clarification';
import { toJsonSchema } from '@/services/verebona-assistant/prompts/output-schemas';

const TACHES = {
  summary: ACCOUNT_SUMMARY_PROMPT,
  comparison: ACCOUNT_COMPARISON_PROMPT,
  timeline: ACCOUNT_TIMELINE_PROMPT,
  help: PRODUCT_HELP_PROMPT,
  clarification: CLARIFICATION_PROMPT,
};

describe('les prompts ne sont plus interchangeables', () => {
  it('chacun est distinct des autres', () => {
    // Le défaut d'origine : cinq prompts identiques à une ligne près.
    const valeurs = Object.values(TACHES);
    expect(new Set(valeurs).size).toBe(valeurs.length);
  });

  it('aucun ne recopie les règles communes du prompt système', () => {
    // Une règle recopiée dans cinq fichiers ne se corrige jamais partout.
    for (const [nom, p] of Object.entries(TACHES)) {
      expect({ nom, recopie: p.includes('Tu ne t’appuies QUE sur les sources') })
        .toEqual({ nom, recopie: false });
    }
  });
});

describe('système — décisions Q5, Q6, Q7, Q9', () => {
  it('Q7 — l’assistant ne se présente pas', () => {
    expect(SYSTEM_PROMPT_V1).toMatch(/ne te présentes pas/);
  });

  it('Q9 — vouvoiement', () => {
    expect(SYSTEM_PROMPT_V1).toContain('Tu vouvoies');
  });

  it('Q5 — une absence appelle une proposition de dépôt', () => {
    expect(SYSTEM_PROMPT_V1).toMatch(/proposes de déposer le document/);
  });

  it('Q6 — un refus indique ce qui reste possible', () => {
    // Un refus sec laisse l'utilisateur sans recours.
    expect(SYSTEM_PROMPT_V1).toMatch(/tu indiques dans la même réponse ce que/);
  });

  it('interdit toujours les quatre domaines de conseil', () => {
    for (const d of ['juridique', 'fiscal', 'médical', 'assurantiel']) {
      expect(SYSTEM_PROMPT_V1).toContain(d);
    }
  });
});

describe('Q1 — longueur différenciée', () => {
  it('la synthèse tient en 4 phrases', () => {
    expect(ACCOUNT_SUMMARY_PROMPT).toMatch(/4 phrases maximum/);
  });

  it('la chronologie n’y est PAS tenue', () => {
    // Douze événements en quatre phrases produisent un paragraphe illisible.
    expect(ACCOUNT_TIMELINE_PROMPT).toMatch(/n’es pas tenu par la limite de 4 phrases/);
    expect(ACCOUNT_TIMELINE_PROMPT).toMatch(/UN ÉVÉNEMENT PAR LIGNE/);
  });

  it('la chronologie reste bornée par le schéma', () => {
    // La limite dure de 1200 caractères s'applique quoi qu'il arrive (§21.2).
    expect(ACCOUNT_TIMELINE_PROMPT).toContain('1200 caractères');
  });
});

describe('Q2 — la comparaison emploie une liste', () => {
  it('demande une puce par élément comparé', () => {
    expect(ACCOUNT_COMPARISON_PROMPT).toMatch(/une puce par bien ou document/);
  });

  it('signale une donnée absente au lieu de l’omettre', () => {
    // Omettre laisserait croire que l'élément n'a pas été comparé.
    expect(ACCOUNT_COMPARISON_PROMPT).toMatch(/une absence est une information/);
  });

  it('interdit de classer ou recommander', () => {
    // « Le premier est plus avantageux » est un conseil, hors périmètre.
    expect(ACCOUNT_COMPARISON_PROMPT).toMatch(/ne classes pas et ne recommandes pas/);
  });
});

describe('Q3 et Q4 — la clarification', () => {
  it('Q3 — ne cite aucune source', () => {
    // Une question n'affirme rien : la règle de citation n'a pas d'objet.
    expect(CLARIFICATION_PROMPT).toMatch(/ne cites aucune source/);
    expect(CLARIFICATION_PROMPT).not.toMatch(/doit citer au moins un identifiant/);
  });

  it('Q4 — propose exactement deux options', () => {
    expect(CLARIFICATION_PROMPT).toMatch(/EXACTEMENT DEUX options/);
  });

  it('prévoit le cas où le choix n’est pas binaire', () => {
    expect(CLARIFICATION_PROMPT).toMatch(/question ouverte courte/);
  });

  it('ne répond pas et ne s’explique pas', () => {
    expect(CLARIFICATION_PROMPT).toMatch(/Tu ne réponds pas/);
  });
});

describe('Q8 — l’aide produit reformule', () => {
  it('reformule au lieu de citer', () => {
    expect(PRODUCT_HELP_PROMPT).toMatch(/REFORMULES l’article/);
    expect(PRODUCT_HELP_PROMPT).toMatch(/sans le citer/);
  });

  it('joint le lien vers l’article', () => {
    expect(PRODUCT_HELP_PROMPT).toMatch(/lien vers l’article/);
  });

  it('interdit de fabriquer une URL', () => {
    expect(PRODUCT_HELP_PROMPT).toMatch(/jamais d’URL/);
  });

  it('n’invente pas le fonctionnement du produit', () => {
    expect(PRODUCT_HELP_PROMPT).toMatch(/ne devines pas le fonctionnement/);
  });
});

describe('schéma de sortie — §18.1', () => {
  it('la conversion en JSON Schema fonctionne sur le zod du projet', () => {
    // Le code portait « selon la version de zod, brancher le converter
    // approprié ». Ce test lève le doute : si une mise à jour retirait
    // `z.toJSONSchema`, il échouerait ici plutôt qu'au premier appel modèle.
    const schema = toJsonSchema();
    expect(schema).toBeTypeOf('object');
    expect(schema).toHaveProperty('type');
  });

  it('le schéma décrit bien la réponse attendue', () => {
    const schema = toJsonSchema() as { properties?: Record<string, unknown> };
    expect(Object.keys(schema.properties ?? {})).toEqual(
      expect.arrayContaining(['answer']),
    );
  });
});
