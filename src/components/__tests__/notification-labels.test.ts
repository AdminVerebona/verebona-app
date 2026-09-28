/**
 * Libellés de notification — CDC 3 §11.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * « NOUVELLE NOTIFICATION » N'APPREND RIEN
 *
 * Neuf types étaient émis sans libellé et tombaient tous sur ce repli.
 * L'utilisateur voyait une pastille, ouvrait, et devait chercher ailleurs ce
 * qui venait de se produire.
 *
 * Ce sont les plus sensibles : rétractation reçue, remboursement demandé,
 * suppression de compte programmée.
 *
 * Ce test compare les types RÉELLEMENT ÉMIS par les services à ceux que
 * l'interface sait nommer. Un nouveau type non libellé le fera échouer avant
 * qu'un utilisateur ne le rencontre.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const CLOCHE = readFileSync(
  join(process.cwd(), 'src/components/NotificationBell.tsx'),
  'utf-8',
);

/** Types que l'interface sait nommer. */
const LIBELLES = new Set(
  [...CLOCHE.matchAll(/case '([A-Z_]+)':/g)].map((m) => m[1]),
);

/** Parcourt les services à la recherche des types émis. */
function typesEmis(): Set<string> {
  const trouves = new Set<string>();
  const parcourir = (dossier: string) => {
    for (const entree of readdirSync(dossier)) {
      const chemin = join(dossier, entree);
      if (statSync(chemin).isDirectory()) {
        if (entree !== '__tests__' && entree !== 'node_modules') parcourir(chemin);
        continue;
      }
      if (!entree.endsWith('.ts')) continue;
      const source = readFileSync(chemin, 'utf-8');
      for (const m of source.matchAll(/eventType:\s*'([A-Z][A-Z0-9_]+)'/g)) {
        trouves.add(m[1]);
      }
    }
  };
  parcourir(join(process.cwd(), 'src/services'));
  return trouves;
}

describe('tout type émis a son libellé', () => {
  it('aucun type ne tombe sur le repli', () => {
    const manquants = [...typesEmis()].filter((t) => !LIBELLES.has(t)).sort();
    expect(manquants, `types sans libellé : ${manquants.join(', ')}`).toEqual([]);
  });
});

describe('les libellés disent ce qui s’est passé', () => {
  it('le statut de remboursement est traduit', () => {
    // « succeeded » ne veut rien dire pour un utilisateur.
    expect(CLOCHE).toMatch(/succeeded: 'effectué'/);
    expect(CLOCHE).toMatch(/failed: 'refusé par votre banque'/);
  });

  it('un montant est formaté en euros', () => {
    // Les montants sont en centimes en base.
    expect(CLOCHE).toMatch(/style: 'currency', currency: 'EUR'/);
    expect(CLOCHE).toMatch(/n \/ 100/);
  });

  it('un échec de résiliation ne dramatise pas', () => {
    // L'utilisateur n'a rien à faire : l'équipe agit.
    expect(CLOCHE).toMatch(/notre équipe s.en charge/);
  });

  it('le repli signale le défaut hors production', () => {
    // Un type sans libellé est une anomalie, pas un cas normal.
    expect(CLOCHE).toMatch(/type sans libellé/);
  });
});
