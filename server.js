import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import fs from 'fs';
import path from 'path';
import { LRUCache } from 'lru-cache';
import { BlockFrostAPI } from '@blockfrost/blockfrost-js';

const app = express();

/* --- config --- */
const PORT = Number(process.env.PORT || 3005);
const POLICY_ID = (process.env.POLICY_ID || '').trim(); // 56-char hex
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const api = new BlockFrostAPI({ projectId: process.env.BLOCKFROST_KEY });

/* --- middleware --- */
app.use(cors({ origin: CORS_ORIGIN }));
app.use(helmet());
app.use(express.json({ limit: '1mb' }));
app.use(morgan('tiny'));

/* --- files --- */
const ROOT = process.cwd();
const DB_FILE  = path.join(ROOT, 'db.json');
const VAR_FILE = path.join(ROOT, 'variants.json');
const INDEX_FILE = path.join(ROOT, 'meta_index.json'); // optional local index by asset name

if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ wallets: {} }, null, 2));
const variants = JSON.parse(fs.readFileSync(VAR_FILE, 'utf8'));
const variantByKey = new Map(variants.map(v => [v.key, v]));

/* --- optional local metadata index (by asset name) --- */
let NAME_INDEX = null; // { "FAMILY_001": { variant, name, image, traits:{...} } ... }

function loadNameIndex() {
  if (!fs.existsSync(INDEX_FILE)) { NAME_INDEX = null; return; }
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

/* --- caches --- */
const accCache  = new LRUCache({ max: 500,  ttl: 1000 * 30 });        // stake -> asset rows (30s)
const infoCache = new LRUCache({ max: 5000, ttl: 1000 * 60 * 60 });   // unit  -> metadata (1h)

/* --- helpers --- */
const hexToAscii = (hex) => {
  if (!hex) return '';
  try { return decodeURIComponent(hex.replace(/[0-9a-f]{2}/gi, '%$&')); }
  catch { return ''; }
};
const ipfs = (u) => u && u.startsWith('ipfs://') ? 'https://cloudflare-ipfs.com/ipfs/' + u.slice(7) : u;

const readDB  = () => JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
const writeDB = (d) => fs.writeFileSync(DB_FILE, JSON.stringify(d, null, 2));

/**
 * Accept stake1… or addr1… and convert to stake address for Blockfrost account endpoints.
 */
async function toStakeAddress(maybe) {
  if (!maybe) return null;
  if (maybe.startsWith('stake1')) return maybe;
  if (maybe.startsWith('addr1')) {
    const info = await api.addresses(maybe);
    return info?.stake_address || null;
  }
  return null;
}

function matchVariant(v, info) {
  // A) attributes.slot
  const attrs = info.onchain_metadata?.attributes || info.onchain_metadata?.traits || info.onchain_metadata || {};
  const slot = (attrs.slot || attrs.Slot || '').toString().trim();
  if (slot && slot.toUpperCase() === v.key.toUpperCase()) return true;

  // B) name prefix up to underscore
  const asciiName = hexToAscii(info.asset_name || '');
  if (asciiName && asciiName.toUpperCase().startsWith((v.key + '_').toUpperCase())) return true;

  return false;
}

function extractNumber(info, fallbackUnitTail = true) {
  // prefer traits.STAMP if present
  const attrs = info.onchain_metadata?.attributes || {};
  if (attrs.STAMP != null) return String(attrs.STAMP);

  // else try suffix of name: FAMILY_### or FAMILY_####
  const ascii = hexToAscii(info.asset_name || '');
  const m = ascii.match(/_(\d{1,4})$/);
  if (m) return m[1];

  if (fallbackUnitTail && info.asset) return info.asset.slice(56);
  return '';
}

/** Try to resolve from local NAME_INDEX (by ASCII asset name) */
function resolveFromLocalByName(asciiName) {
  if (!NAME_INDEX) return null;
  const row = NAME_INDEX[asciiName];
  if (!row) return null;
  const image = row.image?.startsWith('ipfs://') ? 'https://cloudflare-ipfs.com/ipfs/' + row.image.slice(7) : row.image;
  const number = row.traits?.STAMP || (asciiName.match(/_(\d{1,4})$/)?.[1] ?? '');
  const traitFlags = Object.keys(row.traits || {}).map(k => String(k).toLowerCase());
  return {
    variantKey: row.variant,
    name: asciiName,
    image,
    number,
    traitFlags,
  };
}

/* --- core: compute holdings --- */
async function computeHoldings(stake, { force = false } = {}) {
  // 1) list all assets under this account (stake address)
  let rows = !force ? accCache.get(stake) : null;
  if (!rows) {
    rows = await api.accountsAddressesAssets(stake, { count: 100, page: 1 });
    let page = 1;
    while (rows.length === 100 * page) {
      page++;
      const next = await api.accountsAddressesAssets(stake, { count: 100, page });
      rows = rows.concat(next);
    }
    accCache.set(stake, rows);
  }

  // 2) filter to our policy units
  const units = rows
    .map(r => r.asset || r.unit)
    .filter(Boolean)
    .filter(u => (POLICY_ID ? u.startsWith(POLICY_ID) : true));

  // 3) tallies per variant
  const tallies = {};
  for (const v of variants) tallies[v.key] = { count: 0, traitFlags: new Set(), sampleImage: null };

  for (const unit of units) {
    let info = infoCache.get(unit);
    if (!info) { info = await api.assetsById(unit); infoCache.set(unit, info); }

    // Prefer local index by asset_name if available
    const ascii = hexToAscii(info.asset_name || '');
    const local = resolveFromLocalByName(ascii);

    for (const v of variants) {
      const familyMatch =
        (local && local.variantKey?.toUpperCase() === v.key.toUpperCase())
        || matchVariant(v, info);

      if (!familyMatch) continue;

      const t = tallies[v.key];
      t.count += 1;

      // trait flags
      const attrs = info.onchain_metadata?.attributes || {};
      const detected = [];
      if (attrs.blood || /blood/i.test(String(attrs.trait || ''))) detected.push('blood');
      if (attrs.coffee || /coffee/i.test(String(attrs.trait || ''))) detected.push('coffee');
      if (attrs.flip   || attrs.flipped || /flip/i.test(String(attrs.trait || ''))) detected.push('flip');
      if (attrs.laser  || /laser/i.test(String(attrs.trait || ''))) detected.push('laser');
      // include local traits + variant-level always-on icons
      const fixed = Array.isArray(v.traitIcons) ? v.traitIcons : [];
      [...detected, ...(local?.traitFlags || []), ...fixed]
        .forEach(x => t.traitFlags.add(String(x).toLowerCase()));

      // sample image
      const img = local?.image || ipfs(info.onchain_metadata?.image || info.metadata?.image);
      if (!t.sampleImage && img) t.sampleImage = img;
    }
  }

  // convert sets → arrays
  for (const k in tallies) tallies[k].traitFlags = Array.from(tallies[k].traitFlags).slice(0, 3);

  return { units, tallies };
}

/* --- routes --- */
app.get('/health', (_req, res) => res.json({ ok: true, policy: POLICY_ID ? 'set' : 'unset' }));

/** expose variants.json so the frontend can read config if needed */
app.get('/variants', (_req, res) => res.json(variants));

/** reload local meta index without restart */
app.post('/index/reload', (_req, res) => {
  loadNameIndex();
  res.json({ ok: true, rows: NAME_INDEX ? Object.keys(NAME_INDEX).length : 0 });
});

/**
 * GET /holdings/:addr
 * Accepts stake1… OR addr1…; returns:
 * { policy, variants: [{key, name?, cluster?, count, revealed, sampleImage, traitFlags}] }
 */
app.get('/holdings/:addr', async (req, res) => {
  try {
    const raw = req.params.addr;
    const force = String(req.query.force || '0') === '1';
    const stake = await toStakeAddress(raw);
    if (!stake) return res.status(400).json({ error: 'bad_address', detail: 'Need stake1… or addr1…' });

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

/**
 * GET /assets/:addr/:variantKey
 * -> { variant, items: [{ unit, name, image, number }] }
 * Accepts stake1… OR addr1…
 */
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

      // prefer local mapping by asset_name
      const asciiName = hexToAscii(info.asset_name || '');
      const local = resolveFromLocalByName(asciiName);
      const familyMatch =
        (local && local.variantKey?.toUpperCase() === v.key.toUpperCase())
        || matchVariant(v, info);

      if (!familyMatch) continue;

      items.push({
        unit,
        name: local?.name || asciiName || info.asset_name,
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

/**
 * POST /reveal
 * body: { stake, variantKey }
 * persists a “revealed” flag for this wallet + variant
 * (stake may be stake1… or addr1…; we normalize and persist by stake address)
 */
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

/* --- start --- */
app.listen(PORT, () => {
  console.log(`stamps backend listening on :${PORT}`);
});
