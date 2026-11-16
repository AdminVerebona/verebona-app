/**
 * Lot 114Y (Trello #753, CDC T2 §7.6, §8.4 exemple E, §12.4 — D24, D25, M14) — SOURCES SUR DEMANDE.
 *
 *   S01  reconnaissance : seule une demande de PROVENANCE de la réponse précédente ; toute autre phrase suit le
 *        parcours normal ;
 *   S02  les éléments présentés sont ceux que les affirmations de la réponse précédente citent (à défaut, ceux
 *        de la réponse), dans l'ordre enregistré, dédoublonnés, bornés ; jamais un article d'aide ;
 *   S03  élément supprimé ou inaccessible : annoncé, sans lien ; liens construits par le serveur ;
 *   S04  aucune source : c'est dit ; aucune réponse précédente : la demande suit le parcours normal ;
 *   S05  par défaut, rien ne change : pas de bouton « Voir les sources » dans l'espace de réponse.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) }, db: {} }));

const { isSourceRequest, discloseSources, disclosureMessage, NO_SOURCE_MESSAGE, MAX_DISCLOSED_SOURCES } = await import('../../source-disclosure');
type Stored = import('../../source-disclosure').StoredAnswerSource;
type Deps = import('../../source-disclosure').SourceDisclosureDeps;

const src = (over: Partial<Stored>): Stored => ({
  sourceType: 'document', sourceId: 'doc_12', title: 'Facture Norauto', excerpt: 'Total TTC 120 €', linkedAssetLabel: 'Clio',
  usefulDate: '2025-03-12', statusLabel: null, cited: false, ...over,
});
const deps = (sources: Stored[] | null, morts: string[] = []): Deps => ({
  async loadPreviousAnswerSources() { return sources === null ? null : { messageId: 5, sources }; },
  async unavailableIds() { return new Set(morts); },
});
const fil = { accountId: 1, userId: 2, conversationId: 3 };
const cartes = (r: Awaited<ReturnType<typeof discloseSources>>) => (r?.resultGroups ?? []).flatMap((g) => g.items);

describe('L114Y-S01 — reconnaissance d’une demande de provenance', () => {
  it.each([
    'D’où vient ce chiffre ?',
    'D\'où vient cette information ?',
    'D’où ça vient ?',
    'd\'ou provient cette date',
    'D’où sort ce montant ?',
    'Et d’où vient ce chiffre, stp ?',
    'Quelle est la source ?',
    'Quelles sont tes sources ?',
    'Source ?',
    'Tes sources ?',
    'Sur quel document te bases-tu ?',
    'Sur quoi vous basez-vous ?',
    'Comment le sais-tu ?',
    'Montre-moi la source',
    'Montre le justificatif',
    'Montre la facture',
    'Affiche la preuve',
    'D’où tiens-tu ça ?',
  ])('« %s »', (phrase) => {
    expect(isSourceRequest(phrase)).toBe(true);
  });

  it.each([
    'Montre la facture EDF',
    'Montre-moi les documents de la Clio',
    'D’où vient ma voiture ?',
    'Quelle est la source d’énergie de la maison ?',
    'Combien m’a coûté mon vélo ?',
    'Quel est le montant de la facture Norauto ?',
    'Ajoute une source',
    'Comment ajouter un justificatif ?',
    'Supprime le justificatif',
    'Je voudrais savoir d’où vient ce chiffre et combien j’ai payé au total pour la Clio depuis son achat',
    '',
  ])('« %s » n’est pas une demande de provenance', (phrase) => {
    expect(isSourceRequest(phrase)).toBe(false);
  });
});

describe('L114Y-S02 — éléments présentés', () => {
  it('seuls les éléments CITÉS par les affirmations de la réponse précédente (exemple E : pas un autre contrat au nom voisin)', async () => {
    const r = await discloseSources(fil, deps([
      src({ sourceId: 'doc_12', title: 'Contrat d’assurance 2026', cited: true }),
      src({ sourceId: 'doc_13', title: 'Contrat d’assurance 2024', cited: false }),
    ]));
    expect(cartes(r).map((c) => c.title)).toEqual(['Contrat d’assurance 2026']);
    expect(r!.message).toBe('Voici l’élément de votre compte sur lequel s’appuie la réponse précédente.');
    expect(r!.count).toBe(1);
  });

  it('carte : titre, bien lié, date, lien construit par le serveur vers le document', async () => {
    const r = await discloseSources(fil, deps([src({ cited: true })]));
    expect(cartes(r)[0]).toMatchObject({ id: 'doc_12', typeLabel: 'Document', title: 'Facture Norauto', subtitle: 'Clio', date: '2025-03-12' });
    expect(cartes(r)[0].href).toMatch(/^\/[^/]/);
    expect(cartes(r)[0].href).toContain('document');
  });

  it('aucune affirmation citée : les éléments de la réponse, dans l’ordre enregistré', async () => {
    const r = await discloseSources(fil, deps([
      src({ sourceId: 'doc_1', title: 'A' }), src({ sourceId: 'doc_2', title: 'B' }), src({ sourceType: 'agenda_item', sourceId: 'agenda_9', title: 'Vidange' }),
    ]));
    expect(cartes(r).map((c) => c.title)).toEqual(['A', 'B', 'Vidange']);
    expect(r!.message).toBe('Voici les 3 éléments de votre compte sur lesquels s’appuie la réponse précédente.');
  });

  it('champ d’une fiche : la fiche du bien, sur le champ concerné', async () => {
    const r = await discloseSources(fil, deps([src({ sourceType: 'asset_field', sourceId: 'asset_field:7:acquisitionPrice', title: 'Prix d’achat — Clio', cited: true })]));
    expect(cartes(r)[0]).toMatchObject({ typeLabel: 'Bien' });
    expect(cartes(r)[0].href).toBe('/assets/7?tab=details&highlight=acquisitionPrice');
  });

  it('un même élément cité deux fois n’apparaît qu’une fois ; article d’aide et règle d’offre jamais présentés', async () => {
    const r = await discloseSources(fil, deps([
      src({ cited: true }), src({ cited: true }),
      src({ sourceType: 'help_entry', sourceId: 'help_3', title: 'Ajouter un document', cited: true }),
      src({ sourceType: 'product_rule', sourceId: 'rule_1', title: 'Offre', cited: true }),
    ]));
    expect(cartes(r).map((c) => c.id)).toEqual(['doc_12']);
  });

  it(`au plus ${MAX_DISCLOSED_SOURCES} éléments ; les autres sont annoncés`, async () => {
    const r = await discloseSources(fil, deps(Array.from({ length: 7 }, (_, i) => src({ sourceId: `doc_${i + 1}`, title: `Facture ${i + 1}`, cited: true }))));
    expect(cartes(r)).toHaveLength(5);
    expect(r!.message).toBe('Voici les 5 éléments de votre compte sur lesquels s’appuie la réponse précédente. 2 autres éléments ont également été consultés.');
    expect(disclosureMessage(1, 1)).toBe('Voici l’élément de votre compte sur lequel s’appuie la réponse précédente. Un autre élément a également été consulté.');
  });
});

describe('L114Y-S03 — élément supprimé ou inaccessible', () => {
  it('annoncé sans lien ; les autres gardent leur lien', async () => {
    const r = await discloseSources(fil, deps([src({ sourceId: 'doc_1', title: 'A', cited: true }), src({ sourceId: 'doc_2', title: 'B', cited: true })], ['doc_1']));
    const [a, b] = cartes(r);
    expect(a).toMatchObject({ title: 'A', href: null, status: 'N’est plus disponible' });
    expect(b.href).not.toBeNull();
  });

  it('vérification impossible : les éléments restent présentés', async () => {
    const r = await discloseSources(fil, { ...deps([src({ cited: true })]), async unavailableIds() { throw new Error('base indisponible'); } });
    expect(cartes(r)).toHaveLength(1);
  });
});

describe('L114Y-S04 — rien à montrer', () => {
  it('réponse précédente sans élément du compte : c’est dit, aucune carte', async () => {
    expect(await discloseSources(fil, deps([]))).toEqual({ message: NO_SOURCE_MESSAGE, resultGroups: [], count: 0 });
    expect(await discloseSources(fil, deps([src({ sourceType: 'help_entry', sourceId: 'help_3' })]))).toEqual({ message: NO_SOURCE_MESSAGE, resultGroups: [], count: 0 });
    expect(NO_SOURCE_MESSAGE).toBe('Je n’ai pas de source à vous montrer pour la réponse précédente.');
  });

  it('aucune réponse précédente dans le fil : null (parcours normal)', async () => {
    expect(await discloseSources(fil, deps(null))).toBeNull();
  });
});

describe('L114Y-S05 — par défaut, rien ne change', () => {
  const lire = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

  it('l’espace de réponse écarte toujours l’action « Voir les sources »', () => {
    expect(lire('src/components/verebona/space/SpaceContent.tsx')).toContain("filter((a) => a.type !== 'SHOW_SOURCES')");
  });

  it('la demande de provenance est traitée avant la résolution des références du fil, jamais à la reprise d’une clarification', () => {
    const orchestrateur = lire('src/services/verebona-assistant/core/assistant-orchestrator.service.ts');
    const demande = orchestrateur.indexOf('isSourceRequest(input.message)');
    expect(demande).toBeGreaterThan(0);
    expect(demande).toBeLessThan(orchestrateur.indexOf('const early = await applyThreadMemory(input, ports, trace);'));
    expect(orchestrateur.slice(demande - 200, demande)).toContain('!input.resume');
  });

  it('flag des sources coupé : rien n’est exposé', () => {
    expect(lire('src/services/verebona-assistant/core/ports.ts')).toMatch(/discloseSources: async \(input\) => \{\s*if \(!input\.conversationId \|\| !isAssistantFlagOn\('sources'\)\) return null;/);
  });
});
