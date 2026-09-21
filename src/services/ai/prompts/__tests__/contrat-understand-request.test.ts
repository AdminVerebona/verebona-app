/**
 * CDC §5.3, §17.8 — le prompt et le schéma de sortie sont un seul contrat.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE DÉFAUT QUE CES TESTS EMPÊCHENT DE REVENIR
 *
 * Deux conceptions d'assistant coexistaient, l'une par outils, l'autre par
 * intentions, appelant la MÊME opération `understand_request` donc le même
 * prompt, en attendant deux sorties incompatibles. Le prompt stocké servait la
 * conception par outils ; le consommateur réel attendait une intention.
 *
 * Résultat en préproduction : toute classification échouait sur « Sortie non
 * conforme au schéma. intent : Invalid input », et l'assistant répondait qu'il
 * manquait d'éléments à chaque question que les règles ne reconnaissaient pas.
 *
 * Aucun test ne pouvait le voir : chacun des deux côtés était cohérent avec
 * lui-même. Ce fichier vérifie ce que ni l'un ni l'autre ne vérifiait — qu'ils
 * parlent de la même chose.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { AI_OPERATIONS } from '../../registry/operations';
import { GEMINI_PUBLIC_CATALOG } from '../../gateway/pricing/gemini-public-catalog';

function lirePrompt(code: string, dossier: string): string {
  return readFileSync(
    join(process.cwd(), 'src', 'services', 'ai', 'prompts', dossier, `${code}.txt`),
    'utf8',
  );
}

describe('understand_request — prompt et schéma disent la même chose', () => {
  const prompt = lirePrompt('understand_request_v1', 'assistant');

  it('demande les champs que le validateur exige', () => {
    for (const champ of ['"intent"', '"confidence"', '"entityHints"', '"reason"']) {
      expect(prompt, champ).toContain(champ);
    }
  });

  it("ne demande plus la sortie de l'ancienne conception par outils", () => {
    // `{ tools: [...] }` était la sortie attendue par `tool-planner.service`,
    // code mort aujourd'hui. Sa réapparition ici casserait la classification.
    expect(prompt).not.toContain('"tools"');
    expect(prompt).not.toContain('{{TOOLS}}');
  });

  it("n'utilise que les variables réellement fournies par l'appelant", () => {
    // `classification.adapter` passe QUESTION et INTENTS, rien d'autre. Un
    // marqueur sans valeur reste tel quel dans le texte envoyé au modèle.
    const marqueurs = [...prompt.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)].map((m) => m[1]);
    expect([...new Set(marqueurs)].sort()).toEqual(['INTENTS', 'QUESTION']);
  });

  it('interdit explicitement une intention hors catalogue (§9.1)', () => {
    expect(prompt).toMatch(/UNKNOWN/);
    expect(prompt.toLowerCase()).toMatch(/invent/);
  });
});

describe("les modèles de l'assistant sont tarifables", () => {
  const modeles = new Set<string>();
  for (const op of Object.values(AI_OPERATIONS)) {
    if (op.useCaseCode !== 'INTELLIGENT_ASSISTANT' || op.provider === 'none') continue;
    modeles.add(op.primaryModel);
    for (const f of op.fallbackModels) modeles.add(f);
  }

  it('figurent au catalogue public, sans quoi le démarrage bloque en production', () => {
    // `assertPricingReady` refuse le démarrage lorsqu'un modèle d'un usage
    // basculé n'a pas de tarif. Choisir un modèle absent du catalogue rendrait
    // l'application indéployable — et on ne s'en apercevrait qu'en production.
    const connus = new Set(GEMINI_PUBLIC_CATALOG.map((p) => p.model));
    for (const m of modeles) {
      expect(connus.has(m), `${m} absent du catalogue tarifaire public`).toBe(true);
    }
  });

  it("n'emploie aucun modèle Pro (§31.2)", () => {
    for (const m of modeles) {
      expect(m, m).not.toMatch(/-pro\b/);
    }
  });
});

describe('analyze_instruction — le prompt offre bien une issue autre que « modifier »', () => {
  const prompt = lirePrompt('analyze_instruction_v1', 'governance');

  it('demande un verdict parmi les quatre causes (T5-009)', () => {
    // Sans cette issue, un modèle à qui l'on demande une modification de prompt
    // en produira une — même quand le problème est dans le code ou les données.
    for (const v of ['"prompt"', '"code"', '"donnees"', '"configuration"']) {
      expect(prompt, v).toContain(v);
    }
  });

  it('montre explicitement une réponse sans proposition', () => {
    expect(prompt).toContain('"proposedContent": null');
  });

  it('demande les champs que le validateur exige', () => {
    for (const champ of ['"verdict"', '"analysis"', '"proposedContent"', '"risks"', '"recommendations"']) {
      expect(prompt, champ).toContain(champ);
    }
  });

  it("ne demande plus l'ancien champ, qui n'est plus lu", () => {
    expect(prompt).not.toContain('"impactAnalysis"');
  });
});
