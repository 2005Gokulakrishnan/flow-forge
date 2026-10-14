const axios = require('axios');
const prisma = require('./db');
const { appendRow } = require('./google');

function getPath(obj, path) { return path.split('.').reduce((v,k)=>v == null ? undefined : v[k], obj); }
function resolve(value, context) {
  if (typeof value === 'string') return value.replace(/\{\{\s*([\w.$-]+)\s*\}\}/g, (_,p)=> { const v=getPath(context,p); return v == null ? '' : (typeof v==='object'?JSON.stringify(v):String(v)); });
  if (Array.isArray(value)) return value.map(v=>resolve(v,context));
  if (value && typeof value==='object') return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,resolve(v,context)]));
  return value;
}
function compare(actual, op, expected) {
  const a=String(actual ?? ''), b=String(expected ?? '');
  switch(op) { case 'equals': return a===b; case 'notEquals': return a!==b; case 'contains': return a.includes(b); case 'notContains': return !a.includes(b); case 'isEmpty': return actual==null || actual===''; case 'greaterThan': return Number(actual)>Number(expected); case 'lessThan': return Number(actual)<Number(expected); default: throw new Error(`Unsupported filter operator: ${op}`); }
}
function outgoing(edges, id) { return edges.filter(e=>e.source===id); }
async function executeWorkflow({workflow, userId, input}) {
  const def=workflow.definition || {}; const nodes=def.nodes || []; const edges=def.edges || [];
  const byId=new Map(nodes.map(n=>[n.id,n]));
  const trigger=nodes.find(n=>['webhook','trigger','webhookTrigger'].includes(n.type) || ['webhook','trigger'].includes(n.data?.type));
  if (!trigger) throw new Error('Workflow needs a Webhook trigger node.');
  const execution=await prisma.execution.create({data:{userId,workflowId:workflow.id,status:'running',input}});
  const context={trigger:input, previous:input, steps:{}}; const queue=[trigger.id]; const visited=new Set(); let finalOutput=input;
  try {
    while(queue.length) {
      const id=queue.shift(); if(visited.has(id)) continue; visited.add(id);
      const node=byId.get(id); if(!node) continue;
      const type=node.type || node.data?.type; const cfg=node.data?.config || node.config || {};
      if (['webhook','trigger','webhookTrigger'].includes(type)) { for(const e of outgoing(edges,id)) queue.push(e.target); continue; }
      const step=await prisma.executionStep.create({data:{executionId:execution.id,nodeId:id,nodeType:type||'unknown',status:'running',input:context.previous && typeof context.previous==='object'?context.previous:{value:String(context.previous)}}});
      try {
        let output;
        if (type==='filter') {
          const field=cfg.field || 'city'; const actual=getPath(context, field.startsWith('trigger.')||field.startsWith('steps.')?field:`trigger.${field}`);
          output={passed:compare(actual,cfg.operator||'equals',resolve(cfg.value,context)), actual};
        } else if (type==='googleSheets' || type==='google-sheets' || type==='sheets') {
          const mapping=cfg.mapping || [];
          const values=Array.isArray(mapping) ? mapping.map(m=>resolve(m.value,context)) : Object.entries(mapping).sort(([a],[b])=>a.localeCompare(b)).map(([,v])=>resolve(v,context));
          output=await appendRow(userId,{spreadsheetId:cfg.spreadsheetId,range:cfg.range||'Sheet1!A:Z',values,valueInputOption:cfg.valueInputOption||'USER_ENTERED'});
        } else if (type==='http' || type==='httpRequest') {
          const url=resolve(cfg.url,context); if(!/^https:\/\//.test(url) && process.env.NODE_ENV==='production') throw new Error('Production HTTP modules must use HTTPS.');
          const response=await axios({url,method:(cfg.method||'GET').toUpperCase(),headers:resolve(cfg.headers||{},context),data:resolve(cfg.body,context),timeout:15000,validateStatus:s=>s>=200&&s<500});
          output={status:response.status,data:response.data}; if(response.status>=400) throw new Error(`HTTP request returned ${response.status}`);
        } else if (type==='formatter' || type==='setVariable') { output=resolve(cfg.output||cfg.value||{},context); }
        else if (type==='delay') { const ms=Math.min(Math.max(Number(cfg.milliseconds||0),0),30000); await new Promise(r=>setTimeout(r,ms)); output={delayedMs:ms}; }
        else if (type==='router') { output={routed:true}; }
        else throw new Error(`Unknown or unsupported module type: ${type}`);
        context.steps[id]=output; context.previous=output; finalOutput=output;
        await prisma.executionStep.update({where:{id:step.id},data:{status:'success',output:output && typeof output==='object'?output:{value:String(output)},finishedAt:new Date()}});
        for(const e of outgoing(edges,id)) {
          if(type==='filter') { const pass=!!output.passed; const h=e.sourceHandle || e.data?.condition; if(h==='true'&&!pass || h==='false'&&pass) continue; }
          queue.push(e.target);
        }
      } catch(err) {
        await prisma.executionStep.update({where:{id:step.id},data:{status:'failed',error:err.message,finishedAt:new Date()}}); throw err;
      }
    }
    await prisma.execution.update({where:{id:execution.id},data:{status:'success',output:finalOutput && typeof finalOutput==='object'?finalOutput:{value:String(finalOutput)},finishedAt:new Date()}});
    return {executionId:execution.id,status:'success',output:finalOutput};
  } catch(err) {
    await prisma.execution.update({where:{id:execution.id},data:{status:'failed',error:err.message,finishedAt:new Date()}});
    return {executionId:execution.id,status:'failed',error:err.message};
  }
}
module.exports={executeWorkflow};
