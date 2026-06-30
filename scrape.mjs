// Validation scraper — confirms we can download + parse price files for each
// chain in the cloud (GitHub Actions), where the corporate proxy is not a factor.
import { gunzipSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const UA = "Mozilla/5.0";

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
  const xml = gunzipSync(Buffer.from(await dl.arrayBuffer())).toString("utf8");
  return { file: pick, items: parseItems(xml) };
}

// ---- Shufersal direct ----
async function shufersal() {
  const list = await (await fetch("https://prices.shufersal.co.il/FileObject/UpdateCategory?catID=2&storeId=0&page=1")).text();
  const m = /href="([^"]+PriceFull[^"]+\.gz[^"]*)"/.exec(list);
  if (!m) throw new Error("no PriceFull link");
  const url = m[1].replace(/&amp;/g, "&");
  const xml = gunzipSync(Buffer.from(await (await fetch(url)).arrayBuffer())).toString("utf8");
  return { file: url.split("?")[0].split("/").pop(), items: parseItems(xml) };
}

// ---- Carrefour direct (structure discovery) ----
async function carrefour() {
  const root = await fetch("https://prices.carrefour.co.il/");
  const html = await root.text();
  const gz = [...html.matchAll(/href="([^"]+\.gz[^"]*)"/g)].map((x) => x[1]).slice(0, 3);
  console.log("   [carrefour] root status", root.status, "bytes", html.length, "| .gz links:", gz.length);
  if (gz.length) console.log("   sample:", gz[0].slice(0, 120));
  // Try a Shufersal-style listing endpoint
  for (const path of ["FileObject/UpdateCategory?catID=2&storeId=0&page=1", "file/json/dir"]) {
    try {
      const rr = await fetch(`https://prices.carrefour.co.il/${path}`, { method: path.includes("json") ? "POST" : "GET" });
      const tt = await rr.text();
      console.log(`   [carrefour] /${path.split("?")[0]} -> ${rr.status}, bytes ${tt.length}, PriceFull? ${/PriceFull/i.test(tt)}`);
    } catch (e) { console.log(`   [carrefour] /${path} failed: ${e.message}`); }
  }
  throw new Error("carrefour: discovery only (see logs above)");
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
    const { file, items } = await fn();
    const samples = {};
    for (const term of TERMS) {
      samples[term] = items
        .filter((i) => i.name.includes(term))
        .slice(0, 3)
        .map((h) => ({ price: h.price, name: h.name, unit: h.unit }));
    }
    result.chains[label] = { ok: true, file, count: items.length, samples };
    console.log(`OK: ${items.length} items`);
  } catch (e) {
    const cause = e.cause ? (e.cause.code || e.cause.message) : "";
    result.chains[label] = { ok: false, error: e.message, cause };
    console.log(`FAILED: ${e.message} | cause: ${cause}`);
  }
}
writeFileSync("result.json", JSON.stringify(result, null, 2));
console.log("\nwrote result.json");
