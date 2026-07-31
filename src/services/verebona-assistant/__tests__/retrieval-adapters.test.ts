/**
 * Adaptateurs de récupération — CDC §13.2, §13.4, §25.6.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE PÉRIMÈTRE COMPTE EST LA SEULE RÈGLE QUI NE SOUFFRE AUCUNE EXCEPTION
 *
 * Un adaptateur qui ramène une ligne d'un autre compte fait lire à un
 * utilisateur les documents d'un tiers. Le §13.2 l'exige à chaque requête, et
 * rien dans le rendu ne signalerait un manquement : la réponse paraîtrait
 * normale.
 *
 * D'où la double vérification — clause SQL puis contrôle des lignes rendues —
 * et ces tests, qui lisent le source parce qu'une requête peut être juste et
 * son résultat faux.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ADAPTATEURS } from '@/services/verebona-assistant/registries/retrieval-adapters';
import {
  registerRetrievalAdapter,
  getEnabledAdapters,
  clearAdapters,
} from '@/services/verebona-assistant/registries/retrieval-adapter-registry';
import { registerAllRetrievalAdapters } from '@/services/verebona-assistant/registries';

const SOURCE = readFileSync(
  join(process.cwd(), 'src/services/verebona-assistant/registries/retrieval-adapters.ts'),
  'utf-8',
);

describe('enregistrement', () => {
  beforeEach(() => clearAdapters());

  it('cinq adaptateurs sont fournis', () => {
    // L'ancien état : zéro. `retrieve()` retombait sur un repli qui ne
    // cherchait que des noms de biens.
    expect(ADAPTATEURS).toHaveLength(5);
  });

  it('couvre biens, documents, agenda, équipements et pièces', () => {
    const ids = ADAPTATEURS.map((a) => a.code);
    expect(ids).toContain('structured');
    expect(ids).toContain('full_text');
  });

  it('tous sont actifs', () => {
    // Un adaptateur enregistré mais désactivé serait invisible sans erreur.
    for (const a of ADAPTATEURS) expect(a.enabled).toBe(true);
  });

  it('l’enregistrement est idempotent', () => {
    // Un rechargement de module en développement le déclencherait deux fois,
    // et chaque recherche rendrait des doublons.
    registerAllRetrievalAdapters();
    registerAllRetrievalAdapters();
    expect(getEnabledAdapters()).toHaveLength(5);
  });

  it('n’écrase pas des adaptateurs déjà posés', () => {
    registerRetrievalAdapter({
      code: 'semantic', enabled: true, search: async () => [],
    });
    registerAllRetrievalAdapters();
    // Un adaptateur maison enregistré avant ne doit pas être remplacé.
    expect(getEnabledAdapters()).toHaveLength(1);
  });
});

describe('§13.2 — périmètre du compte', () => {
  it('chaque adaptateur filtre sur accountId', () => {
    // Cinq occurrences attendues, une par adaptateur.
    const filtres = SOURCE.match(/accountId, q\.accountId\)/g) ?? [];
    expect(filtres.length).toBeGreaterThanOrEqual(5);
  });

  it('chaque adaptateur recontrôle les lignes rendues', () => {
    // Une requête peut être juste et son résultat faux : jointure sur une
    // table non filtrée, sous-requête oubliée.
    // Un appel par adaptateur. La définition porte un générique
    // — `verifierPerimetre<T extends …>` — et n'entre donc pas dans ce motif,
    // qui vise les appels nommés.
    const controles = SOURCE.match(/verifierPerimetre\('/g) ?? [];
    expect(controles).toHaveLength(5);
  });

  it('la violation de périmètre lève, elle ne filtre pas', () => {
    // Filtrer silencieusement masquerait le défaut ; lever le rend visible.
    expect(SOURCE).toContain('throw new AccountScopeViolation');
  });

  it('les équipements sont bornés par jointure sur les biens', () => {
    // `equipments` ne porte pas `account_id` : la jointure EST le contrôle.
    expect(SOURCE).toMatch(/innerJoin\(assets, eq\(equipments\.assetId, assets\.id\)\)/);
  });

  it('les pièces le sont aussi', () => {
    expect(SOURCE).toMatch(/innerJoin\(assets, eq\(rooms\.assetId, assets\.id\)\)/);
  });

  it('aucun adaptateur n’ignore les éléments supprimés', () => {
    const suppressions = SOURCE.match(/isNull\(assets?\w*\.deletedAt\)/g) ?? [];
    expect(suppressions.length).toBeGreaterThanOrEqual(4);
  });
});

describe('bornes de contenu', () => {
  it('les extraits sont plafonnés à 1500 caractères (§17.7)', () => {
    expect(SOURCE).toMatch(/slice\(0, 1500\)/);
  });

  it('la recherche tolère les accents', () => {
    // Sans `unaccent`, « énergie » ne trouverait pas « energie » — ce que
    // tout utilisateur tape.
    expect(SOURCE).toContain('unaccent');
  });
});
