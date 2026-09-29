/**
 * Corpus synthétique P-T1 (CDC 15 §30, décision D-08 : pas de corpus réel).
 *
 * Chaque fichier JSON porte :
 *   · `case` / `description` : identifiant CDC et comportement attendu ;
 *   · `context` : compte simulé (biens, pièces, équipements, identifiants
 *     vérifiés en base, bien choisi au dépôt) ;
 *   · `recording` : sortie modèle enregistrée, au format du rejeu E2E
 *     (`src/test/e2e/replay-gateway.ts` : operationCode, task, output).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AnalysisContext } from '../../types';

export interface T1FixtureContext {
  linkedAssetId?: number | null;
  assets?: AnalysisContext['assets'];
  rooms?: AnalysisContext['rooms'];
  equipments?: AnalysisContext['equipments'];
  existingTitles?: string[];
  /** Identifiants existant dans le compte (simulent `identifier-verifier`). */
  verified?: Partial<Record<'ASSET' | 'EQUIPMENT' | 'ROOM' | 'SUPPLIER', number[]>>;
  /** GROUP_UPLOAD : fichiers déposés. */
  displayNames?: string[];
  mimeTypes?: string[];
}

export interface T1Fixture {
  case: string;
  description: string;
  context: T1FixtureContext;
  recording: { operationCode: string; task: string; output: Record<string, unknown> };
}

export const T1_FIXTURES_DIR = __dirname;

export function loadT1Fixture(file: string): T1Fixture {
  return JSON.parse(readFileSync(join(T1_FIXTURES_DIR, file), 'utf8')) as T1Fixture;
}

export function listT1Fixtures(): string[] {
  return readdirSync(T1_FIXTURES_DIR).filter((f) => f.endsWith('.json')).sort();
}

/** `AnalysisContext` du compte simulé. */
export function fixtureAnalysisContext(f: T1Fixture, accountId = 1): AnalysisContext {
  return {
    accountId,
    userId: 1,
    assets: f.context.assets ?? [],
    rooms: f.context.rooms ?? [],
    equipments: f.context.equipments ?? [],
    existingTitles: f.context.existingTitles ?? [],
    linkedAssetId: f.context.linkedAssetId ?? null,
  };
}
