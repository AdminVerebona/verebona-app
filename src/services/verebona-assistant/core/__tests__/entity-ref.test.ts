/**
 * CDC §19.2 et §22.7 — décodage des identifiants de sources et routes internes.
 *
 * Ces tests encadrent deux régressions qui se ressemblent mais n'ont pas la
 * même gravité :
 *   · un identifiant préfixé transmis tel quel à une requête SQL — l'action
 *     disparaît silencieusement, personne ne le voit passer ;
 *   · une URL construite sur une route qui n'existe pas — l'utilisateur
 *     clique et tombe sur une page absente.
 *
 * Les deux se corrigent au même endroit, donc se testent au même endroit.
 */
import { describe, it, expect } from 'vitest';
import { parseEntityRef, hrefEntite, hrefSource, hrefBien, ROUTES } from '../entity-ref';

describe('parseEntityRef — décodage des identifiants de sources', () => {
  it('décode les cinq préfixes émis par les adaptateurs', () => {
    expect(parseEntityRef('asset_42')).toEqual({ kind: 'asset', id: 42, sourceId: 'asset_42' });
    expect(parseEntityRef('doc_128')).toEqual({ kind: 'document', id: 128, sourceId: 'doc_128' });
    expect(parseEntityRef('agenda_9')).toEqual({ kind: 'agenda_item', id: 9, sourceId: 'agenda_9' });
    expect(parseEntityRef('equipment_7')?.kind).toBe('equipment');
    expect(parseEntityRef('room_3')?.kind).toBe('room');
  });

  it("expose un identifiant NUMÉRIQUE, jamais la chaîne préfixée", () => {
    // C'est le cœur de la régression : « asset_42 » injecté dans un
    // `WHERE id = $1` sur une colonne entière fait échouer la requête, donc
    // refuser l'action.
    const ref = parseEntityRef('asset_42');
    expect(typeof ref?.id).toBe('number');
    expect(ref?.id).toBe(42);
  });

  it('refuse ce qui ressemble à un identifiant sans en être un', () => {
    expect(parseEntityRef('asset_')).toBeNull();
    expect(parseEntityRef('asset_0')).toBeNull();         // pas d'id 0 en base
    expect(parseEntityRef('asset_-1')).toBeNull();
    expect(parseEntityRef('asset_4e2')).toBeNull();       // Number() l'accepterait
    expect(parseEntityRef('asset_0x2a')).toBeNull();
    expect(parseEntityRef('asset_42abc')).toBeNull();
    expect(parseEntityRef('inconnu_5')).toBeNull();
    expect(parseEntityRef('')).toBeNull();
    expect(parseEntityRef(null)).toBeNull();
  });

  it("n'accepte un identifiant nu que si l'appelant annonce le type attendu", () => {
    // Un `assetId` venant du contexte de page (§27.1) arrive sans préfixe.
    expect(parseEntityRef('42')).toBeNull();
    expect(parseEntityRef('42', 'asset')).toEqual({ kind: 'asset', id: 42, sourceId: '42' });
    expect(parseEntityRef(42, 'asset')?.id).toBe(42);
  });

  it('refuse une cible dont le type ne correspond pas à ce qui est attendu', () => {
    // Sans ce contrôle, un identifiant de document autorise l'ouverture d'un
    // bien portant le même numéro.
    expect(parseEntityRef('doc_42', 'asset')).toBeNull();
    expect(parseEntityRef('asset_42', 'asset')).not.toBeNull();
  });
});

describe('hrefEntite — les URLs pointent vers des routes qui existent', () => {
  it('ouvre un bien et un document sur leur page de détail', () => {
    expect(hrefEntite(parseEntityRef('asset_42')!)).toBe('/assets/42');
    expect(hrefEntite(parseEntityRef('doc_128')!)).toBe('/documents/128');
  });

  it("renvoie l'agenda pour une échéance, faute de page de détail", () => {
    // `/agenda/[id]` n'existe pas dans `src/app` : le détail s'ouvre dans un
    // tiroir. Produire `/agenda/9` fabriquerait un lien mort.
    expect(hrefEntite(parseEntityRef('agenda_9')!)).toBe('/agenda');
    expect(hrefEntite(parseEntityRef('agenda_9')!)).not.toContain('/agenda/9');
  });

  it('ouvre le bien parent, sur le bon onglet, pour un équipement ou une pièce', () => {
    const equip = parseEntityRef('equipment_7')!;
    const piece = parseEntityRef('room_3')!;
    expect(hrefEntite(equip, { assetId: 42 })).toBe('/assets/42?tab=equipments');
    expect(hrefEntite(piece, { assetId: 42 })).toBe('/assets/42?tab=rooms');
  });

  it("ne produit rien quand le bien parent est absent des métadonnées", () => {
    expect(hrefEntite(parseEntityRef('equipment_7')!, {})).toBeNull();
    expect(hrefEntite(parseEntityRef('room_3')!, { assetId: null })).toBeNull();
  });

  it('utilise le paramètre `tab`, seul lu par la fiche bien', () => {
    // La page lit `searchParams.get('tab')`. Le paramètre historique `onglet`
    // n'a jamais eu d'effet.
    expect(hrefBien(42, 'exports')).toBe('/assets/42?tab=exports');
    expect(hrefBien(42, 'overview')).toBe('/assets/42');
    expect(hrefBien(42)).toBe('/assets/42');
  });

  it('pointe « À traiter » et « Mon compte » sur leurs routes réelles', () => {
    expect(ROUTES.A_TRAITER).toBe('/accueil/a-traiter');
    expect(ROUTES.COMPTE).toBe('/mon-compte');
  });
});

describe('hrefSource — raccourci pour les instantanés relus en base', () => {
  it('reconstruit le lien à partir du seul identifiant conservé', () => {
    expect(hrefSource('doc_128')).toBe('/documents/128');
  });

  it('renvoie null sur un identifiant illisible plutôt qu\'un lien approximatif', () => {
    expect(hrefSource('help_faq')).toBeNull();
    expect(hrefSource('')).toBeNull();
  });
});
