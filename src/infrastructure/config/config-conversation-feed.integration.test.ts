import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import mysql from 'mysql2/promise';
import { migrateBailingHubCoreSchema } from '../schema/core-schema-migrator';
import { AgentConversationAuditRepository } from './config-agent-conversation-audit-repository';
import { ConversationLedger } from './config-conversation-ledger';

test('admin conversation feed pages incoming and delivery-only threads without duplicating archived runs',
  { skip: !process.env.BAILING_FEED_TEST_MYSQL_PORT }, async () => {
    const database = `feed_test_${randomBytes(8).toString('hex')}`;
    const connection = { host: '127.0.0.1', port: Number(process.env.BAILING_FEED_TEST_MYSQL_PORT), user: 'root', password: '' };
    const admin = await mysql.createConnection(connection);
    const pool = mysql.createPool({ ...connection, database, timezone: 'Z' });
    try {
      await admin.query(`CREATE DATABASE ${database}`);
      await migrateBailingHubCoreSchema({ mysql: { ...connection, database, connectionLimit: 4 } });
      const archive = randomUUID();
      const at = '2026-10-04 13:00:00';
      await pool.query('INSERT INTO bz_agent_conversation_audits SET ?', [{
        conversation_id: archive, creator_session_id: randomUUID(), client_app_id: 'store-assistant', route_key: 'orders',
        client_archive_id: randomUUID(), client_conversation_id: 'customer-conversation', state: 'ready',
        member_count: 1, confirmed_count: 1, enrollment_hash: 'a'.repeat(64), created_at: at, updated_at: at,
      }]);
      await pool.query('INSERT INTO bz_chat_entries (entry_key,name,route_key,created_at,updated_at) VALUES (?,?,?,?,?)',
        ['shop', 'Storefront', 'orders', at, at]);
      const seedThread = async (id: number, timestamp = at, scope = `scope-${id}`) => pool.query('INSERT INTO bz_threads SET ?', [{
        thread_id: id, route_key: 'orders', scope_key: scope, created_at: at, last_active_at: timestamp,
      }]);
      const message = async (id: number, channel: string, content: string, run: string | null = null, direction = 'in', job: string | null = null) => {
        await pool.query('INSERT INTO bz_messages SET ?', [{
          thread_id: id, direction, channel, content, agent_run_id: run, job_id: job, created_at: at,
        }]);
        await pool.query('UPDATE bz_threads SET message_count=message_count+1 WHERE thread_id=?', [id]);
      };
      let sequence = 0;
      const event = async (kind: string, content: string | null, thread_id: number | null = null, run_id: string | null = null) => {
        ++sequence;
        await pool.query('INSERT INTO bz_agent_conversation_events SET ?', [{
          conversation_id: archive, sequence, event_id: `e${sequence}`, client_turn_id: 'turn', kind, content,
          thread_id, run_id, event_hash: 'b'.repeat(64), created_at: at,
        }]);
      };
      await event('user_message', '归档'.repeat(60));
      for (const id of [11, 12, 13, 15, 16]) await seedThread(id);
      await seedThread(14, at, 'wecom:store-service:synthetic-recipient');
      await seedThread(17, '2026-10-05 13:00:00');
      const covered = randomUUID(), partial = randomUUID();
      await message(11, 'agent:store-assistant', 'covered run', covered);
      await event('run_link', null, 11, covered);
      await message(11, 'delivery', 'do not resurrect a fully archived thread', null, 'out');
      await message(12, 'agent:store-assistant', 'covered part', partial);
      await event('run_link', null, 12, partial);
      await message(12, 'agent:store-assistant', 'unarchived part', randomUUID());
      await message(13, 'agent:other-client', 'standalone');
      await message(14, 'delivery', 'outgoing only', null, 'out');
      await message(15, 'delivery', 'notice before the first user question', null, 'out');
      await message(15, 'wecom:service', 'WeCom question');
      await message(16, 'business-system', 'business app request');
      await message(17, 'chat:shop', 'web question – no reply');

      const feed = new AgentConversationAuditRepository(() => pool);
      const all = await feed.listFeedForAdmin('all');
      assert.deepEqual(all.items.map((item: any) => item.thread_id ?? item.conversation_id), [17, archive, 16, 15, 14, 13, 12]);
      assert.equal(all.items[0].source_label, 'Storefront');
      assert.equal(all.items[0].title, 'web question – no reply');
      assert.equal(all.items[1].title, '归档'.repeat(48));
      assert.equal(all.items.at(-1).title, 'unarchived part');
      assert.deepEqual(all.items.map((item: any) => item.source), ['web', 'client', 'other', 'wecom', 'delivery', 'client', 'client']);
      const delivery = await feed.listFeedForAdmin('delivery');
      assert.deepEqual(delivery.items.map((item: any) => [item.thread_id, item.source_label, item.title]),
        [[14, 'store-service', 'outgoing only']]);
      assert.equal(all.items.find((item: any) => item.thread_id === 15).title, 'WeCom question');
      const clientPage = await feed.listFeedForAdmin('client', 1, 1);
      assert.equal(clientPage.items[0].thread_id, 13);
      assert.equal(clientPage.items[0].client_app_id, 'other-client');
      assert.equal(clientPage.next_offset, 2);
      const lastClientPage = await feed.listFeedForAdmin('client', 1, clientPage.next_offset);
      assert.equal(lastClientPage.items[0].thread_id, 12);
      assert.equal(lastClientPage.next_offset, null);
      // One backdated insertion and one new top entry must not shift the continuation.
      const firstTwo = await feed.listFeedForAdmin('all', 2);
      await seedThread(18, '2026-10-06 13:00:00');
      await message(18, 'chat:shop', 'new arrival before the cursor');
      await seedThread(19, '2026-10-03 13:00:00');
      await message(19, 'chat:shop', 'older history');
      const middle = await feed.listFeedForAdmin('all', 2, 0, firstTwo.next_cursor);
      assert.deepEqual(middle.items.map((i: any) => i.thread_id), [16, 15]);
      const end = await feed.listFeedForAdmin('all', 10, 0, middle.next_cursor);
      assert.deepEqual(end.items.map((i: any) => i.thread_id), [14, 13, 12, 19]);
      assert.equal(end.next_cursor, null);
      await assert.rejects(feed.listFeedForAdmin('client', 2, 0, firstTwo.next_cursor), /Invalid conversation feed cursor/);
      await assert.rejects(feed.listFeedForAdmin('all', 2, 1, firstTwo.next_cursor), /Choose cursor or offset/);
      for (const source of ['wecom', 'other'] as const) {
        const page = await feed.listFeedForAdmin(source, 1);
        assert.equal(page.items[0].source, source);
        assert.equal(page.has_more, false);
      }

      // /send writes the caller's app ID in channel. A successful outbound job
      // establishes delivery; an orphan reply or a coincidentally similar ID does not.
      for (const id of [20, 21, 22, 23, 24, 25]) await seedThread(id);
      const sendJob = async (id: number, via: string, outbound: boolean, status: string) => {
        const job = randomUUID();
        await pool.query('INSERT INTO bz_jobs SET ?', [{
          job_id: job, request_id: job, target: 'channel-send', status, profile: 'default',
          metadata: JSON.stringify({ via, outbound }), created_at: at, updated_at: at,
        }]);
        await message(id, 'store-service', 'business push', null, 'out', job);
      };
      await sendJob(20, 'send', true, 'done');
      await sendJob(21, 'send', false, 'done');
      await sendJob(22, 'send', true, 'error');
      await message(23, 'hub', 'orphan reply', null, 'out');
      await message(24, 'brain-send', 'tool delivery', null, 'out');
      await sendJob(25, 'other', true, 'done');
      await sendJob(15, 'send', true, 'done');
      const notifications = await feed.listFeedForAdmin('delivery');
      assert.deepEqual(notifications.items.map((item: any) => item.thread_id), [24, 20, 14]);
      const ledger = new ConversationLedger(() => pool);
      const mixed = await ledger.threadDetail(15, 0, null);
      assert.equal(mixed?.thread.delivery_only, false);
      assert.deepEqual(mixed?.messages.map(m => m.is_channel_delivery), [true, false, true]);
      for (const [id, expected] of [[14, true], [20, true], [21, false], [22, false], [23, false], [24, true], [25, false]] as const) {
        const detail = await ledger.threadDetail(id);
        assert.equal(detail?.thread.delivery_only, expected);
        assert.equal(detail?.messages[0].is_channel_delivery, expected);
      }
    } finally {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${database}`);
      await admin.end();
    }
  });
