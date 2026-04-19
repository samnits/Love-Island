const path = require("path");

const usePostgres = Boolean(process.env.DATABASE_URL);

function createSQLiteDb() {
  const sqlite3 = require("sqlite3").verbose();
  const dbPath = path.join(__dirname, "data", "couples.db");
  const db = new sqlite3.Database(dbPath);

  db.serialize(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS profiles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        clerk_user_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        love_code TEXT UNIQUE,
        partner_id INTEGER,
        created_at TEXT NOT NULL,
        FOREIGN KEY(partner_id) REFERENCES profiles(id)
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        love_code TEXT UNIQUE,
        partner_id INTEGER,
        created_at TEXT NOT NULL,
        FOREIGN KEY(partner_id) REFERENCES users(id)
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id)
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS miss_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_user TEXT NOT NULL,
        to_user TEXT NOT NULL,
        message TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL
      )
    `);

    db.run(`ALTER TABLE miss_requests ADD COLUMN message TEXT`, (err) => {
      if (err && !String(err.message || "").includes("duplicate column name")) {
        // eslint-disable-next-line no-console
        console.error("Failed to migrate miss_requests.message:", err.message || err);
      }
    });

    db.run(`
      CREATE TABLE IF NOT EXISTS entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id INTEGER NOT NULL,
        from_user TEXT NOT NULL,
        to_user TEXT NOT NULL,
        note TEXT NOT NULL,
        image_path TEXT NOT NULL,
        cloudinary_public_id TEXT,
        event_date TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(request_id) REFERENCES miss_requests(id)
      )
    `);

    db.run(`ALTER TABLE entries ADD COLUMN cloudinary_public_id TEXT`, (err) => {
      if (err && !String(err.message || "").includes("duplicate column name")) {
        // eslint-disable-next-line no-console
        console.error("Failed to migrate entries.cloudinary_public_id:", err.message || err);
      }
    });

    db.run(`
      CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user TEXT NOT NULL,
        message TEXT NOT NULL,
        type TEXT NOT NULL,
        related_entry_id INTEGER,
        is_read INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      )
    `);
  });

  return db;
}

function createPostgresDb() {
  const { Pool } = require("pg");
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
      rejectUnauthorized: false
    }
  });

  const toPgSql = (sql) => {
    let index = 0;
    return sql
      .replace(/\?/g, () => `$${++index}`)
      .replace(/datetime\(([^)]+)\)/gi, "($1)::timestamp")
      .replace(/date\(([^)]+)\)/gi, "($1)::date");
  };

  const withReturningId = (sql) => {
    if (!/^\s*insert\s+into\s+/i.test(sql) || /\breturning\b/i.test(sql)) {
      return sql;
    }
    return `${sql.trim().replace(/;$/, "")} RETURNING id`;
  };

  const initPromise = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS profiles (
        id SERIAL PRIMARY KEY,
        clerk_user_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        love_code TEXT UNIQUE,
        partner_id INTEGER,
        created_at TEXT NOT NULL
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        love_code TEXT UNIQUE,
        partner_id INTEGER,
        created_at TEXT NOT NULL
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        created_at TEXT NOT NULL
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS miss_requests (
        id SERIAL PRIMARY KEY,
        from_user TEXT NOT NULL,
        to_user TEXT NOT NULL,
        message TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS entries (
        id SERIAL PRIMARY KEY,
        request_id INTEGER NOT NULL,
        from_user TEXT NOT NULL,
        to_user TEXT NOT NULL,
        note TEXT NOT NULL,
        image_path TEXT NOT NULL,
        cloudinary_public_id TEXT,
        event_date TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id SERIAL PRIMARY KEY,
        "user" TEXT NOT NULL,
        message TEXT NOT NULL,
        type TEXT NOT NULL,
        related_entry_id INTEGER,
        is_read INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      )
    `);
  })();

  return {
    serialize(fn) {
      fn();
    },

    run(sql, params = [], cb = () => {}) {
      const callback = typeof params === "function" ? params : cb;
      const values = Array.isArray(params) ? params : [];

      (async () => {
        await initPromise;
        const prepared = withReturningId(toPgSql(sql));
        const result = await pool.query(prepared, values);
        callback.call(
          {
            lastID: result.rows?.[0]?.id ?? null,
            changes: result.rowCount || 0
          },
          null
        );
      })().catch((err) => {
        callback.call({ lastID: null, changes: 0 }, err);
      });
    },

    get(sql, params = [], cb = () => {}) {
      const callback = typeof params === "function" ? params : cb;
      const values = Array.isArray(params) ? params : [];

      (async () => {
        await initPromise;
        const result = await pool.query(toPgSql(sql), values);
        callback(null, result.rows[0]);
      })().catch((err) => callback(err));
    },

    all(sql, params = [], cb = () => {}) {
      const callback = typeof params === "function" ? params : cb;
      const values = Array.isArray(params) ? params : [];

      (async () => {
        await initPromise;
        const result = await pool.query(toPgSql(sql), values);
        callback(null, result.rows);
      })().catch((err) => callback(err));
    }
  };
}

module.exports = usePostgres ? createPostgresDb() : createSQLiteDb();
