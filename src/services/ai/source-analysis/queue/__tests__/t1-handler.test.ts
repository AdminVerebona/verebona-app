/**
 * CDC BO IA GEN-004, NFR-003, §10.4 — bascule de la file T1.
 *
 * Le dépôt de documents est un chemin critique : si la file durable se trompe,
 * plus aucune analyse ne part. Ces tests portent sur la bascule elle-même, pas
 * sur l'analyse — c'est elle qui décide quelle file s'exécute, et il ne doit
 * jamais y en avoir deux.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { isDurableQueueEnabled } from '../t1-handler';
import { AI_FLAGS } from '@/services/ai/flags/ai-feature-flags';

const initial = { ...process.env };
afterEach(() => { process.env = { ...initial }; });

describe('bascule de file', () => {
  it('reste sur la file en mémoire par défaut', () => {
    // Une bascule ne s'active jamais par omission : un déploiement qui oublie
    // la variable doit se comporter comme avant.
    delete process.env.AI_DURABLE_QUEUE;
    expect(isDurableQueueEnabled()).toBe(false);
  });

  it('accepte les formes habituelles du dépôt', () => {
    for (const v of ['enabled', 'true', '1', 'ENABLED']) {
      process.env.AI_DURABLE_QUEUE = v;
      expect(isDurableQueueEnabled(), v).toBe(true);
    }
  });

  it("traite toute autre valeur comme un refus", () => {
    // Y compris `shadow` : deux files analyseraient le même document deux fois,
    // ce que le §10.4 interdit. Mieux vaut l'ignorer que le deviner.
    for (const v of ['legacy', 'shadow', 'oui', '']) {
      process.env.AI_DURABLE_QUEUE = v;
      expect(isDurableQueueEnabled(), v).toBe(false);
    }
  });
});

describe('séparation des drapeaux', () => {
  it("ne figure pas parmi les drapeaux d'usage IA", () => {
    // `AI_FLAGS` signifie « un drapeau par usage du référentiel ». L'y ajouter a
    // fait tomber la bijection usage ⇄ drapeau et le rapport d'inventaire, le
    // 18/09/2026 — à juste titre : une bascule technique n'est pas un usage.
    expect(AI_FLAGS as readonly string[]).not.toContain('AI_DURABLE_QUEUE');
    expect(AI_FLAGS).toHaveLength(6); // un par usage, mascotte T6 comprise
  });
});
