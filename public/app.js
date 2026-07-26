
const $ = id => document.getElementById(id);
const titles = {dashboard:"Panel principal",scanner:"Escanear comprobante",documents:"Comprobantes",entries:"Asientos contables",exports:"Exportaciones"};
let file = null;
let extractedPdfText = "";
let cameraStream = null;
let cameraFacingMode = "environment";
let cameraOpening = false;
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
$("cameraInput")?.addEventListener("change", e => {
  selectFile(e.target.files[0]);
  e.target.value="";
});
$("cameraBtn")?.addEventListener("click", openCamera);
$("cameraClose")?.addEventListener("click", closeCamera);
$("cameraCancel")?.addEventListener("click", closeCamera);
$("cameraCapture")?.addEventListener("click", captureCameraPhoto);
$("cameraSwitch")?.addEventListener("click", switchCamera);
$("cameraModal")?.addEventListener("click", event => {
  if(event.target===$("cameraModal")) closeCamera();
});
document.addEventListener("visibilitychange",()=>{
  if(document.hidden && cameraStream) closeCamera();
});
window.addEventListener("beforeunload", stopCameraStream);
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

function setCameraStatus(message,visible=true){
  const status=$("cameraStatus");
  if(!status)return;
  status.textContent=message;
  status.classList.toggle("hidden",!visible);
}

function stopCameraStream(){
  if(cameraStream){
    cameraStream.getTracks().forEach(track=>track.stop());
    cameraStream=null;
  }
  const video=$("cameraVideo");
  if(video) video.srcObject=null;
}

function showCameraModal(){
  $("cameraModal")?.classList.remove("hidden");
  document.body.classList.add("camera-open");
  $("cameraCapture").disabled=true;
  setCameraStatus("Solicitando acceso a la cámara…");
}

function hideCameraModal(){
  $("cameraModal")?.classList.add("hidden");
  document.body.classList.remove("camera-open");
}

async function startCameraStream(){
  if(cameraOpening)return;
  cameraOpening=true;
  stopCameraStream();
  $("cameraCapture").disabled=true;
  setCameraStatus("Iniciando cámara…");

  try{
    const constraints={
      audio:false,
      video:{
        facingMode:{ideal:cameraFacingMode},
        width:{ideal:1920},
        height:{ideal:2560}
      }
    };
    cameraStream=await navigator.mediaDevices.getUserMedia(constraints);
    const video=$("cameraVideo");
    video.srcObject=cameraStream;
    await new Promise((resolve,reject)=>{
      const ready=()=>{cleanup();resolve()};
      const fail=()=>{cleanup();reject(new Error("No se pudo iniciar la vista previa"))};
      const cleanup=()=>{
        video.removeEventListener("loadedmetadata",ready);
        video.removeEventListener("error",fail);
      };
      if(video.readyState>=1)return ready();
      video.addEventListener("loadedmetadata",ready,{once:true});
      video.addEventListener("error",fail,{once:true});
    });
    await video.play();
    setCameraStatus("",false);
    $("cameraCapture").disabled=false;

    try{
      const devices=await navigator.mediaDevices.enumerateDevices();
      const cameras=devices.filter(device=>device.kind==="videoinput");
      $("cameraSwitch")?.classList.toggle("hidden",cameras.length<2);
    }catch(_error){}
  }finally{
    cameraOpening=false;
  }
}

async function openCamera(){
  if(!navigator.mediaDevices?.getUserMedia){
    toast("Tu navegador abrirá la cámara mediante el selector del celular");
    $("cameraInput")?.click();
    return;
  }

  showCameraModal();
  try{
    await startCameraStream();
  }catch(error){
    stopCameraStream();
    hideCameraModal();
    const denied=error?.name==="NotAllowedError" || error?.name==="PermissionDeniedError";
    toast(denied
      ? "Permite el acceso a la cámara en el navegador y vuelve a intentarlo"
      : "No se pudo abrir la cámara. Puedes seleccionar una foto del celular.");
  }
}

function closeCamera(){
  stopCameraStream();
  hideCameraModal();
  setCameraStatus("Solicitando acceso a la cámara…");
}

async function switchCamera(){
  if(cameraOpening)return;
  cameraFacingMode=cameraFacingMode==="environment"?"user":"environment";
  try{
    await startCameraStream();
  }catch(error){
    cameraFacingMode=cameraFacingMode==="environment"?"user":"environment";
    toast("No se encontró otra cámara disponible");
    try{await startCameraStream()}catch(_error){closeCamera()}
  }
}

async function captureCameraPhoto(){
  const video=$("cameraVideo");
  const canvas=$("cameraCanvas");
  if(!cameraStream || !video?.videoWidth || !video?.videoHeight){
    toast("Espera a que la cámara esté lista");
    return;
  }

  $("cameraCapture").disabled=true;
  const flash=$("cameraFlash");
  flash?.classList.add("active");
  setTimeout(()=>flash?.classList.remove("active"),180);

  canvas.width=video.videoWidth;
  canvas.height=video.videoHeight;
  const context=canvas.getContext("2d",{willReadFrequently:true});
  context.drawImage(video,0,0,canvas.width,canvas.height);

  try{
    const blob=await new Promise((resolve,reject)=>{
      canvas.toBlob(
        value=>value?resolve(value):reject(new Error("No se pudo capturar la foto")),
        "image/jpeg",
        .94
      );
    });
    const capturedFile=new File(
      [blob],
      `comprobante-${new Date().toISOString().replace(/[:.]/g,"-")}.jpg`,
      {type:"image/jpeg",lastModified:Date.now()}
    );
    closeCamera();
    await selectFile(capturedFile);
    toast("Foto capturada. Pulsa ‘Leer con IA’ para procesarla.");
  }catch(error){
    $("cameraCapture").disabled=false;
    toast(error.message||"No se pudo tomar la foto");
  }
}

async function selectFile(selected){
  if(!selected) return;
  const allowed=["image/jpeg","image/png","image/webp","application/pdf"];
  if(!allowed.includes(selected.type)){toast("Usa PDF, JPG, PNG o WEBP");return}
  if(selected.size>12*1024*1024){toast("El archivo supera los 12 MB");return}
  file=selected;
  $("selectedName").textContent=selected.name;
  $("selectedSize").textContent=(selected.size/1024/1024).toFixed(2)+" MB";
  $("selectedFile").classList.remove("hidden"); $("scanBtn").disabled=false;
  try{
    const blob=selected.type==="application/pdf"?await pdfFirstPageToBlob(selected,1.4):selected;
    const img=document.createElement("img"); img.src=URL.createObjectURL(blob);
    $("previewArea").innerHTML=""; $("previewArea").appendChild(img);
  }catch(e){toast("No se pudo mostrar la vista previa")}
}
async function readPdf(pdfFile, scale=3.2){
  if(!window.pdfjsLib) throw new Error("No se cargó el lector PDF");
  const pdf=await pdfjsLib.getDocument({data:await pdfFile.arrayBuffer()}).promise;
  const page=await pdf.getPage(1);

  // Extrae texto real cuando el PDF es digital.
  const content=await page.getTextContent();
  extractedPdfText=content.items.map(item=>item.str).join(" ");

  const viewport=page.getViewport({scale});
  const canvas=document.createElement("canvas");
  canvas.width=Math.ceil(viewport.width);
  canvas.height=Math.ceil(viewport.height);
  await page.render({
    canvasContext:canvas.getContext("2d",{willReadFrequently:true}),
    viewport
  }).promise;

  return preprocessCanvasToBlob(canvas);
}

async function pdfFirstPageToBlob(pdfFile,scale=3.2){
  return readPdf(pdfFile,scale);
}
async function imageToProcessedBlob(imageFile){
  const bitmap=await createImageBitmap(imageFile); const scale=Math.max(1,Math.min(3,2400/bitmap.width));
  const canvas=document.createElement("canvas"); canvas.width=Math.round(bitmap.width*scale); canvas.height=Math.round(bitmap.height*scale);
  canvas.getContext("2d",{willReadFrequently:true}).drawImage(bitmap,0,0,canvas.width,canvas.height);
  return preprocessCanvasToBlob(canvas);
}
async function preprocessCanvasToBlob(canvas){
  const source=canvas.getContext("2d",{willReadFrequently:true});
  const image=source.getImageData(0,0,canvas.width,canvas.height);
  const d=image.data;

  // Busca los límites del documento ignorando márgenes blancos.
  let minX=canvas.width, minY=canvas.height, maxX=0, maxY=0;
  const step=Math.max(1,Math.floor(Math.min(canvas.width,canvas.height)/1200));

  for(let y=0;y<canvas.height;y+=step){
    for(let x=0;x<canvas.width;x+=step){
      const i=(y*canvas.width+x)*4;
      const gray=.299*d[i]+.587*d[i+1]+.114*d[i+2];
      if(gray<242){
        if(x<minX)minX=x; if(x>maxX)maxX=x;
        if(y<minY)minY=y; if(y>maxY)maxY=y;
      }
    }
  }

  let cropX=0,cropY=0,cropW=canvas.width,cropH=canvas.height;
  if(maxX>minX && maxY>minY){
    const pad=Math.round(Math.max(canvas.width,canvas.height)*.018);
    cropX=Math.max(0,minX-pad);
    cropY=Math.max(0,minY-pad);
    cropW=Math.min(canvas.width-cropX,maxX-minX+pad*2);
    cropH=Math.min(canvas.height-cropY,maxY-minY+pad*2);
  }

  const cropped=document.createElement("canvas");
  const desiredWidth=Math.min(3000,Math.max(2200,cropW*2));
  const ratio=desiredWidth/cropW;
  cropped.width=Math.round(cropW*ratio);
  cropped.height=Math.round(cropH*ratio);
  const ctx=cropped.getContext("2d",{willReadFrequently:true});
  ctx.drawImage(canvas,cropX,cropY,cropW,cropH,0,0,cropped.width,cropped.height);

  const im=ctx.getImageData(0,0,cropped.width,cropped.height);
  const px=im.data;
  for(let i=0;i<px.length;i+=4){
    let g=.299*px[i]+.587*px[i+1]+.114*px[i+2];
    g=(g-128)*1.55+128;
    g=Math.max(0,Math.min(255,g));
    px[i]=px[i+1]=px[i+2]=g;
  }
  ctx.putImageData(im,0,0);

  return new Promise((resolve,reject)=>
    cropped.toBlob(
      blob=>blob?resolve(blob):reject(new Error("No se pudo preparar el documento")),
      "image/png",
      1
    )
  );
}

async function scanFile(){
  if(!file) return; $("progressBox").classList.remove("hidden"); $("resultCard").classList.add("hidden"); $("scanBtn").disabled=true;
  try{
    setProgress(15,"Preparando el documento...");
    const blob=file.type==="application/pdf"?await pdfFirstPageToBlob(file,2.8):await imageToProcessedBlob(file);
    const form=new FormData(); form.append("document",blob,"documento.png"); form.append("pdfText",extractedPdfText||"");
    setProgress(42,"Analizando varias versiones del documento...");
    const response=await fetch("/api/scan",{method:"POST",body:form}); const data=await response.json();
    if(!response.ok) throw new Error(data.error||"No se pudo procesar");
    setProgress(92,"Organizando los datos..."); fill(data.parsed);
    const engineName=data.engine==="gemini"
      ? `Gemini (${data.model||"modelo activo"})`
      : "OCR de respaldo";
    $("confidenceBadge").textContent=`${engineName} · precisión ${Math.round(data.parsed.confidence||data.ocrConfidence||0)}%`;
    $("resultCard").classList.remove("hidden"); setProgress(100,"Lectura completada"); toast("Documento leído. Revisa los campos.");
  }catch(e){toast(e.message);setProgress(0,"No se pudo completar la lectura")}finally{$("scanBtn").disabled=false}
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
function resetScanner(){closeCamera();file=null;extractedPdfText="";$("fileInput").value="";if($("cameraInput"))$("cameraInput").value="";$("selectedFile").classList.add("hidden");$("scanBtn").disabled=true;$("resultCard").classList.add("hidden");$("progressBox").classList.add("hidden");$("previewArea").innerHTML='<div>▧</div><p>La imagen aparecerá aquí.</p>';document.querySelectorAll("#resultCard input").forEach(i=>i.value="");$("duplicateAlert").classList.add("hidden")}
function setProgress(v,t){$("progressBar").style.width=v+"%";$("progressText").textContent=t}
function money(n,c){return new Intl.NumberFormat("es-PE",{style:"currency",currency:c||"PEN"}).format(Number(n||0))}
function datePE(d){return new Date(d+"T00:00:00").toLocaleDateString("es-PE")}
function esc(s=""){return String(s).replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]))}
function toast(msg){$("toast").textContent=msg;$("toast").classList.add("show");setTimeout(()=>$("toast").classList.remove("show"),2600)}
updateDashboard();


async function updateEngineStatus(){
  try{
    const data=await fetch("/api/status").then(r=>r.json());
    const card=document.querySelector(".mini-card");
    if(!card)return;
    const strong=card.querySelector("strong");
    const small=card.querySelector("small");
    if(data.visionAI){
      strong.textContent="Gemini IA activa";
      small.textContent="Lectura gratuita configurada";
    }else{
      strong.textContent="OCR básico activo";
      small.textContent="Configura GEMINI_API_KEY en Render";
    }
  }catch(_e){}
}
updateEngineStatus();


function currentReceiptForAssistant(){
  const resultCard=$("resultCard");
  if(!resultCard || resultCard.classList.contains("hidden")) return null;
  return {
    type:$("type")?.value||"",
    ruc:$("ruc")?.value||"",
    businessName:$("businessName")?.value||"",
    issueDate:$("issueDate")?.value||"",
    series:$("series")?.value||"",
    number:$("number")?.value||"",
    subtotal:$("subtotal")?.value||"",
    igv:$("igv")?.value||"",
    total:$("total")?.value||"",
    currency:$("currency")?.value||"PEN",
    category:$("category")?.selectedOptions?.[0]?.text||""
  };
}

function addChatMessage(text,role="bot",extraClass=""){
  const div=document.createElement("div");
  div.className=`chat-message ${role} ${extraClass}`.trim();
  div.textContent=text;
  $("chatMessages").appendChild(div);
  $("chatMessages").scrollTop=$("chatMessages").scrollHeight;
  return div;
}

async function askContaBot(question){
  const clean=String(question||"").trim();
  if(!clean)return;
  addChatMessage(clean,"user");
  $("chatInput").value="";
  const loading=addChatMessage("ContaBot está pensando…","bot","loading");

  try{
    const response=await fetch("/api/chat",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        question:clean,
        receipt:currentReceiptForAssistant()
      })
    });
    const data=await response.json();
    loading.remove();
    if(!response.ok)throw new Error(data.error||"No se pudo obtener respuesta");
    addChatMessage(data.answer,"bot");
  }catch(error){
    loading.remove();
    addChatMessage(error.message,"bot");
  }
}

$("chatLauncher")?.addEventListener("click",()=>{
  $("chatPanel").classList.toggle("hidden");
  if(!$("chatPanel").classList.contains("hidden")) $("chatInput").focus();
});
$("chatClose")?.addEventListener("click",()=>$("chatPanel").classList.add("hidden"));
$("chatForm")?.addEventListener("submit",event=>{
  event.preventDefault();
  askContaBot($("chatInput").value);
});
document.querySelectorAll("[data-question]").forEach(button=>{
  button.addEventListener("click",()=>askContaBot(button.dataset.question));
});


async function testGeminiConnection(){
  try{
    const response=await fetch("/api/gemini-test");
    const data=await response.json();
    if(!response.ok) throw new Error(data.error||"Conexión fallida");
    toast(`Gemini conectado: ${data.model}`);
    return true;
  }catch(error){
    toast(`Gemini no responde: ${error.message}`);
    return false;
  }
}

window.testGeminiConnection=testGeminiConnection;
