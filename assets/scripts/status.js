document.getElementById('current-year').textContent = new Date().getFullYear();
document.getElementById('update-time').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function parseDMY(str) {
    var parts = str.split('-').map(Number);
    return new Date(parts[2], parts[1] - 1, parts[0]);
}

function localKey(date) {
    var y = date.getFullYear();
    var m = String(date.getMonth() + 1).padStart(2, '0');
    var d = String(date.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + d;
}

function prettyDate(str) {
    return parseDMY(str).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function monthGroup(str) {
    return parseDMY(str).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function stripComments(text) {
    return text.split('\n').map(function (line) {
        return line.replace(/^\s*\/\/.*$/, '');
    }).join('\n');
}

function toggleCard(id) {
    var body    = document.getElementById('body-' + id);
    var chevron = document.getElementById('chevron-' + id);
    if (!body || !chevron) return;
    var open = body.classList.contains('open');
    body.classList.toggle('open', !open);
    chevron.classList.toggle('open', !open);
}

function calcUptime(serviceId, uptimeDays) {
    var today    = new Date();
    var window90 = new Date(today);
    window90.setDate(today.getDate() - 90);
    var badDays = (uptimeDays[serviceId] || []).filter(function (e) {
        var d = parseDMY(e.date);
        return d >= window90 && d <= today;
    }).length;
    var pct = (91 - badDays) / 91 * 100;
    return pct % 1 === 0 ? pct.toFixed(0) + '%' : pct.toFixed(1) + '%';
}

function detectStatus(serviceId, uptimeDays) {
    var today   = localKey(new Date());
    var entries = uptimeDays[serviceId] || [];
    var hit     = entries.find(function (e) { return localKey(parseDMY(e.date)) === today; });
    return hit ? hit.type : 'operational';
}

function statusBadge(status) {
    var map = {
        operational: { cls: 'badge-operational', dot: 'dot-operational', label: 'Operational' },
        degraded:    { cls: 'badge-degraded',    dot: 'dot-degraded',    label: 'Degraded'    },
        outage:      { cls: 'badge-outage',      dot: 'dot-outage',      label: 'Outage'      }
    };
    var b = map[status] || map.operational;
    return '<span class="status-badge ' + b.cls + '"><span class="badge-dot ' + b.dot + '"></span> ' + b.label + '</span>';
}

function buildBar(serviceId, uptimeDays) {
    var bar = document.getElementById('bar-' + serviceId);
    if (!bar) return;
    bar.innerHTML = '';

    var today       = new Date();
    var incidentMap = {};
    (uptimeDays[serviceId] || []).forEach(function (e) {
        incidentMap[localKey(parseDMY(e.date))] = e.type;
    });

    for (var i = 0; i <= 90; i++) {
        var daysAgo = 90 - i;
        var segDate = new Date(today);
        segDate.setDate(today.getDate() - daysAgo);
        var key  = localKey(segDate);
        var type = incidentMap[key] || '';

        var seg = document.createElement('div');
        seg.className = 'uptime-bar-seg' + (type ? ' ' + type : '');

        var tt = document.createElement('div');
        tt.className = 'seg-tooltip';
        if (daysAgo === 0) {
            tt.textContent = 'Today';
        } else if (daysAgo === 1) {
            tt.textContent = 'Yesterday';
        } else {
            tt.textContent = segDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' (' + daysAgo + ' days ago)';
        }
        seg.appendChild(tt);
        bar.appendChild(seg);
    }
}

function renderServices(services, uptimeDays) {
    var container = document.getElementById('services-list');
    container.innerHTML = services.map(function (svc) {
        var status = detectStatus(svc.id, uptimeDays);
        var dotCls = 'dot-' + status;
        var uptime = calcUptime(svc.id, uptimeDays);
        var rows   = svc.items.map(function (item) {
            return '<div class="service-row">' +
                '<span class="service-row-name"><span class="badge-dot ' + dotCls + '"></span> ' + item.name + '</span>' +
                '<span class="service-uptime-label">' + uptime + ' uptime</span>' +
                '</div>';
        }).join('');

        return '<div class="status-card animate-on-scroll">' +
            '<div class="status-card-header" onclick="toggleCard(\'' + svc.id + '\')">' +
                '<span class="status-card-title">' + svc.name + '</span>' +
                '<div style="display:flex;align-items:center;gap:0.5rem;">' +
                    statusBadge(status) +
                    '<svg class="chevron" id="chevron-' + svc.id + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>' +
                '</div>' +
            '</div>' +
            '<div class="status-card-body" id="body-' + svc.id + '">' +
                rows +
                '<div class="uptime-bar-wrap">' +
                    '<div class="uptime-bar" id="bar-' + svc.id + '"></div>' +
                    '<div class="uptime-bar-labels"><span>90 days ago</span><span>Today</span></div>' +
                '</div>' +
            '</div>' +
        '</div>';
    }).join('');

    services.forEach(function (svc) { buildBar(svc.id, uptimeDays); });
}

function renderHero(incidents) {
    var hasActive = incidents.some(function (i) { return i.currentIncident === true; });
    var icon      = document.getElementById('hero-icon');
    var title     = document.getElementById('overall-status');
    if (hasActive) {
        icon.className = 'status-hero-icon outage';
        icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>';
        title.textContent = 'Partial Outage';
    } else {
        icon.className = 'status-hero-icon operational';
        icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
        title.textContent = 'All Systems Operational';
    }
}

function renderIncidents(incidents) {
    var sorted   = incidents.slice().sort(function (a, b) { return parseDMY(b.date) - parseDMY(a.date); });
    var current  = sorted.filter(function (i) { return i.currentIncident === true; });
    var previous = sorted.filter(function (i) { return i.currentIncident !== true; });

    var labelEl   = document.getElementById('label-current');
    var currentEl = document.getElementById('current-incidents-list');
    if (current.length > 0) {
        labelEl.style.display = '';
        currentEl.innerHTML = current.map(function (inc) {
            return '<div class="incident-card current animate-on-scroll">' +
                '<div class="incident-row">' +
                    '<div>' +
                        '<div class="incident-title">' + inc.title + '</div>' +
                        '<div class="incident-desc">'  + inc.desc  + '</div>' +
                        '<div class="incident-meta">Ongoing · since ' + prettyDate(inc.date) + '</div>' +
                    '</div>' +
                    '<span class="badge-ongoing">Ongoing</span>' +
                '</div>' +
            '</div>';
        }).join('');
    }

    var prevEl = document.getElementById('previous-incidents-list');
    if (previous.length === 0) {
        prevEl.innerHTML = '<div class="status-no-incidents animate-on-scroll">No previous incidents in the last 90 days.</div>';
        return;
    }

    var groups = {};
    previous.forEach(function (inc) {
        var key = monthGroup(inc.date);
        if (!groups[key]) groups[key] = [];
        groups[key].push(inc);
    });

    prevEl.innerHTML = Object.entries(groups).map(function (entry) {
        var month = entry[0];
        var items = entry[1];
        var cards = items.map(function (inc) {
            var meta = [
                '<span>' + prettyDate(inc.date) + '</span>',
                inc.duration ? '<span class="meta-sep">·</span><span>Duration: ' + inc.duration + '</span>' : ''
            ].filter(Boolean).join('');
            return '<div class="incident-card animate-on-scroll">' +
                '<div class="incident-row">' +
                    '<div>' +
                        '<div class="incident-title">' + inc.title + '</div>' +
                        '<div class="incident-desc">'  + inc.desc  + '</div>' +
                        '<div class="incident-meta">'  + meta      + '</div>' +
                    '</div>' +
                    '<span class="badge-resolved">Resolved</span>' +
                '</div>' +
            '</div>';
        }).join('');
        return '<div class="month-label animate-on-scroll">' + month + '</div>' + cards;
    }).join('');
}

fetch('/assets/data/status.emeraldcore')
    .then(function (r) { return r.text(); })
    .then(function (text) {
        var data = JSON.parse(stripComments(text));
        renderHero(data.incidents);
        renderServices(data.services, data.uptimeDays);
        renderIncidents(data.incidents);
    })
    .catch(function (err) {
        console.error('Failed to load status.emeraldcore:', err);
        document.getElementById('overall-status').textContent = 'Status Unavailable';
    });
