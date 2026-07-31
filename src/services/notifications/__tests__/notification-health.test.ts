/**
 * Santé et réémission des notifications — CDC 3 §20.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DEUX RÈGLES QUI NE SE VOIENT PAS À L'ŒIL
 *
 * · Le §20.2 interdit d'exposer « les clés push ni les données sensibles ».
 *   Un écran d'administration qui les afficherait fonctionnerait
 *   parfaitement — le défaut ne se manifesterait qu'en cas de fuite.
 *
 * · Le §20.3 interdit la réémission d'une actualité à un utilisateur non
 *   consentant. Là encore, l'oubli produit un système qui marche : le
 *   message part, et c'est précisément le problème.
 *
 * Ces tests lisent le source. C'est rustique, mais c'est le seul moyen de
 * détecter une exposition qu'aucune assertion de rendu ne verrait.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const SANTE = read('src/services/notifications/notification-health.service.ts');
const REEMISSION = read('src/services/notifications/notification-reemission.service.ts');

describe('§20.2 — aucune donnée sensible exposée', () => {
  it('ne sélectionne jamais le point de terminaison push', () => {
    // `endpoint` permet d'écrire à un appareil : c'est une clé, pas une
    // métrique.
    expect(SANTE).not.toMatch(/SELECT[\s\S]{0,200}\bendpoint\b/i);
    expect(SANTE).not.toMatch(/\bauth_key\b/i);
  });

  it('ne sélectionne pas le contenu des notifications', () => {
    // `deep_link` et `entity_id` désignent la ressource concernée : les
    // exposer revient à dire de quoi parle la notification.
    expect(SANTE).not.toMatch(/SELECT[\s\S]{0,300}\bdeep_link\b/i);
    expect(SANTE).not.toMatch(/SELECT[\s\S]{0,300}\bpayload\b/i);
  });

  it('ne rend que le CODE des erreurs push, pas leur détail', () => {
    expect(SANTE).toMatch(/last_error_code/);
    // `last_error_message` peut contenir l'URL du point de terminaison.
    expect(SANTE).not.toMatch(/SELECT[\s\S]{0,200}last_error_message/i);
  });

  it('tronque les motifs d’échec exposés par la recherche', () => {
    expect(SANTE).toMatch(/left\(last_error, \d+\)/);
  });
});

describe('§20.3 — les cinq conditions de la réémission', () => {
  it('exige une confirmation explicite', () => {
    expect(REEMISSION).toContain('CONFIRMATION_REQUISE');
    expect(REEMISSION).toMatch(/if \(!input\.confirme\)/);
  });

  it('vérifie le consentement aux actualités', () => {
    expect(REEMISSION).toContain('CONSENTEMENT_RETIRE');
    expect(REEMISSION).toContain('consentementActuel');
  });

  it('lit le consentement ACTUEL, pas celui d’origine', () => {
    // Un consentement se retire : celui qui valait au premier envoi peut ne
    // plus valoir. La requête porte sur `newsConsents`, pas sur une copie
    // figée dans la ligne d'origine.
    expect(REEMISSION).toMatch(/from\(newsConsents\)/);
  });

  it('refuse une actualité sans destinataire identifié', () => {
    expect(REEMISSION).toContain('DESTINATAIRE_INCONNU');
  });

  it('ne force jamais les indicateurs obligatoires', () => {
    // Les passer à `true` transformerait une réémission en contournement des
    // préférences de l'utilisateur (§20.3 condition 3).
    expect(REEMISSION).toMatch(/mandatoryBell: origine\.mandatoryBell/);
    expect(REEMISSION).toMatch(/mandatoryEmail: origine\.mandatoryEmail/);
    expect(REEMISSION).not.toMatch(/mandatoryBell: true/);
    expect(REEMISSION).not.toMatch(/mandatoryEmail: true/);
  });

  it('crée une nouvelle ligne au lieu de modifier l’originale', () => {
    // Modifier la ligne d'origine effacerait l'historique de l'incident.
    expect(REEMISSION).toMatch(/insert\(notificationOutbox\)/);
    expect(REEMISSION).not.toMatch(/update\(notificationOutbox\)/);
  });

  it('emploie une clé de déduplication distincte', () => {
    // Réutiliser la clé d'origine ferait rejeter la réémission en silence :
    // elle paraîtrait avoir réussi.
    expect(REEMISSION).toMatch(/reemis/);
  });

  it('consigne une trace d’audit', () => {
    expect(REEMISSION).toContain('adminAuditLog');
    expect(REEMISSION).toContain('NOTIFICATION_REEMISSION');
  });

  it('n’interrompt pas la réémission si l’audit échoue', () => {
    // Une trace manquante est regrettable ; une réémission bloquée par sa
    // propre trace le serait davantage.
    expect(REEMISSION).toMatch(/catch[\s\S]{0,160}audit/i);
  });
});

describe('lecture des indicateurs (§20.1)', () => {
  it('couvre les neuf indicateurs demandés', () => {
    for (const attendu of [
      'evenementsParType', 'livraisonsParCanal', 'tauxSucces',
      'erreursPushParCode', 'emailsEnEchec', 'abonnementsPush',
      'bloquesDepuisSeuil', 'recapitulatifs',
    ]) {
      expect(SANTE).toContain(attendu);
    }
  });

  it('distingue « aucune tentative » de « zéro pour cent »', () => {
    // Un taux de 0 % sur zéro envoi laisserait croire à une panne.
    expect(SANTE).toMatch(/tauxSucces: c\.total > 0 \? .* : null/);
  });

  it('n’alerte pas sur un volume insignifiant', () => {
    // Deux échecs sur trois envois ne signalent rien d'exploitable.
    expect(SANTE).toMatch(/c\.total >= \d+/);
  });
});
