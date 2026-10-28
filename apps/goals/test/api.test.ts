import { describe, expect, it } from 'vitest';
import { needsSignIn, signInUrl } from '../src/api';

const at = (pathname: string, search = '', hash = '') => ({ pathname, search, hash });

describe('needsSignIn', () => {
  it('opens without login, or with a Goals session', () => {
    expect(needsSignIn({ login: false, signedIn: { goals: false, terminal: false } })).toBe(false);
    expect(needsSignIn({ login: true, signedIn: { goals: true, terminal: false } })).toBe(false);
  });

  it('asks to sign in with login on and no Goals session', () => {
    expect(needsSignIn({ login: true, signedIn: { goals: false, terminal: false } })).toBe(true);
  });
});

describe('signInUrl', () => {
  it('comes back to this page, query and hash included', () => {
    expect(signInUrl(at('/goals/'))).toBe('/signin?scope=goals&next=%2Fgoals%2F');
    expect(signInUrl(at('/goals/g3', '?tab=steps', '#step-2'))).toBe(`/signin?scope=goals&next=${encodeURIComponent('/goals/g3?tab=steps#step-2')}`);
  });

  it('never sends people outside Goals afterwards', () => {
    expect(signInUrl(at('/'))).toBe('/signin?scope=goals&next=%2Fgoals%2F');
    expect(signInUrl(at('//evil.example/goals'))).toBe('/signin?scope=goals&next=%2Fgoals%2F');
  });
});
