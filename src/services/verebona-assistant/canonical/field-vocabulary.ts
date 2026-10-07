/**
 * Vocabulaire des champs canoniques dans une question — compréhension
 * DÉTERMINISTE (tickets 8a, 8b §A, 12 ; lot 29). Module PUR.
 *
 * « adresse » → address1, « kilométrage » → mileage, « prix d'achat » →
 * acquisitionPrice : les formulations viennent du REGISTRE CANONIQUE seul
 * (`assistantPhrases` et libellé de chaque champ), jamais d'un dictionnaire
 * propre à T2. Une question peut désigner PLUSIEURS champs (« la date
 * d'achat et le kilométrage ») : ils sont rendus dans l'ordre de la question.
 *
 * Lot 30 (AC19 / AC20) : les champs et leur vocabulaire viennent de la
 * projection OFFICIELLE `catalogForT2Read()` — la même que le FIELD_CATALOG
 * de UNDERSTAND. Aucune liste de synonymes propre à T2 ; les `aliases`
 * techniques du registre ne sont jamais des formulations utilisateur.
 *
 * Le caractère `sensitive` d'un champ n'est PAS un motif d'exclusion ici :
 * il protège la valeur vis-à-vis du modèle et des traces, pas la lecture de
 * sa propre donnée par l'utilisateur (ticket 8a §A).
 */
import {
  catalogForT2Read, fieldAssistantVocabulary, getField, type CanonicalFieldDef,
} from '@/services/canonical/registry';

/** Nombre maximal de champs lus pour une demande (contrat T2 : `requestedFacts.max(20)`). */
export const MAX_REQUESTED_FACTS = 20;

const plain = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[’]/g, "'");
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Formulations reconnues d'un champ : son vocabulaire officiel
 * (`fieldAssistantVocabulary` : libellé et phrases de l'assistant) d'au
 * moins 4 caractères, et le pluriel du premier mot.
 */
export function fieldPhrasesOf(d: Pick<CanonicalFieldDef, 'assistantPhrases' | 'label'>): string[] {
  const base = fieldAssistantVocabulary(d).filter((p) => p.length >= 4);
  // Pluriel du premier mot (« les numéros de série », « les dates d'achat ») :
  // une demande agrégée désigne le même champ.
  const pluriels = base.map((p) => p.replace(/^([a-z]+?)(?<![sx])(?=$|[ '])/, '$1s')).filter((p) => !base.includes(p));
  return [...new Set([...base, ...pluriels])];
}

export interface FieldMention { def: CanonicalFieldDef; phrase: string; index: number }

/** Champs LISIBLES : projection officielle `catalogForT2Read()` (ordre du registre). */
function champsLisibles(): CanonicalFieldDef[] {
  return catalogForT2Read().fields.map((f) => getField(f.key)).filter((d): d is CanonicalFieldDef => !!d);
}

/**
 * Champs désignés par un message (pure, testée) : toutes les mentions, sans
 * recouvrement (la formulation la plus longue l'emporte sur une plus courte
 * qu'elle contient), dans l'ordre d'apparition ; une clé n'apparaît qu'une fois.
 */
export function findReadableFields(message: string): FieldMention[] {
  const m = plain(message);
  const brutes: FieldMention[] = [];
  for (const d of champsLisibles()) {
    for (const p of fieldPhrasesOf(d)) {
      const re = new RegExp(`(^|[^a-z])${esc(p)}(?=$|[^a-z])`, 'g');
      for (let x = re.exec(m); x; x = re.exec(m)) brutes.push({ def: d, phrase: p, index: x.index + x[1].length });
    }
  }
  // Les plus longues d'abord : une mention couverte par une plus longue est écartée.
  brutes.sort((a, b) => b.phrase.length - a.phrase.length || a.index - b.index);
  const retenues: FieldMention[] = [];
  for (const b of brutes) {
    const fin = b.index + b.phrase.length;
    if (retenues.some((r) => b.index < r.index + r.phrase.length && fin > r.index)) continue;
    retenues.push(b);
  }
  const vues = new Set<string>();
  return retenues.sort((a, b) => a.index - b.index).filter((r) => !vues.has(r.def.key) && (vues.add(r.def.key), true));
}

/** « Quand ai-je acheté… » : la date d'achat, champ `acquisitionDate` (T2-23). */
export function purchaseMention(message: string): FieldMention | null {
  const m = plain(message);
  const hit = /\b(achete\w*|acquis\w*)\b/.exec(m);
  const def = hit ? champsLisibles().find((d) => d.key === 'acquisitionDate') : undefined;
  return hit && def ? { def, phrase: hit[1], index: hit.index } : null;
}

/**
 * Faits demandés, compris SANS modèle (pure, testée) : clés canoniques dans
 * l'ordre de la question, dédoublonnées, au plus `MAX_REQUESTED_FACTS`.
 */
export function deterministicRequestedFacts(message: string): string[] {
  const mentions = findReadableFields(message);
  const achat = purchaseMention(message);
  if (achat && !mentions.some((x) => x.def.key === 'acquisitionDate' || (achat.index >= x.index && achat.index < x.index + x.phrase.length))) {
    mentions.push(achat);
  }
  return [...new Set(mentions.sort((a, b) => a.index - b.index).map((x) => x.def.key))].slice(0, MAX_REQUESTED_FACTS);
}

/** Dédoublonnage en conservant l'ordre de première apparition (ticket 12 §D). */
export function dedupeFacts(keys: readonly string[], max = MAX_REQUESTED_FACTS): string[] {
  const out: string[] = [];
  for (const k of keys) {
    const v = String(k ?? '').trim();
    if (v && !out.includes(v)) out.push(v);
    if (out.length >= max) break;
  }
  return out;
}

/** Retire du message les formulations de champs (reste : la désignation de la cible). */
export function withoutFieldPhrases(message: string): string {
  let m = plain(message);
  for (const x of findReadableFields(message).sort((a, b) => b.index - a.index)) {
    m = `${m.slice(0, x.index)} ${m.slice(x.index + x.phrase.length)}`;
  }
  return m;
}

/** Verbes de valeur (« combien l'ai-je payée ? ») : ils demandent une information. */
const VERBES_VALEUR = new Set(['paye', 'payee', 'payes', 'payees', 'payer', 'coute', 'coutee', 'coutes', 'cout', 'couts', 'vaut', 'valait', 'valeur']);
/** Mots de libellés trop généraux pour signaler une information demandée. */
const MOTS_NEUTRES = new Set(['pour', 'avec', 'dans', 'sans', 'sous', 'vers', 'entre', 'depuis', 'notes']);

let vocabulaireChamps: Set<string> | null = null;
/** Mots des libellés et formulations du registre (≥ 4 lettres) — pure. */
function motsDuRegistre(): Set<string> {
  if (vocabulaireChamps) return vocabulaireChamps;
  const v = new Set<string>();
  for (const f of catalogForT2Read().fields) {
    for (const p of f.phrases) {
      for (const w of p.split(/[^a-z0-9]+/)) if (w.length >= 4 && !MOTS_NEUTRES.has(w)) { v.add(w); if (!/[sx]$/.test(w)) v.add(`${w}s`); }
    }
  }
  vocabulaireChamps = v;
  return v;
}

/**
 * Mots d'INFORMATION non couverts par les champs reconnus (pure, testée) :
 * « Quand ai-je acheté la Polo et combien l'ai-je payée ? » → `payee` ;
 * « la date d'achat, le prix et le kilométrage » → `prix`. Non vide : la
 * compréhension déterministe est PARTIELLE — la demande relève de la
 * compréhension par le modèle (ticket 8b : « suffisamment comprise ? »).
 */
export function unconsumedInformationWords(message: string): string[] {
  // Formulations reconnues remplacées par un repère : un mot qui les
  // QUALIFIE (« la DATE de fin de garantie ») n'est pas une autre demande.
  let m = plain(message);
  for (const x of findReadableFields(message).sort((a, b) => b.index - a.index)) {
    m = `${m.slice(0, x.index)} § ${m.slice(x.index + x.phrase.length)}`;
  }
  const achat = purchaseMention(m);
  if (achat) m = `${m.slice(0, achat.index)} § ${m.slice(achat.index + achat.phrase.length)}`;
  const vocab = motsDuRegistre();
  const out = new Set<string>();
  const re = /[a-z0-9]+/g;
  for (let x = re.exec(m); x; x = re.exec(m)) {
    const w = x[0];
    if (w.length < 4 || !(vocab.has(w) || VERBES_VALEUR.has(w))) continue;
    if (/^\s*(de la|de l'|des|du|de|d')\s*§/.test(m.slice(x.index + w.length))) continue;
    out.add(w);
  }
  return [...out];
}
