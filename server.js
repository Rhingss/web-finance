import "dotenv/config";
import express from "express";
import OpenAI from "openai";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
const port = process.env.PORT || 3000;
const projectDir = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(projectDir, "data");
const dataFile = path.join(dataDir, "rapi-data.json");
const defaultBudgets = { Makanan: 800000, Transportasi: 400000, Belanja: 500000, Tagihan: 600000, Hiburan: 250000 };
let mutationQueue = Promise.resolve();

if (!process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY belum diatur di file .env");
  process.exit(1);
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(express.json({ limit: "200kb" }));
// index.html berada satu folder dengan server.js di proyek ini.
app.get("/", (_req, res) => {
  res.sendFile(path.join(projectDir, "index.html"));
});

// Batasi permintaan yang mengubah data atau memakai AI; polling data tidak dihitung.
const requests = new Map();
app.use("/api/", (req, res, next) => {
  if (req.method === "GET" && req.path === "/data") return next();
  const key = req.ip;
  const now = Date.now();
  const recent = (requests.get(key) || []).filter(time => now - time < 60_000);
  if (recent.length >= 30) return res.status(429).json({ error: "Terlalu banyak permintaan. Coba lagi sebentar." });
  recent.push(now);
  requests.set(key, recent);
  next();
});

async function readFinanceData() {
  try {
    const stored = JSON.parse(await readFile(dataFile, "utf8"));
    return {
      initialized: true,
      transactions: Array.isArray(stored.transactions) ? stored.transactions : [],
      budgets: stored.budgets && typeof stored.budgets === "object" ? stored.budgets : defaultBudgets
    };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { initialized: false, transactions: [], budgets: defaultBudgets };
  }
}

async function writeFinanceData(data) {
  await mkdir(dataDir, { recursive: true });
  const temporaryFile = `${dataFile}.tmp`;
  await writeFile(temporaryFile, JSON.stringify({
    transactions: data.transactions,
    budgets: data.budgets
  }, null, 2), "utf8");
  await rename(temporaryFile, dataFile);
}

function mutateFinanceData(update) {
  const operation = mutationQueue.then(async () => {
    const data = await readFinanceData();
    update(data);
    await writeFinanceData(data);
    return data;
  });
  mutationQueue = operation.catch(() => {});
  return operation;
}

function cleanTransaction(input) {
  const name = String(input?.name || "").trim().slice(0, 80);
  const amount = Number(input?.amount);
  const type = input?.type;
  const category = String(input?.category || "Lainnya").trim().slice(0, 40);
  const date = String(input?.date || "");
  if (!name || !Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000 || !["income", "expense"].includes(type) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return { id: randomUUID(), name, amount, type, category, date };
}

// Data terpusat di komputer server agar ponsel dan komputer memakai histori yang sama.
app.get("/api/data", async (_req, res) => {
  try { res.json(await readFinanceData()); }
  catch (error) { console.error("Gagal membaca data:", error.message); res.status(500).json({ error: "Data tidak dapat dibaca." }); }
});

// Impor sekali data lama dari localStorage saat server baru pertama kali dipakai.
app.post("/api/import", async (req, res) => {
  try {
    const result = await mutateFinanceData(data => {
      const transactions = Array.isArray(req.body?.transactions) ? req.body.transactions.slice(0, 500).map(cleanTransaction).filter(Boolean) : [];
      // Izinkan komputer lama mengimpor histori jika ponsel lebih dulu membuat data kosong.
      if (data.transactions.length > 0 || (data.initialized && transactions.length === 0)) return;
      const budgets = req.body?.budgets && typeof req.body.budgets === "object" ? req.body.budgets : defaultBudgets;
      data.transactions = transactions;
      data.budgets = Object.fromEntries(Object.entries(budgets).slice(0, 30).map(([key, value]) => [String(key).slice(0, 40), Math.max(0, Math.min(1_000_000_000, Number(value) || 0))]));
      data.initialized = true;
    });
    res.json(result);
  } catch (error) { console.error("Gagal mengimpor data:", error.message); res.status(500).json({ error: "Data tidak dapat disimpan." }); }
});

app.post("/api/transactions", async (req, res) => {
  const transaction = cleanTransaction(req.body);
  if (!transaction) return res.status(400).json({ error: "Transaksi tidak valid." });
  try {
    const result = await mutateFinanceData(data => { data.transactions.push(transaction); data.initialized = true; });
    res.status(201).json(result);
  } catch (error) { console.error("Gagal menyimpan transaksi:", error.message); res.status(500).json({ error: "Transaksi tidak dapat disimpan." }); }
});

app.put("/api/budgets", async (req, res) => {
  const budgets = req.body?.budgets;
  if (!budgets || typeof budgets !== "object" || Array.isArray(budgets)) return res.status(400).json({ error: "Anggaran tidak valid." });
  try {
    const result = await mutateFinanceData(data => {
      data.budgets = Object.fromEntries(Object.entries(budgets).slice(0, 30).map(([key, value]) => [String(key).slice(0, 40), Math.max(0, Math.min(1_000_000_000, Number(value) || 0))]));
      data.initialized = true;
    });
    res.json(result);
  } catch (error) { console.error("Gagal menyimpan anggaran:", error.message); res.status(500).json({ error: "Anggaran tidak dapat disimpan." }); }
});

app.post("/api/ask", async (req, res) => {
  try {
    const question = String(req.body?.question || "").trim();
    const transactions = req.body?.transactions;

    if (!question || question.length > 500) {
      return res.status(400).json({ error: "Pertanyaan wajib diisi dan maksimal 500 karakter." });
    }

    if (!Array.isArray(transactions) || transactions.length > 500) {
      return res.status(400).json({ error: "Data transaksi tidak valid." });
    }

    // Hitung ringkasan di backend dan kirim hanya total serta kategori ke AI.
    let income = 0;
    let expense = 0;
    const categories = {};

    for (const tx of transactions) {
      const amount = Number(tx?.amount);
      if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000_000) continue;

      if (tx.type === "income") {
        income += amount;
      } else if (tx.type === "expense") {
        expense += amount;
        const category = String(tx.category || "Lainnya").slice(0, 40);
        categories[category] = (categories[category] || 0) + amount;
      }
    }

    const summary = {
      income,
      expense,
      cashDifference: income - expense,
      expenseByCategory: Object.entries(categories)
        .map(([category, amount]) => ({ category, amount }))
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 8)
    };

    const response = await openai.responses.create({
      model: process.env.OPENAI_MODEL || "gpt-6.2-astra",
      instructions: [
        "Kamu adalah asisten pencatatan dan perencanaan anggaran pribadi.",
        "Jawab dalam Bahasa Indonesia, dengan ramah dan singkat.",
        "Berikan saran umum untuk menyusun anggaran dan kebiasaan menabung.",
        "Jangan meminta nama, nomor rekening, kata sandi, atau data sensitif.",
        "Jangan menyarankan investasi tertentu atau menjanjikan hasil keuangan.",
        "Gunakan hanya ringkasan transaksi yang diberikan; jangan mengarang angka."
      ].join(" "),
      input: JSON.stringify({ question, monthlySummary: summary })
    });

    res.json({ answer: response.output_text || "Maaf, belum ada jawaban. Coba tanyakan lagi." });
  } catch (error) {
    console.error("Gagal memproses pertanyaan:", error.message);
    res.status(500).json({ error: "Asisten sedang bermasalah. Coba lagi nanti." });
  }
});

app.listen(port, () => {
  console.log(`Rapi berjalan di http://localhost:${port}`);
});
