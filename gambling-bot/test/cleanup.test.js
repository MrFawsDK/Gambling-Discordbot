import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { RESTJSONErrorCodes } from 'discord.js';
import { openDatabase } from '../src/db.js';
import { MessageCleanup } from '../src/services/cleanup.js';

const HOUR = 60 * 60 * 1000;
let db;
let deleted;
let failWith;

// Fake client: records deletions, or throws a Discord-like error when told to.
const client = {
  rest: {
    async delete(route) {
      if (failWith) throw Object.assign(new Error('fail'), { code: failWith });
      deleted.push(route);
    },
  },
};

const pending = () => db.prepare('SELECT * FROM scheduled_deletions').all();

beforeEach(() => {
  db = openDatabase(':memory:');
  deleted = [];
  failWith = null;
});

test('messages are only deleted once they are due', async () => {
  const cleanup = new MessageCleanup(db, client, HOUR);
  cleanup.schedule('chan', 'msg', 0);

  await cleanup.sweep(HOUR - 1);
  assert.equal(deleted.length, 0);

  await cleanup.sweep(HOUR);
  assert.deepEqual(deleted, ['/channels/chan/messages/msg']);
  assert.equal(pending().length, 0);
});

test('already deleted messages are dropped instead of retried', async () => {
  const cleanup = new MessageCleanup(db, client, HOUR);
  cleanup.schedule('chan', 'msg', 0);
  failWith = RESTJSONErrorCodes.UnknownMessage;

  await cleanup.sweep(HOUR);
  assert.equal(pending().length, 0);
});

test('temporary errors are retried later, then given up', async () => {
  const cleanup = new MessageCleanup(db, client, HOUR);
  cleanup.schedule('chan', 'msg', 0);
  failWith = 'ECONNRESET';
  const originalError = console.error;
  console.error = () => {};

  try {
    let now = HOUR;
    for (let attempt = 1; attempt < 5; attempt++) {
      await cleanup.sweep(now);
      assert.equal(pending()[0].attempts, attempt);
      now = pending()[0].delete_at;
    }
    await cleanup.sweep(now);
    assert.equal(pending().length, 0);
  } finally {
    console.error = originalError;
  }
});

test('lifetime 0 disables cleanup', () => {
  const cleanup = new MessageCleanup(db, client, 0);
  cleanup.schedule('chan', 'msg', 0);
  assert.equal(cleanup.enabled, false);
  assert.equal(pending().length, 0);
});
