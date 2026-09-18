/**
 * CDC BO IA SNP-005 à SNP-009 — neutralisation d'un snapshot.
 *
 * ⚠️ Ce plan applique des opérations destructrices sur des données réelles. Ces
 * tests ne vérifient pas qu'il « marche » : ils vérifient qu'il ne peut pas
 * s'exécuter au mauvais endroit, et qu'il ne laisse derrière lui aucune des
 * trois familles de risque que le CDC énumère.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  NEUTRALIZATION_PLAN, stepsByFamily, affectedTables, testAccountEmails,
  NEUTRAL_EMAIL_DOMAIN,
} from '../neutralization-plan';
import { assertNeutralizationAllowed, NeutralizationRefused } from '../neutralization.service';

const initial = { ...process.env };
afterEach(() => { process.env = { ...initial }; });

function environnement(env: string, armed = true) {
  process.env.NEXT_PUBLIC_APP_ENV = env;
  if (armed) process.env.ALLOW_SNAPSHOT_NEUTRALIZATION = 'true';
  else delete process.env.ALLOW_SNAPSHOT_NEUTRALIZATION;
}

describe('gardes — la seule chose qui compte vraiment', () => {
  it('refuse la production, armée ou non', () => {
    // Exécuté en production, ce plan détruirait les mots de passe, les adresses
    // et les rattachements de paiement réels.
    environnement('production');
    expect(() => assertNeutralizationAllowed('production')).toThrow(NeutralizationRefused);

    environnement('prod');
    expect(() => assertNeutralizationAllowed('production')).toThrow(/production/i);
  });

  it("refuse sans armement explicite", () => {
    // Deux conditions indépendantes demandent deux erreurs simultanées.
    environnement('preprod', false);
    expect(() => assertNeutralizationAllowed('preprod')).toThrow(/ALLOW_SNAPSHOT_NEUTRALIZATION/);
  });

  it("refuse si l'appelant se trompe d'environnement", () => {
    // La confirmation dactylographiée des opérations dangereuses, côté serveur.
    environnement('preprod');
    expect(() => assertNeutralizationAllowed('production')).toThrow(/Confirmation attendue/);
    expect(() => assertNeutralizationAllowed('')).toThrow(NeutralizationRefused);
  });

  it("n'autorise que preprod et local, correctement confirmés", () => {
    environnement('preprod');
    expect(() => assertNeutralizationAllowed('preprod')).not.toThrow();

    environnement('local');
    expect(() => assertNeutralizationAllowed('local')).not.toThrow();
  });
});

describe('couverture des trois familles de risque', () => {
  it('traite la connexion, les effets externes et les secrets', () => {
    for (const f of ['connexion', 'effets_externes', 'secrets'] as const) {
      expect(stepsByFamily(f).length, f).toBeGreaterThan(0);
    }
  });

  it('neutralise mots de passe ET adresses', () => {
    // L'un sans l'autre ne suffit pas : une adresse réelle conservée permet une
    // réinitialisation de mot de passe, donc un accès.
    const ids = NEUTRALIZATION_PLAN.map((s) => s.id);
    expect(ids).toContain('passwords');
    expect(ids).toContain('emails');
  });

  it('supprime ce qui donne un accès sans mot de passe', () => {
    const ids = NEUTRALIZATION_PLAN.map((s) => s.id);
    expect(ids).toContain('sessions');
    expect(ids).toContain('verification_tokens');
  });

  it('coupe tout ce qui peut sortir de l’environnement (SNP-006)', () => {
    const ids = NEUTRALIZATION_PLAN.map((s) => s.id);
    expect(ids).toContain('notification_outbox');
    expect(ids).toContain('push_subscriptions');
  });

  it('détache les paiements réels et supprime les credentials (SNP-007)', () => {
    const ids = NEUTRALIZATION_PLAN.map((s) => s.id);
    expect(ids).toContain('stripe_ids');
    expect(ids).toContain('provider_credentials');
  });
});

describe('forme des opérations', () => {
  it('paramètre les adresses préservées au lieu de les interpoler', () => {
    // Une apostrophe dans une adresse suffirait autrement à casser — ou
    // détourner — une requête destructrice. Toute opération qui épargne les
    // comptes de test doit donc passer par $1, jamais par une liste construite.
    const epargnantes = NEUTRALIZATION_PLAN.filter((s) => s.sql.includes('<> ALL'));
    expect(epargnantes.length).toBeGreaterThan(0);
    for (const s of epargnantes) {
      expect(s.sql, s.id).toContain('$1::text[]');
    }
  });

  it('réécrit les adresses vers un domaine qui ne sera jamais délégué', () => {
    // Si une adresse fuitait malgré tout dans un envoi, aucun courriel
    // n'atteindrait de vraie boîte.
    expect(NEUTRAL_EMAIL_DOMAIN).toMatch(/\.invalid$/);
  });

  it('conserve l’identifiant métier dans l’adresse réécrite (SNP-004)', () => {
    const emails = NEUTRALIZATION_PLAN.find((s) => s.id === 'emails')!;
    expect(emails.sql).toContain('|| id ||');
  });

  it("n'écrase pas les empreintes par une valeur exploitable", () => {
    // Écraser par une empreinte connue ouvrirait une porte à tout le monde.
    const pwd = NEUTRALIZATION_PLAN.find((s) => s.id === 'passwords')!;
    expect(pwd.sql).toContain('$neutralized$');
    expect(pwd.sql).not.toMatch(/\$2[aby]\$/);
  });

  it('énonce pour chaque opération ce qui arriverait sans elle', () => {
    // La justification n'est pas décorative : c'est elle qui permet de relire ce
    // plan sans avoir à redécouvrir pourquoi chaque ligne existe.
    for (const s of NEUTRALIZATION_PLAN) {
      expect(s.risk.length, s.id).toBeGreaterThan(40);
      expect(s.tables.length, s.id).toBeGreaterThan(0);
    }
  });

  it('expose son périmètre pour la revue', () => {
    expect(affectedTables()).toContain('users');
    expect(affectedTables()).toContain('accounts');
  });
});

describe('comptes de test (SNP-009)', () => {
  it('sont lus dans l’environnement, pas figés dans le code', () => {
    process.env.PREPROD_TEST_ACCOUNTS = ' Recette@Verebona.fr , qa@verebona.fr ';
    expect(testAccountEmails()).toEqual(['recette@verebona.fr', 'qa@verebona.fr']);
  });

  it('valent liste vide en leur absence', () => {
    delete process.env.PREPROD_TEST_ACCOUNTS;
    expect(testAccountEmails()).toEqual([]);
  });
});
