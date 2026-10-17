/* Separate active and recovery databases. Nothing here touches inspection storage. */
(function(root){
  'use strict';
  const W=root.WeeklyCore,F=root.WeeklyFiles;
  const DB='installation-progress-active-v1',RECOVERY='installation-progress-recovery-v1',JOURNAL='installation-progress-journal-v1';
  const open=(name,stores)=>new Promise((resolve,reject)=>{
    const request=indexedDB.open(name,1);
    request.onupgradeneeded=()=>stores.forEach(store=>request.result.createObjectStore(store,{keyPath:'id'}));
    request.onsuccess=()=>{request.result.onversionchange=()=>request.result.close();resolve(request.result);};
    request.onerror=()=>reject(request.error);request.onblocked=()=>reject(new Error('Another window is blocking progress storage. Close it and reopen this page.'));
  });
  let activePromise,recoveryPromise;
  let retentionQueue=Promise.resolve();
  function retain(action){
    if(root.navigator?.locks)return root.navigator.locks.request(DB+'-retention',action);
    const result=retentionQueue.then(action);retentionQueue=result.catch(()=>{});return result;
  }
  const active=()=>activePromise ||= open(DB,['sessions','packages','photos','pending']);
  const recovery=()=>recoveryPromise ||= open(RECOVERY,['snapshots']);
  async function transaction(stores,mode,action,other=false){
    const db=await(other?recovery():active());
    return new Promise((resolve,reject)=>{
      const tx=db.transaction(stores,mode),objects=Object.fromEntries(stores.map(name=>[name,tx.objectStore(name)]));
      let result;
      try{result=action(objects,tx);}catch(error){tx.abort();reject(error);return;}
      tx.oncomplete=()=>resolve(typeof result === 'function'?result():result);
      tx.onabort=tx.onerror=()=>reject(tx.error || new Error('Progress storage could not be committed.'));
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
  async function save(session,{photo=null,deletePending=null,pending=null}={}){
    const expected=session.storageVersion,next=W.copy(session);next.storageVersion=expected+1;
    await transaction(['sessions','photos','pending'],'readwrite',(stores,tx)=>{
      const request=stores.sessions.get('active');
      request.onsuccess=()=>{
        if(!request.result || request.result.value.id !== next.id || request.result.value.storageVersion !== expected){tx.abort();return;}
        stores.sessions.put({id:'active',value:next});
        if(photo)stores.photos.put(photo);
        if(pending)stores.pending.put(pending);
        if(deletePending)stores.pending.delete(deletePending);
      };
    });
    return next;
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
  root.WeeklyStorage={DB,RECOVERY,JOURNAL,load:()=>retain(load),journal,save,replace:(...args)=>retain(()=>replace(...args)),archive:(...args)=>retain(()=>archive(...args)),verify,clear:()=>retain(clear),photos:()=>readAll('photos'),pending:()=>readAll('pending'),snapshots:()=>readAll('snapshots',true)};
})(globalThis);
