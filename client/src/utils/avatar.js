// Built-in avatar presets: a dozen recognizable MTG expansion-set symbols,
// rendered with the Keyrune webfont (SIL OFL 1.1 — see
// client/src/assets/fonts/KEYRUNE-LICENSE.md). `ssClass` maps to a glyph rule
// defined in client/src/styles/main.css (.ss-<id>).
export const PRESET_AVATARS = [
  { id: 'khm', label: 'Kaldheim', color: '#4a6fa5' },
  { id: 'thb', label: 'Theros Beyond Death', color: '#b08d3e' },
  { id: 'war', label: 'War of the Spark', color: '#7a3b8f' },
  { id: 'znr', label: 'Zendikar Rising', color: '#c25b2e' },
  { id: 'dom', label: 'Dominaria', color: '#2e7d5b' },
  { id: 'grn', label: 'Guilds of Ravnica', color: '#3f7d3f' },
  { id: 'iko', label: 'Ikoria: Lair of Behemoths', color: '#9b3b3b' },
  { id: 'afr', label: 'Adventures in the Forgotten Realms', color: '#8f2d2d' },
  { id: 'neo', label: 'Kamigawa: Neon Dynasty', color: '#c23b6b' },
  { id: 'one', label: 'Phyrexia: All Will Be One', color: '#5b5b5b' },
  { id: 'ltr', label: 'Tales of Middle-earth', color: '#6b5638' },
  { id: 'mkm', label: 'Murders at Karlov Manor', color: '#2e3d7d' },
];

export function getPresetAvatar(presetId) {
  return PRESET_AVATARS.find(p => p.id === presetId) || null;
}

/**
 * The image URL to use for a user's avatar, or null when the avatar should
 * be rendered as a preset glyph or initials div instead (Gravatar fallback
 * handled separately in userMenu.js).
 */
export function getUploadedAvatarUrl(user) {
  if (user?.avatar_type === 'upload' && user.avatar_value) {
    return `/avatars/${user.avatar_value}`;
  }
  return null;
}
