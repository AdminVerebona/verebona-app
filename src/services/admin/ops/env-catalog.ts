/**
 * Configuration attendue — section « Configuration » de la page BO
 * « Exploitation » (lot 25, chantier B).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * NOMS SEULEMENT, JAMAIS DE VALEUR
 *
 * La liste est lue dans `.env.example` (présent dans l'image Scalingo, comme
 * `src/db/migrations`) : sections, niveau, courte explication. Pour chaque
 * nom, le serveur dit seulement s'il est POSÉ (valeur non vide) — la valeur
 * n'est ni lue dans la réponse, ni comparée, ni journalisée. Les valeurs
 * d'exemple du fichier ne sont pas renvoyées non plus.
 *
 * Niveaux :
 *   · obligatoire  : courte liste explicite (`OBLIGATOIRES`) — le service ne
 *                    fonctionne pas sans (base, session, stockage, paiement) ;
 *   · recommandée  : ligne active de `.env.example` (à poser sur chaque
 *                    environnement hébergé, même si un défaut existe) ;
 *   · facultative  : ligne commentée (`# NOM=`) — défaut documenté.
 *
 * Variables RETIRÉES : `RETIRED_AI_VARIABLES` (lot 16b), anciennes variables
 * S3 (`S3_LEGACY_ENV`), MIGRATIONS_REPAIR_ON_BOOT (lot 24b) — ignorées par
 * le code, à supprimer chez l'hébergeur si elles sont encore posées.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RETIRED_AI_VARIABLES } from '@/services/ai/config/retired-variables';
import { S3_LEGACY_ENV } from '@/lib/s3-config';

export type EnvLevel = 'obligatoire' | 'recommandee' | 'facultative';

export interface EnvVariableDoc {
  name: string;
  level: EnvLevel;
  description: string;
  /** `NEXT_PUBLIC_*` : figée au build, la changer impose un nouveau build. */
  buildTime: boolean;
}

export interface EnvSectionDoc {
  title: string;
  variables: EnvVariableDoc[];
}

/** Indispensables en environnement hébergé (absentes : service rendu impossible). */
export const OBLIGATOIRES: Readonly<Record<string, string>> = {
  DATABASE_URL: 'Connexion PostgreSQL (posée par l’add-on Scalingo). Jamais journalisée.',
  JWT_SECRET: 'Signature des sessions. Sans elle, le serveur refuse de démarrer en production.',
  OVH_S3_ENDPOINT: 'Stockage objet : point d’accès.',
  OVH_S3_BUCKET: 'Stockage objet : nom du bucket.',
  OVH_S3_ACCESS_KEY_ID: 'Stockage objet : identifiant d’accès.',
  OVH_S3_SECRET_ACCESS_KEY: 'Stockage objet : clé secrète.',
  STRIPE_SECRET_KEY: 'Paiements Stripe (mode test hors production, live en production).',
  STRIPE_WEBHOOK_SECRET: 'Signature des webhooks Stripe.',
};

/** Lues par le code mais absentes de `.env.example` en ligne active. */
const HORS_EXEMPLE: ReadonlyArray<{ section: string; name: string; level: EnvLevel; description: string }> = [
  { section: 'Base de données', name: 'DATABASE_URL', level: 'obligatoire', description: OBLIGATOIRES.DATABASE_URL },
  { section: 'E-mails et contact', name: 'RESEND_API_KEY', level: 'recommandee', description: 'Envoi des e-mails (Resend). Absente : aucun e-mail transactionnel ni notification de support.' },
];

const LIGNE_VARIABLE = /^\s*(#\s*)?([A-Z][A-Z0-9_]{2,})=(.*)$/;
const LIGNE_SECTION = /^#\s*(?:-{2,}|─{2,})\s*(.+?)\s*(?:-{2,}|─{2,})?\s*$/;
const SEPARATEUR = /^#\s*[═─-]{6,}\s*$/;

function nettoyerTitre(t: string): string {
  return t.replace(/[─-]+$/g, '').replace(/\s+/g, ' ').trim();
}

function nettoyerDescription(lignes: string[], name: string): string {
  const texte = lignes
    .map((l) => l.replace(/^#\s?/, '').trim())
    .filter((l) => l && !SEPARATEUR.test(`# ${l}`))
    .join(' ')
    .replace(new RegExp(`^${name}\\s*:\\s*`), '')
    .replace(/\s+/g, ' ')
    .trim();
  return texte.length > 280 ? `${texte.slice(0, 277)}…` : texte;
}

/**
 * Lecture de `.env.example` (pur) : sections, variables, niveau, explication.
 * Une variable présente plusieurs fois garde sa première explication ; une
 * occurrence active l'emporte sur une occurrence commentée.
 */
export function parseEnvExample(texte: string): EnvSectionDoc[] {
  const sections: EnvSectionDoc[] = [];
  const index = new Map<string, EnvVariableDoc>();
  let section: EnvSectionDoc = { title: 'Général', variables: [] };
  sections.push(section);
  let tampon: string[] = [];
  let derniere = '';

  for (const brute of texte.split(/\r?\n/)) {
    const ligne = brute.trimEnd();
    if (!ligne.trim()) { tampon = []; derniere = ''; continue; }
    const v = LIGNE_VARIABLE.exec(ligne);
    if (v) {
      const name = v[2];
      const commentee = Boolean(v[1]);
      const description = tampon.length ? nettoyerDescription(tampon, name) : derniere;
      const deja = index.get(name);
      if (deja) {
        if (!commentee && deja.level === 'facultative') deja.level = 'recommandee';
        if (!deja.description && description) deja.description = description;
      } else {
        const doc: EnvVariableDoc = {
          name,
          level: OBLIGATOIRES[name] ? 'obligatoire' : commentee ? 'facultative' : 'recommandee',
          description: description || OBLIGATOIRES[name] || '',
          buildTime: name.startsWith('NEXT_PUBLIC_'),
        };
        index.set(name, doc);
        section.variables.push(doc);
      }
      derniere = description;
      tampon = [];
      continue;
    }
    if (SEPARATEUR.test(ligne)) { tampon = []; continue; }
    const s = LIGNE_SECTION.exec(ligne);
    if (s && !/=/.test(s[1])) {
      section = { title: nettoyerTitre(s[1]), variables: [] };
      sections.push(section);
      tampon = [];
      derniere = '';
      continue;
    }
    if (ligne.trimStart().startsWith('#')) tampon.push(ligne.trim());
  }

  for (const x of HORS_EXEMPLE) {
    if (index.has(x.name)) continue;
    let cible = sections.find((s) => s.title === x.section);
    if (!cible) { cible = { title: x.section, variables: [] }; sections.unshift(cible); }
    const doc: EnvVariableDoc = { name: x.name, level: x.level, description: x.description, buildTime: false };
    index.set(x.name, doc);
    cible.variables.unshift(doc);
  }
  // Obligatoires toujours listées, même absentes du fichier.
  const manquantes = Object.keys(OBLIGATOIRES).filter((n) => !index.has(n));
  if (manquantes.length) {
    sections.unshift({
      title: 'Indispensables',
      variables: manquantes.map((name) => ({ name, level: 'obligatoire' as const, description: OBLIGATOIRES[name], buildTime: false })),
    });
  }
  return sections.filter((s) => s.variables.length > 0);
}

export interface RetiredEnvDoc {
  name: string;
  /** Lot ou chantier qui l'a retirée. */
  origin: string;
  /** Ce qui la remplace / ce que fait le code désormais. */
  now: string;
}

/** Variables retirées : ignorées par le code, à supprimer si encore posées. */
export function retiredEnvVariables(): RetiredEnvDoc[] {
  return [
    ...RETIRED_AI_VARIABLES.map((v) => ({ name: v.name, origin: v.lot, now: v.now })),
    ...Object.entries(S3_LEGACY_ENV).map(([name, canonique]) => ({ name, origin: 'APP-PERF-26', now: `remplacée par ${canonique}` })),
    // Lot 24b (`src/db/migration-config.ts`, `obsolete`).
    { name: 'MIGRATIONS_REPAIR_ON_BOOT', origin: 'lot 24b', now: 'réparation des index par le postdeploy puis en arrière-plan' },
  ];
}

/** Posée = valeur non vide. La valeur elle-même n'est jamais renvoyée. */
export function isSet(env: Record<string, string | undefined>, name: string): boolean {
  return (env[name] ?? '').trim() !== '';
}

export interface ConfigReport {
  /** Fichier lu (`.env.example`), ou null s'il est introuvable. */
  source: string | null;
  sourceError: string | null;
  sections: Array<{ title: string; variables: Array<EnvVariableDoc & { present: boolean }> }>;
  retired: Array<RetiredEnvDoc & { present: boolean }>;
  counts: { expected: number; present: number; missingRequired: string[]; missingRecommended: number; retiredSet: number };
  reminder: string;
}

export const SCALINGO_REMINDER = 'À poser dans Scalingo > Environnement (puis redémarrer ; une variable NEXT_PUBLIC_* impose un nouveau déploiement).';

/** Rapport pur : documentation + environnement → présences (noms seuls). */
export function buildConfigReport(
  sections: EnvSectionDoc[],
  env: Record<string, string | undefined>,
  source: { path: string | null; error: string | null },
): ConfigReport {
  const out = sections.map((s) => ({
    title: s.title,
    variables: s.variables.map((v) => ({ ...v, present: isSet(env, v.name) })),
  }));
  const toutes = out.flatMap((s) => s.variables);
  const retired = retiredEnvVariables().map((r) => ({ ...r, present: isSet(env, r.name) }));
  return {
    source: source.path,
    sourceError: source.error,
    sections: out,
    retired,
    counts: {
      expected: toutes.length,
      present: toutes.filter((v) => v.present).length,
      missingRequired: toutes.filter((v) => v.level === 'obligatoire' && !v.present).map((v) => v.name),
      missingRecommended: toutes.filter((v) => v.level === 'recommandee' && !v.present).length,
      retiredSet: retired.filter((r) => r.present).length,
    },
    reminder: SCALINGO_REMINDER,
  };
}

/** Lit `.env.example` à la racine de l'application ; ne lève jamais. */
export async function getConfigReport(env: Record<string, string | undefined> = process.env, root = process.cwd()): Promise<ConfigReport> {
  const chemin = join(root, '.env.example');
  try {
    const texte = await readFile(chemin, 'utf8');
    return buildConfigReport(parseEnvExample(texte), env, { path: '.env.example', error: null });
  } catch (e) {
    const code = (e as { code?: string }).code ?? 'ERREUR';
    // Sans le fichier : au moins les obligatoires et les retirées.
    return buildConfigReport(parseEnvExample(''), env, { path: null, error: `.env.example illisible (${code})` });
  }
}
