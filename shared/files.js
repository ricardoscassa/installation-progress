/* File formats and bounded ZIP reads; exports store photo Blobs without recompressing them. */
(function (root) {
  'use strict';
  const W = typeof module === 'object' && module.exports ? require('./weekly-core.js') : root.WeeklyCore;
  const encoder = new TextEncoder(), decoder = new TextDecoder();
  const crcTable = new Uint32Array(256).map((_,n)=>{ let c=n; for(let k=0;k<8;k++) c=(c&1)?0xedb88320^(c>>>1):c>>>1; return c>>>0; });
  function crc32(bytes) { let c=0xffffffff; for(const byte of bytes) c=crcTable[(c^byte)&255]^(c>>>8); return (c^0xffffffff)>>>0; }
  async function bytes(value) { return typeof value === 'string' ? encoder.encode(value) : value instanceof Blob ? new Uint8Array(await value.arrayBuffer()) : new Uint8Array(value); }
  async function sha(value) {
    const data = await bytes(value);
    return Array.from(new Uint8Array(await root.crypto.subtle.digest('SHA-256',data)),byte=>byte.toString(16).padStart(2,'0')).join('');
  }
  function safePath(path) {
    W.assert(typeof path === 'string' && path.length <= 300 && !path.startsWith('/') && !path.includes('\\') &&
      !path.split('/').some(value=>!value || value === '.' || value === '..' || /[\x00-\x1f]/.test(value)), 'Unsafe ZIP path.');
    return path;
  }
  function header(size,values) {
    const buffer = new ArrayBuffer(size), view = new DataView(buffer);
    for(const [offset,value,width] of values) width === 2 ? view.setUint16(offset,value,true) : view.setUint32(offset,value,true);
    return new Uint8Array(buffer);
  }
  async function zip(entries) {
    W.assert(entries.length <= 65534,'Too many files for one archive.');
    const parts=[],central=[],names=new Set(); let offset=0;
    for(const entry of entries) {
      const name=encoder.encode(safePath(entry.name));
      W.assert(!names.has(entry.name),'Duplicate ZIP entry.'); names.add(entry.name);
      let data=entry.data, size=data instanceof Blob ? data.size : (await bytes(data)).byteLength;
      let checksum=entry.crc, method=0;
      if (checksum === undefined || entry.compress) {
        const raw=await bytes(data); checksum=crc32(raw); size=raw.length; data=raw;
        if(entry.compress && root.pako) { data=root.pako.deflateRaw(raw); method=8; }
      }
      const packedSize=data instanceof Blob ? data.size : data.byteLength;
      W.assert(size < 0xffffffff && offset + packedSize + 1000 < 0xffffffff,'Archive is too large. Export a smaller photo date range.');
      const stamp=new Date(),dosTime=(stamp.getHours()<<11)|(stamp.getMinutes()<<5)|(stamp.getSeconds()>>1),dosDate=((stamp.getFullYear()-1980)<<9)|((stamp.getMonth()+1)<<5)|stamp.getDate();
      const local=header(30,[[0,0x04034b50,4],[4,20,2],[6,0x800,2],[8,method,2],[10,dosTime,2],[12,dosDate,2],[14,checksum,4],[18,packedSize,4],[22,size,4],[26,name.length,2]]);
      parts.push(local,name,data);
      const directory=header(46,[[0,0x02014b50,4],[4,20,2],[6,20,2],[8,0x800,2],[10,method,2],[12,dosTime,2],[14,dosDate,2],[16,checksum,4],[20,packedSize,4],[24,size,4],[28,name.length,2],[42,offset,4]]);
      central.push(directory,name); offset+=30+name.length+packedSize;
    }
    const centralSize=central.reduce((sum,part)=>sum+part.byteLength,0);
    const end=header(22,[[0,0x06054b50,4],[8,entries.length,2],[10,entries.length,2],[12,centralSize,4],[16,offset,4]]);
    return new Blob([...parts,...central,end],{type:'application/zip'});
  }
  async function loadZip(file,maxBytes=800*1024*1024) {
    W.assert(file.size <= maxBytes,'This archive exceeds the supported file size.');
    W.assert(root.JSZip,'Offline ZIP reader is unavailable. Reopen after Offline ready.');
    const archive=await root.JSZip.loadAsync(await file.arrayBuffer(),{createFolders:false});
    const entries=Object.values(archive.files);
    W.assert(entries.length <= 12000,'Too many archive entries.');
    let total=0;
    for(const entry of entries) {
      if(entry.dir) continue;
      safePath(entry.name);
      W.assert(!entry.unsafeOriginalName || entry.unsafeOriginalName === entry.name,'The ZIP contains a rewritten unsafe path.');
      const size=entry._data?.uncompressedSize;
      W.assert(Number.isSafeInteger(size) && size >= 0 && size <= 30*1024*1024,'An archive entry is too large.');
      total+=size;
      W.assert(total <= 1024*1024*1024,'The expanded archive is too large.');
    }
    return archive;
  }
  async function readEntry(archive,name,limit=20*1024*1024) {
    const entry=archive.file(safePath(name));
    W.assert(entry && entry._data.uncompressedSize <= limit,'A required archive file is missing or too large: '+name);
    const result=await entry.async('uint8array');
    W.assert(result.byteLength <= limit,'Archive entry exceeds its size limit.');
    return result;
  }
  async function jsonEntry(archive,name,limit) { return JSON.parse(decoder.decode(await readEntry(archive,name,limit))); }
  async function weeklyZip(model) {
    const packed=W.pack(model),json=W.stable(packed);
    return zip([{name:'week.json',data:json,compress:true},{name:'manifest.json',data:W.stable({format:'weekly-progress-package',schema:packed.schema,sha256:await sha(json),bytes:encoder.encode(json).length}),compress:true}]);
  }
  async function readWeekly(file) {
    const archive=await loadZip(file,20*1024*1024);
    const manifest=await jsonEntry(archive,'manifest.json',50000), raw=await readEntry(archive,'week.json');
    W.assert(manifest.format === 'weekly-progress-package' && [1,2].includes(manifest.schema) && manifest.bytes === raw.length && await sha(raw) === manifest.sha256,'Weekly package integrity check failed.');
    const packed=JSON.parse(decoder.decode(raw));W.assert(packed.schema === manifest.schema,'Weekly package schemas do not match.');return W.unpack(packed);
  }
  const FIELD_IDS=['Level','InstallationStatus','MetersInstalled','FieldWeld','WeldComplete','WelderID','Material','DiameterMM','SpoolLengthMM','ClampType','BatchNumber','DelayCode'];
  const HEADERS=['Format','RecordID','Revision','BatchID','WeekKey','EntryDate','PlanWeek','Building','Room','Commodity','CanonicalCommodity','GateStatusStructure',
    'GateCategory','DailyLogType','PreviousGateStatus','PreviousPercent','NewGateStatus','NewPercent','MpowerGateStatus','MpowerPercent','NoProgress','Activity',
    ...FIELD_IDS,'CommentsIssues','Source','VerificationState','UserName','UserEmail','SupervisorName','ApprovedAt','ApprovalID','PhotoCount','PhotoRelativePaths','RecordHash','RecordJSON'];
  function csvObject(payload,hash) {
    if(W.isCheckin(payload.record)){
      const r=payload.record;
      return {Format:'WeeklyProgress/1',RecordID:r.id,Revision:r.revision,BatchID:r.batchId,WeekKey:r.weekKey,EntryDate:r.date,Building:r.building,
        ...(r.kind === 'work-group-no-progress'?{DailyLogType:W.scopeDisciplines(r).join(', ')}:{}),
        NoProgress:true,Activity:r.kind === 'work-group-no-progress'?'No Progress · '+W.groupLabel(r.groupId):'Building No Progress',UserName:r.operator.name,UserEmail:r.operator.email,SupervisorName:r.supervisorName,PhotoCount:0,RecordHash:hash,RecordJSON:W.stable(payload)};
    }
    const {record,item,approval,photos}=payload, flow=W.R.workflow(item);
    const rule=flow.rules.find(rule=>rule.code === record.fields.gate);
    const percent=record.fields.noProgress ? null : rule?.policy === 'Fixed' ? rule.percent : W.R.number(record.fields.percent);
    const object={Format:'WeeklyProgress/1',RecordID:record.id,Revision:record.revision,BatchID:record.batchId,WeekKey:record.weekKey,EntryDate:record.date,PlanWeek:item.planWeek,
      Building:item.building,Room:item.room,Commodity:item.commodity,CanonicalCommodity:W.R.canonical(item.commodity),GateStatusStructure:item.structure,
      GateCategory:flow.category,DailyLogType:flow.family,PreviousGateStatus:record.previous.gate,PreviousPercent:record.previous.percent,
      NewGateStatus:record.fields.noProgress?'':record.fields.gate,NewPercent:percent,MpowerGateStatus:item.mpowerGate,MpowerPercent:item.mpowerPercent,
      NoProgress:record.fields.noProgress === true,Activity:record.fields.noProgress?'No Progress':'Normal Progress',CommentsIssues:record.fields.comments || '',
      Source:item.manual?'Manual Unverified':item.origin,VerificationState:item.metadataIssues.length?'Needs Review':item.manual?'Unverified':'Verified',
      UserName:record.operator.name,UserEmail:record.operator.email,SupervisorName:approval.name,ApprovedAt:approval.signedAt,ApprovalID:approval.id,
      PhotoCount:photos.length,PhotoRelativePaths:photos.map(photo=>photo.path).join('|'),RecordHash:hash,RecordJSON:W.stable(payload)};
    FIELD_IDS.forEach(id=>{object[id]=record.fields[id] ?? '';});
    return object;
  }
  function cell(value) {
    let result=value == null ? '' : String(value);
    if(/^\s*[=+@-]/.test(result) || /^[\t\r]/.test(result)) result="'"+result;
    return '"'+result.replace(/"/g,'""')+'"';
  }
  const uncell=value=>/^'\s*[=+@-]/.test(value) || /^'[\t\r]/.test(value) ? value.slice(1) : value;
  function csv(rows) { return '\uFEFF'+[HEADERS,...rows.map(row=>{ const values=csvObject(row.payload,row.hash); return HEADERS.map(name=>values[name]); })].map(row=>row.map(cell).join(',')).join('\r\n')+'\r\n'; }
  async function parseCsv(input) {
    W.assert(encoder.encode(input).length <= 30*1024*1024,'CSV exceeds 30 MB.');
    const rows=W.R.parseDelimited(input,','), columns=rows.shift();
    W.assert(columns && columns.length === HEADERS.length && new Set(columns).size === columns.length && HEADERS.every(name=>columns.includes(name)),'Use the daily CSV produced by this application, with all its columns.');
    W.assert(rows.length && rows.length <= 10000,'CSV needs between 1 and 10,000 daily records.');
    const result=[],ids=new Set();
    for(const row of rows) {
      W.assert(row.length === columns.length,'A CSV row has the wrong number of columns.');
      const object=Object.fromEntries(columns.map((name,index)=>[name,uncell(row[index])]));
      W.assert(object.Format === 'WeeklyProgress/1','Unsupported daily CSV format.');
      const payload=JSON.parse(object.RecordJSON);
      await validatePayload(payload,object.RecordHash);
      const expected=csvObject(payload,object.RecordHash);
      W.assert(HEADERS.every(name=>String(expected[name] ?? '') === object[name]),'CSV display fields differ from the signed record. Make corrections in the app and review them again.');
      W.assert(!ids.has(payload.record.id),'Duplicate RecordID in CSV.'); ids.add(payload.record.id);
      result.push({payload,hash:object.RecordHash});
    }
    return result;
  }
  function photoMetadata(photo) {
    const {blob,originalBlob,...metadata}=photo;
    return {...metadata,path:W.photoPath(photo)};
  }
  async function payloadFor(session,model,record,photos) {
    if(W.isCheckin(record)){W.validateCheckin(record);const payload={format:record.kind === 'work-group-no-progress'?'weekly-progress-work-checkin':'weekly-progress-building-checkin',schema:1,sessionId:session.id,record:W.copy(record),photos:[]};return {payload,hash:await sha(W.stable(payload))};}
    const validation=W.validateRecord(session,model,record);
    W.assert(validation.ready,'Resolve draft requirements before export: '+validation.errors.join(' '));
    const approval=W.approvalFor(session,record);
    W.assert(approval,'Supervisor approval is required for '+record.id);
    const item=model.items.find(item=>item.id === record.itemId);
    const selected=record.photos.map(id=>{const photo=photos.find(photo=>photo.id === id); W.assert(photo,'A record photo is missing.'); return photoMetadata(photo);});
    const payload={format:'weekly-progress-record',schema:1,sessionId:session.id,record:W.copy({...record,history:[]}),
      item:W.copy(item),approval:{id:approval.id,name:approval.name,signedAt:approval.signedAt,revision:record.revision,fingerprint:W.fingerprint(record)},photos:selected};
    return {payload,hash:await sha(W.stable(payload))};
  }
  async function validatePayload(payload,hash) {
    if(['weekly-progress-building-checkin','weekly-progress-work-checkin'].includes(payload?.format)){
      W.assert(payload.schema === 1 && W.isCheckin(payload.record) && /^[0-9a-f]{64}$/.test(hash || '') && await sha(W.stable(payload)) === hash,'Building check-in integrity check failed.');
      W.assert(payload.record.kind === (payload.format === 'weekly-progress-work-checkin'?'work-group-no-progress':'building-no-progress'),'Check-in type does not match its format.');
      W.validateCheckin(payload.record);W.assert(Array.isArray(payload.photos) && payload.photos.length === 0 && !payload.item,'A building check-in must have zero ECS items and no photos.');return payload;
    }
    W.assert(payload?.format === 'weekly-progress-record' && payload.schema === 1 && /^[0-9a-f]{64}$/.test(hash || ''),'Unsupported daily record.');
    W.assert(await sha(W.stable(payload)) === hash,'Record integrity check failed.');
    const {record,item,approval,photos}=payload;
    W.assert(!record?.kind,'Building check-ins require their own zero-item format.');
    W.assert(record && item && approval && Array.isArray(photos) && record.id && record.batchId,'Daily record identity is missing.');
    W.date(record.date);
    W.assert(record.itemId === W.R.key(item.building,item.room,item.ecsCode) && record.itemId === item.id && record.weekKey && record.ruleVersion === W.R.gates.version,'Daily record identity or gate-rule version is invalid.');
    W.assert(record.config?.inspectionRequired === false && record.config?.photoRequired === false,'Unsupported daily-log configuration.');
    W.R.validateConfig(record.config);
    const validation=W.validateProgress(item,record.fields,record.config,record.previous);
    W.assert(validation.ready,'Invalid daily progress: '+validation.errors.join(' '));
    W.assert(approval.revision === record.revision && approval.fingerprint === W.fingerprint(record) && W.text(approval.name) && approval.id && Number.isFinite(Date.parse(approval.signedAt)),'Supervisor approval does not cover this record revision.');
    W.assert(photos.length === record.photos.length && new Set(record.photos).size === record.photos.length,'Photo associations are invalid.');
    photos.forEach((photo,index)=>{
      W.assert(photo.id === record.photos[index] && photo.itemId === item.id && photo.workDate === record.date && photo.building === item.building && photo.path === W.photoPath(photo) && /^[0-9a-f]{64}$/.test(photo.sha256),'Photo capture association is invalid.');
      safePath(photo.path);
    });
    return payload;
  }
  async function recoveryData(session,model,photos,pending=[],options={}) {
    W.validateSession(session,model,new Set(photos.map(photo=>photo.id)));
    for(const photo of [...photos,...pending])W.assert(photo.blob instanceof Blob && photo.blob.size === photo.size && await sha(photo.blob) === photo.sha256,'A recovery photo or interrupted original is missing or changed. Keep the local week and recover its evidence.');
    const data={format:'weekly-progress-recovery',schema:options.pairId?2:1,createdAt:options.createdAt || new Date().toISOString(),...(options.pairId?{pairId:options.pairId}:{}),package:W.pack(model),session:W.copy(session),
      photos:photos.map(photoMetadata),pending:pending.map(photo=>({...photoMetadata(photo),path:'pending/'+photo.id+'.image'}))};
    const raw=W.stable(data);
    const hash=await sha(raw),entries=[{name:'recovery.json',data:raw,compress:true},{name:'recovery-manifest.json',data:W.stable({schema:data.schema,sha256:hash,photos:photos.length,pending:pending.length}),compress:true}];
    if(!options.pairId){photos.forEach(photo=>entries.push({name:W.photoPath(photo),data:photo.blob,crc:photo.crc32}));pending.forEach(photo=>entries.push({name:'pending/'+photo.id+'.image',data:photo.blob,crc:photo.crc32}));}
    return {entries,data,hash};
  }
  async function readRecovery(file,companionFile=null) {
    const archive=await loadZip(file), raw=await readEntry(archive,'recovery.json',30*1024*1024);
    const manifest=await jsonEntry(archive,'recovery-manifest.json',50000), data=JSON.parse(decoder.decode(raw));
    W.assert([1,2].includes(manifest.schema) && await sha(raw) === manifest.sha256 && data.format === 'weekly-progress-recovery' && data.schema === manifest.schema,'Recovery integrity check failed.');
    W.assert(data.photos.length === manifest.photos && data.pending.length === manifest.pending,'Recovery photo count mismatch.');
    let evidence=archive;
    if(data.schema === 2 && (data.photos.length || data.pending.length)){
      if(!companionFile){const error=new Error('This data backup needs its companion photo ZIP for full restoration. Select both files together.');error.code='PHOTO_COMPANION_REQUIRED';throw error;}
      evidence=await loadZip(companionFile);
      const pair=await jsonEntry(archive,'pair-manifest.json',50000),other=await jsonEntry(evidence,'pair-manifest.json',50000),filesRaw=await readEntry(evidence,'recovery-files.json',10*1024*1024),files=JSON.parse(decoder.decode(filesRaw));
      W.assert(W.stable(pair) === W.stable(other) && pair.format === 'weekly-progress-pair' && pair.schema === 1 && pair.id === data.pairId && pair.recoverySha256 === manifest.sha256 && pair.filesSha256 === await sha(filesRaw),'These backup files do not belong to the same recovery snapshot.');
      W.assert(files.format === 'weekly-progress-recovery-files' && files.pairId === data.pairId && files.recoverySha256 === manifest.sha256 && W.stable(files.photos) === W.stable(data.photos) && W.stable(files.pending) === W.stable(data.pending),'Companion recovery file manifest differs from the data backup.');
      W.assert(await sha(await readEntry(evidence,'photo-manifest.json',10*1024*1024)) === pair.evidenceSha256,'Companion evidence manifest integrity check failed.');
    }
    const model=W.unpack(data.package), photos=[],pending=[],paths=new Set(),ids=new Set();
    for(const [metadata,destination] of [...data.photos.map(photo=>[photo,photos]),...data.pending.map(photo=>[photo,pending])]) {
      W.assert(!ids.has(metadata.id) && !paths.has(metadata.path),'Duplicate recovery photo.');ids.add(metadata.id);paths.add(metadata.path);
      const rawPhoto=await readEntry(evidence,metadata.path,25*1024*1024);
      W.assert(await sha(rawPhoto) === metadata.sha256 && rawPhoto.length === metadata.size,'Recovery photo integrity check failed.');
      destination.push({...metadata,blob:new Blob([rawPhoto],{type:metadata.type || 'image/jpeg'}),crc32:crc32(rawPhoto)});
    }
    W.validateSession(data.session,model,new Set(photos.map(photo=>photo.id)));
    return {session:data.session,model,photos,pending};
  }
  async function readRecoveryPair(files){
    W.assert(files.length>0 && files.length<=2,'Choose the data ZIP and its companion photo ZIP, or one legacy full backup.');
    if(files.length === 1)return readRecovery(files[0]);
    const first=await loadZip(files[0]);return first.file('recovery.json')?readRecovery(files[0],files[1]):readRecovery(files[1],files[0]);
  }
  async function dailyZip(session,model,records,photos,pending=[]) {
    const rows=[];
    for(const record of records) rows.push(await payloadFor(session,model,record,photos));
    W.assert(rows.length,'There are no unexported records for this day.');
    const log={id:W.uid('EX-'),kind:'daily',date:records[0].date,createdAt:new Date().toISOString(),status:'prepared',
      records:rows.map(({payload,hash})=>({id:payload.record.id,revision:payload.record.revision,fingerprint:W.fingerprint(payload.record),hash,payload}))};
    const future=W.copy(session);future.exports.push(log);
    return archiveDaily(future,model,log,photos,pending);
  }
  async function archiveDaily(future,model,log,photos,pending=[]) {
    const rows=log.records.map(row=>({payload:row.payload,hash:row.hash}));
    for(const row of rows) {
      await validatePayload(row.payload,row.hash);
      for(const metadata of row.payload.photos){const photo=photos.find(value=>value.id === metadata.id);W.assert(photo && photo.size === metadata.size && await sha(photo.blob) === metadata.sha256,'The original export photo bytes are missing or changed. Restore a recovery backup.');}
    }
    const csvText=csv(rows), dayPhotos=[...new Map(rows.flatMap(row=>row.payload.photos).map(photo=>[photo.id,photo])).values()];
    // Recovery covers the whole week, including deleted/history evidence and unfinished originals.
    log.pairId ||= log.id;
    const recovery=await recoveryData(future,model,photos,pending,{pairId:log.pairId,createdAt:log.createdAt});
    const evidence=W.stable({format:'weekly-progress-photos',schema:1,photos:dayPhotos}),files=W.stable({format:'weekly-progress-recovery-files',schema:1,pairId:log.pairId,recoverySha256:recovery.hash,photos:recovery.data.photos,pending:recovery.data.pending});
    const pair={format:'weekly-progress-pair',schema:1,id:log.pairId,exportId:log.id,date:log.date,recoverySha256:recovery.hash,filesSha256:await sha(files),evidenceSha256:await sha(evidence),csvSha256:await sha(csvText),photoCount:photos.length,pendingCount:pending.length},pairEntry={name:'pair-manifest.json',data:W.stable(pair),compress:true};
    const entries=[...recovery.entries,{name:'daily.csv',data:csvText,compress:true},
      {name:'export-manifest.json',data:W.stable({format:'weekly-progress-export',schema:1,id:log.id,date:log.date,csvSha256:await sha(csvText),records:rows.map(row=>({id:row.payload.record.id,hash:row.hash}))}),compress:true},
      pairEntry];
    const photoEntries=[pairEntry,{name:'recovery-files.json',data:files,compress:true},{name:'photo-manifest.json',data:evidence,compress:true},
      ...photos.map(photo=>({name:W.photoPath(photo),data:photo.blob,crc:photo.crc32})),...pending.map(photo=>({name:'pending/'+photo.id+'.image',data:photo.blob,crc:photo.crc32}))];
    return {blob:await zip(entries),photoBlob:photos.length || pending.length?await zip(photoEntries):null,pair,log,csv:csvText,future};
  }
  async function repeatDailyZip(session,model,id,photos,pending=[]) {
    const future=W.copy(session),log=future.exports.find(entry=>entry.id === id && entry.kind === 'daily');
    W.assert(log?.records?.length,'This export is not available in the saved history.');
    log.status='prepared';
    const result=await archiveDaily(future,model,log,photos,pending);
    result.future=W.copy(session);return result;
  }
  async function readDaily(file) {
    if(/\.csv$/i.test(file.name || '') || file.type?.startsWith('text/csv')) return parseCsv(await file.text());
    const archive=await loadZip(file), raw=await readEntry(archive,'daily.csv',30*1024*1024), manifest=await jsonEntry(archive,'export-manifest.json',2*1024*1024);
    W.assert(manifest.format === 'weekly-progress-export' && manifest.schema === 1 && await sha(raw) === manifest.csvSha256,'Daily export integrity check failed.');
    const rows=await parseCsv(decoder.decode(raw));
    W.assert(W.stable(manifest.records) === W.stable(rows.map(row=>({id:row.payload.record.id,hash:row.hash}))),'Daily export record manifest mismatch.');
    return rows;
  }
  async function photoZip(photos) {
    W.assert(photos.length,'No photos for the selected date.');
    return zip([{name:'photo-manifest.json',data:W.stable({format:'weekly-progress-photos',schema:1,photos:photos.map(photoMetadata)}),compress:true},
      ...photos.map(photo=>({name:W.photoPath(photo),data:photo.blob,crc:photo.crc32}))]);
  }
  async function readPhotos(file) {
    const archive=await loadZip(file), manifest=await jsonEntry(archive,'photo-manifest.json',10*1024*1024);
    W.assert(manifest.format === 'weekly-progress-photos' && manifest.schema === 1 && Array.isArray(manifest.photos) && manifest.photos.length <= 10000,'Unsupported photo manifest.');
    const ids=new Set(),paths=new Set(),files=[];
    for(const meta of manifest.photos) {
      W.assert(!ids.has(meta.id) && !paths.has(meta.path) && meta.path === W.photoPath(meta),'Invalid or duplicate PhotoID/path.');
      ids.add(meta.id);paths.add(meta.path);
      const raw=await readEntry(archive,meta.path,25*1024*1024);
      W.assert(raw.length === meta.size && await sha(raw) === meta.sha256,'Photo integrity check failed: '+meta.path);
      files.push({...meta,blob:new Blob([raw],{type:meta.type || 'image/jpeg'})});
    }
    return files;
  }
  const api={bytes,sha,crc32,safePath,zip,loadZip,readEntry,jsonEntry,weeklyZip,readWeekly,HEADERS,FIELD_IDS,csvObject,csv,parseCsv,
    photoMetadata,payloadFor,validatePayload,recoveryData,readRecovery,readRecoveryPair,dailyZip,repeatDailyZip,readDaily,photoZip,readPhotos};
  if(typeof module === 'object' && module.exports) module.exports=api; else root.WeeklyFiles=api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
