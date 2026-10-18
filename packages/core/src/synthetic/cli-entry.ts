/**
 * Process entry point for `npm run synth`. All logic is in `cli.ts` (tested);
 * this file only wires it to the process, so it is left out of coverage.
 */
import { runSynthCli } from './cli';

process.exitCode = runSynthCli(process.argv.slice(2), {
  cwd: process.env.INIT_CWD ?? process.cwd(),
  log: (message) => {
    console.info(message);
  },
  error: (message) => {
    console.error(message);
  },
});
