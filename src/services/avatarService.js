import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import db from '../db/connection.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Mirrors client/src/utils/avatar.js — the curated set of Keyrune expansion-
// symbol presets.
const PRESET_IDS = new Set([
  'khm', 'thb', 'war', 'znr', 'dom', 'grn', 'iko', 'afr', 'neo', 'one', 'ltr', 'mkm',
]);

const MIME_EXTENSIONS = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

/**
 * Directory uploaded avatars are stored in, alongside the SQLite database so
 * both live in the same persisted volume (see src/db/connection.js for the
 * same DATABASE_PATH-derived pattern).
 */
export function getAvatarsDir() {
  const dbPath = process.env.DATABASE_PATH || join(__dirname, '../../data/deck-lotus.db');
  const avatarsDir = join(dirname(dbPath), 'avatars');

  if (!existsSync(avatarsDir)) {
    mkdirSync(avatarsDir, { recursive: true });
  }

  return avatarsDir;
}

/**
 * Switch a user back to Gravatar/initials, clearing any preset or uploaded
 * file selection. Deletes the previously uploaded file, if any, so orphaned
 * images don't accumulate on disk.
 */
export function setAvatarGravatar(userId) {
  deletePreviousUpload(userId);

  db.run(
    `UPDATE users SET avatar_type = 'gravatar', avatar_value = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [userId]
  );

  return getUpdatedUser(userId);
}

/**
 * Select one of the built-in set-symbol avatars.
 */
export function setAvatarPreset(userId, presetId) {
  if (!PRESET_IDS.has(presetId)) {
    throw new Error(`Invalid preset avatar: ${presetId}`);
  }

  deletePreviousUpload(userId);

  db.run(
    `UPDATE users SET avatar_type = 'preset', avatar_value = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [presetId, userId]
  );

  return getUpdatedUser(userId);
}

/**
 * Save an uploaded avatar image to disk and point the user at it.
 * Replaces (and deletes) any previously uploaded file for this user.
 */
export function saveUploadedAvatar(userId, buffer, mimetype) {
  const ext = MIME_EXTENSIONS[mimetype];
  if (!ext) {
    throw new Error('Unsupported image type');
  }

  deletePreviousUpload(userId);

  const filename = `${userId}-${Date.now()}${ext}`;
  writeFileSync(join(getAvatarsDir(), filename), buffer);

  db.run(
    `UPDATE users SET avatar_type = 'upload', avatar_value = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [filename, userId]
  );

  return getUpdatedUser(userId);
}

function deletePreviousUpload(userId) {
  const user = db.get(`SELECT avatar_type, avatar_value FROM users WHERE id = ?`, [userId]);

  if (user?.avatar_type === 'upload' && user.avatar_value) {
    const filePath = join(getAvatarsDir(), user.avatar_value);
    if (existsSync(filePath)) {
      try {
        unlinkSync(filePath);
      } catch {
        // Best-effort cleanup — a stale file left behind is harmless.
      }
    }
  }
}

function getUpdatedUser(userId) {
  return db.get(
    'SELECT id, username, email, is_admin, avatar_type, avatar_value, created_at FROM users WHERE id = ?',
    [userId]
  );
}
