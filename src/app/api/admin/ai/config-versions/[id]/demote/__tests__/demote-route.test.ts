/**
 * Lot 54 (54C) — gestes du workflow supprimé et de publication : 410 avec le
 * geste de remplacement (« Activer en préproduction », « Exporter la
 * configuration »). Aucun appel au service, aucune écriture.
 */
import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/app/api/admin/ai/config-versions/_shared', async (orig) => ({
  ...(await orig<typeof import('@/app/api/admin/ai/config-versions/_shared')>()),
  requireAdminContext: async () => ({ ok: true, ctx: { adminUserId: 1 } }),
}));
const service = vi.fn();
vi.mock('@/services/ai/config/config-version.service', async (orig) => ({
  ...(await orig<typeof import('@/services/ai/config/config-version.service')>()),
  activate: service, saveConfiguration: service,
}));

const routes = {
  demote: () => import('../route'),
  promote: () => import('../../promote/route'),
  validate: () => import('../../validate/route'),
  package: () => import('../../package/route'),
  import: () => import('@/app/api/admin/ai/config-packages/import/route'),
};

describe('BOIA-15 — plus de Brouillon / À tester / Validé ni de publication en production', () => {
  for (const [nom, charger] of Object.entries(routes)) {
    it(`${nom} : 410 WORKFLOW_REMOVED, rien n’est exécuté`, async () => {
      const { POST } = await charger();
      const r = await (POST as (req: NextRequest) => Promise<Response>)(new NextRequest(`http://localhost/x/${nom}`, { method: 'POST' }));
      expect(r.status).toBe(410);
      expect(await r.json()).toMatchObject({ error: 'WORKFLOW_REMOVED' });
      expect(service).not.toHaveBeenCalled();
    });
  }
});
