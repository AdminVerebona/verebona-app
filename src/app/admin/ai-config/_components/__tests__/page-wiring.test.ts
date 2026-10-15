/**
 * Écran BO IA (page.tsx) — branchement des correctifs T4 (lot 24) ; lot 49
 * (ticket 12) : T5 « Prompt Control » supprimé de l'écran.
 *
 * Contrôle de source (l'environnement de test est Node, sans DOM) : le bloc
 * Déclencheurs passe par `TriggersEditor` (entrées incompatibles visibles et
 * supprimables), un catalogue indisponible affiche une erreur + Réessayer,
 * l'écran relit la ligne enregistrée après sauvegarde.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEditTracker } from '../edit-tracker';

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

  it('après enregistrement, la configuration enregistrée est relue (lot 54 : enregistrement global)', () => {
    const save = page.slice(page.indexOf('const saveAll = async'), page.indexOf('const createVersion = async'));
    expect(save).toContain('apiClient.get<VersionDetail>(`/api/admin/ai/config-versions/${current.id}`)');
    expect(save).toContain('for (const e of v.entries) if (!encore.includes(e.treatment)) n[e.treatment] = e;');
  });

  it('une saisie faite pendant l’enregistrement n’est jamais écrasée par la relecture', () => {
    const save = page.slice(page.indexOf('const saveAll = async'), page.indexOf('const createVersion = async'));
    expect(save).toContain('edits.mark(t)');
    expect(save).toContain('!edits.unchangedSince(t, reperes[t])');
    expect(save).toContain('setDirty(new Set(encore))');
    expect(page).toContain('edits.bump(t.code);');

    const tr = createEditTracker();
    const repere = tr.mark('T4');
    expect(tr.unchangedSince('T4', repere)).toBe(true);
    tr.bump('T4'); // saisie pendant le PUT / GET
    expect(tr.unchangedSince('T4', repere)).toBe(false);
    expect(tr.unchangedSince('T1', tr.mark('T1'))).toBe(true);
  });
});

describe('Lot 49 — T5 supprimé de l’écran (ticket 12)', () => {
  it('T12-AC01 / T5-DEL-01 — plus de Prompt Control : composant, formulaires, appels, ancre et types retirés', () => {
    expect(page).not.toMatch(/PromptControl|prompt-control|Prompt Control \(T5\) —|T5Result|T5Change/);
    expect(page).not.toContain("'/api/admin/ai/prompt-control'");
    expect(page).not.toContain('id="prompt-control"');
    expect(page).toContain("type Treatment = 'T1' | 'T2' | 'T3' | 'T4' | 'T6';");
    // Plus de message ni de bouton propres à T5 ; l'enregistrement ne dépend que des modifications.
    expect(page).not.toMatch(/legacyT5|T5_REPOSITORY_PROMPT_MESSAGE|T5_LEGACY_TEXT_MESSAGE|hasLegacyPromptText/);
    expect(page).toContain('disabled={readOnly || !hasUnsaved || busy}');
  });

  it('T12-AC01 — autres écrans d’administration courante : aucune option T5 (supervision, coûts, file, tableau de bord)', () => {
    for (const f of ['src/app/admin/ai-executions/page.tsx', 'src/app/admin/ai-costs/page.tsx', 'src/app/admin/ai-queue/page.tsx', 'src/app/admin/ai-dashboard/page.tsx']) {
      const src = readFileSync(join(process.cwd(), f), 'utf8');
      expect(src, f).not.toMatch(/'T5'|AI_GOVERNANCE: 'T5'/);
    }
  });

  it('T12-AC09 — une version historique contenant T5 reste lisible : note « traitement supprimé, jamais appliqué » (desktop et mobile, même composant)', () => {
    expect(page).toContain('data-testid="retired-treatments-note"');
    expect(page).toContain('current.retiredTreatments');
    expect(page).toMatch(/break-words/);
  });

  it('T12-AC03 — la section « Prompts maîtres » reste branchée (administration manuelle)', () => {
    expect(page).toContain('<MasterPrompts refreshKey={promptsKey}');
    expect(page).toContain('s’administre dans la section « Prompts maîtres »');
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
  it('T12-AC04 — aucun prompt maître T5 proposé en édition ; plus de mention d’administration de T5', () => {
    const mp = readFileSync(join(process.cwd(), 'src/app/admin/ai-config/_components/MasterPrompts.tsx'), 'utf8');
    expect(mp).not.toContain('il n’est pas modifiable ici');
    expect(mp).not.toContain('T5 (Prompt Control) s’administre ici comme les autres prompts');
  });
});
