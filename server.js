
const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { createWorker } = require("tesseract.js");

const app = express();
const PORT = process.env.PORT || 3000;
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error("Solo se aceptan imágenes JPG, PNG o WEBP en esta versión."));
    }
    cb(null, true);
  }
});

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

function normalizeMoney(value) {
  if (!value) return null;
  const cleaned = value.replace(/[^\d,.-]/g, "").replace(",", ".");
  const number = Number.parseFloat(cleaned);
  return Number.isFinite(number) ? Number(number.toFixed(2)) : null;
}

function parsePeruvianReceipt(text) {
  const clean = text.replace(/\r/g, "");
  const upper = clean.toUpperCase();
  const oneLine = upper.replace(/\s+/g, " ");

  const rucMatches = [...oneLine.matchAll(/\b(?:10|15|17|20)\d{9}\b/g)].map(m => m[0]);
  const dateMatch =
    oneLine.match(/\b(\d{2})[\/.-](\d{2})[\/.-](\d{4})\b/) ||
    oneLine.match(/\b(\d{4})[\/.-](\d{2})[\/.-](\d{2})\b/);

  const docMatch =
    oneLine.match(/\b([FBE]\d{3})\s*[-–]\s*(\d{1,8})\b/) ||
    oneLine.match(/\b([FBE]\d{3})\s+(\d{1,8})\b/);

  const totalMatches = [
    ...oneLine.matchAll(/(?:IMPORTE\s+TOTAL|TOTAL\s+A\s+PAGAR|TOTAL)[^\d]{0,20}(S\/\.?\s*)?(\d{1,7}[.,]\d{2})/g)
  ];
  const igvMatches = [
    ...oneLine.matchAll(/(?:I\.?G\.?V\.?|IGV\s*18%)[^\d]{0,20}(S\/\.?\s*)?(\d{1,7}[.,]\d{2})/g)
  ];
  const subtotalMatches = [
    ...oneLine.matchAll(/(?:OP\.?\s*GRAVADA|VALOR\s+VENTA|SUBTOTAL|BASE\s+IMPONIBLE)[^\d]{0,20}(S\/\.?\s*)?(\d{1,7}[.,]\d{2})/g)
  ];

  const total = totalMatches.length ? normalizeMoney(totalMatches.at(-1)[2]) : null;
  const igv = igvMatches.length ? normalizeMoney(igvMatches.at(-1)[2]) : null;
  let subtotal = subtotalMatches.length ? normalizeMoney(subtotalMatches.at(-1)[2]) : null;

  if (total !== null && subtotal === null && igv !== null) subtotal = Number((total - igv).toFixed(2));
  if (total !== null && igv === null) {
    const estimatedIgv = Number((total - total / 1.18).toFixed(2));
    subtotal = subtotal ?? Number((total - estimatedIgv).toFixed(2));
  }

  const lines = clean.split("\n").map(x => x.trim()).filter(Boolean);
  const businessName =
    lines.find(line =>
      line.length >= 6 &&
      line.length <= 80 &&
      /[A-Za-zÁÉÍÓÚÑáéíóúñ]{4}/.test(line) &&
      !/FACTURA|BOLETA|RUC|SUNAT|TOTAL|IGV|CLIENTE|DIRECCI[ÓO]N/i.test(line)
    ) || "";

  let issueDate = "";
  if (dateMatch) {
    if (dateMatch[1].length === 4) issueDate = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`;
    else issueDate = `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`;
  }

  let type = "Otro";
  if (oneLine.includes("FACTURA")) type = "Factura";
  else if (oneLine.includes("BOLETA")) type = "Boleta de venta";
  else if (oneLine.includes("RECIBO POR HONORARIOS")) type = "Recibo por honorarios";

  const confidenceItems = [
    rucMatches[0],
    docMatch?.[1],
    docMatch?.[2],
    issueDate,
    total
  ].filter(Boolean).length;

  return {
    type,
    ruc: rucMatches[0] || "",
    businessName,
    issueDate,
    series: docMatch?.[1] || "",
    number: docMatch?.[2]?.padStart(8, "0") || "",
    subtotal: subtotal ?? "",
    igv: igv ?? "",
    total: total ?? "",
    currency: oneLine.includes("US$") || oneLine.includes("DÓLAR") ? "USD" : "PEN",
    confidence: Math.min(96, 45 + confidenceItems * 10)
  };
}

app.post("/api/scan", upload.single("document"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No se recibió ningún archivo." });

  let worker;
  try {
    worker = await createWorker("spa");
    const result = await worker.recognize(req.file.path);
    const parsed = parsePeruvianReceipt(result.data.text);

    res.json({
      ok: true,
      ocrConfidence: Math.round(result.data.confidence),
      parsed,
      rawText: result.data.text
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "No se pudo procesar el comprobante." });
  } finally {
    if (worker) await worker.terminate();
    fs.unlink(req.file.path, () => {});
  }
});

app.post("/api/accounting-entry", (req, res) => {
  const { category, subtotal, igv, total, series, number, businessName, type } = req.body;
  const amountSubtotal = Number(subtotal || 0);
  const amountIgv = Number(igv || 0);
  const amountTotal = Number(total || 0);

  const accountMap = {
    "601": "Mercaderías",
    "603": "Materiales auxiliares, suministros y repuestos",
    "631": "Transporte, correos y gastos de viaje",
    "632": "Asesoría y consultoría",
    "635": "Alquileres",
    "636": "Servicios básicos",
    "639": "Otros servicios prestados por terceros",
    "659": "Otros gastos de gestión",
    "33": "Propiedad, planta y equipo"
  };

  const entry = {
    description: `Registro de ${type || "comprobante"} ${series || ""}-${number || ""} de ${businessName || "proveedor"}`,
    lines: [
      { account: category, name: accountMap[category] || "Gasto o activo por clasificar", debit: amountSubtotal, credit: 0 },
      { account: "40111", name: "IGV - Cuenta propia", debit: amountIgv, credit: 0 },
      { account: "4212", name: "Facturas, boletas y otros comprobantes por pagar", debit: 0, credit: amountTotal }
    ]
  };

  res.json({ ok: true, entry });
});

app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.use((err, _req, res, _next) => {
  res.status(400).json({ error: err.message || "Ocurrió un error." });
});

app.listen(PORT, () => {
  console.log(`ContaScan IA disponible en http://localhost:${PORT}`);
});
