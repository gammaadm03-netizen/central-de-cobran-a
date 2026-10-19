import test from 'node:test';
import assert from 'node:assert/strict';
import { LOGIN_THEMES, loginThemeForDate } from './login-themes.ts';

test('each Brazilian calendar month has its own complete welcome campaign', () => {
  assert.equal(LOGIN_THEMES.length, 12);
  for (let index = 0; index < 12; index += 1) {
    const theme = loginThemeForDate(new Date(Date.UTC(2026, index, 15, 12)));
    assert.equal(theme.month, index + 1);
    assert.equal(theme, LOGIN_THEMES[index]);
    for (const field of ['name', 'title', 'accent', 'accentSoft', 'accentInk', 'motif', 'message']) assert.ok(theme[field]);
  }
  assert.equal(LOGIN_THEMES[9].title, 'Outubro Rosa');
  assert.equal(LOGIN_THEMES[9].motif, 'ribbon');
});

test('campaign changes at the São Paulo month boundary, independently of the host timezone', () => {
  assert.equal(loginThemeForDate(new Date('2026-11-01T02:59:59.999Z')).title, 'Outubro Rosa');
  assert.equal(loginThemeForDate(new Date('2026-11-01T03:00:00.000Z')).title, 'Novembro Azul');
  assert.equal(loginThemeForDate(new Date('2027-01-01T02:59:59.999Z')).title, 'Natal');
  assert.equal(loginThemeForDate(new Date('2027-01-01T03:00:00.000Z')).title, 'Janeiro Branco');
});
