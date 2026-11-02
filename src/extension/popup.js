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

  // permissions.request has to be the first thing a click does (Firefox drops
  // it otherwise), and Firefox closes this popup when the prompt opens — so
  // the background is told what to do first, and finishes the job itself.
  // tcgplayerpro.com is asked for in the same prompt: Chrome grants it at
  // install, Firefox only when asked.
  $('connect').onclick = () => {
    chrome.runtime.sendMessage({ type: 'pending-connect', origin });
    chrome.permissions.request({ origins: [`${origin}/*`, 'https://*.tcgplayerpro.com/*'] }).then(() => setTimeout(render, 300));
  };
  $('store').onclick = () => {
    chrome.permissions.request({ origins: [`${origin}/*`] }).then(render);
  };
}

render();
