#!/usr/bin/env node
'use strict';

// Deletes the local SQLite database and rebuilds it with fresh demo data.

const fs = require('node:fs');
const path = require('node:path');
const { openDatabase } = require('../src/server/db');
const { seed } = require('../src/server/seed');

const dbFile = process.env.DATABASE_FILE || path.join(__dirname, '..', 'data', 'horizon.db');

for (const suffix of ['', '-wal', '-shm']) {
  const file = `${dbFile}${suffix}`;
  if (fs.existsSync(file)) {
    fs.rmSync(file);
    console.log(`removed ${path.relative(process.cwd(), file)}`);
  }
}

const db = openDatabase(dbFile);
const result = seed(db, { withDemoData: process.env.SEED_DEMO_DATA !== 'false' });
db.close();

console.log(`rebuilt ${path.relative(process.cwd(), dbFile)} — ${result.users} users, ${result.skills} skills`);
console.log('demo password: horizon-demo-2025');
