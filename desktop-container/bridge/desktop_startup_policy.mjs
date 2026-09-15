export function startupDecision({target,selected,draft,busy,attempted}){
 if(attempted)return 'reconcile';
 if(selected!==target||busy)return 'wait';
 if(draft.trim())return 'blocked-draft';
 return 'send';
}
