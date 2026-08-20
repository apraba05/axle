const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

const docs = {
  v1: `CERTIFICATE OF COMMERCIAL LIABILITY INSURANCE
Carrier: Harborstone Mutual Insurance Co.
Policy Number: AX-10482
Named Insured: Northstar Freight LLC
General Liability Limit: $250,000
Effective Date: 2025-01-01
Expiration Date: 2025-12-31
Status: Active`,
  v2: `COMMERCIAL LIABILITY POLICY — RENEWAL
Carrier: Harborstone Mutual Insurance Co.
Policy Number: AX-10482
Named Insured: Northstar Freight LLC
General Liability Limit: $500,000
Effective Date: 2026-01-01
Expiration Date: 2026-12-31
Status: Active`,
  risky: `CERTIFICATE OF COMMERCIAL LIABILITY INSURANCE
Carrier: Redline Casualty Group
Policy Number: RL-77301
Named Insured: Swift Cartage Inc.
General Liability Limit: $75,000
Effective Date: 2025-06-01
Expiration Date: 2026-05-31
Status: Active`
};

let state = freshState();

function freshState() {
  return { policies: {}, alerts: [], requests: 0, hits: 0, misses: 0 };
}

function extract(text) {
  const field = label => {
    const match = text.match(new RegExp(`${label}:\\s*(.+)`, 'i'));
    return match ? match[1].trim() : 'Unknown';
  };
  const rawLimit = field('General Liability Limit');
  return {
    carrier: field('Carrier'),
    policy_number: field('Policy Number'),
    insured: field('Named Insured'),
    coverage_limits: { general_liability: Number.parseInt(rawLimit.replace(/\D/g, ''), 10) || 0 },
    effective_date: field('Effective Date'),
    expiration_date: field('Expiration Date')
  };
}

function snapshot() {
  return {
    alerts: state.alerts,
    requests: state.requests,
    hits: state.hits,
    misses: state.misses
  };
}

function processPolicy(text, failAlert = false) {
  if (!text.trim()) throw new Error('Policy text is required');
  const started = performance.now();
  const record = extract(text);
  const limit = record.coverage_limits.general_liability;
  const validation = {
    passed: limit >= 100000,
    reason: `$${limit.toLocaleString('en-US')} ${limit >= 100000 ? 'meets' : 'is below'} the $100,000 minimum`
  };
  state.requests += 1;
  const previous = state.policies[record.policy_number];
  if (previous) state.hits += 1;
  else state.misses += 1;

  const changes = [];
  if (previous) {
    const labels = {
      carrier: 'Carrier',
      effective_date: 'Effective date',
      expiration_date: 'Expiration date',
      coverage_limits: 'Coverage limit'
    };
    Object.entries(labels).forEach(([key, label]) => {
      if (JSON.stringify(previous[key]) !== JSON.stringify(record[key])) {
        let oldValue = previous[key];
        let newValue = record[key];
        if (key === 'coverage_limits') {
          oldValue = `$${oldValue.general_liability.toLocaleString('en-US')}`;
          newValue = `$${newValue.general_liability.toLocaleString('en-US')}`;
        }
        changes.push({ field: label, from: oldValue, to: newValue });
      }
    });
  }
  state.policies[record.policy_number] = record;

  let alert = null;
  if (changes.length) {
    const utc = new Date().toLocaleTimeString('en-GB', {
      timeZone: 'UTC', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    alert = {
      id: state.alerts.length + 1,
      time: `${utc} UTC`,
      policy: record.policy_number,
      changes,
      status: failAlert ? 'retrying' : 'delivered'
    };
    state.alerts.unshift(alert);
  }
  return {
    extracted: record,
    validation,
    cache: previous ? 'HIT' : 'MISS',
    changes,
    alert,
    latency_ms: Math.round(performance.now() - started + 286),
    stats: snapshot()
  };
}

function resetState() {
  state = freshState();
  return { ok: true, stats: snapshot() };
}

function recoverAlerts() {
  state.alerts.forEach(alert => {
    if (alert.status === 'retrying') alert.status = 'delivered';
  });
  return { ok: true, alerts: state.alerts };
}

function renderStats(data) {
  $('#requests').textContent = data.requests;
  $('#hitRate').textContent = data.requests ? `${Math.round(data.hits / data.requests * 100)}%` : '—';
  $('#alertsCount').textContent = data.alerts.length;
}

function renderFeed(alerts) {
  const box = $('#feed');
  $('#recover').hidden = !alerts.some(alert => alert.status === 'retrying');
  box.innerHTML = alerts.length ? alerts.map(alert => `<div class="alert ${alert.status}"><b>${alert.status === 'retrying' ? 'Delivery failed — queued for retry' : 'Slack alert delivered'} · ${alert.policy}</b><time>${alert.time}</time><p>${alert.changes.map(change => `${change.field}: ${typeof change.from === 'object' ? JSON.stringify(change.from) : change.from} → ${typeof change.to === 'object' ? JSON.stringify(change.to) : change.to}`).join(' · ')}</p></div>`).join('') : '<div class="feed-empty">No policy changes detected yet.<br><small>Process the original, then the renewal.</small></div>';
}

function renderFields(record) {
  const values = [
    ['CARRIER', record.carrier],
    ['POLICY NUMBER', record.policy_number],
    ['LIABILITY LIMIT', `$${record.coverage_limits.general_liability.toLocaleString('en-US')}`],
    ['EFFECTIVE → EXPIRATION', `${record.effective_date} → ${record.expiration_date}`]
  ];
  $('#fields').innerHTML = values.map(value => `<div class="field"><small>${value[0]}</small><b>${value[1]}</b></div>`).join('');
}

function boot() {
  renderStats(snapshot());
  renderFeed(state.alerts);
  $('#document').value = docs.v1;
}

$$('.tabs button').forEach(button => {
  button.onclick = () => {
    $$('.tabs button').forEach(item => item.classList.remove('active'));
    button.classList.add('active');
    $('#document').value = docs[button.dataset.doc];
  };
});

$('#run').onclick = async () => {
  const button = $('#run');
  button.disabled = true;
  $$('.node').forEach(node => {
    node.className = 'node';
    node.querySelector('span').textContent = 'Idle';
  });
  $$('.connector').forEach(connector => connector.classList.remove('flow'));
  $('#result').className = 'result empty';
  $('#result').innerHTML = '<span>◌</span><b>Pipeline running</b><p>Document entered the extraction queue…</p>';
  const names = ['extract', 'validate', 'monitor', 'alert'];
  for (let index = 0; index < 3; index += 1) {
    const node = $(`[data-node="${names[index]}"]`);
    node.classList.add('running');
    node.querySelector('span').textContent = 'Running';
    await wait(380);
    node.className = 'node done';
    node.querySelector('span').textContent = 'Complete';
    $$('.connector')[index].classList.add('flow');
  }
  try {
    const data = processPolicy($('#document').value, $('#fail').checked);
    const alertNode = $('[data-node="alert"]');
    alertNode.classList.add('running');
    alertNode.querySelector('span').textContent = data.alert ? 'Sending' : 'No change';
    await wait(380);
    alertNode.className = `node ${data.alert?.status === 'retrying' ? 'error' : 'done'}`;
    alertNode.querySelector('span').textContent = data.alert?.status === 'retrying' ? 'Queued' : data.alert ? 'Delivered' : 'No change';
    renderFields(data.extracted);
    renderStats(data.stats);
    renderFeed(data.stats.alerts);
    $('#cache').textContent = `REDIS ${data.cache}`;
    $('#latency').textContent = `${data.latency_ms} MS TOTAL`;
    $('#result').className = `result ${data.validation.passed ? 'pass' : 'fail'}`;
    $('#result').innerHTML = `<span>${data.validation.passed ? '✓' : '!'}</span><b>${data.validation.passed ? 'Coverage verified' : 'Validation failed'}</b><p>${data.validation.reason}${data.changes.length ? ` · ${data.changes.length} policy changes detected` : ''}</p>`;
  } catch (error) {
    $('#result').className = 'result fail';
    $('#result').innerHTML = `<span>!</span><b>Pipeline error</b><p>${error.message}</p>`;
  } finally {
    button.disabled = false;
  }
};

$('#reset').onclick = () => {
  resetState();
  $('#fields').innerHTML = '<p>No extraction yet</p>';
  $('#cache').textContent = 'CACHE —';
  $('#latency').textContent = 'AWAITING RUN';
  $$('.node').forEach(node => {
    node.className = 'node';
    node.querySelector('span').textContent = 'Idle';
  });
  $('#result').className = 'result empty';
  $('#result').innerHTML = '<span>◆</span><b>Ready to verify</b><p>Choose a document and run it through the pipeline.</p>';
  boot();
};

$('#recover').onclick = () => renderFeed(recoverAlerts().alerts);

boot();
