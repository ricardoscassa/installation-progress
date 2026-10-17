import {copyFile,mkdir,readFile,rm} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const root=dirname(fileURLToPath(import.meta.url)),destination=resolve(root,'dist');
const {runtime}=JSON.parse(await readFile(resolve(root,'public-files.json'),'utf8'));
const {VERSION}=createRequire(import.meta.url)('./shared/weekly-core.js');
const assets=[...runtime,'downloads.html'],archive='Installation-Progress-v'+VERSION+'.zip';
await Promise.all([...assets,'artifacts/'+archive,'artifacts/build-manifest.json'].map(file=>readFile(resolve(root,file))));
await rm(destination,{recursive:true,force:true});
for(const file of assets){const target=resolve(destination,file);await mkdir(dirname(target),{recursive:true});await copyFile(resolve(root,file),target);}
for(const file of [archive,'build-manifest.json']){const target=resolve(destination,'downloads',file);await mkdir(dirname(target),{recursive:true});await copyFile(resolve(root,'artifacts',file),target);}
console.log(JSON.stringify({staticDirectory:destination,assets:assets.length,downloads:1}));
