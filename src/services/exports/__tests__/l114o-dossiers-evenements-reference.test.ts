/**
 * Lot 114O (Trello #744), point G — GARDES des dossiers d'export face au
 * nouveau modèle des événements de référence (CDC « Opérations / Agenda V2.0 »
 * §19, §22 ; critères AC24, AC43, AC59, AC67, AC69).
 *
 * Revue des dossiers qui n'avaient pas été reprise au passage précédent :
 * « Vente », « Assurance — souscription », « Dossier complet » et la sortie
 * ZIP. Le comportement est prouvé sur PostgreSQL réel par
 * `src/test/e2e/scenarios/l114o-exports-dossiers.e2e.ts` ; ce fichier POSE LES
 * GARDES qui empêchent le retour du défaut :
 *
 *   L114OG-U01  aucun dossier ne cite un événement de référence sans l'avoir filtré (invalidé, regroupé)
 *   L114OG-U02  les mappeurs et templates de Vente, Souscription, Dossier complet et Location ne lisent
 *               AUCUN événement de référence : ni duplication, ni citation périmée possibles
 *   L114OG-U03  un seul lecteur de la chronologie d'un sinistre (le service partagé du graphe) : un lien
 *               N↔N nouveau ne peut pas être oublié par un lecteur parallèle
 *   L114OG-U04  le plan de sélection ne peut pas retenir deux fois le même fait ni la même pièce
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { planSelection, type ExportChoices } from '@/services/exports/v12/data/choices';
import type { ExportSource } from '@/services/exports/v12/data/source';

const ROOT = process.cwd();
const lire = (rel: string) => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n?/g, '\n');
/** Code seulement : les commentaires citent les règles, ils ne les appliquent pas. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const SOURCES = [
  'src/services/exports/v12/data/source.ts',
  'src/services/exports/v12/data/canonical-source.ts',
];
const SANS_EVENEMENT_DE_REFERENCE = [
  'src/services/exports/v12/data/mappers/vente.ts',
  'src/services/exports/v12/data/mappers/assurance-souscription.ts',
  'src/services/exports/v12/data/mappers/dossier-complet.ts',
  'src/services/exports/v12/data/mappers/location.ts',
  'src/services/exports/v12/templates/vente.ts',
  'src/services/exports/v12/templates/assurance-souscription.ts',
  'src/services/exports/v12/templates/dossier-complet.ts',
  'src/services/exports/v12/templates/location.ts',
  'src/services/exports/v12/zip.ts',
];

describe('L114OG-U01 — un dossier ne cite jamais une opération supprimée ou regroupé', () => {
  it('chaque requête des sources de dossier sur les opérations écarte l’invalidé et le regroupé', () => {
    for (const p of SOURCES) {
      const src = code(lire(p));
      // Fragments SQL qui nomment la table des événements de référence.
      const requetes = [...src.matchAll(/`([^`]*\bFROM business_operations\b[^`]*)`/g)].map((m) => m[1]);
      for (const q of requetes) {
        expect(q, `${p} : ${q.slice(0, 120)}`).toMatch(/invalidated_at IS NULL/);
        expect(q, `${p} : ${q.slice(0, 120)}`).toMatch(/merged_into_operation_id IS NULL/);
        // Et toujours borné au compte (AC59).
        expect(q, `${p} : ${q.slice(0, 120)}`).toMatch(/account_id = \$\d/);
      }
    }
  });

  it('la seule lecture d’une opération par un dossier passe par un service partagé ou par ce filtre', () => {
    // Le dossier « Assurance — sinistre » lit l'événement CLAIM par le service des sinistres (lot 83D),
    // qui écarte lui-même un sinistre invalidé ou regroupé : aucune requête parallèle dans les exports.
    const src = code(lire('src/services/exports/v12/data/source.ts'));
    expect(src).toContain("import('@/services/business-operations/claims/read')");
    const claims = code(lire('src/services/business-operations/claims/read.ts'));
    expect(claims).toMatch(/invalidated_at IS NULL/);
    expect(claims).toMatch(/merged_into_operation_id IS NULL/);
  });
});

describe('L114OG-U02 — Vente, Souscription, Dossier complet, Location et ZIP ne lisent aucune opération', () => {
  it('aucun de ces fichiers ne nomme une opération, un identifiant d’opération ni sa table', () => {
    for (const p of SANS_EVENEMENT_DE_REFERENCE) {
      const src = code(lire(p));
      expect(src, p).not.toMatch(/business_operation|operationId|operation_id|readOperationGraph|business_operation_agenda_links/);
    }
  });

  it('leurs faits viennent du BIEN (documents, photos, événements de la source), jamais d’un lien N↔N', () => {
    // Les trois mappeurs ne lisent que les listes de la source du bien et le plan de sélection.
    for (const p of SANS_EVENEMENT_DE_REFERENCE.filter((x) => x.includes('/mappers/'))) {
      const src = code(lire(p));
      expect(src, p).toMatch(/selectedEvents|sortedDocuments|plannedPhotos/);
    }
  });
});

describe('L114OG-U03 — un seul lecteur de la chronologie d’un sinistre (aucun lien N↔N oublié)', () => {
  it('la chronologie du graphe est lue par le service partagé, et par lui seul', () => {
    const chrono = 'src/services/business-operations/claims/agenda-chronology.ts';
    expect(code(lire(chrono))).toMatch(/business_operation_agenda_links/);
    // Les exports ne lisent pas la table eux-mêmes : ils passent par le service des sinistres.
    for (const p of [...SOURCES, 'src/services/exports/v12/data/mappers/assurance-sinistre.ts']) {
      expect(code(lire(p)), p).not.toMatch(/business_operation_agenda_links/);
    }
  });
});

describe('L114OG-U04 — le plan de sélection ne retient jamais deux fois le même fait', () => {
  const doc = (id: number, title: string) => ({
    id, title, kind: 'FACTURE' as const, format: 'PDF', integrable: true, sensitive: false, occupantData: false,
    date: '2025-04-03', fileName: `${title}.pdf`, sizeBytes: 1000, section: 'documents', mimeType: 'application/pdf',
  });
  const source = {
    exportType: 'DOSSIER_COMPLET', family: 'IMMOBILIER',
    asset: { id: 1, name: 'Maison', category: 'IMMOBILIER', characteristics: {} },
    documents: [doc(11, 'Facture partagee')],
    photos: [],
    events: [{ key: 'agenda:21', source: 'agenda' as const, id: 21, title: 'Entretien partage', date: '2025-04-02', category: null, status: null, provider: null, costCents: null, description: null, forecast: false, nature: 'HISTORICAL' as const }],
    additionalInfo: {}, equipments: [], preparedBy: null,
  } as unknown as ExportSource;

  it('deux choix pour le même justificatif ou le même événement : une seule retenue', () => {
    const choices = {
      outputFormat: 'ZIP', origin: 'user', sections: { history: true, deadlines: true, documents: true, photos: true, finance: false, contracts: true },
      items: [
        { sourceType: 'document', sourceId: 11, selected: true, mode: 'PDF' },
        { sourceType: 'document', sourceId: 11, selected: true, mode: 'ZIP' },
        { sourceType: 'agenda', sourceId: 21, selected: true },
        { sourceType: 'agenda', sourceId: 21, selected: true },
      ],
      acknowledgements: { pdfOnlyExcludesZipItems: false },
    } as unknown as ExportChoices;
    const plan = planSelection('DOSSIER_COMPLET', source, choices, '2026-06-15');
    expect(plan.documents.map((d) => d.doc.id)).toEqual([11]);
    expect([...plan.events]).toEqual(['agenda:21']);
  });

  it('le plan est construit depuis les listes de la source : une pièce absente de la source n’entre jamais', () => {
    const choices = {
      outputFormat: 'ZIP', origin: 'user', sections: { documents: true },
      items: [{ sourceType: 'document', sourceId: 99, selected: true, mode: 'PDF' }],
      acknowledgements: { pdfOnlyExcludesZipItems: false },
    } as unknown as ExportChoices;
    const plan = planSelection('DOSSIER_COMPLET', source, choices, '2026-06-15');
    expect(plan.documents).toEqual([]);
    expect(plan.excluded.map((x) => x.sourceId)).not.toContain(99);
  });
});
