// The popup is where permissions are granted: Chrome only asks the user from
// a click on an extension page, never from a website or the service worker.

const $ = (id) => document.getElementById(id);

async function render() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let origin = null;
  try {
    const url = new URL(tab.url);
    if (url.protocol === 'https:' || url.protocol === 'http:') origin = url.origin;
  } catch { /* chrome:// pages and the like */ }

  const { sites = [] } = await chrome.storage.local.get('sites');
  $('origin').textContent = origin || 'not a web page';
  $('sites').innerHTML = '';
  for (const site of sites) {
    const li = document.createElement('li');
    li.textContent = site;
    const remove = document.createElement('button');
    remove.textContent = 'Remove';
    remove.onclick = async () => {
      await chrome.runtime.sendMessage({ type: 'disconnect-site', origin: site });
      render();
    };
    li.append(remove);
    $('sites').append(li);
  }
  if (!sites.length) $('sites').innerHTML = '<li>None yet — open Deck Lotus and connect it.</li>';

  $('connect').hidden = !origin || sites.includes(origin);
  const allowed = origin && await chrome.permissions.contains({ origins: [`${origin}/*`] });
  $('store').hidden = !origin || allowed || sites.includes(origin);
  $('state').textContent = !origin ? ''
    : sites.includes(origin) ? 'Connected. Use "Check prices" on the Shopping page.'
    : allowed ? 'Price checks are allowed on this site.' : '';

  $('connect').onclick = async () => {
    if (!(await chrome.permissions.request({ origins: [`${origin}/*`] }))) return;
    await chrome.runtime.sendMessage({ type: 'connect-site', origin });
    // Registered scripts only reach pages loaded from now on; this one is already open.
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['bridge.js'] }).catch(() => {});
    render();
  };
  $('store').onclick = async () => {
    await chrome.permissions.request({ origins: [`${origin}/*`] });
    render();
  };
}

render();
