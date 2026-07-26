
const $ = id => document.getElementById(id);
const titles = {dashboard:"Panel principal",scanner:"Escanear comprobante",documents:"Comprobantes",entries:"Asientos contables",exports:"Exportaciones"};
let file = null;
let records = JSON.parse(localStorage.getItem("contascan_pro_records") || "[]");

document.querySelectorAll(".nav").forEach(btn => btn.addEventListener("click", () => show(btn.dataset.view)));
document.querySelectorAll("[data-go]").forEach(btn => btn.addEventListener("click", () => show(btn.dataset.go)));

function show(id){
  document.querySelectorAll(".view").forEach(v=>v.classList.remove("active"));
  document.querySelectorAll(".nav").forEach(v=>v.classList.remove("active"));
  $(id).classList.add("active");
  document.querySelector(`[data-view="${id}"]`)?.classList.add("active");
  $("viewTitle").textContent=titles[id];
  if(id==="documents") renderDocuments();
  if(id==="entries") renderEntries();
  if(id==="dashboard") updateDashboard();
}

$("fileInput").addEventListener("change", e => selectFile(e.target.files[0]));
$("dropzone").addEventListener("dragover", e => {e.preventDefault(); $("dropzone").style.borderColor="#2b72ff"});
$("dropzone").addEventListener("dragleave", () => $("dropzone").style.borderColor="");
$("dropzone").addEventListener("drop", e => {e.preventDefault(); selectFile(e.dataTransfer.files[0])});
$("removeFile").addEventListener("click", resetScanner);
$("resetBtn").addEventListener("click", resetScanner);
$("scanBtn").addEventListener("click", scanFile);
$("saveBtn").addEventListener("click", saveRecord);
$("sunatBtn").addEventListener("click",()=>window.open("https://e-consultaruc.sunat.gob.pe/cl-ti-itmrconsruc/jcrS00Alias","_blank"));
$("searchInput").addEventListener("input",renderDocuments);
$("exportCsv").addEventListener("click",exportCSV);
$("exportTxt").addEventListener("click",exportTXT);
["ruc","series","number"].forEach(id=>$(id).addEventListener("input",checkDuplicate));

function selectFile(selected){
  if(!selected) return;
  if(!["image/jpeg","image/png","image/webp"].includes(selected.type)){toast("Usa una imagen JPG, PNG o WEBP");return}
  if(selected.size>12*1024*1024){toast("El archivo supera los 12 MB");return}
  file=selected;
  $("selectedName").textContent=selected.name;
  $("selectedSize").textContent=(selected.size/1024/1024).toFixed(2)+" MB";
  $("selectedFile").classList.remove("hidden");
  $("scanBtn").disabled=false;
  const img=document.createElement("img");
  img.src=URL.createObjectURL(selected);
  $("previewArea").innerHTML="";
  $("previewArea").appendChild(img);
}

async function scanFile(){
  if(!file) return;
  $("progressBox").classList.remove("hidden");
  $("resultCard").classList.add("hidden");
  setProgress(18,"Subiendo imagen...");
  const form=new FormData();
  form.append("document",file);
  try{
    setProgress(42,"La IA está leyendo el comprobante...");
    const response=await fetch("/api/scan",{method:"POST",body:form});
    const data=await response.json();
    if(!response.ok) throw new Error(data.error||"No se pudo procesar");
    setProgress(88,"Organizando los datos detectados...");
    fill(data.parsed);
    $("confidenceBadge").textContent=`OCR ${data.ocrConfidence}% · extracción ${data.parsed.confidence}%`;
    $("resultCard").classList.remove("hidden");
    setProgress(100,"Lectura completada");
    toast("Comprobante leído correctamente");
  }catch(e){toast(e.message);setProgress(0,"No se pudo completar la lectura")}
}

function fill(d){
  ["type","ruc","businessName","issueDate","series","number","currency","subtotal","igv","total"].forEach(id=>{
    if(d[id]!==undefined && d[id]!==null) $(id).value=d[id];
  });
  checkDuplicate();
}

function checkDuplicate(){
  const key=[$("ruc").value.trim(),$("series").value.trim().toUpperCase(),$("number").value.trim()].join("|");
  const duplicate=key!=="||"&&records.some(r=>r.key===key);
  $("duplicateAlert").classList.toggle("hidden",!duplicate);
}

async function saveRecord(){
  if(!$("ruc").value||!$("series").value||!$("number").value||!$("total").value){toast("Completa RUC, serie, número y total");return}
  const record={
    id:Date.now(),
    key:[$("ruc").value.trim(),$("series").value.trim().toUpperCase(),$("number").value.trim()].join("|"),
    type:$("type").value,ruc:$("ruc").value.trim(),businessName:$("businessName").value.trim()||"Proveedor no identificado",
    issueDate:$("issueDate").value||new Date().toISOString().slice(0,10),series:$("series").value.trim().toUpperCase(),
    number:$("number").value.trim(),currency:$("currency").value,subtotal:Number($("subtotal").value||0),
    igv:Number($("igv").value||0),total:Number($("total").value||0),category:$("category").value,
    categoryText:$("category").selectedOptions[0].text,duplicate:records.some(r=>r.key===[$("ruc").value.trim(),$("series").value.trim().toUpperCase(),$("number").value.trim()].join("|"))
  };
  const response=await fetch("/api/accounting-entry",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(record)});
  const data=await response.json();
  record.entry=data.entry;
  records.unshift(record);
  localStorage.setItem("contascan_pro_records",JSON.stringify(records));
  toast("Comprobante guardado y asiento generado");
  resetScanner();updateDashboard();show("documents");
}

function renderDocuments(){
  const q=$("searchInput").value.toLowerCase();
  const list=records.filter(r=>[r.ruc,r.businessName,r.series,r.number].join(" ").toLowerCase().includes(q));
  $("documentsBody").innerHTML=list.map(r=>`<tr><td>${datePE(r.issueDate)}</td><td>${esc(r.series)}-${esc(r.number)}</td><td>${esc(r.businessName)}</td><td>${esc(r.ruc)}</td><td>${money(r.total,r.currency)}</td><td><span class="tag ${r.duplicate?"dup":""}">${r.duplicate?"Duplicado":"Registrado"}</span></td></tr>`).join("");
  $("documentsEmpty").classList.toggle("hidden",list.length>0);
}

function renderEntries(){
  $("entriesList").innerHTML=records.map(r=>`<article class="entry-card"><header><div><strong>${esc(r.entry.description)}</strong><small>${datePE(r.issueDate)}</small></div><b>${money(r.total,r.currency)}</b></header><table><thead><tr><th>Cuenta</th><th>Descripción</th><th>Debe</th><th>Haber</th></tr></thead><tbody>${r.entry.lines.map(l=>`<tr><td>${l.account}</td><td>${esc(l.name)}</td><td>${l.debit?money(l.debit,r.currency):""}</td><td>${l.credit?money(l.credit,r.currency):""}</td></tr>`).join("")}</tbody></table></article>`).join("");
  $("entriesEmpty").classList.toggle("hidden",records.length>0);
}

function updateDashboard(){
  $("metricDocs").textContent=records.length;
  $("metricEntries").textContent=records.length;
  $("metricDup").textContent=records.filter(r=>r.duplicate).length;
  $("metricTime").textContent=(records.length*4)+" min";
  $("recentDocs").innerHTML=records.length?records.slice(0,4).map(r=>`<div style="display:flex;justify-content:space-between;gap:10px;padding:11px 0;border-bottom:1px solid #e6ebf2"><div><strong>${esc(r.businessName)}</strong><small style="display:block;color:#6e7d96;margin-top:4px">${r.series}-${r.number}</small></div><b>${money(r.total,r.currency)}</b></div>`).join(""):"Todavía no hay documentos procesados.";
}

function exportCSV(){
  if(!records.length){toast("No hay información para exportar");return}
  const rows=[["Fecha","Tipo","RUC","Razón social","Serie","Número","Moneda","Base imponible","IGV","Total","Estado"]];
  records.forEach(r=>rows.push([r.issueDate,r.type,r.ruc,r.businessName,r.series,r.number,r.currency,r.subtotal,r.igv,r.total,r.duplicate?"Duplicado":"Registrado"]));
  const csv="\ufeff"+rows.map(row=>row.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(";")).join("\n");
  download(csv,"contascan_comprobantes.csv","text/csv;charset=utf-8");
}
function exportTXT(){
  if(!records.length){toast("No hay asientos para exportar");return}
  let text="CONTASCAN IA - ASIENTOS CONTABLES REFERENCIALES\n\n";
  records.forEach((r,i)=>{text+=`ASIENTO ${i+1} | ${r.issueDate} | ${r.series}-${r.number} | ${r.businessName}\n`;r.entry.lines.forEach(l=>text+=`${l.account}|${l.name}|${l.debit.toFixed(2)}|${l.credit.toFixed(2)}\n`);text+="\n"});
  download(text,"contascan_asientos.txt","text/plain;charset=utf-8");
}
function download(content,name,type){const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([content],{type}));a.download=name;a.click();URL.revokeObjectURL(a.href)}
function resetScanner(){file=null;$("fileInput").value="";$("selectedFile").classList.add("hidden");$("scanBtn").disabled=true;$("resultCard").classList.add("hidden");$("progressBox").classList.add("hidden");$("previewArea").innerHTML='<div>▧</div><p>La imagen aparecerá aquí.</p>';document.querySelectorAll("#resultCard input").forEach(i=>i.value="");$("duplicateAlert").classList.add("hidden")}
function setProgress(v,t){$("progressBar").style.width=v+"%";$("progressText").textContent=t}
function money(n,c){return new Intl.NumberFormat("es-PE",{style:"currency",currency:c||"PEN"}).format(Number(n||0))}
function datePE(d){return new Date(d+"T00:00:00").toLocaleDateString("es-PE")}
function esc(s=""){return String(s).replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]))}
function toast(msg){$("toast").textContent=msg;$("toast").classList.add("show");setTimeout(()=>$("toast").classList.remove("show"),2600)}
updateDashboard();
