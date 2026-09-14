/**
 * Les liens d'aide mènent à la vitrine — CDC 10.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DEUX CENTRES D'AIDE, DES LIENS QUI RESTAIENT DANS L'APPLICATION
 *
 * Les cinq boutons de la modale ouvraient `/aide` en RELATIF : la page d'aide
 * de l'application, dont le contenu n'a jamais été rapproché de la FAQ
 * publique.
 *
 * Ils pointent désormais vers la vitrine, dans un nouvel onglet. La modale
 * reste le point d'entrée dans l'application ; les articles vivent ailleurs.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const MODALE = readFileSync(
  join(process.cwd(), 'src/components/help/HelpModal.tsx'),
  'utf-8',
);

describe('aucun lien d’aide ne reste dans l’application', () => {
  it('plus aucun window.open relatif vers /aide', () => {
    // Un chemin relatif ouvre la page de l'application, pas celle du site.
    expect(MODALE).not.toMatch(/window\.open\(\s*[`'"]\/aide/);
  });

  it('toutes les ouvertures passent par publicSiteUrl', () => {
    const ouvertures = MODALE.match(/window\.open\(/g) ?? [];
    const construites = MODALE.match(/publicSiteUrl\(/g) ?? [];
    expect(construites.length).toBeGreaterThanOrEqual(ouvertures.length);
  });

  it('l’adresse n’est jamais écrite en dur', () => {
    // Elle diffère par environnement : en dur, la préproduction enverrait
    // vers la production.
    expect(MODALE).not.toMatch(/https:\/\/verebona\.(fr|com)/);
  });

  it('les nouveaux onglets sont isolés', () => {
    // `noopener` empêche la page ouverte d'accéder à `window.opener`.
    //
    // On compte plutôt qu'on ne découpe : une expression bornée à la première
    // parenthèse fermante s'arrête à l'intérieur d'`encodeURIComponent` et
    // signale un faux défaut.
    const ouvertures = (MODALE.match(/window\.open\(/g) ?? []).length;
    const isolees = (MODALE.match(/noopener/g) ?? []).length;
    expect(isolees).toBe(ouvertures);
  });
});
