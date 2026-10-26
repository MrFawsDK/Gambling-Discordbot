// Builds elements without innerHTML: text always goes in as text, so a player named
// "<img onerror=...>" is shown as exactly that instead of running.
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key in el && typeof value !== 'string') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function clear(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

// Only Discord's CDN, which is also all the CSP allows.
export function avatar(url, label = '') {
  const safe = typeof url === 'string' && url.startsWith('https://cdn.discordapp.com/');
  // No image to fall back to, so an unknown avatar is just the empty grey circle.
  if (!safe) return h('span', { class: 'avatar' });
  const img = h('img', { class: 'avatar', src: url, alt: label, loading: 'lazy', referrerpolicy: 'no-referrer' });
  // An old avatar URL stops working when someone changes their picture: fall back to the circle.
  img.addEventListener('error', () => img.replaceWith(h('span', { class: 'avatar' })), { once: true });
  return img;
}
