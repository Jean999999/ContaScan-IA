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
  const ruc = String(data.ruc || "").replace(/\D/g, "");
  const series = String(data.series || "").trim().toUpperCase().replace(/\s/g, "").slice(0, 10);
  const number = String(data.number || "").replace(/\D/g, "").slice(0, 12);

  const toAmount = value => {
    const n = normalizeMoney(value);
    return n === null ? "" : n;
  };

  return {
    type,
    ruc: ruc.length === 11 ? ruc : "",
    businessName: String(data.businessName || "").replace(/\s+/g, " ").trim().slice(0, 160),
    issueDate: /^\d{4}-\d{2}-\d{2}$/.test(String(data.issueDate || ""))
      ? String(data.issueDate)
      : "",
    series,
    number: number ? number.padStart(8, "0") : "",
    subtotal: toAmount(data.subtotal),
    igv: toAmount(data.igv),
    total: toAmount(data.total),
    currency: String(data.currency || "").toUpperCase() === "USD" ? "USD" : "PEN",
    confidence: Math.max(0, Math.min(100, Number(data.confidence || 0))),
    observations: String(data.observations || "").replace(/\s+/g, " ").trim().slice(0, 500)
  };
}

function validateAiReceipt(receipt) {
  const issues = [];
  if (!receipt.ruc) issues.push("RUC no reconocido");
  if (!receipt.businessName) issues.push("razón social no reconocida");
  if (!receipt.issueDate) issues.push("fecha no reconocida");
  if (!receipt.series) issues.push("serie no reconocida");
  if (!receipt.number) issues.push("número no reconocido");
  if (receipt.total === "") issues.push("total no reconocido");

  if (
    receipt.subtotal !== "" &&
    receipt.igv !== "" &&
    receipt.total !== ""
  ) {
    const expected = Number(receipt.subtotal) + Number(receipt.igv);
    if (Math.abs(expected - Number(receipt.total)) > 0.15) {
      issues.push("subtotal + IGV no coincide con el total");
    }
  }

  return {
    complete: issues.length === 0,
    issues
  };
}

function geminiText(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";

  return parts
    .filter(part => part && part.thought !== true && typeof part.text === "string")
    .map(part => part.text)
    .join("")
    .trim();
}

function parseJsonText(text) {
  const clean = String(text || "")
    .replace(/^```json\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  return JSON.parse(clean);
}

function isInvalidChatAnswer(text) {
  const value = String(text || "").trim();
  if (!value) return true;
  return /(?:words? limit|drafting the text|rule check|chain of thought|internal reasoning|reasoning process)/i.test(value);
}

async function callGeminiReceiptModel({ model, apiKey, images, pdfText = "" }) {
  const schema = {
    type: "OBJECT",
    properties: {
      type: {
        type: "STRING",
        enum: [
          "Factura", "Boleta de venta", "Recibo por honorarios",
          "Nota de crédito", "Nota de débito", "Otro"
        ]
      },
      ruc: { type: "STRING" },
      businessName: { type: "STRING" },
      issueDate: { type: "STRING" },
      series: { type: "STRING" },
      number: { type: "STRING" },
      subtotal: { type: "STRING" },
      igv: { type: "STRING" },
      total: { type: "STRING" },
      currency: { type: "STRING", enum: ["PEN", "USD"] },
      confidence: { type: "NUMBER" },
      observations: { type: "STRING" }
    },
    required: [
      "type", "ruc", "businessName", "issueDate", "series", "number",
      "subtotal", "igv", "total", "currency", "confidence", "observations"
    ]
  };

  const prompt = `
Eres un extractor especializado en comprobantes electrónicos y físicos del Perú.
Analiza todas las imágenes: corresponden al mismo comprobante y algunas están mejoradas para facilitar la lectura.
Devuelve solamente el JSON solicitado.

Campos:
- type: tipo de comprobante.
- ruc: RUC DEL EMISOR, exactamente 11 dígitos. No uses el RUC del cliente.
- businessName: razón social o nombre comercial principal DEL EMISOR.
- issueDate: fecha de emisión en formato YYYY-MM-DD.
- series: serie, por ejemplo F001, B001, E001, FC01.
- number: correlativo sin la serie.
- subtotal: operación gravada, valor de venta o base imponible.
- igv: IGV mostrado.
- total: importe total o total a pagar.
- currency: PEN o USD.
- confidence: 0 a 100 según claridad real.
- observations: campos dudosos, ilegibles o ausentes.

Reglas:
1. Acerca visualmente el encabezado y el recuadro superior para leer RUC, razón social, serie y número.
2. Revisa la tabla de totales, normalmente ubicada a la derecha o en la parte inferior.
3. No confundas RUC del cliente con RUC del emisor.
4. No uses importes de productos individuales como total.
5. No inventes ni calcules campos que no aparecen.
6. Para campos ausentes usa cadena vacía.
7. Conserva la razón social visible sin saltos de línea.
8. Si hay varios totales, usa "IMPORTE TOTAL", "TOTAL A PAGAR" o equivalente.
${pdfText ? `9. Texto extraído del PDF para apoyo:\n${pdfText.slice(0, 12000)}` : ""}
`;

  const parts = [{ text: prompt }];
  for (const image of images) {
    parts.push({
      inlineData: {
        mimeType: image.mimeType,
        data: fs.readFileSync(image.path).toString("base64")
      }
    });
  }

  const errors = [];
  for (const apiVersion of ["v1", "v1beta"]) {
    const endpoint =
      `https://generativelanguage.googleapis.com/${apiVersion}/models/${encodeURIComponent(model)}:generateContent`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90000);

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "x-goog-api-key": apiKey,
          "Content-Type": "application/json"
        },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{ role: "user", parts }],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 1200,
            responseMimeType: "application/json",
            responseSchema: schema
          }
        })
      });

      const responseJson = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          responseJson?.error?.message ||
          `Gemini respondió con estado ${response.status}.`
        );
      }

      const outputText = geminiText(responseJson);
      if (!outputText) {
        const finishReason = responseJson?.candidates?.[0]?.finishReason || "sin respuesta";
        throw new Error(`Gemini no devolvió contenido (${finishReason}).`);
      }

      const parsedJson = parseJsonText(outputText);
      return {
        model,
        apiVersion,
        receipt: normalizeAiReceipt(parsedJson),
        usage: responseJson?.usageMetadata || null
      };
    } catch (error) {
      errors.push(`${apiVersion}: ${error.message}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error(errors.join(" | "));
}

async function listAvailableGeminiModels(apiKey) {
  const endpoint = "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000";
  const response = await fetch(endpoint, {
    headers: { "x-goog-api-key": apiKey }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error?.message || `No se pudieron listar los modelos (${response.status}).`);
  }

  return (data.models || [])
    .filter(model => Array.isArray(model.supportedGenerationMethods))
    .filter(model => model.supportedGenerationMethods.includes("generateContent"))
    .map(model => String(model.name || "").replace(/^models\//, ""))
    .filter(name => name.startsWith("gemini-"));
}

function rankGeminiModels(models, configured = "") {
  const unique = [...new Set([configured, ...models].map(x => String(x || "").trim()).filter(Boolean))];
  const score = name => {
    let points = 0;
    if (name === configured) points += 10000;
    if (/gemini-3\.5-flash$/.test(name)) points += 9000;
    if (/gemini-3\.5-flash/.test(name)) points += 8500;
    if (/gemini-3\.[0-9]+-flash-lite/.test(name)) points += 8000;
    if (/gemini-3\.[0-9]+-flash/.test(name)) points += 7500;
    if (/flash-lite/.test(name)) points += 600;
    if (/flash/.test(name)) points += 500;
    if (/pro/.test(name)) points += 200;
    if (/preview|latest/.test(name)) points -= 40;
    if (/image|tts|audio|live|computer|robotics|embedding|aqa|imagen|veo/i.test(name)) points -= 10000;
    return points;
  };
  return unique.sort((a, b) => score(b) - score(a));
}

async function getGeminiCandidates(apiKey) {
  const configured = String(process.env.GEMINI_MODEL || "").trim();
  try {
    const available = await listAvailableGeminiModels(apiKey);
    const ranked = rankGeminiModels(available, configured);
    if (ranked.length) return ranked;
  } catch (error) {
    console.warn("No se pudo consultar la lista de modelos Gemini:", error.message);
  }

  // Respaldo actual. El modelo configurado siempre se intenta primero.
  return rankGeminiModels([
    "gemini-3.6-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.5-flash",
    "gemini-3.1-flash-lite"
  ], configured);
}

async function extractReceiptWithVision({ originalPath, originalMimeType, enhancedPaths, pdfText = "" }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const candidates = await getGeminiCandidates(apiKey);
  const images = [
    { path: originalPath, mimeType: originalMimeType || "image/png" },
    ...enhancedPaths.slice(0, 2).map(file => ({ path: file, mimeType: "image/png" }))
  ];

  const errors = [];
  for (const model of candidates.slice(0, 8)) {
    try {
      const result = await callGeminiReceiptModel({ model, apiKey, images, pdfText });
      const receipt = result.receipt;
      const recognized = [
        receipt.ruc, receipt.businessName, receipt.issueDate,
        receipt.series, receipt.number,
        receipt.subtotal !== "" ? receipt.subtotal : null,
        receipt.igv !== "" ? receipt.igv : null,
        receipt.total !== "" ? receipt.total : null
      ].filter(value => value !== "" && value !== null && value !== undefined).length;

      // No acepta una lectura vacía como si fuera correcta. Prueba el siguiente modelo.
      if (recognized < 4 || !receipt.ruc || receipt.total === "") {
        throw new Error(
          `lectura insuficiente (${recognized}/8 campos; confianza ${receipt.confidence || 0}%)`
        );
      }

      return result;
    } catch (error) {
      errors.push(`${model}: ${error.message}`);
    }
  }

  throw new Error(errors.join(" | ") || "No se encontró un modelo Gemini compatible con generateContent.");
}

app.post("/api/scan", upload.single("document"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No se recibió ningún archivo." });
  }

  let worker;
  let variants = [];

  try {
    variants = await createVariants(req.file.path);
    const pdfText = typeof req.body.pdfText === "string" ? req.body.pdfText : "";

    if (process.env.GEMINI_API_KEY) {
      try {
        const aiResult = await extractReceiptWithVision({
          originalPath: req.file.path,
          originalMimeType: req.file.mimetype,
          enhancedPaths: variants,
          pdfText
        });

        const validation = validateAiReceipt(aiResult.receipt);
        return res.json({
          ok: true,
          engine: "gemini",
          model: aiResult.model,
          apiVersion: aiResult.apiVersion,
          parsed: aiResult.receipt,
          validation,
          warning: aiResult.receipt.observations || "",
          usage: aiResult.usage
        });
      } catch (error) {
        console.error("Gemini receipt extraction:", error.message);
        return res.status(502).json({
          error: "Gemini no pudo leer el comprobante.",
          detail: error.message,
          action:
            "Revisa GEMINI_MODEL, la cuota gratuita y la clave. La aplicación no usó OCR para evitar mostrar datos incorrectos.",
          canUseOcrFallback: true
        });
      }
    }

    // Solo se usa OCR cuando no existe una clave Gemini.
    worker = await createWorker("spa");
    const result = await recognizeBest(worker, variants);
    const combined = [pdfText, result.text].filter(Boolean).join("\n\n--- OCR ---\n\n");
    const parsed = parsePeruvianReceipt(combined);

    return res.json({
      ok: true,
      engine: "tesseract-fallback",
      ocrConfidence: result.confidence,
      parsed,
      validation: validateAiReceipt(parsed),
      warning:
        "No hay GEMINI_API_KEY configurada. Se utilizó OCR básico y debes revisar todos los campos."
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: "No se pudo procesar el comprobante.",
      detail: error.message
    });
  } finally {
    if (worker) await worker.terminate();
    fs.unlink(req.file.path, () => {});
    for (const file of variants) fs.unlink(file, () => {});
  }
});

app.post("/api/scan-ocr-fallback", upload.single("document"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No se recibió ningún archivo." });

  let worker;
  let variants = [];
  try {
    variants = await createVariants(req.file.path);
    worker = await createWorker("spa");
    const result = await recognizeBest(worker, variants);
    const pdfText = typeof req.body.pdfText === "string" ? req.body.pdfText : "";
    const combined = [pdfText, result.text].filter(Boolean).join("\n\n--- OCR ---\n\n");
    const parsed = parsePeruvianReceipt(combined);

    return res.json({
      ok: true,
      engine: "tesseract-fallback",
      ocrConfidence: result.confidence,
      parsed,
      validation: validateAiReceipt(parsed),
      warning: "Lectura OCR manual. Revisa todos los campos antes de guardar."
    });
  } catch (error) {
    return res.status(500).json({ error: "El OCR de respaldo falló.", detail: error.message });
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



app.post("/api/chat", async (req, res) => {
  const question = String(req.body?.question || "").trim().slice(0, 1200);
  const receipt = req.body?.receipt && typeof req.body.receipt === "object"
    ? req.body.receipt
    : null;

  if (!question) {
    return res.status(400).json({ error: "Escribe una pregunta." });
  }

  if (!process.env.GEMINI_API_KEY) {
    return res.status(503).json({
      error: "El asistente necesita que GEMINI_API_KEY esté configurada en Render."
    });
  }

  const receiptContext = receipt
    ? `Datos visibles del comprobante actual:\n${JSON.stringify(receipt, null, 2)}`
    : "No hay un comprobante abierto actualmente.";

  const instructions = `
Eres ContaBot, asistente de ContaScan IA para estudiantes y pequeños negocios del Perú.
Responde únicamente en español claro, directamente a la pregunta y sin mostrar planificación,
reglas internas, listas de control, borradores ni razonamiento previo.

Puedes explicar campos de comprobantes, IGV, RUC, serie, número, base imponible,
duplicados, exportaciones y asientos contables referenciales basados en el PCGE.

Reglas:
- No inventes datos del comprobante.
- Señala que los asientos son referenciales y deben revisarse por un contador.
- No presentes validaciones SUNAT como realizadas si la aplicación no las hizo.
- Para normas tributarias cambiantes, recomienda revisar SUNAT o consultar a un profesional.
- Máximo 180 palabras, salvo que el usuario pida más detalle.

${receiptContext}

Pregunta del usuario: ${question}
`;

  const schema = {
    type: "OBJECT",
    properties: {
      answer: { type: "STRING" }
    },
    required: ["answer"]
  };

  try {
    const candidates = await getGeminiCandidates(process.env.GEMINI_API_KEY);
    const errors = [];

    for (const model of candidates.slice(0, 8)) {
      for (const apiVersion of ["v1", "v1beta"]) {
        try {
          const endpoint =
            `https://generativelanguage.googleapis.com/${apiVersion}/models/${encodeURIComponent(model)}:generateContent`;
          const response = await fetch(endpoint, {
            method: "POST",
            headers: {
              "x-goog-api-key": process.env.GEMINI_API_KEY,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              contents: [{ role: "user", parts: [{ text: instructions }] }],
              generationConfig: {
                temperature: 0.2,
                maxOutputTokens: 500,
                responseMimeType: "application/json",
                responseSchema: schema
              }
            })
          });

          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data?.error?.message || `Estado ${response.status}`);

          const outputText = geminiText(data);
          if (!outputText) throw new Error("respuesta vacía");
          const parsed = parseJsonText(outputText);
          const answer = String(parsed?.answer || "").trim();

          if (isInvalidChatAnswer(answer)) {
            throw new Error("respuesta interna o incompleta");
          }

          return res.json({ ok: true, model, apiVersion, answer });
        } catch (error) {
          errors.push(`${model}/${apiVersion}: ${error.message}`);
        }
      }
    }

    throw new Error(errors.join(" | "));
  } catch (error) {
    console.error("ContaBot Gemini:", error.message);
    res.status(500).json({
      error: "ContaBot no pudo generar una respuesta válida. Inténtalo nuevamente."
    });
  }
});

app.get("/api/status", (_req, res) => {
  res.json({
    visionAI: Boolean(process.env.GEMINI_API_KEY),
    provider: "Google Gemini",
    model: process.env.GEMINI_MODEL || "gemini-3.5-flash",
    freeTier: true,
    mode: process.env.GEMINI_API_KEY ? "gemini-required" : "ocr-only"
  });
});

app.get("/api/gemini-test", async (_req, res) => {
  if (!process.env.GEMINI_API_KEY) {
    return res.status(503).json({ ok: false, error: "Falta GEMINI_API_KEY." });
  }

  try {
    const candidates = await getGeminiCandidates(process.env.GEMINI_API_KEY);
    const errors = [];
    const schema = {
      type: "OBJECT",
      properties: { answer: { type: "STRING" } },
      required: ["answer"]
    };

    for (const model of candidates.slice(0, 8)) {
      for (const apiVersion of ["v1", "v1beta"]) {
        try {
          const endpoint =
            `https://generativelanguage.googleapis.com/${apiVersion}/models/${encodeURIComponent(model)}:generateContent`;
          const response = await fetch(endpoint, {
            method: "POST",
            headers: {
              "x-goog-api-key": process.env.GEMINI_API_KEY,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              contents: [{ parts: [{ text: "Devuelve un JSON con answer igual a CONEXION_OK." }] }],
              generationConfig: {
                temperature: 0,
                maxOutputTokens: 60,
                responseMimeType: "application/json",
                responseSchema: schema
              }
            })
          });

          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data?.error?.message || `Estado ${response.status}`);
          const outputText = geminiText(data);
          const parsed = parseJsonText(outputText);
          const answer = String(parsed?.answer || "").trim();
          if (answer !== "CONEXION_OK") throw new Error("respuesta de prueba inválida");

          return res.json({
            ok: true,
            model,
            apiVersion,
            answer,
            automaticSelection: true,
            availableCandidates: candidates.slice(0, 8)
          });
        } catch (error) {
          errors.push(`${model}/${apiVersion}: ${error.message}`);
        }
      }
    }

    return res.status(502).json({
      ok: false,
      error: "No se encontró un modelo Gemini utilizable para esta clave.",
      detail: errors.join(" | "),
      candidates: candidates.slice(0, 8)
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.use((err, _req, res, _next) => {
  res.status(400).json({ error: err.message || "Ocurrió un error." });
});

app.listen(PORT, () => {
  console.log(`ContaScan IA disponible en http://localhost:${PORT}`);
});
