'use strict';

const path = require('node:path');
const { createApp } = require('./src/server/app');

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const demoData = process.env.SEED_DEMO_DATA !== 'false';

// A relative DATABASE_FILE is resolved against the project, not the shell's cwd.
const dbFile = process.env.DATABASE_FILE
  ? path.resolve(__dirname, process.env.DATABASE_FILE)
  : path.join(__dirname, 'data', 'horizon.db');

const app = createApp({
  root: __dirname,
  dbFile,
  demoData,
  secureCookies: process.env.SECURE_COOKIES === 'true' || process.env.NODE_ENV === 'production',
  trustProxy: process.env.TRUST_PROXY === 'true'
});

app.listen(port, host).then((address) => {
  console.log(`Horizon is running at http://${address.address}:${address.port}`);
  if (demoData) {
    console.log('Demo accounts (password: horizon-demo-2025)');
    console.log('  client  alex@northstar.test');
    console.log('  talent  maya@horizon.test');
    console.log('  admin   admin@horizon.test');
  }
}).catch((error) => {
  console.error(`Failed to start: ${error.message}`);
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\nReceived ${signal}, shutting down.`);
    app.close().then(() => process.exit(0));
  });
}
