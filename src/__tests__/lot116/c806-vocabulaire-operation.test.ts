/**
 * Carte Trello #806 §1 — « Nomenclature et retrait de fonction » (décisions du PO du 17/11/2026).
 *
 * Règle remplacée (carte #806, décision du PO du 17/11/2026) : la règle permanente « ne jamais afficher "Opération" »
 * (gardes des lots 109, 113 et 114) est LEVÉE. À l'écran on dit « opération » ; c'est l'ancien terme, « événement de
 * référence » (et « élément de référence »), qui est interdit dans tout texte visible.
 *
 *   C806-V01  la garde reconnaît toutes les formes de l'ancien terme (singulier, pluriel, majuscules, sans accents,
 *             espaces insécables, retour à la ligne) et ne confond pas les identifiants techniques ;
 *   C806-V02  GARDE : aucune chaîne, aucun gabarit, aucun texte JSX de `src/` (hors tests) ne contient l'ancien
 *             terme — lecture par l'arbre syntaxique (les commentaires ne sont pas des textes visibles) ; liste
 *             FERMÉE et justifiée d'exceptions, dont chacune doit encore exister (une exception morte fait échouer) ;
 *   C806-V03  ce qui ne change pas : adresse de page et routes d'API (aucun lien existant ne casse), sans ancien
 *             terme dans le fil d'Ariane ni dans les titres ;
 *   C806-V04  libellés les plus visibles (fiche, Agenda, Timeline, « À traiter », Assistant) : « opération », accordé
 *             au féminin ;
 *   C806-V05  sens distinct conservé : dans le tiroir de l'Agenda, l'événement qui porte l'ensemble est le « jalon de
 *             l'opération » ; un événement de l'AGENDA garde son nom ;
 *   C806-V06  l'ancien terme reste COMPRIS (Assistant : demandes écrites avec « événement de référence »), et les
 *             reprises au féminin (« à celle-ci », « à cette opération ») le sont aussi ;
 *   C806-V07  question formulée par l'IA : l'ancien terme est refusé (la formulation du code la remplace),
 *             « opération » est admis — sans le bloc 53 du guide du PO, l'écran dit quand même « opération » ;
 *   C806-V08  le bloc 53 est écrit dans le guide du PO ; aucun texte de prompt du dépôt n'est modifié.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { ANCIEN_TERME_806, FORMES_ANCIEN_TERME_806 } from '@/lib/reference-events/__tests__/textes-806';
import { GROUPING_LABELS, AGENDA_EVENT_LABELS } from '@/lib/agenda/grouping-view';
import { REFERENCE_EVENT_PAGE_LABELS, REFERENCE_EVENT_ROUTE, REFERENCE_EVENT_SEARCH_CATEGORY, referenceEventHref, referenceEventRelationLabel } from '@/lib/reference-events/reference-event-page';
import { REFERENCE_EVENT_SUCCESS, REFERENCE_EVENT_WRITE_LABELS, REFERENCE_EVENT_WRITE_MESSAGES } from '@/lib/reference-events/reference-event-write';
import { REFERENCE_EVENT_NOT_FOUND, REFERENCE_EVENT_TITLE } from '@/lib/documents/business-period-surfaces';
import { REFERENCE_EVENT_OPEN_LABEL } from '@/components/documents/ReferenceEventSheet';
import { TIMELINE_REFERENCE_EVENT_LINK } from '@/services/agenda/timeline/labels';
import { CARD_LINK_TEXT } from '@/lib/to-process-links';
import { WRITE_COMMAND_CATALOG } from '@/services/verebona-assistant/commands/catalog';
import { parseReferenceEventCommand } from '@/services/verebona-assistant/commands/reference-event-parser';
import { validateAiUserQuestion } from '@/services/to-process/ai-user-question';
import { getRule } from '@/services/to-process/rules-catalog';
import { MERGE_DISTINCT_LABEL, MERGE_SAME_LABEL, referenceEventMergeQuestion } from '@/services/to-process/operation-merge-cards';

const ROOT = process.cwd();
const lire = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/** Hors garde : tests, jeux d'essai, scénarios (ils citent l'ancien terme pour prouver qu'il est refusé ou compris). */
const HORS_GARDE = /(__tests__|__fixtures__|\/fixtures\/|\.test\.|\.e2e\.|^src\/test\/)/;

/**
 * Exceptions — liste FERMÉE (fichier → motifs des textes admis, et pourquoi). Tout autre texte fait échouer la garde.
 * Classes : IDENTIFIANT (texte technique comparé ou enregistré, jamais affiché), AUTRE OBJET (le mot ne désigne pas
 * l'opération), SQL (commentaire dans une requête), COMPRÉHENSION (forme sans accent lue dans la demande de
 * l'utilisateur). Les adresses (`/agenda/evenements-reference`, `/api/evenements-reference`) ne contiennent pas
 * l'ancien terme sous sa forme écrite : elles ne sont pas des exceptions de cette garde (voir C806-V03).
 */
const EXCEPTIONS: Readonly<Record<string, { classe: 'IDENTIFIANT' | 'AUTRE OBJET' | 'SQL' | 'COMPRÉHENSION'; motif: string; textes: readonly RegExp[] }>> = {
  // AUTRE OBJET — back-office « Diagnostic des notifications » : « événement de référence » y désigne l'ÉVÉNEMENT DE
  // NOTIFICATION de la file d'envoi (`notification_outbox`) auquel une livraison se rapporte, pas l'opération.
  'src/app/api/admin/notifications/diagnostic/[outboxId]/route.ts': { classe: 'AUTRE OBJET', motif: 'événement de la file des notifications (BO)', textes: [/^'Identifiant d’événement de référence invalide\.'$/, /^'Événement de référence introuvable\.'$/] },
  'src/components/admin/notifications/NotificationsDiagnostic.tsx': { classe: 'AUTRE OBJET', motif: 'événement de la file des notifications (BO)', textes: [/^'Livraisons — événement de référence, canal, appareil'$/, /^'File des événements de référence'$/, /^'Événement de référence'$/, /^"Événements de référence distincts"$/, /^Événement de référence$/] },
  'src/services/admin/notifications-diagnostic/model.ts': { classe: 'AUTRE OBJET', motif: 'événement de la file des notifications (BO)', textes: [/Événements? de référence/, /l’événement de référence \$\{$/, /^`Diagnostic d’un événement de référence — \$\{$/, /^'File des événements de référence'$/] },
  'src/services/admin/notifications-diagnostic/service.ts': { classe: 'AUTRE OBJET', motif: 'événement de la file des notifications (BO)', textes: [/^'Aucune livraison enregistrée pour cet événement de référence\.'$/] },
  // IDENTIFIANT — textes FIXES de déclarations techniques, ENREGISTRÉS en base et reconnus par égalité pour être
  // masqués à l'écran (décision du PO du 16/11/2026) : les changer ferait réapparaître les lignes déjà écrites.
  'src/services/business-operations/graph/reference-event-page.ts': { classe: 'IDENTIFIANT', motif: 'texte technique enregistré, comparé par égalité, jamais affiché', textes: [/^'Scission faite depuis la fiche d’un événement de référence\.'$/, /^'Prestataire choisi dans « À traiter », entre deux événements de référence associés\.'$/] },
  // IDENTIFIANT — libellé technique d'un signal d'identité transmis au rapprochement (donnée d'entrée, jamais affichée).
  'src/services/ai/reconciliation/document-asset/identity/signals.ts': { classe: 'IDENTIFIANT', motif: 'signal technique du rapprochement (entrée de traitement)', textes: [/^`événement de référence \$\{$/] },
  // SQL — commentaires « -- » à l'intérieur d'une requête.
  'src/services/business-operations/claims/agenda-chronology.ts': { classe: 'SQL', motif: 'commentaire SQL', textes: [/--[^\n]*événement de référence/] },
  'src/services/business-operations/rebuild/purge.ts': { classe: 'SQL', motif: 'commentaire SQL', textes: [/--[^\n]*événement de référence/] },
  'src/services/suppliers/supplier-detail.service.ts': { classe: 'SQL', motif: 'commentaire SQL', textes: [/--[^\n]*événement de référence/] },
  // COMPRÉHENSION — formes SANS ACCENT comparées à la demande normalisée de l'utilisateur : l'ancien terme reste compris.
  'src/services/verebona-assistant/commands/action-hints.ts': { classe: 'COMPRÉHENSION', motif: 'ancien terme encore compris (texte normalisé)', textes: [/evenement de reference/] },
  'src/services/verebona-assistant/commands/reference-event-parser.ts': { classe: 'COMPRÉHENSION', motif: 'ancien terme encore compris (texte normalisé)', textes: [/^'evenement de reference'$/] },
};

function fichiers(dir: string, out: string[] = []): string[] {
  for (const nom of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${nom}`;
    if (HORS_GARDE.test(rel)) continue;
    if (statSync(join(ROOT, rel)).isDirectory()) fichiers(rel, out);
    else if (/\.(ts|tsx)$/.test(nom)) out.push(rel);
  }
  return out;
}

/** Textes VISIBLES d'un fichier (chaînes, gabarits, textes JSX, expressions régulières) qui contiennent l'ancien terme. */
function textesAvecAncienTerme(rel: string, source: string): Array<{ ligne: number; texte: string }> {
  const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true, rel.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: Array<{ ligne: number; texte: string }> = [];
  const K = ts.SyntaxKind;
  const visiter = (n: ts.Node): void => {
    const k = n.kind;
    if (k === K.StringLiteral || k === K.NoSubstitutionTemplateLiteral || k === K.TemplateHead || k === K.TemplateMiddle || k === K.TemplateTail
      || k === K.JsxText || k === K.RegularExpressionLiteral) {
      const texte = source.slice(k === K.JsxText ? n.pos : n.getStart(sf), n.end);
      if (ANCIEN_TERME_806.test(texte)) out.push({ ligne: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, texte: texte.trim() });
    }
    ts.forEachChild(n, visiter);
  };
  visiter(sf);
  return out;
}

describe('C806-V01 — la garde reconnaît toutes les formes de l’ancien terme', () => {
  it('singulier, pluriel, majuscules, sans accents, espaces insécables, retour à la ligne', () => {
    for (const f of FORMES_ANCIEN_TERME_806) expect(f, f).toMatch(ANCIEN_TERME_806);
  });
  it('ni les identifiants techniques, ni les autres emplois de « événement » et de « référence »', () => {
    for (const t of ['/agenda/evenements-reference/12', '/api/evenements-reference/12/documents', 'reference-event-page', 'business_operations', 'REFERENCE_EVENT',
      'Événements associés', 'événement de l’Agenda', 'événement de l’opération', 'jalon de l’opération', 'référence de commande', 'Opération', 'une autre opération']) {
      expect(t, t).not.toMatch(ANCIEN_TERME_806);
    }
  });
});

describe('C806-V02 — GARDE : aucun texte visible ne dit « événement de référence »', () => {
  const trouves = new Map<string, Array<{ ligne: number; texte: string }>>();
  for (const rel of fichiers('src')) {
    const source = lire(rel);
    if (!ANCIEN_TERME_806.test(source)) continue;
    const textes = textesAvecAncienTerme(rel, source);
    if (textes.length) trouves.set(rel, textes);
  }

  it('toutes les surfaces (client, routes, Assistant, « À traiter », e-mails, exports, back-office) : rien hors de la liste fermée', () => {
    const fautes: string[] = [];
    for (const [rel, textes] of trouves) {
      const admis = EXCEPTIONS[rel]?.textes ?? [];
      for (const t of textes) if (!admis.some((re) => re.test(t.texte))) fautes.push(`${rel}:${t.ligne} ${t.texte.slice(0, 160)}`);
    }
    expect(fautes).toEqual([]);
  });

  it('la liste d’exceptions est fermée ET vivante : chaque fichier listé porte encore un texte admis', () => {
    for (const [rel, e] of Object.entries(EXCEPTIONS)) {
      expect(trouves.has(rel), `${rel} (${e.classe} : ${e.motif}) ne porte plus l’ancien terme : retirez-le de la liste`).toBe(true);
      for (const re of e.textes) expect((trouves.get(rel) ?? []).some((t) => re.test(t.texte)), `${rel} ${re}`).toBe(true);
    }
    expect(Object.keys(EXCEPTIONS)).toHaveLength(11);
  });

  it('fichiers non TypeScript servis à l’utilisateur (e-mails par défaut, pages publiques, application mobile) : aucun ancien terme', () => {
    const autres: string[] = [];
    const parcourir = (dir: string): void => {
      for (const nom of readdirSync(join(ROOT, dir))) {
        const rel = `${dir}/${nom}`;
        if (/node_modules|\/\.|\/android\/|\/ios\/|__tests__|\/fixtures\/|\/migrations\/|\/prompts\//.test(rel)) continue;
        const st = statSync(join(ROOT, rel));
        if (st.isDirectory()) parcourir(rel);
        else if (/\.(json|html|md|txt|css|xml|webmanifest)$/.test(nom) && st.size < 2_000_000 && ANCIEN_TERME_806.test(lire(rel))) autres.push(rel);
      }
    };
    for (const d of ['src', 'public', 'mobile']) parcourir(d);
    expect(autres).toEqual([]);
  });
});

describe('C806-V03 — ce qui ne change pas : adresses et identifiants techniques', () => {
  it('l’adresse de page et les routes d’API gardent leur forme (aucun lien existant ne casse)', () => {
    expect(REFERENCE_EVENT_ROUTE).toBe('/agenda/evenements-reference');
    expect(referenceEventHref(12)).toBe('/agenda/evenements-reference/12');
    for (const p of ['src/app/(dashboard)/agenda/evenements-reference/page.tsx', 'src/app/(dashboard)/agenda/evenements-reference/[id]/page.tsx',
      'src/app/api/evenements-reference/route.ts', 'src/app/api/evenements-reference/[id]/fiche/route.ts', 'src/app/api/documents/[id]/evenements-reference/route.ts']) {
      expect(statSync(join(ROOT, p)).isFile(), p).toBe(true);
    }
  });
  it('fil d’Ariane et titres des deux pages : libellés seulement, jamais un segment d’adresse', () => {
    const liste = lire('src/app/(dashboard)/agenda/evenements-reference/page.tsx');
    const fiche = lire('src/app/(dashboard)/agenda/evenements-reference/[id]/page.tsx');
    expect(liste).toContain('setBreadcrumbs([{ label: "Mon agenda", href: AGENDA_ROUTE }, { label: L.title }]);');
    expect(fiche).toContain('setBreadcrumbs([{ label: "Mon agenda", href: AGENDA_ROUTE }, { label: fiche?.title ?? REFERENCE_EVENT_TITLE }]);');
    expect(REFERENCE_EVENT_TITLE).toBe('Opération');
    for (const s of [liste, fiche]) expect(textesAvecAncienTerme('page.tsx', s)).toEqual([]);
    // Aucune métadonnée de page (<title>, generateMetadata) ne reprend le segment d'adresse.
    for (const s of [liste, fiche]) expect(s).not.toMatch(/generateMetadata|export const metadata|document\.title/);
  });
});

describe('C806-V04 — libellés les plus visibles : « opération », accordé au féminin', () => {
  it('fiche : titre, rubriques, messages, confirmations', () => {
    expect(REFERENCE_EVENT_SEARCH_CATEGORY).toBe('Opération');
    expect(REFERENCE_EVENT_PAGE_LABELS.relationsTitle).toBe('Opérations associées');
    expect(REFERENCE_EVENT_PAGE_LABELS.notFound).toBe('Cette opération est introuvable dans votre compte.');
    expect(REFERENCE_EVENT_PAGE_LABELS.notFoundHint).toBe('Elle a peut-être été regroupée ou supprimée, ou elle appartient à un autre compte.');
    expect(REFERENCE_EVENT_PAGE_LABELS.shared).toBe('Partagé avec une autre opération');
    expect(REFERENCE_EVENT_PAGE_LABELS.dateRoles).toEqual({ PLANNED: 'Prévue le', START: 'Début', REALIZED: 'Réalisée le', END: 'Fin' });
    expect(referenceEventRelationLabel('ASSOCIATED', 'UNDIRECTED')).toBe('Associée à');
    expect(referenceEventRelationLabel('FINANCING', 'INCOMING')).toBe('Financée par');
    expect(referenceEventRelationLabel('CLAIM_REPAIR', 'OUTGOING')).toBe('Réparée par');
    expect(REFERENCE_EVENT_SUCCESS.delete).toBe('Opération supprimée.');
    expect(REFERENCE_EVENT_SUCCESS.associate).toBe('Opérations associées.');
    expect(REFERENCE_EVENT_SUCCESS.split).toBe('Opération scindée. La nouvelle est associée à celle-ci.');
    expect(REFERENCE_EVENT_WRITE_MESSAGES.OPERATION_INACTIVE).toBe('Cette opération a été supprimée ou regroupée : elle ne peut plus être modifiée.');
    expect(REFERENCE_EVENT_WRITE_MESSAGES.REFLEXIVE).toBe('Une opération ne peut pas être reliée à elle-même.');
    expect(REFERENCE_EVENT_WRITE_LABELS.deleteTitle).toBe('Supprimer cette opération ?');
    expect(REFERENCE_EVENT_WRITE_LABELS.splitTitle).toBe('Scinder cette opération');
    expect(REFERENCE_EVENT_WRITE_LABELS.splitLabelField).toBe('Intitulé de la nouvelle opération');
    expect(REFERENCE_EVENT_WRITE_LABELS.associate).toBe('Associer une opération');
    expect(REFERENCE_EVENT_NOT_FOUND).toBe('Impossible d’ouvrir cette opération : elle a peut-être été regroupée ou supprimée.');
    // Aucun accord masculin oublié après « opération » dans les textes de la fiche.
    const valeurs: readonly unknown[] = [...Object.values(REFERENCE_EVENT_SUCCESS), ...Object.values(REFERENCE_EVENT_WRITE_MESSAGES),
      ...Object.values(REFERENCE_EVENT_WRITE_LABELS), ...Object.values(REFERENCE_EVENT_PAGE_LABELS)];
    const tous = valeurs.filter((v): v is string => typeof v === 'string');
    for (const t of tous) {
      expect(t, t).not.toMatch(ANCIEN_TERME_806);
      expect(t, t).not.toMatch(/\b(?:un|le|cet|ce|du|au|aucun|nouvel|quel|lequel|un autre|le même)\s+opérations?\b/i);
      expect(t, t).not.toMatch(/opérations?\s+(?:supprimé|scindé|modifié|regroupé|associés|dissociés|distincts|créé|relié|actifs?)(?![a-zé])/i);
    }
  });
  it('Agenda, Timeline, tiroirs, « À traiter » : « Voir l’opération »', () => {
    expect(REFERENCE_EVENT_OPEN_LABEL).toBe('Voir l’opération');
    expect(TIMELINE_REFERENCE_EVENT_LINK).toBe('Voir l’opération');
    expect(CARD_LINK_TEXT.reference).toBe('Voir l’opération');
  });
  it('« À traiter » : questions du catalogue et réponses de la carte de fusion', () => {
    expect(getRule('REFERENCE-EVENT-MERGE')!.question).toBe('Ces deux opérations décrivent peut-être la même réalité : est-ce la même, ou deux ?');
    expect(referenceEventMergeQuestion('A', 'B')).toBe('« A » et « B » : est-ce la même opération, ou deux ?');
    expect(MERGE_SAME_LABEL).toBe('Oui, c’est la même');
    expect(MERGE_DISTINCT_LABEL).toBe('Non, ce sont deux opérations différentes');
  });
  it('Assistant : textes du catalogue montrés à l’utilisateur', () => {
    const libelles = Object.values(WRITE_COMMAND_CATALOG).map((d) => d.label);
    for (const l of libelles) expect(l, l).not.toMatch(ANCIEN_TERME_806);
    expect(WRITE_COMMAND_CATALOG.CREATE_REFERENCE_EVENT.label).toBe('Enregistrer une opération');
    expect(WRITE_COMMAND_CATALOG.ASSOCIATE_REFERENCE_EVENTS.label).toBe('Associer deux opérations');
    expect(WRITE_COMMAND_CATALOG.UNLINK_DOCUMENT_REFERENCE_EVENT.label).toBe('Retirer un document d’une opération');
    expect(WRITE_COMMAND_CATALOG.LINK_DOCUMENT_REFERENCE_EVENT.label).toBe('Rattacher un document à une opération');
    // Aucune commande « déplacer un document » dans le catalogue (carte #807 E09, confirmé ici).
    expect(Object.keys(WRITE_COMMAND_CATALOG).filter((k) => /MOVE.*DOCUMENT|DOCUMENT.*MOVE/.test(k))).toEqual([]);
    expect(libelles.filter((l) => /déplacer un document/i.test(l))).toEqual([]);
  });
});

describe('C806-V05 — sens distincts : jalon de l’opération, événement de l’Agenda', () => {
  it('tiroir de l’Agenda : l’événement qui porte l’ensemble est le « jalon de l’opération »', () => {
    expect(GROUPING_LABELS.mainBadge).toBe('Jalon de l’opération');
    expect(GROUPING_LABELS.makeMain).toBe('En faire le jalon de l’opération');
    expect(GROUPING_LABELS.releaseMain).toBe('Ne plus en faire le jalon de l’opération');
    expect(GROUPING_LABELS.releaseTitle).toBe('Ne plus en faire le jalon de l’opération ?');
    expect(GROUPING_LABELS.releaseBody).toContain('Verebona ne rétablira pas ce jalon de lui-même ; vous pourrez en désigner un autre à tout moment.');
    expect(GROUPING_LABELS.withdrawnNote).toBe('Aucun jalon pour cette opération : vous l’avez retiré.');
  });
  it('un événement de l’AGENDA garde son nom', () => {
    expect(AGENDA_EVENT_LABELS.event).toBe('Événement');
    expect(AGENDA_EVENT_LABELS.linkedEvents).toBe('Événements associés');
    expect(REFERENCE_EVENT_PAGE_LABELS.eventsTitle).toBe('Événements');
    expect(REFERENCE_EVENT_SUCCESS.linkAgenda).toBe('Événement rattaché.');
    expect(REFERENCE_EVENT_WRITE_LABELS.pickerAgendaTitle).toBe('Rattacher un événement de votre agenda');
  });
});

describe('C806-V06 — l’ancien terme reste compris par l’Assistant ; le féminin aussi', () => {
  const lu = (phrase: string) => parseReferenceEventCommand(phrase, '2026-11-20');
  it('« événement de référence » et « opération » : même commande', () => {
    const ancien = lu('Supprime l’événement de référence Vidange du 12 mars 2025');
    const nouveau = lu('Supprime l’opération Vidange du 12 mars 2025');
    expect(ancien?.command).toBe('INVALIDATE_REFERENCE_EVENT');
    expect(nouveau).toEqual(ancien);
  });
  it('« … à celle-ci », « … à cette opération » : l’opération de l’action précédente', () => {
    const suite = (reprise: string) => parseReferenceEventCommand(`Relie le fournisseur Garage Martin ${reprise}`, '2026-11-20', true);
    const masculin = suite('à celui-ci');
    expect(masculin).toMatchObject({ command: 'LINK_SUPPLIER_REFERENCE_EVENT', target: { fromContext: true, pronounOnly: true } });
    for (const reprise of ['à celle-ci', 'à cette opération', 'à cette dernière', 'à la même']) expect(suite(reprise), reprise).toEqual(masculin);
  });
});

describe('C806-V07 — question formulée par l’IA', () => {
  const ctx = { allowedLabels: ['Maison'] };
  it('l’ancien terme est refusé (repli sur la formulation du code), « opération » est admis', () => {
    expect(validateAiUserQuestion('Ce document concerne-t-il le même événement de référence que « Maison » ?', ctx)).toEqual({ ok: false, code: 'FORBIDDEN_TERM' });
    expect(validateAiUserQuestion('Ce document concerne-t-il la même opération que « Maison » ?', ctx).ok).toBe(true);
  });
});

describe('C806-V08 — bloc 53 du guide du PO ; aucun prompt modifié dans le code', () => {
  const guide = lire('docs/exploitation/prompts-a-appliquer-par-le-po.md');
  it('le bloc 53 existe, à la fin du guide, et donne les textes exacts à remplacer', () => {
    const debut = guide.indexOf('## 23. Étape 53 — ');
    expect(debut).toBeGreaterThan(guide.indexOf('## 22. Étape 61 — '));
    const bloc = guide.slice(debut);
    for (const repere of ['t3-user-question-v1', 't4-user-question-v1', 'FACULTATIVE', '### Où coller', '### Vérifier après activation', '### Retour arrière']) expect(bloc, repere).toContain(repere);
    // Les trois passages à REMPLACER sont cités à l'identique des blocs 24 et 25 déjà livrés.
    for (const ancien of [
      'aucun terme technique (identifiant, score, candidat, code, nom de traitement), jamais le mot « opération ».',
      'Jamais le mot « opération » : nomme la réalité (intervention, contrat, achat, sinistre…) ou dis « événement de référence ».',
      'qui dit quel événement de l’agenda pourrait représenter l’événement de référence et ce qui reste incertain',
    ]) {
      expect(guide.slice(0, debut), ancien).toContain(ancien);
      expect(bloc, ancien).toContain(ancien);
    }
    expect(bloc).toMatch(/n’emploie jamais « événement de référence »/);
  });
  it('les prompts du dépôt ne sont pas modifiés par cette carte (ils ne contenaient pas l’ancien terme)', () => {
    const dossier = 'src/services/ai/prompts';
    const parcourir = (dir: string, out: string[] = []): string[] => {
      for (const nom of readdirSync(join(ROOT, dir))) {
        const rel = `${dir}/${nom}`;
        if (statSync(join(ROOT, rel)).isDirectory()) parcourir(rel, out); else if (/\.txt$/.test(nom)) out.push(rel);
      }
      return out;
    };
    const prompts = parcourir(dossier);
    expect(prompts.length).toBeGreaterThan(0);
    for (const p of prompts) expect(lire(p), p).not.toMatch(ANCIEN_TERME_806);
  });
});
