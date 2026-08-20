export function up(db) {
  db.exec(`
    ALTER TABLE users ADD COLUMN avatar_type TEXT NOT NULL DEFAULT 'gravatar';
    ALTER TABLE users ADD COLUMN avatar_value TEXT;
  `);
  console.log('✓ Added avatar_type/avatar_value columns to users table');
}

export function down(db) {
  // SQLite doesn't support DROP COLUMN easily, so recreate table
  db.exec(`
    CREATE TABLE users_backup AS
    SELECT id, username, email, password_hash, is_admin, created_at, updated_at
    FROM users;

    DROP TABLE users;
    ALTER TABLE users_backup RENAME TO users;

    -- Recreate indexes
    CREATE INDEX idx_users_username ON users(username);
    CREATE INDEX idx_users_email ON users(email);
    CREATE INDEX idx_users_is_admin ON users(is_admin);
  `);
  console.log('✓ Removed avatar_type/avatar_value columns from users table');
}
