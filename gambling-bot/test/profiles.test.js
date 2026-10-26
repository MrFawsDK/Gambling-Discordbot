import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDatabase } from '../src/db.js';
import { Profiles } from '../src/services/profiles.js';

test('profiles are upserted and repeated writes are skipped', () => {
  const db = openDatabase(':memory:');
  const profiles = new Profiles(db, { minIntervalMs: 1000 });
  profiles.saveUser('u', 'Alice', 'https://cdn.discordapp.com/a.png', 0);
  profiles.saveUser('u', 'Alice', 'https://cdn.discordapp.com/a.png', 500);
  assert.equal(db.prepare('SELECT updated_at FROM user_profiles').get().updated_at, 0);

  // A new name is written right away.
  profiles.saveUser('u', 'Alice2', 'https://cdn.discordapp.com/a.png', 600);
  assert.equal(db.prepare('SELECT name FROM user_profiles').get().name, 'Alice2');

  profiles.saveGuild('g', 'Server', null, 0);
  assert.equal(db.prepare('SELECT name FROM guild_profiles').get().name, 'Server');
});

test('needsRefresh lists players without a profile first, then stale ones', () => {
  const db = openDatabase(':memory:');
  const profiles = new Profiles(db);
  const insert = db.prepare('INSERT INTO users (guild_id, user_id, balance) VALUES (?, ?, 100)');
  insert.run('g1', 'fresh');
  insert.run('g1', 'stale');
  insert.run('g1', 'missing');
  // On two servers: still listed once.
  insert.run('g2', 'missing');
  profiles.saveUser('fresh', 'Fresh', null, 1000);
  profiles.saveUser('stale', 'Stale', null, 10);

  assert.deepEqual(profiles.needsRefresh(500), [
    { userId: 'missing', guildId: 'g1' },
    { userId: 'stale', guildId: 'g1' },
  ]);
});
