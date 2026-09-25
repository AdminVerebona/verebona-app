import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('instructions Apple Agenda à jour', () => {
  const src = readFileSync(join(process.cwd(), 'src/app/(dashboard)/mon-compte/informations/InformationsTab.tsx'), 'utf8');
  const bloc = src.slice(src.indexOf('🍎 Apple Agenda (iPhone / Mac)'), src.indexOf('📅 Google Agenda'));
  expect(bloc).toContain('Copiez le lien ci-dessus');
  expect(bloc).toContain('<strong>Calendriers</strong> → <strong>Nouveau calendrier</strong> → <strong>Ajouter un calendrier avec abonnement</strong>');
  expect(bloc).toContain('Collez le lien et cliquez sur <strong>Rechercher</strong>');
  expect(bloc).toContain('Choisissez le nom que vous voulez donner à votre calendrier');
  expect(bloc).not.toContain('Nouvel abonnement à un calendrier');
  expect(bloc).not.toContain('fréquence de mise à jour');
});
