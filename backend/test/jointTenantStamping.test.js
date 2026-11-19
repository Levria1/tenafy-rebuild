const test=require('node:test');
const assert=require('node:assert/strict');
const {PDFDocument,StandardFonts,rgb}=require('pdf-lib');
const {stampLease}=require('../src/services/signatureStamper');
const {SIGNATURE_MARKERS}=require('../src/services/leaseTemplateVariables');
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('non-tenant signers never take tenant anchors; fallback signatures and audit rows paginate',async()=>{
 const source=await PDFDocument.create();const page=source.addPage();const font=await source.embedFont(StandardFonts.Helvetica);
 page.drawText(SIGNATURE_MARKERS.TENANT_1,{x:50,y:450,font,size:8,color:rgb(1,1,1)});
 page.drawText(SIGNATURE_MARKERS.TENANT_2,{x:300,y:450,font,size:8,color:rgb(1,1,1)});
 const party=(i,role,tenant_id=null)=>({id:String(i),tenant_id,signer_name:`Test Signer ${i}`,signer_email:`s${i}@example.invalid`,role,sort_order:i,status:2,signature_png:png,typed_name:`Test Signer ${i}`,signed_at:new Date('2026-11-19T04:00:00Z'),signer_ip:'127.0.0.1',signer_ua:'Synthetic test'});
 // A guarantor appears first deliberately. Only tenant records own the anchors.
 const parties=[party(0,'guarantor'),party(1,'tenant','1'),party(2,'tenant','2'),...Array.from({length:9},(_,i)=>party(i+3,'other'))];
 const bytes=await stampLease({unsignedPdf:await source.save(),parties,landlordSig:null,request:{id:'TEST',sent_at:new Date('2026-11-19T04:00:00Z')}});
 const pdfjs=require('pdfjs-dist/legacy/build/pdf.js');
 const task=pdfjs.getDocument({data:new Uint8Array(bytes),isEvalSupported:false});const d=await task.promise;
 assert.ok(d.numPages>4);
 const first=await d.getPage(1);const operators=await first.getOperatorList();
 assert.equal(operators.fnArray.filter(op=>op===pdfjs.OPS.paintImageXObject).length,2);
 let text='';
 for(let i=1;i<=d.numPages;i++){
  const p=await d.getPage(i),content=await p.getTextContent();
  for(const item of content.items){
   if(item.str.includes('Test Signer'))assert.ok(item.transform[5]>0,'Signer text fell below page');
   text+=item.str+'\n';
  }
 }
 assert.match(text,/GUARANTOR SIGNATURE/);assert.match(text,/ADDITIONAL SIGNATURE/);
 for(const p of parties)assert.ok(text.includes(p.signer_name));
 await task.destroy();
});
