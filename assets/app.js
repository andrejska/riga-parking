/* Rīga centre parking map — everything comes from the static files in /data. */
(function () {
  "use strict";

  const LATEST = "latest";
  const TYPE_LABEL = { "underground": "Underground", "multi-storey": "Multi-storey", "covered": "Covered", "surface": "Surface lot" };
  const TYPE_LETTER = { "underground": "U", "multi-storey": "M", "covered": "C", "surface": "P" };

  // Open-air lots are hidden unless ?selected-parking-lots=1 (or the toggle) turns them on.
  const LOTS_PARAM = "selected-parking-lots";
  const lotsFromURL = () => {
    const v = new URLSearchParams(location.search).get(LOTS_PARAM);
    return v !== null && !["0", "false", "no", "off"].includes(v.toLowerCase());
  };

  const state = {
    showLots: lotsFromURL(),
    parkings: [],          // from parkings.json
    obsById: new Map(),    // parking_id -> observations sorted newest first
    dates: [],             // distinct observation dates, newest first
    selected: LATEST,
    markers: new Map(),    // parking_id -> L.Marker
    hoverId: null,         // hovered/focused in the list or on the map
    activeId: null,        // popup open
  };

  // ---------- helpers ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const fmtDate = (iso) => {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB",
      { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  };

  const utcDate = (iso) => {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  };
  const isoOf = (dt) => dt.toISOString().slice(0, 10);

  /** Gregorian Easter Sunday (anonymous algorithm) as a UTC date. */
  function easter(y) {
    const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
    const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(Date.UTC(y, month - 1, day));
  }

  /**
   * Latvian public holidays that fall on weekdays (Sunday holidays are weekends anyway).
   * May 4 and Nov 18 move to the next Monday when they fall on a weekend.
   * One-off days off declared by the government are not covered.
   */
  const holidayCache = new Map();
  function holidays(y) {
    if (holidayCache.has(y)) return holidayCache.get(y);
    const h = new Map();
    const add = (dt, name) => h.set(isoOf(dt), name);
    const on = (m, d, name) => add(new Date(Date.UTC(y, m - 1, d)), name);
    const movable = (m, d, name) => {
      const dt = new Date(Date.UTC(y, m - 1, d));
      const wd = dt.getUTCDay();
      add(dt, name);
      if (wd === 6 || wd === 0) add(new Date(dt.getTime() + (wd === 6 ? 2 : 1) * 864e5), `${name} (moved)`);
    };
    const e = easter(y).getTime();
    on(1, 1, "New Year's Day");
    add(new Date(e - 2 * 864e5), "Good Friday");
    add(new Date(e + 1 * 864e5), "Easter Monday");
    on(5, 1, "Labour Day");
    movable(5, 4, "Restoration of Independence Day");
    on(6, 23, "Midsummer Eve");
    on(6, 24, "Midsummer Day");
    movable(11, 18, "Proclamation Day");
    on(12, 24, "Christmas Eve");
    on(12, 25, "Christmas Day");
    on(12, 26, "Second Day of Christmas");
    on(12, 31, "New Year's Eve");
    holidayCache.set(y, h);
    return h;
  }

  /** Weekday and day type for a YYYY-MM-DD date: working day, weekend or public holiday. */
  function dayInfo(iso) {
    const dt = utcDate(iso);
    const weekday = dt.toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
    const short = weekday.slice(0, 3);
    const holiday = holidays(dt.getUTCFullYear()).get(iso);
    const wd = dt.getUTCDay();
    if (holiday) return { weekday, short, off: true, kind: "public holiday", label: `public holiday, ${holiday}` };
    if (wd === 0 || wd === 6) return { weekday, short, off: true, kind: "weekend", label: "weekend" };
    return { weekday, short, off: false, kind: "working day", label: "working day" };
  }

  const fmtDay = (iso) => `${dayInfo(iso).short} ${fmtDate(iso)}`;

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

  function accessLabel(access) {
    const known = { public: "Public", customers: "Customers only", private: "Private" };
    return known[access] ? esc(known[access]) : '<span class="muted">Not confirmed</span>';
  }

  const isVisible = (p) => p.type !== "surface" || state.showLots;

  // An observation records cars parked, free spaces, or both; derive the other from capacity.
  function parkedOf(p, obs) {
    if (!obs) return null;
    if (obs.parked != null) return obs.parked;
    return p.capacity && obs.free != null ? Math.max(p.capacity - obs.free, 0) : null;
  }

  function freeOf(p, obs) {
    if (!obs) return null;
    if (obs.free != null) return obs.free;
    return p.capacity && obs.parked != null ? Math.max(p.capacity - obs.parked, 0) : null;
  }

  function pctOf(p, obs) {
    const parked = parkedOf(p, obs);
    return parked != null && p.capacity ? Math.round((parked / p.capacity) * 100) : null;
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
    const cls = `pk-marker ${p.type} ${lvl}`;
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
      const parked = parkedOf(p, obs);
      const free = freeOf(p, obs);
      const big = parked != null
        ? `${parked}${p.capacity ? ` / ${p.capacity}` : ""} cars`
        : `${free} free`;
      const day = dayInfo(obs.date);
      reading = `
        <div class="reading ${level(pct)}">
          <div class="big">${big}
            ${pct != null ? `<span class="muted">· ${pct}%</span>` : ""}</div>
          ${parked != null && free != null ? `<div class="when">${free} free</div>` : ""}
          ${parked == null ? `<div class="when"><span title="Capacity unknown">Occupancy unknown</span></div>` : ""}
          ${pct != null ? `<div class="bar"><span style="width:${Math.min(pct, 100)}%"></span></div>` : ""}
          <dl class="counted">
            <dt>Counted</dt><dd>${esc(day.weekday)}, ${fmtDate(obs.date)}</dd>
            <dt>Time</dt><dd>${obs.time ? esc(obs.time) : '<span class="muted">not recorded</span>'}</dd>
            <dt>Day type</dt><dd><span class="daytype ${day.off ? "off" : "work"}">${esc(day.label)}</span></dd>
            ${obs.note ? `<dt>Note</dt><dd>${esc(obs.note)}</dd>` : ""}
          </dl>
        </div>`;
    } else {
      const what = state.selected === LATEST ? "No observations yet." : `No observation on ${fmtDate(state.selected)}.`;
      reading = `<div class="reading lvl-none"><div class="when">${what}</div></div>`;
    }

    const history = all.length ? `
      <div class="history"><table>
        <thead><tr><th>Date</th><th>Day</th><th>Time</th><th class="num">Parked</th><th class="num">Free</th><th class="num">%</th></tr></thead>
        <tbody>${all.map((o) => {
          const op = pctOf(p, o);
          const n = (v) => (v != null ? v : "–");
          const d = dayInfo(o.date);
          return `<tr class="${o === obs ? "sel" : ""}" ${o.note ? `title="${esc(o.note)}"` : ""}>
            <td>${esc(o.date)}</td>
            <td><span class="daytype ${d.off ? "off" : "work"}" title="${esc(d.weekday + ", " + d.label)}">${esc(d.short)}</span></td>
            <td>${esc(o.time || "–")}</td>
            <td class="num">${n(parkedOf(p, o))}</td><td class="num">${n(freeOf(p, o))}</td>
            <td class="num">${op != null ? op + "%" : "–"}</td></tr>`;
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
        <dt>Access</dt><dd>${accessLabel(p.access)}</dd>
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
      .concat(state.dates.map((d) => `<option value="${d}">${fmtDay(d)} (${dayInfo(d).kind})</option>`));
    $select.innerHTML = opts.join("");
    $select.value = state.selected;
  }

  function renderList() {
    let withData = 0, parked = 0, cap = 0;
    const shown = state.parkings.filter(isVisible);
    const items = shown.map((p) => {
      const obs = readingFor(p.id);
      const pct = pctOf(p, obs);
      const n = parkedOf(p, obs);
      if (obs) {
        withData++;
        if (p.capacity && n != null) { parked += n; cap += p.capacity; }
      }
      let val;
      if (!obs) val = `<small>${p.capacity ? p.capacity + " spaces" : "–"}</small>`;
      else if (n == null) val = `${freeOf(p, obs)}<small>free</small>`;
      else val = `${n}${p.capacity ? `<small>${pct}% of ${p.capacity}</small>` : "<small>cars</small>"}`;
      return `<li><button type="button" data-id="${esc(p.id)}" class="${level(pct)}">
          <span class="name">${esc(p.name)}</span>
          <span class="val">${val}</span>
          <span class="meta">${esc(TYPE_LABEL[p.type] || p.type)} · ${esc(p.address || "")}</span>
          ${obs ? `<span class="meta when">Counted ${esc(fmtDay(obs.date))}${obs.time ? `, ${esc(obs.time)}` : ""} · ${esc(dayInfo(obs.date).kind)}</span>` : ""}
        </button></li>`;
    });
    $list.innerHTML = items.join("");

    // A combined total only makes sense for one date, not for "latest" readings from different days.
    const single = state.selected !== LATEST;
    const scope = single ? `${fmtDay(state.selected)}, ${dayInfo(state.selected).kind}` : "latest readings";
    $summary.textContent = `${shown.length} car parks · ${withData} with data (${scope})` +
      (single && cap ? ` · ${parked} of ${cap} known spaces used (${Math.round((parked / cap) * 100)}%)` : "");
  }

  function renderMarkers() {
    for (const p of state.parkings) {
      const m = state.markers.get(p.id);
      if (!isVisible(p)) {
        m.remove();   // also closes its popup
        continue;
      }
      if (!map.hasLayer(m)) m.addTo(map);
      m.setIcon(markerIcon(p, readingFor(p.id)));
      // Function content is re-evaluated by Leaflet on open/update, so it never goes stale.
      m.setPopupContent(() => popupHTML(p));
    }
  }

  function render() {
    renderList();
    renderMarkers();
    applyHighlight();
  }

  // ---------- list <-> map highlighting ----------
  /** Mark the hovered and open car park in both the list and on the map. */
  function applyHighlight() {
    for (const [id, m] of state.markers) {
      const on = id === state.hoverId || id === state.activeId;
      m.getElement()?.querySelector(".pk-marker")?.classList.toggle("hl", on);
      m.setZIndexOffset(on ? 1000 : 0);
    }
    for (const btn of $list.querySelectorAll("button[data-id]")) {
      btn.classList.toggle("hl", btn.dataset.id === state.hoverId);
      btn.classList.toggle("active", btn.dataset.id === state.activeId);
    }
  }

  function setHover(id) {
    if (state.hoverId === id) return;
    state.hoverId = id;
    applyHighlight();
  }

  $list.addEventListener("mouseover", (e) => {
    const btn = e.target.closest("button[data-id]");
    setHover(btn ? btn.dataset.id : null);
  });
  $list.addEventListener("mouseleave", () => setHover(null));
  $list.addEventListener("focusin", (e) => {
    const btn = e.target.closest("button[data-id]");
    if (btn) setHover(btn.dataset.id);
  });
  $list.addEventListener("focusout", () => setHover(null));

  // ---------- soften the map outside the railway loop ----------
  /**
   * A full-viewport element in its own pane (above tiles, below the boundary line and markers),
   * blurred with backdrop-filter and clipped to "viewport minus boundary polygon" (even-odd).
   * Repositioned on every move; during zoom animation it is scaled like Leaflet's own overlays.
   */
  function addOutsideMask(boundary) {
    if (!(window.CSS && CSS.supports("clip-path", 'path(evenodd, "M0 0H1V1Z")'))) return;
    const rings = [];
    L.geoJSON(boundary).eachLayer((layer) => {
      const lls = layer.getLatLngs();
      // Polygon -> [ring...]; MultiPolygon -> [[ring...]...]; we only need the outer rings.
      (Array.isArray(lls[0][0]) ? lls.map((poly) => poly[0]) : [lls[0]]).forEach((r) => rings.push(r));
    });
    if (!rings.length) return;

    map.createPane("outside");
    map.getPane("outside").style.zIndex = 250;
    const el = L.DomUtil.create("div", "outside-mask leaflet-zoom-animated", map.getPane("outside"));

    const PAD = 64; // px margin around the viewport, so clip edges never show inside it

    function update() {
      const size = map.getSize();
      const origin = map.containerPointToLayerPoint([0, 0]);
      L.DomUtil.setPosition(el, origin);
      el.style.width = `${size.x}px`;
      el.style.height = `${size.y}px`;
      // Clip the boundary to the (padded) viewport first. When zoomed in, the raw polygon spans
      // tens of thousands of pixels, and browsers then mis-render the even-odd hole (the whole
      // view turned blurry). Clipped, coordinates stay small at every zoom level.
      const view = L.bounds([-PAD, -PAD], [size.x + PAD, size.y + PAD]);
      const holes = rings.map((ring) => {
        const pts = ring.map((ll) => map.latLngToLayerPoint(ll).subtract(origin));
        const clipped = L.PolyUtil.clipPolygon(pts, view);
        return clipped.length < 3 ? "" :
          "M" + clipped.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join("L") + "Z";
      }).join("");
      el.style.clipPath = `path(evenodd, "M0 0H${size.x}V${size.y}H0Z${holes}")`;
    }

    map.on("move zoomend viewreset resize", update);
    map.on("zoomanim", (e) => {
      // Same technique as L.ImageOverlay: animate to where the top-left corner will be.
      const scale = map.getZoomScale(e.zoom);
      const offset = map._latLngToNewLayerPoint(map.containerPointToLatLng([0, 0]), e.zoom, e.center);
      L.DomUtil.setTransform(el, offset, scale);
    });
    update();
  }

  $select.addEventListener("change", () => {
    state.selected = $select.value;
    render();
  });

  const $lots = document.getElementById("lots-toggle");
  $lots.checked = state.showLots;
  $lots.addEventListener("change", () => {
    state.showLots = $lots.checked;
    // Keep the URL shareable: the parameter is present only while the lots are shown.
    const url = new URL(location.href);
    if (state.showLots) url.searchParams.set(LOTS_PARAM, "1");
    else url.searchParams.delete(LOTS_PARAM);
    history.replaceState(history.state, "", url);
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
        style: { color: "#2557d6", weight: 2, dashArray: "6 6", fill: false },
      }).addTo(map);
      map.fitBounds(layer.getBounds(), { padding: [10, 10] });
      addOutsideMask(boundary);
    }

    state.parkings = parkings.slice().sort((a, b) => a.name.localeCompare(b.name, "lv"));
    const known = new Set(parkings.map((p) => p.id));
    const dates = new Set();
    // "" -> null (not recorded), digits -> number, anything else -> NaN (invalid row).
    const count = (v) => (!v ? null : /^\d+$/.test(v) ? Number.parseInt(v, 10) : NaN);
    for (const row of parseCSV(csv)) {
      const parked = count(row.parked);
      const free = count(row.free);
      if (!known.has(row.parking_id) || !/^\d{4}-\d{2}-\d{2}$/.test(row.date) ||
          Number.isNaN(parked) || Number.isNaN(free) || (parked == null && free == null)) {
        console.warn("Skipping invalid observation row", row);
        continue;
      }
      const o = { date: row.date, time: row.time || "", parked, free, note: row.note || "" };
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
        .on("mouseover", () => setHover(p.id))
        .on("mouseout", () => setHover(null))
        .on("popupopen", () => {
          state.activeId = p.id;
          applyHighlight();
          $list.querySelector(`button[data-id="${CSS.escape(p.id)}"]`)?.scrollIntoView({ block: "nearest" });
        })
        .on("popupclose", () => {
          if (state.activeId === p.id) state.activeId = null;
          applyHighlight();
        });
      state.markers.set(p.id, m);   // added to the map by renderMarkers() if visible
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
