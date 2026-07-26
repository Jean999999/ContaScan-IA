
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
      return cb(new Error("El servidor recibe imágenes JPG, PNG o WEBP. Los PDF se convierten automáticamente en el navegador."));
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
  const clean = String(text || "").replace(/\r/g, "");
  const oneLine = clean.toUpperCase().replace(/[|]/g, " ").replace(/\s+/g, " ").trim();

  const rucCandidates = [...oneLine.matchAll(/\b(?:10|15|17|20)\s*\d(?:[\s.-]*\d){8,9}\b/g)]
    .map(m => m[0].replace(/\D/g, "")).filter(x => x.length === 11);

  const dateMatch = oneLine.match(/\b(\d{2})[\/.-](\d{2})[\/.-](\d{4})\b/) ||
                    oneLine.match(/\b(\d{4})[\/.-](\d{2})[\/.-](\d{2})\b/);

  const docMatch = oneLine.match(/\b([FBE][A-Z0-9]{3})\s*[-–—]\s*(\d{1,10})\b/) ||
                   oneLine.match(/\b([FBE][A-Z0-9]{3})\s+(\d{1,10})\b/);

  function lastAmount(patterns) {
    const vals=[];
    for (const p of patterns) for (const m of oneLine.matchAll(p)) {
      const n=normalizeMoney(m[m.length-1]); if(n!==null) vals.push(n);
    }
    return vals.length ? vals.at(-1) : null;
  }

  const total=lastAmount([/(?:IMPORTE\s+TOTAL|TOTAL\s+A\s+PAGAR|TOTAL\s+VENTA|TOTAL)[^\d]{0,25}(?:S\/.?|PEN|US\$|\$)?\s*(\d{1,9}(?:[.,]\d{2}))/g]);
  const igv=lastAmount([/(?:I\.?\s*G\.?\s*V\.?|IGV\s*18\s*%|IMPUESTO\s+GENERAL\s+A\s+LAS\s+VENTAS)[^\d]{0,25}(?:S\/.?|PEN|US\$|\$)?\s*(\d{1,9}(?:[.,]\d{2}))/g]);
  let subtotal=lastAmount([/(?:OP\.?\s*GRAVADA|OPERACI[ÓO]N\s+GRAVADA|VALOR\s+DE\s+VENTA|SUB\s*TOTAL|SUBTOTAL|BASE\s+IMPONIBLE)[^\d]{0,25}(?:S\/.?|PEN|US\$|\$)?\s*(\d{1,9}(?:[.,]\d{2}))/g]);
  if(total!==null && subtotal===null && igv!==null) subtotal=Number((total-igv).toFixed(2));

  const lines=clean.split("\n").map(x=>x.replace(/\s+/g," ").trim()).filter(Boolean);
  const excluded=/FACTURA|BOLETA|RECIBO|RUC|SUNAT|TOTAL|IGV|CLIENTE|DIRECCI[ÓO]N|FECHA|SERIE|N[ÚU]MERO|DESCRIPCI[ÓO]N/i;
  const suffix=/\b(S\.?A\.?C\.?|S\.?A\.?|E\.?I\.?R\.?L\.?|S\.?R\.?L\.?)\b/i;
  const businessName=lines.find(x=>x.length>=5&&x.length<=100&&suffix.test(x)&&!excluded.test(x)) ||
                     lines.find(x=>x.length>=6&&x.length<=80&&/[A-Za-zÁÉÍÓÚÑáéíóúñ]{4}/.test(x)&&!excluded.test(x)) || "";

  let issueDate="";
  if(dateMatch) issueDate=dateMatch[1].length===4 ? `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}` : `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`;

  let type="Otro";
  if(/NOTA\s+DE\s+CR[ÉE]DITO/.test(oneLine)) type="Nota de crédito";
  else if(/NOTA\s+DE\s+D[ÉE]BITO/.test(oneLine)) type="Nota de débito";
  else if(/RECIBO\s+POR\s+HONORARIOS/.test(oneLine)) type="Recibo por honorarios";
  else if(/FACTURA/.test(oneLine)) type="Factura";
  else if(/BOLETA/.test(oneLine)) type="Boleta de venta";

  const series=docMatch?.[1]||"";
  const number=docMatch?.[2]||"";
  const found=[rucCandidates[0],series,number,issueDate,total,businessName].filter(Boolean).length;
  return {type,ruc:rucCandidates[0]||"",businessName,issueDate,series,number:number?String(number).padStart(8,"0"):"",subtotal:subtotal??"",igv:igv??"",total:total??"",currency:/US\$|USD|D[ÓO]LAR/.test(oneLine)?"USD":"PEN",confidence:Math.min(98,38+found*10)};
}

app.post("/api/scan", upload.single("document"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No se recibió ningún archivo." });

  let worker;
  try {
    worker = await createWorker("spa");
    await worker.setParameters({ tessedit_pageseg_mode: "6", preserve_interword_spaces: "1", user_defined_dpi: "300" });
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
