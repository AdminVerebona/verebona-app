import { describe, it, expect } from 'vitest';
import { getSignupMode, isPrelaunch, parseSignupMode } from '../prelaunch';

describe('SIGNUP_MODE', () => {
  it('absent ou vide : full (aucun environnement fermé par surprise)', () => {
    expect(parseSignupMode(undefined)).toBe('full');
    expect(parseSignupMode('')).toBe('full');
    expect(parseSignupMode('   ')).toBe('full');
    expect(getSignupMode({})).toBe('full');
  });

  it('valeurs alignées sur le site public (full | prelaunch), « open » synonyme de full', () => {
    expect(parseSignupMode('full')).toBe('full');
    expect(parseSignupMode('open')).toBe('full');
    expect(parseSignupMode(' PRELAUNCH ')).toBe('prelaunch');
    expect(isPrelaunch({ SIGNUP_MODE: 'prelaunch' })).toBe(true);
  });

  it('valeur inconnue : fermé par prudence', () => {
    expect(parseSignupMode('prelaunche')).toBe('prelaunch');
    expect(parseSignupMode('closed')).toBe('prelaunch');
  });
});
