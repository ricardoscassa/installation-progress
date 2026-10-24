/* Installation Progress: weekly and daily application rules. */
(function (root) {
  'use strict';
  const R = typeof module === 'object' && module.exports ? require('./production-core.js') : root.ProductionCore;
  const copy = R.copy, text = R.text;
  const VERSION = '1.6.2';
  const {WORK_GROUPS,workGroup,rowGroup} = R;
  const uid = (prefix = '') => prefix + (root.crypto?.randomUUID ? root.crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  function stable(value) {
    if (value === undefined) return 'null';
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
    return JSON.stringify(value);
  }
  function assert(condition, message) { if (!condition) throw new Error(message); }
  function date(value) {
    assert(/^\d{4}-\d{2}-\d{2}$/.test(value || '') && new Date(value + 'T12:00:00Z').toISOString().slice(0,10) === value, 'Invalid work date.');
    return value;
  }
  function config() { return { ...R.defaultConfig(), inspectionRequired:false, photoRequired:false }; }
  const groupLabel=id=>WORK_GROUPS.find(group=>group.id === id)?.label || 'Work group not specified';
  function recorder(value={},required=false){
    const result={name:text(value.name),email:text(value.email)};
    assert(result.name.length<=255 && result.email.length<=255 && (!required || result.name.length>=2),'Enter the person recording this week (2–255 characters).');
    assert(!result.email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.email),'Enter a valid recorder email or leave it blank.');return result;
  }
  function groupScopes(model){
    const scopes=new Map();
    if(model.selection){
      for(const selected of R.validateSelection(model.selection).scopes)for(const groupId of selected.groups){
        const workflows=R.gates.pairs.filter(pair=>workGroup(pair) === groupId).map(pair=>({commodity:R.canonical(pair.commodity),structure:pair.structure}));
        scopes.set(R.key(selected.building,groupId),{building:selected.building,groupId,workflows:[...new Map(workflows.map(row=>[stable(row),row])).values()]});
      }
      return [...scopes.values()];
    }
    model.items.filter(item=>item.origin === 'Weekly Plan').forEach(item=>{
      const groupId=workGroup(item);if(!groupId)return;const key=R.key(item.building,groupId);
      if(!scopes.has(key))scopes.set(key,{building:item.building,groupId,workflows:[]});
      const rows=scopes.get(key).workflows,workflow={commodity:R.canonical(item.commodity),structure:item.structure};
      if(!rows.some(row=>stable(row) === stable(workflow)))rows.push(workflow);
    });
    return [...scopes.values()].map(scope=>({...scope,workflows:scope.workflows.sort((a,b)=>stable(a).localeCompare(stable(b)))}));
  }
  const scopeDisciplines=scope=>[...new Set(scope.workflows.map(row=>R.workflow(row).family))].sort();
  function table(rows) { return rows.map(row => row.map(v => '"' + text(v).replace(/"/g,'""') + '"').join('\t')).join('\n'); }
  const gate=value=>/^(?:null|<null>)$/i.test(text(value))?'':text(value);
  function reportedPercent(row={}) {
    const value=row.ReportedPercent;
    // Reference numbers can default to zero before a report exists.
    return value !== null && value !== undefined && text(value) !== '' && (Number(value) !== 0 || gate(row.ReportedGateStatus))?value:null;
  }
  function prepareRows(weekly, references, options = {}) {
    assert(Array.isArray(weekly) && weekly.length && weekly.length <= 10000, 'Choose weekly planned work first (maximum 10,000 rows).');
    assert(Array.isArray(references) && references.length <= 50000, 'The reference extract exceeds 50,000 rows.');
    const refs = new Map();
    references.forEach(row => {
      const key = R.key(row.Building,row.ECSCode);
      if (!refs.has(key)) refs.set(key,[]);
      refs.get(key).push(row);
    });
    // Mpower is a comparison claim, never a field-reporting baseline.
    const effective = row => ({gate:reportedPercent(row) !== null?gate(row?.ReportedGateStatus):'',percent:reportedPercent(row) ?? 0});
    const headings = ['Week','Building','Room','Commodity','ECS-code','GateStatusStructure','GateStatus','PercentComplete','SourceUpdatedAt','Description'];
    const baselines = new Map();
    const weeklyRows = weekly.map(row => {
      const candidates = refs.get(R.key(row.Building,row.ECSCode)) || [];
      const ref = candidates.find(r => R.norm(r.Room) === R.norm(row.Room) && R.canonical(r.Commodity) === R.canonical(row.Commodity)) || {};
      const reported=reportedPercent(ref),current=reported !== null?{gate:gate(ref.ReportedGateStatus),percent:reported}:
        {gate:gate(row.LatestGateStatus),percent:row.LatestPercent ?? 0};
      baselines.set(R.key(row.Building,row.ECSCode),{...current,room:row.Room,commodity:R.canonical(row.Commodity)});
      return [row.WeekKey,row.Building,row.Room,row.Commodity,row.ECSCode,row.GateStatusStructure || ref.GateStatusStructure,
        current.gate,current.percent ?? row.LatestPercent,ref.SourceUpdatedAt || row.LastReportedDate,ref.Description || row.Description];
    });
    const ecsRows = references.map(row => {
      const baseline=baselines.get(R.key(row.Building,row.ECSCode));
      const current = baseline && R.norm(baseline.room) === R.norm(row.Room) && baseline.commodity === R.canonical(row.Commodity)?baseline:effective(row);
      return ['',row.Building,row.Room,row.Commodity,row.ECSCode,row.GateStatusStructure,current.gate,current.percent,row.SourceUpdatedAt,row.Description];
    });
    const model = R.prepare(table([headings,...weeklyRows]),table([headings,...ecsRows]),{...options,config:config()});
    const weeks = [...new Set(weekly.map(row => text(row.WeekKey)))];
    assert(weeks.length === 1,'Prepare exactly one reporting week.');
    model.sourceWeekKey = weeks[0];
    model.version = VERSION;
    if(options.recorder)model.recorder=recorder(options.recorder,true);
    if(options.workGroupVersion){assert(options.workGroupVersion === 1,'Unsupported reporting work groups.');model.workGroupVersion=1;}
    model.items.forEach(item => {
      const plan = weekly.find(row => R.key(row.Building,row.ECSCode) === item.referenceKey);
      const sources = (refs.get(item.referenceKey) || []).filter(row => R.norm(row.Room) === R.norm(item.room));
      const ref = sources.find(row => R.canonical(row.Commodity) === item.canonicalCommodity) || {};
      item.mpowerPercent = R.number(ref.PercentComplete);
      if (!Number.isFinite(item.mpowerPercent)) item.mpowerPercent = null;
      item.mpowerGate = gate(ref.GateStatus);
      item.weeklyItemId = plan?.ID ?? plan?.Id ?? null;
      item.ecsItemId = ref.ID ?? ref.Id ?? null;
      item.rawPlan = plan ? copy(plan) : null;
      item.rawReference = copy(ref);
      if(sources.some(source=>source.GateStatusStructure !== ref.GateStatusStructure || source.ReportedPercent !== ref.ReportedPercent || source.ReportedGateStatus !== ref.ReportedGateStatus || source.PercentComplete !== ref.PercentComplete || source.GateStatus !== ref.GateStatus))item.metadataIssues.push('Conflicting reference rows need review');
      item.fields = {}; item.touched = false; item.revision = 0;
    });
    if(model.workGroupVersion)assert(model.items.every(item=>item.origin === 'Weekly Plan'?rowGroup(item):workGroup(item)),'This package contains work outside its reporting groups.');
    return R.validateModel(model);
  }
  const COLUMNS = ['building','room','ecsCode','commodity','structure','sourceGate','sourcePercent','sourceUpdatedAt','description','origin','metadataIssues','mpowerPercent','mpowerGate','weeklyItemId','ecsItemId','rawPlan','rawReference','roomAssignment'];
  function pack(model) {
    const clean = R.validateModel(model);
    return {format:'weekly-progress-package',schema:clean.selection?3:clean.workGroupVersion?2:1,version:VERSION,id:clean.sessionId,week:clean.reportingWeek,
      sourceWeekKey:clean.sourceWeekKey || clean.reportingWeek,createdAt:clean.preparedAt,ruleVersion:R.gates.version,
      ...(clean.recorder?{recorder:recorder(clean.recorder,true)}:{}),...(clean.workGroupVersion?{workGroupVersion:clean.workGroupVersion}:{}),
      ...(clean.selection?{selection:R.validateSelection(clean.selection)}:{}),
      config:clean.config,stats:clean.stats,columns:COLUMNS,rows:clean.items.map(item => COLUMNS.map(name => item[name] ?? null))};
  }
  function unpack(data) {
    assert(data?.format === 'weekly-progress-package' && [1,2,3].includes(data.schema),'Unsupported weekly package.');
    assert(data.schema >= 2?data.workGroupVersion === 1:!data.workGroupVersion,'Weekly package metadata/schema do not match.');
    assert(data.schema === 3?!!data.selection:!data.selection,'Weekly package selection/schema do not match.');
    assert(data.ruleVersion === R.gates.version,'This package uses different gate rules. Update the app before loading it.');
    assert(Array.isArray(data.rows) && data.rows.length <= 50000 && data.rows.length > 0,'Invalid package row count.');
    assert(stable(data.columns) === stable(COLUMNS),'Unsupported package columns.');
    const week = R.normaliseWeek(data.week);
    assert(R.normaliseWeek(data.sourceWeekKey || week) === week,'Package WeekKey does not match its reporting week.');
    const model = {schema:1,version:VERSION,sessionId:text(data.id),reportingWeek:week,sourceWeekKey:data.sourceWeekKey || week,
      preparedAt:data.createdAt,ruleVersion:data.ruleVersion,config:R.validateConfig(data.config),scopes:[],plannedKeys:[],items:[],stats:data.stats || {},exports:[]};
    if(data.selection)model.selection=R.validateSelection(data.selection);
    if(data.recorder)model.recorder=recorder(data.recorder,true);
    if(data.workGroupVersion){assert(data.workGroupVersion === 1,'Unsupported reporting work groups. Update the app.');model.workGroupVersion=1;}
    assert(model.config.inspectionRequired === false && model.config.photoRequired === false,'This package is not a daily-progress configuration.');
    data.rows.forEach(values => {
      assert(Array.isArray(values) && values.length === COLUMNS.length,'Invalid package table row.');
      const item = Object.fromEntries(COLUMNS.map((name,index)=>[name,values[index]]));
      for (const name of ['building','room','ecsCode','commodity','structure','sourceGate','sourceUpdatedAt','description']) {
        assert(typeof item[name] === 'string' && item[name].length <= 4000,'Invalid ECS text value.');
      }
      assert(item.sourcePercent === null || (Number.isFinite(item.sourcePercent) && item.sourcePercent >= 0 && item.sourcePercent <= 100),'Invalid source percentage.');
      item.id = R.key(item.building,item.room,item.ecsCode); item.referenceKey = R.referenceKey(item);
      item.roomLabel = item.building + ' · ' + item.room; item.codeId = item.roomLabel + '-' + item.ecsCode;
      item.canonicalCommodity = R.canonical(item.commodity); item.reportingWeek = week; item.planWeek = item.origin === 'Weekly Plan' ? week : '';
      item.fields = {}; item.manual = false; item.touched = false; item.revision = 0; item.sourceRows = [];
      assert(Array.isArray(item.metadataIssues),'Invalid reference validation metadata.');
      model.items.push(item);
      if(model.workGroupVersion)assert(item.origin === 'Weekly Plan'?rowGroup(item):workGroup(item),'This package contains work outside its reporting groups.');
      if (item.origin === 'Weekly Plan') model.plannedKeys.push(item.referenceKey);
      if (model.workGroupVersion || item.origin === 'Weekly Plan') model.scopes.push(R.scopeKey(item.building,item.room,item.commodity));
    });
    model.scopes = [...new Set(model.scopes)];
    return R.validateModel(model);
  }
  function createSession(model, operator = model.recorder || {}, now = new Date().toISOString()) {
    assert(text(operator.name),'Enter the person recording this week.');
    return {schema:'weekly-progress-session/1',id:uid('WP-'),packageId:model.sessionId,weekKey:model.sourceWeekKey || model.reportingWeek,
      operator:{name:text(operator.name),email:text(operator.email)},createdAt:now,updatedAt:now,storageVersion:0,journalGeneration:0,
      addedIds:[],records:[],checkins:[],editors:{},approvals:[],exports:[],batches:{},deletedEntries:[],
      ui:{screen:'home',room:model.items[0].roomLabel,expanded:'',editDate:'',scroll:0},pendingCapture:null};
  }
  const editorKey = (day,itemId) => R.key(day,itemId);
  const recordFor = (session,day,itemId) => session.records.find(record => record.date === day && record.itemId === itemId);
  const hasFields = fields => Object.entries(fields || {}).some(([key,value])=>key === 'noProgress' ? value === true : R.meaningful(value));
  const essence = record => ({id:record.id,itemId:record.itemId,batchId:record.batchId,date:record.date,weekKey:record.weekKey,
    fields:record.fields,previous:record.previous,photos:record.photos,operator:record.operator,ruleVersion:record.ruleVersion,config:record.config});
  const isCheckin=record=>['building-no-progress','work-group-no-progress'].includes(record?.kind);
  const fingerprint = record => stable(isCheckin(record)?{id:record.id,kind:record.kind,batchId:record.batchId,date:record.date,building:record.building,weekKey:record.weekKey,supervisorName:record.supervisorName,operator:record.operator,commodities:record.commodities,
    ...(record.kind === 'work-group-no-progress'?{groupId:record.groupId,supervisorKey:record.supervisorKey,workflows:record.workflows,ruleVersion:record.ruleVersion}:{})}:essence(record));
  function noProgressBatchId(session,building,day,groupId='',supervisorKey='',generation=''){
    const parts=[session.weekKey,building,(session.operator.email || session.operator.name).trim().toLowerCase()];if(groupId)parts.push(groupId,supervisorKey);if(generation)parts.push(generation);
    const key=stable(parts);let a=2166136261,b=2246822519;
    for(const char of key){a=Math.imul(a^char.charCodeAt(0),16777619);b=Math.imul(b^char.charCodeAt(0),3266489917);}
    return 'DL-NP-'+date(day).replace(/-/g,'')+'-'+[a,b].map(value=>(value>>>0).toString(16).padStart(8,'0')).join('');
  }
  function newBatchId(now=new Date().toISOString()){
    const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(now));
    const value=name=>parts.find(part=>part.type === name).value;
    const random=root.crypto?.getRandomValues?root.crypto.getRandomValues(new Uint32Array(1))[0]:Math.floor(Math.random()*0x100000000);
    return 'DL-'+value('year')+value('month')+value('day')+'-'+value('hour')+value('minute')+value('second')+'-'+random.toString(16).padStart(8,'0');
  }
  function freshBatchId(session,now){
    const used=new Set([...Object.values(session.batches || {}),...(session.records || []).map(record=>record.batchId),...(session.checkins || []).map(record=>record.batchId)]);
    for(let attempt=0;attempt<8;attempt++){const id=newBatchId(now);if(!used.has(id))return id;}
    throw new Error('A unique daily batch could not be created. Try saving again.');
  }
  function validateCheckin(record){
    assert(isCheckin(record) && text(record.id) && /^(?:DL-NP-[0-9]{8}-[0-9a-f]{16}|DL-[0-9]{8}-[0-9]{6}-[0-9a-f]{8})$/.test(record.batchId || ''),'Invalid building check-in identity.');
    assert(record.itemId === undefined && record.fields === undefined && record.photos === undefined,'A building check-in must not contain ECS progress or photo associations.');
    date(record.date);assert(text(record.building) && text(record.building).length<=255 && text(record.weekKey),'Invalid building check-in scope.');
    assert(text(record.supervisorName).length>=2 && text(record.supervisorName).length<=255 && text(record.operator?.name),'Record the supervisor and person reporting.');
    assert(Number.isInteger(record.revision) && record.revision>0 && Number.isFinite(Date.parse(record.recordedAt)) && Array.isArray(record.commodities) && record.commodities.every(value=>typeof value === 'string'),'Invalid building check-in details.');
    if(record.kind === 'work-group-no-progress'){
      assert(WORK_GROUPS.some(group=>group.id === record.groupId) && text(record.supervisorKey) && record.ruleVersion === R.gates.version,'Invalid work-group check-in.');
      assert(Array.isArray(record.workflows) && record.workflows.length>0 && record.workflows.length<=100 && record.workflows.every(row=>workGroup(row) === record.groupId),'Invalid work-group workflow scope.');
      assert(stable(record.commodities) === stable([...new Set(record.workflows.map(row=>R.canonical(row.commodity)))].sort()),'Work-group commodities do not match.');
    }
    if(record.batchId.startsWith('DL-NP-'))assert(record.batchId === noProgressBatchId({weekKey:record.weekKey,operator:record.operator},record.building,record.date,record.groupId,record.supervisorKey,record.batchGeneration || ''),'Building check-in batch scope does not match.');return record;
  }
  const personKey=value=>text(value).replace(/\s+/g,' ').toLowerCase();
  function workConflicts(session,model,building,groupId,day){
    const matches=id=>{const item=model.items.find(item=>item.id === id);return item?.building === building && workGroup(item) === groupId;};
    return session.records.some(record=>record.date === day && matches(record.itemId)) || Object.values(session.editors).some(editor=>editor.date === day && matches(editor.itemId) && editorDirty(session,editor) && (hasFields(editor.fields) || editor.photos.length));
  }
  function saveWorkCheckin(session,model,{building,groupId,supervisorName,id=''},day,now=new Date().toISOString()){
    const scope=groupScopes(model).find(scope=>scope.building === building && scope.groupId === groupId);assert(scope,'Choose a loaded building and work group.');
    const name=text(supervisorName),same=record=>record.kind === 'work-group-no-progress' && record.building === building && record.groupId === groupId && record.date === day;
    const previous=id?(session.checkins || []).find(record=>record.id === id):(session.checkins || []).find(record=>same(record) && personKey(record.supervisorName) === personKey(name));
    if(id)assert(previous && same(previous),'This check-in belongs to a different scope.');
    assert(!(session.checkins || []).some(record=>same(record) && record.id !== previous?.id && personKey(record.supervisorName) === personKey(name)),'This supervisor already has a check-in for this scope.');
    if(previous?.supervisorName === name)return previous;
    const record={kind:'work-group-no-progress',id:previous?.id || uid('WC-'),revision:(previous?.revision || 0)+1,groupId,supervisorKey:previous?.supervisorKey || personKey(name),building,date:date(day),weekKey:session.weekKey,
      supervisorName:name,operator:copy(previous?.operator || session.operator),recordedAt:now,workflows:copy(scope.workflows),commodities:[...new Set(scope.workflows.map(row=>row.commodity))].sort(),ruleVersion:R.gates.version,
      history:previous?[...copy(previous.history || []),{name:previous.supervisorName,recordedAt:previous.recordedAt,revision:previous.revision}]:[]};
    record.batchGeneration=previous && batchSealed(session,previous.batchId)?uid('G-'):previous?.batchGeneration || '';
    record.batchId=previous && !batchSealed(session,previous.batchId)?previous.batchId:freshBatchId(session,now);validateCheckin(record);
    session.checkins=(session.checkins || []).filter(value=>value.id !== record.id).concat(record);return record;
  }
  function saveBuildingCheckin(session,model,building,name,day,now=new Date().toISOString()){
    assert(model.items.some(item=>item.origin === 'Weekly Plan' && item.building === building),'Choose a loaded building.');
    const previous=(session.checkins || []).find(record=>record.date === day && record.building === building);
    if(previous?.supervisorName === text(name))return previous;
    const record={kind:'building-no-progress',id:previous?.id || uid('BC-'),revision:(previous?.revision || 0)+1,batchId:noProgressBatchId(session,building,day),date:date(day),weekKey:session.weekKey,building,
      supervisorName:text(name),previousSupervisorName:previous?.supervisorName || '',operator:copy(session.operator),recordedAt:now,
      commodities:[...new Set(model.items.filter(item=>item.building === building && item.origin === 'Weekly Plan').map(item=>item.commodity))].sort(),history:previous?[...copy(previous.history || []),{name:previous.supervisorName,recordedAt:previous.recordedAt,revision:previous.revision}]:[]};
    record.batchGeneration=previous && batchSealed(session,previous.batchId)?uid('G-'):previous?.batchGeneration || '';
    record.batchId=previous && !batchSealed(session,previous.batchId)?previous.batchId:freshBatchId(session,now);
    validateCheckin(record);session.checkins=(session.checkins || []).filter(value=>value.id !== record.id).concat(record);return record;
  }
  const pendingCheckins=(session,day)=>(session.checkins || []).filter(record=>record.date === day && !exported(session,record));
  function roomChanged(session,model,room,day){
    const ids=new Set(model.items.filter(item=>item.roomLabel === room).map(item=>item.id));
    return session.records.some(record=>record.date === day && ids.has(record.itemId)) || Object.values(session.editors).some(editor=>editor.date === day && ids.has(editor.itemId) && editorDirty(session,editor) && (hasFields(editor.fields) || editor.photos.length>0));
  }
  function validateProgress(item, fields, cfg, previous) {
    const value = R.validateItem({...item,sourcePercent:previous?.percent ?? item.sourcePercent,fields},cfg,{inspectionComplete:true,photoCount:1});
    const errors = [...value.progressErrors];
    if (!value.hasProgress) errors.push('Record progress or select No Progress.');
    if (!fields.noProgress && Number.isFinite(value.reportedPercent) && value.reportedPercent > 90) errors.push('Field progress is limited to 90%.');
    if (!fields.noProgress && previous?.percent > 90) errors.push('The imported position is above 90%; keep it unchanged and record No Progress with a reason.');
    return {...value,errors:[...new Set(errors)],ready:errors.length === 0};
  }
  function previousFor(session,model,item,day,batchId='',fields=null) {
    if(batchId){
      const exported=session.exports.filter(entry=>entry.kind === 'daily').flatMap(entry=>entry.records || []).map(row=>row.payload?.record).filter(record=>record?.itemId === item.id && record.date === day);
      const first=exported.findIndex(record=>record.batchId === batchId),earlier=first<0?exported:exported.slice(0,first);
      const prior=[...earlier].reverse().find(record=>record.batchId !== batchId && !record.fields.noProgress);
      if(prior){
        const v=validateProgress(item,prior.fields,prior.config,prior.previous);
        const proposed=fields || session.records.find(record=>record.itemId === item.id && record.date === day && record.batchId === batchId)?.fields;
        const rule=R.workflow(item).rules.find(rule=>rule.code === proposed?.gate),percent=rule?.policy === 'Fixed'?rule.percent:R.number(proposed?.percent);
        // A correction replaces this day's local observation; it is not new progress from a mistaken export.
        if(v.ready && !proposed?.noProgress && Number.isFinite(percent) && percent < v.reportedPercent)return copy(earlier.find(record=>!record.fields.noProgress)?.previous || prior.previous);
        if(v.ready)return {percent:v.reportedPercent,gate:prior.fields.gate,recordId:prior.id,revision:prior.revision};
      }
    }
    const records = session.records.filter(record=>record.itemId === item.id && record.date < day).sort((a,b)=>b.date.localeCompare(a.date));
    for (const record of records) {
      const v = validateProgress(item,record.fields,record.config,record.previous);
      if (v.ready && !record.fields.noProgress) return {percent:v.reportedPercent,gate:record.fields.gate,recordId:record.id,revision:record.revision};
    }
    return {percent:item.sourcePercent,gate:item.sourceGate,recordId:'',revision:0};
  }
  function editorFor(session,model,item,day) {
    date(day);
    const key = editorKey(day,item.id), existing = session.editors[key];
    if (existing) return copy(existing);
    const record = recordFor(session,day,item.id);
    return {itemId:item.id,date:day,fields:copy(record?.fields || {}),photos:copy(record?.photos || []),
      previous:copy(record?.previous || previousFor(session,model,item,day)),updatedAt:record?.savedAt || '',baseRevision:record?.revision || 0};
  }
  function editorDirty(session,editor) {
    const record = recordFor(session,editor.date,editor.itemId);
    return stable({fields:editor.fields,photos:editor.photos,previous:editor.previous}) !== stable({fields:record?.fields || {},photos:record?.photos || [],previous:record?.previous || editor.previous});
  }
  function setEditor(session,editor,now = new Date().toISOString()) {
    assert(editor && date(editor.date) && editor.itemId,'Invalid editor context.');
    editor.updatedAt = now; session.editors[editorKey(editor.date,editor.itemId)] = copy(editor);
    session.updatedAt = now;
  }
  function photoRemoval(session,model,photo){
    const item=model.items.find(item=>item.id === photo.itemId),day=photo.workDate;
    if(!item || item.building !== photo.building || item.room !== photo.room || item.ecsCode !== photo.ecsCode)return {allowed:false,reason:'The photo does not match this ECS.'};
    const record=recordFor(session,day,item.id),editor=session.editors[editorKey(day,item.id)];
    if(!record?.photos.includes(photo.id) && !editor?.photos.includes(photo.id))return {allowed:false,reason:'This photo is kept in history or recovery.'};
    if(session.pendingCapture?.itemId === item.id && (session.pendingCapture.workDate || session.pendingCapture.editor?.date) === day)return {allowed:false,reason:'Finish the interrupted photo before removing evidence from this entry.'};
    return {allowed:true,item,record,editor};
  }
  function removePhoto(session,model,photo,now=new Date().toISOString()){
    const check=photoRemoval(session,model,photo);assert(check.allowed,check.reason);
    const {item,record}=check,key=editorKey(photo.workDate,item.id),editor=check.editor?copy(check.editor):null;
    if(record?.photos.includes(photo.id)){
      // Revise saved evidence without committing any other unfinished answers.
      const changed={...editorFor(session,model,item,photo.workDate),fields:copy(record.fields),previous:copy(record.previous),photos:record.photos.filter(id=>id !== photo.id)};
      const saved=saveEditor(session,model,item,changed,now);
      if(editor){editor.baseRevision=saved.revision;if(stable(editor.previous) === stable(record.previous))editor.previous=copy(saved.previous);}
    }
    if(editor){
      editor.photos=editor.photos.filter(id=>id !== photo.id);
      if(editorDirty(session,editor) && (record || hasFields(editor.fields) || editor.photos.length))setEditor(session,editor,now);else delete session.editors[key];
    }
    // Bytes remain available to earlier signed/exported snapshots and recovery.
    session.removedPhotoIds=[...new Set([...(session.removedPhotoIds || []),photo.id])];
    session.updatedAt=now;
  }
  function capturedPhotoItem(model,pending){
    const item=model.items.find(value=>value.id === pending.itemId),context=pending.context;
    return item && pending.building === item.building && pending.room === item.room && pending.ecsCode === item.ecsCode && context?.itemId === item.id && context.building === item.building && context.room === item.room && context.ecsCode === item.ecsCode && context.workDate === pending.workDate && context.editor?.itemId === item.id && context.editor.date === pending.workDate?item:null;
  }
  function sharedPhotoChoice(session,model,pending,itemId) {
    const primary=capturedPhotoItem(model,pending),item=model.items.find(item=>item.id === itemId);
    const rejected=reason=>({allowed:false,reason,item});
    if(!primary || !item)return rejected('The captured ECS context is missing or changed.');
    if(item.building !== primary.building || item.room !== primary.room)return rejected('Only ECS in this building and room can share this photo.');
    if(item.origin !== 'Weekly Plan' && !session.addedIds.includes(item.id))return rejected('Add this ECS to the room before sharing a photo.');
    const source=R.workflow(primary),target=R.workflow(item),fields=pending.context.editor.fields;
    if(!source.valid || !target.valid || source.structure !== target.structure)return rejected('Different or unsupported gate-status structure.');
    if(fields.noProgress || !text(fields.gate))return rejected('Select a progress gate in the ECS card before sharing.');
    const sourceValidation=validateProgress(primary,fields,{version:1,families:{},commodities:{}},pending.context.editor.previous);
    if(!sourceValidation.ready)return rejected(sourceValidation.errors.join(' '));
    const sourceRule=source.rules.find(rule=>rule.code === fields.gate),targetRule=target.rules.find(rule=>rule.code === fields.gate);
    const percent=sourceRule?.policy === 'Fixed'?sourceRule.percent:R.number(fields.percent);
    if(!sourceRule || !targetRule || sourceRule.policy !== targetRule.policy || sourceRule.policy === 'Fixed' && sourceRule.percent !== targetRule.percent)return rejected('This ECS does not use the captured gate and percentage.');
    if(!Number.isFinite(percent) || percent<0 || percent>90)return rejected('Shared field progress must be between 0% and 90%.');
    const editor=editorFor(session,model,item,pending.workDate),before=copy(editor);
    editor.fields={...editor.fields,gate:fields.gate,percent,noProgress:false};
    editor.previous=copy(previousForEdit(session,model,item,editor));
    // Only gate eligibility is shared. Required item-specific answers are still
    // checked by the normal draft/sign-off flow, without copying another ECS's values.
    const validation=validateProgress(item,editor.fields,{version:1,families:{},commodities:{}},editor.previous);
    if(!validation.ready)return rejected(validation.errors.join(' '));
    return {allowed:true,item,editor,before,gate:fields.gate,percent,changes:stable(before.fields)!==stable(editor.fields)};
  }
  function sharedPhotoPlan(session,model,pending,extraIds=[]) {
    date(pending.workDate);
    assert(Array.isArray(extraIds) && new Set(extraIds).size === extraIds.length && !extraIds.includes(pending.itemId),'Invalid repeated shared-photo selection.');
    const item=capturedPhotoItem(model,pending);
    assert(item,'The captured ECS context is missing or changed.');
    const primary={item,editor:editorFor(session,model,item,pending.workDate),context:copy(pending.context)};
    const others=extraIds.map(id=>{
      const choice=sharedPhotoChoice(session,model,pending,id);assert(choice.allowed,(choice.item?.ecsCode || id)+': '+choice.reason);
      return {item:choice.item,editor:choice.editor,context:{...copy(pending.context),itemId:id,building:choice.item.building,room:choice.item.room,ecsCode:choice.item.ecsCode,editor:copy(choice.editor)}};
    });
    return [primary,...others];
  }
  const batchSealed=(session,batchId)=>session.exports.some(entry=>entry.kind === 'daily' && entry.records?.some(row=>row.payload?.record?.batchId === batchId));
  function previousForEdit(session,model,item,editor){
    const record=recordFor(session,editor.date,item.id);
    return record?previousFor(session,model,item,editor.date,batchSealed(session,record.batchId)?'next-edit':record.batchId,editor.fields):editor.previous;
  }
  function batchFor(session,item,day,now=new Date().toISOString()) {
    const key = R.key(session.weekKey,day,item.building,session.operator.email || session.operator.name);
    if (!session.batches[key] || batchSealed(session,session.batches[key])) session.batches[key] = freshBatchId(session,now);
    return session.batches[key];
  }
  function saveEditor(session,model,item,editor,now = new Date().toISOString()) {
    assert(hasFields(editor.fields),'Select a gate, add daily-log values or record No Progress before saving.');
    const existing = recordFor(session,editor.date,item.id);
    if (existing && !editorDirty(session,editor)) { delete session.editors[editorKey(editor.date,item.id)]; return existing; }
    const revision = (existing?.revision || 0) + 1;
    const batchId=existing && !batchSealed(session,existing.batchId)?existing.batchId:batchFor(session,item,editor.date,now);
    const record = {id:existing?.id || uid('WR-'),revision,itemId:item.id,batchId,
      date:date(editor.date),weekKey:session.weekKey,fields:copy(editor.fields),previous:copy(existing?previousFor(session,model,item,editor.date,batchId,editor.fields):editor.previous),
      photos:copy(editor.photos),operator:copy(existing?.operator || session.operator),config:copy(session.config || model.config),ruleVersion:R.gates.version,
      createdAt:existing?.createdAt || now,savedAt:now,history:copy(existing?.history || [])};
    const resolved = R.workflow(item), rule = resolved.rules.find(rule=>rule.code === record.fields.gate);
    if (!record.fields.noProgress && rule?.policy === 'Fixed') record.fields.percent = rule.percent;
    if (existing) record.history.push({...copy(existing),history:undefined});
    session.records = session.records.filter(value=>value.id !== record.id).concat(record);
    delete session.editors[editorKey(editor.date,item.id)];
    session.updatedAt = now;
    return record;
  }
  function validateRecord(session,model,record) {
    const item = model.items.find(item=>item.id === record.itemId);
    if (!item) return {ready:false,errors:['Source ECS is missing from this package.']};
    const v = validateProgress(item,record.fields,record.config,record.previous);
    const currentPrevious = previousFor(session,model,item,record.date,record.batchId,record.fields);
    if (stable(currentPrevious) !== stable(record.previous)) v.errors.push('An earlier day changed. Reopen and review the previous progress before saving this record again.');
    const editor = session.editors[editorKey(record.date,record.itemId)];
    if (editor && editorDirty(session,editor)) v.errors.push('This record has unfinished edits. Save them before review or export.');
    v.ready = v.errors.length === 0;
    return v;
  }
  function approvalFor(session,record) {
    return [...session.approvals].reverse().find(approval=>!approval.invalidatedAt && approval.records.some(value=>value.id === record.id && value.revision === record.revision && value.fingerprint === fingerprint(record))) || null;
  }
  function exported(session,record) {
    return session.exports.some(entry=>entry.kind === 'daily' && entry.status === 'download-started' && entry.records.some(value=>value.id === record.id && value.revision === record.revision && value.fingerprint === fingerprint(record)));
  }
  function pending(session,day) { return session.records.filter(record=>record.date === day && !exported(session,record)); }
  function dailyExportState(session,model,day) {
    const records=[...pending(session,day),...pendingCheckins(session,day)],ids=new Set(records.filter(record=>!isCheckin(record)).map(record=>record.itemId));
    // Edits to a selected saved record are validated below. Other unfinished
    // entries stay in recovery and are never promoted into the signed CSV.
    const unfinished=Object.values(session.editors).filter(editor=>editor.date === day && editorDirty(session,editor) && !ids.has(editor.itemId));
    const errors=[...new Set(records.flatMap(record=>{
      if(!isCheckin(record))return validateRecord(session,model,record).errors;
      try{validateCheckin(record);return [];}catch(error){return [error.message];}
    }))];
    const approved=records.length>0 && records.every(record=>isCheckin(record) || approvalFor(session,record));
    return {records,unfinished,errors,approved,ready:approved && !errors.length};
  }
  function sign(session,model,records,name,now = new Date().toISOString()) {
    assert(text(name).length >= 2,'Enter the supervisor’s full name.');
    assert(records.length,'There are no records to review.');
    for (const record of records) assert(validateRecord(session,model,record).ready,'Resolve the draft requirements before signing.');
    const unreviewed=records.filter(record=>!approvalFor(session,record));
    if(!unreviewed.length)return approvalFor(session,records[0]);
    const approval = {id:uid('AP-'),name:text(name),signedAt:now,records:unreviewed.map(record=>({id:record.id,revision:record.revision,fingerprint:fingerprint(record),snapshot:copy(record)}))};
    session.approvals.push(approval); return approval;
  }
  function visibleItems(session,model,room) {
    return model.items.filter(item=>item.roomLabel === room && (item.origin === 'Weekly Plan' || session.addedIds.includes(item.id)));
  }
  function search(session,model,room,query,limit = 30) {
    const terms = text(query).toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return {items:[],total:0};
    const results = model.items.filter(item=>item.roomLabel === room && item.origin !== 'Weekly Plan' && !session.addedIds.includes(item.id) &&
      terms.every(term=>(item.ecsCode + ' ' + item.description + ' ' + item.commodity).toLowerCase().includes(term)));
    return {items:results.slice(0,Math.min(50,limit)),total:results.length};
  }
  function addCandidate(session,model,id,room) {
    const item = model.items.find(value=>value.id === id && value.roomLabel === room);
    assert(item && model.scopes.includes(R.scopeKey(item.building,item.room,item.commodity)),'Choose an ECS within this room’s weekly scope.');
    if (item.origin !== 'Weekly Plan' && !session.addedIds.includes(id)) session.addedIds.push(id);
    return item;
  }
  function candidateRemoval(session,model,id) {
    const item=model.items.find(value=>value.id === id);
    if(!item || item.origin === 'Weekly Plan')return {allowed:false,reason:'Weekly-plan ECS cannot be removed.'};
    if(!session.addedIds.includes(id))return {allowed:false,reason:'This ECS is not added to the room.'};
    if(session.records.some(record=>record.itemId === id) || session.exports.some(entry=>entry.records?.some(row=>row.payload?.record?.itemId === id)))return {allowed:false,reason:'Recorded ECS stay in the room to preserve daily history.'};
    if(session.pendingCapture?.itemId === id || Object.values(session.editors).some(editor=>editor.itemId === id && editor.photos.length))return {allowed:false,reason:'This ECS has photo evidence or a camera session. Keep it with its evidence.'};
    return {allowed:true,reason:''};
  }
  function removeCandidate(session,model,id) {
    const check=candidateRemoval(session,model,id);assert(check.allowed,check.reason);
    session.addedIds=session.addedIds.filter(value=>value !== id);
    Object.entries(session.editors).forEach(([key,editor])=>{if(editor.itemId === id)delete session.editors[key];});
    if(session.ui.expanded === id){session.ui.expanded='';session.ui.editDate='';}
  }
  function deleteEntry(session,model,{recordId='',itemId='',day=''},now=new Date().toISOString()) {
    const record=recordId?[...session.records,...(session.checkins || [])].find(value=>value.id === recordId):recordFor(session,day,itemId);
    assert(!recordId || record,'This entry is no longer in current work.');
    const checkin=isCheckin(record);day=record?.date || date(day);itemId=record?.itemId || itemId;
    const key=checkin?'':editorKey(day,itemId),editor=key?session.editors[key]:null;
    assert(record || editor && (hasFields(editor.fields) || editor.photos.length),'There is no daily entry to delete.');
    assert(checkin || model.items.some(item=>item.id === itemId),'The source ECS is missing.');
    assert(!session.pendingCapture || session.pendingCapture.itemId !== itemId || (session.pendingCapture.workDate || session.pendingCapture.editor?.date) !== day,'Finish the interrupted photo before deleting this entry.');
    const entry={id:uid('DEL-'),kind:checkin?'checkin':'ecs',date:day,itemId:checkin?'':itemId,deletedAt:now,record:record?copy(record):null,editor:editor?copy(editor):null};
    session.deletedEntries ||= [];session.deletedEntries.push(entry);
    if(record){
      session.records=session.records.filter(value=>value.id !== record.id);
      session.checkins=(session.checkins || []).filter(value=>value.id !== record.id);
      session.approvals.forEach(approval=>{if(!approval.invalidatedAt && approval.records.some(value=>value.id === record.id)){approval.invalidatedAt=now;approval.invalidationReason='A reviewed daily entry was deleted.';}});
      if(session.pendingCheckin?.id === record.id)delete session.pendingCheckin;
    }
    if(key)delete session.editors[key];
    if(session.ui.expanded === itemId){session.ui.expanded='';session.ui.editDate='';}
    session.updatedAt=now;return entry;
  }
  function restoreCheck(session,entry){
    if(!entry || entry.restoredAt)return {allowed:false,reason:'This deleted entry has already been restored.'};
    if(entry.kind === 'checkin'){
      const record=entry.record,conflict=(session.checkins || []).some(value=>value.date === record.date && value.building === record.building && (value.groupId || '') === (record.groupId || '') && (value.supervisorKey || '') === (record.supervisorKey || ''));
      return {allowed:!conflict,reason:conflict?'A current check-in already covers this person and scope. Keep it or delete it before restoring.':''};
    }
    const current=recordFor(session,entry.date,entry.itemId),editor=session.editors[editorKey(entry.date,entry.itemId)],capture=session.pendingCapture;
    const conflict=current || editor && (hasFields(editor.fields) || editor.photos.length) || capture?.itemId === entry.itemId && (capture.workDate || capture.editor?.date) === entry.date;
    return {allowed:!conflict,reason:conflict?'There is newer work for this ECS and day. Keep it or delete it before restoring.':''};
  }
  function restoreEntry(session,model,id,now=new Date().toISOString()){
    const entry=(session.deletedEntries || []).find(value=>value.id === id),check=restoreCheck(session,entry);assert(check.allowed,check.reason);
    let record=entry.record?copy(entry.record):null;
    if(record){
      record.revision+=1;record.history ||= [];
      if(isCheckin(record)){
        record.history.push({revision:entry.record.revision,name:entry.record.supervisorName,recordedAt:entry.record.recordedAt});record.recordedAt=now;
        if(batchSealed(session,record.batchId)){record.batchGeneration=uid('NP-');record.batchId=freshBatchId(session,now);}
        session.checkins.push(record);
      }else{
        record.history.push({...copy(entry.record),history:undefined});record.savedAt=now;
        if(batchSealed(session,record.batchId)){record.batchId=batchFor(session,model.items.find(item=>item.id === record.itemId),record.date,now);record.previous=previousFor(session,model,model.items.find(item=>item.id === record.itemId),record.date,record.batchId,record.fields);}
        session.records.push(record);
      }
    }
    if(entry.editor){const editor=copy(entry.editor);editor.baseRevision=record?.revision || 0;editor.updatedAt=now;if(record)editor.previous=copy(record.previous);session.editors[editorKey(entry.date,entry.itemId)]=editor;}
    if(entry.kind === 'ecs'){const item=model.items.find(value=>value.id === entry.itemId);if(item.origin !== 'Weekly Plan' && !session.addedIds.includes(item.id))session.addedIds.push(item.id);}
    entry.restoredAt=now;session.updatedAt=now;return record || entry.editor;
  }
  function hiddenPhotoIds(session){
    const deleted=new Set((session.deletedEntries || []).filter(entry=>!entry.restoredAt).flatMap(entry=>[...(entry.record?.photos || []),...(entry.editor?.photos || [])]));
    for(const record of [...session.records,...Object.values(session.editors),...session.exports.flatMap(entry=>(entry.records || []).map(row=>row.payload?.record).filter(Boolean))])for(const id of record.photos || [])deleted.delete(id);
    for(const id of session.removedPhotoIds || [])deleted.add(id);
    return deleted;
  }
  function position(session,model,item,day) {
    const records = session.records.filter(record=>record.itemId === item.id && record.date <= day).sort((a,b)=>b.date.localeCompare(a.date));
    const current = records.find(record=>validateProgress(item,record.fields,record.config,record.previous).ready);
    const percent = current ? (current.fields.noProgress ? current.previous.percent : validateProgress(item,current.fields,current.config,current.previous).reportedPercent) : item.sourcePercent;
    const gate = current ? (current.fields.noProgress ? current.previous.gate : current.fields.gate) : item.sourceGate;
    return {percent,gate,record:current,green:percent >= 90 || (current?.date === day),ceiling:percent >= 90};
  }
  function validateSession(session,model,photoIds = null) {
    assert(session?.schema === 'weekly-progress-session/1' && session.packageId === model.sessionId,'Recovery session does not match the weekly package.');
    assert(Array.isArray(session.records) && Array.isArray(session.approvals) && Array.isArray(session.exports) && session.editors && session.ui,'Invalid saved session.');
    if(session.removedPhotoIds !== undefined)assert(Array.isArray(session.removedPhotoIds) && session.removedPhotoIds.length<=100000 && new Set(session.removedPhotoIds).size === session.removedPhotoIds.length && session.removedPhotoIds.every(id=>typeof id === 'string' && /^[a-zA-Z0-9_-]+$/.test(id) && (!photoIds || photoIds.has(id))),'Invalid removed photo history.');
    const identities = new Set(), ids = new Set(), allItems = new Set(model.items.map(item=>item.id));
    session.checkins ||= [];
    assert(Array.isArray(session.checkins) && session.checkins.length<=10000,'Invalid building check-in history.');
    const buildingDays=new Set();
    for(const record of session.checkins){validateCheckin(record);const key=R.key(record.date,record.building,record.groupId || '',record.supervisorKey || '');assert(record.weekKey === session.weekKey && model.items.some(item=>item.building === record.building && item.origin === 'Weekly Plan') && !buildingDays.has(key) && !ids.has(record.id),'Invalid or repeated building check-in.');
      if(record.kind === 'work-group-no-progress'){const scope=groupScopes(model).find(scope=>scope.building === record.building && scope.groupId === record.groupId);assert(scope && record.workflows.every(row=>scope.workflows.some(value=>stable(value) === stable(row))),'Check-in workflows are outside this package.');}
      buildingDays.add(key);ids.add(record.id);}
    assert(session.records.length <= 50000 && session.addedIds.every(id=>allItems.has(id)),'Invalid saved ECS references.');
    for (const record of session.records) {
      const key = editorKey(date(record.date),record.itemId);
      assert(allItems.has(record.itemId) && !identities.has(key) && !ids.has(record.id) && Number.isInteger(record.revision) && record.revision > 0,'Invalid or duplicate daily record.');
      assert(record.weekKey === session.weekKey && text(record.batchId) && Array.isArray(record.photos),'Invalid daily batch identity.');
      if (photoIds) assert(record.photos.every(id=>photoIds.has(id)),'A daily record is missing photo bytes.');
      identities.add(key); ids.add(record.id);
    }
    for (const [key,editor] of Object.entries(session.editors)) {
      assert(key === editorKey(date(editor.date),editor.itemId) && allItems.has(editor.itemId) && Array.isArray(editor.photos),'Invalid unfinished editor.');
      if (photoIds) assert(editor.photos.every(id=>photoIds.has(id)),'An unfinished editor is missing photo bytes.');
    }
    session.deletedEntries ||= [];
    assert(Array.isArray(session.deletedEntries) && session.deletedEntries.length<=10000,'Invalid deleted-entry history.');
    const deletedIds=new Set();
    for(const entry of session.deletedEntries){
      assert(entry.id && !deletedIds.has(entry.id) && ['ecs','checkin'].includes(entry.kind) && date(entry.date) && Number.isFinite(Date.parse(entry.deletedAt)) && (!entry.restoredAt || Number.isFinite(Date.parse(entry.restoredAt))),'Invalid deleted entry.');deletedIds.add(entry.id);
      assert(entry.record || entry.editor,'Deleted entry has no recoverable content.');
      if(entry.kind === 'checkin'){validateCheckin(entry.record);assert(entry.record.date === entry.date && entry.record.weekKey === session.weekKey && !entry.editor,'Invalid deleted check-in.');}
      else{
        assert(allItems.has(entry.itemId) && (!entry.record || entry.record.itemId === entry.itemId && entry.record.date === entry.date && entry.record.weekKey === session.weekKey) && (!entry.editor || entry.editor.itemId === entry.itemId && entry.editor.date === entry.date),'Invalid deleted ECS context.');
        for(const source of [entry.record,entry.editor].filter(Boolean))assert(Array.isArray(source.photos) && (!photoIds || source.photos.every(id=>photoIds.has(id))),'Deleted entry is missing recoverable photo bytes.');
      }
    }
    if(session.pendingCheckin){const form=session.pendingCheckin;date(form.date);assert(typeof form.name === 'string' && form.name.length<=255 && typeof form.id === 'string' && (!form.id || session.checkins.some(record=>record.id === form.id && record.building === form.building && record.groupId === form.groupId && record.date === form.date)) && groupScopes(model).some(scope=>scope.building === form.building && scope.groupId === form.groupId),'Invalid unfinished no-progress entry.');}
    return session;
  }
  function photoPath(photo) {
    assert(/^[a-zA-Z0-9_-]+$/.test(photo.id),'Invalid PhotoID.');
    if(photo.pathVersion === 2){
      const stamp=new Date(photo.capturedAt);assert(Number.isFinite(stamp.getTime()),'Invalid photo capture time.');
      const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(stamp),part=name=>parts.find(value=>value.type === name).value;
      const day=part('year')+'-'+part('month')+'-'+part('day');assert(photo.captureDate === day,'Photo capture date differs from UK capture time.');
      const folder=R.photoFolder(photo).slice(0,-13),ecs=text(photo.ecsCode).replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,80) || 'ECS',suffix=photo.fileSuffix || '';
      assert(/^(?:_\d{3})?(?:_[0-9a-f]{6,8})?$/.test(suffix),'Invalid photo filename suffix.');
      return folder+'/'+day+'/'+ecs+'_'+day.replace(/-/g,'')+'_'+part('hour')+part('minute')+part('second')+suffix+'.jpg';
    }
    return R.photoFolder({building:photo.building,captureDate:photo.captureDate}) + '/' +
      photo.ecsCode.replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,80) + '_' + photo.id + '.jpg';
  }
  function namePhoto(photo,existing=[]){
    const named={...photo,pathVersion:2,fileSuffix:''},paths=existing instanceof Set?existing:new Set(existing.filter(value=>value.id !== photo.id).map(photoPath));
    if(paths.has(photoPath(named))){
      named.fileSuffix='_'+String(new Date(photo.capturedAt).getUTCMilliseconds()).padStart(3,'0');
      if(paths.has(photoPath(named))){let hash=2166136261;for(const char of photo.id)hash=Math.imul(hash^char.charCodeAt(0),16777619)>>>0;named.fileSuffix+='_'+hash.toString(16).padStart(8,'0');}
    }
    assert(!paths.has(photoPath(named)),'Photo name collision. Retain this capture and retry.');return named;
  }
  function example() {
    const weekly = [
      {WeekKey:'Week-42-2026',Building:'1HL4',Room:'101',Commodity:'ELEC-SUPPORT',ECSCode:'ECS-001',LatestPercent:10,LatestGateStatus:'1ENDS_CUT'},
      {WeekKey:'Week-42-2026',Building:'1HL4',Room:'101',Commodity:'ELEC-SUPPORT',ECSCode:'ECS-003',LatestPercent:90,LatestGateStatus:'3WELDING'},
      {WeekKey:'Week-42-2026',Building:'1HL4',Room:'102',Commodity:'HVAC-DUCT',ECSCode:'ECS-010',LatestPercent:20,LatestGateStatus:'1HAND_POS'}
    ];
    const refs = weekly.map(row=>({...row,GateStatusStructure:row.Commodity === 'ELEC-SUPPORT' ? 'HPC-BIP-ALL-SUPPORTS' : 'HPC-BIP-DUCTING',GateStatus:row.LatestGateStatus,PercentComplete:row.LatestPercent,Description:'Example installation work'}));
    refs.push({...refs[0],ECSCode:'ECS-201',Description:'Support bracket outside weekly plan'});
    return prepareRows(weekly,refs);
  }
  const api = {VERSION,R,copy,text,uid,newBatchId,stable,assert,date,config,gate,reportedPercent,prepareRows,pack,unpack,createSession,editorKey,recordFor,hasFields,essence,fingerprint,
    WORK_GROUPS,groupLabel,workGroup,rowGroup,recorder,groupScopes,scopeDisciplines,workConflicts,saveWorkCheckin,isCheckin,noProgressBatchId,validateCheckin,saveBuildingCheckin,pendingCheckins,roomChanged,validateProgress,previousFor,previousForEdit,editorFor,editorDirty,setEditor,photoRemoval,removePhoto,saveEditor,sharedPhotoChoice,sharedPhotoPlan,validateRecord,approvalFor,exported,pending,dailyExportState,sign,visibleItems,search,addCandidate,candidateRemoval,removeCandidate,deleteEntry,restoreCheck,restoreEntry,hiddenPhotoIds,position,validateSession,photoPath,namePhoto,example,today:R.londonDate};
  if (typeof module === 'object' && module.exports) module.exports = api; else root.WeeklyCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
