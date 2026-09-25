/** Empreintes canoniques — pur, sans dépendance serveur. */
import { createHash } from 'crypto';

/** JSON à clés triées : deux contextes égaux ont la même empreinte. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
