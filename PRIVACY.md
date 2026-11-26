# Privacy

Threesmith runs on your machine and sends nothing anywhere.

- It reads the files of the project you point it at, and the installed `three` package, to answer lookups and reviews.
- The browser check starts a local web server on `127.0.0.1` (random port) that serves only the folder you give it, and
  a local headless Chromium. The page may load whatever its own code loads (for example a CDN).
- It writes screenshots, baselines, diffs, the undo journal and project hints under `.threesmith/` in the project
  folder.
- It learns on this machine only, in `$THREESMITH_HOME` (default `~/.threesmith`), readable only by you: findings you
  marked as false alarms (hashes and counters), lessons you kept (scrubbed of names, paths and code), and for
  `three_dream` a few counters: API names that were looked up and not found, console messages nothing explained (as
  scrubbed templates), which tools had their writes undone, and how many sessions started. No code, file names or
  paths. `THREESMITH_LEARN=0` turns all of it off.
- No telemetry, no accounts. One network call of its own, and only when you ask for it: comparing your page with
  another three.js release (`three_compare`) runs `npm view three versions` and `npm pack three@<version>` with your
  own npm, registry and proxy settings, and keeps the release in `$THREESMITH_HOME/three/`. Nothing about your
  project is sent. A release that is already there, or a folder you point it at, needs no network.
