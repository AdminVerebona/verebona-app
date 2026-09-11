/**
 * Les nombres affichés sont ceux qui s'appliquent.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE PAGE D'OFFRES QUI ANNONCE PLUS QUE LA RÉALITÉ
 *
 * Les listes de fonctionnalités étaient écrites à la main, sans lien avec
 * `plan_limits`. Trois formulations coexistaient — application, vitrine, et
 * une troisième sur l'écran de fin d'essai — dont aucune ne correspondait
 * exactement aux limites appliquées.
 *
 * Le risque n'est pas cosmétique : un utilisateur qui lit « jusqu'à 50
 * documents » et se voit bloqué à 30 a été trompé au moment où il payait.
 *
 * Ce test lit les limites dans la migration qui les pose, et vérifie que la
 * page affiche les mêmes.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const PAGE = readFileSync(
  join(process.cwd(), 'src/app/(dashboard)/mon-compte/offres/page.tsx'),
  'utf-8',
);

/** Limites posées par `0072_pricing_v2_trial.sql` — la source qui fait foi. */
function limitesEnBase(): Record<string, { biens: number; documents: number; utilisateurs: number }> {
  const sql = readFileSync(
    join(process.cwd(), 'src/db/migrations/0072_pricing_v2_trial.sql'),
    'utf-8',
  );
  const limites: Record<string, { biens: number; documents: number; utilisateurs: number }> = {};
  const motif = /UPDATE plan_limits SET max_assets = (\d+),\s+max_documents = (\d+),\s+max_users = (\d+) WHERE plan_code = '(\w+)'/g;
  for (const m of sql.matchAll(motif)) {
    limites[m[4]] = { biens: +m[1], documents: +m[2], utilisateurs: +m[3] };
  }
  return limites;
}

describe('la page annonce les limites réellement appliquées', () => {
  const limites = limitesEnBase();

  it('la migration a bien été lue', () => {
    // Sans cette garde, une migration renommée viderait le test de son sens
    // sans le faire échouer.
    expect(Object.keys(limites).sort()).toEqual(['premium', 'premium_duo', 'standard']);
  });

  for (const [code, attendu] of Object.entries(limitesEnBase())) {
    it(`${code} : les trois nombres correspondent`, () => {
      expect(PAGE, `biens de ${code}`).toContain(`Jusqu'à ${attendu.biens} biens`);
      expect(PAGE, `documents de ${code}`).toContain(`Jusqu'à ${attendu.documents} documents`);
      const u = attendu.utilisateurs > 1 ? 'utilisateurs' : 'utilisateur';
      expect(PAGE, `utilisateurs de ${code}`).toContain(`${attendu.utilisateurs} ${u}`);
    });
  }
});

describe('les anciennes formulations ont disparu', () => {
  it('plus de quota d’analyse présenté comme une limite de stockage', () => {
    // « 50 documents analysés par an » et « jusqu'à 50 documents » ne
    // désignent pas la même chose : l'un est un quota d'analyse IA, l'autre
    // une capacité. Les confondre trompe sur ce qu'on achète.
    expect(PAGE).not.toContain('documents analysés par an');
    expect(PAGE).not.toContain('documents analysés pendant essai');
  });

  it('plus de « biens actifs »', () => {
    // Aucune notion d'activité n'existe côté métier : un bien compte, ou non.
    expect(PAGE).not.toContain('biens actifs');
  });
});
