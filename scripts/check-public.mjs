import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const skip=new Set(['.git','node_modules','verification','.kepler-annotate','profiles','test-results','playwright-report','__pycache__']);
const rules=[['personal home',/\/(?:Users|home)\/[A-Za-z0-9_.-]+\//],['private network hostname',/\b[a-z0-9.-]+\.(?:intra|internal)\.[a-z.]+\b/i],['private key',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],['access token',/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9]{24,})\b/]];
let count=0;const failures=[];
function scan(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const relative=path.relative(root,path.join(dir,entry.name));if(skip.has(entry.name)||entry.name.startsWith('HANDOFF')||entry.name.startsWith('.env'))continue;if(entry.isDirectory()){scan(path.join(dir,entry.name));continue;}if(/native-host-config\.json|^native-host-launcher/.test(entry.name)){failures.push(relative+': local config');continue;}if(!/\.(?:[cm]?js|py|json|md|yml|yaml|html|css|txt|LICENSE)$/.test(entry.name)&&entry.name!=='LICENSE')continue;const text=fs.readFileSync(path.join(dir,entry.name),'utf8');count++;for(const [name,re]of rules){if(re.test(text))failures.push(relative+': '+name);}}}
scan(root);if(failures.length){console.error(failures.join('\n'));process.exitCode=1;}else console.log(`Public content check passed (${count} text files).`);
