/**
 * Lot 35 — L35-A : correctif d'une erreur de copie dans la base du 10/10.
 *
 * `additional-infos/route.ts` (route utilisée par l'application) avait
 * retrouvé son ancienne version, sans le contrôle « Préparation des
 * dossiers » (`canCreateDossiers`, lot 34) ; la version complète se trouvait
 * dans l'alias singulier. On rétablit : implémentation complète dans
 * `additional-infos`, alias d'une ligne dans `additional-info`.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const lire = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');
const PLURIEL = 'src/app/api/assets/[id]/additional-infos/route.ts';
const SINGULIER = 'src/app/api/assets/[id]/additional-info/route.ts';

describe('L35-A — additional-infos : version lot 34 rétablie', () => {
  it('L35-A — la route utilisée par l’application porte le contrôle canCreateDossiers avant toute écriture', () => {
    const src = lire(PLURIEL);
    expect(src).toContain("import { canCreateDossiers } from '@/services/entitlements.service';");
    const patch = src.slice(src.indexOf('export async function PATCH'));
    const iDroit = patch.indexOf('await canCreateDossiers(accountId)');
    const iEcriture = patch.indexOf('updateAssetAdditionalInfos(');
    expect(iDroit).toBeGreaterThan(-1);
    expect(iEcriture).toBeGreaterThan(iDroit);
  });

  it('L35-A — l’alias singulier ré-exporte la route plurielle, sans implémentation propre', () => {
    const code = lire(SINGULIER).replace(/\/\*[\s\S]*?\*\//g, '').trim();
    expect(code).toBe("export { GET, PATCH } from '../additional-infos/route';");
    expect(lire(SINGULIER)).toContain('Alias singulier');
  });
});
