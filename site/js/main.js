// Progressive enhancement only: the page reads fine without this file. It adds the language
// switch, the download button for the visitor's OS, release data, donate buttons and the
// looping clips. It never talks to anything but the page's own origin.

import { config } from './config.js';
import { dict, LANGS } from './i18n.js';

const LANG_KEY = 'liber-site-lang';
const OS_NAMES = { linux: 'Linux', windows: 'Windows', macos: 'macOS' };
const PRIMARY_KIND = { linux: 'deb', windows: 'exe', macos: 'dmg' };
const SPRITE = 'img/icons.svg';

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let lang = 'en';
let release = null; // parsed release.json, or null
const rerenders = []; // things to redraw when the language changes

/* ---------------- i18n ---------------- */

function t(key, vars) {
  let s = dict[lang]?.[key] ?? dict.en[key];
  if (s === undefined) {
    console.warn(`missing i18n key: ${key}`);
    return key;
  }
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, v);
  return s;
}

function initialLang() {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (LANGS.includes(saved)) return saved;
  } catch {
    // Storage blocked (private mode, sandbox): fall back to the browser's languages.
  }
  const prefs = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const pref of prefs) {
    const base = String(pref || '')
      .toLowerCase()
      .split('-')[0];
    if (LANGS.includes(base)) return base;
  }
  return 'en';
}

function applyLang(next, remember) {
  lang = LANGS.includes(next) ? next : 'en';
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  // Only our own dictionary strings (a <b> or two) ever go through innerHTML.
  for (const el of document.querySelectorAll('[data-i18n-html]')) {
    el.innerHTML = t(el.dataset.i18nHtml);
  }
  for (const el of document.querySelectorAll('[data-i18n-attr]')) {
    for (const pair of el.dataset.i18nAttr.split(',')) {
      const [attr, key] = pair.split(':').map((s) => s.trim());
      if (attr && key) el.setAttribute(attr, t(key));
    }
  }
  for (const btn of document.querySelectorAll('.lang [data-lang]')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.lang === lang));
  }
  for (const fn of rerenders) fn();
  if (remember) {
    try {
      localStorage.setItem(LANG_KEY, lang);
    } catch {
      // A convenience only.
    }
  }
}

function initLangSwitch() {
  const group = document.querySelector('.lang');
  if (!group) return;
  group.hidden = false;
  group.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-lang]');
    if (btn && btn.dataset.lang !== lang) applyLang(btn.dataset.lang, true);
  });
}

/* ---------------- OS detection ---------------- */

export function detectOS(nav = navigator) {
  const ua = nav.userAgent || '';
  if (/Android|iPhone|iPad|iPod/i.test(ua)) return null;
  if (/Windows/i.test(ua)) return 'windows';
  if (/Macintosh|Mac OS X/i.test(ua)) return nav.maxTouchPoints > 1 ? null : 'macos'; // iPadOS
  if (/Linux|X11|CrOS|FreeBSD|OpenBSD/i.test(ua)) return 'linux';
  const platform = (nav.userAgentData?.platform || nav.platform || '').toLowerCase();
  if (platform.startsWith('win')) return 'windows';
  if (platform.startsWith('mac')) return 'macos';
  if (platform.includes('linux')) return 'linux';
  return null;
}

function assetUrl(name) {
  return config.assetBase + encodeURIComponent(name);
}

function filesFor(os) {
  return (release?.files ?? []).filter((f) => f.os === os);
}

function primaryFile(os) {
  const files = filesFor(os);
  return files.find((f) => f.kind === PRIMARY_KIND[os]) ?? files[0] ?? null;
}

function renderHeroButtons() {
  const os = document.documentElement.dataset.os;
  for (const btn of document.querySelectorAll('.os-buttons [data-os]')) {
    const mine = btn.dataset.os === os;
    btn.classList.toggle('dark', mine);
    btn.classList.toggle('line', !mine);
    const label = btn.querySelector('.os-label');
    const name = OS_NAMES[btn.dataset.os];
    label.textContent = mine ? t('hero.downloadFor', { os: name }) : name;
    const file = mine ? primaryFile(os) : null;
    btn.href = file ? assetUrl(file.name) : '#download';
  }
}

function initOS() {
  const os = detectOS();
  if (!os) return;
  document.documentElement.dataset.os = os;
  const row = document.querySelector('.os-buttons');
  const mine = row?.querySelector(`[data-os="${os}"]`);
  if (mine) row.prepend(mine);
  document.querySelector(`.plat[data-platform="${os}"]`)?.classList.add('is-mine');
  rerenders.push(renderHeroButtons);
}

/* ---------------- release.json ---------------- */

function validRelease(data) {
  return (
    data &&
    typeof data.version === 'string' &&
    Array.isArray(data.files) &&
    data.files.every((f) => f && typeof f.name === 'string' && typeof f.os === 'string')
  );
}

function formatSize(bytes) {
  if (typeof bytes !== 'number' || !(bytes > 0)) return '';
  const fmt = new Intl.NumberFormat(lang === 'es' ? 'es-419' : 'en', {
    maximumFractionDigits: 1,
  });
  if (bytes >= 1024 * 1024) return t('size.mb', { n: fmt.format(bytes / (1024 * 1024)) });
  return t('size.kb', { n: fmt.format(Math.max(1, Math.round(bytes / 1024))) });
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c) node.append(c);
  return node;
}

function fileRow(file) {
  const parts = [el('a', { class: 'file-alt', href: assetUrl(file.name), text: file.name })];
  const size = formatSize(file.size);
  if (size) parts.push(` · ${size}`);
  const li = el('li', {}, [el('div', {}, parts)]);
  if (typeof file.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(file.sha256)) {
    const sha = file.sha256.toLowerCase();
    const summary = el('summary', {
      text: `${t('download.sha')} ${sha.slice(0, 4)}…${sha.slice(-4)}`,
    });
    li.append(el('details', {}, [summary, el('code', { text: sha })]));
  }
  if (
    typeof file.virustotal === 'string' &&
    file.virustotal.startsWith('https://www.virustotal.com/')
  ) {
    li.append(el('div', {}, [el('a', { href: file.virustotal, text: t('download.virustotal') })]));
  } else {
    li.append(el('div', { text: t('download.virustotalPending') }));
  }
  return li;
}

function renderRelease() {
  const ok = Boolean(release);
  document.querySelector('[data-release-pending]').hidden = ok;
  const version = document.querySelector('[data-release-version]');
  version.hidden = !ok;
  if (ok) version.textContent = `v${release.version.replace(/^v/, '')}`;
  if (ok) version.setAttribute('aria-label', t('download.version', { version: release.version }));

  for (const plat of document.querySelectorAll('.plat[data-platform]')) {
    const os = plat.dataset.platform;
    const files = filesFor(os);
    const primary = primaryFile(os);
    plat.classList.toggle('is-pending', !ok || !primary);
    const btn = plat.querySelector('[data-release-primary]');
    if (primary) btn.href = assetUrl(primary.name);
    plat.querySelector('[data-release-files]').replaceChildren(...files.map(fileRow));
  }

  const sample = (release?.files ?? []).find((f) => f.kind === 'sample-vault');
  const sampleBtn = document.querySelector('[data-release-sample]');
  sampleBtn.hidden = !sample;
  if (sample) sampleBtn.href = assetUrl(sample.name);
  document.querySelector('[data-release-sample-pending]').hidden = Boolean(sample);
  document.querySelector('[data-release-sample-hint]').hidden = !sample;
}

async function initRelease() {
  try {
    const res = await fetch(config.releaseJson, { cache: 'no-cache' });
    const body = await res.text(); // read it either way, so the request completes
    if (res.ok) {
      const data = JSON.parse(body);
      if (validRelease(data)) release = data;
    }
  } catch {
    // No release yet, or offline: the "coming soon" state below.
  }
  rerenders.push(renderRelease);
  renderRelease();
  if (document.documentElement.dataset.os) renderHeroButtons();
  document.documentElement.dataset.release = release ? 'ready' : 'pending';
}

/* ---------------- donate ---------------- */

function initDonate() {
  const { donate } = config;
  if (!donate?.enabled) return;
  const box = document.querySelector('[data-donate]');
  let shown = 0;
  for (const link of box.querySelectorAll('[data-donate-link]')) {
    const url = donate[link.dataset.donateLink];
    if (typeof url === 'string' && url.startsWith('https://')) {
      link.href = url;
      shown += 1;
    } else {
      link.hidden = true;
    }
  }
  if (shown) {
    box.hidden = false;
    document.querySelector('[data-donate-fallback]').hidden = true;
  }
}

/* ---------------- clips ---------------- */

function icon(id) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `${SPRITE}#${id}`);
  svg.append(use);
  return svg;
}

function initClips() {
  const wanted = new Set(config.videos ?? []);
  const clips = [];
  for (const slot of document.querySelectorAll('[data-clip]')) {
    const slug = slot.dataset.clip;
    const img = slot.querySelector('img');
    if (!wanted.has(slug) || !img) continue;

    const video = document.createElement('video');
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = 'none';
    video.setAttribute('muted', '');
    video.setAttribute('playsinline', '');
    video.poster = img.getAttribute('src');
    video.width = img.width;
    video.height = img.height;
    const altKey = (img.dataset.i18nAttr || '').match(/alt:([\w.-]+)/)?.[1];
    if (altKey) video.dataset.i18nAttr = `aria-label:${altKey}`;
    video.setAttribute('aria-label', img.alt);
    img.replaceWith(video);

    const button = el('button', { type: 'button', class: 'clip-toggle' });
    const bar = el('span', { class: 'clip-bar', 'aria-hidden': 'true' }, [el('i')]);
    slot.append(button, bar);

    const clip = { slug, slot, video, button, bar: bar.firstChild, loaded: false, visible: false };
    clip.userPaused = reducedMotion.matches; // reduced motion: poster and a play button
    clips.push(clip);

    const sync = () => {
      const playing = !video.paused;
      button.replaceChildren(icon(playing ? 'pause' : 'play'));
      button.setAttribute('aria-label', t(playing ? 'clip.pause' : 'clip.play'));
      slot.dataset.state = playing ? 'playing' : 'paused';
    };
    video.addEventListener('play', sync);
    video.addEventListener('pause', sync);
    rerenders.push(sync);
    sync();

    let raf = 0;
    const tick = () => {
      if (video.duration > 0) {
        clip.bar.style.transform = `scaleX(${video.currentTime / video.duration})`;
      }
      raf = video.paused ? 0 : requestAnimationFrame(tick);
    };
    video.addEventListener('play', () => {
      if (!raf) raf = requestAnimationFrame(tick);
    });

    button.addEventListener('click', () => {
      if (video.paused) {
        clip.userPaused = false;
        load(clip);
        video.play().catch(() => {});
      } else {
        clip.userPaused = true;
        video.pause();
      }
    });
  }
  if (!clips.length) return;

  function load(clip) {
    if (clip.loaded) return;
    clip.loaded = true;
    for (const [ext, type] of [
      ['webm', 'video/webm'],
      ['mp4', 'video/mp4'],
    ]) {
      clip.video.append(el('source', { src: `media/${clip.slug}.${ext}`, type }));
    }
    clip.video.preload = 'auto';
    clip.video.load();
  }

  function update(clip) {
    if (clip.visible && !clip.userPaused) {
      load(clip);
      clip.video.play().catch(() => {});
    } else if (!clip.video.paused) {
      clip.video.pause();
    }
  }

  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const clip = clips.find((c) => c.slot === entry.target);
        clip.visible = entry.isIntersecting && entry.intersectionRatio >= 0.5;
        update(clip);
      }
    },
    { threshold: [0, 0.5, 1] },
  );
  for (const clip of clips) io.observe(clip.slot);

  reducedMotion.addEventListener('change', () => {
    for (const clip of clips) {
      clip.userPaused = reducedMotion.matches;
      update(clip);
    }
  });
}

/* ---------------- start ---------------- */

document.documentElement.classList.add('js');
initLangSwitch();
initOS();
initClips();
initDonate();
applyLang(initialLang(), false);
initRelease();
