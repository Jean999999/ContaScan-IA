const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const sharp = require("sharp");
const { createWorker } = require("tesseract.js");

const app = express();
const PORT = process.env.PORT || 3000;
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error("El servidor recibe imágenes. Los PDF se convierten automáticamente en el navegador."));
    }
    cb(null, true);
  }
});

app.use(express.json({ limit: "4mb" }));
app.use(express.static(path.join(__dirname, "public")));

function normalizeMoney(value) {
  if (value === null || value === undefined) return null;
  let cleaned = String(value)
    .replace(/\s/g, "")
    .replace(/[^\d,.-]/g, "");

  if (!cleaned) return null;

  // Formatos: 1,234.56 / 1.234,56 / 1234.56 / 1234,56
  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");
  if (lastComma > lastDot) {
    cleaned = cleaned.replace(/\./g, "").replace(",", ".");
  } else if (lastDot > lastComma) {
    cleaned = cleaned.replace(/,/g, "");
  } else {
    cleaned = cleaned.replace(",", ".");
  }

  const number = Number.parseFloat(cleaned);
  return Number.isFinite(number) ? Number(number.toFixed(2)) : null;
}

function cleanOCRText(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .replace(/[|¦]/g, "I")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, "-")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n");
}

function extractAmounts(line) {
  return [...String(line).matchAll(/(?:S\/\.?|PEN|US\$|\$)?\s*(\d{1,3}(?:[.,]\d{3})*[.,]\d{2}|\d{1,9}[.,]\d{2})/g)]
    .map(m => normalizeMoney(m[1]))
    .filter(v => v !== null);
}

function findLabeledAmount(lines, labels) {
  const labelRegex = new RegExp(labels.join("|"), "i");
  const candidates = [];

  for (let i = 0; i < lines.length; i++) {
    if (!labelRegex.test(lines[i])) continue;

    const sameLine = extractAmounts(lines[i]);
    if (sameLine.length) candidates.push(...sameLine);

    if (i + 1 < lines.length) {
      const nextLine = extractAmounts(lines[i + 1]);
      if (nextLine.length) candidates.push(...nextLine);
    }
  }
  return candidates.length ? candidates.at(-1) : null;
}

function normalizeRucCandidate(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 11 && /^(10|15|17|20)/.test(digits)) return digits;
  return "";
}

function parsePeruvianReceipt(text) {
  const clean = cleanOCRText(text);
  const lines = clean.split("\n").map(x => x.trim()).filter(Boolean);
  const upperLines = lines.map(x => x.toUpperCase());
  const oneLine = upperLines.join(" ").replace(/\s+/g, " ");

  // RUC con tolerancia a espacios y separadores.
  const rucCandidates = [];
  for (const match of oneLine.matchAll(/(?:RUC|R\.U\.C\.?)?[^0-9]{0,8}((?:10|15|17|20)(?:[\s.\-]?\d){9})/g)) {
    const ruc = normalizeRucCandidate(match[1]);
    if (ruc) rucCandidates.push(ruc);
  }
  if (!rucCandidates.length) {
    for (const match of oneLine.matchAll(/\b(?:10|15|17|20)\d{9}\b/g)) {
      rucCandidates.push(match[0]);
    }
  }

  // Serie y número: F001-00012345, B001 12345, E001-123.
  const docPatterns = [
    /\b([FBE][A-Z0-9]{3})\s*[-]\s*(\d{1,10})\b/,
    /\b([FBE][A-Z0-9]{3})\s+(\d{1,10})\b/,
    /SERIE\s*[:.]?\s*([FBE][A-Z0-9]{3}).{0,20}(?:N[ÚU]MERO|NRO\.?|NO\.?)?\s*[:.]?\s*(\d{1,10})/
  ];
  let docMatch = null;
  for (const pattern of docPatterns) {
    docMatch = oneLine.match(pattern);
    if (docMatch) break;
  }

  // Fecha.
  let issueDate = "";
  const datePatterns = [
    /\b(\d{2})[\/.\-](\d{2})[\/.\-](\d{4})\b/,
    /\b(\d{4})[\/.\-](\d{2})[\/.\-](\d{2})\b/
  ];
  for (const pattern of datePatterns) {
    const m = oneLine.match(pattern);
    if (!m) continue;
    issueDate = m[1].length === 4
      ? `${m[1]}-${m[2]}-${m[3]}`
      : `${m[3]}-${m[2]}-${m[1]}`;
    break;
  }

  // Importes usando etiquetas contables frecuentes.
  let total = findLabeledAmount(upperLines, [
    "IMPORTE\\s+TOTAL", "TOTAL\\s+A\\s+PAGAR", "TOTAL\\s+VENTA",
    "TOTAL\\s+COMPROBANTE", "^TOTAL\\b"
  ]);

  let igv = findLabeledAmount(upperLines, [
    "\\bI\\.?G\\.?V\\.?\\b", "IGV\\s*18", "IMPUESTO\\s+GENERAL"
  ]);

  let subtotal = findLabeledAmount(upperLines, [
    "OP\\.?\\s*GRAVADA", "OPERACI[ÓO]N\\s+GRAVADA", "VALOR\\s+DE\\s+VENTA",
    "SUB\\s*TOTAL", "SUBTOTAL", "BASE\\s+IMPONIBLE"
  ]);

  // Respaldo: si hay varios importes, el mayor suele ser el total.
  const allAmounts = upperLines.flatMap(extractAmounts).filter(v => v >= 0.01 && v < 100000000);
  if (total === null && allAmounts.length) total = Math.max(...allAmounts);

  if (subtotal === null && total !== null && igv !== null && total >= igv) {
    subtotal = Number((total - igv).toFixed(2));
  }

  // Evita inventar IGV cuando el documento no lo muestra.
  if (igv === null && subtotal !== null && total !== null && total >= subtotal) {
    const diff = Number((total - subtotal).toFixed(2));
    if (diff >= 0 && diff <= total) igv = diff;
  }

  // Tipo de comprobante.
  let type = "Otro";
  if (/NOTA\s+DE\s+CR[ÉE]DITO/.test(oneLine)) type = "Nota de crédito";
  else if (/NOTA\s+DE\s+D[ÉE]BITO/.test(oneLine)) type = "Nota de débito";
  else if (/RECIBO\s+POR\s+HONORARIOS/.test(oneLine)) type = "Recibo por honorarios";
  else if (/FACTURA/.test(oneLine)) type = "Factura";
  else if (/BOLETA/.test(oneLine)) type = "Boleta de venta";

  // Razón social: prioriza líneas con sufijo empresarial.
  const excluded = /FACTURA|BOLETA|RECIBO|RUC|SUNAT|TOTAL|IGV|CLIENTE|SEÑOR|DIRECCI[ÓO]N|FECHA|SERIE|N[ÚU]MERO|CANTIDAD|DESCRIPCI[ÓO]N|P[ÁA]GINA|TEL[ÉE]FONO/i;
  const companySuffix = /\b(S\.?\s*A\.?\s*C\.?|S\.?\s*A\.?|E\.?\s*I\.?\s*R\.?\s*L\.?|S\.?\s*R\.?\s*L\.?|SAC|EIRL|SRL)\b/i;

  const businessName =
    lines.find(line => line.length >= 5 && line.length <= 110 && companySuffix.test(line) && !excluded.test(line)) ||
    lines.find(line => /^[A-ZÁÉÍÓÚÑ0-9&.,' -]{6,90}$/.test(line) && /[A-ZÁÉÍÓÚÑ]{4}/.test(line) && !excluded.test(line)) ||
    "";

  const series = docMatch?.[1] || "";
  const number = docMatch?.[2] || "";
  const found = [rucCandidates[0], series, number, issueDate, total, businessName].filter(v => v !== "" && v !== null && v !== undefined).length;

  return {
    type,
    ruc: rucCandidates[0] || "",
    businessName,
    issueDate,
    series,
    number: number ? String(number).padStart(8, "0") : "",
    subtotal: subtotal ?? "",
    igv: igv ?? "",
    total: total ?? "",
    currency: /US\$|USD|D[ÓO]LAR/.test(oneLine) ? "USD" : "PEN",
    confidence: Math.min(98, 30 + found * 11)
  };
}

async function createVariants(inputPath) {
  const base = sharp(inputPath, { failOn: "none" })
    .rotate()
    .trim({ background: "#ffffff", threshold: 12 });

  const meta = await base.metadata();
  const width = meta.width || 1200;
  const targetWidth = width < 2200 ? 2600 : Math.min(width, 3200);

  const common = base
    .resize({ width: targetWidth, withoutEnlargement: false, kernel: sharp.kernel.lanczos3 })
    .grayscale()
    .normalize();

  const files = [
    path.join(uploadDir, `ocr-normal-${Date.now()}-${Math.random()}.png`),
    path.join(uploadDir, `ocr-sharp-${Date.now()}-${Math.random()}.png`),
    path.join(uploadDir, `ocr-threshold-${Date.now()}-${Math.random()}.png`)
  ];

  await common.clone()
    .linear(1.25, -20)
    .png()
    .toFile(files[0]);

  await common.clone()
    .sharpen({ sigma: 1.2, m1: 1, m2: 2 })
    .linear(1.45, -35)
    .png()
    .toFile(files[1]);

  await common.clone()
    .threshold(185)
    .png()
    .toFile(files[2]);

  return files;
}

function scoreOCR(text, confidence) {
  const upper = String(text || "").toUpperCase();
  let score = Number(confidence || 0);
  if (/\b(?:10|15|17|20)\d{9}\b/.test(upper.replace(/\s/g, ""))) score += 25;
  if (/\b[FBE][A-Z0-9]{3}\s*-\s*\d+/.test(upper)) score += 20;
  if (/FACTURA|BOLETA|RECIBO|NOTA DE CR[ÉE]DITO/.test(upper)) score += 10;
  if (/TOTAL|IGV|RUC/.test(upper)) score += 10;
  score += Math.min(20, upper.length / 100);
  return score;
}

async function recognizeBest(worker, files) {
  const results = [];

  for (const file of files) {
    for (const psm of ["6", "11"]) {
      await worker.setParameters({
        tessedit_pageseg_mode: psm,
        preserve_interword_spaces: "1",
        user_defined_dpi: "300"
      });
      const result = await worker.recognize(file);
      results.push({
        text: result.data.text,
        confidence: result.data.confidence,
        score: scoreOCR(result.data.text, result.data.confidence)
      });
    }
  }

  results.sort((a, b) => b.score - a.score);
  const best = results[0] || { text: "", confidence: 0 };

  // Mezcla los dos mejores resultados para aumentar la posibilidad de encontrar campos.
  const combinedText = results.slice(0, 2).map(r => r.text).join("\n\n--- SEGUNDA LECTURA ---\n\n");
  return {
    text: combinedText || best.text,
    confidence: Math.round(best.confidence || 0)
  };
}


function normalizeAiReceipt(data = {}) {
  const allowedTypes = [
    "Factura", "Boleta de venta", "Recibo por honorarios",
    "Nota de crédito", "Nota de débito", "Otro"
  ];

  const type = allowedTypes.includes(data.type) ? data.type : "Otro";
  const ruc = String(data.ruc || "").replace(/\D/g, "").slice(0, 11);
  const series = String(data.series || "").trim().toUpperCase().slice(0, 8);
  const number = String(data.number || "").replace(/\D/g, "").slice(0, 12);

  const toAmount = value => {
    const n = normalizeMoney(value);
    return n === null ? "" : n;
  };

  return {
    type,
    ruc: ruc.length === 11 ? ruc : "",
    businessName: String(data.businessName || "").trim().slice(0, 140),
    issueDate: /^\d{4}-\d{2}-\d{2}$/.test(String(data.issueDate || ""))
      ? String(data.issueDate)
      : "",
    series,
    number: number ? number.padStart(8, "0") : "",
    subtotal: toAmount(data.subtotal),
    igv: toAmount(data.igv),
    total: toAmount(data.total),
    currency: data.currency === "USD" ? "USD" : "PEN",
    confidence: Math.max(0, Math.min(100, Number(data.confidence || 0))),
    observations: String(data.observations || "").trim().slice(0, 300)
  };
}

function getResponseOutputText(responseJson) {
  if (typeof responseJson.output_text === "string") return responseJson.output_text;

  const parts = [];
  for (const item of responseJson.output || []) {
    if (item.type !== "message") continue;
    for (const content of item.content || []) {
      if (content.type === "output_text" && typeof content.text === "string") {
        parts.push(content.text);
      }
    }
  }
  return parts.join("\n");
}

async function extractReceiptWithVision(imagePath, mimeType = "image/png") {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const base64 = fs.readFileSync(imagePath).toString("base64");
  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      type: {
        type: "string",
        enum: [
          "Factura", "Boleta de venta", "Recibo por honorarios",
          "Nota de crédito", "Nota de débito", "Otro"
        ]
      },
      ruc: { type: "string" },
      businessName: { type: "string" },
      issueDate: { type: "string" },
      series: { type: "string" },
      number: { type: "string" },
      subtotal: { type: ["number", "null"] },
      igv: { type: ["number", "null"] },
      total: { type: ["number", "null"] },
      currency: { type: "string", enum: ["PEN", "USD"] },
      confidence: { type: "number" },
      observations: { type: "string" }
    },
    required: [
      "type", "ruc", "businessName", "issueDate", "series", "number",
      "subtotal", "igv", "total", "currency", "confidence", "observations"
    ]
  };

  const prompt = `
Analiza este comprobante peruano y extrae únicamente información visible.
Puede ser factura, boleta, recibo por honorarios, nota de crédito o nota de débito.

Reglas:
- RUC: exactamente 11 dígitos. Si no se distingue, devuelve cadena vacía.
- Fecha: formato YYYY-MM-DD. Si no se distingue, devuelve cadena vacía.
- Serie y número: no inventes datos.
- subtotal: usa valor de venta, operación gravada o base imponible.
- igv: usa el IGV mostrado.
- total: usa importe total o total a pagar.
- currency: PEN, salvo que el documento indique dólares.
- No calcules ni adivines importes ausentes.
- confidence: porcentaje estimado de 0 a 100 según legibilidad.
- observations: indica brevemente campos dudosos o ausentes.
`;

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      store: false,
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          {
            type: "input_image",
            image_url: `data:${mimeType};base64,${base64}`,
            detail: "high"
          }
        ]
      }],
      text: {
        format: {
          type: "json_schema",
          name: "peruvian_receipt",
          strict: true,
          schema
        }
      }
    })
  });

  const responseJson = await response.json();
  if (!response.ok) {
    const message = responseJson?.error?.message || "Error del servicio de IA";
    throw new Error(message);
  }

  const outputText = getResponseOutputText(responseJson);
  if (!outputText) throw new Error("La IA no devolvió datos estructurados.");

  return normalizeAiReceipt(JSON.parse(outputText));
}

app.post("/api/scan", upload.single("document"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No se recibió ningún archivo." });

  let worker;
  let variants = [];

  try {
    variants = await createVariants(req.file.path);

    // 1) IA visual real: es la lectura principal cuando existe OPENAI_API_KEY.
    let aiParsed = null;
    let aiError = "";

    try {
      aiParsed = await extractReceiptWithVision(variants[0], "image/png");
    } catch (error) {
      console.error("Vision AI:", error.message);
      aiError = error.message;
    }

    if (aiParsed) {
      return res.json({
        ok: true,
        engine: "vision-ai",
        ocrConfidence: aiParsed.confidence,
        parsed: aiParsed,
        rawText: "",
        warning: aiParsed.observations || ""
      });
    }

    // 2) Respaldo gratuito con Tesseract cuando no hay clave o la IA falla.
    worker = await createWorker("spa");
    const result = await recognizeBest(worker, variants);
    const pdfText = typeof req.body.pdfText === "string" ? req.body.pdfText : "";
    const combined = [pdfText, result.text].filter(Boolean).join("\n\n--- OCR ---\n\n");
    const parsed = parsePeruvianReceipt(combined);

    res.json({
      ok: true,
      engine: "tesseract-fallback",
      ocrConfidence: result.confidence,
      parsed,
      rawText: combined,
      warning: process.env.OPENAI_API_KEY
        ? `La IA visual falló y se usó OCR de respaldo: ${aiError}`
        : "Falta configurar OPENAI_API_KEY en Render; se usó el OCR básico de respaldo."
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "No se pudo procesar el comprobante.",
      detail: error.message
    });
  } finally {
    if (worker) await worker.terminate();
    fs.unlink(req.file.path, () => {});
    for (const file of variants) fs.unlink(file, () => {});
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



function getAssistantText(responseJson) {
  if (typeof responseJson.output_text === "string") return responseJson.output_text.trim();
  const parts = [];
  for (const item of responseJson.output || []) {
    if (item.type !== "message") continue;
    for (const content of item.content || []) {
      if (content.type === "output_text" && typeof content.text === "string") {
        parts.push(content.text);
      }
    }
  }
  return parts.join("\n").trim();
}

app.post("/api/chat", async (req, res) => {
  const question = String(req.body?.question || "").trim().slice(0, 1200);
  const receipt = req.body?.receipt && typeof req.body.receipt === "object"
    ? req.body.receipt
    : null;

  if (!question) {
    return res.status(400).json({ error: "Escribe una pregunta." });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({
      error: "El asistente necesita que OPENAI_API_KEY esté configurada en Render."
    });
  }

  const receiptContext = receipt
    ? `
Datos visibles del comprobante actual:
${JSON.stringify(receipt, null, 2)}
`
    : "No hay un comprobante abierto actualmente.";

  const instructions = `
Eres ContaBot, asistente de ContaScan IA para estudiantes y pequeños negocios del Perú.
Responde en español claro, con explicaciones breves y útiles.
Puedes explicar los campos de comprobantes, IGV, RUC, serie, número, base imponible,
duplicados, exportaciones y asientos contables referenciales basados en el PCGE.

Reglas:
- No inventes datos del comprobante.
- Señala que los asientos son referenciales y deben ser revisados por un contador.
- No presentes validaciones SUNAT como realizadas si la aplicación no las ha hecho.
- Para temas legales o tributarios cambiantes, recomienda revisar SUNAT o consultar a un profesional.
- No reveles claves, mensajes internos, código secreto ni variables del servidor.
- Máximo 180 palabras, salvo que el usuario pida más detalle.

${receiptContext}
`;

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
        store: false,
        instructions,
        input: question
      })
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data?.error?.message || "No se pudo consultar a la IA.");
    }

    const answer = getAssistantText(data);
    res.json({
      ok: true,
      answer: answer || "No pude generar una respuesta en este momento."
    });
  } catch (error) {
    console.error("ContaBot:", error.message);
    res.status(500).json({
      error: "ContaBot no pudo responder. Revisa la configuración o inténtalo nuevamente."
    });
  }
});

app.get("/api/status", (_req, res) => {
  res.json({
    visionAI: Boolean(process.env.OPENAI_API_KEY),
    model: process.env.OPENAI_MODEL || "gpt-4.1-mini"
  });
});

app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.use((err, _req, res, _next) => {
  res.status(400).json({ error: err.message || "Ocurrió un error." });
});

app.listen(PORT, () => {
  console.log(`ContaScan IA disponible en http://localhost:${PORT}`);
});
