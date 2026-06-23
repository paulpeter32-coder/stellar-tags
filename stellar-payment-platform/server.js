const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { Horizon } = require('@stellar/stellar-sdk');
const PDFDocument = require('pdfkit');

const HORIZON_BASE = 'https://horizon-testnet.stellar.org';
const TX_HASH_RE = /^[a-fA-F0-9]{64}$/;

const app = express();
const PORT = process.env.PORT || 5000;


app.use(cors());
app.use(express.json());

const USER_DATABASE = {
  'client*localhost': 'GAPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ',
  'lekan*localhost': 'GAPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ',
};

const DEFAULT_FEDERATION_DOMAIN = 'localhost';

const normalizeNameTag = (value) => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) {
    return '';
  }

  return trimmed.includes('*') ? trimmed : `${trimmed}*${DEFAULT_FEDERATION_DOMAIN}`;
};

const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'registrations.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new sqlite3.Database(dbPath);
db.serialize(() => {
  db.run(
    `CREATE TABLE IF NOT EXISTS username_registry (
      username TEXT PRIMARY KEY,
      address TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
  );
});

app.get('/federation', (req, res) => {
  const nameTag = normalizeNameTag(req.query.q);

  if (!nameTag) {
    return res.status(400).json({ detail: "Missing 'q' parameter" });
  }

  db.get(
    'SELECT address FROM username_registry WHERE username = ?',
    [nameTag],
    (error, row) => {
      if (error) {
        return res.status(500).json({ detail: 'Database lookup failed' });
      }

      const address = row?.address || USER_DATABASE[nameTag];
      if (!address) {
        return res.status(404).json({ detail: 'Name tag not found' });
      }

      return res.json({
        stellar_address: address,
        account_id: address,
        memo_type: 'text',
        memo: 'PlatformPayment',
      });
    },
  );
});

app.post('/register', (req, res) => {
  const username = normalizeNameTag(req.body.username);
  const address = typeof req.body.address === 'string' ? req.body.address.trim() : '';

  if (!username || !address) {
    return res.status(400).json({ detail: 'username and address are required' });
  }

  db.get(
    'SELECT username FROM username_registry WHERE address = ?',
    [address],
    (lookupError, row) => {
      if (lookupError) {
        return res.status(500).json({ detail: 'Database lookup failed' });
      }

      if (row) {
        return res.status(409).json({ detail: 'Address already registered' });
      }

      db.run(
        'INSERT INTO username_registry (username, address, created_at) VALUES (?, ?, ?)',
        [username, address, new Date().toISOString()],
        (error) => {
          if (error) {
            if (error.message && error.message.includes('UNIQUE')) {
              return res.status(409).json({ detail: 'Username already registered' });
            }

            return res.status(500).json({ detail: 'Failed to save registration' });
          }

          return res.json({ ok: true, username, address });
        },
      );
    },
  );
});

app.get('/lookup', (req, res) => {
  const address = typeof req.query.address === 'string' ? req.query.address.trim() : '';

  if (!address) {
    return res.status(400).json({ detail: "Missing 'address' parameter" });
  }

  db.get(
    'SELECT username FROM username_registry WHERE address = ?',
    [address],
    (error, row) => {
      if (error) {
        return res.status(500).json({ detail: 'Database lookup failed' });
      }

      if (!row) {
        return res.status(404).json({ detail: 'Username not found for this address' });
      }

      return res.json({ username: row.username, address });
    },
  );
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/v1/receipts/:txHash', async (req, res) => {
  const { txHash } = req.params;

  if (!TX_HASH_RE.test(txHash)) {
    return res.status(400).json({ detail: 'Invalid transaction hash format' });
  }

  let tx;
  let paymentOps;

  try {
    const server = new Horizon.Server(HORIZON_BASE);
    [tx, paymentOps] = await Promise.all([
      server.transactions().transaction(txHash).call(),
      server.payments().forTransaction(txHash).call(),
    ]);
  } catch (err) {
    if (err && err.response && err.response.status === 404) {
      return res.status(404).json({ detail: 'Transaction not found' });
    }
    return res.status(500).json({ detail: 'Failed to fetch transaction' });
  }

  const timestamp = tx.created_at
    ? new Date(tx.created_at).toUTCString()
    : 'Unknown';

  const nativeOp = (paymentOps.records || []).find(
    (op) => op.asset_type === 'native',
  );

  const sender = nativeOp ? nativeOp.from : tx.source_account;
  const receiver = nativeOp ? nativeOp.to : 'Contract invocation';
  const amount = nativeOp ? `${nativeOp.amount} XLM` : 'See Stellar Explorer';

  const safeHash = txHash.replace(/[^a-fA-F0-9]/g, '');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="receipt-${safeHash}.pdf"`,
  );

  const doc = new PDFDocument({ margin: 50 });
  doc.pipe(res);

  doc
    .fontSize(20)
    .text('Stellar Transaction Receipt', { align: 'center' })
    .moveDown(1.5);

  doc.fontSize(11).text(`Transaction Hash: ${txHash}`).moveDown(0.5);
  doc.text(`Timestamp:        ${timestamp}`).moveDown(0.5);
  doc.text(`Sender:           ${sender}`).moveDown(0.5);
  doc.text(`Receiver:         ${receiver}`).moveDown(0.5);
  doc.text(`Amount:           ${amount}`).moveDown(1.5);

  doc.fontSize(9).fillColor('#888888').text('Generated by Stellar Pay — Testnet', {
    align: 'center',
  });

  doc.end();
});

if (require.main === module) {
    const server = app.listen(PORT, '0.0.0.0', () => {
        console.log(`Server successfully initialized on port ${PORT}`);
    });

    // This catches any weird cloud port errors and prevents a hard crash
    server.on('error', (e) => {
        if (e.code === 'EADDRINUSE') {
            console.error(`Port ${PORT} is in use, forcing shutdown so Railway can restart cleanly.`);
            process.exit(1);
        }
    });
}

module.exports = app;
