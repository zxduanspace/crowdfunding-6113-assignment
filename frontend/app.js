const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (a) => a.slice(0, 6) + '…' + a.slice(-4);
const ETHERSCAN = 'https://sepolia.etherscan.io';

let config, provider, signer, account, contract;
const txs = [];

// ---------- Toasts & error handling ----------
function toast(msg, type = 'ok') {
  const t = $('toast');
  t.textContent = msg;
  t.className = type;
  t.style.display = 'block';
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.style.display = 'none'), 4500);
}

const ERR = {
  AlreadyWithdrawn: 'Funds have already been withdrawn',
  CampaignEnded: 'This campaign has ended and no longer accepts contributions',
  CampaignNotEnded: 'This campaign has not ended yet',
  CampaignNotFound: 'Campaign not found',
  GoalNotReached: 'The funding goal was not reached, so funds cannot be withdrawn',
  GoalReached: 'The goal was reached, so refunds are not available',
  InvalidInput: 'Invalid input',
  NotCreator: 'Only the campaign creator can withdraw funds',
  NothingToRefund: 'You have no contribution to refund in this campaign',
  TransferFailed: 'ETH transfer failed',
  ReentrancyGuardReentrantCall: 'Reentrant call detected and blocked',
};

function parseError(e) {
  if (e.code === 'ACTION_REJECTED') return 'You rejected the transaction in MetaMask';
  if (e.code === 'INSUFFICIENT_FUNDS') return 'Insufficient ETH balance (amount plus gas fee)';
  if (e.revert && ERR[e.revert.name]) return ERR[e.revert.name];
  if (e.code === 'NETWORK_ERROR') return 'Network error, please check your connection';
  return e.shortMessage || e.message || 'Unknown error';
}

// ---------- Wallet connection ----------
async function switchToSepolia() {
  try {
    await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0xaa36a7' }] });
  } catch {
    toast('Please switch MetaMask to the Sepolia test network manually', 'error');
  }
}

async function connect(prompt = true) {
  if (!window.ethereum) return toast('MetaMask not detected. Please install the browser extension.', 'error');
  try {
    if (prompt) await window.ethereum.request({ method: 'eth_requestAccounts' });
    provider = new ethers.BrowserProvider(window.ethereum);
    const net = await provider.getNetwork();
    if (net.chainId !== BigInt(config.chainId)) {
      $('network').textContent = 'Wrong network';
      $('network').className = 'badge bad';
      toast('Not on Sepolia. Please switch networks.', 'error');
      return switchToSepolia(); // the page reloads on chainChanged
    }
    signer = await provider.getSigner();
    account = await signer.getAddress();
    contract = new ethers.Contract(config.contractAddress, config.abi, signer);
    $('network').textContent = config.chainName;
    $('network').className = 'badge ok';
    $('account').textContent = short(account);
    $('connectBtn').textContent = 'Connected';
    $('connectBtn').disabled = true;
    await refresh();
  } catch (e) {
    toast(parseError(e), 'error');
  }
}

// ---------- Sending transactions & status ----------
function renderTxs() {
  $('txList').innerHTML = txs.length
    ? txs.map((t) => {
        const badge = {
          waiting: ['warn', 'Waiting for signature'],
          pending: ['warn', 'Pending…'],
          confirmed: ['ok', 'Confirmed'],
          failed: ['bad', 'Failed'],
        }[t.status];
        const link = t.hash ? `<a href="${ETHERSCAN}/tx/${esc(t.hash)}" target="_blank" rel="noopener">${esc(short(t.hash))}</a>` : '';
        return `<li><span class="badge ${badge[0]}">${badge[1]}</span><span>${esc(t.label)}</span>${link}<span class="muted">${esc(t.msg || '')}</span></li>`;
      }).join('')
    : '<li class="muted">No transactions yet</li>';
}

async function sendTx(label, fn) {
  if (!contract) return toast('Please connect MetaMask first', 'error');
  const item = { label, status: 'waiting', hash: '', msg: '' };
  txs.unshift(item);
  renderTxs();
  try {
    const tx = await fn();
    item.hash = tx.hash;
    item.status = 'pending';
    renderTxs();
    const receipt = await tx.wait();
    item.status = receipt.status === 1 ? 'confirmed' : 'failed';
    renderTxs();
    toast(`${label}: confirmed`);
    await fetch('/api/sync', { method: 'POST' }); // ask the backend to index new events now
    await refresh();
    return true;
  } catch (e) {
    item.status = 'failed';
    item.msg = parseError(e);
    renderTxs();
    toast(item.msg, 'error');
    return false;
  }
}

// ---------- Campaign list ----------
function timeLeft(deadline) {
  const s = deadline - Math.floor(Date.now() / 1000);
  if (s <= 0) return 'Ended';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return `Ends in ${d ? d + 'd ' : ''}${h ? h + 'h ' : ''}${m}m`;
}

async function loadCampaigns() {
  const box = $('campaigns');
  let list;
  try {
    const res = await fetch('/api/campaigns');
    if (!res.ok) throw new Error((await res.json()).error);
    list = await res.json();
  } catch (e) {
    box.innerHTML = `<p class="muted">Failed to load: ${esc(e.message)}</p>`;
    return;
  }
  if (!list.length) {
    box.innerHTML = '<p class="muted">No campaigns yet. Create the first one!</p>';
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const mine = account
    ? await Promise.all(list.map((c) => contract.contributions(c.id, account).catch(() => 0n)))
    : list.map(() => 0n);

  box.innerHTML = list.map((c, i) => {
    const goal = BigInt(c.goal), raised = BigInt(c.raised);
    const ended = now >= c.deadline, reached = raised >= goal;
    const pctBig = (raised * 100n) / goal;
    const pct = Number(pctBig > 100n ? 100n : pctBig);
    const [cls, text] = !ended ? ['warn', 'Active']
      : reached ? (c.withdrawn ? ['ok', 'Withdrawn'] : ['ok', 'Successful'])
      : ['bad', 'Failed'];
    const isCreator = account && c.creator.toLowerCase() === account.toLowerCase();

    let actions = '';
    if (!ended) {
      actions = `<input id="amt-${c.id}" type="number" step="any" min="0" placeholder="Amount (ETH)">
                 <button data-action="contribute" data-id="${c.id}">Contribute</button>`;
    } else if (reached && !c.withdrawn && isCreator) {
      actions = `<button class="green" data-action="withdraw" data-id="${c.id}">Withdraw funds</button>`;
    } else if (!reached && mine[i] > 0n) {
      actions = `<button class="orange" data-action="refund" data-id="${c.id}">Claim refund (${ethers.formatEther(mine[i])} ETH)</button>`;
    }

    return `<div class="campaign">
      <div><span class="badge ${cls}">${text}</span> <span class="meta">#${c.id}</span></div>
      <h3>${esc(c.title)}</h3>
      <div class="bar"><div style="width:${pct}%"></div></div>
      <div class="meta">Raised ${ethers.formatEther(raised)} / ${ethers.formatEther(goal)} ETH (${pct}%)</div>
      <div class="meta">${timeLeft(c.deadline)} · Creator ${esc(short(c.creator))}${isCreator ? ' (you)' : ''}</div>
      ${mine[i] > 0n ? `<div class="meta">My contribution: ${ethers.formatEther(mine[i])} ETH</div>` : ''}
      <div class="actions">${actions}</div>
    </div>`;
  }).join('');
}

// ---------- History ----------
const TYPE = { CampaignCreated: 'Created', Contributed: 'Contributed', Withdrawn: 'Withdrawn', Refunded: 'Refunded' };

async function loadHistory() {
  const q = $('onlyMine').checked && account ? `?address=${account}` : '';
  try {
    const res = await fetch('/api/history' + q);
    if (!res.ok) throw new Error((await res.json()).error);
    const rows = await res.json();
    $('history').innerHTML = rows.length
      ? rows.map((r) => `<tr>
          <td>${new Date(r.timestamp * 1000).toLocaleString('en-GB')}</td>
          <td>${TYPE[r.type] || esc(r.type)}</td>
          <td>#${r.campaign_id}</td>
          <td>${esc(short(r.account))}</td>
          <td>${ethers.formatEther(r.amount)}${r.type === 'CampaignCreated' ? ' (goal)' : ''}</td>
          <td><a href="${ETHERSCAN}/tx/${esc(r.tx_hash)}" target="_blank" rel="noopener">${esc(short(r.tx_hash))}</a></td>
        </tr>`).join('')
      : '<tr><td colspan="6" class="muted">No records yet</td></tr>';
  } catch (e) {
    $('history').innerHTML = `<tr><td colspan="6" class="muted">Failed to load: ${esc(e.message)}</td></tr>`;
  }
}

async function refresh() {
  await Promise.all([loadCampaigns(), loadHistory()]);
}

// ---------- Event listeners ----------
$('connectBtn').addEventListener('click', () => connect(true));
$('refreshBtn').addEventListener('click', refresh);
$('onlyMine').addEventListener('change', loadHistory);

$('createForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = $('title').value.trim();
  if (!title || title.length > 100) return toast('Title must be 1–100 characters', 'error');

  let goal;
  try { goal = ethers.parseEther($('goal').value); } catch { return toast('Invalid funding goal', 'error'); }
  if (goal <= 0n) return toast('Funding goal must be greater than 0', 'error');

  const minutes = Number($('duration').value) * Number($('unit').value);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 129600) {
    return toast('Duration must be a whole number between 1 minute and 90 days', 'error');
  }
  if (await sendTx(`Create campaign "${title}"`, () => contract.createCampaign(title, goal, minutes))) e.target.reset();
});

$('campaigns').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const id = Number(btn.dataset.id);

  if (btn.dataset.action === 'contribute') {
    let amount;
    try { amount = ethers.parseEther($(`amt-${id}`).value); } catch { return toast('Invalid contribution amount', 'error'); }
    if (amount <= 0n) return toast('Contribution must be greater than 0', 'error');
    await sendTx(`Contribute ${ethers.formatEther(amount)} ETH to #${id}`, () => contract.contribute(id, { value: amount }));
  } else if (btn.dataset.action === 'withdraw') {
    await sendTx(`Withdraw funds from #${id}`, () => contract.withdraw(id));
  } else if (btn.dataset.action === 'refund') {
    await sendTx(`Claim refund from #${id}`, () => contract.refund(id));
  }
});

// ---------- Startup ----------
(async function init() {
  try {
    config = await (await fetch('/api/config')).json();
  } catch {
    return toast('Cannot reach the backend service', 'error');
  }
  if (window.ethereum) {
    window.ethereum.on('accountsChanged', () => location.reload());
    window.ethereum.on('chainChanged', () => location.reload());
    const accounts = await window.ethereum.request({ method: 'eth_accounts' });
    if (accounts.length) return connect(false); // auto-connect if already authorized
  }
  await refresh();
})();