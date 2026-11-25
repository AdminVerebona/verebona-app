/**
 * Carte #836 (écart E09) — MOTIF de non-application d'un arbitrage T3,
 * régression révélée par la recette E2E sur PostgreSQL réel.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LA RÉGRESSION
 *
 * Le contrôle en base introduit par l'écart E09 rend `VALUE_NOT_WRITTEN` dès
 * que la valeur lue diffère de la valeur attendue — **y compris lorsqu'elle en
 * diffère parce qu'elle est PROTÉGÉE** (saisie de l'utilisateur,
 * rétablissement BO, import) ou parce que l'événement porte une source que T3
 * ne gère pas (formulaire de sinistre, migration : la consolidation n'y
 * applique jamais un arbitrage T3). Le constat générique masquait donc le
 * motif précis et actionnable, `PROTECTED_OR_UNMANAGED_VALUE`, qui est celui
 * que la trace (`application_error`), le BO et le journal doivent porter.
 *
 * LA CORRECTION
 *
 * La cause SPÉCIFIQUE est prioritaire sur le constat générique.
 * `VALUE_NOT_WRITTEN` ne couvre plus que l'échec d'écriture INEXPLIQUÉ ; les
 * autres motifs (`OPERATION_GONE`, `PROVENANCE_MISMATCH`,
 * `CONFLICT_STILL_OPEN`) sont inchangés.
 *
 *   C836-R4-01  valeur protégée / source hors gestion : PROTECTED_OR_UNMANAGED_VALUE
 *   C836-R4-02  échec INEXPLIQUÉ : VALUE_NOT_WRITTEN conservé
 *   C836-R4-03  les autres motifs, et le cas « appliqué », sont intacts
 * Exécuteur SIMULÉ (aucune base : la recette réelle est dans
 * `src/test/e2e/scenarios/l115f-t3-arbitrage.e2e.ts`, cas L115F-E03).
 */
import { describe, expect, it } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { arbitrationFingerprint, verifyApplication } from '../attribute-arbitration/review';
import type { QualifiedAttributeConflict } from '../attribute-conflicts';

const COMPTE = 11;
const OPERATION = 8;

/** Texte littéral d'une requête Drizzle (paramètres exclus) — pour router l'exécuteur simulé. */
function texteSql(q: unknown): string {
  const chunks = (q as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks.map((c) => {
    const v = (c as { value?: unknown }).value;
    return Array.isArray(v) ? v.join(' ') : '';
  }).join(' ').replace(/\s+/g, ' ');
}

/** Contradiction de la MÊME empreinte que la décision (attribut, rôle, valeurs). */
const conflit = (over: Partial<QualifiedAttributeConflict> = {}): QualifiedAttributeConflict => ({
  field: 'realizedDate', role: 'MIXED',
  values: [
    { value: '2026-03-12', normalized: '2026-03-12', sourceIds: [1], sources: [] },
    { value: '2026-04-16', normalized: '2026-04-16', sourceIds: [2], sources: [] },
  ],
  retained: '2026-04-16', qualification: 'REAL_CONFLICT_UNRESOLVED', reasonCode: 'SAME_REFERENCE', impact: ['OPERATION'],
  ...over,
} as QualifiedAttributeConflict);

const EMPREINTE = arbitrationFingerprint(
  OPERATION, 'realizedDate', 'MIXED', conflit().values.map((v) => v.normalized),
);

/**
 * Exécuteur simulé : l'événement existe, porte `courant` et les contradictions
 * données ; `sources` dit ce que la table des sources répond (protection,
 * source hors gestion).
 */
function faux(p: {
  courant: string | null; conflicts?: QualifiedAttributeConflict[]; provenance?: string | null;
  protegee?: boolean | null; horsGestion?: boolean | null; evenementAbsent?: boolean; actif?: boolean;
}) {
  const lues: string[] = [];
  const x = {
    async execute(q: SQL): Promise<unknown> {
      const t = texteSql(q);
      lues.push(t);
      if (t.includes('FROM business_operation_sources')) {
        return [{ protegee: p.protegee ?? false, hors_gestion: p.horsGestion ?? false }];
      }
      if (p.evenementAbsent) return [];
      return [{
        active: p.actif ?? true, courant: p.courant,
        provenance: p.provenance === undefined ? p.courant : p.provenance,
        conflicts: p.conflicts ?? [],
      }];
    },
  };
  return { x, lues };
}

const decision = { id: 5, operationId: OPERATION, field: 'realizedDate' as const, role: 'MIXED', fingerprint: EMPREINTE };

describe('C836-R4-01 — protection ou source hors gestion : le motif PRÉCIS, pas le constat générique', () => {
  /**
   * CONTRE-EXEMPLE, repris du scénario de recette L115F-E03 : une saisie non gérée par T3 (formulaire de
   * sinistre, autorité USER) interdit la réécriture de la date. La valeur attendue n'est donc pas écrite —
   * et ce n'est pas un échec inexpliqué, c'est une protection.
   */
  it('source ACTIVE hors gestion de T3 : PROTECTED_OR_UNMANAGED_VALUE', async () => {
    const { x } = faux({ courant: '2026-04-16', horsGestion: true, protegee: true });
    expect(await verifyApplication(x, COMPTE, decision, '2026-03-12')).toEqual({
      applied: false, value: '2026-04-16', reason: 'PROTECTED_OR_UNMANAGED_VALUE',
    });
  });

  it('autorité PROTÉGÉE seule (saisie, rétablissement BO, import) : PROTECTED_OR_UNMANAGED_VALUE', async () => {
    const { x } = faux({ courant: '2026-04-16', protegee: true, horsGestion: false });
    expect(await verifyApplication(x, COMPTE, decision, '2026-03-12')).toMatchObject({
      applied: false, reason: 'PROTECTED_OR_UNMANAGED_VALUE',
    });
  });

  it('la ligne de contradiction du MÊME champ et du MÊME rôle porte sa protection : aucune lecture de plus n’est même nécessaire', async () => {
    const { x, lues } = faux({
      courant: '2026-04-16', conflicts: [conflit({ protection: 'USER' })], protegee: false, horsGestion: false,
    });
    expect(await verifyApplication(x, COMPTE, decision, '2026-03-12')).toMatchObject({
      applied: false, reason: 'PROTECTED_OR_UNMANAGED_VALUE',
    });
    expect(lues.some((t) => t.includes('FROM business_operation_sources'))).toBe(false);
  });
});

describe('C836-R4-02 — échec INEXPLIQUÉ : VALUE_NOT_WRITTEN conservé', () => {
  it('aucune protection, aucune source hors gestion : le constat générique reste le bon motif', async () => {
    const { x } = faux({ courant: '2026-04-16', protegee: false, horsGestion: false });
    expect(await verifyApplication(x, COMPTE, decision, '2026-03-12')).toEqual({
      applied: false, value: '2026-04-16', reason: 'VALUE_NOT_WRITTEN',
    });
  });

  it('table des sources illisible (aucune ligne rendue) : rien n’est inventé — le motif reste générique', async () => {
    const x = {
      async execute(q: SQL): Promise<unknown> {
        const t = texteSql(q);
        if (t.includes('FROM business_operation_sources')) return [];
        return [{ active: true, courant: null, provenance: null, conflicts: [] }];
      },
    };
    expect(await verifyApplication(x, COMPTE, decision, '2026-03-12')).toMatchObject({ reason: 'VALUE_NOT_WRITTEN' });
  });
});

describe('C836-R4-03 — les autres motifs et le cas « appliqué » sont intacts', () => {
  it('événement disparu, fusionné ou invalidé : OPERATION_GONE', async () => {
    expect(await verifyApplication(faux({ courant: null, evenementAbsent: true }).x, COMPTE, decision, '2026-03-12'))
      .toEqual({ applied: false, value: null, reason: 'OPERATION_GONE' });
    expect(await verifyApplication(faux({ courant: '2026-03-12', actif: false }).x, COMPTE, decision, '2026-03-12'))
      .toMatchObject({ applied: false, reason: 'OPERATION_GONE' });
  });

  it('provenance discordante : PROVENANCE_MISMATCH', async () => {
    const { x } = faux({ courant: '2026-03-12', provenance: '2026-04-16' });
    expect(await verifyApplication(x, COMPTE, decision, '2026-03-12')).toMatchObject({ reason: 'PROVENANCE_MISMATCH' });
  });

  it('contradiction de la même empreinte toujours ouverte : CONFLICT_STILL_OPEN', async () => {
    const { x } = faux({ courant: '2026-03-12', conflicts: [conflit()] });
    expect(await verifyApplication(x, COMPTE, decision, '2026-03-12')).toMatchObject({ reason: 'CONFLICT_STILL_OPEN' });
  });

  it('valeur écrite, provenance concordante, contradiction refermée : APPLIQUÉ (aucun motif)', async () => {
    const { x } = faux({ courant: '2026-03-12', conflicts: [] });
    expect(await verifyApplication(x, COMPTE, decision, '2026-03-12')).toEqual({ applied: true, value: '2026-03-12' });
  });
});
