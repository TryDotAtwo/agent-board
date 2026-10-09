import {CopilotClient} from '@github/copilot-sdk';
import {modelToken, redact} from './credentials.mjs';

const token = await modelToken();
const client = new CopilotClient({
  gitHubToken: token,
  useLoggedInUser: false,
  workingDirectory: '/workspace',
  logLevel: 'error',
  enableRemoteSessions: false,
});
try {
  await client.start();
  const auth = await client.getAuthStatus();
  console.log(JSON.stringify({authenticated: auth.isAuthenticated, authType: auth.authType}));
  if (process.argv.includes('--models')) {
    const models = await client.listModels();
    console.log(JSON.stringify(models.map(({id, name, capabilities, billing}) => ({id, name, capabilities, billing}))));
  }
  if (!auth.isAuthenticated) throw new Error('Copilot model credential is not authenticated');
} catch (error) {
  console.error(redact(error.message, [token]));
  process.exitCode = 1;
} finally {
  for (const error of await client.stop()) {
    console.error(redact(error.message || String(error), [token]));
    process.exitCode = 1;
  }
}
