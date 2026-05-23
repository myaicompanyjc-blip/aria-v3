/**
 * DB Migration Runner
 * node infrastructure/db/migrate.js
 */
require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

async function migrate() {
  const pool = new Pool({ connectionString: process.env.POSTGRES_URL });
  const sqlFile = path.join(__dirname, '001_initial.sql');

  if (!fs.existsSync(sqlFile)) {
    console.error('Migration file not found:', sqlFile);
    process.exit(1);
  }

  const sql = fs.readFileSync(sqlFile, 'utf8');
  console.log('[Migrate] Running 001_initial.sql...');

  try {
    await pool.query(sql);
    console.log('[Migrate] ✅ Migrations applied successfully');
  } catch (err) {
    console.error('[Migrate] ❌ Error:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();
