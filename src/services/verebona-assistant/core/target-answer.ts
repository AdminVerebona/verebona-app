/**
 * Lectures ciblées — CDC 15 T2-19, T2-20, T2-21 (lot 15,
 * ASSISTANT_CANONICAL_READ=enabled).
 *
 * « Quel est le montant ? » posé sur la page d'un ticket, « et son montant ? »
 * après avoir cité une facture, « et sa date ? » après avoir cité une
 * échéance : la question vise UN objet déjà connu. Elle se lit sur cet
 * objet, par la couche canonique de X (`getCanonicalDocumentState`,
 * `getCanonicalAgendaItem`), AVANT toute analyse textuelle qui la ferait
 * repartir sur l'ensemble du compte.
 *
 * Garde-fou : la lecture ciblée ne s'applique que si la question ne nomme
 * rien d'autre (« le montant de la facture Norauto », depuis un autre
 * document, suit la recherche normale). Sans modèle ; bornée au compte.
 */
import type { Claim, RetrievedSource } from '../types/sources';
import type { VerebonaIntent } from '../types/intents';
import type { AssistantTargets } from './assistant-targets';
import type { CanonicalDocumentState } from '../canonical/document-state';
import type { CanonicalAgendaItem } from '../canonical/agenda';
import { formatAmountCents, formatDateFr, joinFr } from './deterministic-format';
import { ANALYSIS_STATUS_LABELS, IN_ANALYSIS_MESSAGE } from './document-status';
import { tokenizeQuery, DOCUMENT_TYPE_STEMS } from './query-terms';
import type { CanonicalFieldReading } from '../canonical/field-reader';
import type { RouteUnderstanding } from '../types/contracts';

export interface TargetAnswer {
  text: string;
  sources: RetrievedSource[];
  claims: Claim[];
  strategy: string;
  intent: Extract<VerebonaIntent, 'ACCOUNT_FACT_DOCUMENT' | 'ACCOUNT_FACT_AGENDA' | 'ACCOUNT_FACT_ASSET'>;
}

export type DocumentAttribute = 'amount' | 'supplier' | 'date' | 'type' | 'assets';
export type AgendaAttribute = 'status' | 'date';

const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’]/g, "'");

const DOC_ATTRS: Array<[DocumentAttribute, RegExp]> = [
  ['amount', /\b(montant|prix|cout|coute|total|combien\b[\s\S]*\b(coute|paye|payee|facture|regle))\b/],
  ['supplier', /\b(fournisseur|emetteur|emis par|vendeur|prestataire|artisan|garage|qui l'a (emis|fait|fourni))\b/],
  ['date', /\b(date|quand|daté|datee?)\b/],
  ['type', /\b(type|genre|sorte|categorie|nature) (de|du) (document|fichier)\b|\bc'est quel (type|genre)\b|\bquel type\b/],
  ['assets', /\b(quel(s|le|les)? biens?|a quel bien|rattache\w*|lie a quoi|concerne quel)\b/],
];

const AGENDA_ATTRS: Array<[AgendaAttribute, RegExp]> = [
  ['status', /\b(fait|faite|realise|realisee|effectue|effectuee|termine|terminee|statut|etat|eu lieu|confirme|confirmee|en retard|annule|annulee)\b/],
  ['date', /\b(date|quand|prevu|prevue|a quelle date|jour)\b/],
];

/** Attribut de document demandé (pure, testée). */
export function documentAttributeOf(message: string): DocumentAttribute | null {
  const m = plain(message);
  for (const [a, re] of DOC_ATTRS) if (re.test(m)) return a;
  return null;
}

/** Attribut d'échéance demandé (pure, testée). */
export function agendaAttributeOf(message: string): AgendaAttribute | null {
  const m = plain(message);
  for (const [a, re] of AGENDA_ATTRS) if (re.test(m)) return a;
  return null;
}

/** Mots qui désignent l'attribut ou l'objet déjà ciblé, sans rien nommer d'autre. */
const MOTS_DE_SUIVI = new Set([
  'montant', 'prix', 'cout', 'coute', 'total', 'paye', 'payee', 'regle', 'fournisseur', 'emetteur', 'emi', 'emis', 'vendeur',
  'prestataire', 'artisan', 'garage', 'date', 'datee', 'type', 'genre', 'sorte', 'categorie', 'nature', 'rattache', 'rattachee',
  'lie', 'concerne', 'bien', 'biens', 'statut', 'etat', 'fait', 'faite', 'realise', 'realisee', 'effectue', 'effectuee',
  'termine', 'terminee', 'lieu', 'confirme', 'confirmee', 'retard', 'annule', 'annulee', 'prevu', 'prevue', 'jour', 'eu',
  'document', 'fichier', 'echeance', 'rappel', 'evenement', 'celui', 'celle', 'ci', 'la', 'lui', 'quoi', 'deja', 'bien',
  'et', 'alors', 'du', 'coup', 'ete', 'etait', 'bien', 'vraiment', 'exact', 'exacte', 'combien', 'quel', 'quelle', 'rendez', 'vous', 'intervention', 'ticket',
]);

/**
 * La question ne nomme-t-elle rien d'autre que l'objet ciblé (pure, testée) ?
 * « Quel est le montant ? », « et son montant ? », « le montant de cette
 * facture ? » : oui. « Le montant de la facture Norauto ? » : non.
 */
export function asksOnlyAboutTarget(message: string): boolean {
  return tokenizeQuery(message).every((t) => !t.exact
    && (MOTS_DE_SUIVI.has(t.stem) || MOTS_DE_SUIVI.has(t.raw) || DOCUMENT_TYPE_STEMS.has(t.stem)));
}

const docSource = (d: CanonicalDocumentState): RetrievedSource => ({
  id: `doc_${d.fileId}`,
  type: 'document',
  title: d.title,
  content: [
    d.documentTypeLabel ?? d.catalogCode, d.documentDate, d.supplier ? `fournisseur ${d.supplier}` : null,
    d.amountCents != null ? `montant ${formatAmountCents(d.amountCents)}` : null,
    d.assets.length ? `bien${d.assets.length > 1 ? 's' : ''} : ${d.assets.map((a) => a.name).join(', ')}` : null,
  ].filter(Boolean).join(' · ').slice(0, 1500),
  relevanceScore: 1,
  meta: {
    documentId: d.fileId, date: d.documentDate, assetId: d.assets[0]?.assetId ?? null, assetName: d.assets[0]?.name ?? null,
    statusLabel: ANALYSIS_STATUS_LABELS[d.analysisStatus as keyof typeof ANALYSIS_STATUS_LABELS] ?? null,
  },
});

/** Fait T1 dont la clé ou le libellé correspond à un motif. */
const factOf = (d: CanonicalDocumentState, re: RegExp) =>
  d.facts.find((f) => f.value && (re.test(plain(f.key)) || re.test(plain(f.label ?? '')) || re.test(plain(f.canonicalKey ?? ''))));

/** Réponse sur un document ciblé (pure, testée). */
export function documentTargetAnswer(d: CanonicalDocumentState, attr: DocumentAttribute): TargetAnswer {
  const t = `« ${d.title} »`;
  const enAnalyse = d.analysisStatus === 'IN_ANALYSIS' ? ` ${IN_ANALYSIS_MESSAGE}` : '';
  let text: string;
  switch (attr) {
    case 'amount': {
      const f = d.amountCents == null ? factOf(d, /amount|montant|total|price|prix/) : undefined;
      text = d.amountCents != null
        ? `Le montant de ${t} est de ${formatAmountCents(d.amountCents)}.`
        : f ? `Le document ${t} indique ${(f.label ?? 'un montant').toLowerCase()} : ${f.value}${f.unit ? ` ${f.unit}` : ''}.`
          : `Aucun montant n’est enregistré pour ${t}.${enAnalyse}`;
      break;
    }
    case 'supplier': {
      const f = !d.supplier ? factOf(d, /supplier|fournisseur|vendor|emetteur|issuer/) : undefined;
      text = d.supplier ? `Le fournisseur de ${t} est ${d.supplier}.`
        : f ? `Le document ${t} indique comme fournisseur : ${f.value}.`
          : `Aucun fournisseur n’est enregistré pour ${t}.${enAnalyse}`;
      break;
    }
    case 'date':
      text = d.documentDate ? `${t} est daté du ${formatDateFr(d.documentDate)}.` : `Aucune date n’est enregistrée pour ${t}.${enAnalyse}`;
      break;
    case 'type': {
      const lib = d.documentTypeLabel ?? d.catalogCode;
      text = lib ? `${t} est classé comme : ${lib}${d.rubricLabel ? ` (rubrique ${d.rubricLabel})` : ''}.` : `Le type de ${t} n’est pas encore renseigné.`;
      break;
    }
    case 'assets':
      text = d.assets.length
        ? `${t} est rattaché à ${joinFr(d.assets.map((a) => a.name))}.`
        : `${t} n’est rattaché à aucun bien.`;
      break;
  }
  const sources = [docSource(d)];
  return {
    text, sources, strategy: `target.document_${attr}`, intent: 'ACCOUNT_FACT_DOCUMENT',
    claims: [{ claimKey: `document:${attr}`, text, sourceIds: sources.map((s) => s.id), derivation: 'direct' }],
  };
}

/** Réponse sur une échéance ciblée (pure, testée) — statut à 4 états. */
export function agendaTargetAnswer(i: CanonicalAgendaItem, attr: AgendaAttribute, today: string): TargetAnswer {
  const t = `« ${i.title} »`;
  const quand = i.date ? formatDateFr(i.date) : null;
  let text: string;
  if (attr === 'date') {
    text = !quand ? `Aucune date n’est enregistrée pour ${t}.`
      : i.nature === 'HISTORICAL' ? `${t} a eu lieu le ${quand}.`
        : i.forecast ? `${t} est prévu le ${quand} (date prévisionnelle, à confirmer par un document).`
          : `${t} est ${i.date! < today ? 'prévu depuis le' : 'prévu le'} ${quand}.`;
  } else {
    switch (i.status) {
      case 'completed': text = `${t} est marqué comme réalisé${quand ? ` (échéance du ${quand})` : ''}.`; break;
      case 'not_completed': text = `${t} est marqué comme annulé : il n’aura pas lieu.`; break;
      case 'unknown': text = `La réalisation de ${t} est à confirmer : une question vous attend dans « À traiter ».`; break;
      default:
        text = i.nature === 'HISTORICAL'
          ? `${t} est un fait passé${quand ? ` (${quand})` : ''}, enregistré dans votre historique.`
          : i.date && i.date < today
            ? `Aucune réalisation n’est enregistrée pour ${t}, prévu le ${quand} : une date passée ne prouve pas qu’il a été fait. Vous pouvez le marquer comme réalisé depuis l’agenda.`
            : `${t} est à venir${quand ? ` (le ${quand})` : ''}.`;
    }
  }
  const src: RetrievedSource = {
    id: `agenda_${i.id}`, type: 'agenda_item', title: i.title,
    content: [i.date, i.status, i.nature === 'HISTORICAL' ? 'fait passé' : null, i.forecast ? 'date prévisionnelle' : null,
      i.assets.map((a) => a.name).join(', ') || null].filter(Boolean).join(' · '),
    relevanceScore: 1,
    meta: { agendaItemId: i.id, date: i.date, assetId: i.assets[0]?.assetId ?? null },
  };
  return {
    text, sources: [src], strategy: `target.agenda_${attr}`, intent: 'ACCOUNT_FACT_AGENDA',
    claims: [{ claimKey: `agenda:${attr}`, text, sourceIds: [src.id], derivation: 'direct' }],
  };
}

/** Lecteurs canoniques (couche de X), injectables pour les tests. */
export interface TargetReaders {
  document(accountId: number, fileId: number): Promise<CanonicalDocumentState | null>;
  agenda(accountId: number, itemId: number): Promise<CanonicalAgendaItem | null>;
  /** Champ canonique d'un bien (`readCanonicalField` de X). */
  field?(accountId: number, assetId: number, key: string): Promise<CanonicalFieldReading | null>;
  today(): string;
}

const lecteursCanoniques: TargetReaders = {
  document: async (a, f) => (await import('../canonical/document-state')).getCanonicalDocumentState(a, f),
  agenda: async (a, i) => (await import('../canonical/agenda')).getCanonicalAgendaItem(a, i),
  field: async (a, id, k) => (await import('../canonical/field-reader')).readCanonicalField(a, id, k),
  today: () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()),
};

/**
 * Lecture ciblée, ou `null` : aucune cible document / échéance, question sur
 * autre chose, ou objet introuvable dans le compte. Une cible de PAGE
 * n'est retenue que si la question ne nomme rien d'autre ; une cible du
 * fil ou d'une clarification a déjà été désignée par l'utilisateur.
 */
export async function answerFromTarget(
  accountId: number,
  message: string,
  targets: AssistantTargets,
  readers: TargetReaders = lecteursCanoniques,
  understanding?: RouteUnderstanding,
): Promise<TargetAnswer | null> {
  // Master T2 (A4) : UN champ demandé du FIELD_CATALOG sur UN bien ciblé →
  // lu sur la fiche canonique (valeur, origine, preuve, conflit).
  const faits = understanding?.requestedFacts ?? [];
  if (faits.length === 1 && targets.asset && targets.namedAssets.length <= 1 && readers.field) {
    const r = await readers.field(accountId, targets.asset.id, faits[0]);
    if (r && !r.sensitive && r.value !== null && r.value !== undefined && r.display) {
      const [{ fieldAnswer }, { assetFieldSource }] = await Promise.all([
        import('../canonical/structured-answers'), import('../canonical/field-reader'),
      ]);
      const text = fieldAnswer(r);
      const src = assetFieldSource(r);
      return {
        text, sources: [src], strategy: 'target.asset_field', intent: 'ACCOUNT_FACT_ASSET',
        claims: [{ claimKey: `field:${r.key}`, text, sourceIds: [src.id], derivation: 'direct' }],
      };
    }
  }
  const seul = asksOnlyAboutTarget(message);
  const cibles = [targets.primary, targets.agendaItem, targets.document]
    .filter((c): c is NonNullable<typeof c> => !!c && (c.type === 'document' || c.type === 'agenda_item'));
  for (const c of cibles) {
    if (!seul) return null;
    if (c.type === 'agenda_item') {
      const attr = agendaAttributeOf(message);
      if (!attr) continue;
      const item = await readers.agenda(accountId, c.id);
      if (!item) return null;
      return agendaTargetAnswer(item, attr, readers.today());
    }
    if (c.type === 'document') {
      const attr = documentAttributeOf(message);
      if (!attr) continue;
      const d = await readers.document(accountId, c.id);
      if (!d) return null;
      return documentTargetAnswer(d, attr);
    }
  }
  return null;
}
