/**
 * Carte Trello #830 (P2, Pré-MEP) — fiche d'un document : règle d'affichage PURE des événements associés
 * (`lib/documents/document-event-duplicates`) et câblage du tiroir.
 *
 *   C830-U01  Decathlon : l'événement représente l'opération affichée → masqué ; bloc entier absent (bouton compris)
 *   C830-U02  événement autonome seul → affiché, bouton présent ; document sans aucun événement → bouton présent
 *   C830-U03  cas mixte → seul le doublon disparaît ; l'ordre est conservé
 *   C830-U04  opération sans événement correspondant → rien n'est masqué
 *   C830-U05  la correspondance ne lit NI titre NI date : même titre et même date sans relation → affiché ;
 *             titres et dates différents avec relation → masqué
 *   C830-U06  l'opération doit être EFFECTIVEMENT affichée : non listée, lecture en échec (aucune opération) → affiché
 *   C830-U07  prudence : lecture des liens en échec → tout est affiché ; événement inconnu des liens → affiché ;
 *             réponse sans `representedOperationIds` (document historique, serveur antérieur) → affiché
 *   C830-U08  tant qu'une des deux lectures manque → rien n'est rendu (pas d'apparition fugitive du doublon)
 *   C830-U09  câblage du tiroir du document : règle A (vue calculée, bouton conditionné), règle B (plus de vignette
 *             « jalon de l'opération »), règle C (aucun renvoi vers l'opération sous « Date du document »)
 *   C830-U10  périmètre : le tiroir de l'Agenda et la fiche de l'opération ne lisent pas cette règle ; la vignette du
 *             tiroir de l'Agenda est inchangée ; la route des liens reste en lecture seule et bornée au compte
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  documentEventsView, isEventOfDisplayedOperation, type DocumentAgendaLinkFacts, type DocumentAgendaLinksState,
} from '@/lib/documents/document-event-duplicates';
import { GROUPING_LABELS } from '@/lib/agenda/grouping-view';

const lire = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
interface Evt { id: number; title: string; startDate: string | null }
const evt = (id: number, title: string, startDate: string | null = null): Evt => ({ id, title, startDate });
const represente = (itemId: number, ...ops: number[]): DocumentAgendaLinkFacts => ({ itemId, direct: false, viaGroup: true, isMain: true, outsideOperation: false, representedOperationIds: ops });
const distinct = (itemId: number, o: Partial<DocumentAgendaLinkFacts> = {}): DocumentAgendaLinkFacts => ({ itemId, direct: true, viaGroup: false, isMain: false, outsideOperation: true, representedOperationIds: [], ...o });
const prets = (...l: DocumentAgendaLinkFacts[]): DocumentAgendaLinksState => ({ status: 'ready', links: new Map(l.map((x) => [x.itemId, x])) });

describe('C830 — règle d’affichage des événements de la fiche d’un document', () => {
  it('C830-U01 — Decathlon : l’événement représente l’opération affichée → masqué, bloc entier absent', () => {
    const v = documentEventsView([evt(501, 'Achat Decathlon', '2026-11-20')], prets(represente(501, 9001)), [9001]);
    expect(v).toEqual({ ready: true, events: [], hiddenIds: [501], showAssociate: false });
  });

  it('C830-U02 — événement autonome seul → affiché ; document sans événement → bouton présent', () => {
    const e = evt(503, 'Passage du ramoneur', '2026-12-03');
    expect(documentEventsView([e], prets(distinct(503)), [])).toEqual({ ready: true, events: [e], hiddenIds: [], showAssociate: true });
    expect(documentEventsView([], prets(), [])).toEqual({ ready: true, events: [], hiddenIds: [], showAssociate: true });
    expect(documentEventsView([], prets(), [9001])).toMatchObject({ ready: true, showAssociate: true });
  });

  it('C830-U03 — cas mixte : seul le doublon disparaît, l’ordre est conservé', () => {
    const [a, b, c] = [evt(1, 'Rappel A'), evt(2, 'Pose de la chaudière'), evt(3, 'Rappel C')];
    // L'événement 3 a rejoint l'opération en simple membre (geste « Associer à l'agenda ») : il ne la représente pas.
    const v = documentEventsView([a, b, c], prets(distinct(1), represente(2, 9004), distinct(3, { outsideOperation: false })), [9004]);
    expect(v.events).toEqual([a, c]);
    expect(v.hiddenIds).toEqual([2]);
    expect(v.showAssociate).toBe(true);
  });

  it('C830-U04 — opération sans événement correspondant : aucun événement autonome masqué', () => {
    const e = evt(506, 'Visite annuelle');
    expect(documentEventsView([e], prets(distinct(506)), [9005])).toEqual({ ready: true, events: [e], hiddenIds: [], showAssociate: true });
  });

  it('C830-U05 — jamais par le titre ni par la date', () => {
    // Même titre, même date que l'opération, AUCUNE relation → affiché.
    const homonyme = evt(7, 'Achat Decathlon', '2026-11-20');
    expect(documentEventsView([homonyme], prets(distinct(7)), [9001]).events).toEqual([homonyme]);
    // Titre et date sans rapport, relation établie → masqué.
    expect(documentEventsView([evt(8, 'Tout autre libellé', '1999-01-01')], prets(represente(8, 9001)), [9001]).hiddenIds).toEqual([8]);
    // La fonction ne reçoit que des identifiants : le titre et la date ne lui sont même pas lisibles par le lien.
    expect(Object.keys(represente(8, 9001)).sort()).toEqual(['direct', 'isMain', 'itemId', 'outsideOperation', 'representedOperationIds', 'viaGroup']);
    const source = lire('src/lib/documents/document-event-duplicates.ts');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/title|startDate|label|toLowerCase|includes\(/);
  });

  it('C830-U06 — l’opération doit être effectivement affichée sur la fiche', () => {
    const e = evt(501, 'Achat Decathlon');
    // Opération non listée par « Opérations » (lecture en échec → liste vide, ou autre opération affichée).
    expect(documentEventsView([e], prets(represente(501, 9001)), []).events).toEqual([e]);
    expect(documentEventsView([e], prets(represente(501, 9001)), [9002]).events).toEqual([e]);
    // Deux opérations représentées, une seule affichée : c'est un doublon de celle-là.
    expect(documentEventsView([e], prets(represente(501, 9001, 9002)), [9002]).hiddenIds).toEqual([501]);
    expect(isEventOfDisplayedOperation(represente(501, 9001), new Set([9001]))).toBe(true);
    expect(isEventOfDisplayedOperation(represente(501), new Set([9001]))).toBe(false);
    expect(isEventOfDisplayedOperation(undefined, new Set([9001]))).toBe(false);
  });

  it('C830-U07 — prudence : on ne masque que ce qui est prouvé', () => {
    const e = evt(501, 'Achat Decathlon');
    // Lecture des liens en échec : tout reste affiché, bouton compris — même sans connaître les opérations.
    expect(documentEventsView([e], { status: 'failed' }, null)).toEqual({ ready: true, events: [e], hiddenIds: [], showAssociate: true });
    expect(documentEventsView([e], { status: 'failed' }, [9001]).events).toEqual([e]);
    // Événement que la lecture des liens ne connaît pas (liste relue avant les liens) : affiché.
    const nouveau = evt(9, 'Tout juste associé');
    const v = documentEventsView([e, nouveau], prets(represente(501, 9001)), [9001]);
    expect(v.events).toEqual([nouveau]);
    expect(v.showAssociate).toBe(true);
    // Document historique / réponse sans la correspondance : jamais doublon.
    const ancien: DocumentAgendaLinkFacts = { itemId: 507, direct: true, viaGroup: false, isMain: false, outsideOperation: true };
    expect(documentEventsView([evt(507, 'Réfection de la toiture', '2019-03-01')], prets(ancien), [9001]).hiddenIds).toEqual([]);
    const sansChamp: DocumentAgendaLinkFacts = { itemId: 501, direct: false, viaGroup: true, isMain: true };
    expect(documentEventsView([e], prets(sansChamp), [9001]).events).toEqual([e]);
  });

  it('C830-U08 — tant qu’une lecture manque, rien n’est rendu (ni carte, ni titre, ni bouton)', () => {
    const e = evt(501, 'Achat Decathlon');
    const rien = { ready: false, events: [], hiddenIds: [], showAssociate: false };
    expect(documentEventsView([e], { status: 'loading' }, [9001])).toEqual(rien);
    expect(documentEventsView([e], prets(represente(501, 9001)), null)).toEqual(rien);
    expect(documentEventsView([e], { status: 'loading' }, null)).toEqual(rien);
  });
});

describe('C830 — câblage du tiroir du document et périmètre', () => {
  const tiroir = lire('src/components/assets/DocumentDrawer.tsx');

  it('C830-U09 — tiroir du document : règles A, B et C', () => {
    // Règle A : la liste rendue est la vue calculée ; le bouton dépend de la vue ; les opérations affichées viennent de la rubrique.
    expect(tiroir).toContain('const vueEvenements = documentEventsView(linkedAgendaItems, agendaLinksState, shownOpIds);');
    expect(tiroir).toContain('if (!vueEvenements.ready) return null;');
    expect(tiroir).toContain('{vueEvenements.events.length > 0 && (');
    expect(tiroir).toContain('{vueEvenements.events.map(item => (');
    expect(tiroir).not.toContain('{linkedAgendaItems.map(item => (');
    expect(tiroir).toContain('{vueEvenements.showAssociate && (');
    expect(tiroir).toContain('<DocumentOperations key={doc.id} documentId={doc.id} onDisplayedChange={onOpsShown} />');
    const operations = lire('src/components/documents/DocumentOperations.tsx');
    expect(operations).toContain('signaler.current?.(documentId, operations ? operations.map((o) => o.id) : null);');
    // Échec de la lecture des liens : état « failed » (tout reste affiché), jamais un état « prêt » vide.
    expect(tiroir).toContain("setAgendaLinksLoad({ docId, status: 'failed' })");
    // Règle B : plus aucune vignette « jalon de l'opération » dans le tiroir du document.
    expect(tiroir).not.toContain('GROUPING_LABELS.mainBadge');
    expect(tiroir).not.toMatch(/Jalon de l.op[ée]ration|[ÉE]v[ée]nement de r[ée]f[ée]rence<|mainBadge/);
    // Règle C : aucun renvoi vers l'opération dans le bloc « Informations » (de « Date du document » à « Notes »).
    const debut = tiroir.indexOf('data-testid="document-detail-document-date"');
    const fin = tiroir.indexOf('data-testid="document-notes-description"', debut);
    expect(debut).toBeGreaterThan(0);
    expect(fin).toBeGreaterThan(debut);
    const informations = tiroir.slice(debut, fin);
    expect(informations).not.toMatch(/ReferenceEvent|referenceEventHref|evenements-reference|DocumentOperations|data-reference-event-open|<Layers/);
    expect(tiroir).not.toMatch(/ReferenceEventLink|DocumentReferenceEvents|REFERENCE_EVENT_OPEN_LABEL|ReferenceEventSheet/);
    expect(lire('src/components/documents/ReferenceEventSheet.tsx')).not.toContain('export function DocumentReferenceEvents');
    // La période métier (seul composant entre les deux dates) ne mène à aucune opération.
    const periodes = lire('src/components/documents/BusinessPeriods.tsx');
    expect(periodes).not.toMatch(/ReferenceEventLink|referenceEventHref/);
  });

  it('C830-U10 — périmètre : Agenda et fiche de l’opération inchangés ; route des liens en lecture seule, bornée au compte', () => {
    // La règle n'est lue que par le tiroir du document.
    for (const f of [
      'src/components/agenda/AgendaItemDrawer.tsx', 'src/components/agenda/AgendaGroupingPanel.tsx', 'src/components/agenda/AgendaGroupingSection.tsx',
      'src/components/reference-events/ReferenceEventPageContent.tsx', 'src/components/reference-events/ReferenceEventList.tsx',
    ]) expect(lire(f), f).not.toMatch(/document-event-duplicates|representedOperationIds|onDisplayedChange/);
    // Le tiroir de l'Agenda garde sa vignette (hors périmètre de la carte) ; le libellé partagé n'est pas modifié.
    expect(GROUPING_LABELS.mainBadge).toBe('Jalon de l’opération');
    expect(lire('src/components/agenda/AgendaGroupingPanel.tsx')).toContain('{L.mainBadge}');
    expect(GROUPING_LABELS.documentLinkedEvents).toBe('Événements associés');
    expect(GROUPING_LABELS.documentAgendaTitle).toBe('Associer à l’agenda');
    // Lecture des liens : une seule requête, SELECT, bornée au compte du document ; le fait porté établit la correspondance.
    const lecture = lire('src/services/business-operations/grouping/read.ts');
    const fn = lecture.slice(lecture.indexOf('export async function getDocumentAgendaLinks'), lecture.indexOf('export async function listAgendaCandidatesForDocument'));
    expect(fn).toContain('WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL');
    expect(fn).toContain('g3.fact_key IS NOT NULL');
    expect(fn).toContain('g3.account_id = i.account_id');
    expect(fn).toContain('d3.file_id = l.asset_file_id AND d3.active');
    expect(fn).toContain('o3.invalidated_at IS NULL AND o3.merged_into_operation_id IS NULL');
    expect(fn).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
  });
});
