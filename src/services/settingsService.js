import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Stored alongside backups in the data directory — deliberately file-based (not a DB
// table) so it works regardless of migration state.
const DATA_DIR = process.env.DATA_PATH || path.join(__dirname, '../../data');
const SETTINGS_FILE = path.join(DATA_DIR, 'app-settings.json');

const DEFAULTS = {
  registrationEnabled: true,
  // Scheduled-backup config lives here rather than in memory: a container rebuild
  // starts a fresh process, and a backup schedule that quietly stops running is
  // worse than one that was never enabled.
  scheduledBackups: {
    enabled: false,
    frequency: 'daily', // daily, 6hours, 12hours, weekly
    retainCount: 10,
    lastRun: null
  },
  // ntfy push settings. Blank means "fall back to the env var", so an existing
  // NTFY_TOPIC deploy keeps working until someone sets a topic here.
  notifications: {
    ntfyUrl: '',
    ntfyTopic: '',
    ntfyToken: ''
  },
  // Price-watch cron. Blank means PRICE_CHECK_SCHEDULE or the 6-hour default;
  // stored so a schedule picked in Settings survives a container rebuild.
  priceCheckSchedule: ''
};

function merged(stored) {
  return {
    ...DEFAULTS,
    ...stored,
    scheduledBackups: { ...DEFAULTS.scheduledBackups, ...(stored.scheduledBackups || {}) },
    notifications: { ...DEFAULTS.notifications, ...(stored.notifications || {}) }
  };
}

function readFile() {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Returns all app settings, merged over defaults.
 * An env override (REGISTRATION_ENABLED=false) always wins so a headless/hardened
 * deploy can force registration off without touching the file.
 */
export function getSettings() {
  const stored = readFile();
  const settings = merged(stored);
  if (process.env.REGISTRATION_ENABLED !== undefined) {
    settings.registrationEnabled =
      process.env.REGISTRATION_ENABLED.toLowerCase() === 'true';
    settings.registrationLockedByEnv = true;
  }
  return settings;
}

export function isRegistrationEnabled() {
  return getSettings().registrationEnabled !== false;
}

/**
 * Merge and persist a partial settings patch. Only known keys are accepted.
 * Ignored when the value is locked by an env var.
 */
export function updateSettings(patch = {}) {
  const stored = readFile();
  const current = merged(stored);
  if (typeof patch.registrationEnabled === 'boolean') {
    current.registrationEnabled = patch.registrationEnabled;
  }
  if (patch.scheduledBackups && typeof patch.scheduledBackups === 'object') {
    current.scheduledBackups = { ...current.scheduledBackups, ...patch.scheduledBackups };
  }
  if (patch.notifications && typeof patch.notifications === 'object') {
    for (const key of Object.keys(DEFAULTS.notifications)) {
      if (typeof patch.notifications[key] === 'string') {
        current.notifications[key] = patch.notifications[key].trim();
      }
    }
  }
  if (typeof patch.priceCheckSchedule === 'string') {
    current.priceCheckSchedule = patch.priceCheckSchedule.trim();
  }
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(current, null, 2));
  } catch (err) {
    throw new Error(`Failed to save settings: ${err.message}`);
  }
  return getSettings();
}
