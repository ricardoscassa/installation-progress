(function(){
  'use strict';
  const W=WeeklyCore,R=W.R,F=WeeklyFiles,S=WeeklyStorage;
  const $=id=>document.getElementById(id),content=$('content'),modal=$('modal'),modalBody=$('modal-body');
  let cameraInput=$('camera-input'),captureFlight=null,foregroundRecovery=null,photoDrawEpoch=0,preparedPhotoURL=null;
  let session=null,model=null,photos=[],pendingPhotos=[],queue=Promise.resolve(),committedVersion=0,storageFailed=false,offlineReady=false;
  let stagedModel=null,searchOpen=false,searchValue='',today=W.today(),busy=false,lastCheckpoint=0,objectUrls=[];
  let cameraPending=null,processedPhoto=null,workerRegistration=null,inputSaveTimer=null,noticeTimer=null,preparedDownloadURL=null;
  let comparisonObserver=null;
  const waitingActions=[];
  const h=(tag,className='',value='')=>{const el=document.createElement(tag);if(className)el.className=className;if(value !== '')el.textContent=String(value);return el;};
  function icon(name){const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'),use=document.createElementNS(svg.namespaceURI,'use');use.setAttribute('href','#i-'+name);svg.append(use);svg.setAttribute('aria-hidden','true');return svg;}
  function button(label,action,cls='button',symbol=''){const el=h('button',cls);el.type='button';if(symbol)el.append(icon(symbol));el.append(document.createTextNode(label));el.addEventListener('click',()=>run(action));return el;}
  function field(label,control){const el=h('label','field',label);if(['INPUT','SELECT','TEXTAREA'].includes(control.tagName) && !control.hasAttribute('aria-label'))control.setAttribute('aria-label',label);el.append(control);return el;}
  function input(type,value='',placeholder=''){const el=h('input');el.type=type;el.value=value;el.placeholder=placeholder;return el;}
  function select(options,value){const el=h('select');options.forEach(option=>{const obj=typeof option === 'object'?option:{value:option,label:option};const op=h('option','',obj.label);op.value=obj.value;el.append(op);});el.value=value;return el;}
  function check(label,value,change){const box=input('checkbox');box.checked=!!value;box.addEventListener('change',()=>change(box.checked));const el=h('label','check');el.append(box,h('span','',label));return el;}
  function pill(label,cls=''){return h('span','pill '+cls,label);}
  function heading(title,eyebrow='',subtitle=''){if(eyebrow)content.append(h('div','eyebrow',eyebrow));content.append(h('h1','',title));if(subtitle)content.append(h('p','subtle',subtitle));}
  function note(value){content.append(h('div','note',value));}
  function time(value){return new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}).format(new Date(value));}
  function dayLabel(day){return new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',weekday:'long',day:'numeric',month:'long'}).format(new Date(day+'T12:00:00Z'));}
  function showError(error){$('error-banner').hidden=false;$('error-banner').textContent=error?.message || String(error);console.error(error);}
  function notice(value){clearTimeout(noticeTimer);$('notice').hidden=!value;$('notice').textContent=value;if(value)noticeTimer=setTimeout(()=>{$('notice').hidden=true;},4500);}
  function saving(value){$('save-status').textContent=value;}
  async function run(action){
    if(busy)return new Promise(resolve=>waitingActions.push({action,resolve}));
    busy=true;content.inert=true;modalBody.inert=true;
    try{await action();}catch(error){showError(error);}
    finally{busy=false;content.inert=false;modalBody.inert=false;const next=waitingActions.shift();if(next)run(next.action).then(next.resolve);}
  }
  function persist(options={}){
    if(inputSaveTimer){clearTimeout(inputSaveTimer);inputSaveTimer=null;}
    if(storageFailed)return Promise.reject(new Error('Saving stopped after a storage error. Keep this window open and use recovery or reload.'));
    session.journalGeneration+=1;session.updatedAt=new Date().toISOString();
    const journalOK=S.journal(session,options.editorOnly && !session.pendingCheckin),snapshot=W.copy(session);
    saving(journalOK?'Saving…':'Saving to database…');
    queue=queue.then(async()=>{
      snapshot.storageVersion=committedVersion;
      const saved=await S.save(snapshot,options);committedVersion=saved.storageVersion;
      if(session?.id === saved.id){session.storageVersion=committedVersion;if(session.journalGeneration === saved.journalGeneration){try{const current=JSON.parse(localStorage.getItem(S.JOURNAL) || 'null');if(journalOK && current?.token === journalOK)localStorage.removeItem(S.JOURNAL);}catch{}saving('Saved on this device');}}
      return saved;
    }).catch(error=>{storageFailed=true;saving('Save failed · keep page open');const message=new Error('Your latest work is retained in the recovery journal where possible. '+error.message);showError(message);throw message;});
    return queue;
  }
  async function flush(){if(inputSaveTimer){clearTimeout(inputSaveTimer);inputSaveTimer=null;await persist({editorOnly:true});}return queue;}
  function persistEditor(){
    if(storageFailed){showError(new Error('Saving has stopped. Keep this page open and recover your work.'));return;}
    session.journalGeneration+=1;session.updatedAt=new Date().toISOString();S.journal(session,!session.pendingCheckin);saving('Saving…');
    if(inputSaveTimer)clearTimeout(inputSaveTimer);
    inputSaveTimer=setTimeout(()=>{inputSaveTimer=null;persist({editorOnly:true}).catch(showError);},120);
  }
  function revoke(){objectUrls.forEach(url=>URL.revokeObjectURL(url));objectUrls=[];}
  function image(photo,cls=''){const el=h('img',cls);const url=URL.createObjectURL(photo.blob);objectUrls.push(url);el.loading=cls === 'preview-photo'?'eager':'lazy';el.decoding='async';el.src=url;el.alt=photo.ecsCode+' · '+photo.building+' · '+photo.room;return el;}
  function download(blob,name){const url=URL.createObjectURL(blob),anchor=document.createElement('a');anchor.href=url;anchor.download=name;document.body.append(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}
  function releaseDownload(){for(const url of [preparedDownloadURL,preparedPhotoURL].filter(Boolean))setTimeout(()=>URL.revokeObjectURL(url),60000);preparedDownloadURL=null;preparedPhotoURL=null;}
  function closeDialog(){photoDrawEpoch++;modal.close();modalBody.replaceChildren();cameraPending=null;processedPhoto=null;releaseDownload();}
  function dialog(title){
    releaseDownload();modalBody.replaceChildren();const row=h('div','dialog-heading'),close=button('×',closeDialog,'dialog-close');close.setAttribute('aria-label','Close dialog');
    row.append(h('h2','',title),close);modalBody.append(row);if(!modal.open)modal.showModal();return modalBody;
  }
  function validationBox(errors){const box=h('div','errors'),list=h('ul');errors.forEach(error=>list.append(h('li','',error)));box.append(list);return box;}
  function currentConfig(){return session?.config || model.config;}
  function sourceItem(id){return model.items.find(item=>item.id === id);}
  function activeEditor(){
    if(!session?.ui.expanded)return null;
    const item=sourceItem(session.ui.expanded);if(!item)return null;
    return W.editorFor(session,model,item,session.ui.editDate || today);
  }
  async function saveOpen({explicit=false}={}){
    const editor=activeEditor();if(!editor)return;
    const item=sourceItem(editor.itemId);
    if(W.hasFields(editor.fields) && (W.editorDirty(session,editor) || explicit)){
      const record=W.saveEditor(session,model,item,editor);await persist();
      const validation=W.validateRecord(session,model,record);
      if(!validation.ready)notice('Draft saved. '+validation.errors.join(' '));
    }
    await flush();
  }
  async function navigate(page){
    notice('');
    await saveOpen();session.ui.screen=page;session.ui.expanded='';session.ui.editDate='';session.ui.scroll=0;
    searchOpen=false;searchValue='';await persist();render();
  }
  async function openCard(item,day=today){
    await saveOpen();
    const same=session.ui.expanded === item.id && session.ui.editDate === day;
    session.ui.expanded=same?'':item.id;session.ui.editDate=same?'':day;
    await persist();renderRooms();
    if(!same)requestAnimationFrame(()=>document.getElementById('open-ecs-card')?.scrollIntoView({block:'nearest',behavior:'smooth'}));
  }
  async function checkpoint(reason='Automatic checkpoint'){
    await flush();
    if(!session)return;
    await S.archive(session,model,reason);lastCheckpoint=Date.now();
  }
  function scheduleCheckpoint(){if(Date.now()-lastCheckpoint < 180000)return;setTimeout(()=>{if(!busy && !session?.pendingCapture)checkpoint().catch(error=>notice('Automatic recovery checkpoint delayed: '+error.message));},100);}
  function summary(record,item){
    if(record.fields.noProgress)return 'No Progress · '+(record.previous.percent ?? '—')+'% retained';
    const v=W.validateProgress(item,record.fields,record.config,record.previous);
    return (record.previous.percent ?? '—')+'% → '+(v.reportedPercent ?? '—')+'% · '+(record.fields.gate || 'Gate needed');
  }
  function gateLabel(code){return ({'1ENDS_CUT':'Ends cut','2PREP_TACK':'Preparation & tack','3WELDING':'Welding','1HAND_POS':'Handling & positioning','2INST_DUCT':'Duct installation'}[code]) || code.replace(/^\d+/,'').replace(/_/g,' ');}
  function resetContent(){comparisonObserver?.disconnect();comparisonObserver=null;revoke();content.replaceChildren();$('week-label').textContent=model?model.reportingWeek:'';$('day-label').textContent=today.slice(5).split('-').reverse().join('/');}
  function render(){
    resetContent();$('bottom-menu').hidden=!session;$('settings-button').hidden=!session;
    if(!session){renderLoad();return;}
    document.querySelectorAll('#bottom-menu button').forEach(el=>{
      if(el.dataset.page === session.ui.screen)el.setAttribute('aria-current','page');else el.removeAttribute('aria-current');
    });
    ({home:renderHome,rooms:renderRooms,draft:renderDraft,export:renderExport,photos:renderPhotos}[session.ui.screen] || renderHome)();
    content.scrollTop=session.ui.scroll || 0;
  }
  function renderHome(){
    resetContent();const buildings=[...new Set(model.items.filter(item=>item.origin === 'Weekly Plan').map(item=>item.building))];
    heading('Your week, in view.',buildings.join(' · ')+' · '+dayLabel(today),model.stats.planned+' planned ECS · '+Object.keys(model.roomCodes).length+' rooms');
    const metrics=h('div','metrics'),records=session.records.filter(record=>record.date === today),unfinished=Object.values(session.editors).filter(editor=>editor.date === today && W.editorDirty(session,editor)).length;
    const draftIds=new Set([...W.pending(session,today).map(record=>record.itemId),...Object.values(session.editors).filter(editor=>editor.date === today && W.editorDirty(session,editor)).map(editor=>editor.itemId)]);
    [['ECS recorded today',records.filter(record=>W.validateProgress(sourceItem(record.itemId),record.fields,record.config,record.previous).ready).length],['In today’s draft',draftIds.size+W.pendingCheckins(session,today).length],['Exported today',[...records,...(session.checkins || []).filter(record=>record.date === today)].filter(record=>W.exported(session,record)).length]].forEach(([label,value])=>{const box=h('div','metric');box.append(h('strong','',value),h('span','',label));metrics.append(box);});
    content.append(metrics,button(session.pendingCheckin?'Resume no progress entry':'No progress today',()=>workCheckin(),'button','check'));
    buildings.forEach(building=>{
    const buildingHeading=h('div','building-heading');buildingHeading.append(h('h2','',building));content.append(buildingHeading);
    (session.checkins || []).filter(record=>record.building === building && record.date === today).forEach(record=>{
      const row=h('div','spread');row.append(h('p','subtle',W.groupLabel(record.groupId)+' · No progress · '+record.supervisorName));
      if(record.kind === 'work-group-no-progress')row.append(button('Edit',()=>workCheckin(record),'link-button'));content.append(row);
    });
    const grid=h('div','rooms-grid');
    Object.keys(model.roomCodes).filter(room=>roomBuilding(room) === building).forEach(room=>{
      const items=W.visibleItems(session,model,room),planned=items.filter(item=>item.origin === 'Weekly Plan'),recorded=items.filter(item=>W.position(session,model,item,today).record?.date === today).length,at90=items.filter(item=>W.position(session,model,item,today).ceiling).length;
      const card=button('',async()=>{await saveOpen();session.ui.room=room;await navigate('rooms');},'room-card');
      const row=h('div','spread');row.append(h('strong','',roomName(room)),icon('arrow'));card.append(row,h('p','subtle',planned.length+' planned ECS'));
      if(W.roomChanged(session,model,room,today)){const flag=pill('Changed today','good');flag.prepend(icon('check'));card.append(flag);}
      card.append(h('div','green-text',recorded+' recorded today · '+at90+' at 90% or above'));grid.append(card);
    });
    content.append(grid);
    });
    content.append(h('p','subtle','Recorded by '+session.operator.name),button('Load another week',()=>{$('package-input').click();},'link-button'));
    if(pendingPhotos.length)content.append(button('Resume interrupted photo ('+pendingPhotos.length+')',()=>resumePhoto(pendingPhotos[0]),'button block'));
    if(session.pendingCapture && !pendingPhotos.length)note('A camera session was interrupted. Saved work is intact; reopen that ECS to take the photo again.');
  }
  function workCheckin(previous=null){
    const draft=session.pendingCheckin && (!previous || previous.id === session.pendingCheckin.id)?session.pendingCheckin:null;
    if(!previous && draft?.id)previous=session.checkins.find(record=>record.id === draft.id);
    const day=previous?.date || draft?.date || today,scopes=W.groupScopes(model),buildings=[...new Set(scopes.map(scope=>scope.building))],body=dialog('No progress');
    if(!scopes.length){body.append(h('p','','No supported work groups are loaded.'));return;}
    body.append(h('p','subtle',dayLabel(day)+' · Records 0 ECS items for the selected work group and responsible person.'));
    const building=select(buildings,previous?.building || draft?.building || roomBuilding(session.ui.room) || buildings[0]),group=select([],''),name=input('text',draft?.name ?? previous?.supervisorName ?? '','Supervisor / superintendent full name'),scopeText=h('p','subtle'),warning=h('div','note'),confirm=input('checkbox'),confirmation=h('label','check');name.maxLength=255;
    confirmation.append(confirm,h('span','','This responsible person has no ECS entries for this scope today.'));
    const save=button('Record no progress',async()=>{
      W.assert(!W.workConflicts(session,model,building.value,group.value,day) || confirm.checked,'Confirm the responsible person has no ECS entries for this scope.');
      W.saveWorkCheckin(session,model,{building:building.value,groupId:group.value,supervisorName:name.value,id:previous?.id || ''},day);
      delete session.pendingCheckin;await persist();closeDialog();render();notice('No progress saved for '+dayLabel(day)+'. Export it from Daily export.');scheduleCheckpoint();
    },'button primary block');save.id='save-building-checkin';
    const enable=()=>{const conflict=W.workConflicts(session,model,building.value,group.value,day);warning.hidden=!conflict;confirmation.hidden=!conflict;save.disabled=name.value.trim().length<2 || !group.value || conflict && !confirm.checked;};
    const refresh=()=>{const scope=scopes.find(scope=>scope.building === building.value && scope.groupId === group.value);scopeText.textContent=scope?'Includes '+scope.workflows.map(row=>row.commodity).filter((value,index,rows)=>rows.indexOf(value) === index).join(', '):'';confirm.checked=false;enable();};
    const drawGroups=()=>{group.replaceChildren();scopes.filter(scope=>scope.building === building.value).forEach(scope=>{const option=h('option','',W.groupLabel(scope.groupId));option.value=scope.groupId;group.append(option);});if(previous)group.value=previous.groupId;refresh();};
    const remember=()=>{session.pendingCheckin={date:day,building:building.value,groupId:group.value,name:name.value,id:previous?.id || ''};persistEditor();};
    building.onchange=()=>{drawGroups();remember();};group.onchange=()=>{refresh();remember();};name.oninput=()=>{enable();remember();};confirm.onchange=enable;building.disabled=!!previous || buildings.length===1;group.disabled=!!previous;
    warning.textContent='This work group already has recorded or unfinished ECS work today. Confirm this check-in is for a responsible person with no ECS entries.';
    body.append(field('Building',building),field('Work group',group),scopeText,field('Supervisor / superintendent name',name),warning,confirmation,save,
      button('Discard unfinished entry',async()=>{delete session.pendingCheckin;await persist();closeDialog();render();},'link-button'));drawGroups();if(draft && !previous){group.value=draft.groupId;refresh();}
  }
  function renderLoad(){
    resetContent();heading('Load weekly package','START YOUR WEEK','Choose your prepared weekly ZIP.');
    content.append(button('Choose compressed file',()=>{$('package-input').click();},'button primary block','down'));
    content.append(button('Explore with example data',async()=>{stagedModel=W.example();renderLoad();},'button block'));
    if(stagedModel){
      const suggested=stagedModel.recorder || session?.operator || {},name=input('text',suggested.name || '','First name and surname'),email=input('email',suggested.email || '','Optional email'),recordingAs=h('p','note');
      content.append(h('h2','',stagedModel.reportingWeek),h('p','subtle',stagedModel.stats.planned+' planned ECS · '+Object.keys(stagedModel.roomCodes).length+' rooms · '+stagedModel.stats.candidates+' hidden search candidates'));
      content.append(field('Person recording this week',name),field('Email',email));
      const identity=()=>{recordingAs.textContent='Recording as: '+(name.value.trim() || 'enter your name')+(email.value.trim()?' · '+email.value.trim():'');};name.oninput=identity;email.oninput=identity;identity();content.append(recordingAs,h('p','subtle','Confirm these details. They identify the person recording each entry; supervisor names are recorded separately.'));
      const open=button('Open loaded week',async()=>{
        W.assert(offlineReady,'Wait for Offline ready before opening the week. Use HTTPS or localhost for the offline app.');
        const nextModel=stagedModel,operator=W.recorder({name:name.value,email:email.value},true);
        const replace=async()=>{
          if(session)await flush();const next=W.createSession(nextModel,operator);
          session=await S.replace(next,nextModel,[],[],{purgeRecovery:true});model=nextModel;stagedModel=null;photos=[];pendingPhotos=[];cameraInput.value='';committedVersion=session.storageVersion;storageFailed=false;queue=Promise.resolve();closeDialog();render();await checkpoint('New week loaded');
          if(navigator.storage?.persist)navigator.storage.persist().catch(()=>{});
        };
        if(session || (await S.snapshots()).length){const body=dialog('Replace the current week?');body.append(h('p','','This permanently removes the current week’s records, photos, unfinished captures and all local recovery copies from this app. ZIP files already saved in Files or OneDrive remain available.'));
          body.append(h('p','subtle','Download any work you want to keep before continuing. A backup download is optional.'));
          if(session){const backup=button('Prepare optional recovery ZIP',async()=>{await flush();const [savedPhotos,savedPending]=await Promise.all([S.photos(),S.pending()]);const data=await F.recoveryData(session,model,savedPhotos,savedPending),blob=await F.zip(data.entries);preparedDownloadURL=URL.createObjectURL(blob);const link=h('a','button block','Save optional recovery ZIP');link.href=preparedDownloadURL;link.download='progress_recovery_'+today+'_'+session.id+'.zip';backup.replaceWith(link);},'button block');body.append(backup);}
          body.append(button('Replace week and clear previous data',replace,'button danger block'));
        }else await replace();
      },'button primary block');
      open.disabled=!offlineReady;open.dataset.offlineRequired='true';content.append(open);
    }
    note('Only the active week is kept. Replacing it clears previous records, photos and local recovery after a warning. The offline app stays cached.');
    if(session)content.append(button('Return to current week',()=>{stagedModel=null;render();},'link-button'));
  }
  function renderRooms(){
    const scroll=content.scrollTop;resetContent();const room=session.ui.room;
    heading(roomName(room),dayLabel(session.ui.editDate || today),'Planned work · save a record to add it to the daily draft.');
    const buildings=[...new Set(model.items.filter(item=>item.origin === 'Weekly Plan').map(item=>item.building))];
    if(buildings.length>1){const building=select(buildings,roomBuilding(room));building.onchange=()=>run(()=>changeRoom(Object.keys(model.roomCodes).find(key=>roomBuilding(key) === building.value)));content.append(field('Building',building));}
    const rooms=Object.keys(model.roomCodes).filter(key=>roomBuilding(key) === roomBuilding(room));
    const roomSelect=rooms.length>10?button(roomName(room),()=>chooseRoom(rooms),'button block'):select(rooms.map(value=>({value,label:roomName(value)})),room);roomSelect.id='room-select';
    if(rooms.length<=10)roomSelect.onchange=()=>run(()=>changeRoom(roomSelect.value));else roomSelect.setAttribute('aria-haspopup','dialog');
    content.append(field('Navigate rooms',roomSelect));
    updateRoomFlags();
    if(session.ui.editDate && session.ui.editDate !== today){note('Editing '+dayLabel(session.ui.editDate)+'. Today’s entries stay separate.');content.append(button('Return to today',async()=>{await saveOpen();session.ui.expanded='';session.ui.editDate='';await persist();renderRooms();},'link-button'));}
    const day=session.ui.editDate || today;
    const list=h('div');list.id='ecs-list';
    const items=W.visibleItems(session,model,room).sort((a,b)=>Number(W.position(session,model,b,today).green)-Number(W.position(session,model,a,today).green)||a.ecsCode.localeCompare(b.ecsCode,undefined,{numeric:true}));
    items.forEach(item=>list.append(renderCard(item,day)));content.append(list);
    const add=button('Add ECS',async()=>{await saveOpen();searchOpen=!searchOpen;session.ui.expanded='';await persist();renderRooms();if(searchOpen)$('candidate-query')?.focus();},'add-button','plus');add.id='add-ecs';content.append(add);
    if(searchOpen)renderSearch(room);deletedEntries(content,day,room);content.scrollTop=scroll;
  }
  const roomName=key=>model.items.find(item=>item.roomLabel === key)?.room || key;
  const roomBuilding=key=>model.items.find(item=>item.roomLabel === key)?.building || '';
  function updateRoomFlags(){
    const control=$('room-select');if(!control)return;
    if(control.tagName === 'SELECT')Array.from(control.options).forEach(option=>option.textContent=roomName(option.value)+(W.roomChanged(session,model,option.value,today)?' · ✓ Changed today':''));
    else control.textContent=roomName(session.ui.room)+(W.roomChanged(session,model,session.ui.room,today)?' · ✓ Changed today':' · Choose room');
  }
  async function changeRoom(room){await saveOpen();session.ui.room=room;session.ui.expanded='';session.ui.editDate='';session.ui.scroll=0;searchOpen=false;searchValue='';await persist();closeDialog();render();}
  function chooseRoom(rooms){
    const body=dialog('Choose room'),query=input('search','','Search room'),list=h('div');let changedOnly=false;
    query.id='room-query';const filter=button('Changed today',()=>{changedOnly=!changedOnly;filter.setAttribute('aria-pressed',String(changedOnly));draw();},'button');filter.id='changed-room-filter';filter.setAttribute('aria-pressed','false');
    body.append(field('Search rooms',query),filter,list);
    const draw=()=>{list.replaceChildren();const found=rooms.filter(room=>roomName(room).toLowerCase().includes(query.value.toLowerCase()) && (!changedOnly || W.roomChanged(session,model,room,today)));
      list.append(h('p','subtle',found.length+' rooms'+(found.length>50?' · showing the first 50; type to narrow':'')));
      found.slice(0,50).forEach(room=>{const row=button('',()=>changeRoom(room),'room-choice');row.dataset.roomChoice=room;row.append(h('strong','',roomName(room)));if(W.roomChanged(session,model,room,today)){const flag=pill('Changed today','good');flag.prepend(icon('check'));row.append(flag);}list.append(row);});};
    query.oninput=draw;draw();query.focus();
  }
  function renderCard(item,day){
    const pos=W.position(session,model,item,today),expanded=session.ui.expanded === item.id;
    const card=h('article','ecs-card'+(pos.green?' recorded':''));card.dataset.ecs=item.ecsCode;
    if(expanded)card.id='open-ecs-card';
    const toggle=button('',()=>openCard(item,day),'ecs-toggle'),line=h('div','spread');toggle.setAttribute('aria-expanded',expanded?'true':'false');
    line.append(h('span','ecs-code',item.ecsCode),h('strong','ecs-percent',(pos.percent ?? '—')+'%'));
    const meta=h('div','ecs-meta');meta.append(h('span','',item.canonicalCommodity));if(item.origin !== 'Weekly Plan')meta.append(pill('Not in weekly plan'));
    const current=W.recordFor(session,today,item.id),photoCount=current?.photos.length || 0;
    if(photoCount){meta.append(icon('camera'),h('span','',photoCount));}
    meta.append(icon('chevron'));toggle.append(line,meta);
    const validation=current?W.validateRecord(session,model,current):null;
    const label=pos.ceiling?'90% or above · open to edit · stays green this week':pos.record?.date === today?'Recorded today · '+pos.gate:current?'Draft · requirements need attention':'Latest: '+(pos.gate || 'Reference needed');
    toggle.append(h('div',pos.green?'ecs-result':'subtle',label));card.append(toggle);
    if(expanded)card.append(renderEditor(item,day));
    return card;
  }
  function renderEditor(item,day){
    const editor=W.editorFor(session,model,item,day),body=h('div','ecs-editor'),flow=R.workflow(item),cfg=currentConfig();
    body.append(progressComparison(item,editor.previous));
    const validation=h('div');validation.id='editor-validation';
    const readiness=()=>{
      validation.replaceChildren();if(!W.hasFields(editor.fields))return;
      const v=W.validateProgress(item,editor.fields,cfg,editor.previous);
      validation.append(v.ready?h('p','green-text','Progress fields ready. Photos are optional.'):validationBox(v.errors));
    };
    const saveField=(name,value)=>{
      editor.fields[name]=value;editor.previous=W.copy(W.previousForEdit(session,model,item,editor));W.setEditor(session,editor);readiness();
      persistEditor();updateRoomFlags();
    };
    body.append(h('h3','','Gate status'));
    const gates=h('div','gates');
    const eligible=flow.rules.filter(rule=>rule.policy !== 'Fixed' || rule.percent <= 90);
    const chooseGate=async rule=>{
        editor.fields.gate=rule.code;editor.fields.noProgress=false;
        if(rule.policy === 'Fixed')editor.fields.percent=rule.percent;
        editor.previous=W.copy(W.previousForEdit(session,model,item,editor));
        W.setEditor(session,editor);await persist();body.replaceWith(renderEditor(item,day));updateRoomFlags();
    };
    const unavailable=()=>editor.previous.percent > 90;
    if(eligible.length>4){
      const picker=select([{value:'',label:'Select gate status'},...eligible.map(rule=>({value:rule.code,label:gateLabel(rule.code)+' · '+(rule.policy === 'Fixed'?rule.percent+'%':'0–90%')}))],editor.fields.gate || '');
      picker.dataset.gateSelect='true';picker.setAttribute('aria-label','Gate status');
      eligible.forEach((rule,index)=>picker.options[index+1].disabled=unavailable(rule));
      picker.onchange=()=>{const rule=eligible.find(value=>value.code === picker.value);if(rule)run(()=>chooseGate(rule));};
      gates.classList.add('gate-picker');gates.append(field('Select gate',picker));
    }else eligible.forEach(rule=>{
      const gate=button('',()=>chooseGate(rule),'gate');
      gate.dataset.gate=rule.code;gate.setAttribute('aria-pressed',String(editor.fields.gate === rule.code));
      gate.append(h('span','',gateLabel(rule.code)),h('strong','',rule.policy === 'Fixed'?rule.percent+'%':'0–90%'));
      gate.disabled=unavailable(rule);
      gates.append(gate);
    });
    gates.hidden=!!editor.fields.noProgress;body.append(gates);
    if(!flow.valid)body.append(h('p','errors','Reference required: source structure and commodity do not match an approved workflow.'));
    const selected=flow.rules.find(rule=>rule.code === editor.fields.gate);
    if(editor.fields.noProgress)body.append(h('p','green-text','Previous position retained: '+(editor.previous.gate || '—')+' · '+(editor.previous.percent ?? '—')+'%'));
    else if(selected && selected.policy !== 'Fixed'){
      const percent=input('number',editor.fields.percent ?? '');percent.min='0';percent.max='90';percent.step='any';percent.dataset.field='percent';
      percent.addEventListener('input',()=>saveField('percent',percent.value));body.append(field('New progress (%) · maximum 90',percent));
    }else if(selected)body.append(h('p','green-text','New progress: '+selected.percent+'% · fixed by gate'));
    if(editor.fields.noProgress)body.append(h('p','subtle','This earlier ECS no-progress record is retained.'),button('Record ECS progress instead',async()=>{editor.fields.noProgress=false;W.setEditor(session,editor);await persist();body.replaceWith(renderEditor(item,day));},'link-button'));
    const fields=h('div','split');
    R.fieldsFor(item,cfg).filter(def=>def.visible !== false).forEach(def=>{
      let control;
      if(def.type === 'select')control=select([{value:'',label:'Not recorded'},...(def.options || []).filter(op=>typeof op !== 'object' || op.active !== false).map(op=>typeof op === 'object'?{value:op.value,label:op.label || op.value}:op)],editor.fields[def.id] ?? '');
      else if(def.type === 'checkbox'){control=input('checkbox');control.checked=!!editor.fields[def.id];}
      else{control=input(def.type === 'number'?'number':'text',editor.fields[def.id] ?? '');if(def.min != null)control.min=def.min;if(def.max != null)control.max=def.max;if(def.type === 'number')control.step='any';}
      control.dataset.field=def.id;
      control.addEventListener(def.type === 'select' || def.type === 'checkbox'?'change':'input',()=>saveField(def.id,def.type === 'checkbox'?control.checked:control.value));
      fields.append(field(def.label+(def.required?' *':''),control));
    });
    body.append(fields);
    const delays=select([{value:'',label:'None recorded'},...['I130 · Damages','I133 · NCR Reworks','I134 · FCR Reworks','I136 · Weld Failure','I162 · Installation Not Per Design','I163 · Out Of Sequence Installation','I164 · Quality Documentation'].map(value=>({value:value.split(' · ')[0],label:value}))],editor.fields.DelayCode || '');
    delays.onchange=()=>saveField('DelayCode',delays.value);delays.dataset.field='DelayCode';body.append(field('Delay code',delays));
    const comments=h('textarea');comments.rows=3;comments.value=editor.fields.comments || '';comments.dataset.field='comments';comments.addEventListener('input',()=>saveField('comments',comments.value));
    body.append(field('Comments / No Progress reason',comments),validation);
    const latestPrevious=W.previousFor(session,model,item,day);
    if(W.stable(latestPrevious) !== W.stable(editor.previous))body.append(button('Review updated previous progress',async()=>{editor.previous=latestPrevious;W.setEditor(session,editor);await persist();body.replaceWith(renderEditor(item,day));},'button block'));
    const actions=h('div','camera-action'),camera=h('label','icon-button camera-trigger');camera.title='Take photo for '+item.ecsCode;
    bindCamera(item,editor);
    camera.append(icon('camera'),cameraInput);
    actions.append(camera,h('span','subtle',editor.photos.length+' photo'+(editor.photos.length === 1?'':'s')),button('Save progress',async()=>{
      W.setEditor(session,editor);W.saveEditor(session,model,item,editor);session.ui.expanded='';session.ui.editDate='';await persist();renderRooms();notice('Daily record saved. Review it in Draft.');scheduleCheckpoint();
    },'button primary'));body.append(actions,h('p','subtle','Edits autosave on this device. Switching cards saves the daily draft.'));
    if(editor.photos.length)body.append(photoGrid(editor.photos));
    const saved=W.recordFor(session,day,item.id);
    if(saved || W.hasFields(editor.fields) || editor.photos.length){const remove=button(saved?'Delete daily entry':'Discard entry',()=>confirmDelete({itemId:item.id,day}),'link-button danger');remove.dataset.deleteItem=item.id;body.append(remove);}
    if(wasExported(saved || {itemId:item.id,date:day}))body.append(h('p','subtle','Earlier downloads keep their original values. If those values were uploaded, correct them manually in the source lists.'));
    if(item.origin !== 'Weekly Plan'){
      const removal=W.candidateRemoval(session,model,item.id),remove=button('Remove added ECS',()=>removeAdded(item),'link-button danger');
      remove.dataset.removeEcs=item.id;remove.disabled=!removal.allowed;body.append(remove);
      if(!removal.allowed)body.append(h('p','subtle',removal.reason));
    }
    readiness();return body;
  }
  function removeAdded(item){
    const removal=W.candidateRemoval(session,model,item.id);W.assert(removal.allowed,removal.reason);
    const body=dialog('Remove added ECS?');body.append(h('p','',item.ecsCode+' will leave this room and remain available in Add ECS search. Any unfinished values will be kept in recovery.'));
    body.append(button('Remove from room',async()=>{await checkpoint('Before removing added ECS');W.removeCandidate(session,model,item.id);await persist();closeDialog();renderRooms();notice('Added ECS removed. It is still available in search.');},'button danger block'));
  }
  function wasExported(record){return session.exports.some(entry=>entry.kind === 'daily' && entry.records?.some(row=>row.payload?.record?.id === record.id || record.itemId && row.payload?.record?.itemId === record.itemId && row.payload?.record?.date === record.date));}
  async function editRecord(record){
    await saveOpen();const current=W.recordFor(session,record.date,record.itemId);W.assert(current,'This entry was deleted. Restore it from Deleted entries before editing.');
    const item=sourceItem(current.itemId);session.ui.screen='rooms';session.ui.room=item.roomLabel;session.ui.expanded=item.id;session.ui.editDate=current.date;await persist();closeDialog();render();
  }
  async function confirmDelete(context){
    await flush();const record=context.recordId?[...session.records,...(session.checkins || [])].find(record=>record.id === context.recordId):W.recordFor(session,context.day,context.itemId);
    const item=sourceItem(record?.itemId || context.itemId),day=record?.date || context.day;
    W.assert(!item || !pendingPhotos.some(photo=>photo.itemId === item.id && photo.workDate === day),'Finish the interrupted photo before deleting this entry.');
    const body=dialog('Delete daily entry?'),label=W.isCheckin(record)?record.building+' · '+W.groupLabel(record.groupId)+' · '+record.supervisorName:item.ecsCode+' · room '+item.room;
    body.append(h('p','',label+' · '+dayLabel(day)),h('p','','This removes the entry from current work. Undo keeps its values and photos available for this week. Loaded weekly-plan ECS stay in the room.'));
    if(record && wasExported(record))body.append(h('p','note','Earlier downloads keep this entry. Deleting here does not cancel anything already uploaded; corrections there are manual.'));
    body.append(button('Delete entry',async()=>{await checkpoint('Before deleting a daily entry');W.deleteEntry(session,model,context);await persist();closeDialog();render();notice('Entry deleted. Use Undo in Deleted entries to restore it.');scheduleCheckpoint();},'button danger block'));
    body.append(button('Keep entry',closeDialog,'button block'));
  }
  function deletedEntries(parent,day,room=''){
    const entries=(session.deletedEntries || []).filter(entry=>entry.date === day && !entry.restoredAt && (!room || sourceItem(entry.itemId)?.roomLabel === room));
    if(!entries.length)return;
    const group=h('details','batch deleted-entries');group.append(h('summary','','Deleted entries · '+entries.length),h('p','subtle','Undo is available while this week is loaded. Another week clears these entries and their local recovery.'));
    entries.slice().reverse().forEach(entry=>{
      const record=entry.record,item=sourceItem(entry.itemId),box=h('details','draft-record');box.dataset.deletedEntry=entry.id;
      box.append(h('summary','',entry.kind === 'checkin'?record.building+' · '+W.groupLabel(record.groupId)+' · No progress':item.ecsCode+' · room '+item.room),h('p','subtle','Deleted '+time(entry.deletedAt)));
      if(record && item)box.append(h('p','',summary(record,item)));
      if(entry.kind === 'checkin')box.append(h('p','',record.supervisorName));
      const photoIds=[...new Set([...(record?.photos || []),...(entry.editor?.photos || [])])];if(photoIds.length)box.append(photoGrid(photoIds));
      const check=W.restoreCheck(session,entry),undo=button('Undo deletion',async()=>{W.restoreEntry(session,model,entry.id);await persist();render();notice('Entry restored. Review it again before exporting.');scheduleCheckpoint();},'button block');undo.dataset.restoreEntry=entry.id;undo.disabled=!check.allowed;box.append(undo);
      if(!check.allowed)box.append(h('p','subtle',check.reason));group.append(box);
    });parent.append(group);
  }
  function progressComparison(item,previous){
    const row=h('div','progress-comparison'),prior=h('span','comparison-previous'),mpower=h('span','comparison-mpower'),divider=h('span','comparison-divider','|');
    const priorGate=previous.gate?gateLabel(previous.gate):'',mpowerGate=item.mpowerGate?gateLabel(item.mpowerGate):'';
    prior.append(h('span','comparison-label','Previous:'),h('span','comparison-gate',priorGate),h('span','comparison-percent',previous.percent == null?'Not recorded':(priorGate?'– ':'')+previous.percent+'%'));
    mpower.append(h('span','comparison-label','Mpower:'),h('span','comparison-mpower-gate',mpowerGate),h('span','comparison-percent',item.mpowerPercent == null?'—':item.mpowerPercent+'%'));
    prior.title='Previous site report: '+(priorGate?priorGate+' · ':'')+(previous.percent == null?'Not recorded':previous.percent+'%');
    mpower.title='Mpower comparison: '+(mpowerGate?mpowerGate+' · ':'')+(item.mpowerPercent == null?'Not recorded':item.mpowerPercent+'%');
    row.append(prior,divider,mpower);
    const fit=()=>{
      if(!row.isConnected || !row.clientWidth)return;
      row.classList.remove('compact-mpower');
      const priorWidth=[...prior.children].reduce((width,el)=>width+Math.max(el.scrollWidth,el.getBoundingClientRect().width),0)+6;
      row.classList.toggle('compact-mpower',priorWidth+mpower.getBoundingClientRect().width+divider.getBoundingClientRect().width+12>row.clientWidth);
    };
    comparisonObserver?.disconnect();
    if(typeof ResizeObserver === 'function'){comparisonObserver=new ResizeObserver(fit);comparisonObserver.observe(row);requestAnimationFrame(fit);}
    else row.classList.add('compact-mpower');
    return row;
  }
  function renderSearch(room){
    const box=h('section','search-container');box.id='candidate-search';
    const query=input('search',searchValue,'Type ECS code or description');query.id='candidate-query';
    box.append(field('Search work in '+room,query),h('p','subtle','Only this room’s selected work groups are searched.'));
    const results=h('div');results.id='candidate-results';box.append(results);content.append(box);
    const update=()=>{
      searchValue=query.value;results.replaceChildren();
      const found=W.search(session,model,room,query.value);
      if(!query.value.trim()){results.append(h('p','subtle','Start typing to narrow the list.'));return;}
      results.append(h('p','subtle',found.total+' matches'+(found.total>found.items.length?' · first '+found.items.length+' shown, keep typing to narrow':'')));
      found.items.forEach(item=>{
        const pick=button('',async()=>{await saveOpen();W.addCandidate(session,model,item.id,room);session.ui.expanded=item.id;session.ui.editDate=today;searchOpen=false;searchValue='';await persist();renderRooms();},'candidate');
        pick.append(h('strong','',item.ecsCode),h('span','',item.description || item.canonicalCommodity));results.append(pick);
      });
    };
    query.addEventListener('input',update);update();
  }
  function photoGrid(ids){
    const grid=h('div','photo-grid');
    ids.forEach(id=>{const photo=photos.find(value=>value.id === id);if(!photo)return;const tile=button('',()=>viewPhoto(photo),'photo-tile');tile.append(image(photo),h('span','',photo.ecsCode+' · '+photo.captureDate));grid.append(tile);});return grid;
  }
  function recordDetails(record,{history=false}={}){
    if(W.isCheckin(record)){
      const details=h('details','draft-record'),sum=h('summary'),row=h('div','spread');row.append(h('span','',record.building+' · '+W.groupLabel(record.groupId)+' · No progress'),icon('chevron'));sum.append(row,h('span','checkin-owner',record.supervisorName));details.append(sum,h('p','subtle',dayLabel(record.date)+' · 0 ECS items'),h('p','','Supervisor / superintendent: '+record.supervisorName),h('p','subtle','Recorded by '+record.operator.name+' · '+time(record.recordedAt)));
      const current=(session.checkins || []).find(value=>value.id === record.id);
      if(current){const actions=h('div','row');if(record.kind === 'work-group-no-progress')actions.append(button(history?'Edit current check-in':'Edit check-in',()=>workCheckin(current),'link-button'));const remove=button('Delete daily entry',()=>confirmDelete({recordId:current.id}),'link-button danger');remove.dataset.deleteRecord=current.id;actions.append(remove);details.append(actions);}
      return details;
    }
    const item=sourceItem(record.itemId),details=h('details','draft-record'),sum=h('summary'),top=h('div','spread');
    const value=W.validateProgress(item,record.fields,record.config,record.previous),progress=record.fields.noProgress?'No progress':(record.previous.percent ?? '—')+'% → '+(value.reportedPercent ?? '—')+'%';
    top.append(h('strong','',item.ecsCode),h('span','review-progress',progress));
    if(record.photos.length){const flag=icon('camera');flag.setAttribute('aria-hidden','false');flag.setAttribute('role','img');flag.setAttribute('aria-label','Photo attached');top.append(flag);}
    top.append(icon('chevron'));sum.append(top);details.append(sum);
    const status=history?'Export snapshot':W.exported(session,record)?'Exported':W.approvalFor(session,record)?'Reviewed':'Awaiting review';details.append(pill(status,status === 'Awaiting review'?'':'good'),h('p','subtle','Revision '+record.revision));
    const kv=h('dl','kv');
    const values=[['Building / room',item.roomLabel],['Commodity',item.commodity],['Work origin',item.origin],['Work date',record.date],['Gate',record.fields.noProgress?record.previous.gate:record.fields.gate],['Previous percent',record.previous.percent ?? '—'],['New percent',record.fields.noProgress?'Unchanged':W.validateProgress(item,record.fields,record.config,record.previous).reportedPercent ?? '—']];
    const definitions=R.fieldsFor(item,record.config);
    Object.entries(record.fields).filter(([name,value])=>!['gate','percent'].includes(name) && R.meaningful(value)).forEach(([name,value])=>values.push([definitions.find(def=>def.id === name)?.label || ({comments:'Comments',noProgress:'No Progress'}[name]) || name,String(value)]));
    values.push(['Recorded by',record.operator.name],['Saved',time(record.savedAt)],['Photos',record.photos.length]);
    values.forEach(([label,value])=>kv.append(h('dt','',label),h('dd','',value ?? '')));details.append(kv);
    if(record.photos.length)details.append(photoGrid(record.photos));
    const approvals=session.approvals.filter(approval=>approval.records.some(value=>value.id === record.id));
    approvals.forEach(approval=>{
      const label=(approval.invalidatedAt?'Previous review by ':'Reviewed by ')+approval.name+' · '+time(approval.signedAt)+' · revision '+approval.records.find(value=>value.id === record.id).revision+(approval.invalidatedAt?' · review required again':'');
      details.append(h('p','subtle',label));
    });
    const current=W.recordFor(session,record.date,item.id);
    if(current){const actions=h('div','row');actions.append(button(history?'Edit current entry':'Edit record',()=>editRecord(current),'link-button'));const remove=button('Delete daily entry',()=>confirmDelete({recordId:current.id}),'link-button danger');remove.dataset.deleteRecord=current.id;actions.append(remove);details.append(actions);}
    else if(history)details.append(h('p','subtle','Removed from current work. Undo is available in Deleted entries.'));
    return details;
  }
  function renderDraft(){
    resetContent();heading('Draft & history','DAILY WORK','Today opens first. Earlier days and exported snapshots stay available.');
    const days=[...new Set([today,...session.records.map(record=>record.date),...(session.checkins || []).map(record=>record.date),...(session.deletedEntries || []).filter(entry=>!entry.restoredAt).map(entry=>entry.date),...Object.values(session.editors).map(editor=>editor.date),...session.exports.map(entry=>entry.date).filter(Boolean)])].sort().reverse();
    days.forEach(day=>{
      const batch=h('details','batch');batch.open=day === today;
      const editors=Object.values(session.editors).filter(editor=>editor.date === day && W.editorDirty(session,editor)),editingIds=new Set(editors.map(editor=>editor.itemId));
      const pending=W.pending(session,day).filter(record=>!editingIds.has(record.itemId));
      const checkins=W.pendingCheckins(session,day);
      const sum=h('summary');sum.append(h('span','',(day === today?'Today · ':'')+dayLabel(day)),pill((pending.length+editors.length+checkins.length)+' in draft'));batch.append(sum);
      checkins.forEach(record=>batch.append(recordDetails(record)));
      const rooms=[...new Set(pending.map(record=>sourceItem(record.itemId).roomLabel))].sort();
      rooms.forEach(room=>{batch.append(h('h3','',room));pending.filter(record=>sourceItem(record.itemId).roomLabel === room).forEach(record=>{batch.append(recordDetails(record));const v=W.validateRecord(session,model,record);if(!v.ready)batch.append(validationBox(v.errors));});});
      editors.forEach(editor=>{
        const item=sourceItem(editor.itemId);batch.append(h('p','subtle',item.roomLabel+' · '+item.ecsCode+' · unfinished edits'));
        batch.append(button('Continue unfinished record',async()=>{session.ui.screen='rooms';session.ui.room=item.roomLabel;session.ui.expanded=item.id;session.ui.editDate=editor.date;await persist();render();},'button'));
        batch.append(button('Discard entry',()=>confirmDelete({itemId:item.id,day:editor.date}),'link-button danger'));
      });
      const unreviewed=pending.filter(record=>!W.approvalFor(session,record));
      if(unreviewed.length){const review=button('Review & sign off',()=>reviewDay(day),'button primary block');review.disabled=editors.length>0 || unreviewed.some(record=>!W.validateRecord(session,model,record).ready);batch.append(review);}
      else if(pending.length)batch.append(pill('Supervisor approval saved','good'));
      else if(!editors.length && !checkins.length)batch.append(h('p','subtle','No unexported draft records for this day.'));
      const history=session.exports.filter(entry=>entry.kind === 'daily' && entry.date === day);
      if(history.length){
        const group=h('details','batch'),title=h('summary','', 'Exported history · '+history.length+' package'+(history.length === 1?'':'s'));group.append(title);
        history.forEach(entry=>{
          const box=h('div','history-entry');box.append(h('strong','',time(entry.createdAt)+' · '+entry.records.length+' records'),h('p','subtle',entry.status === 'download-started'?'Download initiated':'Prepared export · download may need retry'));
          entry.records.forEach(value=>box.append(recordDetails(value.payload.record,{history:true})));
          box.append(button('Download package again',()=>prepareRepeat(entry.id),'button block','down'));group.append(box);
        });batch.append(group);
      }
      deletedEntries(batch,day);content.append(batch);
    });
  }
  function reviewDay(day){
    const records=W.pending(session,day).filter(record=>!W.approvalFor(session,record));W.assert(records.length,'No records need review.');
    records.forEach(record=>W.assert(W.validateRecord(session,model,record).ready,'Resolve the draft requirements first.'));
    const body=dialog('Review & sign off');body.append(h('p','subtle',dayLabel(day)+' · '+records.length+' records'));
    const rooms=[...new Set(records.map(record=>sourceItem(record.itemId).roomLabel))];
    rooms.forEach(room=>{body.append(h('h3','',roomName(room)));records.filter(record=>sourceItem(record.itemId).roomLabel === room).forEach(record=>body.append(recordDetails(record,{history:true})));});
    const name=input('text','','Supervisor full name'),consent=input('checkbox'),label=h('label','check');label.append(consent,h('span','','I reviewed these records and their attached evidence.'));
    const sign=button('Sign reviewed records',async()=>{W.sign(session,model,records,name.value);await persist();closeDialog();renderDraft();notice('Reviewed version saved with supervisor name and time.');scheduleCheckpoint();},'button primary block');sign.id='sign-off';sign.disabled=true;
    const enable=()=>{sign.disabled=name.value.trim().length < 2 || !consent.checked;};name.oninput=enable;consent.onchange=enable;
    body.append(field('Supervisor name',name),label,sign,h('p','subtle','Later edits require renewed approval. Previous approvals remain in history.'));
  }
  function renderExport(){
    resetContent();heading('Daily export','TAKE YOUR WORK BACK','CSV and recovery data, with photos in a separate companion ZIP.');
    const days=[...new Set([today,...session.records.map(record=>record.date),...(session.checkins || []).map(record=>record.date),...session.exports.map(entry=>entry.date).filter(Boolean)])].sort().reverse(),daySelect=select(days.map(day=>({value:day,label:dayLabel(day)})),days.includes(session.ui.exportDay)?session.ui.exportDay:today),body=h('div');
    daySelect.id='export-day';content.append(field('Work day',daySelect),body);
    const update=()=>{
      body.replaceChildren();const day=daySelect.value,records=[...W.pending(session,day),...W.pendingCheckins(session,day)],exported=[...session.records,...(session.checkins || [])].filter(record=>record.date === day && W.exported(session,record));
      body.append(h('p','',records.length+' records awaiting export · '+exported.length+' already exported'));
      const errors=records.flatMap(record=>W.isCheckin(record)?[]:W.validateRecord(session,model,record).errors);
      if(errors.length)body.append(validationBox([...new Set(errors)]));
      const approved=records.length>0 && records.every(record=>W.isCheckin(record) || W.approvalFor(session,record));
      if(records.length)body.append(pill(approved?(records.every(W.isCheckin)?'Supervisor names recorded':'Supervisor approval saved'):'Supervisor review needed',approved?'good':''));
      else body.append(h('p','green-text',exported.length?'All saved records for this day have a prepared download below.':'No saved records for this day.'));
      const list=h('div','export-list');
      [['export','Daily progress CSV','Only this day’s new or changed records; includes all entered daily-log fields.'],['down','Recovery data + companion photos','Week, drafts, history and approvals. Keep both ZIPs to restore all photos, including earlier work and interrupted captures.']].forEach(([symbol,title,desc])=>{const row=h('div'),text=h('div');text.append(h('strong','',title),h('p','subtle',desc));row.append(icon(symbol),text);list.append(row);});if(records.length)body.append(list);
      const exp=button('Download daily package',async()=>{
        await flush();W.assert(!Object.values(session.editors).some(editor=>editor.date === day && W.editorDirty(session,editor)),'Finish the saved editor changes before exporting this day.');
        saving('Preparing export…');const result=await F.dailyZip(session,model,records,photos,pendingPhotos);
        await offerDailyDownload(result);
      },'button primary block','down');exp.id='daily-export';exp.disabled=!approved || !!errors.length;if(records.length)body.append(exp);
      if(records.length && !approved && !errors.length)body.append(button('Review & sign first',()=>reviewDay(day),'link-button'));
      if(records.length)body.append(h('p','subtle','The data ZIP has no image bytes. A companion photo ZIP is prepared whenever recovery needs photos.'));
      const history=session.exports.filter(entry=>entry.kind === 'daily' && entry.date === day).slice().reverse();
      if(history.length){body.append(h('h2','','Previous downloads'));history.forEach(entry=>{
        const box=h('div','history-entry');box.dataset.exportId=entry.id;box.append(h('strong','',time(entry.createdAt)+' · '+entry.records.length+' records'),h('p','subtle',entry.status === 'download-started'?'Download started · available again':'Prepared · ready to retry'));
        box.append(button('Download package again',()=>prepareRepeat(entry.id),'button block','down'));body.append(box);
      });}
    };
    daySelect.onchange=()=>{session.ui.exportDay=daySelect.value;persist().catch(showError);update();};update();
  }
  async function prepareRepeat(id){await flush();saving('Preparing download…');await offerDailyDownload(await F.repeatDailyZip(session,model,id,photos,pendingPhotos));}
  async function offerDailyDownload(result){
    session=result.future;await persist();render();
    const buildingCount=result.log.records.filter(row=>W.isCheckin(row.payload.record)).length,ecsCount=result.log.records.length-buildingCount;
    const body=dialog('Your daily package is ready');body.append(h('p','subtle',dayLabel(result.log.date)+' · '+ecsCount+' ECS item'+(ecsCount === 1?'':'s')+(buildingCount?' · '+buildingCount+' building check-in'+(buildingCount === 1?'':'s'):'')));
    preparedDownloadURL=URL.createObjectURL(result.blob);
    const save=h('a','button primary block export-download','Save Data');save.href=preparedDownloadURL;save.download='daily_progress_'+result.log.date+'_'+result.log.id+'.zip';save.id='save-daily-file';
    let photoSave=null;
    if(result.photoBlob){preparedPhotoURL=URL.createObjectURL(result.photoBlob);photoSave=h('a','button primary block export-download','Save Photos');photoSave.id='save-companion-photos';photoSave.href=preparedPhotoURL;photoSave.download='daily_photos_'+result.log.date+'_'+result.log.id+'.zip';photoSave.addEventListener('click',()=>{const entry=session.exports.find(value=>value.id === result.log.id);entry.photoDownloadStartedAt=new Date().toISOString();persist().catch(showError);});}
    // This native link is tapped after ZIP preparation, retaining Safari's download gesture.
    save.addEventListener('click',()=>{
      const entry=session.exports.find(value=>value.id === result.log.id);entry.status='download-started';entry.lastDownloadAt=new Date().toISOString();entry.downloadCount=(entry.downloadCount || 0)+1;
      entry.pairId=result.pair.id;entry.lastRecoveryHash=result.pair.recoverySha256;
      persist().then(()=>{render();scheduleCheckpoint();}).catch(showError);
      notice('Download started. The same package remains available in Previous downloads.');
    });
    body.append(save);if(photoSave)body.append(photoSave);
    body.append(h('p','subtle',photoSave?'Save Data includes the CSV and data backup. Save both files for complete recovery.':'Save Data includes the CSV and data backup.'));
  }
  function renderPhotos(){
    resetContent();heading('Photos','EVIDENCE',model.reportingWeek+' · Building / capture date folders');
    const hidden=W.hiddenPhotoIds(session),available=photos.filter(photo=>!hidden.has(photo.id));
    const dates=[...new Set(available.map(photo=>photo.captureDate))].sort().reverse(),choices=[{value:'all',label:'Whole week'},...dates.map(day=>({value:day,label:dayLabel(day)}))];
    const picker=select(choices,dates.includes(today)?today:'all'),body=h('div');content.append(field('Captured day',picker),body);
    const update=()=>{
      body.replaceChildren();const selected=available.filter(photo=>picker.value === 'all' || photo.captureDate === picker.value);
      body.append(h('p','subtle',selected.length+' saved photos'));
      body.append(photoGrid(selected.map(photo=>photo.id)));
      const exp=button('Download photo ZIP',async()=>{await flush();const blob=await F.photoZip(selected);download(blob,'progress_photos_'+picker.value+'_'+W.uid()+'.zip');notice('Photo ZIP download initiated. New photos use Building / capture date folders.');},'button primary block','down');exp.disabled=!selected.length;body.append(exp);
      if(pendingPhotos.length)body.append(button('Resume interrupted photo',()=>resumePhoto(pendingPhotos[0]),'button block'));
    };
    picker.onchange=update;update();
  }
  function viewPhoto(photo){const body=dialog(photo.ecsCode+' · '+photo.room),fields=photo.context.editor?.fields || photo.context.fields || {},previous=photo.context.editor?.previous || {},gate=fields.noProgress?previous.gate:fields.gate,percent=fields.noProgress?previous.percent:fields.percent;body.append(image(photo,'preview-photo'),h('p','subtle',photo.building+' · '+time(photo.capturedAt)+' · work date '+photo.workDate),h('p','subtle','Capture: '+(gate || 'Gate not recorded')+' · '+(percent ?? '—')+'%'+(fields.noProgress?' · No Progress':'')));body.append(button('Download photo',()=>download(photo.blob,W.photoPath(photo).split('/').pop()),'button block','down'));}
  function startCamera(item,editor){
    W.setEditor(session,editor);session.pendingCapture={itemId:item.id,workDate:editor.date,startedAt:new Date().toISOString(),editor:W.copy(editor),building:item.building,room:item.room,ecsCode:item.ecsCode};
    // persist() writes the recovery journal synchronously. The native input then opens
    // its picker in the original touch/click event, without awaiting IndexedDB first.
    return persist();
  }
  function bindCamera(item,editor){
    const native=cameraInput;native.hidden=false;native.className='native-camera-input';native.dataset.camera='true';native.setAttribute('aria-label','Take photo for '+item.ecsCode);
    native.onclick=event=>{if(busy){event.preventDefault();notice('Finishing the current operation. Tap the camera again when ready.');return;}try{
      if(native.files?.length){event.preventDefault();return;}
      native.value='';startCamera(item,editor).catch(showError);captureFlight={input:native,context:W.copy(session.pendingCapture),sessionId:session.id};native.captureFlight=captureFlight;
    }catch(error){event.preventDefault();showError(error);}};
    native.onchange=event=>{const file=event.target.files[0],flight=native.captureFlight,context=flight?.context || W.copy(session?.pendingCapture);if(file){if(captureFlight===flight)captureFlight=null;native.captureFlight=null;run(()=>acceptCamera(file,context,flight?.sessionId)).finally(()=>{native.value='';});}};
    native.oncancel=()=>{const flight=native.captureFlight;if(!flight || flight!==captureFlight)return;captureFlight=null;native.captureFlight=null;native.value='';if(session?.id===flight.sessionId && session.pendingCapture?.startedAt===flight.context.startedAt && !pendingPhotos.length){session.pendingCapture=null;persist().catch(showError);}};
  }
  function renewIdleCamera(){
    if(captureFlight || cameraPending || cameraInput.files?.length)return;
    const replacement=cameraInput.cloneNode(false);replacement.value='';cameraInput.replaceWith(replacement);cameraInput=replacement;
    const editor=activeEditor(),item=editor && sourceItem(editor.itemId);if(item)bindCamera(item,editor);
  }
  async function acceptCamera(file,capturedContext=null,sessionId=session?.id){
    W.assert(file && file.type.startsWith('image/') && file.size>0 && file.size <= 25*1024*1024,'Choose an image up to 25 MB.');
    const context=capturedContext || session.pendingCapture;W.assert(context && session.id === sessionId,'The camera target changed. Keep this original file and reopen its ECS.');
    const raw=new Uint8Array(await file.arrayBuffer()),pending={id:W.uid('PH-'),itemId:context.itemId,workDate:context.workDate,
      building:context.building,room:context.room,ecsCode:context.ecsCode,capturedAt:new Date().toISOString(),captureDate:W.today(),
      context:W.copy(context),blob:file,type:file.type,size:file.size,sha256:await F.sha(raw),crc32:F.crc32(raw)};
    W.assert(session.id === sessionId,'The active week changed during capture.');
    await persist({pending});pendingPhotos.push(pending);await resumePhoto(pending);
  }
  async function resumePhoto(pending){
    cameraPending=pending;processedPhoto=null;
    const body=dialog('Photo stamp');cameraPending=pending;
    const drawEpoch=++photoDrawEpoch,sessionId=session.id;
    body.append(h('p','subtle',pending.ecsCode+' · '+pending.building+' · '+pending.room+' · '+pending.workDate));
    const canvas=h('canvas');canvas.setAttribute('aria-label','Photo with captured ECS context');body.append(canvas);
    const noteInput=input('text','','Optional photo note');body.append(field('Photo note',noteInput));
    const status=h('p','subtle','Preparing captured image…'),save=button('Save photo',async()=>{
      W.assert(processedPhoto && cameraPending,'Wait for the stamped image.');
      const stamped=processedPhoto;W.assert(drawEpoch === photoDrawEpoch && cameraPending?.id === pending.id && session.id === sessionId,'This photo editor has changed. Reopen the retained capture.');
      const photo=W.namePhoto({...pending,blob:stamped,type:'image/jpeg',size:stamped.size,sha256:await F.sha(stamped),crc32:F.crc32(await F.bytes(stamped)),note:noteInput.value,originalSha256:pending.sha256},photos);
      W.assert(drawEpoch === photoDrawEpoch && session.id === sessionId,'The capture context changed while saving.');
      const item=sourceItem(pending.itemId),editor=W.editorFor(session,model,item,pending.workDate);
      if(!editor.photos.includes(photo.id))editor.photos.push(photo.id);W.setEditor(session,editor);session.pendingCapture=null;
      await persist({photo,deletePending:pending.id});photos=photos.filter(value=>value.id !== photo.id).concat(photo);pendingPhotos=pendingPhotos.filter(value=>value.id !== pending.id);
      closeDialog();render();notice('Photo saved on this device. Save the ECS progress before review.');scheduleCheckpoint();
    },'button primary block');save.id='save-photo';save.disabled=true;body.append(status,save);
    try{
      const bitmap=await createImageBitmap(pending.blob),scale=Math.min(1,1800/Math.max(bitmap.width,bitmap.height));
      canvas.width=Math.max(320,Math.round(bitmap.width*scale));const pictureHeight=Math.round(bitmap.height*scale);canvas.height=pictureHeight+125;
      const context=canvas.getContext('2d');
      let drawVersion=0;
      const draw=async()=>{
        const version=++drawVersion;
        context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(bitmap,0,0,canvas.width,pictureHeight);
        context.fillStyle='#172c42';context.fillRect(0,pictureHeight,canvas.width,125);context.fillStyle='#fff';
        context.font='bold '+Math.max(14,Math.round(canvas.width/45))+'px sans-serif';
        const fields=pending.context.editor.fields,previous=pending.context.editor.previous;
        const gate=fields.noProgress?previous.gate:fields.gate,percent=fields.noProgress?previous.percent:fields.percent;
        [pending.building+' · '+pending.room+' · '+pending.ecsCode,pending.captureDate+' · '+(gate || 'Gate not recorded')+' · '+(percent ?? '—')+'%'+(fields.noProgress?' · No Progress':''),noteInput.value].forEach((line,index)=>context.fillText(line,14,pictureHeight+30+index*32,canvas.width-28));
        const result=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.82));if(version !== drawVersion || drawEpoch !== photoDrawEpoch || cameraPending?.id !== pending.id || session.id !== sessionId || !canvas.isConnected)return;processedPhoto=result;save.disabled=!processedPhoto;status.textContent='Captured context is preserved with the photo.';
      };
      noteInput.addEventListener('input',()=>{save.disabled=true;draw().catch(showError);});await draw();
    }catch(error){status.textContent='This image could not be decoded. Its original bytes are retained in recovery. '+error.message;}
  }
  async function recoveryMenu(){
    await flush();const body=dialog('Recovery backups'),snapshots=(await S.snapshots()).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
    body.append(h('p','subtle','Local snapshots survive app reset. External backups are needed after browser storage deletion.'));
    if(session)body.append(button('Download full recovery backup',async()=>{const data=await F.recoveryData(session,model,photos,pendingPhotos);download(await F.zip(data.entries),'progress_recovery_'+today+'_'+W.uid()+'.zip');},'button primary block','down'));
    body.append(button('Import recovery backup',()=>{$('recovery-input').value='';$('recovery-input').click();},'button block'),h('p','subtle','For daily backups, select the data ZIP and companion photo ZIP together. Older full backups need one file.'));
    snapshots.forEach(snapshot=>{
      const box=h('div','history-entry');box.append(h('strong','',time(snapshot.createdAt)),h('p','subtle',snapshot.reason+' · '+snapshot.session.records.length+' records · '+snapshot.photos.length+' photos'));
      box.append(button('Restore',async()=>{
        await S.verify(snapshot);if(session)await checkpoint('Before restoring recovery');const restoredModel=W.unpack(snapshot.package);
        session=await S.replace(snapshot.session,restoredModel,snapshot.photos,snapshot.pending);model=restoredModel;photos=snapshot.photos;pendingPhotos=snapshot.pending;committedVersion=0;queue=Promise.resolve();storageFailed=false;closeDialog();render();notice('Verified recovery restored.');
      },'button'));
      box.append(button('Download',async()=>{await S.verify(snapshot);const data=await F.recoveryData(snapshot.session,W.unpack(snapshot.package),snapshot.photos,snapshot.pending);download(await F.zip(data.entries),'progress_recovery_'+snapshot.id+'.zip');},'link-button'));body.append(box);
    });
    if(!snapshots.length)body.append(h('p','subtle','No local snapshots yet.'));
  }
  function settings(){
    const body=dialog('Week settings');
    body.append(h('p','subtle',model.reportingWeek+' · '+session.operator.name));
    body.append(button('Load another weekly package',()=>{closeDialog();$('package-input').click();},'button block'));
    body.append(button('Daily-log field requirements',fieldSettings,'button block'));
    if(workerRegistration?.waiting)body.append(button('Apply cached app update',async()=>{await saveOpen();await checkpoint('Before app update');workerRegistration.waiting.postMessage({type:'ACTIVATE_UPDATE'});},'button block'));
    body.append(button('Reset active week',async()=>{
      const confirm=dialog('Reset active week?');confirm.append(h('p','','Your week and all photo bytes will first be verified in recovery.'));
      confirm.append(button('Back up and reset',async()=>{await flush();await checkpoint('Before active reset');await S.clear();session=null;model=null;photos=[];pendingPhotos=[];stagedModel=null;queue=Promise.resolve();storageFailed=false;closeDialog();render();notice('Active week reset. Tap the bottom corner five times for recovery.');},'button danger block'));
    },'button danger block'));
    body.append(h('p','subtle','Version '+W.VERSION+' · '+R.gates.version));
  }
  function fieldSettings(){
    const cfg=W.copy(currentConfig()),body=dialog('Daily-log field requirements'),profile=select(Object.keys(cfg.families),'Mechanical'),container=h('div');
    body.append(field('Field family',profile),container);
    const draw=()=>{
      container.replaceChildren();
      cfg.families[profile.value].forEach(def=>{
        const row=h('div','history-entry'),label=input('text',def.label);label.oninput=()=>{def.label=label.value;};
        row.append(field('Field label · '+def.id,label),check('Show field',def.visible !== false,value=>{def.visible=value;}),check('Required',def.required,value=>{def.required=value;}));container.append(row);
      });
    };
    profile.onchange=draw;draw();
    body.append(button('Save requirements for new revisions',async()=>{cfg.version+=1;session.config=R.validateConfig(cfg);await persist();closeDialog();render();notice('New record revisions use the updated fields. Saved records retain their original requirements.');},'button primary block'));
  }
  async function verifyOffline(){
    if(!navigator.serviceWorker || !window.isSecureContext){$('offline-status').textContent='HTTPS or localhost required for offline use';return;}
    try{
      const scope=new URL('./',location.href).href,existing=await navigator.serviceWorker.getRegistration(scope);
      workerRegistration=existing?.scope === scope?existing:await navigator.serviceWorker.register('./sw.js',{scope:'./',updateViaCache:'none'});
      if(existing?.scope === scope && navigator.onLine)workerRegistration.update().catch(()=>{});
      await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Offline installation did not finish. Check connectivity, then retry offline setup.')),30000);navigator.serviceWorker.ready.then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});});
      const targetWorker=new URL('./sw.js',location.href).href;
      if(navigator.serviceWorker.controller?.scriptURL !== targetWorker)await new Promise(resolve=>{const timer=setTimeout(resolve,5000);navigator.serviceWorker.addEventListener('controllerchange',()=>{clearTimeout(timer);resolve();},{once:true});});
      const controller=navigator.serviceWorker.controller;W.assert(controller?.scriptURL === targetWorker,'Offline worker has not taken control. Reopen this page.');
      const result=await new Promise((resolve,reject)=>{
        const channel=new MessageChannel(),timer=setTimeout(()=>reject(new Error('Offline cache verification timed out.')),7000);
        channel.port1.onmessage=event=>{clearTimeout(timer);resolve(event.data);};
        controller.postMessage({type:'VERIFY_OFFLINE'},[channel.port2]);
      });
      W.assert(result.ready,'Offline files missing: '+(result.missing || []).join(', '));offlineReady=true;
      $('offline-status').textContent='Offline ready';document.querySelectorAll('[data-offline-required]').forEach(el=>el.disabled=false);
      let initialController=controller;
      navigator.serviceWorker.addEventListener('controllerchange',()=>{if(navigator.serviceWorker.controller !== initialController)location.reload();});
      workerRegistration.addEventListener('updatefound',()=>{const worker=workerRegistration.installing;worker?.addEventListener('statechange',()=>{if(worker.state === 'installed' && workerRegistration.waiting)notice('An app update is cached. Apply it from Week settings when ready.');});});
    }catch(error){$('offline-status').textContent='Offline copy not ready';showError(error);}
  }
  async function boot(){
    verifyOffline();
    try{
      const saved=await S.load();
      if(saved){session=saved.session;model=saved.model;committedVersion=session.storageVersion;photos=await S.photos();pendingPhotos=await S.pending();const savedIds=new Set(photos.map(photo=>photo.id)),pendingIds=new Set(pendingPhotos.map(photo=>photo.id));Object.values(session.editors).forEach(editor=>{editor.photos=editor.photos.filter(id=>savedIds.has(id) || !pendingIds.has(id));});W.validateSession(session,model,savedIds);await persist();}
      render();saving(session?'Saved on this device':'No week loaded');
    }catch(error){showError(error);content.replaceChildren(h('h1','','Saved work needs recovery'),button('Open recovery backups',recoveryMenu,'button primary block'));$('settings-button').hidden=true;}
  }
  $('package-input').addEventListener('change',event=>run(async()=>{
    const file=event.target.files[0];if(!file)return;stagedModel=null;
    try{stagedModel=await F.readWeekly(file);$('error-banner').hidden=true;closeDialog();renderLoad();}
    finally{event.target.value='';}
  }));
  $('recovery-input').addEventListener('change',event=>run(async()=>{const files=[...event.target.files];if(!files.length)return;const restored=await F.readRecoveryPair(files);if(session)await checkpoint('Before importing recovery');session=await S.replace(restored.session,restored.model,restored.photos,restored.pending);model=restored.model;photos=restored.photos;pendingPhotos=restored.pending;committedVersion=0;queue=Promise.resolve();storageFailed=false;captureFlight=null;closeDialog();render();notice('External recovery verified and restored.');}));
  $('settings-button').onclick=()=>run(settings);
  document.querySelectorAll('#bottom-menu button').forEach(el=>el.onclick=()=>run(()=>navigate(el.dataset.page)));
  let cornerCount=0,cornerTime=0;
  $('recovery-corner').onclick=()=>{const now=Date.now();cornerCount=now-cornerTime<4000?cornerCount+1:1;cornerTime=now;if(cornerCount>=5){cornerCount=0;run(recoveryMenu);}};
  content.addEventListener('scroll',()=>{if(session)session.ui.scroll=content.scrollTop;},{passive:true});
  let touch=null;
  content.addEventListener('touchstart',event=>{const point=event.touches[0];touch={x:point.clientX,y:point.clientY};},{passive:true});
  content.addEventListener('touchmove',event=>{
    if(!touch || event.touches.length !== 1 || event.target.closest('textarea,input,select,dialog'))return;
    const point=event.touches[0],dy=point.clientY-touch.y,dx=point.clientX-touch.x;
    if(Math.abs(dy)>Math.abs(dx) && ((content.scrollTop<=0 && dy>0) || (content.scrollTop+content.clientHeight>=content.scrollHeight-1 && dy<0)))event.preventDefault();
  },{passive:false});
  function onDayChange(){
    const next=W.today();if(next === today)return;today=next;$('day-label').textContent=today.slice(5).split('-').reverse().join('/');
    if(session?.ui.expanded)notice('A new work day has started. The open record stays on '+session.ui.editDate+'. Close it to start today’s work.');
    else if(session)render();
  }
  async function recoverForeground(){
    if(document.hidden)return;if(foregroundRecovery)return foregroundRecovery;
    foregroundRecovery=(async()=>{
      await S.recover();await flush();
      // Keep the rendered editor, work date, modal and scroll position. Never reset a returning picker.
      if(!busy){content.inert=false;modalBody.inert=false;renewIdleCamera();}
      onDayChange();
    })().finally(()=>{foregroundRecovery=null;});return foregroundRecovery;
  }
  const foreground=()=>recoverForeground().catch(showError);
  setInterval(onDayChange,30000);window.addEventListener('focus',foreground);window.addEventListener('pageshow',foreground);document.addEventListener('resume',foreground);
  document.addEventListener('visibilitychange',()=>{if(document.hidden && session){session.ui.scroll=content.scrollTop;S.journal(session);}else foreground();});
  window.addEventListener('pagehide',()=>{if(session){session.ui.scroll=content.scrollTop;session.journalGeneration+=1;S.journal(session);}});
  modal.addEventListener('cancel',()=>{photoDrawEpoch++;cameraPending=null;processedPhoto=null;releaseDownload();});
  window.ProgressApp={get session(){return session;},get model(){return model;},get photos(){return photos;},get offlineReady(){return offlineReady;},
    flush,persist,render,navigate,checkpoint,acceptCamera,saveOpen,onDayChange,recoverForeground,storage:S,
    loadExample:async(name='Example worker')=>{stagedModel=null;if(session)await checkpoint('Before example replacement');model=W.example();session=await S.replace(W.createSession(model,{name}),model);photos=[];pendingPhotos=[];committedVersion=0;queue=Promise.resolve();storageFailed=false;render();},
    activate:async(value,operator={name:'Recorder'})=>{if(session)await checkpoint('Before package replacement');model=value;session=await S.replace(W.createSession(model,operator),model);photos=[];pendingPhotos=[];committedVersion=0;queue=Promise.resolve();storageFailed=false;render();}};
  boot();
})();
