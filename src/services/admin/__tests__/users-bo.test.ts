/**
 * Utilisateurs — CDC Back-Office V1 §6.1 (liste) et §6.2 / §6.3 (fiche).
 */
import { describe, it, expect } from 'vitest';
import { parseListParams, paginateRows, sortRows, containsPattern } from '@/services/admin/list-params';
import { USER_SORTS, userOrderBy, userDisplayStatus } from '@/services/admin/user-list.service';
import {
  describeUserAgent,
  duoInvitationBlockReason,
  memberRole,
  normalizeCommunicationStatus,
  truncateIp,
} from '@/services/admin/user-detail.service';

describe('parseListParams (GEN-004, USR-L05)', () => {
  it('valeurs par défaut et liste blanche du tri', () => {
    const p = parseListParams(new URLSearchParams('sort=role&dir=up&page=-3'), USER_SORTS, { sort: 'name', dir: 'asc' });
    expect(p).toMatchObject({ sort: 'name', dir: 'asc', page: 1, q: '' });
  });
  it('lit q, sort, dir et page valides', () => {
    const p = parseListParams(new URLSearchParams('q=%20Dupont%20&sort=account&dir=desc&page=3'), USER_SORTS, { sort: 'name', dir: 'asc' });
    expect(p).toMatchObject({ q: 'Dupont', sort: 'account', dir: 'desc', page: 3 });
  });
});

describe('recherche (USR-L02)', () => {
  it('neutralise les jokers ILIKE saisis', () => {
    expect(containsPattern('50%_a\\b')).toBe('%50\\%\\_a\\\\b%');
  });
});

describe('tri des utilisateurs (USR-L05)', () => {
  it('ne trie que sur les colonnes visibles, sans statut admin ni dates', () => {
    expect([...USER_SORTS]).toEqual(['name', 'email', 'account', 'plan', 'status']);
  });
  it('produit un ORDER BY stable avec NULLS LAST', () => {
    expect(userOrderBy('name', 'asc')).toBe('lower(u.last_name) ASC NULLS LAST, lower(u.first_name) ASC NULLS LAST, u.id ASC');
    expect(userOrderBy('account', 'desc')).toBe('lower(acc.name) DESC NULLS LAST, u.id DESC');
  });
  it('statut affiché : actif ou désactivé', () => {
    expect(userDisplayStatus('ACTIVE')).toBe('active');
    expect(userDisplayStatus('SUSPENDED')).toBe('disabled');
    expect(userDisplayStatus(null)).toBe('disabled');
  });
});

describe('paginateRows / sortRows', () => {
  it('borne la page et calcule le total', () => {
    const r = paginateRows([1, 2, 3, 4, 5], 9, 2);
    expect(r).toEqual({ items: [5], page: 3, pageSize: 2, total: 5, totalPages: 3 });
    expect(paginateRows([], 1, 25)).toMatchObject({ total: 0, totalPages: 1, items: [] });
  });
  it('valeurs absentes toujours en fin, chaînes sans casse', () => {
    const rows = [{ v: 'b' }, { v: null }, { v: 'A' }, { v: 'c' }];
    expect(sortRows(rows, (r) => r.v, 'asc').map((r) => r.v)).toEqual(['A', 'b', 'c', null]);
    expect(sortRows(rows, (r) => r.v, 'desc').map((r) => r.v)).toEqual(['c', 'b', 'A', null]);
    const nums = [{ n: 3 }, { n: 10 }, { n: 1 }];
    expect(sortRows(nums, (r) => r.n, 'desc').map((r) => r.n)).toEqual([10, 3, 1]);
  });
});

describe('fiche utilisateur (§6.2, USR-D02)', () => {
  it('tronque les IP', () => {
    expect(truncateIp('192.168.1.42')).toBe('192.168.1.x');
    expect(truncateIp('::ffff:10.0.0.7')).toBe('10.0.0.x');
    expect(truncateIp('203.0.113.9, 10.0.0.1')).toBe('203.0.113.x');
    expect(truncateIp('2001:db8:85a3:0:0:8a2e:370:7334')).toBe('2001:db8:85a3:…');
    expect(truncateIp(null)).toBeNull();
    expect(truncateIp('unknown')).toBeNull();
  });
  it('décrit l’appareil depuis le User-Agent', () => {
    expect(describeUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit Safari/604.1')).toBe('Safari · iOS');
    expect(describeUserAgent('Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537 Edg/120')).toBe('Edge · Windows');
    expect(describeUserAgent('curl/8')).toBe('Autre');
    expect(describeUserAgent(null)).toBeNull();
  });
  it('rôle titulaire / second utilisateur', () => {
    expect(memberRole({ isAccountOwner: true, membershipRole: 'member', isDuoSecond: false })).toBe('holder');
    expect(memberRole({ isAccountOwner: false, membershipRole: 'owner', isDuoSecond: false })).toBe('holder');
    expect(memberRole({ isAccountOwner: false, membershipRole: 'member', isDuoSecond: true })).toBe('second');
  });
  it('statuts de communication normalisés (COM-014)', () => {
    expect(normalizeCommunicationStatus('SENT')).toBe('sent');
    expect(normalizeCommunicationStatus('failed')).toBe('failed');
    expect(normalizeCommunicationStatus('skipped_preference')).toBe('skipped');
    expect(normalizeCommunicationStatus('pending')).toBe('pending');
  });
});

describe('USR-A01 : invitation réémissible', () => {
  const base = { pendingInviteEmail: 'b@x.fr', pendingInviteToken: 't', hasActiveSecond: false, duoStatus: 'ACTIVE' };
  it('en attente, même expirée : réémissible', () => {
    expect(duoInvitationBlockReason(base)).toBeNull();
  });
  it('refusée si aucune invitation, second déjà actif ou Duo terminé', () => {
    expect(duoInvitationBlockReason({ ...base, pendingInviteEmail: null })).toMatch(/Aucune/);
    expect(duoInvitationBlockReason({ ...base, hasActiveSecond: true })).toMatch(/déjà rejoint/);
    expect(duoInvitationBlockReason({ ...base, duoStatus: 'CANCELED' })).toMatch(/plus actif/);
  });
});
