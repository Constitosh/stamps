import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import fs from 'fs';
import path from 'path';
import { LRUCache } from 'lru-cache';
import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { bech32 } from 'bech32';

const app = express();

/* ── config ── */
const PORT        = Number(process.env.PORT || 3005);
const POLICY_ID   = (process.env.POLICY_ID || '').trim();
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const NETWORK_ID  = Number(process.env.NETWORK_ID || 1); // 1 mainnet, 0 testnet
const api         = new BlockFrostAPI({ projectId: process.env.BLOCKFROST_KEY });

/* ── middleware ── */
app.use(cors({ origin: CORS_ORIGIN }));
app.use(helmet());
app.use(express.json({ limit: '1mb' }));
app.use(morgan('tiny'));

/* ── files ── */
const ROOT       = process.cwd();
const DB_FILE    = path.join(ROOT, 'db.json');
const VAR_FILE   = path.join(ROOT, 'variants.json');
const INDEX_FILE = path.join(ROOT, 'meta_index.json');

if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ wallets: {} }, null, 2));
if (!fs.existsSync(VAR_FILE)) fs.writeFileSync(VAR_FILE, '[]');

const variants     = JSON.parse(fs.readFileSync(VAR_FILE, 'utf8'));
const variantByKey = new Map(variants.map(v => [v.key, v]));

/* ── optional local metadata index (by ASCII NFT name) ── */
let NAME_INDEX = null; // { "0.2-LASERS_1": { variant, name, image, traits:{...}, ... }, ... }
function loadNameIndex() {
  if (!fs.existsSync(INDEX_FILE)) { NAME_INDEX = null; console.log('meta_index.json missing (optional)'); return; }
  try {
    const arr = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    NAME_INDEX = Object.fromEntries(arr.map(r => [String(r.name), r]));
    console.log(`Loaded meta_index.json with ${arr.length} rows.`);
  } catch (e) {
    console.warn('Failed to load meta_index.json:', e.message);
    NAME_INDEX = null;
  }
}
loadNameIndex();

/* ── caches ── */
const accCache  = new LRUCache({ max: 500,  ttl: 1000 * 30 });        // stake -> rows (30s)
const infoCache = new LRUCache({ max: 5000, ttl: 1000 * 60 * 60 });   // unit  -> info (1h)

/* ── helpers ── */
const hexToAscii = (hex) => {
  if (!hex) return '';
  try { return decodeURIComponent(hex.replace(/[0-9a-f]{2}/gi, '%$&')); }
  catch { return ''; }
};
const ipfs = (u) => u?.startsWith('ipfs://') ? ('https://cloudflare-ipfs.com/ipfs/' + u.slice(7)) : u;
const readDB  = () => JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
const writeDB = (d) => fs.writeFileSync(DB_FILE, JSON.stringify(d, null, 2));

/** Accept stake1…, addr1…, hex 28-byte stake key hash, or hex full address bytes. Return stake1… */
async function toStakeAddress(maybe) {
  if (!maybe) return null;

  // bech32 inputs
  if (maybe.startsWith('stake1')) return maybe;
  if (maybe.startsWith('addr1')) {
    const info = await api.addresses(maybe);
    return info?.stake_address || null;
  }

  // hex inputs
  const isHex = (s) => typeof s === 'string' && /^[0-9a-f]+$/i.test(s);
  if (!isHex(maybe)) return null;

  const bytes = Buffer.from(maybe, 'hex');

  // Case A: 28-byte stake key hash -> build reward address (header: 0b1110nnnn)
  if (bytes.length === 28) {
    const header = (14 << 4) | (NETWORK_ID & 0x0f);
    const reward = Buffer.concat([Buffer.from([header]), bytes]);
    return bech32.encode(NETWORK_ID === 1 ? 'stake' : 'stake_test', bech32.toWords(reward));
  }

  // Case B: full address bytes (payment or reward)
  if (bytes.length >= 29) {
    const type = bytes[0] >> 4;
    const net  = bytes[0] & 0x0f;
    const prefix =
      type === 14
        ? (net === 1 ? 'stake' : 'stake_test')
        : (net === 1 ? 'addr'  : 'addr_test');

    const bech = bech32.encode(prefix, bech32.toWords(bytes));
    if (bech.startsWith('stake1')) return bech;
    if (bech.startsWith('addr1')) {
      const info = await api.addresses(bech);
      return info?.stake_address || null;
    }
  }
  return null;
}

function matchVariantOnchain(v, info) {
  const attrs = info.onchain_metadata?.attributes
             || info.onchain_metadata?.traits
             || info.onchain_metadata
             || {};
  const slot = (attrs.slot || attrs.Slot || '').toString().trim();
  if (slot && slot.toUpperCase() === v.key.toUpperCase()) return true;

  const asciiName = hexToAscii(info.asset_name || '');
  if (asciiName && asciiName.toUpperCase().startsWith((v.key + '_').toUpperCase())) return true;

  return false;
}
function extractNumber(info, fallbackUnitTail = true) {
  const attrs = info.onchain_metadata?.attributes || info.onchain_metadata?.traits || {};
  if (attrs.STAMP != null) return String(attrs.STAMP);

  const ascii = hexToAscii(info.asset_name || '');
  const m = ascii.match(/_(\d{1,4})$/);
  if (m) return m[1];

  if (fallbackUnitTail && info.asset) return info.asset.slice(56);
  return '';
}
function resolveFromLocalByName(asciiName) {
  if (!NAME_INDEX) return null;
  const row = NAME_INDEX[asciiName];
  if (!row) return null;
  const image = ipfs(row.image);
  const number = row.traits?.STAMP || (asciiName.match(/_(\d{1,4})$/)?.[1] ?? '');
  const traitFlags = Object.keys(row.traits || {}).map(k => String(k).toLowerCase());
  return { variantKey: row.variant, name: asciiName, image, number, traitFlags };
}

/* ── core ── */
async function computeHoldings(stake, { force = false } = {}) {
  let rows = !force ? accCache.get(stake) : null;
  if (!rows) {
    rows = await api.accountsAddressesAssets(stake, { count: 100, page: 1 });
    for (let page = 2; rows.length === 100 * (page - 1); page++) {
      const next = await api.accountsAddressesAssets(stake, { count: 100, page });
      rows = rows.concat(next);
    }
    accCache.set(stake, rows);
  }

  const units = rows
    .map(r => r.asset || r.unit)
    .filter(Boolean)
    .filter(u => POLICY_ID ? u.startsWith(POLICY_ID) : true);

  const tallies = {};
  for (const v of variants) tallies[v.key] = { count: 0, traitFlags: new Set(), sampleImage: null };

  for (const unit of units) {
    let info = infoCache.get(unit);
    if (!info) { info = await api.assetsById(unit); infoCache.set(unit, info); }

    const ascii = hexToAscii(info.asset_name || '');
    const local = resolveFromLocalByName(ascii);

    for (const v of variants) {
      const match =
        (local && local.variantKey?.toUpperCase() === v.key.toUpperCase())
        || matchVariantOnchain(v, info);
      if (!match) continue;

      const t = tallies[v.key];
      t.count += 1;

      const attrs = info.onchain_metadata?.attributes || info.onchain_metadata?.traits || {};
      const detected = [];
      if (attrs.blood || /blood/i.test(String(attrs.trait || ''))) detected.push('blood');
      if (attrs.coffee || /coffee/i.test(String(attrs.trait || ''))) detected.push('coffee');
      if (attrs.flip   || attrs.flipped || /flip/i.test(String(attrs.trait || ''))) detected.push('flip');
      if (attrs.laser  || /laser/i.test(String(attrs.trait || ''))) detected.push('laser');

      const fixed = Array.isArray(v.traitIcons) ? v.traitIcons : [];
      [...detected, ...(local?.traitFlags || []), ...fixed]
        .forEach(x => t.traitFlags.add(String(x).toLowerCase()));

      const img = local?.image || ipfs(info.onchain_metadata?.image || info.metadata?.image);
      if (!t.sampleImage && img) t.sampleImage = img;
    }
  }

  for (const k in tallies) tallies[k].traitFlags = Array.from(tallies[k].traitFlags).slice(0, 3);
  return { units, tallies };
}

/* ── routes ── */
app.get('/health', (_req, res) => res.json({ ok: true, policy: POLICY_ID ? 'set' : 'unset' }));
app.get('/variants', (_req, res) => res.json(variants));
app.post('/index/reload', (_req, res) => { loadNameIndex(); res.json({ ok: true, rows: NAME_INDEX ? Object.keys(NAME_INDEX).length : 0 }); });

/** holdings: accept stake1 / addr1 / hex and normalize server-side */
app.get('/holdings/:addr', async (req, res) => {
  try {
    const raw   = req.params.addr;
    const force = String(req.query.force || '0') === '1';
    const stake = await toStakeAddress(raw);
    if (!stake) return res.status(400).json({ error: 'bad_address', detail: 'Need stake1/addr1/hex' });

    const { tallies } = await computeHoldings(stake, { force });

    const db = readDB();
    const now = new Date().toISOString();
    db.wallets[stake] = db.wallets[stake] || { reveals: [], first_seen: now };
    db.wallets[stake].last_seen = now;
    writeDB(db);

    const out = variants.map(v => ({
      key: v.key,
      name: v.name || v.key,
      cluster: v.cluster || null,
      count: tallies[v.key].count,
      sampleImage: tallies[v.key].sampleImage,
      traitFlags: tallies[v.key].traitFlags,
      revealed: db.wallets[stake].reveals.includes(v.key)
    }));

    res.json({ policy: POLICY_ID || null, variants: out });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'holdings_failed' });
  }
});

app.get('/assets/:addr/:variantKey', async (req, res) => {
  try {
    const { addr, variantKey } = req.params;
    const stake = await toStakeAddress(addr);
    if (!stake) return res.status(400).json({ error: 'bad_address' });

    const v = variantByKey.get(variantKey);
    if (!v) return res.status(404).json({ error: 'unknown_variant' });

    const { units } = await computeHoldings(stake);
    const items = [];

    for (const unit of units) {
      let info = infoCache.get(unit);
      if (!info) { info = await api.assetsById(unit); infoCache.set(unit, info); }

      const ascii = hexToAscii(info.asset_name || '');
      const local = resolveFromLocalByName(ascii);
      const match =
        (local && local.variantKey?.toUpperCase() === v.key.toUpperCase())
        || matchVariantOnchain(v, info);
      if (!match) continue;

      items.push({
        unit,
        name: local?.name || ascii || info.asset_name,
        image: local?.image || ipfs(info.onchain_metadata?.image || info.metadata?.image),
        number: local?.number || extractNumber(info)
      });
    }
    res.json({ variant: v.key, items });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'assets_failed' });
  }
});

app.post('/reveal', async (req, res) => {
  let { stake, variantKey } = req.body || {};
  if (!stake || !variantKey) return res.status(400).json({ error: 'missing_params' });

  const stakeAddr = await toStakeAddress(stake);
  if (!stakeAddr) return res.status(400).json({ error: 'bad_address' });
  if (!variantByKey.has(variantKey)) return res.status(404).json({ error: 'unknown_variant' });

  const db = readDB();
  const now = new Date().toISOString();
  const rec = db.wallets[stakeAddr] || { reveals: [], first_seen: now };
  if (!rec.reveals.includes(variantKey)) rec.reveals.push(variantKey);
  rec.last_seen = now;
  db.wallets[stakeAddr] = rec;
  writeDB(db);

  res.json({ ok: true, reveals: rec.reveals });
});

/* ── start ── */
app.listen(PORT, () => console.log(`stamps backend listening on :${PORT}`));
