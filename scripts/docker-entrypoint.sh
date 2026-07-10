#!/bin/sh
set -eu

node --input-type=module <<'NODE'
const mysql = await import('mysql2/promise');
const host = process.env.BAILING_MYSQL_HOST || 'mysql';
const port = Number(process.env.BAILING_MYSQL_PORT || 3306);
const user = process.env.BAILING_MYSQL_USER || 'bailing';
const password = process.env.BAILING_MYSQL_PASSWORD || '';
const database = process.env.BAILING_MYSQL_DATABASE || 'bailinghub';
const deadline = Date.now() + 60000;
for (;;) {
  try {
    const conn = await mysql.createConnection({ host, port, user, password, database });
    await conn.end();
    process.exit(0);
  } catch (e) {
    if (Date.now() > deadline) {
      console.error(`MySQL is not ready: ${e?.message || e}`);
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
}
NODE

npm run db:init

if [ "${BAILING_SEED_DEMO:-0}" = "1" ]; then
  npm run demo:seed
fi

exec npm start
