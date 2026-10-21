/**
 * Lot 75N — BO « Données du compte » : modèle PUR (états des valeurs,
 * masquage, sérialiseurs texte / JSON / CSV, nommage, liens profonds).
 */
import { describe, expect, it } from 'vitest';
import {
  CATEGORIES, CATEGORY_TYPES, absent, cellState, columnField, csvCell, dossierToCsv, dossierToJson, dossierToText, entityRef,
  exportFileName, fieldCopyText, formatColumn, formatMinor, isMarker, maskDeep, maskRow, masked, notLoaded, parseEntityRef,
  rawText, rowFields, sectionToCsv, type EntityDossier,
} from '../model';
import { pushHistory } from '@/app/admin/accounts/[id]/_components/account-data/EntityDrawer';

const LONG = 'x'.repeat(50_000);

function dossier(): EntityDossier {
  return {
    schema: 'verebona.bo.donnees-compte/1', extractedAt: '2026-10-20T08:15:00.000Z', accountId: 123,
    entity: { type: 'equipment', typeLabel: 'Équipement', id: 456, table: 'equipments', name: 'Robot aspirateur Roborock S8 Pro Ultra', status: 'EN_SERVICE', statusLabel: 'EN_SERVICE' },
    complete: true, warnings: [],
    sections: [
      { id: 'identite', tab: 'synthese', title: 'Identité', fields: [
        columnField('equipments', 'purchase_price_cents', 116583, undefined, 'Prix d’achat — colonne miroir'),
        columnField('equipments', 'estimated_value_cents', null, undefined, 'Valeur estimée'),
        columnField('equipments', 'mileage', 0, undefined, 'Zéro'),
        columnField('equipments', 'inexistante', undefined, undefined, 'Colonne absente'),
        columnField('asset_files', 'filename', masked('nom du fichier original'), undefined, 'Nom du fichier'),
        columnField('equipments', 'notes', LONG, undefined, 'Longue valeur'),
      ] },
      { id: 'rel', tab: 'relations', title: 'Relations', relations: [
        { type: 'document', id: 789, label: 'Facture d’acquisition', nature: 'source de preuves', status: 'ANALYZED', origin: 'DOCUMENT_EXTRACTION', via: 'field_evidence.source_id' },
      ] },
      { id: 'evidence', tab: 'preuves', title: 'Preuves', table: {
        table: 'field_evidence', columns: ['id', 'value_json', 'raw_value', 'evidence_excerpt', 'excerpt_long'], total: 1, complete: true, limit: 2000,
        rows: [{ id: 11, value_json: { amount: 1399, unit: 'EUR' }, raw_value: '1 399,00 € TTC; "total"', evidence_excerpt: null, excerpt_long: notLoaded('borne') }],
      } },
    ],
  };
}

describe('L75N-U01 états des valeurs : absent, NULL, 0, non chargé, masqué', () => {
  it('distingue les cinq états sans jamais confondre absent / masqué avec NULL', () => {
    expect(cellState(undefined)).toBe('absent');
    expect(cellState(null)).toBe('null');
    expect(cellState(0)).toBe('value');
    expect(cellState('')).toBe('value');
    expect(cellState(false)).toBe('value');
    expect(cellState(masked('secret'))).toBe('masked');
    expect(cellState(notLoaded())).toBe('not_loaded');
    expect(cellState(absent())).toBe('absent');
    const [prix, nul, zero, abs, masq] = dossier().sections[0].fields!;
    expect(prix).toMatchObject({ state: 'value', raw: 116583, display: '1 165,83 €', unit: 'centimes EUR' });
    expect(nul).toMatchObject({ state: 'null', raw: null });
    expect(zero).toMatchObject({ state: 'value', raw: 0 });
    expect(abs.state).toBe('absent');
    expect('raw' in abs).toBe(false);
    expect(masq.state).toBe('masked');
    expect('raw' in masq).toBe(false);
  });
  it('un objet JSON métier n’est pas pris pour un marqueur', () => {
    expect(isMarker({ $etat: 'masque' })).toBe(true);
    expect(isMarker({ etat: 'masque' })).toBe(false);
    expect(isMarker({ $etat: 'autre' })).toBe(false);
  });
});

describe('L75N-U02 masquage : secrets, clés de stockage, fichier original, données sensibles', () => {
  it('maskRow masque les colonnes interdites et garde NULL pour NULL', () => {
    const r = maskRow({
      id: 1, s3_key: 'acc/1/f.pdf', s3_bucket: 'b', filename: 'facture-dupont.pdf', original_filename: null, web_link_url: 'https://x',
      thumbnail_url: 'https://cdn/x.png', extracted_text: 'abc', api_token: 'tok', amount_cents: 139900, metadata: { iban: 'FR76...', note: 'ok' },
      notes: 'RIB FR76 3000 6000 0112 3456 7890 189',
    });
    expect(r.s3_key).toEqual({ $etat: 'masque', motif: 'clé de stockage' });
    expect(r.filename).toEqual({ $etat: 'masque', motif: 'nom du fichier original' });
    expect(r.original_filename).toBeNull();
    expect(cellState(r.web_link_url)).toBe('masked');
    expect(cellState(r.thumbnail_url)).toBe('masked');
    expect(r.extracted_text).toEqual({ $etat: 'masque', motif: 'contenu intégral du document', longueur: 3 });
    expect(cellState(r.api_token)).toBe('masked');
    expect(r.amount_cents).toBe(139900);
    expect((r.metadata as Record<string, unknown>).iban).toMatchObject({ $etat: 'masque' });
    expect(String(r.notes)).not.toContain('0112 3456');
  });
  it('clé canonique sensible : valeurs de la ligne de preuve masquées ; fiche JSON masquée par clé', () => {
    const isSensitiveKey = (k: string) => k === 'address1';
    const ev = maskRow({ id: 2, field_key: 'address1', value_json: '12 rue X', raw_value: '12 rue X', status: 'active' }, { isSensitiveKey });
    expect(cellState(ev.value_json)).toBe('masked');
    expect(cellState(ev.raw_value)).toBe('masked');
    expect(ev.status).toBe('active');
    const kc = maskDeep({ address1: '12 rue X', address1__origin: 'USER', acquisitionPrice: 1399 }, { isSensitiveKey }) as Record<string, unknown>;
    expect(cellState(kc.address1)).toBe('masked');
    expect(kc.address1__origin).toBe('USER');
    expect(kc.acquisitionPrice).toBe(1399);
  });
});

describe('L75N-U03 sérialiseurs : même structure, sans troncature, valides', () => {
  it('JSON valide, fidèle (valeur brute, unités, marqueurs, horodatage)', () => {
    const d = dossier();
    const parsed = JSON.parse(dossierToJson(d));
    expect(parsed).toEqual(JSON.parse(JSON.stringify(d)));
    expect(parsed.extractedAt).toBe('2026-10-20T08:15:00.000Z');
    expect(parsed.sections[0].fields[0]).toMatchObject({ raw: 116583, unit: 'centimes EUR' });
    expect(parsed.sections[0].fields[5].raw).toHaveLength(50_000);
  });
  it('texte lisible : sections identifiées, valeurs brutes et affichées, longues valeurs intégrales', () => {
    const t = dossierToText(dossier());
    expect(t).toContain('Équipement #456 — Robot aspirateur Roborock S8 Pro Ultra');
    expect(t).toContain('Extraction : 2026-10-20T08:15:00.000Z');
    expect(t).toContain('######## Synthèse ########');
    expect(t).toContain('######## Relations ########');
    expect(t).toContain('######## Preuves et historique ########');
    expect(t).toContain('- Prix d’achat — colonne miroir [equipments.purchase_price_cents] : brut=116583 | affiché=1 165,83 € | unité=centimes EUR');
    expect(t).toContain('[equipments.estimated_value_cents] : brut=NULL');
    expect(t).toContain('- Colonne absente [equipments.inexistante] : état=absent');
    expect(t).toContain('état=masqué | note=nom du fichier original');
    expect(t).toContain(LONG);
    expect(t).toContain('Document #789 « Facture d’acquisition »');
    expect(t).toContain('value_json={"amount":1399,"unit":"EUR"}');
    expect(t).toContain('excerpt_long=[non chargé : borne]');
  });
  it('signale explicitement une extraction incomplète', () => {
    const d = { ...dossier(), complete: false, warnings: ['Section « Preuves » : 2000 ligne(s) extraite(s) sur 2500 (borne 2000).'] };
    expect(dossierToText(d)).toContain('EXTRACTION INCOMPLÈTE');
    expect(dossierToText(d)).toContain('AVERTISSEMENT : Section « Preuves »');
    expect(dossierToCsv(d)).toContain('INCOMPLÈTE');
  });
  it('CSV : BOM UTF-8, `;`, CRLF, guillemets et accents, formules neutralisées, colonnes conservées', () => {
    const csv = dossierToCsv(dossier());
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toContain('\r\n');
    expect(csv.split('\r\n')[0]).toBe('﻿onglet;section;table;ligne;champ;libelle;etat;valeur_brute;valeur_affichee;unite;origine;modifie_le;note');
    expect(csv).toContain('"1 399,00 € TTC; ""total"""');
    expect(csv).toContain('Prix d’achat');
    expect(csv).toContain(LONG);
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('-12')).toBe('-12');
    const sec = sectionToCsv(dossier().sections[2])!;
    expect(sec.split('\r\n')[0]).toBe('﻿id;value_json;raw_value;evidence_excerpt;excerpt_long');
    expect(sec).toContain('11;"{""amount"":1399,""unit"":""EUR""}";');
    expect(sec).toContain(';NULL;[non chargé : borne]');
  });
  it('copie d’une valeur : valeur complète, jamais tronquée ; états explicites', () => {
    const f = dossier().sections[0].fields!;
    expect(fieldCopyText(f[0])).toBe('116583');
    expect(fieldCopyText(f[1])).toBe('NULL');
    expect(fieldCopyText(f[4])).toBe('[masqué : nom du fichier original]');
    expect(fieldCopyText(f[5])).toHaveLength(50_000);
    expect(rawText({ a: [1, 2] })).toBe('{"a":[1,2]}');
  });
});

describe('L75N-U04 formatage, nommage, liens profonds, navigation', () => {
  it('formatage : montants, dates, la valeur brute reste séparée', () => {
    expect(formatMinor(139900)).toBe('1 399,00 €');
    expect(formatMinor(-5)).toBe('-0,05 €');
    expect(formatColumn('amount_minor', 139900, { currency: 'USD' })).toEqual({ display: '1 399,00 USD', unit: 'unités mineures USD' });
    expect(formatColumn('document_date', '2024-04-22').display).toBe('22/04/2024');
    expect(formatColumn('created_at', '2024-04-22T10:00:00+00:00').display).toBe('22/04/2024 12:00:00 (Paris)');
    expect(rowFields('t', { a: 1, b: null }).map((f) => f.state)).toEqual(['value', 'null']);
  });
  it('nom de fichier : verebona-compte-<id>-<type>-<id>-<date>.<ext>', () => {
    const d = dossier();
    expect(exportFileName(d, 'json')).toBe('verebona-compte-123-equipement-456-2026-10-20.json');
    expect(exportFileName(d, 'csv', 'field-evidence')).toBe('verebona-compte-123-equipement-456-2026-10-20-field-evidence.csv');
    expect(exportFileName({ ...d, entity: { ...d.entity, type: 'deadline' } }, 'txt')).toBe('verebona-compte-123-echeance-historique-456-2026-10-20.txt');
    // Jour civil de Paris (22 h UTC le 19 = 20 à Paris en heure d'été).
    expect(exportFileName({ ...d, extractedAt: '2026-10-19T22:30:00.000Z' }, 'json')).toBe('verebona-compte-123-equipement-456-2026-10-20.json');
  });
  it('lien profond : liste blanche stricte', () => {
    expect(parseEntityRef('equipment-456')).toEqual({ type: 'equipment', id: 456 });
    expect(parseEntityRef(entityRef('operation', 9))).toEqual({ type: 'operation', id: 9 });
    for (const bad of ['users-1', 'equipment-0', 'equipment-1;drop', 'asset-12345678901', '', null]) expect(parseEntityRef(bad as string)).toBeNull();
  });
  it('six catégories ; navigation : historique du tiroir unique', () => {
    expect(CATEGORIES).toEqual(['biens', 'equipements', 'pieces', 'documents', 'echeances', 'operations']);
    expect(CATEGORY_TYPES.echeances).toEqual(['agenda', 'deadline']);
    const a = { type: 'equipment' as const, id: 1 };
    const b = { type: 'document' as const, id: 2 };
    expect(pushHistory([], null, a)).toEqual([]);
    expect(pushHistory([], a, b)).toEqual([a]);
    expect(pushHistory([a], a, a)).toEqual([a]);
  });
});
