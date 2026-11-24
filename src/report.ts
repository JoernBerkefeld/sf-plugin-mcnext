import type { SfCommand } from '@salesforce/sf-plugins-core';
import type { Envelope } from './envelope.js';

/** Human output of a run and its exit code. With `--json` the top-level status is that exit code. */
export function report(command: SfCommand<unknown>, envelope: Envelope): void {
  if (envelope.items.length > 0)
    command.table({
      data: envelope.items.map((item) => ({
        area: item.area,
        type: item.type,
        name: item.name,
        outcome: item.outcome,
        detail: [item.code, item.message].filter(Boolean).join(': '),
      })),
      columns: ['area', 'type', 'name', 'outcome', 'detail'],
    });
  else if (envelope.errors.length === 0) command.log('Nothing to do.');
  for (const warning of envelope.warnings) command.warn(warning);
  for (const error of envelope.errors) command.logToStderr(`${error.code}: ${error.message}`);
  if (envelope.status !== 0) process.exitCode = envelope.status;
}
