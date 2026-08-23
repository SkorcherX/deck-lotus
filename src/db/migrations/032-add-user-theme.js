/**
 * Per-user theme selection.
 *
 * Mirrors 023-add-user-avatars: one nullable-with-default column on `users`,
 * read out by getUserById/getAllUsers and written by a single service call.
 *
 * The default is deliberately 'arcane' — the shipped default theme — rather
 * than NULL, so existing users get the same thing a new browser gets and the
 * client never has to distinguish "no preference" from "chose the default".
 *
 * The value is validated against the packs on disk before it is ever written
 * (src/services/themeService.js). A slug that no longer ships is harmless: the
 * client resolves an unknown theme back to the default at load time.
 */
export function up(db) {
  db.exec(`
    ALTER TABLE users ADD COLUMN theme TEXT NOT NULL DEFAULT 'arcane';
  `);
  console.log('✓ Added theme column to users table');
}

export function down(db) {
  // SQLite has no practical DROP COLUMN, so the table is rebuilt without the
  // column — the same approach as 023.
  //
  // ⚠ Two things to know before ever running this. The migration runner never
  // calls down(), so this is documentation rather than a code path. And
  // CREATE TABLE ... AS SELECT copies data but NOT the schema: the rebuilt
  // table loses its PRIMARY KEY, UNIQUE and NOT NULL constraints. That flaw is
  // inherited from 023 and is reproduced here rather than silently diverging,
  // but it means a real rollback needs the table recreated from the schema
  // first, not this.
  db.exec(`
    CREATE TABLE users_backup AS
    SELECT id, username, email, password_hash, is_admin,
           avatar_type, avatar_value, created_at, updated_at
    FROM users;

    DROP TABLE users;
    ALTER TABLE users_backup RENAME TO users;

    CREATE INDEX idx_users_username ON users(username);
    CREATE INDEX idx_users_email ON users(email);
    CREATE INDEX idx_users_is_admin ON users(is_admin);
  `);
  console.log('✓ Removed theme column from users table');
}
