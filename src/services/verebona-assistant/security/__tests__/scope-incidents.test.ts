/** CDC Assistant §32.2 (lot 19) — incidents de cloisonnement comptés par instance, sans contenu. */
import { describe, it, expect, vi } from 'vitest';
import { recordScopeIncident, scopeIncidentCounters, resetScopeIncidentsForTests } from '../scope-incidents';

describe('incidents de cloisonnement', () => {
  it('compte par type, journal sans valeur', () => {
    resetScopeIncidentsForTests();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    recordScopeIncident('CLIENT_ACCOUNT_OVERRIDE');
    recordScopeIncident('CLIENT_ACCOUNT_OVERRIDE');
    expect(scopeIncidentCounters()).toEqual({ CLIENT_ACCOUNT_OVERRIDE: 2 });
    expect(warn).toHaveBeenCalledWith('[verebona][cloisonnement] incident CLIENT_ACCOUNT_OVERRIDE');
    resetScopeIncidentsForTests();
    expect(scopeIncidentCounters()).toEqual({ CLIENT_ACCOUNT_OVERRIDE: 0 });
  });
});
