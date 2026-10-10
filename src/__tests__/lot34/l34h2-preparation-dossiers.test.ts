/**
 * Lot 34 (34H2), point 6 — tiroir « Préparation des dossiers » (ex-
 * « Informations complémentaires ») : libellé, texte d'introduction, écriture
 * réservée au droit de créer des dossiers, comportement Standard commun.
 *
 *   DOSS-01 libellé remplacé partout dans l'interface du tiroir
 *   DOSS-02 nouveau texte d'introduction (générique)
 *   DOSS-03 aucun renommage technique (route, clés, table)
 *   DOSS-04 droit FONCTIONNEL (premiumFeatures), jamais `plan === 'PREMIUM'`
 *   DOSS-05 compte avec le droit : tiroir utilisable, champs modifiables,
 *           enregistrement automatique conservé
 *   DOSS-06 Standard : tiroir visible, AUCUN champ rendu (ni modifiable, ni
 *           clavier mobile), clic → fenêtre de fonctionnalité limitée commune
 *   DOSS-07 aucun nouveau toast / paywall / parcours d'upgrade
 *   DOSS-08 contrôle serveur sur la mutation (e2e : refus API direct)
 *   DOSS-10/11 décision sur les droits ACTUELS (downgrade ferme, upgrade rouvre)
 *   DOSS-12 génération inchangée (mappings non touchés)
 *   DOSS-13 mobile / desktop : même composant, pas de variante cachée
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as React from 'react';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const droits = vi.hoisted(() => ({ current: null as null | { premiumFeatures: boolean; canWrite: boolean; isRestricted: boolean } }));
vi.mock('@/hooks/useEntitlements', () => ({
  useEntitlements: () => ({
    entitlements: droits.current, isLoading: droits.current === null, isRestricted: droits.current?.isRestricted ?? false,
    refresh: async () => {}, status: droits.current ? 'ready' : 'loading',
  }),
}));
vi.mock('@/lib/api-client', () => ({ apiClient: { get: async () => ({}), patch: async () => ({}) } }));
(globalThis as { React?: typeof React }).React = React;

import {
  canCreateDossiers, decideDossierDrawerClick, DOSSIER_PREPARATION_INTRO, DOSSIER_PREPARATION_PREMIUM_MESSAGE, DOSSIER_PREPARATION_TITLE,
} from '@/lib/entitlements/dossier-rights';
const { AssetAdditionalInfosSection } = await import('@/components/assets/AssetAdditionalInfosSection');

const lire = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');
const SECTION = 'src/components/assets/AssetAdditionalInfosSection.tsx';
const ROUTE = 'src/app/api/assets/[id]/additional-infos/route.ts';

const PREMIUM = { premiumFeatures: true, canWrite: true, isRestricted: false };
const STANDARD = { premiumFeatures: false, canWrite: true, isRestricted: false };

const rendre = (props: Partial<Parameters<typeof AssetAdditionalInfosSection>[0]> = {}) =>
  renderToStaticMarkup(h(AssetAdditionalInfosSection, { assetId: 7, category: 'VEHICULE', ...props }));

beforeEach(() => { droits.current = null; });

describe('Libellé (DOSS-01 à DOSS-03)', () => {
  it('DOSS-01 — « Informations complémentaires » remplacé par « Préparation des dossiers » dans le tiroir', () => {
    expect(DOSSIER_PREPARATION_TITLE).toBe('Préparation des dossiers');
    droits.current = PREMIUM;
    const html = rendre();
    expect(html).toContain('Préparation des dossiers');
    expect(html).not.toContain('Informations complémentaires');
    // Variante embarquée (écran de préparation d'un dossier) : même libellé.
    expect(rendre({ variant: 'embedded' })).toContain('Préparation des dossiers');
    const src = lire(SECTION);
    expect(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')).not.toMatch(/Informations complémentaires|informations complémentaires/);
    // Autres libellés d'interface liés au tiroir.
    expect(lire('src/services/exports/v12/preparation/messages.ts')).toContain('Les informations de préparation des dossiers n’ont pas pu être enregistrées');
    expect(lire('src/components/exports/preparation/ExportPreparationScreen.tsx')).toContain('Les informations de préparation des dossiers saisies');
  });

  it('DOSS-02 — nouveau texte d’introduction, l’ancien est supprimé', () => {
    expect(DOSSIER_PREPARATION_INTRO).toBe(
      'Renseignez ici les informations utilisées pour préparer automatiquement vos dossiers. Elles seront reprises dans les dossiers compatibles avec ce bien.',
    );
    const src = lire(SECTION);
    expect(src).toContain('{DOSSIER_PREPARATION_INTRO}');
    expect(src).not.toContain('Prix, points forts, loyer, protections, sinistre, valeur et charges');
  });

  it('DOSS-03 — aucun renommage technique : route, clés API et table inchangées', () => {
    expect(lire(ROUTE)).toContain('/api/assets/[id]/additional-infos');
    expect(lire('src/db/schema.ts')).toContain("pgTable('asset_additional_infos'");
    expect(lire(SECTION)).toContain('`/api/assets/${assetId}/additional-infos`');
    expect(lire(SECTION)).toContain('id="asset-section-additional_infos"');
  });
});

describe('Droit fonctionnel (DOSS-04, DOSS-10, DOSS-11)', () => {
  it('DOSS-04 — `canCreateDossiers` suit `premiumFeatures` (Premium, Duo, essai, futures offres), jamais le nom du plan', () => {
    expect(canCreateDossiers({ premiumFeatures: true, canWrite: true })).toBe(true);
    expect(canCreateDossiers({ premiumFeatures: false, canWrite: true })).toBe(false);
    expect(canCreateDossiers({ premiumFeatures: true, canWrite: false })).toBe(false);
    expect(canCreateDossiers(null)).toBeNull();
    // Une offre au nom inconnu qui ouvre la fonction est couverte.
    expect(canCreateDossiers({ plan: 'premium_famille', premiumFeatures: true } as never)).toBe(true);
    for (const f of [SECTION, ROUTE, 'src/lib/entitlements/dossier-rights.ts']) {
      const code = lire(f).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      expect(code).not.toMatch(/plan\s*===?\s*['"](PREMIUM|premium)/);
    }
    const service = lire('src/services/entitlements.service.ts');
    expect(service).toMatch(/export async function canCreateDossiers\(accountId: number\)[\s\S]*?return canUsePremiumFeature\(accountId\)/);
  });

  it('DOSS-10 / DOSS-11 — décision sur les droits ACTUELS : perdu → tiroir refermé ; retrouvé → ouvrable sans rechargement', () => {
    const src = lire(SECTION);
    // Droits lus du magasin partagé (relu après changement d'offre), jamais stockés.
    expect(src).toContain('const droitDossiers = canCreateDossiers(entitlements);');
    expect(src).not.toMatch(/localStorage|sessionStorage/);
    expect(src).toContain('if (!droitDossiers) setOpen(false);');
    // Rien n'est vidé côté client : aucune écriture déclenchée par le changement de droit.
    expect(src).not.toMatch(/queue\.set\([^)]*null\)[\s\S]{0,80}droitDossiers/);
  });
});

describe('Compte avec le droit (DOSS-05)', () => {
  it('DOSS-05 — tiroir utilisable : clic → ouverture ; champs modifiables et enregistrement automatique conservés', () => {
    expect(decideDossierDrawerClick(false, true)).toBe('open');
    expect(decideDossierDrawerClick(true, true)).toBe('close');
    droits.current = PREMIUM;
    expect(rendre()).toContain('data-dossier-right="granted"');
    const src = lire(SECTION);
    expect(src).toContain('const readOnly = readOnlyProp || droitDossiers !== true;');
    expect(src).toContain('createAutosaveQueue');
    // Variante embarquée (préparation d'un dossier, compte autorisé) : champs actifs.
    const html = rendre({ variant: 'embedded' });
    expect(html).not.toContain('readonly=""');
  });
});

describe('Compte Standard (DOSS-06, DOSS-07)', () => {
  it('DOSS-06 — tiroir visible, fermé, sans aucun champ ; clic → refus commun, jamais d’ouverture', () => {
    droits.current = STANDARD;
    const html = rendre({ defaultOpen: true });
    expect(html).toContain('Préparation des dossiers');
    expect(html).toContain('data-dossier-right="denied"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toMatch(/<input|<textarea|<select/);
    expect(decideDossierDrawerClick(false, false)).toBe('refuse');
  });

  it('DOSS-06 — droits inconnus : rien d’ouvert ni de modifiable avant le contrôle (pas de clavier mobile)', () => {
    droits.current = null;
    const html = rendre({ defaultOpen: true });
    expect(html).toContain('data-dossier-right="unknown"');
    expect(html).not.toMatch(/<input|<textarea|<select/);
    expect(decideDossierDrawerClick(false, null)).toBe('wait');
    // Embarquée, droits inconnus : lecture seule (aucun champ modifiable).
    const src = lire(SECTION);
    expect(src).toContain('{open && droitDossiers === true && (');
  });

  it('DOSS-07 — même mécanisme que les autres fonctions Premium : garde commune + fenêtre partagée `PREMIUM_REQUIRED`', () => {
    const src = lire(SECTION);
    expect(src).toContain("garder(() => signalerRefus({ code: 'PREMIUM_REQUIRED', message: DOSSIER_PREPARATION_PREMIUM_MESSAGE }))");
    // Comme l'ajout d'une pièce / d'un équipement (mêmes appels).
    expect(lire('src/components/assets/asset-equipments-panel.tsx')).toMatch(/garder\([\s\S]*signalerRefus\(\{\s*code: 'PREMIUM_REQUIRED'/);
    // Aucun nouveau composant de restriction : ni toast, ni dialogue, ni lien d'offre propres.
    expect(src).not.toMatch(/from 'sonner'|@\/components\/ui\/dialog|WriteBlockedDialog|\/mon-compte\/offres|Passer à Premium/);
    // Même système de libellés que les autres fonctions Premium.
    expect(DOSSIER_PREPARATION_PREMIUM_MESSAGE).toMatch(/ est disponible avec les offres Premium et Premium Duo\.$/);
  });
});

describe('Serveur et non-régression (DOSS-08, DOSS-12, DOSS-13)', () => {
  it('DOSS-08 — la mutation vérifie le droit Dossiers AVANT de lire le corps ; refus 403 au format commun', () => {
    const src = lire(ROUTE);
    const patch = src.slice(src.indexOf('export async function PATCH'));
    const iDroit = patch.indexOf('await canCreateDossiers(accountId)');
    expect(iDroit).toBeGreaterThan(0);
    expect(iDroit).toBeLessThan(patch.indexOf('await request.json()'));
    expect(iDroit).toBeLessThan(patch.indexOf('updateAssetAdditionalInfos('));
    expect(patch).toMatch(/\{ error: code, code, message \}, \{ status: 403 \}/);
    // Seule mutation de ces données : `updateAssetAdditionalInfos`, appelée par cette route uniquement.
    expect(lire('src/services/exports/additional-infos.service.ts')).toContain('export async function updateAssetAdditionalInfos(');
  });

  it('DOSS-12 — génération inchangée : la source des dossiers lit toujours les mêmes informations', () => {
    const source = lire('src/services/exports/v12/data/source.ts');
    expect(source).toContain("import { getAssetAdditionalInfos } from '@/services/exports/additional-infos.service';");
    expect(lire('src/services/exports/additional-infos.service.ts')).not.toMatch(/canCreateDossiers|premiumFeatures/);
  });

  it('DOSS-13 — mobile, tablette, desktop : un seul rendu, le refus passe par la même fenêtre', () => {
    const src = lire(SECTION);
    expect(src).not.toMatch(/useIsMobile|md:hidden|hidden md:/);
  });
});
