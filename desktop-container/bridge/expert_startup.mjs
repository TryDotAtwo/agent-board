export async function initializeExpertThread({config,client,state,options,log}) {
  if(config.board&&state.threadId&&config.initialThreadId&&state.threadId!==config.initialThreadId){
    await log('Configured board chat differs from stored chat; explicit migration required. Existing history retained.');
    return false;
  }
  try {
    await client.startOrResumeThread(config.id,options(state.threadId||config.initialThreadId));
  } catch {
    if (config.board) {
      await log('Board expert could not resume; preserving its existing thread. No replacement thread created.');
      return false;
    }
    if(config.backend==='desktop-chat') {
      await log('Pro expert unavailable: initialization failed; fixed Chat retained, native experts continue. Repair configuration or spool access and restart the bridge.');
      return false;
    }
    if(state.threadId) {
      state.legacyThreadId=state.threadId;
      await log('stored Codex thread could not resume; starting a new thread');
    }
    await client.startOrResumeThread(config.id,options());
  }
  return true;
}
