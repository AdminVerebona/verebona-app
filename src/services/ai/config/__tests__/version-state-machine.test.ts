/**
 * CDC BO IA §4.1, §7 — cycle de vie d'une version de configuration.
 *
 * Ces tests portent sur les invariants qui décident quelle configuration
 * s'exécute. Une transition qui dériverait en silence ne se découvrirait qu'en
 * constatant qu'une version archivée tourne encore.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  transition, canTransition, allowedEvents, isExecutable, isRollbackEligible,
  InvalidConfigTransition, getTransitionTable,
  type ConfigVersionStatus,
} from '../version-state-machine';
import { parseEnvironment, getAiEnvironment, allowsTestVersions } from '../environment';

const TOUS: ConfigVersionStatus[] = ['DRAFT', 'TO_TEST', 'ACTIVE', 'VALIDATED', 'ARCHIVED'];

describe('les trois interdits structurels', () => {
  it("VER-002 — une Active ne s'édite pas : sa seule sortie est de céder la place", () => {
    expect(allowedEvents('ACTIVE')).toEqual(['supersede']);
  });

  it('VER-009 — une Active ne peut pas être archivée', () => {
    expect(canTransition('ACTIVE', 'archive')).toBe(false);
    expect(() => transition('ACTIVE', 'archive')).toThrow(InvalidConfigTransition);
  });

  it("VER-008 — l'archivage est définitif : aucune sortie d'ARCHIVED", () => {
    expect(allowedEvents('ARCHIVED')).toEqual([]);
    for (const e of ['activate', 'rollback', 'promote', 'validate'] as const) {
      expect(canTransition('ARCHIVED', e), e).toBe(false);
    }
  });
});

describe('le cycle nominal', () => {
  it('conduit un Brouillon jusqu’à Active', () => {
    expect(transition('DRAFT', 'promote')).toBe('TO_TEST');
    expect(transition('TO_TEST', 'validate')).toBe('ACTIVE');
    expect(transition('ACTIVE', 'supersede')).toBe('VALIDATED');
  });

  it('VER-005 — un retour en Brouillon est possible depuis « À tester »', () => {
    expect(transition('TO_TEST', 'demote')).toBe('DRAFT');
  });

  it('VER-012 — une version importée arrive au statut Validé, pas Active', () => {
    // L'import ne fait transiter aucune version existante : il en crée une.
    // Ce que la table vérifie, c'est qu'aucun état ne mène à ACTIVE par
    // « import » — l'activation reste un geste explicite.
    for (const s of TOUS) {
      expect(canTransition(s, 'import'), s).toBe(false);
    }
  });
});

describe('activer et restaurer sont deux événements distincts', () => {
  it('mènent tous deux au même état', () => {
    expect(transition('VALIDATED', 'activate')).toBe('ACTIVE');
    expect(transition('VALIDATED', 'rollback')).toBe('ACTIVE');
  });

  it('restent deux entrées séparées de la table', () => {
    // Les fusionner derrière un drapeau rendrait invisible, à la lecture, la
    // différence entre « laisser terminer les exécutions » (WF-05) et « les
    // interrompre puis remettre les jobs en tête de file » (WF-06).
    const table = getTransitionTable();
    expect(Object.keys(table.VALIDATED).sort()).toEqual(['activate', 'archive', 'rollback']);
  });

  it("ne s'appliquent qu'à une version validée", () => {
    for (const s of ['DRAFT', 'TO_TEST', 'ARCHIVED'] as const) {
      expect(canTransition(s, 'activate'), s).toBe(false);
      expect(canTransition(s, 'rollback'), s).toBe(false);
    }
  });
});

describe('quelle version s’exécute', () => {
  it('VER-004 — « À tester » est effective en préproduction, jamais en production', () => {
    expect(isExecutable('TO_TEST', 'preprod')).toBe(true);
    expect(isExecutable('TO_TEST', 'local')).toBe(true);
    expect(isExecutable('TO_TEST', 'production')).toBe(false);
  });

  it("l'Active s'exécute partout", () => {
    for (const env of ['local', 'preprod', 'production'] as const) {
      expect(isExecutable('ACTIVE', env), env).toBe(true);
    }
  });

  it('aucun autre statut ne s’exécute', () => {
    for (const s of ['DRAFT', 'VALIDATED', 'ARCHIVED'] as const) {
      for (const env of ['local', 'preprod', 'production'] as const) {
        expect(isExecutable(s, env), `${s}/${env}`).toBe(false);
      }
    }
  });
});

describe('éligibilité au rollback (VER-007)', () => {
  it("exige d'avoir été Active par le passé", () => {
    // Une version validée mais jamais activée n'est pas un retour en arrière :
    // c'est une version qu'on n'a jamais essayée.
    expect(isRollbackEligible('VALIDATED', new Date())).toBe(true);
    expect(isRollbackEligible('VALIDATED', null)).toBe(false);
  });

  it('exclut une version archivée', () => {
    expect(isRollbackEligible('ARCHIVED', new Date())).toBe(false);
  });
});

describe("résolution de l'environnement", () => {
  const initial = process.env.NEXT_PUBLIC_APP_ENV;
  afterEach(() => {
    if (initial === undefined) delete process.env.NEXT_PUBLIC_APP_ENV;
    else process.env.NEXT_PUBLIC_APP_ENV = initial;
  });

  it('accepte les synonymes déjà utilisés ailleurs dans le dépôt', () => {
    // `stripe-config` accepte déjà `prod` comme `production` : refuser ici ce
    // qu'on accepte là produirait une incohérence invisible.
    expect(parseEnvironment('prod')).toBe('production');
    expect(parseEnvironment('PRODUCTION')).toBe('production');
    expect(parseEnvironment(' preprod ')).toBe('preprod');
    expect(parseEnvironment('staging')).toBe('preprod');
    expect(parseEnvironment('local')).toBe('local');
  });

  it('refuse une valeur inconnue plutôt que de deviner', () => {
    expect(parseEnvironment('recette')).toBeNull();
    expect(parseEnvironment('')).toBeNull();
    expect(parseEnvironment(undefined)).toBeNull();
  });

  it('lit la variable existante', () => {
    process.env.NEXT_PUBLIC_APP_ENV = 'preprod';
    expect(getAiEnvironment()).toBe('preprod');
  });

  it('réserve le cycle de test aux environnements non productifs (WF-02)', () => {
    expect(allowsTestVersions('preprod')).toBe(true);
    expect(allowsTestVersions('local')).toBe(true);
    expect(allowsTestVersions('production')).toBe(false);
  });
});
