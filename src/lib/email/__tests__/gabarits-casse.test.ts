/**
 * Recherche de gabarit d'email — insensible à la casse.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * QUINZE GABARITS ÉTAIENT INTROUVABLES PAR CONSTRUCTION
 *
 * `emailService.send()` cherchait `options.templateCode.toUpperCase()`. La
 * migration 0077 a enregistré quinze gabarits EN MINUSCULES — `notif_quota`,
 * `notif_security`, `notif_document_batch_failed`… Aucun ne pouvait être
 * trouvé.
 *
 * Le journal d'envois le répétait depuis le 2 août :
 *
 *   « Template notif_document_batch_failed not found »
 *
 * alors que ce gabarit figure bien en base. Toutes les notifications par
 * email échouaient — échéances, quotas, incidents de paiement, invitations,
 * parrainage.
 *
 * Rien ne le signalait ailleurs : l'envoi échoue en silence, par conception,
 * pour ne pas faire échouer l'action qui l'a déclenché.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const SERVICE = readFileSync(
  join(process.cwd(), 'src/lib/email/email-service.ts'),
  'utf-8',
);

describe('la casse n’empêche plus de trouver un gabarit', () => {
  it('la comparaison est insensible à la casse', () => {
    expect(SERVICE).toMatch(/upper\(\$\{emailTemplates\.type\}\) = upper\(/);
  });

  it('le code appelant n’est plus forcé en majuscules', () => {
    // Forcer une convention casserait l'autre : le projet emploie les deux.
    expect(SERVICE).not.toMatch(/templateCode\.toUpperCase\(\)/);
  });
});

describe('tout code appelé correspond à un gabarit amorcé', () => {
  /** Codes de gabarit demandés par le code applicatif. */
  function codesAppeles(): Set<string> {
    const trouves = new Set<string>();
    const parcourir = (dossier: string) => {
      for (const entree of readdirSync(dossier)) {
        const chemin = join(dossier, entree);
        if (statSync(chemin).isDirectory()) {
          if (entree !== '__tests__' && entree !== 'node_modules') parcourir(chemin);
          continue;
        }
        if (!/\.tsx?$/.test(entree)) continue;
        const source = readFileSync(chemin, 'utf-8');
        for (const m of source.matchAll(/templateCode:\s*['"]([A-Za-z][A-Za-z0-9_]+)['"]/g)) {
          trouves.add(m[1]);
        }
      }
    };
    parcourir(join(process.cwd(), 'src'));
    return trouves;
  }

  /** Codes réellement posés par les migrations et les amorçages. */
  function codesAmorces(): Set<string> {
    const trouves = new Set<string>();
    const sources = [
      join(process.cwd(), 'src/db/migrations'),
      join(process.cwd(), 'src/db/seeds'),
    ];
    const parcourir = (dossier: string) => {
      for (const entree of readdirSync(dossier)) {
        const chemin = join(dossier, entree);
        if (statSync(chemin).isDirectory()) { parcourir(chemin); continue; }
        if (!/\.(sql|ts)$/.test(entree)) continue;
        const source = readFileSync(chemin, 'utf-8');
        // Trois écritures coexistent dans le projet :
        //   ('CODE', 'Sujet'   en SQL
        //   type: 'CODE'       dans un objet TypeScript
        //   const TYPE = 'CODE'  dans un seed dédié
        //   code: 'CODE'       dans un autre seed encore
        // Ne reconnaître que les deux premières faisait passer pour manquants
        // des gabarits pourtant amorcés.
        for (const m of source.matchAll(/\(\s*'([A-Za-z][A-Za-z0-9_]+)',\s*'/g)) trouves.add(m[1]);
        for (const m of source.matchAll(/(?:type|code):\s*'([A-Za-z][A-Za-z0-9_]+)'/g)) trouves.add(m[1]);
        for (const m of source.matchAll(/=\s*'([A-Z][A-Z0-9_]{4,})'/g)) trouves.add(m[1]);
      }
    };
    for (const d of sources) parcourir(d);
    return trouves;
  }

  it('aucun code appelé n’est absent des amorçages', () => {
    // Comparaison insensible à la casse : c'est désormais le comportement du
    // service, le test doit l'être aussi.
    const amorces = new Set([...codesAmorces()].map((c) => c.toUpperCase()));
    const manquants = [...codesAppeles()]
      .filter((c) => !amorces.has(c.toUpperCase()))
      .sort();

    expect(manquants, `gabarits appelés mais jamais amorcés :\n  ${manquants.join('\n  ')}`)
      .toEqual([]);
  });
});
