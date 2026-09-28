/**
 * Politique « données sensibles » de l'assistant — CDC §29.4 (et §29.3,
 * §16.2 minimisation, §29.6 journaux).
 *
 * « Une politique dédiée définit le traitement de : pièces d'identité,
 * coordonnées bancaires, données médicales, données de tiers, secrets et
 * codes d'accès. Par défaut, ces informations sont masquées ou exclues du
 * contexte lorsque leur présence n'est pas nécessaire à la réponse. »
 *
 * Seules les coordonnées bancaires étaient masquées (IBAN, cartes — et le NIR
 * dans la passerelle). Ce module est la partie DÉTERMINISTE de la politique :
 * des motifs, jamais un appel modèle, appliqués à tout ce que l'assistant
 * envoie au modèle (question, extraits des sources, contexte du fil).
 *
 * ── Catégories et traitement par défaut ────────────────────────────────────
 *
 *   identity  pièce d'identité : numéro de passeport, de carte d'identité, de
 *             titre de séjour ou de permis (annoncé par son intitulé),
 *             passeport au format français annoncé comme tel, bande MRZ,
 *             NIR → masqué.
 *             Document d'identité entier → EXCLU du contexte.
 *             Nécessaire : la question porte sur un numéro de pièce.
 *   bank      IBAN, carte bancaire → masqué. Nécessaire : jamais (le
 *             modèle n'a pas à recopier un IBAN ; la fiche fournisseur
 *             l'affiche sans lui).
 *   medical   phrase portant une donnée médicale, toujours qualifiée
 *             (diagnostic médical, ordonnance médicale, arrêt maladie,
 *             groupe sanguin, patient…) → phrase masquée, zone bornée à
 *             ±60 caractères dans un bloc sans ponctuation. Le vocabulaire
 *             du bâtiment et du droit (pathologie du bâtiment, ordonnance
 *             de référé) n'est jamais visé.
 *             Document médical entier → EXCLU du contexte.
 *             Nécessaire : la question porte explicitement sur la santé.
 *   thirdParty données personnelles de tiers figurant dans les documents :
 *             e-mail, téléphone, date de naissance → masquées. Nécessaire :
 *             la question demande un contact (numéro, tél, mail,
 *             coordonnées…) — la date de naissance, jamais. Les coordonnées
 *             professionnelles d'une fiche FOURNISSEUR ne sont jamais masquées.
 *   secret    mot de passe, code d'accès, digicode, code d'alarme, code
 *             Wi-Fi, PIN, clé d'API, jeton, clé privée → masqué TOUJOURS :
 *             un secret n'est jamais transmis au fournisseur du modèle, même
 *             demandé (l'utilisateur le retrouve dans sa donnée d'origine).
 *
 * Le texte masqué garde sa forme (« [numéro de pièce d'identité masqué] ») :
 * le modèle sait qu'une donnée existe sans la recevoir, et le dit.
 *
 * Aucun contenu n'est journalisé : le rapport ne porte que des compteurs
 * par catégorie et les identifiants des sources exclues.
 */
import type { RetrievedSource } from '../types/sources';

export type SensitiveCategory = 'identity' | 'bank' | 'medical' | 'thirdParty' | 'secret';

export const SENSITIVE_CATEGORIES: readonly SensitiveCategory[] = ['identity', 'bank', 'medical', 'thirdParty', 'secret'];

/** Catégories dont la présence est nécessaire à la réponse (non masquées). */
export type SensitiveNecessity = Partial<Record<SensitiveCategory, boolean>>;

export interface MaskReport {
  /** Nombre de masquages par catégorie. */
  counts: Record<SensitiveCategory, number>;
}

const vide = (): Record<SensitiveCategory, number> => ({ identity: 0, bank: 0, medical: 0, thirdParty: 0, secret: 0 });

// ── Motifs ──────────────────────────────────────────────────────────────────
// Tous insensibles aux accents saisis ou non (é/e), bornés en longueur pour
// rester linéaires.

/** Intitulé de pièce d'identité suivi de son numéro (6 à 20 caractères, au moins 2 chiffres). */
const PIECE_NUMEROTEE = /((?:passeport|carte\s+(?:nationale\s+)?d['’]\s?identit[ée]|\bCNI\b|titre\s+de\s+s[ée]jour|permis\s+de\s+conduire|pi[èe]ce\s+d['’]\s?identit[ée])[^\n\d]{0,30}?)\b((?=[A-Z]*\d[A-Z]*\d)[A-Z0-9]{6,20})\b/gi;
/**
 * Passeport français (2 chiffres, 2 lettres, 5 chiffres) — seulement s'il est
 * annoncé comme tel à proximité : ce format est aussi celui de numéros de
 * série d'appareils, qui doivent rester lisibles.
 */
const PASSEPORT_FR = /(passeport[^\n]{0,60}?)\b(\d{2}[A-Z]{2}\d{5})\b/gi;
/** Bande MRZ (lignes lisibles par machine d'une pièce d'identité). */
const MRZ = /\b[A-Z0-9<]{6,44}<<[A-Z0-9<]{6,44}(?![A-Z0-9<])/g;
/** NIR (numéro de sécurité sociale), espaces tolérés. */
const NIR = /\b[12]\s?\d{2}\s?(?:0[1-9]|1[0-2])\s?(?:\d{2}|2A|2B)\s?\d{3}\s?\d{3}(?:\s?\d{2})?\b/g;

const IBAN = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g;
const CARTE = /\b(?:\d[ -]?){13,19}\b/g;

/**
 * Donnée médicale : expressions SANS ambiguïté, toutes porteuses d'un
 * qualificatif médical. « Diagnostic », « pathologie », « traitement » ou
 * « ordonnance » seuls décrivent aussi un bâtiment (« pathologie du
 * bâtiment », « toiture diagnostiquée », « traitement de charpente ») ou une
 * procédure (« ordonnance de référé ») : ils ne suffisent jamais.
 */
const MEDICAL = /\b(?:diagnostic\s+m[ée]dical|prescription\s+m[ée]dicale|ordonnance\s+(?:m[ée]dicale|du\s+(?:dr\b|docteur|m[ée]decin))|posologie|ant[ée]c[ée]dents?\s+m[ée]dicaux|affection\s+de\s+longue\s+dur[ée]e|arr[êe]t\s+maladie|arr[êe]t\s+de\s+travail\s+(?:pour\s+)?maladie|taux\s+d['’]\s?invalidit[ée]|groupe\s+sanguin|s[ée]ropositi\w*|certificat\s+m[ée]dical|compte[\s-]rendu\s+(?:m[ée]dical|op[ée]ratoire|d['’]\s?hospitalisation)|traitement\s+m[ée]dical|dossier\s+m[ée]dical|m[ée]decin\s+traitant|donn[ée]es?\s+de\s+sant[ée]|[ée]tat\s+de\s+sant[ée]|suivi\s+m[ée]dical|(?:le|la|du|au)\s+patient(?:e)?\b)/i;
/** Au-delà, la zone masquée est bornée autour de l'expression (texte OCR sans ponctuation). */
const MEDICAL_MAX_SEGMENT = 240;
const MEDICAL_FENETRE = 60;

const EMAIL = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;
const TELEPHONE = /(?:\b0|\+33\s?)[1-9](?:[ .-]?\d{2}){4}\b/g;
/** Date de naissance annoncée comme telle. */
const NAISSANCE = /((?:n[ée]e?\s+le|date\s+de\s+naissance\s*:?)\s*)(\d{1,2}[/.\-\s]\d{1,2}[/.\-\s]\d{2,4}|\d{1,2}\s+[a-zéû]+\s+\d{4})/gi;

/** Secret annoncé par son intitulé : la valeur qui suit est masquée. */
const SECRET_ANNONCE = /((?:mot\s+de\s+passe|password|\bmdp\b|passcode|digicode|code\s+(?:d['’]\s?acc[èe]s|d['’]\s?entr[ée]e|du\s+portail|portail|de\s+l['’]\s?alarme|alarme|wi-?fi|pin|secret|confidentiel|de\s+la\s+porte|du\s+coffre|coffre)|cl[ée]\s+(?:wi-?fi|wpa2?|d['’]\s?api|secr[èe]te)|identifiant\s+de\s+connexion)(?:\s+(?:du|de\s+la|de\s+l['’]|de|des)\s*[a-zà-ÿ-]{2,20})?\s*(?:est|:|=|-)?\s*)([^\s,;]{3,64})/gi;
const CLE_API = /\b(?:AIza[0-9A-Za-z\-_]{35}|sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|xox[abp]-[A-Za-z0-9-]{10,})\b/g;
const JWT = /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}\b/g;
const CLE_PRIVEE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

export const MASKS: Record<SensitiveCategory, string> = {
  identity: '[numéro de pièce d’identité masqué]',
  bank: '[coordonnées bancaires masquées]',
  medical: '[donnée médicale masquée]',
  thirdParty: '[donnée personnelle masquée]',
  secret: '[code ou secret masqué]',
};

/** Remplace et compte. */
function remplacer(texte: string, re: RegExp, cat: SensitiveCategory, counts: Record<SensitiveCategory, number>, garderPrefixe = false): string {
  return texte.replace(re, (...m: string[]) => {
    counts[cat] += 1;
    return garderPrefixe ? `${m[1]}${MASKS[cat]}` : MASKS[cat];
  });
}

/**
 * Masque les données sensibles d'un texte, sauf les catégories déclarées
 * nécessaires (les secrets le sont toujours). Rend le texte et les compteurs.
 */
export function maskSensitiveText(text: string, necessity: SensitiveNecessity = {}): { text: string; report: MaskReport } {
  const counts = vide();
  let t = String(text ?? '');
  if (!t) return { text: t, report: { counts } };

  // Secrets d'abord (une clé d'API ne doit pas être prise pour un IBAN).
  t = remplacer(t, CLE_PRIVEE, 'secret', counts);
  t = remplacer(t, JWT, 'secret', counts);
  t = remplacer(t, CLE_API, 'secret', counts);
  t = remplacer(t, SECRET_ANNONCE, 'secret', counts, true);

  if (!necessity.identity) {
    t = remplacer(t, MRZ, 'identity', counts);
    t = remplacer(t, PIECE_NUMEROTEE, 'identity', counts, true);
    t = remplacer(t, PASSEPORT_FR, 'identity', counts, true);
    t = remplacer(t, NIR, 'identity', counts);
  }
  // Coordonnées bancaires : jamais nécessaires au modèle.
  t = remplacer(t, IBAN, 'bank', counts);
  t = remplacer(t, CARTE, 'bank', counts);

  if (!necessity.thirdParty) {
    t = remplacer(t, EMAIL, 'thirdParty', counts);
    t = remplacer(t, TELEPHONE, 'thirdParty', counts);
  }
  // La date de naissance d'une personne n'est jamais nécessaire.
  t = remplacer(t, NAISSANCE, 'thirdParty', counts, true);

  if (!necessity.medical) {
    // Phrase par phrase : une donnée médicale ne se réduit pas à un motif.
    // Une « phrase » démesurée (bloc OCR sans ponctuation) n'est pas masquée
    // en entier : seule une fenêtre bornée autour de l'expression l'est.
    t = t.split(/(?<=[.!?\n])/).map((phrase) => {
      if (!MEDICAL.test(phrase)) return phrase;
      if (phrase.trim().length > MEDICAL_MAX_SEGMENT) return masquerFenetresMedicales(phrase, counts);
      counts.medical += 1;
      const debut = /^\s*/.exec(phrase)?.[0] ?? '';
      const fin = /\s*$/.exec(phrase)?.[0] ?? '';
      return `${debut}${MASKS.medical}${/[.!?]\s*$/.test(phrase) ? '.' : ''}${fin}`;
    }).join('');
  }
  return { text: t, report: { counts } };
}

/** Masque ±60 caractères (coupés aux espaces) autour de chaque expression médicale. */
function masquerFenetresMedicales(texte: string, counts: Record<SensitiveCategory, number>): string {
  const re = new RegExp(MEDICAL.source, 'gi');
  const zones: Array<[number, number]> = [];
  for (let m = re.exec(texte); m; m = re.exec(texte)) {
    const finExpr = m.index + m[0].length;
    let debut = Math.max(0, m.index - MEDICAL_FENETRE);
    let fin = Math.min(texte.length, finExpr + MEDICAL_FENETRE);
    // Coupure aux espaces, sans jamais rogner l'expression elle-même.
    const apresDebut = texte.indexOf(' ', debut);
    if (debut > 0 && apresDebut >= 0 && apresDebut < m.index) debut = apresDebut + 1;
    const avantFin = texte.lastIndexOf(' ', fin);
    if (fin < texte.length && avantFin > finExpr) fin = avantFin;
    const derniere = zones[zones.length - 1];
    if (derniere && debut <= derniere[1]) derniere[1] = Math.max(derniere[1], fin);
    else zones.push([debut, fin]);
  }
  let out = '';
  let pos = 0;
  for (const [d, f] of zones) {
    out += `${texte.slice(pos, d)}${MASKS.medical}`;
    counts.medical += 1;
    pos = f;
  }
  return out + texte.slice(pos);
}

/**
 * Catégories nécessaires à la réponse, déduites de la QUESTION : un besoin
 * explicite lève le masquage de sa catégorie (jamais pour les secrets, les
 * coordonnées bancaires ni les dates de naissance).
 */
export function sensitiveNecessityFor(question: string): SensitiveNecessity {
  const q = String(question ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  return {
    identity: /\b(numero|n°|no)\b.{0,40}\b(passeport|carte d'?\s?identite|cni|titre de sejour|permis de conduire|piece d'?\s?identite|securite sociale)\b/.test(q)
      || /\b(passeport|carte d'?\s?identite|cni|titre de sejour|permis de conduire|securite sociale)\b.{0,40}\b(numero|n°)\b/.test(q),
    medical: /\b(medical|medicale|medicaux|sante|ordonnance|mutuelle|maladie|medecin|arret de travail|hospitalisation)\b/.test(q),
    // « Quel est le numéro du plombier ? », « le tél du chauffagiste ? »
    thirdParty: /\b(numero|numeros|tel|telephone|portable|e-?mail|mail|adresse mail|courriel|joindre|contacter|appeler|coordonnees)\b|\bn°/.test(q),
  };
}

// ── Exclusion par type de document ──────────────────────────────────────────

/** Documents d'identité ou médicaux : exclus du contexte sauf nécessité. */
const DOC_IDENTITE = /\b(passeport|carte\s+(?:nationale\s+)?d['’]\s?identit[ée]|\bCNI\b|titre\s+de\s+s[ée]jour|permis\s+de\s+conduire|pi[èe]ce\s+d['’]\s?identit[ée]|carte\s+vitale)\b/i;
const DOC_MEDICAL = /\b(ordonnance\s+(?:m[ée]dicale|de\s+pharmacie|pharmacie|du\s+(?:dr\b|docteur|m[ée]decin))|certificat\s+m[ée]dical|compte[\s-]rendu\s+(?:m[ée]dical|op[ée]ratoire|d['’]\s?hospitalisation)|analyses?\s+(?:m[ée]dicales?|de\s+sang|biologiques?)|dossier\s+m[ée]dical|arr[êe]t\s+(?:de\s+travail|maladie))\b/i;

/** Catégorie sensible d'un DOCUMENT entier (titre ou type), sinon `null`. */
export function sensitiveDocumentCategory(s: Pick<RetrievedSource, 'type' | 'title' | 'meta'>): 'identity' | 'medical' | null {
  if (s.type !== 'document' && s.type !== 'document_extraction') return null;
  const libelle = `${s.title ?? ''} ${String(s.meta?.documentType ?? '')} ${String(s.meta?.documentTypeLabel ?? '')}`;
  if (DOC_IDENTITE.test(libelle)) return 'identity';
  if (DOC_MEDICAL.test(libelle)) return 'medical';
  return null;
}

export interface SourcesPolicyResult {
  sources: RetrievedSource[];
  /** Événements de trace, sans contenu (§17.11, §29.6). */
  events: string[];
  counts: Record<SensitiveCategory, number>;
  excludedIds: string[];
}

/**
 * Applique la politique aux sources envoyées au modèle : exclut les
 * documents d'identité et médicaux non nécessaires, masque le reste.
 * Le titre est masqué comme le contenu. Les sources exclues ne sont PAS
 * perdues pour l'utilisateur : elles restent dans ses données, seul le
 * modèle ne les reçoit pas.
 */
export function applySensitiveDataPolicy(sources: RetrievedSource[], question: string): SourcesPolicyResult {
  const necessity = sensitiveNecessityFor(question);
  const counts = vide();
  const excludedIds: string[] = [];
  const kept: RetrievedSource[] = [];
  for (const s of sources) {
    const cat = sensitiveDocumentCategory(s);
    if (cat && !necessity[cat]) {
      excludedIds.push(s.id);
      continue;
    }
    // Fiche fournisseur : ses coordonnées sont PROFESSIONNELLES, publiques
    // par nature et utiles (« quel est le numéro du plombier ? ») — jamais
    // masquées. Les données de tiers visées sont celles de particuliers
    // figurant dans les documents.
    const besoin = s.type === 'supplier' ? { ...necessity, thirdParty: true } : necessity;
    const titre = maskSensitiveText(s.title, besoin);
    const contenu = maskSensitiveText(s.content, besoin);
    for (const c of SENSITIVE_CATEGORIES) counts[c] += titre.report.counts[c] + contenu.report.counts[c];
    kept.push(titre.text === s.title && contenu.text === s.content ? s : { ...s, title: titre.text, content: contenu.text });
  }
  const events: string[] = [];
  for (const c of SENSITIVE_CATEGORIES) if (counts[c] > 0) events.push(`SENSITIVE:MASKED:${c}:${counts[c]}`);
  if (excludedIds.length) events.push(`SENSITIVE:EXCLUDED:${excludedIds.length}`);
  return { sources: kept, events, counts, excludedIds };
}
