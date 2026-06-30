// Validation scraper — confirms we can download + parse price files for each
// chain in the cloud (GitHub Actions), where the corporate proxy is not a factor.
import { gunzipSync, inflateRawSync } from "node:zlib";
import { writeFileSync } from "node:fs";

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
  throw new Error("unknown archive head " + buf.subarray(0, 4).toString("hex"));
}

const UA = "Mozilla/5.0";

// fetch with retries + per-attempt timeout (cloud networks can be flaky to these hosts)
async function fetchRetry(url, opts = {}, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 25000);
      const res = await fetch(url, { ...opts, signal: ctrl.signal });
      clearTimeout(to);
      return res;
    } catch (e) { last = e; }
  }
  throw last;
}

// ---- generic "מחירים שקופים" XML item parser ----
function parseItems(xml) {
  const get = (b, t) => {
    const m = new RegExp(`<${t}>([\\s\\S]*?)</${t}>`).exec(b);
    return m ? m[1].trim() : "";
  };
  const items = [];
  for (const im of xml.matchAll(/<Item>([\s\S]*?)<\/Item>/g)) {
    const b = im[1];
    const name = get(b, "ItemName") || get(b, "ItemNm");
    const price = parseFloat(get(b, "ItemPrice"));
    if (!name || !isFinite(price)) continue;
    items.push({ name, price, unit: get(b, "UnitQty") || get(b, "UnitOfMeasure") || "" });
  }
  return items;
}

// ---- Cerberus portal (Rami Levy, Yohananof, ...) ----
async function cerberus(username) {
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

  let r = await fetch(`${BASE}/login`, { headers: { "User-Agent": UA } });
  store(r);
  const t0 = meta(await r.text());
  r = await fetch(`${BASE}/login/user`, {
    method: "POST",
    headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie() },
    body: `username=${encodeURIComponent(username)}&password=&csrftoken=${encodeURIComponent(t0)}`,
    redirect: "manual",
  });
  store(r);
  r = await fetch(`${BASE}/file`, { headers: { "User-Agent": UA, Cookie: cookie() } });
  store(r);
  const t1 = meta(await r.text()) || jar["csrftoken"];
  r = await fetch(`${BASE}/file/json/dir`, {
    method: "POST",
    headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie() },
    body: `csrftoken=${encodeURIComponent(t1)}&iDisplayStart=0&iDisplayLength=5000&cd=%2F`,
  });
  const files = [...(await r.text()).matchAll(/"fname":"([^"]+)"/g)].map((x) => x[1]);
  const full = files.filter((n) => /pricefull/i.test(n)).sort();
  const pick = full[full.length - 1];
  if (!pick) throw new Error(`no PriceFull (sample: ${files.slice(0, 3).join(", ")})`);
  const dl = await fetch(`${BASE}/file/d/${pick}`, { headers: { "User-Agent": UA, Cookie: cookie() } });
  const buf = Buffer.from(await dl.arrayBuffer());
  let xml;
  try {
    xml = decompress(buf).toString("utf8");
  } catch (e) {
    const head = buf.slice(0, 60).toString("latin1").replace(/[\r\n]+/g, " ");
    throw new Error(`gunzip failed for ${pick} (status ${dl.status}, ${buf.length} bytes, head="${head}")`);
  }
  return { file: pick, items: parseItems(xml), head: xml.slice(0, 700) };
}

// ---- Shufersal direct ----
async function shufersal() {
  const list = await (await fetch("https://prices.shufersal.co.il/FileObject/UpdateCategory?catID=2&storeId=0&page=1")).text();
  const m = /href="([^"]+PriceFull[^"]+\.gz[^"]*)"/.exec(list);
  if (!m) throw new Error("no PriceFull link");
  const url = m[1].replace(/&amp;/g, "&");
  const xml = decompress(Buffer.from(await (await fetch(url)).arrayBuffer())).toString("utf8");
  return { file: url.split("?")[0].split("/").pop(), items: parseItems(xml), head: xml.slice(0, 700) };
}

// ---- Carrefour direct (U-CODE.NET portal — structure discovery) ----
async function carrefour() {
  const res = await fetchRetry("https://prices.carrefour.co.il/");
  const html = await res.text();
  const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  const actions = [...html.matchAll(/action="([^"]+)"/g)].map((m) => m[1]);
  const gz = hrefs.filter((h) => /\.gz/i.test(h));
  const interesting = [...new Set(hrefs.filter((h) => /file|download|price|\?|Download/i.test(h)))].slice(0, 15);
  throw new Error(
    `DISCOVERY status=${res.status} bytes=${html.length} | gz=${JSON.stringify(gz.slice(0, 3))} | forms=${JSON.stringify(actions.slice(0, 5))} | links=${JSON.stringify(interesting)}`
  );
}

// ================= pipeline =================
const FB_PROJECT = "shoppingcart300626";
const FB_KEY = "AIzaSyAB_l1XWmRRSsd9K_Fw_pXc8ARE4EV5kFE"; // public web config key
const FS = `https://firestore.googleapis.com/v1/projects/${FB_PROJECT}/databases/(default)/documents`;
const GROQ_KEY = process.env.GROQ_API_KEY;

// Encode a JS value into Firestore REST typed format.
function fsValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(fsValue) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, val]) => [k, fsValue(val)])) } };
}

async function readItems() {
  const res = await fetchRetry(`${FS}/shoppingItems?key=${FB_KEY}&pageSize=300`);
  const data = await res.json();
  return (data.documents || [])
    .map((d) => ({
      id: d.name.split("/").pop(),
      name: d.fields?.name?.stringValue || "",
      quantity: Number(d.fields?.quantity?.integerValue ?? d.fields?.quantity?.doubleValue ?? 1),
    }))
    .filter((i) => i.name);
}

async function writePriceCache(itemId, obj) {
  const body = JSON.stringify({ fields: fsValue(obj).mapValue.fields });
  const res = await fetchRetry(`${FS}/priceCache/${itemId}?key=${FB_KEY}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body,
  });
  if (!res.ok) throw new Error(`priceCache write ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

// Heuristic match: prefer more query-tokens matched, then shorter name, then cheaper.
function bestMatch(items, query) {
  const tokens = query.toLowerCase().split(/\s+/).filter((t) => t.length >= 2);
  if (!tokens.length) tokens.push(query.toLowerCase());
  let best = null, bestScore = -Infinity;
  for (const it of items) {
    const name = it.name.toLowerCase();
    const matched = tokens.filter((t) => name.includes(t)).length;
    if (matched === 0) continue;
    const score = matched * 100000 - it.name.length * 100 - it.price;
    if (score > bestScore) { bestScore = score; best = it; }
  }
  return best;
}

// Prefilter: top-N catalog products that share tokens with the query.
function candidates(items, query, n = 40) {
  const tokens = query.toLowerCase().split(/\s+/).filter((t) => t.length >= 2);
  if (!tokens.length) tokens.push(query.toLowerCase());
  const scored = [];
  for (const it of items) {
    const name = it.name.toLowerCase();
    const words = name.split(/[\s,.\-/()'"]+/).filter(Boolean);
    let wordHits = 0, subHits = 0;
    for (const t of tokens) {
      if (words.some((w) => w === t || w.startsWith(t))) wordHits++;
      else if (name.includes(t)) subHits++;
    }
    if (wordHits === 0 && subHits === 0) continue;
    // whole-word matches dominate substring matches; shorter name as minor tiebreak
    scored.push({ it, s: wordHits * 10000 + subHits * 100 - it.name.length });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, n).map((x) => x.it);
}

// Ask Groq to choose the best-matching candidate index per chain (real prices kept).
async function groqPick(itemName, candByChain) {
  const lines = Object.entries(candByChain)
    .map(([chain, cands]) => `חנות "${chain}":\n` + (cands.length ? cands.map((c, i) => `  ${i}. ${c.name}`).join("\n") : "  (אין מועמדים)"))
    .join("\n\n");
  const prompt = `המשתמש רוצה לקנות מוצר בשם: "${itemName}".
לכל חנות, בחר את ה-index של המוצר ברשימה שהכי מתאים מבחינת *סוג המוצר* שהמשתמש מתכוון אליו — לא חייב אותן מילים בדיוק, אלא אותו מוצר במהות.
דוגמאות: "מוצרלה פרסקה" = מוצרלה טרייה / כדור מוצרלה טרי; "קולה" = קוקה קולה / משקה קולה (לא "רוקולה"); "בצל" = בצל יבש טרי (לא חטיף בטעם בצל); "שמן רגיל" = שמן קנולה/חמניות לבישול.
העדף את הווריאנט הבסיסי והסטנדרטי של המוצר (לא תחליף, לא טבעוני, אלא אם המשתמש ביקש). החזר -1 רק אם באמת אין ברשימה מוצר מאותו סוג.
החזר JSON בלבד במבנה: { "שופרסל": number, "רמי לוי": number, "יוחננוף": number }

${lines}`;
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_KEY}` },
    body: JSON.stringify({
      model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0,
    }),
  });
  if (!res.ok) throw new Error(`groq ${res.status}: ${(await res.text()).slice(0, 150)}`);
  return JSON.parse((await res.json()).choices[0].message.content);
}

const CHAINS = [
  ["שופרסל", shufersal],
  ["רמי לוי", () => cerberus("RamiLevi")],
  ["יוחננוף", () => cerberus("yohananof")],
];

const result = { ranAt: new Date().toISOString(), chains: {}, items: [] };
const catalogs = {};
for (const [label, fn] of CHAINS) {
  console.log(`\n========== ${label} ==========`);
  try {
    const { items } = await fn();
    catalogs[label] = items;
    result.chains[label] = { ok: true, count: items.length };
    console.log(`OK: ${items.length} items`);
  } catch (e) {
    catalogs[label] = [];
    result.chains[label] = { ok: false, error: e.message, cause: e.cause?.code || "" };
    console.log(`FAILED: ${e.message}`);
  }
}

if (process.env.DEBUG_TERM) {
  const term = process.env.DEBUG_TERM;
  const toks = term.toLowerCase().split(/\s+/).filter((t) => t.length >= 2);
  const dbg = {};
  for (const [label] of CHAINS) {
    dbg[label] = (catalogs[label] || [])
      .filter((it) => toks.some((t) => it.name.toLowerCase().includes(t)))
      .slice(0, 50)
      .map((it) => `₪${it.price} ${it.name}`);
  }
  writeFileSync("result.json", JSON.stringify({ debugTerm: term, matches: dbg }, null, 2));
  console.log("debug written for", term);
  process.exit(0);
}

const items = await readItems();
console.log(`\nread ${items.length} shopping items from Firestore`);
let written = 0;
for (const item of items) {
  const candByChain = {};
  for (const [label] of CHAINS) candByChain[label] = candidates(catalogs[label], item.name);

  let picks = null;
  try {
    picks = await groqPick(item.name, candByChain);
  } catch (e) {
    console.log(`  groq failed for ${item.name}: ${e.message} — using heuristic`);
  }

  const prices = [];
  for (const [label] of CHAINS) {
    let cand = null;
    if (picks) {
      const idx = Number(picks[label]);
      if (Number.isInteger(idx) && idx >= 0 && candByChain[label][idx]) cand = candByChain[label][idx];
    } else {
      cand = bestMatch(catalogs[label], item.name); // fallback when Groq unavailable
    }
    if (cand) prices.push({ store: label, matchedName: cand.name, price: cand.price, unit: cand.unit });
  }

  try {
    await writePriceCache(item.id, { itemName: item.name, updated: result.ranAt, prices });
    written++;
  } catch (e) {
    console.log(`  write failed for ${item.name}: ${e.message}`);
  }
  result.items.push({ name: item.name, matches: prices.map((p) => `${p.store} ₪${p.price} (${p.matchedName})`) });
}
console.log(`wrote ${written}/${items.length} priceCache docs`);
writeFileSync("result.json", JSON.stringify(result, null, 2));
