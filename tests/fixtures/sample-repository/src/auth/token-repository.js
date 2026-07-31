class TokenRepository {
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
