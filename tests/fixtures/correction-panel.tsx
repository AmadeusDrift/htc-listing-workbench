import '../../src/renderer/styles.css';
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ListingCorrectionPanel} from '../../src/renderer/ListingCorrectionPanel';
import type {AmazonDraft} from '../../src/shared/amazon-contracts';
function Harness(){const [draft,setDraft]=useState<AmazonDraft|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');Object.assign(window,{setCorrectionDraft:setDraft});return <>{error&&<p role="alert">{error}</p>}{draft&&<ListingCorrectionPanel draft={draft} onDraft={setDraft} busy={busy} run={async(_label,work)=>{setBusy(true);try{await work();setError('');}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}}/>}</>;}
createRoot(document.getElementById('root')!).render(<Harness/>);
