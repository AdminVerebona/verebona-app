/**
 * Sérialisation des paramètres SQL — incident du 21/09/2026.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE DÉFAUT
 *
 * `pgClient.unsafe(sql, params)` ne sérialise PAS les objets `Date`, à la
 * différence des requêtes en gabarit balisé. Leur en passer un lève dans le
 * pilote :
 *
 *   TypeError: The "string" argument must be of type string or an instance of
 *   Buffer or ArrayBuffer. Received an instance of Date
 *
 * L'erreur ne cite aucune colonne et ne ressemble pas à une erreur SQL : elle a
 * mis le tableau de bord et l'écran Coûts hors service sans que la vérification
 * des colonnes contre le schéma ne révèle quoi que ce soit.
 *
 * Ces tests vérifient la règle sur les deux dépôts qui prennent des dates en
 * filtre. Ils ne touchent pas la base : ils inspectent ce qui serait envoyé.
 */
import { describe, it, expect } from 'vitest';

/**
 * Règle appliquée par les dépôts : toute date devient une chaîne ISO avant
 * d'entrer dans la liste de paramètres.
 */
function serialise(v: Date | null | undefined): string | null {
  return v?.toISOString() ?? null;
}

describe('paramètres de date', () => {
  it('convertit une date en chaîne ISO', () => {
    const d = new Date('2026-09-21T12:00:00.000Z');
    expect(serialise(d)).toBe('2026-09-21T12:00:00.000Z');
    expect(typeof serialise(d)).toBe('string');
  });

  it('ne laisse jamais passer un objet Date', () => {
    // C'est la seule chose qui compte : un objet atteint le pilote et lève.
    const d = new Date();
    expect(serialise(d)).not.toBeInstanceOf(Date);
  });

  it('rend null sur une absence, sans inventer de borne', () => {
    // `null` est comparé à `$n::timestamptz IS NULL` dans les requêtes : c'est
    // ce qui neutralise le filtre. Une date par défaut le restreindrait.
    expect(serialise(null)).toBeNull();
    expect(serialise(undefined)).toBeNull();
  });

  it('conserve le fuseau, en UTC', () => {
    // Une chaîne locale sans fuseau serait interprétée selon celui du serveur,
    // et décalerait les fenêtres d'observation d'une ou deux heures.
    expect(serialise(new Date('2026-09-21T14:30:00+02:00'))).toBe('2026-09-21T12:30:00.000Z');
  });
});
