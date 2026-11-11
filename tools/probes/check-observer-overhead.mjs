import path from 'node:path'
import {pathToFileURL} from 'node:url'
import {readFile,writeFile} from 'node:fs/promises'
const [loaderRoot,port,bundle,output]=process.argv.slice(2)
const {listTargets,connectCdpSession}=await import(pathToFileURL(path.resolve(loaderRoot,'src/cdp.mjs')).href)
const targets=(await listTargets(Number(port))).filter(t=>t.type==='page')
if(targets.length!==1||targets[0].url!=='about:blank')throw Error('isolated-target-required')
const session=await connectCdpSession(targets[0].webSocketDebuggerUrl,{timeoutMs:15000})
try{
 await session.sendCommand('Emulation.setDeviceMetricsOverride',{width:1000,height:800,deviceScaleFactor:1,mobile:false})
 const code=await readFile(bundle,'utf8')
 const result=await session.sendCommand('Runtime.evaluate',{expression:`(async()=>{const module={exports:{}};((module)=>{${code}\n})(module);return await module.exports.runObserverBenchmark(document)})()`,awaitPromise:true,returnByValue:true})
 if(result.exceptionDetails)throw Error('evaluation')
 const value=result.result?.value
 if(output)await writeFile(output,JSON.stringify(value,null,2))
 console.log(JSON.stringify(value))
 if(value?.scans!==0||value?.snapshot?.runtime?.ui?.slots!==2)process.exitCode=1
}finally{await session.sendCommand('Emulation.clearDeviceMetricsOverride').catch(()=>{});await session.close()}
