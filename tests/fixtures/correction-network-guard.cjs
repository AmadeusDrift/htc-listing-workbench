// Node test-host only: block every outbound transport before test modules load.
const {installNetworkGuard}=require('../../scripts/release-network-guard.cjs');
const state=installNetworkGuard({net:{},shell:{},app:{on(){},whenReady:()=>Promise.resolve()},session:{defaultSession:{webRequest:{onBeforeRequest(){}}}}});
process.on('exit',()=>{if(state.attempts.length){console.error('Unexpected correction test network attempts',state.attempts);process.exitCode=1;}});
