# Rīga centre parking

**Live map: https://andrejska.github.io/riga-parking/**

A map of underground, multi-storey and covered car parks in central Rīga,
inside the railway loop. Click a car park to see its capacity and how many
cars were parked there on the dates you recorded.

The map dims and blurs everything outside the loop. Hovering a car park in
the list highlights its marker on the map, and hovering a marker highlights
its row in the list.

It's a static site with no build step, backend or database. The data is two
plain files that you edit by hand.

```
index.html              the page
assets/app.js           map + popup logic (Leaflet, loaded from unpkg)
assets/style.css
data/parkings.json      the car parks: location, type, capacity, …
data/observations.csv   occupancy counts: one row per car park per date/time
data/boundary.geojson   the railway-loop outline drawn on the map
scripts/validate.py     checks the data files (Python 3, standard library only)
```

## Run it locally

Browsers block `fetch()` from `file://`, so serve the folder over HTTP:

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

## Host it

Any static host works: copy the folder as it is.

- **GitHub Pages:** push the repo, then go to *Settings → Pages → Deploy from
  a branch* and pick `main` / root. `.nojekyll` is already included.
- **Netlify, Cloudflare Pages, S3, nginx, …:** upload the folder. No build
  command is needed.

## Recording occupancy

Add one line to `data/observations.csv` per count:

```csv
parking_id,date,time,parked,note
jekaba-arkade,2026-11-24,09:30,212,weekday morning
galleria-riga,2026-11-24,17:45,118,"rain, pre-Christmas"
```

| column       | required | format                                                        |
|--------------|----------|---------------------------------------------------------------|
| `parking_id` | yes      | an `id` from `parkings.json`                                  |
| `date`       | yes      | `YYYY-MM-DD`                                                  |
| `time`       | no       | `HH:MM` in 24-hour time; leave empty if unknown               |
| `parked`     | yes      | whole number of cars                                          |
| `note`       | no       | free text; put it in quotes if it contains a comma            |

You can edit the file in a spreadsheet as long as you save it back as CSV
with the same header.

The **"Show occupancy on"** selector lists every date that has at least one
observation:

- **Latest observation for each** colours each car park by its most recent count.
- **A specific date** shows only that day's counts. If a car park has several
  counts that day, the latest time is used. Car parks with no count that day
  turn grey.

Marker colour is the share of capacity in use: green under 60%, amber
60–85%, red over 85%, grey when there's no count or the capacity is unknown.
The popup shows the full history for that car park.

## Adding or editing a car park

Add an object to `data/parkings.json`:

```json
{
  "id": "my-new-parking",
  "name": "Display name",
  "type": "underground",
  "address": "Street 1",
  "lat": 56.95,
  "lon": 24.11,
  "capacity": 150,
  "operator": "EuroPark",
  "access": "public",
  "sources": ["https://www.openstreetmap.org/way/123"],
  "notes": ""
}
```

- `id` must be lowercase-with-dashes and unique. Observations refer to it, so
  don't change it once you've recorded counts.
- `type` is `underground` (round **U** marker), `multi-storey` (**M**) or
  `covered` (**C**, a roofed car park at ground level, e.g. under a building).
- `capacity` is a whole number, or `null` if unknown.
- `access` is `public`, `customers` or `private`. Anything else, such as
  `unconfirmed`, shows as "Not confirmed" in the popup.
- Coordinates: right-click a spot on openstreetmap.org and choose
  *Show address*, or copy them from Google Maps.

## Check before committing

```sh
python3 scripts/validate.py
```

The script reports these as **errors**: unknown ids, bad dates or times,
negative counts and a wrong header.

It reports these as **warnings**: a count above capacity, duplicate
observations and a car park outside the boundary.

## About the starting data

11 of the car parks come from OpenStreetMap features tagged
`amenity=parking` + `parking=underground|multi-storey` with public or customer
access. Each one was matched to an address. Private residential and hotel-guest
garages were left out.

Six more were added by hand:

- **BTA Daugava Athletics Arena** (Augšiela 1). Its operator (LNSC) describes
  covered parking on part of the arena's ground floor, near the service
  entrance, and publishes no space count.
- **Radisson Blu Hotel Latvija**: underground, entrance from Baznīcas iela 7.
- **Radisson Blu Elizabete Hotel**: underground, entrance from Elizabetes
  iela 73, operated by SNABB.
- **Barona centrs** (Krišjāņa Barona iela 46): the shopping centre's
  underground car park, operated by SNABB.
- **VERDE office complex** (Roberta Hirša iela 1, Skanste): underground,
  operated by SNABB. SNABB's surface car park at the same address is left out.
- **Radisson Blu Rīdzene** (Reimersa iela 1): underground, entrance from
  Kalpaka bulvāris, operated by SNABB. It used to be for hotel guests only.

**Capacity is known for only 4 of the 17**, and each entry's `notes` and
`sources` say where the figure came from:

| car park            | capacity | source                                         |
|---------------------|---------:|------------------------------------------------|
| Kongresu nams       |      317 | rigassatiksme.lv (operator)                    |
| Jēkaba Arkāde       |      300 | OpenStreetMap `capacity` tag                   |
| Marijas iela 2      |      270 | neighborhood.lv article (not operator-confirmed) |
| Galleria Riga       |    ~120 | galleriariga.lv ("about 120 spaces")           |

The rest are `null`. Fill them in when you find an operator figure or count
the spaces yourself.

OSM may also miss some facilities, for example a car park inside a shopping
centre that is only mapped as a building. Add those by hand.

`observations.csv` starts empty, with only the header row.

### The boundary

`boundary.geojson` was generated from OpenStreetMap railway and river
geometry. It follows:

1. the Daugava centreline, from Eksportosta down to the railway bridge;
2. the railway bridge;
3. the line through Rīga Central station to Zemitāni;
4. the Zemitāni–Skulte line north to the junction near Brasa;
5. the Čiekurkalns–Rīga Krasta freight branch west to Eksportosta.

This covers Vecrīga, Centrs, Avoti, Grīziņkalns, Skanste,
Pētersala-Andrejsala and part of Brasa. The boundary is only drawn on the
map. It doesn't filter anything, apart from the warning in `validate.py`.

## Basemaps

Use the layer button (top right of the map) to switch between three
basemaps. None of them needs an API key.

- **OpenStreetMap** is the default.
- **Esri Streets** and **Esri Satellite** are alternatives.

The page remembers your choice in this browser.

OpenStreetMap's tile servers sometimes return **403 "Access blocked"**. This
happens when the request has no proper `Referer` header, typically in some
embedded previews or with strict privacy settings. If you see it, switch to
Esri Streets. If OSM tiles fail completely, the page switches to Esri
Streets by itself.

## Attribution

Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright)
contributors, ODbL. Esri basemap tiles © Esri and its data providers. OSM's
tile servers are fine for a low-traffic personal site. For heavier use,
change the tile URLs in `assets/app.js` to a commercial tile provider.

## License

All rights reserved. The source is public so you can read it and contribute
to it. You may fork it only to prepare pull requests to this repository. Any
other use needs prior written permission, including hosting, redistribution,
screenshots, presentations, public display and embedding the map. To ask,
[open an issue](https://github.com/andrejska/riga-parking/issues/new). By submitting
a contribution, you license it to the project owner. See [LICENSE](LICENSE)
for the full terms.

The OpenStreetMap-derived data (`data/boundary.geojson` and the OSM-sourced
entries in `data/parkings.json`) is not covered by this. It stays under the
[ODbL](https://opendatacommons.org/licenses/odbl/), © OpenStreetMap
contributors.
