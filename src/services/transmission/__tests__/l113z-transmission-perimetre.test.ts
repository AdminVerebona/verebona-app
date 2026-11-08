/**
 * Lot 113Z — sécurité : périmètre d'une transmission par jeton (isolation des comptes).
 *
 *   L113Z-SEC-U01  identifiants nettoyés (entiers positifs, dédoublonnés) ;
 *   L113Z-SEC-U02  sélection restreinte aux identifiants autorisés ; sélection non vide entièrement
 *                  étrangère → rien (jamais « tout l'instantané ») ;
 *   L113Z-SEC-U03  filtrage par compte ET bien (SQL), trace sans identifiant ; appliqué à la création ET à l'acceptation.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const unsafe = vi.hoisted(() => vi.fn());
vi.mock('@/db', () => ({ db: {}, pgClient: { unsafe } }));

const m = await import('../transmission-scope');
const lire = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');

describe('L113Z-SEC-U01/U02 — fonctions pures', () => {
  it('identifiants nettoyés', () => {
    expect(m.cleanIds([3, '4', 3, -1, 0, 1.5, 'x', null, '5; DROP'])).toEqual([3, 4]);
    expect(m.cleanIds('1,2')).toEqual([]);
  });
  it('restreint à l’autorisé ; tout étranger → inclusion coupée', () => {
    expect(m.restrictSelection(true, [1, 2, 3], new Set([1, 3]))).toEqual({ include: true, ids: [1, 3], dropped: 1 });
    expect(m.restrictSelection(true, [9], new Set())).toEqual({ include: false, ids: [], dropped: 1 });
    // Sélection vide d'origine : sens historique (« tout le contenu du bien », lu dans l'instantané serveur).
    expect(m.restrictSelection(true, [], new Set())).toEqual({ include: true, ids: [], dropped: 0 });
    expect(m.restrictSelection(false, [1], new Set([1]))).toEqual({ include: false, ids: [1], dropped: 0 });
  });
});

describe('L113Z-SEC-U03 — compte et bien vérifiés, trace sans identifiant', () => {
  it('seuls les éléments du compte ET du bien sont conservés', async () => {
    unsafe.mockReset();
    unsafe.mockImplementation(async (text: string, params: unknown[]) => {
      expect(params[0]).toBe(7); // compte émetteur
      expect(params[1]).toBe(70); // bien transmis
      if (text.includes('FROM asset_files')) {
        expect(text).toMatch(/f\.account_id = \$1/);
        expect(text).toMatch(/a\.account_id = \$1/);
        expect(text).toMatch(/substructure_id IN|equipment_id IN/);
        return [{ id: 1 }, { id: 2 }];
      }
      if (text.includes('FROM agenda_items')) { expect(text).toMatch(/i\.account_id = \$1/); return [{ id: 10 }]; }
      if (text.includes('FROM equipments')) return [];
      throw new Error(text);
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { selection, dropped } = await m.scopeTransmissionSelection(7, 70, {
      includeDocuments: true, selectedDocIds: [1, 999],
      includePhotos: true, selectedPhotoIds: [2, 888],
      includeEvents: true, selectedEventIds: [10, 777],
      includeEquipments: true, selectedEquipmentIds: [555],
    }, 'acceptation');
    expect(selection).toMatchObject({
      selectedDocIds: [1], selectedPhotoIds: [2], selectedEventIds: [10], selectedEquipmentIds: [], includeEquipments: false,
      includeDocuments: true, includePhotos: true, includeEvents: true,
    });
    expect(dropped).toEqual({ documents: 1, photos: 1, events: 1, equipments: 1 });
    const trace = warn.mock.calls.map((c) => String(c[0])).join(' ');
    expect(trace).toMatch(/4 élément\(s\)/);
    for (const id of ['999', '888', '777', '555']) expect(trace).not.toContain(id);
    warn.mockRestore();
  });
  it('appliqué à la création et à l’acceptation ; requêtes d’acceptation bornées au compte émetteur', () => {
    const creation = lire('src/app/api/assets/[id]/transmission/route.ts');
    expect(creation).toMatch(/scopeTransmissionSelection\(accountId, assetId, selectedPayloadDemande, 'creation'\)/);
    const acceptation = lire('src/app/api/transmission/[token]/route.ts');
    expect(acceptation).toMatch(/scopeTransmissionSelection\(row\.accountId, row\.assetId, selected, 'acceptation'\)/);
    expect(acceptation.match(/eq\(assetFiles\.accountId, row\.accountId\)/g)).toHaveLength(2);
    expect(acceptation).toMatch(/eq\(agendaItems\.accountId, row\.accountId\)/);
    // Anti-énumération : aucun message ne mentionne un élément écarté.
    expect(acceptation).not.toMatch(/FOREIGN|hors périmètre.*NextResponse/);
  });
});
