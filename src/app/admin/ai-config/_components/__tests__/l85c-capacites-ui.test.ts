/**
 * Lot 85C — Configuration IA (écran existant, décision PO 12) : capacités des
 * modèles et profils par opération, desktop ET mobile.
 *
 * Contrôle de source (environnement Node, sans DOM), comme `page-wiring` :
 *   L85C-UI-01  section « Capacités des modèles » branchée sur la route
 *               d'administration, cartes empilées (1 colonne en mobile,
 *               2 en desktop), Preview signalé « information seulement »,
 *               source et date de chaque information, « à requalifier »
 *   L85C-UI-02  « Profils par opération » dans l'éditeur de CHAQUE
 *               traitement (même composant desktop / mobile, grille d'une
 *               colonne sous `sm`), valeurs « héritées » explicites, profils
 *               effectifs lus du serveur (constructeur de l'exécution)
 *   L85C-UI-03  aucune saisie de température (décision 09)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const lire = (f: string) => readFileSync(join(process.cwd(), 'src/app/admin/ai-config', f), 'utf8');
const page = lire('page.tsx');
const capacites = lire('_components/ModelCapabilities.tsx');
const profils = lire('_components/OperationProfilesEditor.tsx');

describe('L85C-UI-01 — capacités des modèles', () => {
  it('section branchée, lecture seule, route d’administration', () => {
    expect(page).toContain('<ModelCapabilities />');
    expect(capacites).toContain("apiClient.get<Data>('/api/admin/ai/model-capabilities')");
    expect(capacites).not.toMatch(/apiClient\.(post|put|delete)/);
  });
  it('desktop et mobile : cartes empilées (md:grid-cols-2), aucun tableau à défilement', () => {
    expect(capacites).toContain('grid gap-3 md:grid-cols-2');
    expect(capacites).not.toContain('<table');
    expect(capacites).toContain('break-all');
  });
  it('Preview pour information seulement ; source, date, à requalifier', () => {
    expect(capacites).toContain('Preview · information seulement (exclu en V1)');
    expect(capacites).toContain('Requalification nécessaire depuis le');
    expect(capacites).toMatch(/SOURCE\[s\.source\]/);
  });
});

describe('L85C-UI-02 — profils par opération et par rang', () => {
  it('dans l’éditeur de chaque traitement, opérations lues du serveur', () => {
    expect(page).toContain('<OperationProfilesEditor');
    expect(page).toContain('operations={catalogs.operationsByTreatment?.[entry.treatment] ?? []}');
    expect(page).toContain("onChange={(next) => set('operationProfiles', next)}");
    expect(page).toContain('`/api/admin/ai/model-capabilities?versionId=${current.id}`');
  });
  it('trois rangs, valeurs héritées explicites, une colonne en mobile', () => {
    expect(profils).toContain("['primaryModel', 'Principal'], ['fallback1', 'Repli 1'], ['fallback2', 'Repli 2']");
    expect(profils).toContain('raisonnement hérité');
    expect(profils).toContain('grid gap-3 sm:grid-cols-3');
    expect(profils).toContain('refusé avant appel');
    expect(profils).toContain('ramené à la limite du modèle');
  });
});

describe('L85C-UI-03 — garde-fous de saisie', () => {
  it('la température n’est jamais un champ saisi (décision 09)', () => {
    expect(profils).not.toMatch(/aria-label=\{[^}]*température/i);
    expect(profils).not.toMatch(/temperature:\s*e\.target/);
  });
});
