const { TokenRepository } = require('./token-repository.js');
const { login } = require('./login.js');

class AuthService {
  constructor(tokens = new TokenRepository(), users = new Map([['alice', 'correct-password']])) {
    this.tokens = tokens;
    this.users = users;
  }

  login(username, password) {
    return login(this.users, username, password);
  }

  resetPassword(value) {
    return this.tokens.consume(value);
  }
}

module.exports = { AuthService };
