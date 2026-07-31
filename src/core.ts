import {createHash,randomUUID} from 'node:crypto';import {existsSync,lstatSync,mkdirSync,readFileSync,realpathSync,statSync,writeFileSync} from 'node:fs';import {dirname,isAbsolute,join,resolve,sep} from 'node:path';
export const uid=()=>randomUUID();
export const rawHash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
export function safePath(root:string,path:string){if(isAbsolute(path)||path.replaceAll('\\','/').split('/').includes('..'))throw new Error(`unsafe repository path: ${path}`);const full=resolve(root,path);if(!full.startsWith(resolve(root)+sep))throw new Error(`path outside workspace: ${path}`);return full;}
function canonicalPath(path:string){const value=realpathSync.native(path);return process.platform==='win32'?value.toLowerCase():value;}
/** Resolve a repository file for reading without following a symlink/junction outside the repository. */
export function safeReadPath(root:string,path:string){const full=safePath(root,path);const repository=canonicalPath(root);const target=canonicalPath(full);if(!target.startsWith(`${repository}${sep}`)||!statSync(target).isFile())throw new Error(`repository read escapes workspace: ${path}`);return full;}
export const readJson=<T>(path:string):T=>JSON.parse(readFileSync(path,'utf8')) as T;
export function writeJson(path:string,value:unknown){mkdirSync(dirname(path),{recursive:true});writeFileSync(path,`${JSON.stringify(value,null,2)}\n`);}
function ensureMetadataDirectory(root:string,path:string){mkdirSync(path,{recursive:true});if(lstatSync(path).isSymbolicLink())throw new Error(`Lattice metadata directory cannot be a symlink or junction: ${path}`);const repository=canonicalPath(root);const directory=canonicalPath(path);if(directory!==repository&&!directory.startsWith(`${repository}${sep}`))throw new Error(`Lattice metadata directory escapes workspace: ${path}`);if(!statSync(path).isDirectory())throw new Error(`invalid Lattice metadata directory: ${path}`);}
export function metadata(root:string){const repository=realpathSync.native(resolve(root));const base=join(repository,'.lattice');ensureMetadataDirectory(repository,base);for(const dir of ['index','sessions','tasks','handoffs','edit-grants','worktrees','logs','benchmarks','cache','cache/verified-patches'])ensureMetadataDirectory(repository,join(base,dir));return base;}
export const exists=(path:string)=>existsSync(path);
