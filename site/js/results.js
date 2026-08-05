/* Company Swag Vote 2026 — private results reader.
 *
 * The static GitHub Pages site cannot hold an administrator secret. This page
 * asks the administrator to enter the deployed Worker URL and a private token
 * for each session, then reads the Worker CSV export in memory only.
 */
(function () {
  'use strict';

  var CATALOG_URL =
    (window.SWAG_RESULTS_CONFIG && window.SWAG_RESULTS_CONFIG.CATALOG_URL) || 'data/catalog.json';
  var SCORE_BY_VOTE = { Love: 2, Like: 1, "Don't Like": -1 };
  var el = {
    form: document.getElementById('results-form'),
    apiUrl: document.getElementById('api-url'),
    adminToken: document.getElementById('admin-token'),
    status: document.getElementById('results-status'),
    output: document.getElementById('results-output'),
    allRows: document.getElementById('results-all-rows'),
    feedbackList: document.getElementById('results-feedback-list'),
    feedbackEmpty: document.getElementById('results-feedback-empty'),
    updated: document.getElementById('results-updated'),
    ballots: document.getElementById('kpi-ballots'),
    ratings: document.getElementById('kpi-ratings'),
    products: document.getElementById('kpi-products'),
    download: document.getElementById('download-csv'),
    themeToggle: document.getElementById('theme-toggle'),
    themeToggleLabel: document.getElementById('theme-toggle-label'),
  };

  var state = { catalog: null, csv: '', loading: false };

  if (window.SWAG_VOTE_CONFIG && window.SWAG_VOTE_CONFIG.VOTE_API_URL) {
    el.apiUrl.value = String(window.SWAG_VOTE_CONFIG.VOTE_API_URL).replace(/\/+$/, '');
  }

  function escapeHTML(value) {
    return String(value).replace(/[&<>]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c];
    });
  }

  function setStatus(message, kind) {
    el.status.textContent = message;
    if (kind) {
      el.status.setAttribute('data-state', kind);
    } else {
      el.status.removeAttribute('data-state');
    }
  }

  function setLoading(loading) {
    state.loading = loading;
    el.form.querySelector('button[type="submit"]').disabled = loading;
    el.form.querySelector('button[type="submit"]').textContent = loading ? 'Loading…' : 'Load results';
  }

  function normalizeBase(value) {
    var raw = String(value || '').trim().replace(/\/+$/, '');
    if (!/^https:\/\//i.test(raw)) return '';
    return raw;
  }

  function parseCsv(raw) {
    var text = String(raw || '').replace(/^\uFEFF/, '');
    var rows = [];
    var row = [];
    var value = '';
    var quoted = false;

    for (var i = 0; i < text.length; i += 1) {
      var char = text[i];
      if (quoted) {
        if (char === '"') {
          if (text[i + 1] === '"') {
            value += '"';
            i += 1;
          } else {
            quoted = false;
          }
        } else {
          value += char;
        }
      } else if (char === '"') {
        quoted = true;
      } else if (char === ',') {
        row.push(value);
        value = '';
      } else if (char === '\n') {
        row.push(value.replace(/\r$/, ''));
        if (row.some(function (cell) { return cell !== ''; })) rows.push(row);
        row = [];
        value = '';
      } else {
        value += char;
      }
    }

    if (quoted) throw new Error('The export file contains an unmatched quote.');
    if (value || row.length) {
      row.push(value);
      if (row.some(function (cell) { return cell !== ''; })) rows.push(row);
    }
    if (!rows.length) return [];

    var headers = rows.shift();
    return rows.map(function (cells) {
      var record = {};
      headers.forEach(function (header, index) {
        record[header] = cells[index] || '';
      });
      return record;
    });
  }

  function summarize(records) {
    var tallies = {};
    var ballots = {};
    var feedbackByBallot = {};
    state.catalog.products.forEach(function (product) {
      tallies[product.id] = {
        id: product.id,
        name: product.name,
        love: 0,
        like: 0,
        dontLike: 0,
        ratings: 0,
        score: 0,
      };
    });

    records.forEach(function (record) {
      var feedback = String(record.feedback || '').trim();
      if (feedback && record.ballot_id && !Object.prototype.hasOwnProperty.call(feedbackByBallot, record.ballot_id)) {
        feedbackByBallot[record.ballot_id] = feedback;
      }
      var tally = tallies[record.product_id];
      if (!tally || !Object.prototype.hasOwnProperty.call(SCORE_BY_VOTE, record.vote)) return;
      tally.ratings += 1;
      tally.score += SCORE_BY_VOTE[record.vote];
      if (record.vote === 'Love') tally.love += 1;
      if (record.vote === 'Like') tally.like += 1;
      if (record.vote === "Don't Like") tally.dontLike += 1;
      if (record.ballot_id) ballots[record.ballot_id] = true;
    });

    var ranked = Object.keys(tallies)
      .map(function (id) { return tallies[id]; })
      .sort(function (a, b) {
        return (
          b.score - a.score ||
          b.love - a.love ||
          b.ratings - a.ratings ||
          a.name.localeCompare(b.name)
        );
      });

    return {
      ranked: ranked,
      ballots: Object.keys(ballots).length,
      ratings: records.filter(function (record) {
        return tallies[record.product_id] && Object.prototype.hasOwnProperty.call(SCORE_BY_VOTE, record.vote);
      }).length,
      products: ranked.filter(function (item) { return item.ratings > 0; }).length,
      feedback: Object.keys(feedbackByBallot).map(function (ballotId) {
        return feedbackByBallot[ballotId];
      }),
    };
  }

  function render(summary) {
    el.ballots.textContent = String(summary.ballots);
    el.ratings.textContent = String(summary.ratings);
    el.products.textContent = String(summary.products);
    el.updated.textContent = 'Loaded ' + new Date().toLocaleString();

    function renderRows(items) {
      return items
      .map(function (item, index) {
        return (
          '<tr data-testid="row-all-results-' + item.id + '">' +
          '<td class="results-rank">' + (index + 1) + '</td>' +
          '<th scope="row"><span class="results-product">' + escapeHTML(item.name) + '</span><span class="results-id">' + escapeHTML(item.id) + '</span></th>' +
          '<td>' + item.love + '</td>' +
          '<td>' + item.like + '</td>' +
          '<td>' + item.dontLike + '</td>' +
          '<td class="results-score">' + item.score + '</td>' +
          '</tr>'
        );
      })
      .join('');
    }

    el.allRows.innerHTML = renderRows(summary.ranked);
    el.feedbackList.innerHTML = summary.feedback
      .map(function (feedback, index) {
        return (
          '<li class="results-feedback__item" data-testid="item-feedback-' +
          (index + 1) +
          '"><p>' +
          escapeHTML(feedback) +
          '</p></li>'
        );
      })
      .join('');
    el.feedbackList.hidden = !summary.feedback.length;
    el.feedbackEmpty.hidden = summary.feedback.length > 0;
    el.output.hidden = false;
  }

  function downloadCsv() {
    if (!state.csv) return;
    var blob = new Blob([state.csv], { type: 'text/csv;charset=utf-8' });
    var link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'swag-vote-2026-results.csv';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(link.href);
  }

  function loadResults(event) {
    event.preventDefault();
    if (state.loading) return;
    var base = normalizeBase(el.apiUrl.value);
    var token = el.adminToken.value;

    if (!base || !token) {
      setStatus('Enter the deployed voting service URL and administrator export token.', 'error');
      return;
    }

    setLoading(true);
    setStatus('Reading the private export…', 'busy');

    Promise.all([
      state.catalog
        ? Promise.resolve(state.catalog)
        : fetch(CATALOG_URL, { cache: 'no-cache' }).then(function (res) {
            if (!res.ok) throw new Error('catalog HTTP ' + res.status);
            return res.json();
          }),
      fetch(base + '/admin/export.csv', {
        headers: { 'X-Admin-Token': token, Accept: 'text/csv' },
        cache: 'no-store',
      }).then(function (res) {
        return res.text().then(function (body) {
          if (!res.ok) {
            var errorMessage = 'The export could not be loaded (' + res.status + ').';
            try {
              errorMessage = JSON.parse(body).error || errorMessage;
            } catch (err) {
              /* Use the safe generic error. */
            }
            throw new Error(errorMessage);
          }
          return body;
        });
      }),
    ])
      .then(function (values) {
        var catalog = values[0];
        if (!catalog || !Array.isArray(catalog.products) || !catalog.products.length) {
          throw new Error('The product catalog is not available.');
        }
        state.catalog = catalog;
        state.csv = values[1];
        var records = parseCsv(state.csv);
        render(summarize(records));
        el.download.disabled = false;
        setStatus(records.length ? 'Private results loaded.' : 'No submitted ratings yet. The table shows zero totals.', 'ok');
      })
      .catch(function (err) {
        state.csv = '';
        el.download.disabled = true;
        setStatus(
          'Results were not loaded: ' + (err && err.message ? err.message : 'unknown error') + '.',
          'error'
        );
      })
      .finally(function () {
        setLoading(false);
      });
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    var goingDark = theme !== 'dark';
    el.themeToggle.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
    el.themeToggleLabel.textContent = goingDark ? 'Dark mode' : 'Light mode';
    el.themeToggle.setAttribute('aria-label', goingDark ? 'Switch to dark mode' : 'Switch to light mode');
  }

  var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(prefersDark ? 'dark' : 'light');
  el.themeToggle.addEventListener('click', function () {
    applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
  });
  el.form.addEventListener('submit', loadResults);
  el.download.addEventListener('click', downloadCsv);
})();
