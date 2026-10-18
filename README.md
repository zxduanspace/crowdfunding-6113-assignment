# Decentralized Crowdfunding DApp

An all-or-nothing crowdfunding platform built on the Ethereum Sepolia testnet. Creators set a funding goal and a deadline. Backers contribute ETH directly to a smart contract. After the deadline, the contract decides the outcome: the creator withdraws the funds if the goal was reached, otherwise every backer can reclaim their own contribution.

**Render link:** [`https://crowdfunding-6113-assignment.onrender.com`](https://crowdfunding-6113-assignment.onrender.com)

**Contract (Sepolia):** [`0xaC657734EB6aa70d3d8D2A1b2C012F1A9a812FDB`](https://sepolia.etherscan.io/address/0xaC657734EB6aa70d3d8D2A1b2C012F1A9a812FDB)

> Testnet project for coursework. The contract is not audited. Do not use it with real funds.

## Features

- Connect a MetaMask wallet, with automatic Sepolia network detection and switching
- Create campaigns with a title, goal (ETH) and duration (minutes, hours or days)
- Contribute, withdraw funds (creator) and claim refunds (backers)
- Live transaction status: waiting for signature, pending, confirmed, failed
- On-chain history with Etherscan links, filterable to the connected account
- Input validation in the frontend, the backend and the smart contract
- Readable error messages for contract reverts, rejected transactions and wrong networks

## Tech Stack

| Layer | Technology |
| --- | --- |
| Smart contract | Solidity ^0.8.24, OpenZeppelin `ReentrancyGuard` |
| Blockchain | Ethereum Sepolia testnet |
| Wallet | MetaMask |
| Frontend | HTML, CSS, JavaScript, ethers.js v6 |
| Backend | Node.js, Express, ethers.js |
| Database | SQLite (better-sqlite3), used as an event index |
| Deployment | Render, GitHub |

## How It Works

- **Writes:** the browser calls the contract through MetaMask. The user signs every transaction, so no private key is ever stored or handled by the app.
- **Reads:** the backend reads campaign state from the contract and serves history from SQLite, which it fills by polling the contract's event logs every 15 seconds.

## Project Structure

```
├── contracts/Crowdfunding.sol   # Smart contract
├── backend/
│   ├── server.js                # Express API, static hosting, event indexer
│   └── abi.js                   # Contract ABI (human-readable format)
├── frontend/
│   ├── index.html
│   ├── style.css
│   └── app.js                   # Wallet connection and contract calls
└── package.json
```

## Getting Started

**Prerequisites:** Node.js 20+, the MetaMask browser extension, and some Sepolia test ETH.

```bash
git clone [repository URL]
cd [repository folder]
npm install
```

Create a `.env` file in the project root:

```
RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
CONTRACT_ADDRESS=0xaC657734EB6aa70d3d8D2A1b2C012F1A9a812FDB
START_BLOCK=11899449
PORT=3000
```

Start the server and open http://localhost:3000:

```bash
npm start
```

## API

| Endpoint | Description |
| --- | --- |
| `GET /api/config` | Contract address, chain id and ABI |
| `GET /api/campaigns` | Current state of all campaigns, read from the contract |
| `GET /api/history?address=&campaignId=` | Indexed contract events, with optional filters |
| `POST /api/sync` | Triggers an immediate event sync |

## Smart Contract

| Function | Caller | Rule |
| --- | --- | --- |
| `createCampaign(title, goal, durationMinutes)` | Anyone | Title 1 to 100 bytes, goal above 0, duration 1 minute to 90 days |
| `contribute(id)` | Anyone | Before the deadline, value above 0 |
| `withdraw(id)` | Creator | After the deadline, goal reached, once only |
| `refund(id)` | Backer | After the deadline, goal not reached |

Security measures: `nonReentrant` on `withdraw` and `refund`, state updated before ETH is sent, pull-based refunds (no loops over backers), custom errors, and Solidity 0.8 checked arithmetic.

## Deployment on Render

1. Push the repository to GitHub.
2. Create a **Web Service** on Render from the repository.
3. Build command: `npm install`. Start command: `npm start`.
4. Set the environment variables `RPC_URL`, `CONTRACT_ADDRESS`, `START_BLOCK` and `NODE_VERSION=20`.

The free tier can sleep when idle and does not keep local files between restarts. The SQLite index is rebuilt from `START_BLOCK` on startup, because the blockchain is the source of truth.

## Limitations

- Testnet only, no audit
- No creator verification, no milestones, no early cancellation
- `/api/campaigns` reads every campaign on each request and has no pagination
- Relies on a public RPC endpoint that may rate-limit requests
