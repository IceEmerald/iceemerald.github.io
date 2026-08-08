const yearNode = document.getElementById('current-year');
const updateTimeNode = document.getElementById('update-time');

if (yearNode) {
  yearNode.textContent = String(new Date().getFullYear());
}
if (updateTimeNode) {
  updateTimeNode.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function parseDMY(str) {
  const [day, month, year] = String(str).split('-').map(Number);
  return new Date(year, month - 1, day);
}

function localKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function prettyDate(str) {
  return parseDMY(str).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function monthGroup(str) {
  return parseDMY(str).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function stripComments(text) {
  return String(text).split('\n').map((line) => line.replace(/^\s*\/\/.*$/, '')).join('\n');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;').replace(/'/g, '&#39;');
}

function toggleCard(id) {
  const body = document.getElementById(`body-${id}`);
  const chevron = document.getElementById(`chevron-${id}`);
  if (!body || !chevron) return;

  const isOpen = body.classList.contains('open');
  body.classList.toggle('open', !isOpen);
  chevron.classList.toggle('open', !isOpen);
}

function calcUptime(serviceId, uptimeDays) {
  const today = new Date();
  const window90 = new Date(today);
  window90.setDate(today.getDate() - 90);

  const badDays = (uptimeDays[serviceId] || []).filter((entry) => {
    const date = parseDMY(entry.date);
    return date >= window90 && date <= today;
  }).length;

  const pct = ((91 - badDays) / 91) * 100;
  return Number.isInteger(pct) ? `${pct.toFixed(0)}%` : `${pct.toFixed(1)}%`;
}

function detectStatus(serviceId, uptimeDays) {
  const today = localKey(new Date());
  const entries = uptimeDays[serviceId] || [];
  const hit = entries.find((entry) => localKey(parseDMY(entry.date)) === today);
  return hit ? hit.type : 'operational';
}

function statusBadge(status) {
  const map = {
    operational: { cls: 'badge-operational', dot: 'dot-operational', label: 'Operational' },
    degraded: { cls: 'badge-degraded', dot: 'dot-degraded', label: 'Degraded' },
    outage: { cls: 'badge-outage', dot: 'dot-outage', label: 'Outage' }
  };
  const meta = map[status] || map.operational;

  const badge = document.createElement('span');
  badge.className = `status-badge ${meta.cls}`;

  const dot = document.createElement('span');
  dot.className = `badge-dot ${meta.dot}`;

  const label = document.createElement('span');
  label.textContent = meta.label;

  badge.append(dot, label);
  return badge;
}

function buildBar(serviceId, uptimeDays) {
  const bar = document.getElementById(`bar-${serviceId}`);
  if (!bar) return;

  bar.replaceChildren();

  const today = new Date();
  const incidentMap = {};
  (uptimeDays[serviceId] || []).forEach((entry) => {
    incidentMap[localKey(parseDMY(entry.date))] = entry.type;
  });

  for (let i = 0; i <= 90; i += 1) {
    const daysAgo = 90 - i;
    const segDate = new Date(today);
    segDate.setDate(today.getDate() - daysAgo);
    const key = localKey(segDate);
    const type = incidentMap[key] || '';

    const seg = document.createElement('div');
    seg.className = `uptime-bar-seg${type ? ` ${type}` : ''}`;

    const tooltip = document.createElement('div');
    tooltip.className = 'seg-tooltip';
    if (daysAgo === 0) tooltip.textContent = 'Today';
    else if (daysAgo === 1) tooltip.textContent = 'Yesterday';
    else tooltip.textContent = `${segDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} (${daysAgo} days ago)`;

    seg.appendChild(tooltip);
    bar.appendChild(seg);
  }
}

function renderServices(services, uptimeDays) {
  const container = document.getElementById('services-list');
  if (!container) return;
  container.replaceChildren();

  services.forEach((svc) => {
    const status = detectStatus(svc.id, uptimeDays);
    const uptime = calcUptime(svc.id, uptimeDays);
    const card = document.createElement('div');
    card.className = 'status-card animate-on-scroll';

    const header = document.createElement('div');
    header.className = 'status-card-header';
    header.addEventListener('click', () => toggleCard(svc.id));

    const title = document.createElement('span');
    title.className = 'status-card-title';
    title.textContent = svc.name;

    const meta = document.createElement('div');
    meta.style.display = 'flex';
    meta.style.alignItems = 'center';
    meta.style.gap = '0.5rem';
    meta.appendChild(statusBadge(status));

    const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    chevron.setAttribute('class', 'chevron');
    chevron.setAttribute('id', `chevron-${svc.id}`);
    chevron.setAttribute('viewBox', '0 0 24 24');
    chevron.setAttribute('fill', 'none');
    chevron.setAttribute('stroke', 'currentColor');
    chevron.setAttribute('stroke-width', '2');
    chevron.setAttribute('stroke-linecap', 'round');
    chevron.setAttribute('stroke-linejoin', 'round');
    chevron.innerHTML = '<polyline points="6 9 12 15 18 9"></polyline>';
    meta.appendChild(chevron);

    header.append(title, meta);

    const body = document.createElement('div');
    body.className = 'status-card-body';
    body.id = `body-${svc.id}`;

    const rows = document.createElement('div');
    (svc.items || []).forEach((item) => {
      const row = document.createElement('div');
      row.className = 'service-row';

      const name = document.createElement('span');
      name.className = 'service-row-name';

      const dot = document.createElement('span');
      dot.className = `badge-dot dot-${status}`;
      name.appendChild(dot);
      name.appendChild(document.createTextNode(` ${item.name}`));

      const uptimeLabel = document.createElement('span');
      uptimeLabel.className = 'service-uptime-label';
      uptimeLabel.textContent = `${uptime} uptime`;

      row.append(name, uptimeLabel);
      rows.appendChild(row);
    });

    const wrap = document.createElement('div');
    wrap.className = 'uptime-bar-wrap';
    const bar = document.createElement('div');
    bar.className = 'uptime-bar';
    bar.id = `bar-${svc.id}`;
    const labels = document.createElement('div');
    labels.className = 'uptime-bar-labels';
    labels.innerHTML = '<span>90 days ago</span><span>Today</span>';
    wrap.append(bar, labels);

    body.append(rows, wrap);
    card.append(header, body);
    container.appendChild(card);

    buildBar(svc.id, uptimeDays);
  });
}

function renderHero(incidents) {
  const hasActive = incidents.some((item) => item.currentIncident === true);
  const icon = document.getElementById('hero-icon');
  const title = document.getElementById('overall-status');

  if (!icon || !title) return;

  if (hasActive) {
    icon.className = 'status-hero-icon outage';
    icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>';
    title.textContent = 'Partial Outage';
    return;
  }

  icon.className = 'status-hero-icon operational';
  icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
  title.textContent = 'All Systems Operational';
}

function renderIncidents(incidents) {
  const sorted = incidents.slice().sort((a, b) => parseDMY(b.date) - parseDMY(a.date));
  const current = sorted.filter((entry) => entry.currentIncident === true);
  const previous = sorted.filter((entry) => entry.currentIncident !== true);

  const labelEl = document.getElementById('label-current');
  const currentEl = document.getElementById('current-incidents-list');
  if (currentEl) {
    currentEl.replaceChildren();
    if (current.length > 0 && labelEl) labelEl.style.display = '';

    current.forEach((incident) => {
      const card = document.createElement('div');
      card.className = 'incident-card current animate-on-scroll';

      const row = document.createElement('div');
      row.className = 'incident-row';

      const info = document.createElement('div');
      const title = document.createElement('div');
      title.className = 'incident-title';
      title.textContent = incident.title;
      const desc = document.createElement('div');
      desc.className = 'incident-desc';
      desc.textContent = incident.desc;
      const meta = document.createElement('div');
      meta.className = 'incident-meta';
      meta.textContent = `Ongoing · since ${prettyDate(incident.date)}`;
      info.append(title, desc, meta);

      const badge = document.createElement('span');
      badge.className = 'badge-ongoing';
      badge.textContent = 'Ongoing';

      row.append(info, badge);
      card.appendChild(row);
      currentEl.appendChild(card);
    });
  }

  const prevEl = document.getElementById('previous-incidents-list');
  if (!prevEl) return;

  if (previous.length === 0) {
    prevEl.innerHTML = '<div class="status-no-incidents animate-on-scroll">No previous incidents in the last 90 days.</div>';
    return;
  }

  const groups = {};
  previous.forEach((incident) => {
    const key = monthGroup(incident.date);
    groups[key] ??= [];
    groups[key].push(incident);
  });

  prevEl.replaceChildren();
  Object.entries(groups).forEach(([month, items]) => {
    const monthLabel = document.createElement('div');
    monthLabel.className = 'month-label animate-on-scroll';
    monthLabel.textContent = month;
    prevEl.appendChild(monthLabel);

    items.forEach((incident) => {
      const card = document.createElement('div');
      card.className = 'incident-card animate-on-scroll';

      const row = document.createElement('div');
      row.className = 'incident-row';

      const info = document.createElement('div');
      const title = document.createElement('div');
      title.className = 'incident-title';
      title.textContent = incident.title;
      const desc = document.createElement('div');
      desc.className = 'incident-desc';
      desc.textContent = incident.desc;
      const meta = document.createElement('div');
      meta.className = 'incident-meta';
      const metaParts = [document.createTextNode(prettyDate(incident.date))];
      if (incident.duration) {
        const sep = document.createElement('span');
        sep.className = 'meta-sep';
        sep.textContent = '·';
        const dur = document.createElement('span');
        dur.textContent = `Duration: ${incident.duration}`;
        meta.append(metaParts[0], sep, dur);
      } else {
        meta.appendChild(metaParts[0]);
      }
      info.append(title, desc, meta);

      const badge = document.createElement('span');
      badge.className = 'badge-resolved';
      badge.textContent = 'Resolved';

      row.append(info, badge);
      card.appendChild(row);
      prevEl.appendChild(card);
    });
  });
}

fetch('/assets/data/status.emeraldcore')
  .then((response) => response.text())
  .then((text) => {
    const data = JSON.parse(stripComments(text));
    renderHero(data.incidents);
    renderServices(data.services, data.uptimeDays);
    renderIncidents(data.incidents);
  })
  .catch((error) => {
    console.error('Failed to load status.emeraldcore:', error);
    const overallStatus = document.getElementById('overall-status');
    if (overallStatus) overallStatus.textContent = 'Status Unavailable';
  });
