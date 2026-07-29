/**
 * Amorçage des prompts en base — CDC §4.5 et §6.1.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI CE FICHIER
 *
 * Le chargeur (`prompts/prompt-loader.ts`) lit les prompts dans
 * `ai_prompt_versions` et retombe sur les fichiers du dépôt si la table est
 * vide. Ce repli est délibéré — il évite qu'un déploiement casse — mais tant
 * qu'il joue, **aucun prompt n'est gouverné** : ni activation, ni retour
 * arrière, ni double validation humaine, ni trace de qui a changé quoi.
 *
 * Autrement dit, tout le lot 6 est inopérant tant que ce seed n'a pas tourné.
 *
 * ⚠️ CE SEED N'ÉCRASE JAMAIS UNE VERSION ACTIVE.
 *
 * C'est la règle qui compte. Un prompt activé l'a été par deux validations
 * humaines distinctes (§4.5.3). Si le fichier du dépôt diverge de la version
 * active en base, le seed insère une version CANDIDATE et le signale — il ne
 * décide pas à la place des deux valideurs. Un seed qui écraserait l'actif
 * rendrait la gouvernance décorative : il suffirait de modifier un `.txt` et
 * de redéployer pour contourner le circuit.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Utilisation :
 *   npm run db:seed:prompts
 *   npm run db:seed:prompts -- --dry-run   (n'écrit rien, affiche le plan)
 */
import { createHash } from 'crypto';
import { readFile, readdir } from 'fs/promises';
import { join } from 'path';

export interface PromptFile {
  /** Code du prompt — c'est le nom du fichier, suffixe de version compris. */
  promptCode: string;
  /** Version extraite du suffixe : `reconcile_links_v1` → `v1`. */
  version: string;
  content: string;
  contentHash: string;
  /** Chemin relatif, pour les messages. */
  relativePath: string;
}

const PROMPTS_ROOT = join(process.cwd(), 'src', 'services', 'ai', 'prompts');

/**
 * Déduit code et version d'un nom de fichier.
 *
 * La convention du référentiel est que `promptCode` PORTE la version
 * (`reconcile_links_v1`), et non l'inverse. Deux versions d'un même prompt sont
 * donc deux codes distincts au sens du référentiel, et la colonne `version`
 * sert au suivi à l'intérieur d'un code — celui des révisions validées par la
 * gouvernance, pas celui des fichiers du dépôt.
 */
export function parsePromptFileName(fileName: string): { promptCode: string; version: string } {
  const promptCode = fileName.replace(/\.txt$/i, '');
  const match = promptCode.match(/_v(\d+)$/);
  return { promptCode, version: match ? `v${match[1]}` : 'v1' };
}

export function hashContent(content: string): string {
  // Normalisation des fins de ligne : l'équipe développe sous Windows, et un
  // CRLF ne doit pas produire un prompt « modifié » à chaque aller-retour.
  return createHash('sha256').update(content.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

/** Parcourt l'arborescence des prompts du dépôt. */
export async function collectPromptFiles(root = PROMPTS_ROOT): Promise<PromptFile[]> {
  const found: PromptFile[] = [];

  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, `${prefix}${entry.name}/`);
      } else if (entry.name.endsWith('.txt')) {
        const content = await readFile(full, 'utf8');
        const { promptCode, version } = parsePromptFileName(entry.name);
        found.push({
          promptCode,
          version,
          content,
          contentHash: hashContent(content),
          relativePath: `${prefix}${entry.name}`,
        });
      }
    }
  }

  await walk(root, '');
  return found.sort((a, b) => a.promptCode.localeCompare(b.promptCode));
}

export type SeedAction = 'created' | 'unchanged' | 'candidate';

export interface SeedDecision {
  promptCode: string;
  action: SeedAction;
  detail: string;
}

/**
 * Décide, sans base ni effet de bord, ce qu'il faut faire de chaque fichier.
 *
 * Séparée de l'écriture pour être testable : c'est ici que se trouve la règle
 * de non-écrasement, et c'est elle qu'il faut protéger d'une régression.
 */
export function decideSeedAction(
  file: PromptFile,
  activeInDb: { contentHash: string; version: string } | null,
): SeedDecision {
  if (!activeInDb) {
    return {
      promptCode: file.promptCode,
      action: 'created',
      detail: `activé en ${file.version} depuis ${file.relativePath}`,
    };
  }
  if (activeInDb.contentHash === file.contentHash) {
    return { promptCode: file.promptCode, action: 'unchanged', detail: `déjà actif en ${activeInDb.version}` };
  }
  return {
    promptCode: file.promptCode,
    action: 'candidate',
    detail:
      `le fichier diverge de la version active (${activeInDb.version}) — ` +
      'version CANDIDATE créée, activation à faire par le circuit de gouvernance',
  };
}

export interface SeedSummary {
  created: number;
  unchanged: number;
  candidate: number;
  decisions: SeedDecision[];
  /** Opérations du référentiel dont le prompt n'existe pas dans le dépôt. */
  missingFiles: string[];
}

export async function seedPrompts(options: { dryRun?: boolean } = {}): Promise<SeedSummary> {
  const { pgClient } = await import('@/db');
  const { AI_OPERATIONS } = await import('@/services/ai/registry/operations');

  const files = await collectPromptFiles();
  const decisions: SeedDecision[] = [];

  for (const file of files) {
    const rows = (await pgClient.unsafe(
      `SELECT content_hash, version FROM ai_prompt_versions
        WHERE prompt_code = $1 AND status = 'ACTIVE' LIMIT 1`,
      [file.promptCode] as never[],
    )) as unknown as Array<{ content_hash: string; version: string }>;

    const active = rows[0] ? { contentHash: rows[0].content_hash, version: rows[0].version } : null;
    const decision = decideSeedAction(file, active);
    decisions.push(decision);

    if (options.dryRun || decision.action === 'unchanged') continue;

    const status = decision.action === 'created' ? 'ACTIVE' : 'CANDIDATE';
    const activatedAt = decision.action === 'created' ? 'NOW()' : 'NULL';

    await pgClient.unsafe(
      `INSERT INTO ai_prompt_versions (prompt_code, version, content, content_hash, status, activated_at)
       VALUES ($1, $2, $3, $4, '${status}', ${activatedAt})`,
      [file.promptCode, nextVersion(file, decision), file.content, file.contentHash] as never[],
    );
  }

  // Un prompt déclaré au référentiel mais absent du dépôt ne se verra qu'au
  // premier appel, en production. Autant le dire ici.
  const known = new Set(files.map((f) => f.promptCode));
  const missingFiles = Object.values(AI_OPERATIONS)
    .map((op) => op.promptCode)
    .filter((code): code is string => typeof code === 'string' && !known.has(code));

  return {
    created: decisions.filter((d) => d.action === 'created').length,
    unchanged: decisions.filter((d) => d.action === 'unchanged').length,
    candidate: decisions.filter((d) => d.action === 'candidate').length,
    decisions,
    missingFiles: [...new Set(missingFiles)],
  };
}

/** Une candidate porte un suffixe daté : elle ne doit pas entrer en collision. */
function nextVersion(file: PromptFile, decision: SeedDecision): string {
  if (decision.action === 'created') return file.version;
  return `${file.version}-seed-${new Date().toISOString().slice(0, 10)}`;
}

// ── Exécution directe ────────────────────────────────────────────────────────
if (process.argv[1]?.includes('ai-prompts.seed')) {
  const dryRun = process.argv.includes('--dry-run');

  seedPrompts({ dryRun })
    .then((s) => {
      console.log(`\n${dryRun ? 'Simulation' : 'Amorçage'} des prompts\n`);
      for (const d of s.decisions) {
        const mark = { created: '+', unchanged: '=', candidate: '!' }[d.action];
        console.log(`  ${mark} ${d.promptCode.padEnd(28)} ${d.detail}`);
      }
      console.log(
        `\n${s.created} activé(s), ${s.unchanged} inchangé(s), ${s.candidate} en attente de validation.`,
      );
      if (s.candidate > 0) {
        console.log(
          '\n⚠️ Des fichiers divergent de la version active. Aucune n\'a été écrasée :\n' +
          '   passez par le circuit de gouvernance pour activer les candidates.',
        );
      }
      if (s.missingFiles.length > 0) {
        console.log(`\n⚠️ Prompts déclarés au référentiel sans fichier : ${s.missingFiles.join(', ')}`);
      }
      process.exit(0);
    })
    .catch((e) => {
      console.error('\n✖ Amorçage impossible :', (e as Error).message);
      process.exit(1);
    });
}
