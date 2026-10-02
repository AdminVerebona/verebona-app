/**
 * Réponses structurées CANONIQUES — CDC 15 T2-04, T2-15, T2-22, T2-23,
 * T2-24, T2-32 (lot 15). Appelées par `data-answer.service` (niveau 1) ;
 * aucun appel modèle.
 *
 *   · structured.asset_field          « Quel est le kilométrage de la Clio ? »,
 *                                     « Quand ai-je acheté la maison ? » — un champ
 *                                     du registre lu par `readCanonicalField`
 *                                     (valeur, origine, preuve, conflit ouvert),
 *                                     source `asset_field:<id>:<clé>` ;
 *   · structured.upcoming_agenda      « Quelles échéances arrivent bientôt ? » —
 *                                     fenêtre (« 3 prochains mois », défaut 30 j),
 *                                     tri, statut prévisionnel, HISTORICAL exclu ;
 *   · structured.missing_information  « Qu'est-ce qui manque sur mes fiches ? » —
 *                                     règles de complétude du registre + À traiter ;
 *   · structured.sum_qualified        « Combien ai-je dépensé en entretien ? » —
 *                                     dépenses qualifiées par thème, couverture
 *                                     incomplète signalée, jamais de somme brute.
 */
import { listFields, type CanonicalFieldDef } from '@/services/canonical/registry';
import type { Claim, RetrievedSource } from '../types/sources';
import type { AccountDataPort, AssetRow } from '../core/data-answer.service';
import {
  daysBetween, formatAmountCents, formatDateFr, formatList, formatNoResult, formatRelativeDays, joinFr,
} from '../core/deterministic-format';
import { assetFieldSource, assetFieldSourceId, type CanonicalFieldReading } from './field-reader';
import { EXPENSE_THEME_LABELS, expenseThemeOf, expenseSumSource } from './expenses';

export interface ScopeLike { assets: AssetRow[]; ambiguous: boolean; unresolved: boolean; label: string | null }

export type CanonicalStrategy =
  | 'structured.asset_field' | 'structured.upcoming_agenda' | 'structured.missing_information' | 'structured.sum_qualified';

export type CanonicalLevel1 =
  | { strategy: CanonicalStrategy; answer: string; sources: RetrievedSource[]; claims: Claim[]; kind: 'exact' | 'list' | 'calc' | 'no_result' | 'conflict' }
  | { ambiguous: AssetRow[]; reason: string }
  | null;

const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’]/g, "'");
const claim = (key: string, text: string, sources: RetrievedSource[], derivation: Claim['derivation']): Claim =>
  ({ claimKey: key, text, sourceIds: sources.map((s) => s.id), derivation });
const assetSrc = (a: AssetRow): RetrievedSource =>
  ({ id: `asset_${a.id}`, type: 'asset_field', title: a.name, content: [a.category, a.subtype].filter(Boolean).join(' · '), relevanceScore: 1, meta: { assetId: a.id } });

// ── Champ du registre désigné par une question (T2-22) ─────────────────────

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Formulations d'un champ : phrases de l'assistant et libellé (sans accents). */
function phrasesOf(d: CanonicalFieldDef): string[] {
  return [...new Set([...(d.assistantPhrases ?? []), plain(d.label)].map(plain).filter((p) => p.length >= 4))];
}

/** Champ LISIBLE désigné par le message ; la formulation la plus longue gagne (pure, testée). */
export function findReadableField(message: string): { def: CanonicalFieldDef; phrase: string } | null {
  const m = plain(message);
  let best: { def: CanonicalFieldDef; phrase: string } | null = null;
  for (const d of listFields()) {
    if (!d.assistantReadable || d.sensitive) continue;
    for (const p of phrasesOf(d)) {
      if (new RegExp(`(^|[^a-z])${esc(p)}($|[^a-z])`).test(m) && (!best || p.length > best.phrase.length)) best = { def: d, phrase: p };
    }
  }
  return best;
}

/** « Quand ai-je acheté… » : la date d'achat, champ `acquisitionDate` (T2-23). */
function purchaseQuestion(message: string): { def: CanonicalFieldDef; phrase: string } | null {
  const hit = /\b(achete\w*|acquis\w*)\b/.exec(plain(message));
  const def = hit ? listFields().find((d) => d.key === 'acquisitionDate') : undefined;
  return hit && def ? { def, phrase: hit[1] } : null;
}

/** Question de LECTURE (pas une commande, pas un comptage) (pure, testée). */
export function isFieldQuestion(message: string): boolean {
  const m = plain(message);
  if (/\b(combien de|nombre de)\b/.test(m)) return false;
  if (/^\s*(mets|met|modifie|change|remplace|fixe|corrige|renseigne)\b/.test(m)) return false;
  return /\?|\b(quel|quelle|quels|quelles|quand|combien|rappelle|donne|indique|dis-moi|c'est quoi|a quelle date)\b/.test(m);
}

// ── Échéances à venir (T2-15) ──────────────────────────────────────────────

/** Liste d'échéances demandée ; fenêtre en jours, ou `undefined` (pure, testée). */
export function upcomingAgendaRequest(message: string): { windowDays: number } | null {
  const m = plain(message);
  const liste = /\b(echeances|rendez-vous|evenements|rappels|dates importantes)\b/.test(m);
  const futur = /\b(bientot|a venir|prochain(e)?s?|arrivent|cette semaine|ce mois|dans les?)\b/.test(m);
  if (!liste || !futur) return null;
  const n = /\b(\d{1,3})\s+(prochains?\s+)?(jours?|semaines?|mois|ans?)\b/.exec(m) ?? /\bprochain(?:e)?s?\s+(\d{1,3})\s+(jours?|semaines?|mois)\b/.exec(m);
  if (n) {
    const q = Number(n[1]);
    const u = n[n.length - 1];
    const jours = /^jour/.test(u) ? q : /^semaine/.test(u) ? q * 7 : /^mois/.test(u) ? q * 31 : q * 365;
    return { windowDays: Math.min(Math.max(jours, 1), 730) };
  }
  if (/\bcette semaine\b/.test(m)) return { windowDays: 7 };
  if (/\bce mois\b/.test(m)) return { windowDays: 31 };
  if (/\bcette annee\b/.test(m)) return { windowDays: 365 };
  return { windowDays: 30 };
}

const MISSING = /\b(manque|manquent|manquant|manquante|manquantes|manquants|incomplete?s?|a completer|pas renseigne\w*|non renseigne\w*)\b/;
const SPEND = /\b(depense|depenses|depensee?s?|coute|coutes?|paye|payes?|total|somme|montant total)\b/;
const COUNT = /\b(combien|nombre)\b/;

/**
 * Réponse canonique structurée, ou `null` (les branches historiques
 * s'appliquent ensuite). `resolveScope(texte)` : résolution du bien de
 * `data-answer` (clarification, page, mots du message).
 */
export async function tryCanonicalStructured(p: {
  port: AccountDataPort;
  accountId: number;
  message: string;
  resolveScope: (text: string) => Promise<ScopeLike>;
}): Promise<CanonicalLevel1> {
  const { port, accountId, message } = p;
  const m = plain(message);
  const today = port.today();

  // ── Informations manquantes (T2-04) ────────────────────────────────────
  if (MISSING.test(m) && port.listMissingInformation) {
    const reste = message.replace(/informations?|manqu\w*|incompl\w*|compl[eé]ter|renseign\w*/gi, ' ');
    const scope = await p.resolveScope(reste);
    if (scope.ambiguous) return { ambiguous: scope.assets, reason: 'MISSING_INFO_MULTIPLE_ASSETS' };
    if (scope.unresolved) return null;
    const list = await port.listMissingInformation(accountId, { assetIds: scope.assets.map((a) => a.id) });
    const lignes = list.filter((a) => a.missing.length || a.toProcess.length).map((a) => {
      const parts = [
        a.missing.length ? `à renseigner : ${joinFr(a.missing.map((x) => x.label.toLowerCase()))}` : null,
        a.toProcess.length ? `${a.toProcess.length} élément${a.toProcess.length > 1 ? 's' : ''} à traiter` : null,
      ].filter(Boolean);
      return `${a.assetName} — ${parts.join(' ; ')}`;
    });
    const sources: RetrievedSource[] = list.flatMap((a) => a.missing.slice(0, 4).map((x) => ({
      id: assetFieldSourceId(a.assetId, x.key), type: 'asset_field' as const, title: `${x.label} — ${a.assetName}`,
      content: `${x.label} : non renseigné (information attendue pour ce bien)`, relevanceScore: 1,
      meta: { assetId: a.assetId, fieldKey: x.key, value: null, missing: true },
    }))).slice(0, 8);
    const answer = lignes.length === 0
      ? formatNoResult('aucune information manquante', scope.label ? `sur la fiche de ${scope.label}` : 'sur vos fiches')
      : formatList(scope.label ? `Informations à compléter pour ${scope.label}` : 'Informations à compléter', lignes, 10);
    const srcs = sources.length ? sources : scope.assets.map(assetSrc);
    return { strategy: 'structured.missing_information', answer, sources: srcs, claims: [claim('missing', answer, srcs, 'calculated')], kind: lignes.length ? 'list' : 'no_result' };
  }

  // ── Dépenses qualifiées (T2-24) ────────────────────────────────────────
  if (SPEND.test(m) && (COUNT.test(m) || /\b(total|somme)\b/.test(m)) && port.sumQualifiedExpenses) {
    const theme = expenseThemeOf(message);
    const reste = theme ? message.replace(new RegExp(Object.values(EXPENSE_THEME_LABELS).join('|') + '|entretien|revision|reparations?|travaux|assurances?|achat', 'gi'), ' ') : message;
    const scope = await p.resolveScope(reste);
    if (scope.unresolved) return null;
    const year = Number(m.match(/\b(20\d{2})\b/)?.[1]) || undefined;
    const q = await port.sumQualifiedExpenses(accountId, { assetIds: scope.assets.map((a) => a.id), year, theme });
    const pour = `${scope.label ? ` pour ${scope.label}` : ''}${year ? ` en ${year}` : ''}`;
    // Source qui PORTE le total (thème, complétude, documents inclus) : une
    // reformulation par le modèle reste vérifiable (claim-support, T2-31).
    const sources = [
      expenseSumSource(q, { assetIds: scope.assets.map((a) => a.id), scopeLabel: scope.label, year }),
      ...scope.assets.map(assetSrc),
    ];
    // Non qualifiés : nature non précisée et/ou (année demandée) date absente.
    const sansDate = q.unqualified.undatedCount ?? 0;
    const sansNature = q.unqualified.count - sansDate;
    const pl = (n: number, a: string, b: string) => (n > 1 ? b : a);
    const motifs = [
      sansNature ? `${sansNature} document${pl(sansNature, '', 's')} avec montant ne précise${pl(sansNature, '', 'nt')} pas leur nature` : null,
      sansDate ? `${sansDate} document${pl(sansDate, '', 's')} avec montant n’${pl(sansDate, 'a', 'ont')} pas de date (non qualifié${pl(sansDate, '', 's')})` : null,
    ].filter(Boolean).join(' ; ');
    const incomplet = q.unqualified.count > 0
      ? ` Non compté${pl(q.unqualified.count, '', 's')} : ${motifs} — le total peut être incomplet.`
      : '';
    const doublons = q.duplicates?.count ? ` Doublon${pl(q.duplicates.count, '', 's')} signalé${pl(q.duplicates.count, '', 's')} (fusion possible) écarté${pl(q.duplicates.count, '', 's')} : ${q.duplicates.count} — chaque document n’est compté qu’une fois.` : '';
    const exclus = q.excluded.count > 0 ? ` Les devis et documents sans valeur de dépense (${q.excluded.count}) ne sont pas comptés.` : '';
    let answer: string;
    let kind: 'calc' | 'no_result' = 'calc';
    if (theme) {
      const t = q.byTheme[0];
      if (!t) {
        kind = 'no_result';
        answer = q.unqualified.count > 0
          // Couverture incomplète : aucun total affirmé (T2-24).
          ? `Je ne peux pas isoler vos dépenses de ${EXPENSE_THEME_LABELS[theme]}${pour} : ${motifs}. Complétez-les (type, date du document) pour obtenir un total fiable.`
          : formatNoResult(`aucune dépense de ${EXPENSE_THEME_LABELS[theme]} documentée`, pour.trim() || undefined);
      } else {
        answer = `Dépenses de ${t.label} documentées${pour} : ${formatAmountCents(t.sumCents)} (${t.count} document${t.count > 1 ? 's' : ''}).${incomplet}${doublons}${exclus}`;
      }
    } else if (q.byTheme.length === 0) {
      kind = 'no_result';
      answer = q.unqualified.count > 0
        ? `Je ne peux pas totaliser vos dépenses${pour} : ${motifs}.`
        : formatNoResult('aucune dépense documentée', pour.trim() || undefined);
    } else {
      answer = `${formatList(`Dépenses documentées${pour}, par thème`, q.byTheme.map((t) => `${t.label} ${formatAmountCents(t.sumCents)} (${t.count})`))} Total des dépenses qualifiées : ${formatAmountCents(q.qualifiedSumCents)}.${incomplet}${doublons}${exclus}`;
    }
    return { strategy: 'structured.sum_qualified', answer, sources, claims: [claim('sum', answer, sources, 'calculated')], kind };
  }

  // ── Échéances à venir, fenêtre (T2-15) ─────────────────────────────────
  const upcoming = upcomingAgendaRequest(message);
  if (upcoming && !COUNT.test(m) && port.listUpcomingAgenda) {
    const reste = message.replace(/[ée]ch[ée]ances?|rendez-vous|[ée]v[ée]nements?|rappels?|bient[ôo]t|arrivent|prochaine?s?|[àa] venir/gi, ' ');
    const scope = await p.resolveScope(reste);
    if (scope.ambiguous) return { ambiguous: scope.assets, reason: 'UPCOMING_MULTIPLE_ASSETS' };
    if (scope.unresolved) return null;
    const rows = await port.listUpcomingAgenda(accountId, { assetIds: scope.assets.map((a) => a.id), windowDays: upcoming.windowDays, limit: 10 });
    const fenetre = upcoming.windowDays <= 7 ? 'dans les 7 prochains jours' : `dans les ${upcoming.windowDays} prochains jours`;
    const sources: RetrievedSource[] = rows.map((r) => ({
      id: `agenda_${r.id}`, type: 'agenda_item', title: r.title,
      content: `${r.date}${r.forecast ? ' · date prévisionnelle' : ''}${r.assetNames.length ? ` · ${r.assetNames.join(', ')}` : ''}`,
      relevanceScore: 1, meta: { date: r.date, forecast: r.forecast },
    }));
    const answer = rows.length === 0
      ? formatNoResult(`aucune échéance ${fenetre}`, scope.label ? `pour ${scope.label}` : undefined)
      : formatList(`Échéances ${fenetre}${scope.label ? ` pour ${scope.label}` : ''}`, rows.map((r) =>
        `« ${r.title} »${r.assetNames.length && !scope.label ? ` (${joinFr(r.assetNames)})` : ''} ${r.forecast ? 'prévue le' : 'le'} ${formatDateFr(r.date)} (${formatRelativeDays(daysBetween(today, r.date))})`), 10)
        + (rows.some((r) => r.forecast) ? ' Les dates « prévues » sont prévisionnelles : elles seront confirmées par un document.' : '');
    const srcs = sources.length ? sources : scope.assets.map(assetSrc);
    return { strategy: 'structured.upcoming_agenda', answer, sources: srcs, claims: [claim('upcoming', answer, srcs, 'calculated')], kind: rows.length ? 'list' : 'no_result' };
  }

  // ── Champ d'un bien (T2-22, T2-23, T2-32) ──────────────────────────────
  const champ = findReadableField(message) ?? purchaseQuestion(message);
  if (champ && isFieldQuestion(message) && port.readAssetField) {
    const reste = plain(message).replace(new RegExp(esc(champ.phrase), 'g'), ' ');
    const scope = await p.resolveScope(reste);
    if (scope.ambiguous) return { ambiguous: scope.assets, reason: 'FIELD_MULTIPLE_ASSETS' };
    if (scope.unresolved || scope.assets.length !== 1) return null;
    const a = scope.assets[0];
    const r = await port.readAssetField(accountId, a.id, champ.def.key);
    // Non renseigné : les documents (niveau 2) peuvent encore porter la valeur.
    if (!r || r.value === null || r.value === undefined || r.display === null) return null;
    const answer = fieldAnswer(r);
    const sources = [assetFieldSource(r)];
    return {
      strategy: 'structured.asset_field', answer, sources,
      claims: [claim(`field:${r.key}`, answer, sources, 'direct')],
      kind: 'exact',
    };
  }
  return null;
}

/** Phrase de réponse d'un champ (pure, testée) : valeur, origine, preuve, conflit. */
export function fieldAnswer(r: CanonicalFieldReading): string {
  // Lot 18 (R3) : champ vide sur le bien mais renseigné sur ses équipements
  // ou pièces — chaque valeur est rattachée à SON équipement / SA pièce.
  if (!r.display && r.entities?.length) {
    const lignes = r.entities.filter((e) => e.display && !e.sensitive).map((e) => {
      const nom = e.entityName ?? (e.target.type === 'ROOM' ? 'la pièce' : 'l’équipement');
      const doc = e.evidence?.documentTitle && e.origin !== 'USER' ? ` (« ${e.evidence.documentTitle} »)` : '';
      return `${e.label} de ${nom} : ${e.display}.${e.originLabel ? ` Valeur ${e.originLabel}${doc}.` : ''}`;
    });
    if (lignes.length) return lignes.join(' ');
  }
  const valeur = r.key === 'acquisitionDate' && r.display
    ? `Vous avez acheté ${r.assetName ?? 'ce bien'} le ${r.display}.`
    : `${r.label} de ${r.assetName ?? 'ce bien'} : ${r.display}.`;
  const origine = r.originLabel ? ` Valeur ${r.originLabel}${r.evidence?.documentTitle && r.origin !== 'USER' ? ` (« ${r.evidence.documentTitle} »)` : ''}.` : '';
  const conflit = r.openConflict ? ` Un autre document propose une valeur différente : c’est à arbitrer dans « À traiter » (${r.openConflict.question}).` : '';
  return `${valeur}${origine}${conflit}`;
}
