/**
 * Empreintes de RÉFÉRENCE des masters du dépôt — CDC 15 §30, D-17.
 *
 * `fingerprints.json` (committé) porte l'empreinte SHA-256 de chaque
 * `tN_master_v1.txt` pour laquelle le corpus a été rejoué VERT. Un master
 * modifié sans corpus fait échouer `ai:verify` (`ai:corpus --check-fingerprints`)
 * et `test:run` : il faut relancer le corpus, puis
 * `npm run ai:corpus -- --update-fingerprints` (refusé si un master est rouge).
 * Le texte d'un master du DÉPÔT ne peut donc plus changer sans corpus.
 *
 * Portée (BO-IA-PROMPTS-01) : les fichiers `tN_master_v1.txt` du dépôt
 * seulement — garde-fou de développeur, en CI. Les versions administrées et
 * activées depuis le BO (`ai_master_prompt_versions`) ne sont jamais lues
 * ici : elles ne peuvent faire échouer ni le build, ni la CI, ni le
 * déploiement.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MasterCorpusResult } from './runner';

export const FINGERPRINTS_PATH = join(__dirname, 'fingerprints.json');

export interface FingerprintFile {
  /** Référence : master → empreinte SHA-256 du fichier du dépôt au dernier corpus vert. */
  masters: Record<string, string>;
}

export function readFingerprints(path = FINGERPRINTS_PATH): FingerprintFile {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as FingerprintFile;
  } catch {
    return { masters: {} };
  }
}

/** Écarts entre les masters du dépôt et la référence (vide : conforme). */
export function fingerprintDrift(results: MasterCorpusResult[], ref: FingerprintFile): string[] {
  const out: string[] = [];
  for (const r of results) {
    const attendu = ref.masters[r.masterPromptCode];
    if (!attendu) out.push(`${r.masterPromptCode} : aucune empreinte de référence (nouveau master sans corpus enregistré)`);
    else if (attendu !== r.textSha256) out.push(`${r.masterPromptCode} : texte modifié (${r.textSha256.slice(0, 12)} ≠ référence ${attendu.slice(0, 12)})`);
  }
  for (const code of Object.keys(ref.masters)) {
    if (!results.some((r) => r.masterPromptCode === code)) out.push(`${code} : master de référence absent du registre`);
  }
  return out;
}

/** Met à jour la référence — seulement si TOUS les masters sont verts. */
export function writeFingerprints(results: MasterCorpusResult[], path = FINGERPRINTS_PATH): void {
  const rouges = results.filter((r) => r.status !== 'PASSED');
  if (rouges.length) throw new Error(`corpus rouge (${rouges.map((r) => r.masterPromptCode).join(', ')}) : référence non mise à jour`);
  const masters = Object.fromEntries(results.map((r) => [r.masterPromptCode, r.textSha256]).sort(([a], [b]) => String(a).localeCompare(String(b))));
  writeFileSync(path, `${JSON.stringify({ masters }, null, 2)}\n`);
}
