import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {dirname,resolve,extname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=dirname(fileURLToPath(import.meta.url)),port=Number(process.env.PORT || 8788);
const server=createServer(async(req,res)=>{
  try{
    let path=decodeURIComponent(new URL(req.url,'http://localhost').pathname);if(path.endsWith('/'))path+='index.html';
    const full=resolve(root,'.'+path);
    if(!full.startsWith(root+sep) || path.includes('/.')){res.writeHead(403).end();return;}
    const body=await readFile(full);
    res.setHeader('Content-Type',({'.html':'text/html;charset=utf-8','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json','.zip':'application/zip'})[extname(full)] || 'application/octet-stream');
    res.setHeader('Cache-Control','no-store');res.end(body);
  }catch{res.writeHead(404).end('Not found');}
});
server.listen(port,'127.0.0.1',()=>console.log('Installation Progress local preview: http://127.0.0.1:'+port+'/'));
