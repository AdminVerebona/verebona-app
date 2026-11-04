/**
 * Lot 109I — vocabulaire « événement » sur toutes les surfaces client
 * (extension du ticket #614, décision PO du 31/10/2026).
 *
 *   L109I-U01  libellés partagés : « Événements associés » / « Aucun événement associé. »
 *              repris de GROUPING_LABELS (aucune seconde convention) ;
 *   L109I-U02  GARDE DE RÉGRESSION : aucune chaîne VISIBLE (littéraux et textes JSX,
 *              commentaires et journaux exclus) des surfaces client ne contient
 *              « élément (d'/de l')agenda », « élément agenda », « agenda associé »,
 *              « événement d'agenda » ni « Suggestions agenda » ; exceptions nommées
 *              et justifiées (synonymes de recherche, message de journal) ;
 *   L109I-U03  rendus concrets (fiche équipement, fournisseur, document, Agenda,
 *              recherche, transfert, Duo, e-mail, À traiter, Assistant, erreurs) ;
 *   L109I-U04  compatibilité : l'ancien terme reste compris (aide / Assistant).
 *
 * Hors garde (volontairement) : back-office et diagnostics (`/admin/`,
 * registre de cohérence, regroupement technique `business-operations`),
 * prompts IA, migrations, fixtures, tests, identifiants techniques
 * (`agenda_items`, `document-creer-element-agenda`…).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { AGENDA_EVENT_LABELS, GROUPING_LABELS } from '@/lib/agenda/grouping-view';
import { localSearchNoResult, localSearchStatus } from '@/lib/search/local-search';
import { detectHelpConcept } from '@/lib/help-center/concepts';
import { describeMoves, describeStays } from '@/components/assets/MoveToDuoSpaceDialog';
import { targetFallbackLabel } from '@/services/to-process/card-labels';
import { DEFAULT_EMAIL_TEMPLATES } from '@/lib/email-defaults';

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/** Formulations interdites à l'écran (apostrophes droite / courbe, casse, pluriel). */
const FORBIDDEN = /[ée]l[ée]ments?\s+(?:d['’]\s*|de\s+l['’]\s*)?agenda|agenda\s+associ[ée]|[ée]v[ée]nements?\s+d['’]\s*agenda|suggestions\s+agenda/i;

/** Surfaces dont les chaînes peuvent être affichées à l'utilisateur (client, routes, Assistant, À traiter, e-mails…). */
const ROOTS = [
  'src/components', 'src/app', 'src/lib', 'src/hooks', 'src/contexts',
  'src/services/verebona-assistant', 'src/services/to-process', 'src/services/home', 'src/services/notifications',
  'src/services/email', 'src/services/duo', 'src/services/agenda', 'src/services/suppliers', 'src/services/search',
  'src/services/exports', 'src/services/documents', 'src/services/assets', 'src/services/equipments', 'src/services/rooms',
  'src/services/suggestions', 'src/services/account', 'src/services/gdpr', 'src/services/legal',
];
/** Hors périmètre : tests, fixtures, back-office (nomenclature exploitant), prompts IA. */
const EXCLUDED = /(__tests__|__fixtures__|\.test\.|\.e2e\.|\/admin\/|\/prompts\/)/;
/**
 * Exceptions justifiées (fichier → motif de ligne) :
 *   · concepts.ts : anciens termes gardés comme SYNONYMES de compréhension (objects / queries) ;
 *   · agenda-removal-trace.ts : message de journal de démarrage (schemaNotReadyMessage), jamais affiché.
 */
const ALLOWED: Record<string, RegExp> = {
  'src/lib/help-center/concepts.ts': /^\s*(objects|queries):/,
  'src/services/agenda/agenda-removal-trace.ts': /^\s*consequence:/,
};

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (EXCLUDED.test(rel)) continue;
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...files(rel));
    else if (/\.(ts|tsx)$/.test(name)) out.push(rel);
  }
  return out;
}

/** Lignes de code sans commentaires ni journaux (les numéros de ligne sont conservés). */
function visibleLines(src: string): string[] {
  const sansBlocs = src.replace(/\/\*[\s\S]*?\*\//g, (m) => '\n'.repeat(m.split('\n').length - 1));
  return sansBlocs.split('\n').map((l) => {
    const sansLigne = l.replace(/(^|[^:'"`])\/\/.*$/, '$1');
    return /console\.(error|warn|info|log|debug)\(/.test(sansLigne) ? '' : sansLigne;
  });
}

describe('L109I-U01 — libellés partagés (lib/agenda/grouping-view)', () => {
  it('rubrique et état vide d’une fiche = termes déjà validés dans GROUPING_LABELS', () => {
    expect(AGENDA_EVENT_LABELS.linkedEvents).toBe('Événements associés');
    expect(AGENDA_EVENT_LABELS.linkedEvents).toBe(GROUPING_LABELS.sectionLinked);
    expect(AGENDA_EVENT_LABELS.noLinkedEvent).toBe('Aucun événement associé.');
    expect(AGENDA_EVENT_LABELS.noLinkedEvent).toBe(GROUPING_LABELS.emptyLinkedEvents);
    expect(AGENDA_EVENT_LABELS.create).toBe(GROUPING_LABELS.createAgendaItem);
    expect(AGENDA_EVENT_LABELS.searchEvent).toBe(GROUPING_LABELS.pickerSearch.elements);
    // « Agenda » reste le nom du module.
    expect(GROUPING_LABELS.documentAgendaTitle).toBe('Associer à l’agenda');
  });
  it('table du ticket : correspondances minimales', () => {
    expect(AGENDA_EVENT_LABELS.event).toBe('Événement');
    expect(AGENDA_EVENT_LABELS.events).toBe('Événements');
    expect(AGENDA_EVENT_LABELS.createFirst).toBe('Créez votre premier événement');
    expect(AGENDA_EVENT_LABELS.seeAll).toBe('Voir tous les événements');
    expect(AGENDA_EVENT_LABELS.noEvent).toBe('Aucun événement');
    expect(AGENDA_EVENT_LABELS.suggested).toBe('Événements suggérés');
    expect(AGENDA_EVENT_LABELS.count(0)).toBe('aucun événement');
    expect(AGENDA_EVENT_LABELS.count(1)).toBe('1 événement');
    expect(AGENDA_EVENT_LABELS.count(4)).toBe('4 événements');
    expect(AGENDA_EVENT_LABELS.total(0)).toBe('0 événement');
  });
  it('aucun libellé partagé ne porte une formulation interdite, ni « Opération »', () => {
    const valeurs = [...Object.values(AGENDA_EVENT_LABELS), ...Object.values(GROUPING_LABELS)]
      .flatMap((v) => (typeof v === 'string' ? [v] : typeof v === 'function' ? [String((v as (n: number) => string)(2))] : Object.values(v as Record<string, string>)));
    for (const v of valeurs) {
      expect(v, v).not.toMatch(FORBIDDEN);
      expect(v, v).not.toMatch(/Opération/);
    }
  });
});

describe('L109I-U02 — garde : aucune formulation interdite dans les chaînes visibles', () => {
  it('surfaces client, routes, Assistant, À traiter, e-mails, aide', () => {
    const fautes: string[] = [];
    for (const root of ROOTS) {
      for (const f of files(root)) {
        const allowed = ALLOWED[relative(ROOT, join(ROOT, f))];
        visibleLines(read(f)).forEach((l, i) => {
          if (FORBIDDEN.test(l) && !(allowed && allowed.test(l))) fautes.push(`${f}:${i + 1} ${l.trim().slice(0, 140)}`);
        });
      }
    }
    expect(fautes).toEqual([]);
  });
  it('la garde détecte bien les variantes (apostrophes, casse, pluriel)', () => {
    for (const t of ['Agenda associé', 'Aucun élément agenda associé.', 'Éléments d’agenda', 'élément d\'agenda',
      'Créer un élément de l’agenda', 'Événements d’agenda', 'Suggestions agenda', 'ELEMENTS D\'AGENDA']) expect(t).toMatch(FORBIDDEN);
    for (const t of ['Mon agenda', 'Associer à l’agenda', 'Événements associés', 'document-creer-element-agenda', 'agenda_items']) expect(t).not.toMatch(FORBIDDEN);
  });
});

describe('L109I-U03 — rendus concrets', () => {
  it('fiche équipement : « Événements associés » et « Aucun événement associé. » (compteur et cartes inchangés)', () => {
    const eq = read('src/components/assets/EquipmentDrawer.tsx');
    expect(eq).toContain('<p className="vb-app-subsection">{AGENDA_EVENT_LABELS.linkedEvents}</p>');
    expect(eq).toContain('<p className="text-xs text-muted-foreground">{AGENDA_EVENT_LABELS.noLinkedEvent}</p>');
    expect(eq).toContain('{equipmentAgenda.length}');
    expect(eq).toMatch(/<EntityCard\s+key=\{item\.id\}\s+kind="echeance"/);
  });
  it('fiche fournisseur : rubrique « Événements associés », état vide contextualisé, « Associer » / « Dissocier » conservés', () => {
    const s = read('src/components/suppliers/SupplierAgendaSection.tsx');
    expect(s).toContain('{AGENDA_EVENT_LABELS.linkedEvents}');
    expect(s).toContain('{AGENDA_EVENT_LABELS.supplierNoLinkedEvent}');
    expect(AGENDA_EVENT_LABELS.supplierNoLinkedEvent).toBe('Aucun événement n’est associé à ce fournisseur.');
    expect(s).toContain('Associer un événement');
    expect(s).not.toMatch(/Supprimer/);
  });
  it('fiche document : « Événements suggérés » (propositions d’événements, bouton « Ajouter » = création prérenseignée)', () => {
    const d = read('src/components/assets/DocumentDrawer.tsx');
    expect(d.match(/\{AGENDA_EVENT_LABELS\.suggested\}/g)?.length).toBe(3);
    expect(d).toContain("p.proposalType === 'agenda_suggestion'");
  });
  it('Agenda, onglet Agenda du bien, création, suppression : « événement »', () => {
    for (const f of ['src/app/(dashboard)/agenda/page.tsx', 'src/components/assets/AssetAgendaTab.tsx']) {
      const s = read(f);
      expect(s, f).toContain('AGENDA_EVENT_LABELS.noEventYet');
      expect(s, f).not.toMatch(/Aucun élément|premier élément/);
    }
    const c = read('src/components/agenda/CreateAgendaItemDrawer.tsx');
    expect(c).toContain('<SheetTitle>{AGENDA_EVENT_LABELS.newEvent}</SheetTitle>');
    const a = read('src/components/agenda/AgendaItemDrawer.tsx');
    expect(a).toContain('<AlertDialogTitle>{AGENDA_EVENT_LABELS.deleteTitle}</AlertDialogTitle>');
    expect(AGENDA_EVENT_LABELS.deleteBody).toContain('de votre agenda');
  });
  it('recherche locale de l’Agenda et transfert', () => {
    expect(localSearchStatus('agenda', 0)).toBe('Aucun événement trouvé');
    expect(localSearchStatus('agenda', 3)).toBe('3 événements trouvés');
    expect(localSearchStatus('document', 2)).toBe('2 documents trouvés');
    expect(localSearchNoResult('agenda', 'x', false)).toBe('Aucun événement ne correspond à « x ».');
    expect(read('src/components/assets/TransferExportDrawer.tsx')).toContain('emptyLabel={AGENDA_EVENT_LABELS.noEvent}');
  });
  it('Duo : déplacement, invitation (page et e-mail par défaut)', () => {
    expect(describeMoves({ documents: [], equipments: 0, rooms: 0, agendaItems: 2, events: 0, deadlines: 0, operations: 0, toProcessActions: 0, suppliersCopied: 0, suppliersReused: 0 } as never))
      .toEqual(['2 événements']);
    expect(describeStays({ sharedDocuments: [], sharedAgendaItems: 2, sharedOperations: 0, pendingTransmissionsCancelled: 0 }))
      .toEqual(['2 événements partagés avec d’autres biens (lien retiré)']);
    expect(read('src/app/duo/join/[token]/page.tsx')).toContain('pour vos biens, documents et événements.');
    expect(DEFAULT_EMAIL_TEMPLATES.DUO_INVITATION.body).toContain('documents et événements dans un même compte');
  });
  it('À traiter, Assistant, erreurs des routes', () => {
    expect(targetFallbackLabel('AGENDA_ITEM')).toBe('Événement');
    expect(read('src/services/verebona-assistant/core/data-answer.service.ts')).toContain('` Événement : « ${first.title} ».`');
    expect(read('src/app/api/agenda/[id]/liens/route.ts')).toContain('ITEM_NOT_FOUND: { status: 404, message: AGENDA_EVENT_LABELS.notFound }');
    expect(read('src/app/api/documents/[id]/agenda-liens/route.ts')).toContain('Événement ou document introuvable.');
  });
});

describe('L109I-U04 — compatibilité : l’ancien terme reste compris', () => {
  it('aide / Assistant : « créer un élément d’agenda » et « créer un événement » → même concept', () => {
    expect(detectHelpConcept('comment créer un élément d’agenda')?.concept.id).toBe('AGENDA_ITEM_CREATE');
    expect(detectHelpConcept('comment créer un événement')?.concept.id).toBe('AGENDA_ITEM_CREATE');
    expect(detectHelpConcept('comment créer un événement')?.concept.label).toBe('Créer un événement');
  });
});
