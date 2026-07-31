import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execa } from 'execa';
import { removeDirectoryWithRetry } from '../src/cleanup.js';

export type TestRepository = {
  path: string;
  cleanup(): Promise<void>;
};

export async function repository(
  files: Record<string, string | Buffer>,
  options: { autocrlf?: 'true' | 'false' | 'input'; attributes?: string } = {},
): Promise<TestRepository> {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'lattice-v2-test-')));
  writeFileSync(join(path, '.gitignore'), '.lattice/\nnode_modules/\n');
  if (options.attributes !== undefined) {
    writeFileSync(join(path, '.gitattributes'), options.attributes);
  }
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = join(path, relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
  }
  await execa('git', ['init'], { cwd: path });
  await execa('git', ['config', 'user.email', 'tests@example.invalid'], { cwd: path });
  await execa('git', ['config', 'user.name', 'Lattice Tests'], { cwd: path });
  await execa('git', ['config', 'core.autocrlf', options.autocrlf ?? 'false'], { cwd: path });
  await execa('git', ['add', '.'], { cwd: path });
  await execa('git', ['commit', '-m', 'fixture'], { cwd: path });
  return {
    path,
    cleanup: () => removeDirectoryWithRetry(path),
  };
}

export const fixtureFiles = {
  'package.json': JSON.stringify({
    private: true,
    scripts: { test: 'node --test tests/reset-token.test.js' },
  }),
  'src/auth/token-repository.js': `class TokenRepository {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.tokens = new Map();
  }
  issue(value, expiresAt) {
    const token = { value, expiresAt, used: false };
    this.tokens.set(value, token);
    return token;
  }
  consume(value) {
    const token = this.tokens.get(value);
    if (!token || token.expiresAt <= this.now()) return undefined;
    return token;
  }
}
module.exports = { TokenRepository };
`,
  'src/auth/audit.js': `const events = [];
function recordAudit(event) { events.push(event); }
function getAuditEvents() { return [...events]; }
function resetAuditEvents() { events.length = 0; }
module.exports = { recordAudit, getAuditEvents, resetAuditEvents };
`,
  'src/auth/service.js': `const { TokenRepository } = require('./token-repository.js');
class AuthService {
  constructor(tokens = new TokenRepository(), users = new Map([['alice', 'correct-password']])) {
    this.tokens = tokens;
    this.users = users;
  }
  login(username, password) {
    return this.users.get(username) === password ? { username, authenticated: true } : undefined;
  }
  resetPassword(value) {
    return this.tokens.consume(value);
  }
}
module.exports = { AuthService };
`,
  'tests/reset-token.test.js': `const assert = require('node:assert/strict');
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
  assert.deepEqual(service.login('alice', 'correct-password'), { username: 'alice', authenticated: true });
  assert.equal(service.login('alice', 'wrong-password'), undefined);
});
`,
};
