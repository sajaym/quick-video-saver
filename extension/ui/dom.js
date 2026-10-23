// Tiny DOM toolkit: element builder, keyed list sync, popup menu and toasts. No framework needed.
import {icon} from './icons.js';

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (['value', 'checked', 'disabled', 'hidden', 'title', 'type', 'placeholder', 'href', 'target', 'rel', 'spellcheck', 'min', 'max', 'step', 'id', 'name', 'src', 'alt', 'referrerPolicy', 'loading'].includes(key)) el[key] = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function clear(el) { while (el.firstChild) el.firstChild.remove(); return el; }

// Keeps `container` children in step with `items` without rebuilding nodes (inputs keep focus, menus stay put).
export function syncList(container, items, keyOf, make, patch) {
  const existing = new Map();
  for (const child of [...container.children]) if (child.dataset.key) existing.set(child.dataset.key, child);
  let previous = null;
  for (const item of items) {
    const key = String(keyOf(item));
    let node = existing.get(key);
    if (node) existing.delete(key);
    else { node = make(item); node.dataset.key = key; }
    patch(node, item);
    const expected = previous ? previous.nextSibling : container.firstChild;
    if (node !== expected) container.insertBefore(node, expected);
    previous = node;
  }
  for (const stale of existing.values()) stale.remove();
}

export function setText(el, text) { if (el.textContent !== text) el.textContent = text; }
export function setHidden(el, hidden) { if (el.hidden !== !!hidden) el.hidden = !!hidden; }

// ---- popup menu ---------------------------------------------------------------------------------------
let menu = null, cleanup = null, afterClose = null;

export function closeMenu() {
  menu?.remove(); menu = null;
  cleanup?.(); cleanup = null;
  const callback = afterClose; afterClose = null;
  callback?.();
}

export function openMenu(anchor, items, {title = '', onClose = null, minWidth = 220} = {}) {
  closeMenu();
  afterClose = onClose;
  const withIcons = items.some(item => item?.icon);
  menu = h('div', {class: 'menu', role: 'menu'},
    title && h('div', {class: 'menu-title', text: title}),
    items.filter(Boolean).map(item => item.separator ? h('div', {class: 'menu-sep'}) : h('button', {
      class: 'menu-item' + (item.danger ? ' danger' : '') + (item.checked ? ' checked' : ''), role: item.radio ? 'menuitemradio' : 'menuitem', 'aria-checked': item.radio ? String(!!item.checked) : null, disabled: !!item.disabled,
      onClick: () => { closeMenu(); item.run?.(); },
    }, item.icon ? icon(item.icon, 18) : withIcons && h('span', {class: 'icon-gap'}), h('span', {class: 'menu-label'}, item.label, item.sub && h('small', {text: item.sub})), item.hint && h('span', {class: 'menu-hint', text: item.hint}), item.checked && icon('check', 18, 'menu-check'))));
  menu.style.minWidth = Math.min(minWidth, innerWidth - 16) + 'px';
  menu.style.left = '0px';
  menu.style.top = '0px';
  document.body.append(menu);
  const rect = anchor.getBoundingClientRect();
  const width = Math.min(menu.offsetWidth, innerWidth - 16);
  let left = Math.max(8, Math.min(innerWidth - width - 8, rect.right - width));
  if (rect.left < innerWidth / 2 && rect.width > 120) left = Math.max(8, Math.min(innerWidth - width - 8, rect.left));
  let top = rect.bottom + 6;
  if (top + menu.offsetHeight > innerHeight - 8) top = Math.max(8, rect.top - menu.offsetHeight - 6);
  Object.assign(menu.style, {left: left + 'px', top: top + 'px'});
  menu.querySelector('button:not(:disabled)')?.focus({preventScroll: true});
  const away = event => { if (menu && !menu.contains(event.target) && !anchor.contains(event.target)) closeMenu(); };
  const key = event => {
    if (event.key === 'Escape') { closeMenu(); anchor.focus?.(); }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const entries = [...menu.querySelectorAll('button:not(:disabled)')];
      const index = entries.indexOf(document.activeElement);
      entries[(index + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length]?.focus();
    }
  };
  setTimeout(() => { document.addEventListener('pointerdown', away, true); document.addEventListener('keydown', key, true); addEventListener('blur', closeMenu); }, 0);
  document.querySelector('.scroll')?.addEventListener('scroll', closeMenu, {once: true});
  cleanup = () => { document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', key, true); removeEventListener('blur', closeMenu); };
}

// ---- toasts --------------------------------------------------------------------------------------------
let toastTimer = 0;
export function toast(message, {kind = 'info', action = null, ms = 4200} = {}) {
  let host = document.getElementById('toasts');
  if (!host) { host = h('div', {id: 'toasts', role: 'status', 'aria-live': 'polite'}); document.body.append(host); }
  clear(host);
  const node = h('div', {class: 'toast ' + kind}, icon(kind === 'error' ? 'alertCircle' : kind === 'success' ? 'checkCircle' : 'info', 20), h('span', {class: 'toast-text', text: message}),
    action && h('button', {class: 'toast-action', text: action.label, onClick: () => { host.replaceChildren(); action.run(); }}));
  host.append(node);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.remove(), ms);
}
