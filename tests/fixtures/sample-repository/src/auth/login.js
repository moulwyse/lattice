function login(users, username, password) {
  return users.get(username) === password
    ? { username, authenticated: true }
    : undefined;
}

module.exports = { login };
