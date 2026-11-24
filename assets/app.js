/* Rīga centre parking map — everything comes from the static files in /data. */
(function () {
  "use strict";

  const LATEST = "latest";
  const TYPE_LABEL = { "underground": "Underground", "multi-storey": "Multi-storey" };
  const TYPE_LETTER = { "underground": "U", "multi-storey": "M" };

  const state = {
    parkings: [],          // from parkings.json
    obsById: new Map(),    // parking_id -> observations sorted newest first
    dates: [],             // distinct observation dates, newest first
    selected: LATEST,
    markers: new Map(),    // parking_id -> L.Marker
  };

  // ---------- helpers ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const fmtDate = (iso) => {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB",
      { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  };

  function level(pct) {
    if (pct == null) return "lvl-none";
    if (pct < 60) return "lvl-low";
    if (pct <= 85) return "lvl-mid";
    return "lvl-high";
  }

  /** Minimal RFC 4180 CSV parser (handles quoted fields, commas and newlines in quotes). */
  function parseCSV(text) {
    const rows = [];
    let row = [], field = "", i = 0, quoted = false;
    text = text.replace(/^﻿/, "");
    while (i < text.length) {
      const c = text[i];
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') { field += '"'; i += 2; continue; }
        if (c === '"') { quoted = false; i++; continue; }
        field += c; i++; continue;
      }
      if (c === '"') { quoted = true; i++; continue; }
      if (c === ",") { row.push(field); field = ""; i++; continue; }
      if (c === "\n" || c === "\r") {
        row.push(field); field = "";
        if (row.some((v) => v.trim() !== "")) rows.push(row);
        row = [];
        i += (c === "\r" && text[i + 1] === "\n") ? 2 : 1;
        continue;
      }
      field += c; i++;
    }
    row.push(field);
    if (row.some((v) => v.trim() !== "")) rows.push(row);
    if (!rows.length) return [];
    const header = rows.shift().map((h) => h.trim());
    return rows.map((r) => Object.fromEntries(header.map((h, k) => [h, (r[k] ?? "").trim()])));
  }

  /** The observation that represents a parking for the currently selected date. */
  function readingFor(id) {
    const list = state.obsById.get(id) || [];
    if (state.selected === LATEST) return list[0] || null;
    return list.find((o) => o.date === state.selected) || null;   // newest time that day
  }

  function pctOf(p, obs) {
    return obs && p.capacity ? Math.round((obs.parked / p.capacity) * 100) : null;
  }

  // ---------- map ----------
  const map = L.map("map", { zoomControl: true }).setView([56.955, 24.125], 14);

  // Several basemaps: OSM's tile servers block some browsers/previews (403 "Access blocked"),
  // so there's always a keyless alternative one click away. The choice is remembered per browser.
  const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services";
  const basemaps = {
    "OpenStreetMap": L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      // OSM's tile usage policy requires a Referer; send the origin even under strict page policies.
      referrerPolicy: "strict-origin-when-cross-origin",
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }),
    "Esri Streets": L.tileLayer(`${ESRI}/World_Street_Map/MapServer/tile/{z}/{y}/{x}`, {
      maxZoom: 19,
      attribution: "Tiles &copy; Esri &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors",
    }),
    "Esri Satellite": L.tileLayer(`${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`, {
      maxZoom: 19,
      attribution: "Tiles &copy; Esri &mdash; Esri, Maxar, Earthstar Geographics",
    }),
  };
  const BASEMAP_KEY = "riga-parking:basemap";
  let saved = null;
  try { saved = localStorage.getItem(BASEMAP_KEY); } catch (_) { /* storage unavailable */ }
  const initial = basemaps[saved] ? saved : "OpenStreetMap";
  basemaps[initial].addTo(map);
  L.control.layers(basemaps, null, { position: "topright" }).addTo(map);
  map.on("baselayerchange", (e) => {
    try { localStorage.setItem(BASEMAP_KEY, e.name); } catch (_) { /* ignore */ }
  });

  // If OSM tiles fail outright (none load, several error), fall back to Esri automatically.
  (function autoFallback() {
    const osm = basemaps["OpenStreetMap"];
    let ok = 0, failed = 0;
    osm.on("tileload", () => { ok++; });
    osm.on("tileerror", () => {
      if (++failed >= 4 && ok === 0 && map.hasLayer(osm)) {
        map.removeLayer(osm);
        basemaps["Esri Streets"].addTo(map);
        console.warn("OpenStreetMap tiles failed to load; switched to Esri Streets.");
      }
    });
  })();

  function markerIcon(p, obs) {
    const lvl = level(pctOf(p, obs));
    const cls = `pk-marker ${p.type === "underground" ? "underground" : "multi"} ${lvl}`;
    return L.divIcon({
      className: "",
      html: `<div class="${cls}" title="${esc(p.name)}">${TYPE_LETTER[p.type] || "P"}</div>`,
      iconSize: [28, 28],
      iconAnchor: [14, 14],
      popupAnchor: [0, -14],
    });
  }

  function popupHTML(p) {
    const obs = readingFor(p.id);
    const pct = pctOf(p, obs);
    const all = state.obsById.get(p.id) || [];

    let reading;
    if (obs) {
      const free = p.capacity != null ? Math.max(p.capacity - obs.parked, 0) : null;
      reading = `
        <div class="reading ${level(pct)}">
          <div class="big">${obs.parked}${p.capacity ? ` / ${p.capacity}` : ""} cars
            ${pct != null ? `<span class="muted">· ${pct}%</span>` : ""}</div>
          <div class="when">${fmtDate(obs.date)}${obs.time ? ` at ${esc(obs.time)}` : ""}
            ${free != null ? ` · ${free} free` : ""}</div>
          ${pct != null ? `<div class="bar"><span style="width:${Math.min(pct, 100)}%"></span></div>` : ""}
          ${obs.note ? `<div class="when">${esc(obs.note)}</div>` : ""}
        </div>`;
    } else {
      const what = state.selected === LATEST ? "No observations yet." : `No observation on ${fmtDate(state.selected)}.`;
      reading = `<div class="reading lvl-none"><div class="when">${what}</div></div>`;
    }

    const history = all.length ? `
      <div class="history"><table>
        <thead><tr><th>Date</th><th>Time</th><th class="num">Parked</th><th class="num">%</th></tr></thead>
        <tbody>${all.map((o) => {
          const op = pctOf(p, o);
          return `<tr class="${o === obs ? "sel" : ""}" ${o.note ? `title="${esc(o.note)}"` : ""}>
            <td>${esc(o.date)}</td><td>${esc(o.time || "–")}</td>
            <td class="num">${o.parked}</td><td class="num">${op != null ? op + "%" : "–"}</td></tr>`;
        }).join("")}</tbody>
      </table></div>` : "";

    const sources = (p.sources || []).map((u, i) =>
      `<a href="${esc(u)}" target="_blank" rel="noopener">${i === 0 && u.includes("openstreetmap.org") ? "OSM" : "source " + (i + 1)}</a>`
    ).join(" · ");

    return `<div class="pp">
      <h2>${esc(p.name)}</h2>
      <p class="addr">${esc(p.address || "")}</p>
      <dl>
        <dt>Type</dt><dd>${esc(TYPE_LABEL[p.type] || p.type)}</dd>
        <dt>Capacity</dt><dd>${p.capacity != null ? p.capacity + " spaces" : '<span class="muted">unknown</span>'}</dd>
        ${p.operator ? `<dt>Operator</dt><dd>${esc(p.operator)}</dd>` : ""}
      </dl>
      ${reading}
      ${history}
      ${p.notes ? `<p class="sources muted">${esc(p.notes)}</p>` : ""}
      ${sources ? `<p class="sources">${sources}</p>` : ""}
    </div>`;
  }

  // ---------- side panel ----------
  const $select = document.getElementById("date-select");
  const $list = document.getElementById("list");
  const $summary = document.getElementById("summary");

  function renderSelect() {
    const opts = [`<option value="${LATEST}">Latest observation for each</option>`]
      .concat(state.dates.map((d) => `<option value="${d}">${fmtDate(d)}</option>`));
    $select.innerHTML = opts.join("");
    $select.value = state.selected;
  }

  function renderList() {
    let withData = 0, parked = 0, cap = 0;
    const items = state.parkings.map((p) => {
      const obs = readingFor(p.id);
      const pct = pctOf(p, obs);
      if (obs) {
        withData++;
        if (p.capacity) { parked += obs.parked; cap += p.capacity; }
      }
      const val = obs
        ? `${obs.parked}${p.capacity ? `<small>${pct}% of ${p.capacity}</small>` : "<small>cars</small>"}`
        : `<small>${p.capacity ? p.capacity + " spaces" : "–"}</small>`;
      return `<li><button type="button" data-id="${esc(p.id)}" class="${level(pct)}">
          <span class="name">${esc(p.name)}</span>
          <span class="val">${val}</span>
          <span class="meta">${esc(TYPE_LABEL[p.type] || p.type)} · ${esc(p.address || "")}</span>
        </button></li>`;
    });
    $list.innerHTML = items.join("");

    // A combined total only makes sense for one date, not for "latest" readings from different days.
    const single = state.selected !== LATEST;
    const scope = single ? fmtDate(state.selected) : "latest readings";
    $summary.textContent = `${state.parkings.length} car parks · ${withData} with data (${scope})` +
      (single && cap ? ` · ${parked} of ${cap} known spaces used (${Math.round((parked / cap) * 100)}%)` : "");
  }

  function renderMarkers() {
    for (const p of state.parkings) {
      const m = state.markers.get(p.id);
      m.setIcon(markerIcon(p, readingFor(p.id)));
      // Function content is re-evaluated by Leaflet on open/update, so it never goes stale.
      m.setPopupContent(() => popupHTML(p));
    }
  }

  function render() {
    renderList();
    renderMarkers();
  }

  $select.addEventListener("change", () => {
    state.selected = $select.value;
    render();
  });

  $list.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-id]");
    if (!btn) return;
    const m = state.markers.get(btn.dataset.id);
    // Jump without animation so the popup's auto-pan works from the final view.
    map.setView(m.getLatLng(), Math.max(map.getZoom(), 16), { animate: false });
    m.openPopup();
  });

  // ---------- load data ----------
  async function load() {
    const get = async (path, as) => {
      const r = await fetch(path, { cache: "no-cache" });
      if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
      return as === "json" ? r.json() : r.text();
    };
    const [parkings, csv, boundary] = await Promise.all([
      get("data/parkings.json", "json"),
      get("data/observations.csv", "text"),
      get("data/boundary.geojson", "json").catch(() => null),
    ]);

    if (boundary) {
      const layer = L.geoJSON(boundary, {
        interactive: false,
        style: { color: "#2557d6", weight: 2, dashArray: "6 6", fillColor: "#2557d6", fillOpacity: 0.04 },
      }).addTo(map);
      map.fitBounds(layer.getBounds(), { padding: [10, 10] });
    }

    state.parkings = parkings.slice().sort((a, b) => a.name.localeCompare(b.name, "lv"));
    const known = new Set(parkings.map((p) => p.id));
    const dates = new Set();
    for (const row of parseCSV(csv)) {
      const parked = Number.parseInt(row.parked, 10);
      if (!known.has(row.parking_id) || !/^\d{4}-\d{2}-\d{2}$/.test(row.date) ||
          !/^\d+$/.test(row.parked) || !Number.isFinite(parked)) {
        console.warn("Skipping invalid observation row", row);
        continue;
      }
      const o = { date: row.date, time: row.time || "", parked, note: row.note || "" };
      if (!state.obsById.has(row.parking_id)) state.obsById.set(row.parking_id, []);
      state.obsById.get(row.parking_id).push(o);
      dates.add(row.date);
    }
    const key = (o) => `${o.date}T${o.time || "99:99"}`;
    for (const list of state.obsById.values()) list.sort((a, b) => key(b).localeCompare(key(a)));
    state.dates = [...dates].sort().reverse();

    for (const p of state.parkings) {
      const m = L.marker([p.lat, p.lon], { icon: markerIcon(p, null), title: p.name, riseOnHover: true })
        .bindPopup(() => popupHTML(p), {
          maxWidth: 320,
          // Keep the popup inside short maps (phones); it scrolls instead of being clipped.
          maxHeight: Math.max(220, Math.round(map.getSize().y * 0.75)),
          autoPanPadding: [16, 16],
        })
        .addTo(map);
      state.markers.set(p.id, m);
    }

    renderSelect();
    render();
  }

  load().catch((err) => {
    console.error(err);
    $summary.innerHTML = `<strong>Could not load data.</strong> ${esc(err.message)}<br>` +
      "If you opened index.html directly from disk, serve the folder over HTTP instead " +
      "(e.g. <code>python3 -m http.server</code>).";
  });
})();
