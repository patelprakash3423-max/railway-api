import {runJourneyCli} from './cli-runner.js';
try{await runJourneyCli(process.argv.slice(2));}
catch(error){console.error((error as Error).message);process.exitCode=1;}
