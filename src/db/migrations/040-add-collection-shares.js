/**
 * A read-only link to one user's collection, for someone with no account.
 *
 * One row per user, not one per link: there is a single "my collection" link,
 * and a user who wants to cut someone off regenerates it, which replaces the
 * token in place. Several live links would need names and a management screen
 * to be revocable one at a time, and nobody sharing a binder with a friend
 * wants that.
 *
 * Nothing here references cards or printings, so the weekly MTGJSON rebuild
 * cannot touch it. It is user-scoped, so backupService carries it.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS collection_shares (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      share_token TEXT NOT NULL UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  console.log('✓ Created collection_shares table');
}

export function down(db) {
  // ⚠ The migration runner never calls down(), so this is documentation.
  db.exec(`DROP TABLE IF EXISTS collection_shares;`);
  console.log('✓ Dropped collection_shares');
}
