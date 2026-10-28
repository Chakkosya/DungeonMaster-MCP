import { readFile } from 'node:fs/promises';
import { pool } from './db.js';

const sql = await readFile(new URL('../sql/001_init.sql', import.meta.url), 'utf8');
await pool.query(sql);
await pool.end();
