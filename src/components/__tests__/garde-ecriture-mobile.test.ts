/**
 * Garde d'écriture — points KO de la recette mobile.
 *
 * Lecture des sources, comme les autres tests de garde du projet : ce qui
 * est vérifié, c'est que chaque entrée passe par la garde.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

describe('les droits ne sont pas lus une seule fois', () => {
  const HOOK = read('src/hooks/useEntitlements.ts');
  it('relit les droits au changement de page et au retour sur l’app', () => {
    expect(HOOK).toMatch(/usePathname\(\)/);
    expect(HOOK).toMatch(/visibilitychange/);
    expect(HOOK).toMatch(/ENTITLEMENTS_REFRESH_EVENT/);
  });
});

describe('tout refus serveur ouvre la fenêtre', () => {
  it('api-client signale les 403 de droits', () => {
    expect(read('src/lib/api-client.ts')).toMatch(/parseWriteBlocked\(errorBody\)/);
  });
  it('le fournisseur écoute l’événement', () => {
    expect(read('src/contexts/WriteGuardContext.tsx')).toMatch(/WRITE_BLOCKED_EVENT/);
  });
});

describe('les entrées KO sont gardées', () => {
  it('le tiroir de création d’agenda se garde lui-même', () => {
    const src = read('src/components/agenda/CreateAgendaItemDrawer.tsx');
    expect(src).toMatch(/useWriteGuard\(\)/);
    expect(src).toMatch(/open && !bloque/);
  });

  it('l’onglet agenda d’un bien garde son bouton', () => {
    expect(read('src/components/assets/AssetAgendaTab.tsx')).toMatch(/onClick=\{ouvrirCreation\}/);
  });

  it('l’assistant garde l’envoi et l’ouverture par événement', () => {
    const src = read('src/components/verebona/VerebonaDrawer.tsx');
    expect(src).toMatch(/onSend=\{envoyer\}/);
    expect(src).not.toMatch(/onSend=\{v\.send\}/);
    expect(src).not.toMatch(/onPick=\{\(label\) => v\.send/);
  });

  it('le tiroir document ne reste jamais en édition sans droit', () => {
    expect(read('src/components/assets/DocumentDrawer.tsx')).toMatch(/if \(!isEditing \|\| !estBloque\(\)\) return;/);
  });

  it('le dialogue d’ajout de document se garde à l’ouverture', () => {
    expect(read('src/components/documents/unified-document-dialog.tsx')).toMatch(/estBloque\('documents'\)/);
  });
});

describe('les routes d’écriture refusent un essai terminé', () => {
  it.each([
    'src/app/api/agenda/route.ts',
    'src/app/api/agenda/[id]/route.ts',
    'src/app/api/files/confirm/route.ts',
  ])('%s', (fichier) => {
    expect(read(fichier)).toMatch(/refuserSiLectureSeule\(/);
  });

  it('l’assistant refuse un essai terminé', () => {
    expect(read('src/app/api/verebona/messages/route.ts')).toMatch(/refuserSiPasDIA\(/);
  });
});

describe('dépôt multiple', () => {
  const DIALOGUE = read('src/components/documents/unified-document-dialog.tsx');
  const CONFIRM = read('src/app/api/files/confirm/route.ts');

  it('le client confirme chaque fichier séparément, en séquence', () => {
    expect(DIALOGUE).toMatch(/for \(let i = 0; i < total; i\+\+\)/);
    expect(DIALOGUE).not.toMatch(/Promise\.all\(files\.map/);
  });

  it('le serveur confirme tous les fichiers reçus et passe par la file', () => {
    expect(CONFIRM).toMatch(/inArray\(assetFiles\.id, idsDemandes\)/);
    expect(CONFIRM).toMatch(/enqueueFileAnalyses/);
  });
});
