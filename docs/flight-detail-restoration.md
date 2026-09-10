# Flight detail restoration

Flights use the existing smaller 1:50m display atlas again, addressing slow wide
flights on older phones. The existing settled 1:10m detail returns immediately
when the flight finishes or is interrupted. Manual dragging and zooming retain
full detail.

Only the displayed atlas selection changes. Hidden-geometry culling, viewport
clipping, the exact SVG writer, flat-map projection caches, non-scaling strokes,
and the earlier label/DOM optimizations remain in place. Both atlas levels use
the same optimized renderer. Flight timing and camera motion are unchanged.

## Paired benchmark

Compared against production build `c752cca`, using Playwright Chromium
145.0.7632.6 on an Apple M4 with 6× CPU throttling, mobile viewport 390 × 844 and
device pixel ratio 2. These are simulated CPU constraints, not physical-phone
measurements. Each build ran three repetitions of GBR → USA → CHN → USA → AUS →
GBR (15 measured flights), after the existing warm-up flights. Runs were
sequential and separate from verification.

| Workload | Full-detail flight FPS | Restored simplified-flight FPS |
| --- | ---: | ---: |
| USA → China | 6.59 | 17.43 |
| USA → Australia | 14.28 | 28.65 |
| All five routes combined | 14.74 | 27.02 |

The benchmark now accepts `ROUTES` so long flights can be checked directly:

```sh
ROUTES='GBR,USA,CHN,USA,AUS,GBR' node scripts/benchmark-flights.mjs BASELINE_DIST restoration-before 6 3 mobile
ROUTES='GBR,USA,CHN,USA,AUS,GBR' node scripts/benchmark-flights.mjs dist restoration-after 6 3 mobile
```

## Verification

The production build and flight-transition checks cover simplified geometry
during USA → China, and exact equality with the previous full-detail land,
coastline, and border paths initially, after landing, and after cancelling a
flight by zooming or starting a drag without moving. The flat-map verifier checks the selected atlas at both
detail levels against fresh D3 projection, including cache invalidation on resize.
The visual comparison uses an independent unculled reference for the selected
atlas; its assertions now require simplified detail only while a flight runs.

All 67 tested browser states, 10,182 visible-path comparisons, and 31 snapshot
pairs passed across desktop, mobile, and Mercator. All snapshot pairs were
pixel-identical, with no raster exceptions. The flat-map check covered 702,128
points within 0.000000707 CSS pixels of fresh projection.

```sh
node scripts/verify-flight-detail.mjs FULL_DETAIL_DIST dist
node scripts/verify-flat-geometry.mjs
node scripts/build-full-detail-reference.mjs
SCENARIOS=desktop,mobile,mercator FRESH_RASTER=1 SOFTWARE_RASTER=1 \
  CLIPPED_PATHS=1 IGNORE_OFFSCREEN_LABELS=1 \
  node scripts/verify-globe-rendering.mjs output/playwright/full-detail-reference-project/dist dist
```
