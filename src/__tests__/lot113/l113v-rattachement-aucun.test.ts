/**
 * Lot 113V (#719, post-MEP) — « Aucun » dans les choix de rattachement
 * document → bien ; non-rattachement explicite respecté (unitaires, sans base).
 *
 *   L113V-U-01 carte à 2 candidats : 2 biens en évidence + « Aucun » à côté,
 *              actionnable, neutre, accessible ; même parcours (`onChoose`,
 *              valeur NONE) ; « Aucun » sous l'état vide, absent en erreur.
 *   L113V-U-02 message de succès de « Aucun » ; « Annuler » conservé.
 *   L113V-U-03 éléments RÉELLEMENT nouveaux (pure) : même contexte → rien ;
 *              nouveau bien désigné → réexamen ; bien refusé seulement
 *              candidat → rien ; preuve déterministe + document modifié →
 *              réexamen ; bien inéligible jamais proposé.
 *   L113V-U-04 question de réexamen : nomme l'élément nouveau, jamais
 *              « opération ».
 *   L113V-U-05 trace de décision lue défensivement.
 *   L113V-U-06 T1 : un bien désigné reste CITÉ (aucun rattachement).
 *   L113V-U-07 câblage : route canonique, annulation, porte de la question
 *              (pont + balayage), écriture automatique, balayage T3,
 *              confirmation à contexte inchangé, cohérence ; aucune
 *              modification de la règle « Non applicable » générique.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import React, { createElement as h, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('sonner', () => ({ toast: Object.assign(() => {}, { info: () => {}, error: () => {}, success: () => {} }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));
vi.mock('@/db', () => ({ db: {}, pgClient: { unsafe: async () => [] } }));

(globalThis as { React?: typeof React }).React = React;

const choix = await import('@/services/to-process/no-asset-choice');
const { ActionCard } = await import('@/components/to-process/ActionCard');
const { AssetLinkChoices, ASSET_LINK_TEXT } = await import('@/components/to-process/AssetLinkChoices');
const { resolutionToastText } = await import('@/components/to-process/useToProcessResolution');
const { withoutAssetAttachment } = await import('@/services/ai/source-analysis/master/document-links');
const { getRule } = await import('@/services/to-process/rules-catalog');

const lire = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');
type View = Parameters<typeof ActionCard>[0]['action'];
const carte = (over: Partial<View> = {}): View => ({
  publicId: 'c0ffee00-0719', targetType: 'DOCUMENT', targetId: 42, fieldKey: null, relationKey: 'assetIds',
  actionKind: 'ARBITRATE', priority: 'DO_NEXT', ruleCode: 'LINK-ASSET', question: 'À quel bien rattacher ce document ?',
  proposals: [{ value: 1, label: 'Maison' }, { value: 3, label: 'Appartement Lyon' }],
  target: { label: 'Courrier de la mairie' },
  assetChoices: {
    status: 'OK',
    items: [
      { assetId: 1, label: 'Maison', suggested: true },
      { assetId: 3, label: 'Appartement Lyon', suggested: true },
      { assetId: 9, label: 'Peugeot 3008', suggested: false },
    ],
  },
  ...over,
});
const noop = () => {};
const rendu = (action: View, onChoose: Parameters<typeof ActionCard>[0]['onChoose'] = noop) =>
  renderToStaticMarkup(h(ActionCard, { action, onChoose, onOpenTarget: noop, visual: true }));
const boutons = (html: string) => [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').trim());
function find(node: ReactNode, pred: (el: ReactElement<Record<string, unknown>>) => boolean, out: ReactElement<Record<string, unknown>>[] = []) {
  if (Array.isArray(node)) { node.forEach((n) => find(n, pred, out)); return out; }
  if (!isValidElement(node)) return out;
  const el = node as ReactElement<Record<string, unknown>>;
  if (pred(el)) out.push(el);
  find(el.props.children as ReactNode, pred, out);
  return out;
}

describe('L113V — carte (mobile et ordinateur : même composant)', () => {
  it('L113V-U-01 — 2 candidats : 2 biens en évidence et « Aucun » à côté, actionnable, même parcours', () => {
    const html = rendu(carte());
    expect(boutons(html)).toEqual(['Maison', 'Appartement Lyon', 'Peugeot 3008', 'Aucun']);
    expect(html).toContain('data-asset-choice="none"');
    expect(html).toContain(`aria-label="${ASSET_LINK_TEXT.noneAria}"`);
    // Aucun « Ouvrir » / « Autre » (113A) ; « Aucun » est dans le groupe des choix, en bouton neutre.
    expect(boutons(html)).not.toContain('Ouvrir');
    const groupe = html.slice(html.indexOf('data-asset-choices="ok"'));
    expect(groupe.indexOf('data-asset-choice="none"')).toBeGreaterThan(0);

    const onNone = vi.fn();
    const tree = AssetLinkChoices({ choices: carte().assetChoices!, onPick: noop, onRetry: noop, onNone });
    // Bouton rendu par un sous-composant (`NoneButton`) : déplié pour lire ses propriétés.
    const [btn] = find(tree as ReactNode, (el) => typeof el.props.onNone === 'function');
    const inner = (btn.type as (p: unknown) => ReactElement<Record<string, unknown>>)(btn.props);
    expect(inner.props.variant).toBe('outline');
    (inner.props.onClick as () => void)();
    expect(onNone).toHaveBeenCalledTimes(1);
    // Câblage de la carte : `onChoose` (route `/resolve`), valeur NONE — jamais un identifiant de bien.
    const src = lire('src/components/to-process/ActionCard.tsx');
    expect(src).toMatch(/onNone=\{\(\) => onChoose\(action, \{ value: NO_ASSET_CHOICE, label: NO_ASSET_CHOICE_LABEL \}\)\}/);
    expect(choix.NO_ASSET_CHOICE).toBe('NONE');
    expect(choix.NO_ASSET_CHOICE_LABEL).toBe('Aucun');
    expect(lire('src/components/to-process/AssetLinkChoices.tsx')).not.toMatch(/apiClient|fetch\(|['`]\/api\//);
  });

  it('L113V-U-01 bis — aucun bien éligible : « Aucun » sous l’état vide ; liste illisible : pas de « Aucun »', () => {
    expect(boutons(rendu(carte({ actionKind: 'COMPLETE', proposals: [], assetChoices: { status: 'EMPTY', items: [] } })))).toEqual(['Aucun']);
    expect(boutons(rendu(carte({ assetChoices: { status: 'ERROR', items: [] } })))).toEqual([ASSET_LINK_TEXT.retry]);
    // Sans `onNone` (appel direct historique) : comportement 113A inchangé.
    const html = renderToStaticMarkup(h(AssetLinkChoices, { choices: carte().assetChoices!, onPick: noop, onRetry: noop }));
    expect(html).not.toContain('data-asset-choice="none"');
  });

  it('L113V-U-02 — message de « Aucun » (à valider PO), autres messages inchangés', () => {
    expect(resolutionToastText(carte(), { label: 'Aucun', value: 'NONE' })).toBe('Choix enregistré : ce document reste sans bien.');
    expect(resolutionToastText(carte(), { label: 'Maison', value: 1 })).toBe('Document rattaché à « Maison »');
    expect(resolutionToastText({ assetChoices: undefined }, { label: '12/03/2027' })).toBe('Valeur mise à jour');
    // « Annuler » reste proposé (seul `undoable: false` le retire).
    expect(lire('src/components/to-process/useToProcessResolution.ts')).toMatch(/action: \{ label: 'Annuler'/);
  });
});

describe('L113V — éléments réellement nouveaux (pure)', () => {
  const base = { offeredAssetIds: [1, 3, 9], provenAssetIds: [] as number[], candidateAssetIds: [] as number[], eligibleAssetIds: [1, 3, 9], documentChanged: false };
  it('L113V-U-03 — même contexte : rien ; bien refusé simplement candidat : rien ; même document + preuve : rien', () => {
    expect(choix.noAssetNewElements(base)).toEqual({ newAssetIds: [], newEvidenceAssetIds: [], proposalIds: [] });
    expect(choix.noAssetNewElements({ ...base, candidateAssetIds: [1, 3] }).proposalIds).toEqual([]);
    expect(choix.noAssetNewElements({ ...base, provenAssetIds: [1] }).proposalIds).toEqual([]);
    expect(choix.noAssetNewElements({ ...base, candidateAssetIds: [1], documentChanged: true }).proposalIds).toEqual([]);
  });
  it('L113V-U-03 bis — nouveau bien désigné ; preuve déterministe après nouvelle analyse ; inéligible jamais proposé', () => {
    expect(choix.noAssetNewElements({ ...base, eligibleAssetIds: [1, 3, 9, 12], candidateAssetIds: [12, 1] }))
      .toEqual({ newAssetIds: [12], newEvidenceAssetIds: [], proposalIds: [12] });
    expect(choix.noAssetNewElements({ ...base, provenAssetIds: [3], documentChanged: true }))
      .toEqual({ newAssetIds: [], newEvidenceAssetIds: [3], proposalIds: [3] });
    // Bien créé mais non désigné par le document : aucune relance.
    expect(choix.noAssetNewElements({ ...base, eligibleAssetIds: [1, 3, 9, 12] }).proposalIds).toEqual([]);
    // Bien nouveau mais archivé / verrouillé / supprimé : jamais proposé.
    expect(choix.noAssetNewElements({ ...base, candidateAssetIds: [77] }).proposalIds).toEqual([]);
    // Ordre : preuve d'abord, puis indices.
    expect(choix.noAssetNewElements({ ...base, eligibleAssetIds: [1, 3, 9, 12, 13], candidateAssetIds: [13], provenAssetIds: [12] }).proposalIds).toEqual([12, 13]);
  });
  it('L113V-U-04 — la question nomme l’élément nouveau, sans « opération »', () => {
    const q = [
      choix.noAssetReexaminationQuestion({ newAssetLabels: ['Maison'], newEvidence: false }),
      choix.noAssetReexaminationQuestion({ newAssetLabels: ['Maison', 'Clio'], newEvidence: false }),
      choix.noAssetReexaminationQuestion({ newAssetLabels: [], newEvidence: true }),
    ];
    expect(q[0]).toBe('Vous avez ajouté « Maison » depuis votre choix « Aucun » : à quel bien rattacher ce document ?');
    for (const x of q) { expect(x).toMatch(/\?$/); expect(x).not.toMatch(/op[ée]ration/i); }
  });
  it('L113V-U-05 — trace lue défensivement', () => {
    expect(choix.parseNoAssetDecision(null)).toBeNull();
    expect(choix.parseNoAssetDecision({ action_id: 'x', decided_at: null, user_id: null, details: {} })).toBeNull();
    expect(choix.parseNoAssetDecision({ action_id: 5, decided_at: null, user_id: null, details: { choice: 'OTHER' } })).toBeNull();
    expect(choix.parseNoAssetDecision({
      action_id: '5', decided_at: '2026-11-07T10:00:00Z', user_id: 4,
      details: JSON.stringify({ choice: 'NO_ASSET', candidateAssetIds: [1, '3', 1], offeredAssetIds: [1, 3, 9, -2], knowledgeRev: 'abc' }),
    })).toEqual({
      actionId: 5, decidedAt: '2026-11-07T10:00:00.000Z', userId: 4, candidateAssetIds: [1, 3], offeredAssetIds: [1, 3, 9], knowledgeRev: 'abc',
    });
    expect(choix.isNoAssetChoice('NONE')).toBe(true);
    expect(choix.isNoAssetChoice(0)).toBe(false);
  });
  it('L113V-U-06 — T1 : biens désignés seulement CITÉS (aucun rattachement), le reste intact', () => {
    expect(withoutAssetAttachment([
      { assetId: 1, role: 'PRIMARY', confidence: 1 }, { assetId: 3, role: 'SECONDARY', confidence: 0.9 }, { assetId: 9, role: 'MENTIONED', confidence: 0.5 },
    ])).toEqual([
      { assetId: 1, role: 'MENTIONED', confidence: 1 }, { assetId: 3, role: 'MENTIONED', confidence: 0.9 }, { assetId: 9, role: 'MENTIONED', confidence: 0.5 },
    ]);
  });
});

describe('L113V — câblage (un seul circuit, aucun second moteur)', () => {
  it('L113V-U-07 — décision : route canonique verrouillée, annulation, condition SQL partagée', () => {
    const resolve = lire('src/services/to-process/resolve-action.service.ts');
    expect(resolve).toMatch(/isNoAssetChoice\(value\)\) \{\s+const \{ resolveNoAssetChoice \}/);
    expect(resolve).toMatch(/undoNoAssetChoice\(action, accountId\)/);
    // La règle générique « Non applicable » reste refusée pour LINK-ASSET : seul « Aucun » ferme ainsi la carte.
    expect(getRule('LINK-ASSET')!.allowNotApplicable).toBe(false);
    const sqlAucun = choix.explicitNoAssetSql('f');
    expect(sqlAucun).toContain("ne.details ->> 'choice' = 'NO_ASSET'");
    expect(sqlAucun).toContain("nb.resolution_reason IN ('USER_ARBITRATED', 'USER_COMPLETED')");
    expect(sqlAucun).toContain("nl.origin = 'USER'");
    expect(sqlAucun).toContain('nl.equipment_id IS NULL');
    const decision = lire('src/services/to-process/no-asset-decision.ts');
    // Aucune écriture de lien ni de colonne de rattachement.
    expect(decision).not.toMatch(/linkDocumentToAsset|unlinkDocument|writeUser|SET asset_id/);
  });

  it('L113V-U-07 bis — respect partout : pont, balayage, écriture automatique, T1, T3, cohérence', () => {
    expect(lire('src/services/ai/reconciliation/document-asset/question-gate.ts')).toMatch(/AND NOT \$\{explicitNoAssetSql\('f'\)\}/);
    expect(lire('src/services/to-process/document-rule-bridge.ts')).toMatch(/plan = \{ kind: 'NONE', reason: 'USER_NO_ASSET' \}/);
    const slots = lire('src/services/to-process/document-slots.ts');
    const auto = slots.slice(slots.indexOf('async writeAuto', slots.indexOf('export const ASSET_LINK_SLOT')), slots.indexOf('async writeUser', slots.indexOf('export const ASSET_LINK_SLOT')));
    expect(auto).toContain("explicitNoAssetSql('asset_files')");
    expect(lire('src/services/ai/source-analysis/pipeline.ts')).toMatch(/aucunBien \? withoutAssetAttachment\(liensT1\) : liensT1/);
    const t3 = lire('src/services/ai/reconciliation/document-asset/resolve-document-asset.service.ts');
    // Décision lue AVANT tout appel au modèle, et relue juste avant l'écriture.
    expect(t3.indexOf('respectExplicitNoAsset({')).toBeLessThan(t3.indexOf('await callModel({'));
    expect(t3).toMatch(/Lot 113V : « Aucun » choisi PENDANT l'évaluation/);
    const respect = lire('src/services/ai/reconciliation/document-asset/explicit-no-asset.ts');
    expect(respect).not.toMatch(/AiGateway|callModel|attachAutomatically|linkDocumentToAsset/);
    const queue = lire('src/services/ai/reconciliation/document-asset/queue.ts');
    expect(queue).toContain("AND r.reason_code IS DISTINCT FROM '${NO_ASSET_REASON_CODE}')");
    expect(lire('src/services/ai/reconciliation/document-asset/resolution.repository.ts')).toContain("status = 'USER_DECIDED' AND reason_code = 'USER_NO_ASSET'");
    expect(lire('src/services/coherence/registry/checks/document-primary-link.ts')).toContain("'USER_NO_ASSET'");
  });
});
