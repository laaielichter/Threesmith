// Writes docs/library.html: every asset of the library on one page, with filters per category and family and a search
// in English or Dutch words. The pictures are the three.js renders in docs/library/<category>--<family>.jpg (made by
// scripts/library-sheets.mjs): one sheet per family, 6 cells per row, shown as CSS sprites and loaded only when they
// come into view. The assets and titles come from the code, so the page cannot drift from what the tool builds.
//   npm run build && node scripts/library-sheets.mjs && node scripts/library-page.mjs
import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { libraryOverview, loadAssetLibrary } from "../dist/library/library.js";

const COLS = 6;
const docs = (name) => fileURLToPath(new URL(`../docs/${name}`, import.meta.url));
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const all = [...loadAssetLibrary().values()];
const overview = libraryOverview();
const total = all.length;
const CATEGORY = { furniture: "Furniture", street: "Street furniture", storage: "Storage and industry", nature: "Nature", buildings: "Buildings", vehicles: "Vehicles", props: "Props" };
const nice = (family) => family.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
const short = (text) => (text.split(/(?<=\.)\s/)[0] ?? text).replace(/\s*It faces \+z\.?$/, "");

let pictures = 0;
const cards = [];
for (const c of overview) {
  for (const f of c.families) {
    const members = all.filter((a) => a.category === c.category && a.family === f.family).sort((a, b) => a.id.localeCompare(b.id));
    const sheet = `library/${c.category}--${f.family}.jpg`;
    const hasSheet = existsSync(docs(sheet));
    const rows = Math.ceil(members.length / COLS);
    members.forEach((a, i) => {
      const x = (((i % COLS) / (COLS - 1)) * 100).toFixed(3);
      const y = rows > 1 ? ((Math.floor(i / COLS) / (rows - 1)) * 100).toFixed(3) : "0";
      if (hasSheet) pictures++;
      const words = `${a.title} ${a.id} ${a.tags.join(" ")} ${a.archetype}`.toLowerCase();
      const sprite = hasSheet ? `<div class="sprite" role="img" aria-label="${esc(a.title)}, rendered by three.js" data-sheet="${sheet}" data-size="${COLS * 100}% ${rows * 100}%" data-pos="${x}% ${y}%"></div>` : `<div class="sprite"></div>`;
      cards.push(`<article class="model-card" data-id="${esc(a.id)}" data-category="${c.category}" data-family="${esc(f.family)}" data-words="${esc(words)}"><div class="model-picture">${sprite}</div><div class="model-info"><span>${esc(CATEGORY[c.category])} · ${esc(nice(f.family))}</span><h3>${esc(a.title)}</h3><p>${esc(short(a.description))}</p><code>model build ${esc(a.id)}</code></div></article>`);
    });
  }
}
const buttons = [`<button type="button" aria-pressed="true" data-filter="all">All ${total}</button>`, ...overview.map((c) => `<button type="button" aria-pressed="false" data-filter="${c.category}">${esc(CATEGORY[c.category])} ${c.count}</button>`)].join("");
const families = Object.fromEntries(overview.map((c) => [c.category, c.families.map((f) => ({ id: f.family, title: nice(f.family), count: f.count }))]));

const page = `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${total} 3D base models for three.js, built from code | Threesmith</title>
<meta name="description" content="${total} ready-made, parametric 3D base models for three.js: furniture, street furniture, storage, nature, buildings, vehicles and props. Each builds a clean .glb and passes the model lint; agents build them by id or start their own from the spec.">
<link rel="canonical" href="https://laaielichter.github.io/Threesmith/library.html">
<link rel="icon" href="favicon.svg" type="image/svg+xml">
<meta name="theme-color" content="#faf8f3">
<meta property="og:title" content="${total} 3D base models for three.js, built from code">
<meta property="og:description" content="The Threesmith asset library: parametric .glb base models a coding agent can build, change and check. Rendered by three.js.">
<meta property="og:url" content="https://laaielichter.github.io/Threesmith/library.html">
<meta property="og:image" content="https://laaielichter.github.io/Threesmith/assets/social.jpg">
<meta name="twitter:card" content="summary_large_image">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;600&display=swap">
<link rel="stylesheet" href="site.css">
<link rel="stylesheet" href="assets/studio.css">
<style>
.library-tools { display: grid; gap: 14px; margin: 26px 0 30px; }
.library-tools input[type="search"] { width: 100%; font: inherit; font-size: .95rem; padding: 13px 18px; border-radius: 30px; border: 1px solid #d5cbbb; background: #fffaf3; color: #28252e; }
.library-tools input[type="search"]:focus-visible { outline: 2px solid #836a98; outline-offset: 2px; }
.library-tools .gallery-filters { margin: 0; }
.family-chips { display: flex; flex-wrap: wrap; gap: 7px; }
.family-chips[hidden] { display: none; }
.family-chips button { background: transparent; border: 1px solid #e0d6c8; border-radius: 30px; padding: 5px 12px; color: #85717c; font-size: .7rem; cursor: pointer; }
.family-chips button[aria-pressed="true"] { border-color: #28252e; color: #28252e; }
.model-grid { grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); }
.model-card { content-visibility: auto; contain-intrinsic-size: auto 380px; }
.model-picture .sprite { width: 100%; aspect-ratio: 4 / 3; background-color: #f1ece4; background-repeat: no-repeat; }
.model-info h3 { font-size: 1.05rem; }
.empty { color: #85717c; padding: 40px 0; }
</style>
</head>
<body>
<header class="top"><div class="wrap">
  <a class="brand" href="./"><img src="logo.svg" alt="" width="30" height="30">Threesmith</a>
  <nav class="links">
    <a href="./#how">How it works</a>
    <a class="opt" href="models.html">Models</a>
    <a class="opt" href="library.html" aria-current="page">Library</a>
    <a href="install.html">Install</a>
    <a class="gh" href="https://github.com/laaielichter/Threesmith">GitHub</a>
  </nav>
</div></header>
<div class="hero" style="padding-bottom:10px"><div class="wrap" style="display:block">
  <span class="eyebrow">The asset library · ${total} base models · .glb</span>
  <h1>${total} base models. Every one checked.</h1>
  <p class="lead">Parametric specs that build a clean <code>.glb</code>: UVs, textures, a node per part, pivots on hinges and hubs. An agent builds one by its id with <code>three_model_build</code>, changes its parameters, or copies the spec as the start of its own model. Each passes the model lint and the check against what it is. Search in English or Dutch. Every picture below is three.js itself, loading the built file with GLTFLoader.</p>
  <pre class="cfg" style="background:#070b10;color:#d6dee6;border:1px solid var(--line);border-radius:12px;padding:14px 16px;overflow:auto">npx threesmith model library "oak chair"
npx threesmith model build furniture/dining-chair-oak-ladder --param seatHeight=0.5 -o public/models/chair.glb
npx threesmith model library furniture/dining-chair-oak-ladder --spec > my-chair.json</pre>
</div></div>
<section><div class="wrap">
  <div class="library-tools">
    <input id="q" type="search" placeholder="Search ${total} models: oak chair, rode bank, pine tree, container ..." aria-label="Search the asset library" autocomplete="off">
    <div class="gallery-filters" role="group" aria-label="Filter by category">${buttons}<span id="gallery-count" role="status">${total} models</span></div>
    <div class="family-chips" id="family-chips" role="group" aria-label="Filter by family" hidden></div>
  </div>
  <div class="model-grid" id="grid">
${cards.join("\n")}
  </div>
  <p class="empty" id="empty" hidden>No model matches. Try fewer words, or English ones.</p>
  <p class="sub">The list as text: <a href="https://github.com/laaielichter/Threesmith/blob/main/LIBRARY.md">LIBRARY.md</a>. The ${110} ready-made kinds: <a href="models.html">models</a>.</p>
</div></section>
<footer><div class="wrap">
  <span>Threesmith · made by laaielichter · MIT</span>
  <span><a href="./">Home</a> · <a href="models.html">Models</a> · <a href="install.html">Install</a> · <a href="https://github.com/laaielichter/Threesmith">GitHub</a></span>
</div></footer>
<script>
(() => {
  const FAMILIES = ${JSON.stringify(families)};
  const DUTCH = { eiken: "oak", stoel: "chair", stoelen: "chair", tafel: "table", kast: "cupboard", bank: "sofa bench", boom: "tree", bomen: "tree", struik: "bush", rots: "rock", steen: "rock stone", bloem: "flower", huis: "house", schuur: "shed barn", auto: "car", fiets: "bicycle", boot: "boat", kist: "chest crate", ton: "barrel", rood: "red", rode: "red", blauw: "blue", blauwe: "blue", groen: "green", groene: "green", geel: "yellow", gele: "yellow", wit: "white", witte: "white", zwart: "black", zwarte: "black", houten: "wood", hout: "wood", hek: "fence", paal: "post bollard", vrachtwagen: "truck", toren: "tower", kerk: "church", lamp: "lamp", put: "well", den: "pine", paddenstoel: "mushroom", bus: "bus", trein: "train" };
  const $ = (id) => document.getElementById(id);
  const cards = [...document.querySelectorAll(".model-card")];
  const state = { category: "all", family: "", words: [] };
  const show = (s) => { s.style.backgroundImage = "url(" + s.dataset.sheet + ")"; s.style.backgroundSize = s.dataset.size; s.style.backgroundPosition = s.dataset.pos; };
  const io = "IntersectionObserver" in window ? new IntersectionObserver((entries) => { for (const e of entries) if (e.isIntersecting) { io.unobserve(e.target); show(e.target); } }, { rootMargin: "600px" }) : null;
  for (const s of document.querySelectorAll(".sprite[data-sheet]")) io ? io.observe(s) : show(s);
  function apply() {
    let shown = 0;
    for (const card of cards) {
      const hit = (state.category === "all" || card.dataset.category === state.category) && (!state.family || card.dataset.family === state.family) && state.words.every((alts) => alts.some((w) => card.dataset.words.includes(w)));
      card.hidden = !hit;
      if (hit) shown++;
    }
    $("gallery-count").textContent = shown + (shown === 1 ? " model" : " models");
    $("empty").hidden = shown !== 0;
  }
  const chips = $("family-chips");
  function showFamilies() {
    chips.textContent = "";
    const list = FAMILIES[state.category] || [];
    chips.hidden = list.length === 0;
    for (const f of list) { const b = document.createElement("button"); b.type = "button"; b.dataset.family = f.id; b.setAttribute("aria-pressed", "false"); b.textContent = f.title + " " + f.count; chips.append(b); }
  }
  chips.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    state.family = state.family === b.dataset.family ? "" : b.dataset.family;
    for (const x of chips.children) x.setAttribute("aria-pressed", String(x.dataset.family === state.family));
    apply();
  });
  const buttons = [...document.querySelectorAll("[data-filter]")];
  for (const button of buttons) button.addEventListener("click", () => {
    state.category = button.dataset.filter; state.family = "";
    for (const x of buttons) x.setAttribute("aria-pressed", String(x === button));
    showFamilies(); apply();
  });
  $("q").addEventListener("input", (e) => {
    state.words = e.target.value.toLowerCase().split(/\\s+/).filter(Boolean).map((w) => [w, ...(DUTCH[w] ?? "").split(" ").filter(Boolean)]);
    apply();
  });
})();
</script>
</body>
</html>
`;
writeFileSync(docs("library.html"), page);
console.log(`docs/library.html: ${total} assets, ${pictures} with a picture`);
