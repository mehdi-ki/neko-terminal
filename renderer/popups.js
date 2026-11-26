/* Neko Terminal – popups: cards (neko popup/notify/ask, OSC 9/777/99 notifications) and the image lightbox. */
(() => {
  const $ = s => document.querySelector(s);
  const stack = $('#popups');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // small, safe markdown: `code`, **bold**, links, line breaks
  function richText(s) {
    const parts = String(s || '').split(/(`[^`\n]+`)/g);
    return parts.map(p => {
      if (/^`[^`]+`$/.test(p)) return `<code>${esc(p.slice(1, -1))}</code>`;
      let h = esc(p);
      h = h.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
      h = h.replace(/\b(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])/g, '<a href="#" data-href="$1">$1</a>');
      return h.replace(/\n/g, '<br>');
    }).join('');
  }

  function wireLinks(el, cwd) {
    el.querySelectorAll('a[data-href]').forEach(a => {
      a.onclick = e => { e.preventDefault(); window.neko.open(a.dataset.href, cwd); };
    });
  }

  let toastT = null;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.classList.remove('hidden'); t.style.opacity = 1;
    clearTimeout(toastT);
    toastT = setTimeout(() => { t.style.opacity = 0; setTimeout(() => t.classList.add('hidden'), 200); }, 1800);
  }

  // kind: popup | notify | ask | osc ; returns a promise with { button, value } or { dismissed }
  function card(opts) {
    return new Promise(resolve => {
      const kind = opts.kind || 'popup';
      const el = document.createElement('div');
      el.className = `pop pop-${kind}`;
      const icon = kind === 'ask' ? '?' : kind === 'notify' || kind === 'osc' ? '🔔' : opts.claude ? '✳' : '🐱';
      const src = opts.source ? `<span class="pop-src">${esc(opts.source)}</span>` : '';
      let html = `<div class="pop-head"><span class="pop-ic">${icon}</span><span class="pop-title">${esc(opts.title || (kind === 'ask' ? 'Frage' : 'Neko'))}</span>${src}<button class="pop-x" title="Schließen (Esc)">✕</button></div>`;
      if (opts.text) html += `<div class="pop-body">${richText(opts.text)}</div>`;
      if (opts.image) html += `<div class="pop-img"><img alt=""></div>`;
      if (opts.links && opts.links.length) html += `<div class="pop-links">${opts.links.map(l => `<a href="#" data-href="${esc(l)}">${esc(l)}</a>`).join('')}</div>`;
      if (kind === 'ask' && opts.input) html += `<input class="pop-input" spellcheck="false" placeholder="${esc(opts.placeholder || 'Antwort…')}">`;
      if (kind === 'ask') html += `<div class="pop-btns">${(opts.buttons || ['OK']).map((b, i) => `<button class="pop-btn${i === 0 ? ' primary' : ''}" data-i="${i}">${esc(b)}</button>`).join('')}</div>`;
      el.innerHTML = html;
      if (opts.image) {
        const img = el.querySelector('.pop-img img');
        img.src = opts.image.dataUrl;
        img.title = 'Klick: groß anzeigen';
        img.onclick = () => lightbox(opts.image);
      }
      wireLinks(el, opts.cwd);
      stack.appendChild(el);
      requestAnimationFrame(() => el.classList.add('in'));

      let done = false;
      let timer = null;
      const close = result => {
        if (done) return;
        done = true;
        const hadFocus = el.contains(document.activeElement);
        clearTimeout(timer);
        el.classList.remove('in');
        el.classList.add('out');
        setTimeout(() => el.remove(), 180);
        if (opts.onClose) opts.onClose();
        resolve(result);
        if (opts.refocus && hadFocus) opts.refocus();
      };
      el.querySelector('.pop-x').onclick = () => close({ dismissed: true });
      el.addEventListener('mousedown', e => { if (opts.onActivate && !e.target.closest('button,a,input,img')) opts.onActivate(); });
      const input = el.querySelector('.pop-input');
      el.querySelectorAll('.pop-btn').forEach(b => {
        b.onclick = () => close({ button: b.textContent, index: +b.dataset.i, value: input ? input.value : undefined });
      });
      el.addEventListener('keydown', e => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close({ dismissed: true }); }
        else if (e.key === 'Enter' && kind === 'ask') { e.preventDefault(); const b = el.querySelector('.pop-btn'); if (b) b.click(); }
      });
      // never take keyboard focus on our own: an Enter typed into the terminal must not answer a question
      if (input) input.addEventListener('mousedown', e => e.stopPropagation());

      const ms = opts.timeout != null ? opts.timeout * 1000 : (kind === 'notify' || kind === 'osc' ? 7000 : 0);
      const arm = () => { clearTimeout(timer); if (ms > 0) timer = setTimeout(() => close({ dismissed: true, timeout: true }), ms); };
      el.addEventListener('mouseenter', () => clearTimeout(timer));
      el.addEventListener('mouseleave', arm);
      arm();
      // at most 5 cards
      const all = stack.querySelectorAll('.pop:not(.out)');
      if (all.length > 5) all[0].querySelector('.pop-x').click();
    });
  }

  // ------------------------------------------------ lightbox
  const lb = $('#lightbox');
  let lbImg = null;
  function lightbox(img) {
    lb.innerHTML = `<div class="lb-bar"><span class="lb-name">${esc(img.name || '')}</span><span class="lb-size"></span><span class="lb-sp"></span>${img.src ? '<button class="lb-open">Extern öffnen</button><button class="lb-reveal">Im Ordner zeigen</button>' : ''}<button class="lb-x">✕</button></div><div class="lb-stage"><img alt=""></div>`;
    lbImg = lb.querySelector('img');
    lbImg.onload = () => { lb.querySelector('.lb-size').textContent = `${lbImg.naturalWidth}×${lbImg.naturalHeight}`; };
    lbImg.src = img.dataUrl;
    lbImg.onclick = e => { e.stopPropagation(); lb.classList.toggle('actual'); };
    lb.querySelector('.lb-x').onclick = closeLightbox;
    const o = lb.querySelector('.lb-open'); if (o) o.onclick = () => window.neko.open(img.src);
    const r = lb.querySelector('.lb-reveal'); if (r) r.onclick = () => window.neko.open(img.src, '', { reveal: true });
    lb.classList.remove('hidden', 'actual');
    lb.tabIndex = -1;
    lb.focus();
  }
  function closeLightbox() {
    lb.classList.add('hidden');
    lb.innerHTML = '';
    if (window.NekoRefocus) window.NekoRefocus();
  }
  lb.addEventListener('mousedown', e => { if (e.target === lb || e.target.classList.contains('lb-stage')) closeLightbox(); });
  lb.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); closeLightbox(); } });
  async function lightboxFromPath(p, cwd) {
    const r = await window.neko.loadImage(p, cwd);
    if (!r || r.error) { toast(r && r.error || 'Bild nicht lesbar'); return; }
    lightbox(r);
  }

  window.NekoPopups = { card, toast, lightbox, lightboxFromPath, richText, isLightboxOpen: () => !lb.classList.contains('hidden') };
})();
