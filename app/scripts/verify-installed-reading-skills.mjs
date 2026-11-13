import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile),app=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),repo=path.dirname(app);
const targets=[['codex','C:/Users/carzy/.codex/skills/extension-logic-clone'],['dsh','C:/dev/sandbox/dsh/data/skills/extension-logic-clone']];
const results=await Promise.allSettled(targets.map(async([name,skill])=>{const validation=await run('python',['C:/Users/carzy/.codex/skills/.system/skill-creator/scripts/quick_validate.py',skill],{cwd:app,env:{...process.env,PYTHONUTF8:'1',PYTHONDONTWRITEBYTECODE:'1'},timeout:30000});const verification=await run('python',[path.join(app,'scripts/verify-reading-skill.py'),'--skill',skill,'--report',path.join(repo,'docs/技能更新/2026-11-14-v3',name+'-verification.json')],{cwd:app,env:{...process.env,PYTHONUTF8:'1',PYTHONDONTWRITEBYTECODE:'1'},timeout:45000});return {name,validation:validation.stdout.trim(),verification:JSON.parse(verification.stdout)};}));for(const result of results){if(result.status==='rejected'){console.error(String(result.reason));process.exitCode=1;}else console.log(JSON.stringify(result.value));}
