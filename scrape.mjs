// Price scraper for the shopping-list app.
//
// Every run (GitHub Actions, several times a day):
//   1. Downloads the official "מחירים שקופים" price feeds for the user's branches.
//   2. Merges them by barcode into one compact catalog (out/catalog.json) that the app
//      downloads and searches on the phone — basket compare + in-store price check.
//   3. Pre-matches shopping-list items that have no match yet (via the Worker's /match
//      endpoint) and stores the chosen barcodes on the item (shoppingItems/{id}.priceMatch),
//      so the app rarely has to call the LLM live.
import { gunzipSync, inflateRawSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

// Decompress a price file: handles both gzip (Shufersal/Yohananof) and zip (Rami Levy).
function decompress(buf) {
  if (buf[0] === 0x1f && buf[1] === 0x8b) return gunzipSync(buf); // gzip
  if (buf[0] === 0x50 && buf[1] === 0x4b) {
    // ZIP — read the central directory for reliable sizes/offset
    let eocd = -1;
    for (let i = buf.length - 22; i >= 0; i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("zip: no EOCD");
    const cd = buf.readUInt32LE(eocd + 16);
    if (buf.readUInt32LE(cd) !== 0x02014b50) throw new Error("zip: bad central dir");
    const method = buf.readUInt16LE(cd + 10);
    const compSize = buf.readUInt32LE(cd + 20);
    const localOff = buf.readUInt32LE(cd + 42);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const comp = buf.subarray(start, start + compSize);
    if (method === 0) return comp;
    if (method === 8) return inflateRawSync(comp);
    throw new Error("zip: unsupported method " + method);
  }
  return buf; // not compressed — plain XML (possibly UTF-16)
}

// Decode an XML buffer honoring a UTF-16/UTF-8 BOM.
function decodeXml(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString("utf16le");
  if (buf[0] === 0xfe && buf[1] === 0xff) return Buffer.from(buf).swap16().toString("utf16le");
  return buf.toString("utf8");
}

const UA = "Mozilla/5.0";

// fetch with retries + per-attempt timeout (cloud networks can be flaky to these hosts)
async function fetchRetry(url, opts = {}, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 60000);
      const res = await fetch(url, { ...opts, signal: ctrl.signal });
      clearTimeout(to);
      return res;
    } catch (e) { last = e; }
  }
  throw last;
}

const unescapeXml = (s) =>
  s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

// ---- generic "מחירים שקופים" XML item parser ----
function parseItems(xml) {
  const get = (b, t) => {
    const m = new RegExp(`<${t}>([\\s\\S]*?)</${t}>`).exec(b);
    return m ? unescapeXml(m[1].trim()) : "";
  };
  const items = [];
  // most chains use <Item>; the laibcatalog (Victory) files may use <Product>
  for (const im of xml.matchAll(/<(Item|Product)>([\s\S]*?)<\/\1>/g)) {
    const b = im[2];
    const name = (get(b, "ItemName") || get(b, "ItemNm")).replace(/\s+/g, " ");
    const price = parseFloat(get(b, "ItemPrice"));
    if (!name || !isFinite(price) || price <= 0) continue;
    const qty = parseFloat(get(b, "Quantity"));
    const unit = get(b, "UnitQty");
    items.push({
      code: get(b, "ItemCode").replace(/^0+(?=\d{8})/, ""),
      name,
      price,
      size: isFinite(qty) && qty > 0 && unit && !/יחידה|לא ידוע/.test(unit) ? `${+qty.toFixed(2)} ${unit}` : "",
      weighted: get(b, "bIsWeighted") === "1",
    });
  }
  return items;
}

// Parse a Stores XML file into [{ id, name, city, address }].
function parseStores(xml) {
  const stores = [];
  const get = (b, tags) => {
    for (const t of tags) {
      const m = new RegExp(`<${t}>([\\s\\S]*?)</${t}>`, "i").exec(b);
      if (m) return m[1].trim();
    }
    return "";
  };
  const re = /<(Store|STORE|Branch|BRANCH)>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const b = m[2];
    const id = get(b, ["StoreId", "StoreID", "StoreNo", "BranchId", "StoreNumber"]);
    if (!id) continue;
    stores.push({
      id,
      name: get(b, ["StoreName", "BranchName"]),
      city: get(b, ["City"]),
      address: get(b, ["Address"]),
    });
  }
  return stores;
}

// ---- Cerberus portal (Rami Levy, Yohananof, ...) ----
async function cerberusSession(username) {
  const BASE = "https://url.publishedprices.co.il";
  const jar = {};
  const store = (res) => {
    for (const c of res.headers.getSetCookie?.() || []) {
      const [p] = c.split(";");
      const i = p.indexOf("=");
      if (i > 0) jar[p.slice(0, i).trim()] = p.slice(i + 1).trim();
    }
  };
  const cookie = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
  const meta = (h) => (/name="csrftoken"\s+content="([^"]+)"/.exec(h) || [])[1];

  let r = await fetchRetry(`${BASE}/login`, { headers: { "User-Agent": UA } });
  store(r);
  const t0 = meta(await r.text());
  r = await fetchRetry(`${BASE}/login/user`, {
    method: "POST",
    headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie() },
    body: `username=${encodeURIComponent(username)}&password=&csrftoken=${encodeURIComponent(t0)}`,
    redirect: "manual",
  });
  store(r);
  r = await fetchRetry(`${BASE}/file`, { headers: { "User-Agent": UA, Cookie: cookie() } });
  store(r);
  const t1 = meta(await r.text()) || jar["csrftoken"];
  r = await fetchRetry(`${BASE}/file/json/dir`, {
    method: "POST",
    headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie() },
    body: `csrftoken=${encodeURIComponent(t1)}&iDisplayStart=0&iDisplayLength=5000&cd=%2F`,
  });
  const files = [...(await r.text()).matchAll(/"fname":"([^"]+)"/g)].map((x) => x[1]);
  const get = async (fname) =>
    decompress(Buffer.from(await (await fetchRetry(`${BASE}/file/d/${fname}`, { headers: { "User-Agent": UA, Cookie: cookie() } })).arrayBuffer()));
  return { files, get };
}

// Latest file of a given kind (e.g. /pricefull/) for one store.
function pickStoreFile(files, kind, storeId) {
  let list = files.filter((n) => kind.test(n));
  if (storeId) {
    const v = new Set([String(storeId), String(Number(storeId)), String(storeId).padStart(3, "0"), String(storeId).padStart(4, "0")]);
    const forStore = list.filter((n) => n.split(/[-.]/).some((s) => v.has(s)));
    if (forStore.length) list = forStore;
  }
  list.sort();
  return list[list.length - 1];
}

async function cerberus(username, storeId) {
  const { files, get } = await cerberusSession(username);
  const full = pickStoreFile(files, /pricefull/i, storeId);
  if (!full) throw new Error(`no PriceFull (sample: ${files.slice(0, 3).join(", ")})`);
  const items = parseItems(decodeXml(await get(full)));
  // PriceFull is published about once a day; the incremental Price files carry later changes.
  const inc = pickStoreFile(files, /^price(?!full)/i, storeId);
  if (inc && inc.replace(/^price/i, "") > full.replace(/^pricefull/i, "")) {
    try { applyUpdates(items, parseItems(decodeXml(await get(inc)))); } catch { /* keep the full file */ }
  }
  return { file: full, items };
}

// ---- Shufersal direct ----
async function shufersalFile(catID, storeId) {
  const list = await (await fetchRetry(`https://prices.shufersal.co.il/FileObject/UpdateCategory?catID=${catID}&storeId=${storeId}&page=1`)).text();
  const m = /href="([^"]+\.gz[^"]*)"/.exec(list);
  if (!m) return null;
  const url = m[1].replace(/&amp;/g, "&");
  return { name: url.split("?")[0].split("/").pop(), xml: decodeXml(decompress(Buffer.from(await (await fetchRetry(url)).arrayBuffer()))) };
}

async function shufersal(storeId) {
  const full = await shufersalFile(2, storeId);
  if (!full) throw new Error("no PriceFull link");
  const items = parseItems(full.xml);
  try {
    const inc = await shufersalFile(1, storeId); // incremental "Price" file
    if (inc) applyUpdates(items, parseItems(inc.xml));
  } catch { /* keep the full file */ }
  return { file: full.name, items };
}

// ---- laibcatalog.co.il (Victory, Mahsanei Hashuk, H. Cohen) ----
// The home page lists the files published today; the chains there don't publish on Shabbat,
// in which case this throws and the previous run's prices are reused.
async function laib(chainId, branch) {
  const BASE = "https://laibcatalog.co.il/";
  const html = await (await fetchRetry(BASE, { headers: { "User-Agent": UA } })).text();
  const hrefs = [...html.matchAll(/href='([^']+\.(?:xml\.)?gz)'/g)].map((m) => m[1].replace(/\\/g, "/"));
  const latest = (kind) =>
    hrefs.filter((h) => new RegExp(`/${kind}${chainId}-\\d+-${branch}-`, "i").test(h)).sort().pop();
  const full = latest("PriceFull");
  if (!full) throw new Error(`no PriceFull for ${chainId}-${branch} on laibcatalog (${hrefs.length} files listed)`);
  const get = async (h) => decodeXml(decompress(Buffer.from(await (await fetchRetry(BASE + h, { headers: { "User-Agent": UA } })).arrayBuffer())));
  const items = parseItems(await get(full));
  const inc = latest("Price");
  if (inc && inc.split("/").pop().replace(/^price/i, "") > full.split("/").pop().replace(/^pricefull/i, "")) {
    try { applyUpdates(items, parseItems(await get(inc))); } catch { /* keep the full file */ }
  }
  return { file: full.split("/").pop(), items };
}

// Overlay incremental price updates onto the full list (by item code).
function applyUpdates(items, updates) {
  const byCode = new Map(items.map((it) => [it.code, it]));
  for (const u of updates) {
    const it = byCode.get(u.code);
    if (it) it.price = u.price;
    else { items.push(u); byCode.set(u.code, u); }
  }
}

// ================= config =================
const FB_PROJECT = "shoppingcart300626";
const FB_KEY = "AIzaSyAB_l1XWmRRSsd9K_Fw_pXc8ARE4EV5kFE"; // public web config key
const FS = `https://firestore.googleapis.com/v1/projects/${FB_PROJECT}/databases/(default)/documents`;
const MATCH_URL = process.env.MATCH_URL || "https://shopping-price-compare.karzag.workers.dev/match";
const MATCH_LIMIT = Number(process.env.MATCH_LIMIT || 60); // items matched per run (LLM rate limits)

// Branches near Kiryat Tivon:
//   Shufersal 98 = דיל קרית טבעון אלונים · Rami Levy 062 = צק פוסט חיפה · Yohananof 013 = חוצות המפרץ
//   Victory 086 = טבעון · Salah Dabbah 019 = צק פוסט
// Only ever APPEND chains: in-store codes are keyed by chain index ("<i>:<code>") and those
// keys are saved in the items' priceMatch.
const CHAINS = [
  { name: "שופרסל", branch: "דיל קרית טבעון", load: () => shufersal(98) },
  { name: "רמי לוי", branch: "צ'ק פוסט חיפה", load: () => cerberus("RamiLevi", "062") },
  { name: "יוחננוף", branch: "חוצות המפרץ", load: () => cerberus("yohananof", "013") },
  // disabled: laibcatalog.co.il is geo-blocked from GitHub Actions/Cloudflare (works only from an Israeli IP)
  { name: "ויקטורי", branch: "טבעון", load: () => laib("7290696200003", "086"), disabled: true },
  { name: "סלאח דבאח", branch: "צ'ק פוסט", load: () => cerberus("SalachD", "019") },
];
const CATALOG_URL = "https://raw.githubusercontent.com/ykarzag/Shopping-Prices/catalog/catalog.json";

// A chain that failed this run keeps its prices from the previously published catalog.
async function previousPrices(chainName) {
  const prev = await (await fetchRetry(CATALOG_URL)).json();
  const ci = prev.chains.indexOf(chainName);
  if (ci < 0) return null;
  const items = prev.products
    .filter((p) => p[4 + ci] != null)
    .map((p) => ({ code: p[0].replace(/^\d+:/, ""), name: p[1], size: p[2], weighted: !!p[3], price: p[4 + ci] }));
  const updated = prev.chainUpdated?.[ci] || prev.updated;
  return { items, updated };
}

mkdirSync("out", { recursive: true });

// Store discovery mode: find the user's branches and their StoreIds.
if (process.env.DEBUG_TERM === "__STORES__") {
  const kw = ["אלונים", "חיפה", "צ'ק", "צ׳ק", "ביג", "טבעון", "קרית אתא", "קריית אתא", "נשר", "רכסים"];
  const hit = (s) => kw.some((k) => `${s.city} ${s.name} ${s.address}`.includes(k));
  const out = {};
  for (const [label, user] of [["רמי לוי", "RamiLevi"], ["יוחננוף", "yohananof"]]) {
    try {
      const { files, get } = await cerberusSession(user);
      const sf = files.find((n) => /storesfull/i.test(n)) || files.find((n) => /stores/i.test(n));
      const stores = parseStores(decodeXml(await get(sf)));
      out[label] = { file: sf, total: stores.length, all: stores.map((s) => `${s.id} | ${s.name} | ${s.city} | ${s.address}`) };
    } catch (e) { out[label] = { error: e.message }; }
  }
  try {
    const f = await shufersalFile(5, 0);
    const stores = parseStores(f.xml);
    out["שופרסל"] = { total: stores.length, matches: stores.filter(hit) };
  } catch (e) { out["שופרסל"] = { error: e.message }; }
  writeFileSync("out/result.json", JSON.stringify(out, null, 2));
  console.log("stores debug written");
  process.exit(0);
}

// ================= 1. download =================
const ranAt = new Date().toISOString();
const result = { ranAt, chains: {}, matched: [] };
const catalogs = [];
const chainUpdated = []; // when each chain's prices were downloaded
let fresh = 0;
for (const chain of CHAINS) {
  if (chain.disabled) { // keeps its column (and every later chain's index) but has no prices
    catalogs.push([]);
    chainUpdated.push(null);
    continue;
  }
  try {
    const { file, items } = await chain.load();
    catalogs.push(items);
    chainUpdated.push(ranAt);
    fresh++;
    result.chains[chain.name] = { ok: true, file, count: items.length };
    console.log(`${chain.name}: ${items.length} items (${file})`);
  } catch (e) {
    result.chains[chain.name] = { ok: false, error: e.message, cause: e.cause?.code || "" };
    console.log(`${chain.name}: FAILED ${e.message}`);
    let prev = null;
    try { prev = await previousPrices(chain.name); } catch { /* no previous catalog */ }
    catalogs.push(prev?.items || []);
    chainUpdated.push(prev?.updated || null);
    if (prev) {
      result.chains[chain.name].reused = { count: prev.items.length, from: prev.updated };
      console.log(`  reusing ${prev.items.length} prices from ${prev.updated}`);
    }
  }
}
if (process.env.DUMP_RAW) writeFileSync("out/raw.json", JSON.stringify(catalogs));
if (!fresh) {
  console.log("no chain downloaded — keeping the previous catalog");
  process.exit(1);
}

// ================= 2. merge into one catalog =================
// A real barcode (EAN, 8–14 digits) is shared across chains. In-store codes are not:
// weighed items (13 digits starting with 2) and produce PLUs (7290000000xxx — e.g.
// 7290000000138 is כרוב לבן in one chain and בטטה in another). Those are keyed "<chain>:<code>".
const isSharedCode = (c) => /^\d{8,14}$/.test(c) && !(c.length === 13 && c[0] === "2") && !/^7290000000\d{3}$/.test(c);
const products = new Map(); // key -> [key, name, size, weighted, p0, p1, p2]
catalogs.forEach((items, ci) => {
  for (const it of items) {
    if (!it.code) continue;
    const key = isSharedCode(it.code) ? it.code : `${ci}:${it.code}`;
    let p = products.get(key);
    if (!p) {
      p = [key, it.name, it.size, it.weighted ? 1 : 0, ...CHAINS.map(() => null)];
      products.set(key, p);
    } else if (it.name.length > p[1].length) {
      p[1] = it.name; // keep the most descriptive name
    }
    p[4 + ci] = it.price;
    if (!p[2] && it.size) p[2] = it.size;
  }
});
const catalog = {
  updated: ranAt,
  chains: CHAINS.map((c) => c.name),
  branches: CHAINS.map((c) => c.branch),
  chainUpdated, // per chain: when its prices were downloaded (null = no data yet)
  // columns: key, name, size, weighted, price per chain (null = not sold there)
  products: [...products.values()],
};
writeFileSync("out/catalog.json", JSON.stringify(catalog));
result.catalogProducts = catalog.products.length;
console.log(`catalog: ${catalog.products.length} products`);

if (process.env.SKIP_MATCH) {
  writeFileSync("out/result.json", JSON.stringify(result, null, 2));
  process.exit(0);
}

// ================= 3. pre-match shopping items =================
// Candidate selection — keep in sync with src/lib/priceMatch.js in the app.
// Hebrew-aware tokens: final letters unified, common plural/feminine endings stripped,
// so "עגבניות" finds "עגבניה" and "מלפפונים" finds "מלפפון".
const FINALS = { "ך": "כ", "ם": "מ", "ן": "נ", "ף": "פ", "ץ": "צ" };
const normalize = (s) => s.toLowerCase().replace(/["'״׳`]/g, "").replace(/[ךםןףץ]/g, (c) => FINALS[c]).replace(/[^\p{L}\p{N}%.]+/gu, " ").trim();
const stem = (w) => (w.length > 4 && w.endsWith("יות") ? w.slice(0, -3) : w.length > 3 && /(ות|ימ)$/.test(w) ? w.slice(0, -2) : w.length > 3 && w.endsWith("ה") ? w.slice(0, -1) : w);
const P = catalog.products.map((p) => {
  const n = normalize(p[1]);
  return { p, n, words: n.split(" ").map(stem) };
});

function tokenScore(t, words, name) {
  let best = 0;
  for (const w of words) {
    if (w === t) return 3;
    if (w.startsWith(t) || (w.length > t.length && "הובלמש".includes(w[0]) && w.slice(1).startsWith(t))) best = 2;
  }
  return best || (name.includes(t) ? 1 : 0);
}

// Multi-packs ("מארז", "4 * 1 ליטר", "שישיית") — pushed down unless the user asked for one.
const MULTIPACK = /מארז|שישי|רביעי|\d\s*[*xX×]\s*\d/;

function candidates(query, n = 15) {
  const tokens = normalize(query).split(" ").filter((t) => t.length >= 2).map(stem);
  if (!tokens.length) return [];
  const wantsPack = MULTIPACK.test(query);
  const scored = [];
  for (const { p, n: name, words } of P) {
    let sum = 0, hit = 0;
    for (const t of tokens) {
      const ts = tokenScore(t, words, name);
      sum += ts;
      if (ts) hit++;
    }
    if (!hit) continue;
    const chains = p.slice(4).filter((x) => x != null).length;
    // extra words beyond the query cost points, so "מלפפון" beats "מלפפון במלח 7-9 560 גרם"
    const extra = Math.max(0, words.filter((w) => !/^\d/.test(w)).length - tokens.length);
    scored.push({ p, s: (hit === tokens.length ? 50000 : 0) + sum * 10000 + (words[0].startsWith(tokens[0]) ? 3000 : 0) - extra * 800 - (!wantsPack && MULTIPACK.test(p[1]) ? 20000 : 0) + chains * 60 - name.length * 3 });
  }
  scored.sort((a, b) => b.s - a.s);
  // best overall, plus the best few per chain so every chain has options
  const picked = new Set(scored.slice(0, n).map((x) => x.p));
  CHAINS.forEach((_, ci) => scored.filter((x) => x.p[4 + ci] != null).slice(0, 6).forEach((x) => picked.add(x.p)));
  return [...picked];
}

const toCand = (p) => ({ n: p[1], q: p[2], w: p[3], p: Object.fromEntries(CHAINS.map((c, ci) => [c.name, p[4 + ci]]).filter(([, v]) => v != null)) });

function fsValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(fsValue) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, val]) => [k, fsValue(val)])) } };
}

async function readItems() {
  const out = [];
  let token = "";
  do {
    const data = await (await fetchRetry(`${FS}/shoppingItems?key=${FB_KEY}&pageSize=300${token ? `&pageToken=${token}` : ""}`)).json();
    for (const d of data.documents || []) {
      const f = d.fields || {};
      const pm = f.priceMatch?.mapValue?.fields;
      out.push({
        id: d.name.split("/").pop(),
        name: f.name?.stringValue || "",
        quantity: Number(f.quantity?.integerValue ?? f.quantity?.doubleValue ?? 1),
        match: pm
          ? {
              name: pm.name?.stringValue,
              manual: !!pm.manual?.booleanValue,
              codes: Object.fromEntries(Object.entries(pm.codes?.mapValue?.fields || {}).map(([k, v]) => [k, v.stringValue])),
              // matches made before chains were tracked covered the first three chains
              chains: pm.chains?.arrayValue?.values?.map((v) => v.stringValue) || CHAINS.slice(0, 3).map((c) => c.name),
            }
          : null,
      });
    }
    token = data.nextPageToken;
  } while (token);
  return out.filter((i) => i.name);
}

async function writeMatch(id, priceMatch) {
  // updateMask touches only priceMatch; exists=true never resurrects a deleted item
  const url = `${FS}/shoppingItems/${id}?key=${FB_KEY}&updateMask.fieldPaths=priceMatch&currentDocument.exists=true`;
  const res = await fetchRetry(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields: { priceMatch: fsValue(priceMatch) } }),
  });
  if (!res.ok) throw new Error(`write ${res.status}: ${(await res.text()).slice(0, 150)}`);
}

// DRY_ITEMS="a,b,c": match these names without touching Firestore (local testing)
const DRY = process.env.DRY_ITEMS?.split(",").map((name, i) => ({ id: "t" + i, name, quantity: 1, match: null }));
const shopping = DRY || await readItems();
const ACTIVE = CHAINS.filter((_, ci) => catalogs[ci].length).map((c) => c.name); // chains with prices
// A rename means a fresh match. A chain added since the last match only fills that chain in —
// the existing (possibly manual) picks for the other chains are kept.
const renamed = (i) => i.match?.name !== i.name;
// (a chain that sells one of the already-matched barcodes is covered — the app uses it directly)
const missingChains = (i) =>
  ACTIVE.filter((c) => {
    if (i.match?.chains.includes(c)) return false;
    const ci = CHAINS.findIndex((x) => x.name === c);
    return !Object.values(i.match?.codes || {}).some((k) => products.get(k)?.[4 + ci] != null);
  });
const todo = shopping
  .filter((i) => renamed(i) || missingChains(i).length)
  .sort((a, b) => (b.quantity > 0) - (a.quantity > 0)) // items to buy first
  .slice(0, MATCH_LIMIT);
console.log(`shopping items: ${shopping.length}, to match this run: ${todo.length}`);

const BATCH = 2;
for (let i = 0; i < todo.length; i += BATCH) {
  const batch = todo.slice(i, i + BATCH).map((it) => ({ ...it, cands: candidates(it.name) }));
  let picks;
  try {
    const res = await fetchRetry(MATCH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chains: ACTIVE, items: batch.map((b) => ({ id: b.id, name: b.name, cands: b.cands.map(toCand) })) }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || String(res.status));
    picks = data.results;
  } catch (e) {
    console.log(`  match failed (${batch.map((b) => b.name).join(", ")}): ${e.message}`);
    if (/429|rate/i.test(e.message)) break; // out of LLM quota — the next run continues
    continue;
  }
  for (const b of batch) {
    const pick = picks?.[b.id] || {};
    const keep = !renamed(b) && b.match ? b.match : null; // only new chains are being added
    const codes = keep ? { ...keep.codes } : {};
    CHAINS.forEach((c, ci) => {
      if (keep?.chains.includes(c.name)) return;
      const cand = b.cands[pick[c.name]];
      if (cand && cand[4 + ci] != null) codes[c.name] = cand[0];
    });
    const chains = [...new Set([...(keep?.chains || []), ...ACTIVE])];
    try {
      if (!DRY) await writeMatch(b.id, { name: b.name, codes, chains, manual: !!keep?.manual, at: ranAt });
      const show = CHAINS.map((c, ci) => {
        const p = codes[c.name] && products.get(codes[c.name]);
        return p ? `${c.name}=${p[1]} ₪${p[4 + ci]}` : `${c.name}=—`;
      });
      result.matched.push(`${b.name}: ${show.join(" | ")}`);
    } catch (e) {
      console.log(`  ${e.message} (${b.name})`);
    }
  }
  await new Promise((r) => setTimeout(r, 4000)); // spread LLM token usage
}
console.log(`matched ${result.matched.length} items`);
writeFileSync("out/result.json", JSON.stringify(result, null, 2));
