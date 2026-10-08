import { FakeTwilio } from './fake-twilio';
import { writeAudioFixtures } from './make-audio';
import { listFixtures, loadFixture, loadSendgridFixture, newVars } from './fixtures';
import { localEnv } from './local-env';
import { replayFixture, runScenario } from './replay';
import { replaySendgrid } from './replay-sendgrid';
import { seedArmstrong, seedVars } from './seed';
import { serveFunctions, stopFunctions } from './serve';

const [command, name, ...flags] = process.argv.slice(2);
const env = localEnv();

async function main(): Promise<number> {
  switch (command) {
    case 'serve':
      await serveFunctions(env);
      console.log(`functions serving at ${env.functionsUrl}`);
      return 0;
    case 'fake-twilio': {
      const fake = new FakeTwilio(env);
      await fake.start();
      console.log(`fake Twilio recordings API at ${env.twilio.apiBaseUrl} (Ctrl-C to stop)`);
      await new Promise(() => undefined);
      return 0;
    }
    case 'make-audio':
      console.log(writeAudioFixtures().join('\n'));
      return 0;
    case 'stop':
      stopFunctions();
      return 0;
    case 'list': {
      const { fixtures, sendgrid, scenarios } = listFixtures();
      console.log(
        `twilio fixtures:\n  ${fixtures.join('\n  ')}\nsendgrid fixtures:\n  ${sendgrid.join('\n  ')}\nscenarios:\n  ${scenarios.join('\n  ')}`,
      );
      return 0;
    }
    case 'replay': {
      if (name === undefined)
        throw new Error('usage: harness replay <fixture|scenario> [--tamper]');
      const { fixtures, sendgrid, scenarios } = listFixtures();
      const vars = { ...newVars(), ...seedVars(await seedArmstrong(env)) };
      if (scenarios.includes(name)) {
        const run = await runScenario(name, env, vars);
        for (const step of run.steps) {
          const verdict = step.failures.length === 0 ? 'ok  ' : 'FAIL';
          console.log(
            `${verdict} ${step.fixture}${step.tamper ? ' (tampered)' : ''} -> ${step.result.status}`,
          );
          for (const failure of step.failures) console.log(`       ${failure}`);
        }
        return run.ok ? 0 : 1;
      }
      if (fixtures.includes(name)) {
        const result = await replayFixture(loadFixture(name), {
          env,
          vars,
          tamper: flags.includes('--tamper'),
          unsigned: flags.includes('--unsigned'),
        });
        console.log(`${result.status} ${result.contentType ?? ''}\n${result.body}`);
        return 0;
      }
      if (sendgrid.includes(name)) {
        const result = await replaySendgrid(loadSendgridFixture(name), { env, vars });
        console.log(`${result.status} ${result.contentType ?? ''}\n${result.body}`);
        return 0;
      }
      throw new Error(`no fixture or scenario named "${name}" (try: harness list)`);
    }
    default:
      console.log(
        'usage: harness <serve|stop|fake-twilio|make-audio|list|replay <name> [--tamper|--unsigned]>',
      );
      return 2;
  }
}

process.exit(await main());
