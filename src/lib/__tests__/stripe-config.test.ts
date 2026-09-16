import { describe, it, expect } from 'vitest';
import {
  assertStripeConfig,
  getExpectedStripeMode,
  getStripeKeyMode,
  getTierFromPriceId,
  StripeConfigError,
} from '@/lib/stripe';

const env = (vars: Record<string, string | undefined>) => vars as NodeJS.ProcessEnv;

describe('getStripeKeyMode', () => {
  it('lit le mode depuis le préfixe', () => {
    expect(getStripeKeyMode('sk_test_abc')).toBe('test');
    expect(getStripeKeyMode('rk_live_abc')).toBe('live');
    expect(getStripeKeyMode('whsec_abc')).toBeNull();
    expect(getStripeKeyMode(undefined)).toBeNull();
  });
});

describe('getExpectedStripeMode', () => {
  it('attend live en production, test ailleurs', () => {
    expect(getExpectedStripeMode(env({ NEXT_PUBLIC_APP_ENV: 'production' }))).toBe('live');
    expect(getExpectedStripeMode(env({ NEXT_PUBLIC_APP_ENV: 'prod' }))).toBe('live');
    expect(getExpectedStripeMode(env({ NEXT_PUBLIC_APP_ENV: 'preprod' }))).toBe('test');
    expect(getExpectedStripeMode(env({ NEXT_PUBLIC_APP_ENV: 'local' }))).toBe('test');
    expect(getExpectedStripeMode(env({}))).toBeNull();
  });

  it('STRIPE_EXPECTED_MODE est prioritaire', () => {
    expect(getExpectedStripeMode(env({ NEXT_PUBLIC_APP_ENV: 'preprod', STRIPE_EXPECTED_MODE: 'live' }))).toBe('live');
  });
});

describe('assertStripeConfig', () => {
  it('refuse une clé live en preprod', () => {
    expect(() => assertStripeConfig(env({ NEXT_PUBLIC_APP_ENV: 'preprod', STRIPE_SECRET_KEY: 'sk_live_x' })))
      .toThrowError(StripeConfigError);
  });

  it('refuse une clé test en production', () => {
    expect(() => assertStripeConfig(env({ NEXT_PUBLIC_APP_ENV: 'production', STRIPE_SECRET_KEY: 'sk_test_x' })))
      .toThrowError(/mode "test"/);
  });

  it('accepte une configuration cohérente', () => {
    expect(assertStripeConfig(env({ NEXT_PUBLIC_APP_ENV: 'preprod', STRIPE_SECRET_KEY: 'sk_test_x' }))).toBe('test');
    expect(assertStripeConfig(env({ NEXT_PUBLIC_APP_ENV: 'production', STRIPE_SECRET_KEY: 'sk_live_x' }))).toBe('live');
  });

  it('signale une clé absente ou illisible', () => {
    expect(() => assertStripeConfig(env({}))).toThrowError(/STRIPE_SECRET_KEY is not defined/);
    expect(() => assertStripeConfig(env({ STRIPE_SECRET_KEY: 'pouet' }))).toThrowError(/unknown prefix/);
  });
});

describe('getTierFromPriceId', () => {
  it('reconnaît les 6 prix V2', () => {
    process.env.STRIPE_PRICE_STANDARD_MONTHLY = 'price_std_m';
    process.env.STRIPE_PRICE_PREMIUM_DUO_YEARLY = 'price_duo_y';
    expect(getTierFromPriceId('price_std_m')).toBe('standard');
    expect(getTierFromPriceId('price_duo_y')).toBe('premium_duo');
    expect(getTierFromPriceId('price_inconnu')).toBeNull();
    expect(getTierFromPriceId(undefined)).toBeNull();
    delete process.env.STRIPE_PRICE_STANDARD_MONTHLY;
    delete process.env.STRIPE_PRICE_PREMIUM_DUO_YEARLY;
  });
});
