import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import path from 'node:path';
import { realpath, mkdir } from 'node:fs/promises';

export interface Config {
  root: string;
  dataDirectory: string;
  sessionDirectory: string;
  piCommand: string;
  host: string;
  port: number;
  dev: boolean;
}
export async function readConfig(): Promise<Config> {
  const { values } = parseArgs({
    options: {
      root: { type: 'string', default: process.env.LENTZ_ROOT || homedir() },
      host: { type: 'string', default: process.env.LENTZ_HOST || '127.0.0.1' },
      port: { type: 'string', default: process.env.LENTZ_PORT || '4317' },
      'data-dir': {
        type: 'string',
        default: process.env.LENTZ_DATA_DIR || path.join(homedir(), '.local/share/lentz'),
      },
      pi: { type: 'string', default: process.env.LENTZ_PI || 'pi' },
      'session-dir': {
        type: 'string',
        default:
          process.env.PI_CODING_AGENT_SESSION_DIR ||
          path.join(
            process.env.PI_CODING_AGENT_DIR || path.join(homedir(), '.pi/agent'),
            'sessions',
          ),
      },
      dev: { type: 'boolean', default: false },
    },
  });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Port must be between 1 and 65535.');
  const root = await realpath(path.resolve(values.root));
  const dataDirectory = path.resolve(values['data-dir']);
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  return {
    root,
    dataDirectory,
    sessionDirectory: path.resolve(values['session-dir']),
    piCommand: values.pi,
    host: values.host,
    port,
    dev: values.dev,
  };
}
