import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultPreferences, type Preferences, type Workspace } from '../shared/types.js';
import { HttpError } from './errors.js';

interface StoredState {
  version: 1;
  workspaces: Workspace[];
  preferences: Preferences;
}
export class Store {
  private state!: StoredState;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private directory: string,
    private root: string,
  ) {}
  async init() {
    try {
      this.state = JSON.parse(await readFile(path.join(this.directory, 'state.json'), 'utf8'));
      if (this.state.version !== 1 || !Array.isArray(this.state.workspaces))
        throw new Error('Unsupported workspace data.');
      // Drop obsolete appearance fields while keeping existing workspaces and preferences.
      const { gap: _gap, ...preferences } = this.state.preferences as Preferences & {
        gap?: number;
      };
      this.state.preferences = { ...defaultPreferences, ...preferences };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.state = {
        version: 1,
        workspaces: [{ id: randomUUID(), name: 'Main', layout: null, revision: 0 }],
        preferences: { ...defaultPreferences, defaultDirectory: this.root },
      };
      await this.persist(this.state);
    }
  }
  read() {
    return structuredClone(this.state);
  }
  private async persist(state: StoredState) {
    const target = path.join(this.directory, 'state.json');
    const temp = `${target}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
    await rename(temp, target);
  }
  private mutate<T>(change: (state: StoredState) => T): Promise<T> {
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.state);
      const result = change(next);
      await this.persist(next);
      this.state = next;
      return result;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  create(name: string) {
    return this.mutate((state) => {
      const workspace = { id: randomUUID(), name, layout: null, revision: 0 };
      state.workspaces.push(workspace);
      return workspace;
    });
  }
  update(id: string, changes: Partial<Pick<Workspace, 'name' | 'layout'>>, revision: number) {
    return this.mutate((state) => {
      const workspace = state.workspaces.find((item) => item.id === id);
      if (!workspace) throw new HttpError(404, 'Workspace not found.');
      if (workspace.revision !== revision)
        throw new HttpError(
          409,
          'This workspace changed on another device. Reload to use its latest layout.',
        );
      Object.assign(workspace, changes);
      workspace.revision++;
      return workspace;
    });
  }
  remove(id: string) {
    return this.mutate((state) => {
      if (state.workspaces.length === 1) throw new HttpError(400, 'Keep at least one workspace.');
      state.workspaces = state.workspaces.filter((item) => item.id !== id);
    });
  }
  preferences(changes: Partial<Preferences>) {
    return this.mutate((state) => {
      Object.assign(state.preferences, changes);
      return state.preferences;
    });
  }
}
