import api from '../services/api.js';
import { getGravatarUrl, getUserInitials, getUserColor } from '../utils/gravatar.js';
import { getPresetAvatar, getUploadedAvatarUrl } from '../utils/avatar.js';

let currentUser = null;
let userStats = null;
let dropdownOpen = false;

export async function setupUserMenu() {
  const avatarBtn = document.getElementById('user-avatar-btn');
  const dropdown = document.getElementById('user-dropdown');
  const logoutBtn = document.getElementById('logout-btn');

  // Load user data
  await loadUserData();

  // Toggle dropdown on avatar click
  avatarBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleDropdown();
  });

  // Close dropdown when clicking outside
  document.addEventListener('click', (e) => {
    if (dropdownOpen && !dropdown.contains(e.target) && !avatarBtn.contains(e.target)) {
      closeDropdown();
    }
  });

  // Settings moved off the top row and into this menu — it is an account
  // thing, and the nav bar had run out of room for the pages people actually
  // work in. Closing the dropdown first, so the settings page is not left
  // sitting behind an open menu.
  const settingsBtn = document.getElementById('dropdown-settings-btn');
  if (settingsBtn) {
    settingsBtn.addEventListener('click', () => {
      closeDropdown();
      window.dispatchEvent(new CustomEvent('navigate', { detail: { page: 'settings' } }));
    });
  }

  // Logout handler
  logoutBtn.addEventListener('click', () => {
    api.logout();
    window.location.reload();
  });

  // Update on page changes
  window.addEventListener('page:change', loadUserData);
}

async function loadUserData() {
  try {
    // Load user profile
    const profileResult = await api.getProfile();
    currentUser = profileResult.user;

    // Load user stats
    const statsResult = await api.getUserStats();
    userStats = statsResult.stats;

    // Update UI
    await updateAvatar();
    updateDropdownContent();
  } catch (error) {
    console.error('Failed to load user data:', error);
  }
}

// Exposed so settings.js can refresh the nav avatar right after the user
// changes it, instead of waiting for the next page:change event.
export async function refreshUserMenu() {
  await loadUserData();
}

async function updateAvatar() {
  if (!currentUser) return;

  // Elements for nav avatar
  const avatarImg = document.getElementById('user-avatar-img');
  const avatarInitials = document.getElementById('user-avatar-initials');

  // Elements for dropdown avatar
  const dropdownAvatarImg = document.getElementById('dropdown-avatar-img');
  const dropdownAvatarInitials = document.getElementById('dropdown-avatar-initials');

  // Uploaded custom image takes priority over everything else.
  const uploadedUrl = getUploadedAvatarUrl(currentUser);
  if (uploadedUrl) {
    avatarImg.src = uploadedUrl;
    avatarImg.classList.remove('hidden');
    avatarInitials.style.display = 'none';

    dropdownAvatarImg.src = uploadedUrl;
    dropdownAvatarImg.classList.remove('hidden');
    dropdownAvatarInitials.style.display = 'none';
    return;
  }

  // A selected set-symbol preset renders as a Keyrune glyph on a colored
  // circle, same div used for the initials fallback.
  if (currentUser.avatar_type === 'preset') {
    const preset = getPresetAvatar(currentUser.avatar_value);
    if (preset) {
      avatarImg.classList.add('hidden');
      avatarInitials.style.display = 'flex';
      avatarInitials.style.background = preset.color;
      avatarInitials.style.color = '#fff';
      avatarInitials.innerHTML = `<i class="ss ss-${preset.id}"></i>`;

      dropdownAvatarImg.classList.add('hidden');
      dropdownAvatarInitials.style.display = 'flex';
      dropdownAvatarInitials.style.background = preset.color;
      dropdownAvatarInitials.style.color = '#fff';
      dropdownAvatarInitials.innerHTML = `<i class="ss ss-${preset.id}"></i>`;
      return;
    }
  }

  // Try to load Gravatar
  const gravatarUrl = getGravatarUrl(currentUser.email, 80);

  // Set background color for initials (and reset any leftover preset text color)
  const userColor = getUserColor(currentUser.username);
  avatarInitials.style.background = userColor;
  avatarInitials.style.color = '';
  dropdownAvatarInitials.style.background = userColor;
  dropdownAvatarInitials.style.color = '';

  // Set initials
  const initials = getUserInitials(currentUser.username);
  avatarInitials.textContent = initials;
  dropdownAvatarInitials.textContent = initials;

  // Try to load Gravatar image
  if (gravatarUrl) {
    const img = new Image();
    img.onload = () => {
      // Gravatar loaded successfully
      avatarImg.src = gravatarUrl;
      avatarImg.classList.remove('hidden');
      avatarInitials.style.display = 'none';

      dropdownAvatarImg.src = gravatarUrl;
      dropdownAvatarImg.classList.remove('hidden');
      dropdownAvatarInitials.style.display = 'none';
    };
    img.onerror = () => {
      // Gravatar failed, use initials
      avatarImg.classList.add('hidden');
      avatarInitials.style.display = 'flex';

      dropdownAvatarImg.classList.add('hidden');
      dropdownAvatarInitials.style.display = 'flex';
    };
    img.src = gravatarUrl;
  } else {
    // No email or Gravatar URL, use initials
    avatarImg.classList.add('hidden');
    avatarInitials.style.display = 'flex';

    dropdownAvatarImg.classList.add('hidden');
    dropdownAvatarInitials.style.display = 'flex';
  }
}

function updateDropdownContent() {
  if (!currentUser || !userStats) return;

  // Update user info
  document.getElementById('dropdown-username').textContent = currentUser.username;
  document.getElementById('dropdown-email').textContent = currentUser.email;

  // Update stats
  document.getElementById('stat-decks').textContent = userStats.deckCount;
  document.getElementById('stat-cards').textContent = userStats.cardCount;
  document.getElementById('stat-api-keys').textContent = userStats.apiKeyCount;
  document.getElementById('stat-shared').textContent = userStats.sharedDeckCount;
}

function toggleDropdown() {
  const dropdown = document.getElementById('user-dropdown');

  if (dropdownOpen) {
    closeDropdown();
  } else {
    openDropdown();
  }
}

function openDropdown() {
  const dropdown = document.getElementById('user-dropdown');
  dropdown.classList.remove('hidden');
  dropdownOpen = true;

  // Reload stats when opening
  loadUserData();
}

function closeDropdown() {
  const dropdown = document.getElementById('user-dropdown');
  dropdown.classList.add('hidden');
  dropdownOpen = false;
}
