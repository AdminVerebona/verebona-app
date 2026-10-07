/**
 * Écran BO IA (page.tsx) — branchement des correctifs T4 et T5 (lot 24).
 *
 * Contrôle de source (l'environnement de test est Node, sans DOM) : le bloc
 * Déclencheurs passe par `TriggersEditor` (entrées incompatibles visibles et
 * supprimables), un catalogue indisponible affiche une erreur + Réessayer,
 * l'écran relit la ligne enregistrée après sauvegarde ; T5 affiche le
 * message permanent et l'information non bloquante d'un texte hérité.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEditTracker } from '../edit-tracker';
import { T5_LEGACY_TEXT_MESSAGE, T5_REPOSITORY_PROMPT_MESSAGE, hasLegacyPromptText } from '@/services/ai/config/t5-messages';

const page = readFileSync(join(process.cwd(), 'src/app/admin/ai-config/page.tsx'), 'utf8');

describe('T4 — déclencheurs', () => {
  it('TriggersEditor branché ; l’ancien bloc (catalogue applicable seul) a disparu', () => {
    expect(page).toContain('<TriggersEditor');
    expect(page).toContain('catalog={catalogs.triggerCatalog}');
    expect(page).toContain('defaults={catalog.defaultTriggers ?? []}');
    expect(page).toContain('readOnly={readOnly}');
    expect(page).not.toContain('toggleTrigger');
    expect(page).not.toMatch(/catalog\.triggers\.map\(\(t\) =>/);
  });

  it('catalogue indisponible : erreur explicite et Réessayer (relecture du seul catalogue)', () => {
    expect(page).toContain('Le catalogue des déclencheurs n&apos;a pas pu être chargé');
    expect(page).toContain('onClick={onRetryCatalogs}');
    expect(page).toContain('onRetryCatalogs={reloadCatalogs}');
  });

  it('après enregistrement, la ligne enregistrée est relue', () => {
    const save = page.slice(page.indexOf('const saveTreatment'), page.indexOf('const saveAllDirty'));
    expect(save).toContain('apiClient.get<VersionDetail>(`/api/admin/ai/config-versions/${current.id}`)');
    expect(save).toContain('setDrafts((d) => ({ ...d, [t]: relue }))');
  });

  it('une saisie faite pendant l’enregistrement n’est jamais écrasée par la relecture', () => {
    const save = page.slice(page.indexOf('const saveTreatment'), page.indexOf('const saveAllDirty'));
    expect(save).toContain('const repere = edits.mark(t);');
    expect(save).toContain('if (relue && edits.unchangedSince(t, repere)) setDrafts(');
    expect(save).toContain('if (edits.unchangedSince(t, repere)) setDirty(');
    expect(page).toContain('edits.bump(t.code);');

    const tr = createEditTracker();
    const repere = tr.mark('T4');
    expect(tr.unchangedSince('T4', repere)).toBe(true);
    tr.bump('T4'); // saisie pendant le PUT / GET
    expect(tr.unchangedSince('T4', repere)).toBe(false);
    expect(tr.unchangedSince('T1', tr.mark('T1'))).toBe(true);
  });
});

describe('T5 — messages', () => {
  it('message permanent du dépôt ; information non bloquante sur la ligne ENREGISTRÉE ; enregistrement possible pour nettoyer', () => {
    expect(page).toContain('{T5_REPOSITORY_PROMPT_MESSAGE}');
    expect(page).toContain('saved && hasLegacyPromptText(saved)');
    expect(page).toContain('{T5_LEGACY_TEXT_MESSAGE}');
    expect(page).toContain('disabled={(!dirty.has(t.code) && !legacyT5(t.code)) || busy}');
    // Plus de consigne inapplicable pour T5.
    expect(page).not.toMatch(/zone dédiée/);
  });

  it('textes du ticket et détection', () => {
    // Lot 32B (décision PO n° 15) : le texte de T5 s'administre dans « Prompts maîtres ».
    expect(T5_REPOSITORY_PROMPT_MESSAGE).toMatch(/s’administre dans la section « Prompts maîtres »/);
    expect(T5_LEGACY_TEXT_MESSAGE).toBe('Un ancien texte de configuration est présent mais n’est pas utilisé par T5. Il sera retiré lors de l’enregistrement du brouillon.');
    expect(hasLegacyPromptText({ prompt: '', masterPrompt: null })).toBe(false);
    expect(hasLegacyPromptText({ prompt: ' x ', masterPrompt: null })).toBe(true);
    expect(hasLegacyPromptText({ prompt: '', masterPrompt: 'm' })).toBe(true);
  });
});

// ── Lot 32B — sélecteurs de modèles par traitement ───────────────────────────
describe('MOD — TreatmentEditor', () => {
  const editeur = page.slice(page.indexOf('function TreatmentEditor('), page.indexOf('const toggleGuardrail'));

  it('MOD-29 — les sélecteurs n’utilisent QUE modelsByTreatment[entry.treatment] (plus la liste globale)', () => {
    expect(editeur).toContain('catalogs.modelsByTreatment?.[entry.treatment]');
    expect(editeur).not.toContain('catalogs.models.map');
    expect(page).not.toMatch(/catalogs\.models\.map/);
  });

  it('MOD-30 — même base pour les trois rangs, modèle déjà choisi retiré, valeur enregistrée inutilisable marquée', () => {
    expect(editeur).toContain('chainOptions(usableNames, entry, rank, { readOnly, reasonOf: motif })');
    for (const r of ['primaryModel', 'fallback1', 'fallback2']) expect(page).toContain(`{modelOptions('${r}')}`);
    expect(editeur).toContain('disabled={o.unusable}');
    expect(page).toContain('unusableRanks(usableNames, entry)');
  });
});

describe('PO15 — section « Prompts maîtres »', () => {
  it('PO15-09 — T5 n’est plus annoncé comme non modifiable', () => {
    const mp = readFileSync(join(process.cwd(), 'src/app/admin/ai-config/_components/MasterPrompts.tsx'), 'utf8');
    expect(mp).not.toContain('il n’est pas modifiable ici');
    expect(mp).toContain('T5 (Prompt Control) s’administre ici comme les autres prompts');
  });
});
