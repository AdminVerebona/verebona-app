/**
 * Carte #836 (écart E06) — PORTÉE DU JEU DE PROPOSITIONS CONSERVÉ par une carte
 * « À traiter », régression révélée par la recette E2E sur PostgreSQL réel.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LA RÉGRESSION
 *
 * Pour fermer l'écart E06, `upsertAction` a cessé de ne conserver que la
 * première page d'affichage (`proposalsJson: displayed`) et s'est mis à
 * conserver le jeu COMPLET — **pour toutes les règles**. Or ce qui est stocké
 * porte, ailleurs, une sémantique propre : sur la règle `LINK-ASSET` (« À quel
 * bien rattacher ce document ? »), c'est « les candidats que la carte a
 * retenus », et `buildAssetLinkChoices` marque `suggested: true` tout candidat
 * stocké qui reste un bien éligible. Un candidat que la carte avait justement
 * écarté par la borne d'affichage redevenait donc « suggéré » — alors que la
 * carte #836 impose, mot pour mot, « AUCUNE autre carte ne change ».
 *
 * LA CORRECTION
 *
 * `storedProposals` : jeu COMPLET pour les seules règles qui déclarent une
 * exception d'affichage (`DISPLAYED_PROPOSALS_MAX_BY_RULE`) ; stockage
 * EXACTEMENT antérieur pour toutes les autres.
 *
 *   C836-R3-01  règle d'attribut : les 13+ valeurs réelles restent conservées
 *               ET paginées (l'écart E06 reste fermé)
 *   C836-R3-02  CONTRE-EXEMPLE — rattachement d'un document : le candidat
 *               écarté par la borne ne redevient pas « suggéré »
 *   C836-R3-03  les autres règles retrouvent exactement leur stockage d'avant
 * Tests purs (aucune base, aucune IA).
 */
import { describe, expect, it } from 'vitest';
import {
  DISPLAYED_PROPOSALS_MAX, DISPLAYED_PROPOSALS_MAX_BY_RULE, overflowProposals, selectDisplayedProposals,
  storedProposals, type ActionProposal,
} from '../action-model';
import { buildAssetLinkChoices } from '../asset-link-choices';

const proposition = (value: string, confidence: number, isCurrentValue = false): ActionProposal =>
  ({ value, label: value, confidence, ...(isCurrentValue ? { isCurrentValue: true } : {}) }) as ActionProposal;

/** `n` valeurs réelles d'une contradiction d'attribut, par confiance décroissante. */
const attributs = (n: number) => Array.from({ length: n }, (_, i) =>
  proposition(`ATTRIBUTE:2026-03-${String(i + 1).padStart(2, '0')}`, 1 - i / 100));

describe('C836-R3-01 — règle d’attribut : l’écart E06 reste fermé', () => {
  it('les treize valeurs réelles sont CONSERVÉES, et la lecture les pagine toutes', () => {
    const toutes = attributs(13);
    const conservees = storedProposals(toutes, 'OPERATION-ATTRIBUTE');
    // Rien n'est tronqué à l'écriture : la treizième valeur existe encore après l'enregistrement.
    expect(conservees).toHaveLength(13);
    // …et elle reste atteignable : première page d'affichage, puis la suite.
    const page = selectDisplayedProposals(conservees, 'OPERATION-ATTRIBUTE');
    const suite = overflowProposals(conservees, 'OPERATION-ATTRIBUTE');
    expect(page).toHaveLength(DISPLAYED_PROPOSALS_MAX_BY_RULE['OPERATION-ATTRIBUTE']);
    expect([...page, ...suite].map((p) => p.value)).toEqual(toutes.map((p) => p.value));
    expect(suite.map((p) => p.value)).toContain('ATTRIBUTE:2026-03-13');
  });

  it('la valeur en place protégée reste conservée avec les alternatives', () => {
    const toutes = [...attributs(13), proposition('ATTRIBUTE:actuelle', 0, true)];
    expect(storedProposals(toutes, 'OPERATION-ATTRIBUTE')).toHaveLength(14);
  });
});

describe('C836-R3-02 — rattachement d’un document : aucune autre carte n’est remuée', () => {
  /**
   * CONTRE-EXEMPLE, repris du scénario de recette L113A-E2E-02 : trois candidats, dont l'un (le studio
   * archivé, confiance 0,8) n'est plus éligible. La carte ne retient que les DEUX meilleurs — l'archivé et
   * Maison (0,7) — donc Peugeot (0,4) redevient un bien « autre ». Avec le jeu complet stocké, Peugeot
   * réapparaissait « suggéré ».
   */
  it('le candidat écarté par la borne d’affichage ne redevient PAS « suggéré »', () => {
    const MAISON = 11; const PEUGEOT = 12; const APPART = 13; const ARCHIVE = 14;
    const candidats = [
      proposition(String(PEUGEOT), 0.4), proposition(String(MAISON), 0.7), proposition(String(ARCHIVE), 0.8),
    ];
    const eligibles = [{ id: APPART, name: 'Appartement' }, { id: MAISON, name: 'Maison' }, { id: PEUGEOT, name: 'Peugeot 3008' }];

    const conservees = storedProposals(candidats, 'LINK-ASSET');
    expect(conservees.map((p) => p.value)).toEqual([String(ARCHIVE), String(MAISON)]);
    expect(buildAssetLinkChoices(conservees, eligibles).items.map((i) => [i.assetId, i.suggested])).toEqual([
      [MAISON, true], [APPART, false], [PEUGEOT, false],
    ]);

    // Ce que faisait la régression, et que ce cas interdit : le jeu COMPLET resuggère le candidat écarté.
    expect(buildAssetLinkChoices(candidats, eligibles).items.map((i) => [i.assetId, i.suggested])).toEqual([
      [MAISON, true], [PEUGEOT, true], [APPART, false],
    ]);
  });
});

describe('C836-R3-03 — stockage antérieur des règles sans exception déclarée', () => {
  it('une règle quelconque conserve EXACTEMENT ses propositions affichées', () => {
    const toutes = attributs(6);
    for (const regle of ['LINK-ASSET', 'ASSET-FIELD', 'DOCUMENT-DATA', null]) {
      expect(DISPLAYED_PROPOSALS_MAX_BY_RULE[regle ?? ''], regle ?? 'sans règle').toBeUndefined();
      expect(storedProposals(toutes, regle), regle ?? 'sans règle').toEqual(selectDisplayedProposals(toutes, regle));
      expect(storedProposals(toutes, regle)).toHaveLength(DISPLAYED_PROPOSALS_MAX);
      // Et aucune « suite » n'est rendue pour elles : rien à dérouler, rien de perdu non plus.
      expect(overflowProposals(toutes, regle)).toEqual([]);
    }
  });

  it('le point d’écriture unique conserve le jeu rendu par `storedProposals`', async () => {
    const { readFileSync } = await import('node:fs');
    const svc = readFileSync('src/services/to-process/to-process-action.service.ts', 'utf8');
    // Le jeu écrit est celui de la portée (jamais la page d'affichage, jamais le jeu complet sans condition).
    expect(svc).toMatch(/const proposals = storedProposals\(reelles, input\.ruleCode\);/);
    expect(svc).not.toMatch(/proposalsJson: displayed/);
    expect(svc).not.toMatch(/proposalsJson: reelles/);
  });
});
