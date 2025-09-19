import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import fs from 'fs';
import path from 'path';
import LRU from 'lru-cache';
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
const DB_FILE = path.join(ROOT, 'db.json');
const VAR_FILE = path.join(ROOT, 'variants.json');

if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ wallets: {} }, null, 2));
const variants = JSON.parse(fs.readFileSync(VAR_FILE, 'utf8'));
const variantByKey = new Map(variants.map(v => [v.key, v]));

/* --- caches --- */
const accCache  = new LRU({ max: 500,  ttl: 1000*60*5  });  // 5 min
const infoCache = new LRU({ max: 5000, ttl: 1000*60*60 });  // 1 hour

/* --- helpers --- */
const hexToAscii = (hex) => {
  if (!hex) return '';
  try { return decodeURIComponent(hex.replace(/[0-9a-f]{2}/gi, '%$&')); }
  catch { return ''; }
};
const ipfs = (u) => u && u.startsWith('ipfs://') ? 'https://cloudflare-ipfs.com/ipfs/' + u.slice(7) : u;

const readDB  = () => JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
const writeDB = (d) => fs.writeFileSync(DB_FILE, JSON.stringify(d, null, 2));

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

  // else try suffix of name: FAMILY_### or FAMILY_## 
  const ascii = hexToAscii(info.asset_name || '');
  const m = ascii.match(/_(\d{1,4})$/);
  if (m) return m[1];

  if (fallbackUnitTail && info.asset) return info.asset.slice(56);
  return '';
}

/* --- core: compute holdings --- */
async function computeHoldings(stake) {
  // 1) list all assets under this account
  let rows = accCache.get(stake);
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
    .filter(u => POLICY_ID ? u.startsWith(POLICY_ID) : true);

  // 3) tallies per variant
  const tallies = {};
  for (const v of variants) tallies[v.key] = { count: 0, traitFlags: new Set(), sampleImage: null };

  for (const unit of units) {
    let info = infoCache.get(unit);
    if (!info) { info = await api.assetsById(unit); infoCache.set(unit, info); }

    for (const v of variants) {
      if (!matchVariant(v, info)) continue;

      const t = tallies[v.key];
      t.count += 1;

      const attrs = info.onchain_metadata?.attributes || {};
      // auto-detect a few booleans/names used in your UI; normalize to lowercase keys
      const detected = [];
      if (attrs.blood || /blood/i.test(String(attrs.trait || ''))) detected.push('blood');
      if (attrs.coffee || /coffee/i.test(String(attrs.trait || ''))) detected.push('coffee');
      if (attrs.flip   || attrs.flipped || /flip/i.test(String(attrs.trait || ''))) detected.push('flip');
      if (attrs.laser  || /laser/i.test(String(attrs.trait || ''))) detected.push('laser');

      // include variant-level always-on icons if defined
      const fixed = Array.isArray(v.traitIcons) ? v.traitIcons : [];
      [...detected, ...fixed].forEach(x => t.traitFlags.add(String(x).toLowerCase()));

      const img = ipfs(info.onchain_metadata?.image || info.metadata?.image);
      if (!t.sampleImage && img) t.sampleImage = img;
    }
  }

  // convert sets → arrays
  for (const k in tallies) tallies[k].traitFlags = Array.from(tallies[k].traitFlags).slice(0, 3);

  return { units, tallies };
}

/* --- routes --- */
app.get('/health', (_req, res) => res.json({ ok: true, policy: POLICY_ID ? 'set' : 'unset' }));

/**
 * GET /holdings/:stake
 * -> { policy, variants: [{key, name?, cluster?, count, revealed, sampleImage, traitFlags}] }
 */
app.get('/holdings/:stake', async (req, res) => {
  try {
    const stake = req.params.stake;
    const { tallies } = await computeHoldings(stake);

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
 * GET /assets/:stake/:variantKey
 * -> { variant, items: [{ unit, name, image, number }] }
 */
app.get('/assets/:stake/:variantKey', async (req, res) => {
  try {
    const { stake, variantKey } = req.params;
    const v = variantByKey.get(variantKey);
    if (!v) return res.status(404).json({ error: 'unknown_variant' });

    const { units } = await computeHoldings(stake);
    const items = [];

    for (const unit of units) {
      let info = infoCache.get(unit);
      if (!info) { info = await api.assetsById(unit); infoCache.set(unit, info); }
      if (!matchVariant(v, info)) continue;

      items.push({
        unit,
        name: hexToAscii(info.asset_name || '') || info.asset_name,
        image: ipfs(info.onchain_metadata?.image || info.metadata?.image),
        number: extractNumber(info)
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
 */
app.post('/reveal', (req, res) => {
  const { stake, variantKey } = req.body || {};
  if (!stake || !variantKey) return res.status(400).json({ error: 'missing_params' });
  if (!variantByKey.has(variantKey)) return res.status(404).json({ error: 'unknown_variant' });

  const db = readDB();
  const now = new Date().toISOString();
  const rec = db.wallets[stake] || { reveals: [], first_seen: now };
  if (!rec.reveals.includes(variantKey)) rec.reveals.push(variantKey);
  rec.last_seen = now;
  db.wallets[stake] = rec;
  writeDB(db);

  res.json({ ok: true, reveals: rec.reveals });
});

/* --- start --- */
app.listen(PORT, () => {
  console.log(`stamps backend listening on :${PORT}`);
});
