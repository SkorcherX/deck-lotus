// Built-in avatar presets: the 5 MTG mana colors plus colorless.
// Original glyphs/colors, not WOTC artwork — safe to ship as UI chrome.
export const PRESET_AVATARS = [
  { id: 'W', label: 'White', color: '#f8f6d8', glyph: 'W', textColor: '#8a7c3f' },
  { id: 'U', label: 'Blue', color: '#0e68ab', glyph: 'U', textColor: '#ffffff' },
  { id: 'B', label: 'Black', color: '#150b00', glyph: 'B', textColor: '#ffffff' },
  { id: 'R', label: 'Red', color: '#d3202a', glyph: 'R', textColor: '#ffffff' },
  { id: 'G', label: 'Green', color: '#00733e', glyph: 'G', textColor: '#ffffff' },
  { id: 'C', label: 'Colorless', color: '#8c8c8c', glyph: 'C', textColor: '#ffffff' },
];

export function getPresetAvatar(presetId) {
  return PRESET_AVATARS.find(p => p.id === presetId) || null;
}

/**
 * The image URL to use for a user's avatar, or null when the avatar should
 * be rendered as a colored glyph/initials div instead (preset, or Gravatar
 * fallback handled separately in userMenu.js).
 */
export function getUploadedAvatarUrl(user) {
  if (user?.avatar_type === 'upload' && user.avatar_value) {
    return `/avatars/${user.avatar_value}`;
  }
  return null;
}
