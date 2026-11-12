// Frontend logic for gpsdash — polls the dashboard server for the GPS/NTP status it relays from the agent.

const POLL_INTERVAL_MS = 2000;
const OFFSET_HISTORY_WINDOW_MS = 15 * 60 * 1000; // the offset graph keeps the last 15 minutes
const MAX_OFFSET_HISTORY = OFFSET_HISTORY_WINDOW_MS / POLL_INTERVAL_MS;

const FIX_MODE_LABELS = { 0: "Unknown", 1: "No fix", 2: "2D fix", 3: "3D fix" };

const offsetHistory = []; // offsets in ms, oldest first
const offsetTimes = []; // poll timestamps (ms since epoch), parallel to offsetHistory

// The server owns the offset history (so a reload shows the whole window at once, and every viewer sees the same one);
// the page only keeps a copy to draw. Each poll sends the newest sample we hold (historySeq) and the server run it came
// from (historyEpoch), and gets back only the newer samples.
let historySeq = 0;
let historyEpoch = null;

function applyHistory(h) {
  if (h.reset) {
    offsetHistory.length = 0;
    offsetTimes.length = 0;
  }
  const now = Date.now();
  for (const sample of h.samples) {
    offsetHistory.push(sample.offsetMs);
    offsetTimes.push(now - sample.ageMs); // the server sends ages, so its clock and ours never get mixed
  }
  while (offsetHistory.length > MAX_OFFSET_HISTORY) {
    offsetHistory.shift();
    offsetTimes.shift();
  }
  historySeq = h.seq;
  historyEpoch = h.epoch;
}

// Graph view options, remembered per browser. Defaults: log-spaced time axis and a symmetric-log value axis
// (the "Value" and "Time" toggles switch either one to linear).
// The value axis used to default to linear, and a saved copy of that old default is indistinguishable from a deliberate
// choice, so a saved value-axis choice only counts when it was written with v: 2 (the log default); older ones are ignored.
const graphMode = { yLog: true, tLog: true };
try {
  const saved = JSON.parse(localStorage.getItem("gpsdash.graphMode") || "null");
  if (saved) {
    graphMode.yLog = saved.v === 2 ? saved.yLog !== false : true;
    graphMode.tLog = saved.tLog !== false;
  }
} catch (e) {
  // localStorage unavailable (private mode etc.): keep the defaults
}
function saveGraphMode() {
  try {
    localStorage.setItem("gpsdash.graphMode", JSON.stringify({ ...graphMode, v: 2 }));
  } catch (e) {
    // ignore: the choice just won't persist
  }
}

// Altitude unit, remembered per browser. Default: feet. Clicking the altitude value switches between feet and meters.
const FEET_PER_METER = 3.28084;
let altUnit = "ft";
try {
  const savedUnit = localStorage.getItem("gpsdash.altUnit");
  if (savedUnit === "ft" || savedUnit === "m") altUnit = savedUnit;
} catch (e) {
  // localStorage unavailable (private mode etc.): keep the default
}
function saveAltUnit() {
  try {
    localStorage.setItem("gpsdash.altUnit", altUnit);
  } catch (e) {
    // ignore: the choice just won't persist
  }
}

// The agent reports altitude in meters (alt_m); feet are shown whole, since GPS height is only good to a few meters.
function fmtAltitude(meters) {
  if (meters === undefined || meters === null) return "—";
  return altUnit === "ft" ? `${Math.round(meters * FEET_PER_METER)} ft` : `${meters.toFixed(1)} m`;
}

// A clock disciplined by a GPS pulse is off by nanoseconds or a few microseconds, so the unit follows the size of the
// number: ns below 1 µs, µs below 1 ms, ms above (a 40 µs offset must not read "0.0 ms"). Sizes are judged after
// rounding, so 999.6 ns reads "1.0 µs", never "1000 ns".
function fmtOffset(seconds) {
  if (seconds === undefined || seconds === null) return "—";
  const ns = Math.abs(seconds) * 1e9;
  let text;
  if (Math.round(ns) < 1000) text = `${Math.round(ns)} ns`;
  else if (Number((ns / 1e3).toFixed(1)) < 1000) text = `${(ns / 1e3).toFixed(1)} µs`;
  else text = `${(ns / 1e6).toFixed(1)} ms`;
  return seconds < 0 && text !== "0 ns" ? `-${text}` : text;
}

function fmtCoord(value, digits = 5) {
  if (value === undefined || value === null) return "—";
  return value.toFixed(digits);
}

function statusDot(level, label) {
  return `<span class="status-dot status-${level}" aria-hidden="true"></span><span>${label}</span>`;
}

// The usual six-level HDOP scale (lower is better). The dot has five colours: Ideal is blue, then green for Excellent and
// Good, then yellow, orange and red.
function hdopStatus(hdop) {
  if (hdop === undefined || hdop === null) return { level: "critical", label: "No HDOP data" };
  const value = hdop.toFixed(2);
  if (hdop < 1) return { level: "ideal", label: `Ideal (HDOP ${value})` };
  if (hdop < 2) return { level: "good", label: `Excellent (HDOP ${value})` };
  if (hdop < 5) return { level: "good", label: `Good (HDOP ${value})` };
  if (hdop < 10) return { level: "warning", label: `Moderate (HDOP ${value})` };
  if (hdop < 20) return { level: "serious", label: `Fair (HDOP ${value})` };
  return { level: "critical", label: `Poor (HDOP ${value})` };
}

let lastGps = null; // the newest GPS reading, so a unit change can redraw at once without waiting for the next poll

function renderGps(gps) {
  lastGps = gps;
  const el = document.getElementById("gps-panel");
  const oldAltButton = document.getElementById("alt-toggle"); // kept across redraws, see below
  const altHadFocus = oldAltButton !== null && document.activeElement === oldAltButton;
  if (!gps) {
    el.innerHTML = "<p class='error'>No GPS data</p>";
    return;
  }
  const hdopStat = hdopStatus(gps.hdop);
  const hasAltitude = gps.alt_m !== undefined && gps.alt_m !== null;
  const otherUnit = altUnit === "ft" ? "meters" : "feet";
  const altitudeCell = hasAltitude
    ? `<button type="button" id="alt-toggle" class="unit-toggle" title="Click to show ${otherUnit}" aria-label="Altitude ${fmtAltitude(gps.alt_m)}. Click to show ${otherUnit}">${fmtAltitude(gps.alt_m)}</button>`
    : "—";
  el.innerHTML = `
    <dl>
      <dt>Fix</dt><dd>${FIX_MODE_LABELS[gps.mode] ?? "Unknown"}</dd>
      <dt>Quality</dt><dd class="status-line">${statusDot(hdopStat.level, hdopStat.label)}</dd>
      <dt>Satellites</dt><dd>${gps.satellites_used ?? "—"} used / ${gps.satellites_visible ?? "—"} visible</dd>
      <dt>Position</dt><dd>${fmtCoord(gps.lat)}, ${fmtCoord(gps.lon)}</dd>
      <dt>Altitude</dt><dd>${altitudeCell}</dd>
    </dl>
  `;
  // The panel is redrawn every 2 s. If the altitude button were a new element each time, a click whose press and release
  // straddle a redraw would be lost, so the existing button is put back in place (with the new text) instead.
  const newAltButton = document.getElementById("alt-toggle");
  if (oldAltButton && newAltButton) {
    oldAltButton.textContent = newAltButton.textContent;
    oldAltButton.title = newAltButton.title;
    oldAltButton.setAttribute("aria-label", newAltButton.getAttribute("aria-label"));
    newAltButton.replaceWith(oldAltButton);
    if (altHadFocus) oldAltButton.focus();
  }
}

// The panel is redrawn on every poll, so the click is caught on the panel itself (it survives the redraws).
function wireAltitudeToggle() {
  const el = document.getElementById("gps-panel");
  if (!el) return;
  el.addEventListener("click", (event) => {
    if (!event.target.closest("#alt-toggle")) return;
    altUnit = altUnit === "ft" ? "m" : "ft";
    saveAltUnit();
    renderGps(lastGps);
    if (event.detail === 0) document.getElementById("alt-toggle")?.focus(); // keyboard use: keep the focus on the button
  });
}

function renderNtp(ntp, sources) {
  const el = document.getElementById("ntp-panel");
  if (!ntp) {
    el.innerHTML = "<p class='error'>No NTP data</p>";
    return;
  }
  // chrony can be locked to GPS either through the serial time (source "GPS") or, with a PPS board, through the pulse
  // (source "PPS", with "GPS" then only labelling the second and shown as unusable). Either one selected counts.
  const gpsSelected = (sources || []).find((s) => (s.name === "PPS" || s.name === "GPS") && s.state === "selected");
  const disciplineStat = !gpsSelected
    ? { level: "warning", label: "No — using network NTP" }
    : gpsSelected.name === "PPS"
      ? { level: "good", label: "Yes — GPS pulse (PPS)" }
      : { level: "good", label: "Yes — GPS serial time (no PPS)" };
  el.innerHTML = `
    <dl>
      <dt>Reference</dt><dd>${escapeHtml(ntp.reference_name)} (stratum ${escapeHtml(ntp.stratum)})</dd>
      <dt>System offset</dt><dd>${fmtOffset(ntp.system_offset_seconds)}</dd>
      <dt>Leap status</dt><dd>${escapeHtml(ntp.leap_status)}</dd>
      <dt>GPS-disciplined</dt><dd class="status-line">${statusDot(disciplineStat.level, disciplineStat.label)}</dd>
    </dl>
  `;
}

// Plain-English wording for chrony's source states (the hover text explains each one). The raw state stays on the row's
// CSS class, so styling is unchanged.
const SOURCE_STATE_TEXT = {
  selected: ["selected", "The source chrony is steering the clock from right now"],
  combined: ["blended in", "A good source chrony averages in with the selected one"],
  not_combined: ["backup, not used", "Healthy and reachable, but not blended in: the selected source is far more precise"],
  rejected: ["rejected (disagrees)", "chrony thinks this source is wrong because it disagrees with the others"],
  too_variable: ["too jittery", "Its measurements swing too much to trust"],
  unusable: ["unusable", "chrony cannot use this source: unreachable, failing a check, or set not to be selected"],
};

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// A network server shows its DNS name when the server found one (the IP address stays in the hover text); otherwise the IP.
function sourceNameCell(s) {
  if (!s.hostname) return `<td>${escapeHtml(s.name)}</td>`;
  return `<td title="${escapeHtml(s.name)}">${escapeHtml(s.hostname)}</td>`;
}

function sourceStateCell(s, ppsSelected) {
  if (s.name === "GPS" && s.state === "unusable" && ppsSelected) {
    return `<td title="chrony reads the GPS serial time only to tell PPS which second each pulse belongs to; it never steers the clock from it">label only (by design)</td>`;
  }
  const [text, hint] = SOURCE_STATE_TEXT[s.state] || [escapeHtml(s.state), ""]; // an unknown state is shown as plain text
  return `<td${hint ? ` title="${hint}"` : ""}>${text}</td>`;
}

function renderSources(sources) {
  const el = document.getElementById("sources-panel");
  if (!sources || sources.length === 0) {
    el.innerHTML = "<p class='error'>No source data</p>";
    return;
  }
  const ppsSelected = sources.some((x) => x.name === "PPS" && x.state === "selected");
  // chrony lists reference clocks in config-file order (GPS before PPS). Show the pulse first, then GPS, then the network
  // servers; the sort is stable, so everything else keeps the order chrony reported.
  const rank = (s) => (s.name === "PPS" ? 0 : s.name === "GPS" ? 1 : 2);
  const ordered = [...sources].sort((a, b) => rank(a) - rank(b));
  const numbers = (s) => [String(s.stratum), fmtOffset(s.adjusted_offset_seconds), fmtOffset(s.estimated_error_seconds)];
  // The page redraws every poll, and a browser only shows a hover tooltip if the element under the pointer stays put. So
  // when the same sources are listed in the same states, only the numbers are updated in place; the table is rebuilt only
  // when a source, its name or its state changes.
  const signature = ordered.map((s) => [s.name, s.hostname || "", s.state, sourceStateCell(s, ppsSelected)].join("|")).join("\n");
  const existing = el.querySelector("table");
  if (existing && existing.dataset.signature === signature) {
    existing.querySelectorAll("tbody tr").forEach((tr, i) => {
      numbers(ordered[i]).forEach((text, n) => {
        const cell = tr.children[n + 2];
        if (cell.textContent !== text) cell.textContent = text;
      });
    });
    return;
  }
  const rows = ordered
    .map(
      (s) => `
      <tr class="state-${escapeHtml(s.state)}">
        ${sourceNameCell(s)}
        ${sourceStateCell(s, ppsSelected)}
        ${numbers(s).map((text) => `<td>${escapeHtml(text)}</td>`).join("")}
      </tr>`
    )
    .join("");
  el.innerHTML = `
    <table>
      <thead><tr><th>Source</th><th>State</th><th>Stratum</th><th>Offset</th><th>Est. error</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
  el.querySelector("table").dataset.signature = signature;
}

const SKY_SIZE = 220;

// Constellations, from gpsd's gnssid. Each is identified TWICE, by a COLOUR and by a marker SHAPE, so it stays legible
// without colour vision; the satellite's STATE is shown by the fill style instead:
// solid = used in the fix, translucent = signal heard but not used, dashed ring = no signal.
const CONSTELLATIONS = {
  0: { name: "GPS", color: "#3987e5", shape: "circle" },
  1: { name: "SBAS", color: "#f0e442", shape: "square" },
  2: { name: "Galileo", color: "#00b58a", shape: "triangle-down" },
  3: { name: "BeiDou", color: "#ee6a2c", shape: "hexagon" },
  4: { name: "IMES", color: "#b0b0b0", shape: "pentagon" },
  5: { name: "QZSS", color: "#cc79a7", shape: "diamond" },
  6: { name: "GLONASS", color: "#e69f00", shape: "triangle" },
  7: { name: "NavIC", color: "#56b4e9", shape: "plus" },
};
const UNKNOWN_CONSTELLATION = { name: null, color: "#8b98a5", shape: "circle" }; // older agent, or a gnssid we don't know

function constellationOf(s) {
  return CONSTELLATIONS[s.gnssid] || UNKNOWN_CONSTELLATION;
}

// Corners of a regular n-gon around (cx, cy); rotDeg 0 puts one corner straight up.
function polygonPoints(cx, cy, r, n, rotDeg) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = ((rotDeg + (360 / n) * i) * Math.PI) / 180;
    pts.push(`${(cx + r * Math.sin(a)).toFixed(1)},${(cy - r * Math.cos(a)).toFixed(1)}`);
  }
  return pts.join(" ");
}

// One marker, centred on (x, y). Sizes are tuned so every shape has a similar visual weight.
function shapeMarkup(shape, x, y, size, attrs, inner = "") {
  const poly = (points) => `<polygon points="${points}" ${attrs}>${inner}</polygon>`;
  switch (shape) {
    case "square": {
      const half = size * 0.9;
      return `<rect x="${(x - half).toFixed(1)}" y="${(y - half).toFixed(1)}" width="${(half * 2).toFixed(1)}" height="${(half * 2).toFixed(1)}" ${attrs}>${inner}</rect>`;
    }
    case "diamond":
      return poly(polygonPoints(x, y, size * 1.28, 4, 0));
    case "triangle":
      return poly(polygonPoints(x, y, size * 1.55, 3, 0));
    case "triangle-down":
      return poly(polygonPoints(x, y, size * 1.55, 3, 180));
    case "hexagon":
      return poly(polygonPoints(x, y, size * 1.11, 6, 0));
    case "pentagon":
      return poly(polygonPoints(x, y, size * 1.16, 5, 0));
    case "plus": {
      const a = size * 0.45;
      const b = size * 1.3;
      const pts = [[-a, -b], [a, -b], [a, -a], [b, -a], [b, a], [a, a], [a, b], [-a, b], [-a, a], [-b, a], [-b, -a], [-a, -a]];
      return poly(pts.map(([dx, dy]) => `${(x + dx).toFixed(1)},${(y + dy).toFixed(1)}`).join(" "));
    }
    default:
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${size}" ${attrs}>${inner}</circle>`;
  }
}

// Sort satellites into the groups the plot and legend show, so the legend always adds up to the total.
//  - used:       in the position fix
//  - unused:     above the horizon, signal heard, but not used in the fix
//  - noSignal:   above the horizon, but no signal heard (SNR 0/unknown), e.g. a geostationary satellite not being tracked
//  - below:      a valid position, below the horizon
//  - noPosition: gpsd knows the satellite exists but has no position for it (it reports az 0, el -999)
function classifySatellites(satellites) {
  const g = { used: [], unused: [], noSignal: [], below: [], noPosition: [] };
  for (const s of satellites) {
    const valid =
      Number.isFinite(s.el) && Number.isFinite(s.az) && s.el >= -90 && s.el <= 90 && s.az >= 0 && s.az <= 360;
    if (!valid) g.noPosition.push(s);
    else if (s.el < 0) g.below.push(s);
    else if (s.used) g.used.push(s);
    else if (s.ss > 0) g.unused.push(s);
    else g.noSignal.push(s);
  }
  return g;
}

// "QZSS 193, 194; PRN 12": PRNs grouped under their constellation name (or plain "PRN" when the constellation is unknown).
function describeSatellites(sats) {
  const groups = new Map();
  for (const s of sats) {
    const key = constellationOf(s).name || "PRN";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s.prn);
  }
  return [...groups].map(([key, prns]) => `${key} ${escapeHtml(prns.join(", "))}`).join("; ");
}

// One line under the legend: how many satellites of each constellation are used, out of those listed.
function constellationSummary(satellites) {
  if (!satellites.some((s) => CONSTELLATIONS[s.gnssid])) return "";
  const byId = new Map();
  for (const s of satellites) {
    const id = CONSTELLATIONS[s.gnssid] ? s.gnssid : 99;
    const entry = byId.get(id) || { c: CONSTELLATIONS[id] || { name: "Other", color: UNKNOWN_CONSTELLATION.color, shape: "circle" }, total: 0, used: 0 };
    entry.total += 1;
    if (s.used) entry.used += 1;
    byId.set(id, entry);
  }
  const items = [...byId.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(
      ([, e]) =>
        `<span title="${e.used} of ${e.total} used in the fix"><svg class="shape-icon" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">${shapeMarkup(e.c.shape, 6, 6, 4, `style="fill:${e.c.color}"`)}</svg> ${e.c.name} ${e.used}/${e.total}</span>`
    );
  return `<div class="legend legend-constellations" aria-label="Satellites by constellation, used out of listed">${items.join("")}<span class="sky-hint">used / listed</span></div>`;
}

function renderSkyPlot(satellites) {
  const el = document.getElementById("sky-plot");
  if (!satellites || satellites.length === 0) {
    el.innerHTML = "<p class='error'>No satellite data</p>";
    return;
  }
  const cx = SKY_SIZE / 2;
  const cy = SKY_SIZE / 2;
  const r = SKY_SIZE / 2 - 14;
  const rings = [30, 60].map((elDeg) => {
    const ringR = r * (1 - elDeg / 90);
    return `<circle cx="${cx}" cy="${cy}" r="${ringR.toFixed(1)}" class="sky-ring" />`;
  }).join("");
  const groups = classifySatellites(satellites);
  const dotFor = (s, cls) => {
    const radius = r * (1 - s.el / 90);
    const azRad = (s.az * Math.PI) / 180;
    const x = cx + radius * Math.sin(azRad);
    const y = cy - radius * Math.cos(azRad);
    const c = constellationOf(s);
    const snr = s.ss !== null && s.ss !== undefined && s.ss > 0 ? `${s.ss.toFixed(0)} dB` : "no signal";
    const svid = s.svid !== undefined && s.svid !== null && s.svid !== s.prn ? ` (sv ${s.svid})` : "";
    const who = c.name ? `${c.name} · PRN ${s.prn}${svid}` : `PRN ${s.prn}`;
    const title = `<title>${escapeHtml(who)} · el ${s.el.toFixed(0)}° · az ${s.az.toFixed(0)}° · ${snr}${s.used ? " · used in fix" : ""}</title>`;
    return shapeMarkup(c.shape, x, y, 5, `class="${cls}" style="--sat:${c.color}"`, title);
  };
  // Not-used dots go underneath the used ones, so a used satellite is never hidden behind a grey one.
  const dots =
    groups.noSignal.map((s) => dotFor(s, "sky-dot-nosignal")).join("") +
    groups.unused.map((s) => dotFor(s, "sky-dot-unused")).join("") +
    groups.used.map((s) => dotFor(s, "sky-dot-used")).join("");
  const legendItem = (cls, label, sats) => `<span><i class="dot ${cls}"></i> ${label} (${sats.length})</span>`;
  const notes = [];
  if (groups.noPosition.length) notes.push(`No position reported: ${describeSatellites(groups.noPosition)}`);
  if (groups.below.length) notes.push(`Below the horizon: ${describeSatellites(groups.below)}`);
  el.innerHTML = `
    <svg viewBox="0 0 ${SKY_SIZE} ${SKY_SIZE}" class="sky-svg" role="img" aria-label="Satellite sky view, North at top">
      <circle cx="${cx}" cy="${cy}" r="${r}" class="sky-horizon" />
      ${rings}
      <text x="${cx}" y="12" class="sky-label" text-anchor="middle">N</text>
      <text x="${SKY_SIZE - 4}" y="${cy + 4}" class="sky-label" text-anchor="end">E</text>
      <text x="${cx}" y="${SKY_SIZE - 4}" class="sky-label" text-anchor="middle">S</text>
      <text x="4" y="${cy + 4}" class="sky-label" text-anchor="start">W</text>
      ${dots}
    </svg>
    <div class="legend legend-states">
      ${legendItem("dot-used", "Used", groups.used)}
      ${legendItem("dot-unused", "Not used", groups.unused)}
      ${groups.noSignal.length ? legendItem("dot-nosignal", "No signal", groups.noSignal) : ""}
      ${groups.below.length ? legendItem("dot-below", "Below horizon", groups.below) : ""}
      ${groups.noPosition.length ? legendItem("dot-noposition", "No position", groups.noPosition) : ""}
    </div>
    ${constellationSummary(satellites)}
    ${notes.length ? `<div class="sky-note">${notes.join(" · ")}</div>` : ""}
  `;
}


// ---- Clock-offset graph -----------------------------------------------------------------
const GRAPH = { w: 320, h: 128, padL: 46, padR: 8, padT: 10, padB: 18 };
const LOG_Y_FLOOR_MS = 0.0001; // symmetric-log: values within ~100 ns of zero stay roughly linear (PPS-disciplined clock)
const LOG_T_TAU_S = 8; // log time axis: the newest seconds get the most room
const TIME_TICKS = [
  [0, "now"],
  [10, "-10s"],
  [60, "-1m"],
  [300, "-5m"],
  [900, "-15m"],
];

// Symmetric log: keeps the sign, handles zero, and compresses large offsets so µs and ms both stay visible.
const symlog = (ms) => Math.sign(ms) * Math.log10(1 + Math.abs(ms) / LOG_Y_FLOOR_MS);

function fmtTickMs(ms) {
  if (ms === 0) return "0";
  const a = Math.abs(ms);
  const sign = ms > 0 ? "+" : "-";
  const n = (x) => String(Number(x.toFixed(1))); // whole numbers stay whole; a 2.5 µs tick keeps its decimal
  if (a < 0.001) return `${sign}${n(a * 1e6)}ns`;
  if (a < 1) return `${sign}${n(a * 1000)}µs`;
  if (a < 1000) return `${sign}${n(a)}ms`;
  return `${sign}${n(a / 1000)}s`;
}

function gridLine(y, cls) {
  const { w, padL, padR } = GRAPH;
  return `<line x1="${padL}" x2="${w - padR}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" class="${cls}" />`;
}

function tickLabel(y, text) {
  return `<text x="${GRAPH.padL - 5}" y="${(y + 3).toFixed(1)}" text-anchor="end" class="sparkline-tick">${text}</text>`;
}

// Both value axes are symmetric around zero and zoom to the data, so a PPS-disciplined clock (offsets of a few µs or ns)
// stays readable on either one. They differ in how values are spread and in how the limit is chosen: the log axis steps by
// decades (never tighter than ±1 µs), the linear axis by 1-2-5 steps (never tighter than ±100 ns) so the line fills the graph.
function maxAbsOf(values) {
  return Math.max(...values.map(Math.abs), 0);
}

function valueAxisLimit(values) {
  const maxAbs = maxAbsOf(values);
  let topExp = -3; // never zoom in past ±1 µs
  while (Math.pow(10, topExp) < maxAbs && topExp < 4) topExp++;
  return { top: Math.pow(10, topExp), topExp };
}

// The smallest 1, 2 or 5 times a power of ten that covers the biggest offset (at least 100 ns).
function niceLimit(maxAbs) {
  const m = Math.max(maxAbs, 1e-4);
  const base = Math.pow(10, Math.floor(Math.log10(m)));
  for (const f of [1, 2, 5, 10]) if (f * base >= m * 0.9999) return f * base;
  return 10 * base;
}

// Value axis, linear: evenly spaced between -top and +top, ticks at 0, ±top/2 and ±top.
function linearValueAxis(values) {
  const { h, padT, padB } = GRAPH;
  const top = niceLimit(maxAbsOf(values));
  const plotH = h - padT - padB;
  const toY = (v) => padT + (1 - (Math.max(-top, Math.min(top, v)) + top) / (2 * top)) * plotH;
  let grid = gridLine(toY(0), "sparkline-zero") + tickLabel(toY(0), "0");
  for (const f of [0.5, 1]) {
    for (const sign of [1, -1]) {
      grid += gridLine(toY(sign * f * top), "sparkline-grid");
      grid += tickLabel(toY(sign * f * top), fmtTickMs(sign * f * top));
    }
  }
  return { toY, grid };
}

// Value axis, symmetric log: zero in the middle, decade ticks (±1 µs, ±10 µs, ±100 µs, ±1 ms, ...) each side.
function logValueAxis(values) {
  const { h, padT, padB } = GRAPH;
  const { top, topExp } = valueAxisLimit(values);
  const yMax = symlog(top);
  const plotH = h - padT - padB;
  const toY = (v) => padT + (1 - (symlog(Math.max(-top, Math.min(top, v))) + yMax) / (2 * yMax)) * plotH;
  let grid = gridLine(toY(0), "sparkline-zero") + tickLabel(toY(0), "0");
  for (let k = -4; k <= topExp; k++) {
    const v = Math.pow(10, k);
    const labelled = k >= -3; // the ±100 ns lines are minor: drawn, but not labelled
    for (const s of [1, -1]) {
      grid += gridLine(toY(s * v), "sparkline-grid");
      if (labelled) grid += tickLabel(toY(s * v), fmtTickMs(s * v));
    }
  }
  return { toY, grid };
}

// Time axis, linear: one fixed step per poll, fills left to right until the window is full, then scrolls.
function linearTimeAxis(count) {
  const { w, h, padL, padR } = GRAPH;
  const stepX = (w - padL - padR) / (MAX_OFFSET_HISTORY - 1);
  const toX = (i) => padL + i * stepX;
  const spanSeconds =
    count >= MAX_OFFSET_HISTORY ? OFFSET_HISTORY_WINDOW_MS / 1000 : Math.round(((count - 1) * POLL_INTERVAL_MS) / 1000);
  const spanLabel =
    spanSeconds >= 60 ? `${Math.floor(spanSeconds / 60)}m${spanSeconds % 60 ? ` ${spanSeconds % 60}s` : ""}` : `${spanSeconds}s`;
  const lastX = toX(count - 1);
  const labels =
    (spanSeconds > 0 ? `<text x="${padL}" y="${h - 4}" text-anchor="start" class="sparkline-tick">-${spanLabel}</text>` : "") +
    (lastX - padL >= 45 ? `<text x="${lastX.toFixed(1)}" y="${h - 4}" text-anchor="end" class="sparkline-tick">now</text>` : "");
  return { toX, grid: "", labels, spanText: spanLabel, inWindow: () => true };
}

// Time axis, log: the newest sample sits at the right edge while data is arriving; the last seconds are spread out and
// the minutes before are squeezed to the left, so 15 minutes fit in the same width. The axis is fixed at the full window.
// While the source is silent the axis is anchored to the present instead, so the last known value slides left and a
// yellow line can be held out to the right edge.
function logTimeAxis(times, anchorT) {
  const { w, h, padL, padR, padT, padB } = GRAPH;
  const plotW = w - padL - padR;
  const windowS = OFFSET_HISTORY_WINDOW_MS / 1000;
  const denom = Math.log10(1 + windowS / LOG_T_TAU_S);
  const xForAge = (ageS) => padL + (1 - Math.min(1, Math.log10(1 + Math.max(0, ageS) / LOG_T_TAU_S) / denom)) * plotW;
  const ageOf = (i) => (anchorT - times[i]) / 1000;
  const toX = (i) => xForAge(ageOf(i));
  let grid = "";
  let labels = "";
  for (const [ageS, text] of TIME_TICKS) {
    if (ageS > windowS) continue;
    const x = xForAge(ageS);
    grid += `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${padT}" y2="${h - padB}" class="sparkline-grid" />`;
    const anchor = ageS === 0 ? "end" : ageS >= windowS ? "start" : "middle";
    labels += `<text x="${x.toFixed(1)}" y="${h - 4}" text-anchor="${anchor}" class="sparkline-tick">${text}</text>`;
  }
  return { toX, grid, labels, spanText: `${Math.round(windowS / 60)}m`, inWindow: (i) => ageOf(i) <= windowS, xNow: xForAge(0), xLeft: padL };
}

function fmtDuration(ms) {
  const sec = Math.round(ms / 1000);
  if (sec < 90) return `${sec} s`;
  const min = Math.round(sec / 60);
  if (min < 90) return `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

// Yellow means "no data was arriving from the source": a stretch of at least GAP_MIN_S with no sample is bridged by a
// yellow line, and while the newest sample is older than SILENT_AFTER_MS the last known value is held out to "now" in
// yellow. Everything else, including samples the server restored from disk, is drawn as normal data.
const GAP_MIN_S = 10;
const SILENT_AFTER_MS = 10000;

function renderOffsetSparkline() {
  const el = document.getElementById("offset-sparkline");
  const n = offsetHistory.length;
  if (n < 1) {
    el.innerHTML = "<p class='muted'>Collecting data…</p>";
    return;
  }
  const { w, h } = GRAPH;
  const now = Date.now();
  const silentMs = now - offsetTimes[n - 1];
  const silent = silentMs > SILENT_AFTER_MS;
  const yAxis = graphMode.yLog ? logValueAxis(offsetHistory) : linearValueAxis(offsetHistory);
  const xAxis = graphMode.tLog ? logTimeAxis(offsetTimes, silent ? now : offsetTimes[n - 1]) : linearTimeAxis(n);
  const at = (i) => `${xAxis.toX(i).toFixed(1)},${yAxis.toY(offsetHistory[i]).toFixed(1)}`;

  // stretches with no data: between sample i-1 and sample i
  const gaps = [];
  for (let i = 1; i < n; i++) {
    if ((offsetTimes[i] - offsetTimes[i - 1]) / 1000 > GAP_MIN_S) gaps.push(i);
  }
  // the grey line: runs of samples between gaps (only the part inside the axis window)
  const runs = [];
  let from = 0;
  for (const g of [...gaps, n]) {
    const pts = [];
    for (let i = from; i < g; i++) if (xAxis.inWindow(i)) pts.push(at(i));
    if (pts.length > 1) runs.push(pts);
    from = g;
  }
  // the yellow line: a bridge over each gap, and the held last value while the source is silent
  const yellow = [];
  for (const g of gaps) {
    if (!xAxis.inWindow(g)) continue; // the whole gap is older than the axis
    const before = xAxis.inWindow(g - 1) ? at(g - 1) : `${xAxis.xLeft},${yAxis.toY(offsetHistory[g - 1]).toFixed(1)}`; // clipped at the left edge
    yellow.push([before, at(g)]);
  }
  if (silent && graphMode.tLog && xAxis.inWindow(n - 1)) {
    yellow.push([at(n - 1), `${xAxis.xNow.toFixed(1)},${yAxis.toY(offsetHistory[n - 1]).toFixed(1)}`]);
  }
  const shownGaps = gaps.filter((g) => xAxis.inWindow(g));

  const lastIdx = n - 1;
  const last = offsetHistory[lastIdx];
  const min = Math.min(...offsetHistory);
  const max = Math.max(...offsetHistory);
  // Each number picks its own unit (offsets are in ms here), so a 108 ns "now" never reads "0.0 µs" just because
  // the 15-minute range reaches microseconds.
  const cap = (ms) => fmtOffset(ms / 1000);
  let note = "";
  if (silent) {
    note = `No data from the agent for ${fmtDuration(silentMs)} · yellow shows the last known value`;
  } else if (shownGaps.length) {
    const g = shownGaps[shownGaps.length - 1];
    note = `Yellow: no data for ${fmtDuration(offsetTimes[g] - offsetTimes[g - 1])}${shownGaps.length > 1 ? ` (latest of ${shownGaps.length} gaps)` : ""}`;
  }
  const aria =
    `System clock offset over the last ${xAxis.spanText}; ` +
    `value axis ${graphMode.yLog ? "logarithmic" : "linear"}, time axis ${graphMode.tLog ? "logarithmic" : "linear"}` +
    (silent ? "; the source is silent, the yellow line holds the last known value" : shownGaps.length ? "; yellow marks stretches with no data" : "");
  el.innerHTML = `
    <svg viewBox="0 0 ${w} ${h}" class="sparkline-svg" role="img" aria-label="${aria}">
      ${yAxis.grid}
      ${xAxis.grid}
      ${xAxis.labels}
      ${runs.map((pts) => `<polyline points="${pts.join(" ")}" class="sparkline-line" />`).join("")}
      ${yellow.map((seg) => `<polyline points="${seg.join(" ")}" class="sparkline-line-gap" />`).join("")}
      <circle cx="${xAxis.toX(lastIdx).toFixed(1)}" cy="${yAxis.toY(last).toFixed(1)}" r="4" class="${silent ? "sparkline-dot-stale" : "sparkline-dot"}" />
    </svg>
    <div class="sparkline-caption">${cap(last)} ${silent ? "at the last sample" : "now"} · range ${cap(min)} to ${cap(max)}</div>
    ${note ? `<div class="sparkline-stale-note">${note}</div>` : ""}
  `;
}

function updateGraphControls() {
  for (const [id, key, name] of [["toggle-y", "yLog", "Value"], ["toggle-t", "tLog", "Time"]]) {
    const btn = document.getElementById(id);
    if (!btn) continue;
    btn.textContent = `${name}: ${graphMode[key] ? "log" : "linear"}`;
    btn.setAttribute("aria-pressed", graphMode[key] ? "true" : "false");
  }
}

function wireGraphControls() {
  for (const [id, key] of [["toggle-y", "yLog"], ["toggle-t", "tLog"]]) {
    const btn = document.getElementById(id);
    if (!btn) continue;
    btn.addEventListener("click", () => {
      graphMode[key] = !graphMode[key];
      saveGraphMode();
      updateGraphControls();
      renderOffsetSparkline();
    });
  }
  updateGraphControls();
}

let polling = false;
// A request that never completes (a connection that died while the laptop slept, a stalled network) would otherwise keep
// `polling` true for good: no more polls, no banner, and the graph would never show the silence. So each poll is given up after this long.
const POLL_TIMEOUT_MS = 10000;

async function poll() {
  if (polling) return; // skip this tick if the previous request is still in flight
  polling = true;
  const banner = document.getElementById("error-banner");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POLL_TIMEOUT_MS);
  try {
    const res = await fetch(`/api/status?since=${historySeq}&epoch=${historyEpoch === null ? "" : historyEpoch}`, {
      signal: controller.signal,
    });
    const data = await res.json();
    if (data.history) applyHistory(data.history); // the server keeps the offset history; the page only draws it (an error reply carries it too)
    if (!res.ok) throw new Error(data.error || "unknown error");
    banner.hidden = true;
    renderGps(data.gps);
    renderNtp(data.ntp, data.sources);
    renderSources(data.sources);
    renderSkyPlot(data.gps && data.gps.satellites);
  } catch (err) {
    const why = err.name === "AbortError" ? "the server did not answer in time" : err.message;
    banner.textContent = `Could not load status: ${why}`;
    banner.hidden = false;
  } finally {
    clearTimeout(timer);
    polling = false;
    renderOffsetSparkline(); // also when nothing arrived: the graph then shows the silence
  }
}

wireGraphControls();
wireAltitudeToggle();
poll();
setInterval(poll, POLL_INTERVAL_MS);
