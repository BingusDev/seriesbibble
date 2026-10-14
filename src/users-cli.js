#!/usr/bin/env node
// Account maintenance from the command line, e.g. in Docker:
//   docker compose exec series-bible node src/users-cli.js list
//   docker compose exec series-bible node src/users-cli.js add <username> <password>
//   docker compose exec series-bible node src/users-cli.js reset-password <username> <new password>
const auth = require('./auth');

const [cmd, username, password] = process.argv.slice(2);

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

try {
  if (cmd === 'list') {
    const users = auth.allUsers();
    if (!users.length) console.log('No accounts yet.');
    for (const u of users) console.log(`${u.username}\t${u.displayName}\tcreated ${u.createdAt}`);
  } else if (cmd === 'add') {
    if (!username || !password) fail('Usage: users-cli.js add <username> <password>');
    console.log(`Created ${auth.createUser({ username, password }).username}`);
  } else if (cmd === 'reset-password') {
    if (!username || !password) fail('Usage: users-cli.js reset-password <username> <new password>');
    const user = auth.findByName(username);
    if (!user) fail(`No account named ${username}`);
    auth.setPassword(user, password);
    console.log(`Password changed for ${user.username}; they are signed out everywhere.`);
  } else {
    fail('Commands: list | add <username> <password> | reset-password <username> <new password>');
  }
} catch (err) {
  fail(err.message);
}
