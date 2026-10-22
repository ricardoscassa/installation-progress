/* Separate active and recovery databases. Nothing here touches inspection storage. */
(function(root){
  'use strict';
  const W=root.WeeklyCore,F=root.WeeklyFiles;
  const DB='installation-progress-active-v1',RECOVERY='installation-progress-recovery-v1',JOURNAL='installation-progress-journal-v1';
  const open=(name,stores)=>new Promise((resolve,reject)=>{
    const request=indexedDB.open(name,1);
    request.onupgradeneeded=()=>stores.forEach(store=>request.result.createObjectStore(store,{keyPath:'id'}));
    request.onsuccess=()=>{const db=request.result,forget=()=>{if(name===DB)activePromise=null;else recoveryPromise=null;};db.onclose=forget;db.onversionchange=()=>{forget();db.close();};resolve(db);};
    request.onerror=()=>reject(request.error);request.onblocked=()=>reject(new Error('Another window is blocking progress storage. Close it and reopen this page.'));
  });
  let activePromise,recoveryPromise;
  const transactions=new Set();
  let retentionQueue=Promise.resolve();
  function retain(action){
    if(root.navigator?.locks)return root.navigator.locks.request(DB+'-retention',action);
    const result=retentionQueue.then(action);retentionQueue=result.catch(()=>{});return result;
  }
  const active=()=>activePromise ||= open(DB,['sessions','packages','photos','pending']).catch(error=>{activePromise=null;throw error;});
  const recovery=()=>recoveryPromise ||= open(RECOVERY,['snapshots']).catch(error=>{recoveryPromise=null;throw error;});
  async function transaction(stores,mode,action,other=false){
    let db=await(other?recovery():active()),tx;
    try{tx=db.transaction(stores,mode);}catch(error){
      if(error.name !== 'InvalidStateError')throw error;
      // No transaction began, so reconnecting here cannot repeat a committed write.
      if(other)recoveryPromise=null;else activePromise=null;
      db=await(other?recovery():active());tx=db.transaction(stores,mode);
    }
    return new Promise((resolve,reject)=>{
      const state={tx,startedAt:Date.now()},objects=Object.fromEntries(stores.map(name=>[name,tx.objectStore(name)]));transactions.add(state);
      let result;
      tx.oncomplete=()=>{transactions.delete(state);resolve(typeof result === 'function'?result():result);};
      tx.onabort=()=>{transactions.delete(state);reject(state.error || tx.error || new DOMException('Progress storage could not be committed.','AbortError'));};
      try{result=action(objects,tx);}catch(error){state.error=error;try{tx.abort();}catch{}transactions.delete(state);reject(error);}
    });
  }
  const readAll=(store,other=false)=>transaction([store],'readonly',objects=>{
    const request=objects[store].getAll();return()=>request.result;
  },other);
  async function load(){
    const sessions=await readAll('sessions'),saved=sessions.find(row=>row.id === 'active');
    const cleanup=sessions.find(row=>row.id === 'retention');if(cleanup)await finishReplacement(cleanup.sessionId);
    if(!saved)return null;
    const packages=await readAll('packages'),pack=packages.find(row=>row.id === saved.value.packageId);
    W.assert(pack,'The saved weekly reference package is missing. Use recovery.');
    let session=saved.value;
    try{
      const raw=localStorage.getItem(JOURNAL),journal=raw?JSON.parse(raw):null;
      if(journal?.kind === 'editors' && journal.sessionId === session.id && journal.packageId === session.packageId && journal.generation > session.journalGeneration){
        session={...session,editors:journal.editors,ui:journal.ui,journalGeneration:journal.generation};
        W.validateSession(session,W.unpack(pack.value));
      }else if(journal?.session?.id === session.id && journal.session.packageId === session.packageId && journal.session.journalGeneration > session.journalGeneration){
        const restored=journal.session;restored.storageVersion=session.storageVersion;
        W.validateSession(restored,W.unpack(pack.value));
        session=restored;
      }
    }catch(error){throw new Error('A recovery journal needs attention: '+error.message);}
    return {session,model:W.unpack(pack.value)};
  }
  function journal(session,editorsOnly=false){
    try{const token=W.uid('JR-'),value=editorsOnly?{schema:1,kind:'editors',token,sessionId:session.id,packageId:session.packageId,generation:session.journalGeneration,editors:session.editors,ui:session.ui}:{schema:1,token,session};localStorage.setItem(JOURNAL,JSON.stringify(value));return token;}catch{return false;}
  }
  async function save(session,{photo=null,photos=[],deletePending=null,pending=null}={},attempt=0){
    const images=photo?[photo,...photos]:photos;
    W.assert(Array.isArray(images) && new Set(images.map(value=>value.id)).size === images.length,'Duplicate photo identities in one save.');
    const expected=session.storageVersion,next=W.copy(session);next.storageVersion=expected+1;
    try{await transaction(['sessions','photos','pending'],'readwrite',(stores,tx)=>{
      const request=stores.sessions.get('active');
      request.onsuccess=()=>{
        if(!request.result || request.result.value.id !== next.id || request.result.value.storageVersion !== expected){tx.abort();return;}
        stores.sessions.put({id:'active',value:next});
        images.forEach(image=>stores.photos.put(image));
        if(pending)stores.pending.put(pending);
        if(deletePending)stores.pending.delete(deletePending);
      };
    });}catch(error){
      // Suspension may lose a completion event. Inspect committed state before any retry.
      const current=(await readAll('sessions')).find(row=>row.id === 'active')?.value;
      if(current?.id === next.id && W.stable(current) === W.stable(next)){
        const storedPhotos=images.length?await readAll('photos'):[],storedPending=pending || deletePending?await readAll('pending'):[];
        W.assert(images.every(image=>storedPhotos.some(value=>value.id === image.id && value.sha256 === image.sha256 && value.blob?.size === image.size)),'Committed photo needs recovery.');
        W.assert(!pending || storedPending.some(value=>value.id === pending.id && value.sha256 === pending.sha256 && value.blob?.size === pending.size),'Pending original needs recovery.');
        W.assert(!deletePending || !storedPending.some(value=>value.id === deletePending),'Photo transaction needs recovery.');return next;
      }
      if(!attempt && current?.id === session.id && current.storageVersion === expected && ['AbortError','UnknownError','InvalidStateError'].includes(error.name))return save(session,{photo,photos,deletePending,pending},1);
      throw new Error(current?.id !== session.id || current.storageVersion !== expected?'Saved work changed in another window. Reopen this page before editing.':error.message);
    }
    return next;
  }
  async function recover(){
    for(const state of transactions)if(Date.now()-state.startedAt>30000)try{state.tx.abort();}catch{}
    // A real readonly transaction validates cached connections; transaction() reopens closed ones.
    await readAll('sessions');await readAll('snapshots',true);
    return {pendingTransactions:transactions.size};
  }
  async function finishReplacement(sessionId){
    const rows=await readAll('sessions'),activeSession=rows.find(row=>row.id === 'active'),marker=rows.find(row=>row.id === 'retention');
    if(!marker)return;
    W.assert(marker.sessionId === sessionId && activeSession?.value.id === sessionId,'Weekly replacement changed in another tab. Reopen this page.');
    await transaction(['snapshots'],'readwrite',stores=>stores.snapshots.clear(),true);
    await transaction(['sessions'],'readwrite',stores=>stores.sessions.delete('retention'));
  }
  async function replace(session,model,photos=[],pending=[],{purgeRecovery=false}={}){
    W.validateSession(session,model,new Set(photos.map(photo=>photo.id)));
    const next=W.copy(session);next.storageVersion=0;
    await transaction(['sessions','packages','photos','pending'],'readwrite',stores=>{
      Object.values(stores).forEach(store=>store.clear());
      stores.packages.put({id:model.sessionId,value:W.pack(model)});stores.sessions.put({id:'active',value:next});
      if(purgeRecovery)stores.sessions.put({id:'retention',sessionId:next.id});
      photos.forEach(photo=>stores.photos.put(photo));pending.forEach(photo=>stores.pending.put(photo));
    });
    localStorage.removeItem(JOURNAL);if(purgeRecovery)await finishReplacement(next.id);return next;
  }
  async function verify(snapshot){
    W.assert(snapshot?.manifest && snapshot.photos.length === snapshot.manifest.photoCount && snapshot.pending.length === snapshot.manifest.pendingCount,'Recovery counts do not match.');
    W.assert(await F.sha(W.stable({session:snapshot.session,package:snapshot.package})) === snapshot.manifest.sha256,'Recovery state verification failed.');
    for(const photo of [...snapshot.photos,...snapshot.pending]){
      W.assert(photo.blob instanceof Blob && photo.blob.size === photo.size && await F.sha(photo.blob) === photo.sha256,'Recovery photo verification failed.');
    }
    W.validateSession(snapshot.session,W.unpack(snapshot.package),new Set(snapshot.photos.map(photo=>photo.id)));return snapshot;
  }
  async function archive(session,model,reason){
    const rows=await readAll('sessions');
    W.assert(rows.find(row=>row.id === 'active')?.value.id === session.id && !rows.some(row=>row.id === 'retention'),'The active week changed. Reopen this page before saving recovery.');
    const photos=await readAll('photos'),pending=await readAll('pending'),pack=W.pack(model);
    const snapshot={id:'CURRENT',createdAt:new Date().toISOString(),reason,session:W.copy(session),package:pack,photos,pending,
      manifest:{photoCount:photos.length,pendingCount:pending.length,sha256:await F.sha(W.stable({session,package:pack}))}};
    await verify(snapshot);
    await transaction(['snapshots'],'readwrite',stores=>stores.snapshots.put(snapshot),true);
    const saved=(await readAll('snapshots',true)).find(row=>row.id === snapshot.id);
    await verify(saved);return saved;
  }
  async function clear(){
    await transaction(['sessions','packages','photos','pending'],'readwrite',stores=>Object.values(stores).forEach(store=>store.clear()));
    localStorage.removeItem(JOURNAL);
  }
  root.WeeklyStorage={DB,RECOVERY,JOURNAL,load:()=>retain(load),journal,save,recover,replace:(...args)=>retain(()=>replace(...args)),archive:(...args)=>retain(()=>archive(...args)),verify,clear:()=>retain(clear),photos:()=>readAll('photos'),pending:()=>readAll('pending'),snapshots:()=>readAll('snapshots',true)};
})(globalThis);
