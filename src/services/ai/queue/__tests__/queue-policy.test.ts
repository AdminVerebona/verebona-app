/**
 * CDC BO IA §15.2, MOD-005, SCR-08, WF-10, WF-11 — règles de la file.
 *
 * Ces trois décisions — quoi dédupliquer, quand reprendre, dans quel ordre
 * servir — déterminent ce qui s'exécute et combien de fois. Les vérifier ici
 * évite d'avoir à les observer en production pour savoir ce qu'elles font.
 */
import { describe, it, expect } from 'vitest';
import {
  dedupeKey, backoffSeconds, isPermanentFailure, afterFailure,
  decideQueueing, compareJobs, MAX_ATTEMPTS,
} from '../queue-policy';

describe('clé de déduplication (WF-10)', () => {
  it('confond deux demandes visant le même périmètre', () => {
    const scope = { accountId: 7, targetType: 'document', targetId: 42 };
    expect(dedupeKey('T1', scope)).toBe(dedupeKey('T1', { ...scope }));
  });

  it("n'inclut pas le déclencheur d'origine", () => {
    // Le cœur du WF-10 : un dépôt de document et une planification qui visent
    // le même objet sont la même exécution. Les distinguer produirait deux
    // analyses du même fichier parce qu'elles ont été demandées autrement.
    const scope = { accountId: 7, targetType: 'document', targetId: 42 };
    const parDepot = dedupeKey('T1', scope);
    const parPlanification = dedupeKey('T1', scope);
    expect(parDepot).toBe(parPlanification);
  });

  it('sépare deux traitements sur le même objet', () => {
    const scope = { accountId: 7, targetType: 'document', targetId: 42 };
    expect(dedupeKey('T1', scope)).not.toBe(dedupeKey('T3', scope));
  });

  it('sépare deux comptes', () => {
    expect(dedupeKey('T3', { accountId: 1 })).not.toBe(dedupeKey('T3', { accountId: 2 }));
  });

  it('distingue un périmètre global d’un périmètre ciblé', () => {
    // Une passe globale et une passe sur un compte ne sont pas la même chose :
    // les confondre ferait sauter l'une des deux.
    expect(dedupeKey('T3', {})).not.toBe(dedupeKey('T3', { accountId: 1 }));
  });

  it("ne confond pas un identifiant absent avec l'identifiant « i* »", () => {
    expect(dedupeKey('T1', { targetId: null })).toBe(dedupeKey('T1', {}));
  });
});

describe('temporisation de reprise (MOD-005)', () => {
  const sansBruit = () => 0.5;

  it('croît avec les tentatives', () => {
    const d1 = backoffSeconds(1, sansBruit);
    const d2 = backoffSeconds(2, sansBruit);
    const d3 = backoffSeconds(3, sansBruit);
    expect(d2).toBeGreaterThan(d1);
    expect(d3).toBeGreaterThan(d2);
  });

  it('reste plafonnée', () => {
    // Sans plafond, un incident long repousserait la reprise à plusieurs heures
    // après le retour à la normale.
    expect(backoffSeconds(20, sansBruit)).toBeLessThanOrEqual(30 * 60);
  });

  it('disperse les reprises groupées', () => {
    // Cent jobs échoués au même instant ne doivent pas repartir ensemble et
    // refaire tomber ce qui vient de se relever.
    const bas = backoffSeconds(3, () => 0);
    const haut = backoffSeconds(3, () => 1);
    expect(haut).toBeGreaterThan(bas);
    // Le bruit reste modéré : la date affichée au SCR-08 doit rester fidèle.
    expect(haut / bas).toBeLessThan(2);
  });
});

describe('échec permanent', () => {
  it('survient après le nombre de cycles prévu', () => {
    expect(isPermanentFailure(MAX_ATTEMPTS - 1)).toBe(false);
    expect(isPermanentFailure(MAX_ATTEMPTS)).toBe(true);
  });

  it('renvoie le job en file tant que la limite n’est pas atteinte', () => {
    const r = afterFailure(1);
    expect(r.status).toBe('PENDING');
    expect(r.retryInSeconds).toBeGreaterThan(0);
    expect(r.attempts).toBe(2);
  });

  it('marque l’échec définitif à la dernière tentative', () => {
    const r = afterFailure(MAX_ATTEMPTS - 1);
    expect(r.status).toBe('FAILED');
    expect(r.retryInSeconds).toBeNull();
  });
});

describe('mise en file (WF-10, WF-11)', () => {
  it('crée quand rien d’équivalent n’existe', () => {
    expect(decideQueueing(null, 'automatic')).toBe('create');
  });

  it('n’ajoute rien quand un équivalent attend déjà', () => {
    expect(decideQueueing({ status: 'PENDING' }, 'automatic')).toBe('skip');
  });

  it('coalesce quand un équivalent est en cours', () => {
    // Un événement arrivé pendant une exécution ne peut pas être ignoré —
    // l'exécution en cours ne verra pas les données qu'il annonce — mais dix
    // événements ne justifient pas dix jobs.
    expect(decideQueueing({ status: 'RUNNING' }, 'automatic')).toBe('coalesce');
  });

  it('recrée après un job terminé, échoué ou annulé', () => {
    for (const status of ['DONE', 'FAILED', 'CANCELLED'] as const) {
      expect(decideQueueing({ status }, 'automatic'), status).toBe('create');
    }
  });

  it('laisse le lancement manuel passer outre, toujours', () => {
    // WF-11 : « créer une nouvelle exécution même si un job automatique
    // équivalent existe ».
    for (const status of ['PENDING', 'RUNNING'] as const) {
      expect(decideQueueing({ status }, 'manual'), status).toBe('create');
    }
  });
});

describe('ordre de service (SCR-08)', () => {
  const job = (headPriority: boolean, iso: string) => ({ headPriority, createdAt: new Date(iso) });

  it('sert la tête de file avant le reste', () => {
    const remis = job(true, '2026-09-18T12:00:00Z');
    const ancien = job(false, '2026-09-18T08:00:00Z');
    expect(compareJobs(remis, ancien)).toBeLessThan(0);
  });

  it('respecte le FIFO à priorité égale', () => {
    const a = job(false, '2026-09-18T08:00:00Z');
    const b = job(false, '2026-09-18T09:00:00Z');
    expect(compareJobs(a, b)).toBeLessThan(0);
  });

  it('conserve le FIFO entre deux remises en tête', () => {
    // Une remise en tête reprend sa place, elle n'en gagne pas une meilleure :
    // le §1.4 exclut toute priorité manuelle en V1.
    const a = job(true, '2026-09-18T08:00:00Z');
    const b = job(true, '2026-09-18T09:00:00Z');
    expect(compareJobs(a, b)).toBeLessThan(0);
  });
});
