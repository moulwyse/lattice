const assert = require('node:assert/strict');
const test = require('node:test');
const { TokenRepository } = require('../src/auth/token-repository.js');
const { AuthService } = require('../src/auth/service.js');
const { getAuditEvents, resetAuditEvents } = require('../src/auth/audit.js');

test('valid reset token is consumed only once', () => {
  const tokens = new TokenRepository(() => 100);
  tokens.issue('valid', 200);
  assert.equal(tokens.consume('valid').value, 'valid');
  assert.equal(tokens.consume('valid'), undefined);
});

test('expired reset token remains rejected', () => {
  const tokens = new TokenRepository(() => 200);
  tokens.issue('expired', 100);
  assert.equal(tokens.consume('expired'), undefined);
});

test('successful password reset records an audit event', () => {
  resetAuditEvents();
  const tokens = new TokenRepository(() => 100);
  tokens.issue('audit-me', 200);
  new AuthService(tokens).resetPassword('audit-me');
  assert.deepEqual(getAuditEvents(), [{ type: 'password_reset', token: 'audit-me' }]);
});

test('existing login behavior remains unchanged', () => {
  const service = new AuthService();
  assert.deepEqual(service.login('alice', 'correct-password'), {
    username: 'alice',
    authenticated: true,
  });
  assert.equal(service.login('alice', 'wrong-password'), undefined);
});
