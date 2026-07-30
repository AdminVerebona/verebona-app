/**
 * Cibles des liens de pied de page.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * SIX LIENS RENVOYAIENT 404 EN PRÉPRODUCTION
 *
 * Les pieds de page sont affichés par l'APPLICATION, mais la plupart de leurs
 * liens désignent des pages de la VITRINE. Écrits en relatif, ils pointaient
 * vers app.verebona.fr, où aucune n'existe.
 *
 * Next préchargeant les liens au survol, les 404 apparaissaient dans la
 * console avant même qu'on ne clique — sans que personne ne les relie aux
 * pieds de page.
 *
 * Ces tests figent la répartition : ce qui traverse vers la vitrine, et ce
 * que l'application sert réellement.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const FOOTER = readFileSync(join(process.cwd(), 'src/components/Footer.tsx'), 'utf-8');
const LANDING = readFileSync(join(process.cwd(), 'src/components/LandingFooter.tsx'), 'utf-8');

/** Chemins que l'application sert vraiment. */
const SERVIS_PAR_LAPP = ['/cgvu', '/retractation'];

/** Chemins qui n'existent que sur la vitrine. */
const PAGES_VITRINE = [
  '/mentions-legales', '/confidentialite', '/contact', '/aide',
  '/pourquoi-verebona', '/comment-ca-marche',
];

describe('les pages servies par l’application existent', () => {
  it('chaque chemin interne correspond à une route', () => {
    for (const chemin of SERVIS_PAR_LAPP) {
      const dossier = join(process.cwd(), 'src/app', chemin.slice(1));
      expect({ chemin, existe: existsSync(dossier) }).toEqual({ chemin, existe: true });
    }
  });
});

describe('les pages de la vitrine ne sont pas liées en relatif', () => {
  it('aucun lien relatif vers une page inexistante', () => {
    for (const source of [FOOTER, LANDING]) {
      for (const page of PAGES_VITRINE) {
        // Un `href="/aide"` en dur produirait un 404 : ces pages doivent
        // passer par publicSiteUrl().
        expect(source).not.toMatch(new RegExp(`href="${page}"`));
      }
    }
  });

  it('les deux pieds de page emploient publicSiteUrl', () => {
    expect(FOOTER).toContain('publicSiteUrl');
    expect(LANDING).toContain('publicSiteUrl');
  });

  it('les liens externes sont marqués comme tels', () => {
    // Le marquage est ce qui rend la répartition lisible : sans lui, on ne
    // sait plus quel lien traverse et lequel reste.
    for (const source of [FOOTER, LANDING]) {
      expect(source).toContain('external: true');
      expect(source).toContain('resolveHref');
    }
  });
});

describe('les liens imposés par les CDC restent internes', () => {
  it('CGVU est servi par l’application (CDC 7 §12)', () => {
    // Le §12 exige que les conditions restent accessibles après fermeture du
    // compte : les renvoyer vers la vitrine romprait le permalien.
    for (const source of [FOOTER, LANDING]) {
      expect(source).toMatch(/\{ href: '\/cgvu',\s+label: 'CGVU' \}/);
    }
  });

  it('« Renoncer au contrat ici » est servi par l’application (CDC 6 §6.1)', () => {
    for (const source of [FOOTER, LANDING]) {
      expect(source).toContain("Renoncer au contrat ici");
      expect(source).toMatch(/href: '\/retractation'/);
    }
  });

  it('ni CGVU ni rétractation ne sont marqués externes', () => {
    for (const source of [FOOTER, LANDING]) {
      expect(source).not.toMatch(/href: '\/cgvu'[^}]*external/);
      expect(source).not.toMatch(/href: '\/retractation'[^}]*external/);
    }
  });
});
