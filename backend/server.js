require('dotenv').config();
const path = require('path');
const express = require('express');
const { ethers } = require('ethers');
const Database = require('better-sqlite3');
const abi = require('./abi');

const { RPC_URL, CONTRACT_ADDRESS, START_BLOCK } = process.env;
const PORT = process.env.PORT || 3000;
if (!RPC_URL || !ethers.isAddress(CONTRACT_ADDRESS || '') || !/^\d+$/.test(START_BLOCK || '')) {
  console.error('请检查 .env：RPC_URL / CONTRACT_ADDRESS / START_BLOCK');
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const contract = new ethers.Contract(CONTRACT_ADDRESS, abi, provider);

// ---------- SQLite：缓存链上事件，用于历史记录 ----------
const db = new Database(process.env.DB_PATH || path.join(__dirname, 'data.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    tx_hash TEXT, log_index INTEGER, block_number INTEGER, timestamp INTEGER,
    type TEXT, campaign_id INTEGER, account TEXT, amount TEXT, extra TEXT,
    PRIMARY KEY (tx_hash, log_index)
  );
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`);

let syncing = null;
function sync() {
  if (!syncing) {
    syncing = doSync()
      .catch((e) => console.error('同步失败:', e.shortMessage || e.message))
      .finally(() => { syncing = null; });
  }
  return syncing;
}

async function doSync() {
  const latest = await provider.getBlockNumber();
  const row = db.prepare("SELECT value FROM meta WHERE key='last_block'").get();
  let from = row ? Number(row.value) + 1 : Number(START_BLOCK);
  const insert = db.prepare('INSERT OR IGNORE INTO events VALUES (?,?,?,?,?,?,?,?,?)');
  const tsCache = new Map();

  while (from <= latest) {
    const to = Math.min(from + 1999, latest); // 分批查询，避免公共节点限制
    const logs = await contract.queryFilter('*', from, to);
    for (const l of logs) {
      if (!l.eventName) continue;
      if (!tsCache.has(l.blockNumber)) {
        tsCache.set(l.blockNumber, (await provider.getBlock(l.blockNumber)).timestamp);
      }
      const a = l.args;
      const isCreate = l.eventName === 'CampaignCreated';
      const byCreator = isCreate || l.eventName === 'Withdrawn';
      insert.run(
        l.transactionHash, l.index, l.blockNumber, tsCache.get(l.blockNumber),
        l.eventName, Number(a.id),
        byCreator ? a.creator : a.backer,
        (isCreate ? a.goal : a.amount).toString(),
        isCreate ? JSON.stringify({ title: a.title, deadline: Number(a.deadline) }) : null
      );
    }
    db.prepare("INSERT OR REPLACE INTO meta VALUES ('last_block', ?)").run(String(to));
    from = to + 1;
  }
}

// ---------- API ----------
const app = express();
app.use(express.json());

// 前端从这里拿合约地址和 ABI，保证只维护一份
app.get('/api/config', (req, res) => {
  res.json({ contractAddress: CONTRACT_ADDRESS, chainId: 11155111, chainName: 'Sepolia', abi });
});

// 项目列表：直接读链上最新状态
app.get('/api/campaigns', async (req, res) => {
  try {
    const count = Number(await contract.campaignCount());
    const list = await Promise.all(
      [...Array(count).keys()].map(async (id) => {
        const c = await contract.campaigns(id);
        return {
          id, creator: c.creator, title: c.title,
          goal: c.goal.toString(), deadline: Number(c.deadline),
          raised: c.raised.toString(), withdrawn: c.withdrawn,
        };
      })
    );
    res.json(list.reverse());
  } catch (e) {
    console.error(e.shortMessage || e.message);
    res.status(502).json({ error: '读取链上数据失败，请稍后重试' });
  }
});

// 交易历史：可按地址、项目筛选，带输入验证
app.get('/api/history', (req, res) => {
  const { address, campaignId } = req.query;
  const where = [];
  const params = [];

  if (address !== undefined) {
    if (typeof address !== 'string' || !ethers.isAddress(address)) {
      return res.status(400).json({ error: '地址格式无效' });
    }
    where.push('LOWER(account)=?');
    params.push(address.toLowerCase());
  }
  if (campaignId !== undefined) {
    if (typeof campaignId !== 'string' || !/^\d+$/.test(campaignId)) {
      return res.status(400).json({ error: 'campaignId 无效' });
    }
    where.push('campaign_id=?');
    params.push(Number(campaignId));
  }

  const sql = `SELECT * FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY block_number DESC, log_index DESC LIMIT 100`;
  res.json(db.prepare(sql).all(...params));
});

// 交易确认后，前端调用它立即刷新历史
app.post('/api/sync', async (req, res) => {
  await sync();
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, '..', 'frontend')));

sync();
setInterval(sync, 15000);
app.listen(PORT, () => console.log(`服务已启动：http://localhost:${PORT}`));