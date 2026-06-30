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
    const name = get(b, "ItemName");
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

// ---- run all, report ----
const TERMS = ["בצל", "חלב", "עגבני"];
const chains = [
  ["שופרסל", shufersal],
  ["רמי לוי", () => cerberus("RamiLevi")],
  ["יוחננוף", () => cerberus("yohananof")],
  ["קרפור", carrefour],
];

const result = { ranAt: new Date().toISOString(), chains: {} };
for (const [label, fn] of chains) {
  console.log(`\n========== ${label} ==========`);
  try {
    const { file, items, head } = await fn();
    const samples = {};
    for (const term of TERMS) {
      samples[term] = items
        .filter((i) => i.name.includes(term))
        .slice(0, 3)
        .map((h) => ({ price: h.price, name: h.name, unit: h.unit }));
    }
    result.chains[label] = { ok: true, file, count: items.length, samples, head: items.length === 0 ? head : undefined };
    console.log(`OK: ${items.length} items`);
  } catch (e) {
    const cause = e.cause ? (e.cause.code || e.cause.message) : "";
    result.chains[label] = { ok: false, error: e.message, cause };
    console.log(`FAILED: ${e.message} | cause: ${cause}`);
  }
}
writeFileSync("result.json", JSON.stringify(result, null, 2));
console.log("\nwrote result.json");
