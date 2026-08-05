/* Company Swag Vote 2026 — ballot client (vanilla JS, no build step).
 *
 * Responsibilities:
 *   - load the static catalog and render category-grouped product cards
 *   - track optional Like / Love / Don't Like selections and progress
 *   - POST one anonymous ballot to the configured Worker endpoint
 *   - store a vote-lock ONLY after the server accepts the ballot
 *   - degrade gracefully where web storage is unavailable (sandbox previews)
 */
(function () {
  'use strict';

  var CATALOG_URL = 'data/catalog.json';
  var VOTE_VALUES = ['Like', 'Love', "Don't Like"];
  var STORE_LOCK = 'hbt.swagvote.2026.lock';
  var STORE_ID = 'hbt.swagvote.2026.browserId';
  var STORE_THEME = 'hbt.swagvote.2026.theme';

  var el = {
    loading: document.getElementById('loading-state'),
    error: document.getElementById('error-state'),
    errorDetail: document.getElementById('error-detail'),
    retry: document.getElementById('retry-catalog'),
    form: document.getElementById('ballot-form'),
    sections: document.getElementById('category-sections'),
    filters: document.getElementById('category-filters'),
    progressBar: document.getElementById('progress-bar'),
    progressMeter: document.getElementById('progress-meter'),
    progressFill: document.getElementById('progress-fill'),
    progressCount: document.getElementById('progress-count'),
    progressTotal: document.getElementById('progress-total'),
    submitSticky: document.getElementById('submit-sticky'),
    status: document.getElementById('form-status'),
    confirmation: document.getElementById('confirmation'),
    confirmationDetail: document.getElementById('confirmation-detail'),
    feedback: document.getElementById('feedback'),
    themeToggle: document.getElementById('theme-toggle'),
    themeToggleLabel: document.getElementById('theme-toggle-label'),
    imageZoom: document.getElementById('image-zoom'),
    imageZoomImage: document.getElementById('image-zoom-image'),
    imageZoomCaption: document.getElementById('image-zoom-caption'),
    imageZoomClose: document.getElementById('image-zoom-close'),
  };

  var state = {
    catalog: null,
    votes: Object.create(null),
    submitting: false,
    locked: false,
    zoomTrigger: null,
  };

  /* ---------------------------------------------------------------- storage
   * localStorage works on real GitHub Pages but is blocked in some sandboxed
   * preview iframes. Every access is guarded; a failure degrades to an
   * in-memory fallback for the current page view only.
   */
  var memory = Object.create(null);
  var storageOk = (function () {
    try {
      var k = '__hbt_probe__';
      window.localStorage.setItem(k, '1');
      window.localStorage.removeItem(k);
      return true;
    } catch (err) {
      return false;
    }
  })();

  function storeGet(key) {
    if (storageOk) {
      try {
        return window.localStorage.getItem(key);
      } catch (err) {
        /* fall through to memory */
      }
    }
    return Object.prototype.hasOwnProperty.call(memory, key) ? memory[key] : null;
  }

  function storeSet(key, value) {
    memory[key] = value;
    if (storageOk) {
      try {
        window.localStorage.setItem(key, value);
      } catch (err) {
        /* non-fatal: preview sandboxes block persistence */
      }
    }
  }

  /* ------------------------------------------------------------------ theme */
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    var goingDark = theme !== 'dark';
    el.themeToggle.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
    el.themeToggleLabel.textContent = goingDark ? 'Dark mode' : 'Light mode';
    el.themeToggle.setAttribute(
      'aria-label',
      goingDark ? 'Switch to dark mode' : 'Switch to light mode'
    );
  }

  function initTheme() {
    var saved = storeGet(STORE_THEME);
    var prefersDark =
      window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    applyTheme(saved === 'dark' || saved === 'light' ? saved : prefersDark ? 'dark' : 'light');
    el.themeToggle.addEventListener('click', function () {
      var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      storeSet(STORE_THEME, next);
    });
  }

  /* ------------------------------------------------------------- identifiers */
  function browserId() {
    var existing = storeGet(STORE_ID);
    if (existing) return existing;
    var id;
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      id = window.crypto.randomUUID();
    } else if (window.crypto && window.crypto.getRandomValues) {
      var buf = new Uint8Array(16);
      window.crypto.getRandomValues(buf);
      id = Array.prototype.map
        .call(buf, function (b) {
          return ('0' + b.toString(16)).slice(-2);
        })
        .join('');
    } else {
      id = 'fallback-' + Date.now() + '-' + Math.random().toString(36).slice(2, 12);
    }
    storeSet(STORE_ID, id);
    return id;
  }

  function apiBase() {
    var cfg = window.SWAG_VOTE_CONFIG || {};
    return String(cfg.VOTE_API_URL || '').trim().replace(/\/+$/, '');
  }

  /* ---------------------------------------------------------------- rendering */
  function slug(text) {
    return String(text)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  }

  function voteKey(value) {
    return value === "Don't Like" ? 'dontlike' : value.toLowerCase();
  }

  function fallbackFigure() {
    return (
      '<div class="card__fallback">' +
      '<svg viewBox="0 0 32 32" aria-hidden="true" fill="none">' +
      '<rect x="2.5" y="5.5" width="27" height="21" rx="2" stroke="currentColor" stroke-width="2"/>' +
      '<path d="M2.5 21l7-6.5 6 5 5-4.5 9 8" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>' +
      '<circle cx="21" cy="12" r="2.2" stroke="currentColor" stroke-width="2"/>' +
      '</svg>' +
      '<span class="card__fallback-label">Image coming soon</span>' +
      '<span class="card__fallback-sub">No product photograph supplied yet — rate it on name and price.</span>' +
      '</div>'
    );
  }

  function cardHTML(p) {
    var figure;
    if (p.image) {
      figure =
        '<button class="card__zoom" type="button" data-zoom-src="' +
        escapeAttr(p.image) +
        '" data-zoom-name="' +
        escapeAttr(p.name) +
        '" aria-label="View larger image of ' +
        escapeAttr(p.name) +
        '" data-testid="button-zoom-' +
        p.id +
        '">' +
        '<img class="card__img" src="' +
        p.image +
        '" alt="Product photograph of the ' +
        escapeAttr(p.name) +
        ', a candidate ' +
        escapeAttr(p.category.toLowerCase()) +
        ' swag item." width="800" height="600" loading="lazy" decoding="async" data-testid="img-product-' +
        p.id +
        '">' +
        '</button>';
    } else {
      figure = fallbackFigure();
    }

    var opts = VOTE_VALUES.map(function (value) {
      var k = voteKey(value);
      return (
        '<label class="voteopt voteopt--' +
        k +
        '">' +
        '<input type="radio" name="vote-' +
        p.id +
        '" value="' +
        escapeAttr(value) +
        '" data-product="' +
        p.id +
        '" data-testid="radio-' +
        p.id +
        '-' +
        k +
        '">' +
        '<span>' +
        escapeHTML(value) +
        '</span>' +
        '</label>'
      );
    }).join('');

    return (
      '<li class="card" data-product="' +
      p.id +
      '" data-testid="card-product-' +
      p.id +
      '">' +
      '<figure class="card__figure">' +
      figure +
      '</figure>' +
      '<div class="card__body">' +
      '<h3 class="card__name" id="name-' +
      p.id +
      '" data-testid="text-name-' +
      p.id +
      '">' +
      escapeHTML(p.name) +
      '</h3>' +
      '<p class="card__price" data-testid="text-price-' +
      p.id +
      '">Approx. $' +
      escapeHTML(String(p.price)) +
      '<span>Max before bulk pricing</span></p>' +
      '<fieldset class="card__vote">' +
      '<legend class="visually-hidden">Your rating for ' +
      escapeHTML(p.name) +
      '</legend>' +
      '<div class="votegroup">' +
      opts +
      '</div>' +
      '<button class="card__clear" type="button" data-clear="' +
      p.id +
      '" data-testid="button-clear-' +
      p.id +
      '" hidden>Clear my rating</button>' +
      '</fieldset>' +
      '</div>' +
      '</li>'
    );
  }

  function escapeHTML(s) {
    return String(s).replace(/[&<>]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c];
    });
  }

  function escapeAttr(s) {
    return escapeHTML(s).replace(/"/g, '&quot;');
  }

  function render(catalog) {
    var byCategory = {};
    catalog.products.forEach(function (p) {
      (byCategory[p.category] = byCategory[p.category] || []).push(p);
    });

    var order = (catalog.categories || []).map(function (c) {
      return c.name;
    });
    Object.keys(byCategory).forEach(function (name) {
      if (order.indexOf(name) === -1) order.push(name);
    });

    el.sections.innerHTML = order
      .map(function (name) {
        var items = byCategory[name] || [];
        if (!items.length) return '';
        var id = slug(name);
        var withPhoto = items.filter(function (p) {
          return !!p.image;
        }).length;
        return (
          '<section class="catsection" id="cat-' +
          id +
          '" data-category="' +
          id +
          '" aria-labelledby="cath-' +
          id +
          '" data-testid="section-category-' +
          id +
          '">' +
          '<div class="catsection__head">' +
          '<h2 id="cath-' +
          id +
          '">' +
          escapeHTML(name) +
          '</h2>' +
          '<p class="catsection__meta" data-testid="text-category-meta-' +
          id +
          '">' +
          items.length +
          ' item' +
          (items.length === 1 ? '' : 's') +
          ' · ' +
          withPhoto +
          ' photographed' +
          '</p>' +
          '</div>' +
          '<ul class="cardgrid" role="list">' +
          items.map(cardHTML).join('') +
          '</ul>' +
          '</section>'
        );
      })
      .join('');

    var chips = (catalog.categories || []).map(function (c) {
      var id = slug(c.name);
      return (
        '<li><button class="chip" type="button" data-filter="' +
        id +
        '" data-testid="filter-' +
        id +
        '" aria-pressed="false">' +
        escapeHTML(c.name) +
        ' <span aria-hidden="true">(' +
        c.count +
        ')</span></button></li>'
      );
    });
    el.filters.insertAdjacentHTML('beforeend', chips.join(''));

    el.progressTotal.textContent = String(catalog.products.length);
    el.progressMeter.setAttribute('aria-valuemax', String(catalog.products.length));
    document.querySelectorAll('[data-testid="text-closer-total"]').forEach(function (n) {
      n.textContent = String(catalog.products.length);
    });
    document.querySelectorAll('[data-testid="text-catalog-count"]').forEach(function (n) {
      n.textContent = String(catalog.products.length);
    });
  }

  /* ---------------------------------------------------------------- progress */
  function ratedCount() {
    return Object.keys(state.votes).length;
  }

  function updateProgress() {
    var total = state.catalog ? state.catalog.products.length : 0;
    var n = ratedCount();
    var pct = total ? Math.round((n / total) * 100) : 0;
    el.progressCount.textContent = String(n);
    el.progressFill.style.width = pct + '%';
    el.progressMeter.setAttribute('aria-valuenow', String(n));
    el.progressMeter.setAttribute('aria-valuetext', n + ' of ' + total + ' products rated');
    document.querySelectorAll('[data-testid="text-closer-rated"]').forEach(function (node) {
      node.textContent = String(n);
    });
  }

  /* ------------------------------------------------------------------ events */
  function onChange(event) {
    var input = event.target;
    if (!input || input.type !== 'radio' || !input.dataset.product) return;
    state.votes[input.dataset.product] = input.value;
    var clear = el.sections.querySelector('[data-clear="' + input.dataset.product + '"]');
    if (clear) clear.hidden = false;
    updateProgress();
    setStatus('', null);
  }

  function onClick(event) {
    var zoom = event.target.closest('[data-zoom-src]');
    if (zoom) {
      openImageZoom(zoom);
      return;
    }
    var clear = event.target.closest('[data-clear]');
    if (!clear) return;
    var pid = clear.getAttribute('data-clear');
    delete state.votes[pid];
    el.sections
      .querySelectorAll('input[name="vote-' + pid + '"]')
      .forEach(function (input) {
        input.checked = false;
      });
    clear.hidden = true;
    updateProgress();
  }

  function openImageZoom(trigger) {
    var src = trigger.getAttribute('data-zoom-src');
    var name = trigger.getAttribute('data-zoom-name');
    if (!src || !el.imageZoom) return;
    state.zoomTrigger = trigger;
    el.imageZoomImage.src = src;
    el.imageZoomImage.alt = 'Larger view of ' + name;
    el.imageZoomCaption.textContent = name;
    if (typeof el.imageZoom.showModal === 'function') {
      el.imageZoom.showModal();
    } else {
      el.imageZoom.setAttribute('open', '');
    }
    el.imageZoomClose.focus();
  }

  function closeImageZoom() {
    if (!el.imageZoom || !el.imageZoom.open) return;
    if (typeof el.imageZoom.close === 'function') {
      el.imageZoom.close();
    } else {
      el.imageZoom.removeAttribute('open');
    }
  }

  function resetImageZoom() {
    el.imageZoomImage.src = '';
    el.imageZoomImage.alt = '';
    el.imageZoomCaption.textContent = '';
    if (state.zoomTrigger) {
      state.zoomTrigger.focus();
      state.zoomTrigger = null;
    }
  }

  function onFilter(event) {
    var btn = event.target.closest('[data-filter]');
    if (!btn) return;
    var filter = btn.getAttribute('data-filter');
    el.filters.querySelectorAll('[data-filter]').forEach(function (b) {
      var active = b === btn;
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    el.sections.querySelectorAll('[data-category]').forEach(function (section) {
      section.hidden = filter !== 'all' && section.getAttribute('data-category') !== filter;
    });
  }

  function setStatus(message, stateName) {
    el.status.textContent = message;
    if (stateName) {
      el.status.setAttribute('data-state', stateName);
    } else {
      el.status.removeAttribute('data-state');
    }
  }

  /* -------------------------------------------------------------- submission */
  function lockAndConfirm(count, message) {
    state.locked = true;
    storeSet(STORE_LOCK, JSON.stringify({ submitted: new Date().toISOString(), count: count }));
    el.form.hidden = true;
    el.progressBar.hidden = true;
    el.confirmation.hidden = false;
    if (message) el.confirmationDetail.textContent = message;
    document.querySelectorAll('[data-testid="text-confirmed-count"]').forEach(function (n) {
      n.textContent = String(count);
    });
    if (!storageOk) {
      el.confirmation.insertAdjacentHTML(
        'beforeend',
        '<p class="confirmation__meta" data-testid="text-storage-warning">Note: this browser blocks local' +
          ' storage (common inside preview frames), so the one-ballot lock cannot persist across a reload' +
          ' here. On the published GitHub Pages site it persists normally, and the server rejects a second' +
          ' ballot from the same browser identifier either way.</p>'
      );
    }
    el.confirmation.setAttribute('tabindex', '-1');
    el.confirmation.focus();
  }

  function setSubmitting(flag) {
    state.submitting = flag;
    document
      .querySelectorAll(
        '[data-testid="button-submit-ballot"], [data-testid="button-submit-ballot-closer"], [data-testid="input-feedback"]'
      )
      .forEach(function (b) {
        b.disabled = flag;
        if (b.matches('[data-testid="button-submit-ballot"], [data-testid="button-submit-ballot-closer"]')) {
          b.textContent = flag ? 'Submitting…' : 'Submit my ballot';
        }
      });
  }

  function submitBallot() {
    if (state.submitting || state.locked) return;

    var base = apiBase();
    if (!base) {
      setStatus(
        'Voting endpoint not configured yet. An administrator must set VOTE_API_URL in site/js/config.js to the deployed Worker URL before ballots can be sent. Nothing was submitted.',
        'error'
      );
      return;
    }

    var votes = Object.keys(state.votes).map(function (pid) {
      return { productId: pid, vote: state.votes[pid] };
    });

    if (!votes.length) {
      setStatus('Rate at least one product before submitting.', 'error');
      return;
    }

    setSubmitting(true);
    setStatus('Sending your ballot…', 'busy');

    var feedback = el.feedback ? el.feedback.value.trim() : '';
    var payload = { browserId: browserId(), votes: votes, feedback: feedback || null };

    fetch(base + '/votes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (res) {
        return res
          .json()
          .catch(function () {
            return {};
          })
          .then(function (body) {
            return { status: res.status, ok: res.ok, body: body };
          });
      })
      .then(function (r) {
        if (r.ok && r.body && r.body.accepted) {
          lockAndConfirm(r.body.recorded || votes.length, null);
          return;
        }
        if (r.status === 409) {
          lockAndConfirm(
            r.body && r.body.recorded ? r.body.recorded : votes.length,
            'A ballot from this browser was already recorded, so this one was not counted again. Only the first ballot per browser is kept.'
          );
          return;
        }
        setSubmitting(false);
        setStatus(
          'The ballot was not accepted (' +
            r.status +
            (r.body && r.body.error ? ': ' + r.body.error : '') +
            '). Nothing was recorded — please try again.',
          'error'
        );
      })
      .catch(function () {
        setSubmitting(false);
        setStatus(
          'Could not reach the voting service. Check your connection and try again — nothing was recorded.',
          'error'
        );
      });
  }

  /* ------------------------------------------------------------------- boot */
  function showError(detail) {
    el.loading.hidden = true;
    el.form.hidden = true;
    el.progressBar.hidden = true;
    el.error.hidden = false;
    el.errorDetail.textContent = detail;
  }

  function loadCatalog() {
    el.error.hidden = true;
    el.loading.hidden = false;

    fetch(CATALOG_URL, { cache: 'no-cache' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (catalog) {
        if (!catalog || !Array.isArray(catalog.products) || !catalog.products.length) {
          throw new Error('empty catalog');
        }
        state.catalog = catalog;
        render(catalog);
        el.loading.hidden = true;

        var lock = storeGet(STORE_LOCK);
        if (lock) {
          var parsed = {};
          try {
            parsed = JSON.parse(lock) || {};
          } catch (err) {
            parsed = {};
          }
          state.locked = true;
          el.form.hidden = true;
          el.progressBar.hidden = true;
          el.confirmation.hidden = false;
          el.confirmationDetail.textContent =
            'A ballot has already been submitted from this browser, so voting is closed here. Only one anonymous ballot per browser is counted.';
          document.querySelectorAll('[data-testid="text-confirmed-count"]').forEach(function (n) {
            n.textContent = String(parsed.count || 0);
          });
          return;
        }

        el.form.hidden = false;
        el.progressBar.hidden = false;
        updateProgress();
      })
      .catch(function (err) {
        showError(
          'The product catalog could not be loaded (' +
            (err && err.message ? err.message : 'unknown error') +
            '). Reload the page or try again.'
        );
      });
  }

  initTheme();
  el.sections.addEventListener('change', onChange);
  el.sections.addEventListener('click', onClick);
  el.imageZoomClose.addEventListener('click', closeImageZoom);
  el.imageZoom.addEventListener('click', function (event) {
    if (event.target === el.imageZoom) closeImageZoom();
  });
  el.imageZoom.addEventListener('close', resetImageZoom);
  el.filters.addEventListener('click', onFilter);
  el.retry.addEventListener('click', loadCatalog);
  el.submitSticky.addEventListener('click', submitBallot);
  el.form.addEventListener('submit', function (event) {
    event.preventDefault();
    submitBallot();
  });
  loadCatalog();
})();
