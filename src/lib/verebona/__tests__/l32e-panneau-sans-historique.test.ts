/**
 * Lot 32, point 11 — le bouton historique (icône horloge) est retiré du
 * panneau Verebona, desktop ET mobile, avec son code mort (vue « Toutes les
 * demandes », effacement global, état `historyOpen`). La reprise et la
 * suppression d'un fil restent possibles par les « Recherches récentes ».
 *
 *  · AC11.1 : aucun bouton historique (desktop, mobile) ;
 *  · AC11.2 : code mort retiré (vue, état, helpers) ;
 *  · AC11.3 : l'historique des conversations reste utilisable (récents, reprise, suppression).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '../../../..');
const lire = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const FIELD = lire('src/components/verebona/space/VerebonaField.tsx');
const CONTENT = lire('src/components/verebona/space/SpaceContent.tsx');
const PROVIDER = lire('src/components/verebona/space/VerebonaSpaceProvider.tsx');
const SPACE = lire('src/lib/verebona/space.ts');
const HOOK = lire('src/lib/verebona/useVerebona.ts');

describe('AC11.1 — plus de bouton historique dans le panneau', () => {
  it('desktop et mobile : ni icône History, ni « Toutes les demandes »', () => {
    expect(FIELD).not.toMatch(/\bHistory\b/);
    expect(FIELD).not.toMatch(/HistoryButton/);
    expect(FIELD).not.toMatch(/Toutes les demandes/);
    // Les deux en-têtes gardent « Nouvelle demande » et « Fermer ».
    expect(FIELD.match(/Nouvelle demande/g)?.length).toBeGreaterThanOrEqual(2);
    expect(FIELD.match(/aria-label="Fermer"/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

describe('AC11.2 — code mort retiré', () => {
  it('vue « Toutes les demandes », effacement global et état associé supprimés', () => {
    for (const t of [FIELD, CONTENT, PROVIDER]) {
      expect(t).not.toMatch(/historyOpen|setHistoryOpen|allPrevious|HistoryView|ClearHistory/);
    }
    expect(SPACE).not.toMatch(/export function previousRequests|PreviousRequestRow|MAX_PREVIOUS_REQUESTS/);
    expect(HOOK).not.toMatch(/\bclearAll\b/);
  });
});

describe('AC11.3 — l’historique des conversations reste utilisable', () => {
  it('recherches récentes : reprise et suppression d’un fil', () => {
    expect(CONTENT).toMatch(/Recherches récentes/);
    expect(CONTENT).toMatch(/onResume=\{\(\) => api\.resume\(r\.id\)\}/);
    expect(CONTENT).toMatch(/onDelete=\{\(\) => api\.removeRecent\(r\.id\)\}/);
    expect(PROVIDER).toMatch(/void v\.deleteThread\(id\)/);
    expect(PROVIDER).toMatch(/v\.selectConversation\(id\)/);
    expect(SPACE).toMatch(/export function recentSearches/);
  });
});
