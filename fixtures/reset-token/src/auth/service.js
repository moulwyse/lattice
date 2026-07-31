const { TokenRepository } = require('./token-repository.js');

class AuthService {
  constructor(tokens = new TokenRepository(), users = new Map([['alice', 'correct-password']])) {
    this.tokens = tokens;
    this.users = users;
  }

  login(username, password) {
    return this.users.get(username) === password
      ? { username, authenticated: true }
      : undefined;
  }

  resetPassword(value) {
    return this.tokens.consume(value);
  }
}

module.exports = { AuthService };
