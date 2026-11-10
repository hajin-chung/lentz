import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import path from 'node:path';
import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Config } from './config.js';
import { Store } from './store.js';
import { Files } from './files.js';
import { HttpError } from './errors.js';
import { SessionIndex } from './pi/sessions.js';
import { PiRuntime } from './pi/runtime.js';
import type { Workspace } from '../shared/types.js';

const pathQuery = z.object({ path: z.string().min(1) });
const idParams = z.object({ id: z.string().uuid() });
const preferencesSchema = z
  .object({
    theme: z.enum(['system', 'light', 'dark']).optional(),
    accent: z.enum(['mono', 'sage', 'blue', 'rose']).optional(),
    fontSize: z.number().int().min(12).max(20).optional(),
    motion: z.boolean().optional(),
    showHidden: z.boolean().optional(),
    defaultDirectory: z.string().optional(),
    sendOnEnter: z.boolean().optional(),
    htmlScripts: z.boolean().optional(),
  })
  .strict();

export async function createApp(config: Config) {
  const app = Fastify({ logger: false, bodyLimit: 8 * 1024 * 1024 });
  const files = new Files(config.root);
  const store = new Store(config.dataDirectory, config.root);
  await store.init();
  // A different startup root should also reset an out-of-root default directory.
  try {
    await files.resolve(store.read().preferences.defaultDirectory);
  } catch {
    await store.preferences({ defaultDirectory: config.root });
  }
  const index = new SessionIndex(config.sessionDirectory, config.root);
  const runtimes = new Map<string, PiRuntime>();
  const events = new EventEmitter();
  events.setMaxListeners(100);
  const registerRuntime = (runtime: PiRuntime) => {
    runtimes.set(runtime.info.id, runtime);
    for (const kind of ['event', 'snapshot', 'notice'])
      runtime.on(kind, (data) => events.emit('update', { id: runtime.info.id, kind, data }));
    runtime.ready
      .then(() =>
        events.emit('update', { id: runtime.info.id, kind: 'snapshot', data: runtime.snapshot }),
      )
      .catch(() => {});
  };
  const getRuntime = (id: string) => {
    const runtime = runtimes.get(id);
    if (!runtime)
      throw new HttpError(404, 'Conversation is not attached. Reopen it from the session picker.');
    return runtime;
  };

  app.setErrorHandler((error, _request, reply) => {
    const err = error as Error & { statusCode?: number; code?: string };
    const status =
      error instanceof z.ZodError
        ? 400
        : err.statusCode || (err.code === 'ENOENT' ? 404 : err.code === 'EACCES' ? 403 : 500);
    reply.code(status).send({
      error:
        error instanceof z.ZodError
          ? error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
          : err.message,
    });
  });
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
    // No login by design. Reject other websites/opaque HTML previews reaching the control API.
    if (request.headers['sec-fetch-site'] === 'cross-site')
      throw new HttpError(403, 'Cross-site API requests are not allowed.');
    const origin = request.headers.origin;
    if (origin && (origin === 'null' || new URL(origin).host !== request.headers.host))
      throw new HttpError(403, 'Origin does not match this server.');
  });
  app.get('/api/bootstrap', async () => ({
    ...store.read(),
    config: {
      root: config.root,
      dataDirectory: config.dataDirectory,
      piCommand: config.piCommand,
      sessionDirectory: config.sessionDirectory,
    },
  }));
  app.post('/api/workspaces', async (request) =>
    store.create(z.object({ name: z.string().trim().min(1).max(80) }).parse(request.body).name),
  );
  app.put('/api/workspaces/:id', async (request) => {
    const { id } = idParams.parse(request.params);
    const { revision, ...changes } = z
      .object({
        revision: z.number().int(),
        name: z.string().trim().min(1).max(80).optional(),
        layout: z.record(z.string(), z.unknown()).nullable().optional(),
      })
      .strict()
      .parse(request.body);
    return store.update(id, changes as Partial<Pick<Workspace, 'name' | 'layout'>>, revision);
  });
  app.delete('/api/workspaces/:id', async (request) => {
    await store.remove(idParams.parse(request.params).id);
    return { ok: true };
  });
  app.patch('/api/preferences', async (request) => {
    const changes = preferencesSchema.parse(request.body);
    if (changes.defaultDirectory !== undefined) {
      changes.defaultDirectory = await files.resolve(changes.defaultDirectory);
      if (!(await stat(changes.defaultDirectory)).isDirectory())
        throw new HttpError(400, 'Default directory must be a folder.');
    }
    return store.preferences(changes);
  });
  app.get('/api/files/tree', async (request) =>
    files.directory(z.object({ path: z.string().optional() }).parse(request.query).path),
  );
  app.get('/api/files/info', async (request) => files.info(pathQuery.parse(request.query).path));
  app.get('/api/files/text', async (request) => files.text(pathQuery.parse(request.query).path));
  app.get('/api/files/text-preview', async (request) =>
    files.previewText(pathQuery.parse(request.query).path),
  );
  app.put('/api/files/text', async (request) => {
    const body = z
      .object({ path: z.string(), content: z.string(), revision: z.string() })
      .parse(request.body);
    return files.save(body.path, body.content, body.revision);
  });
  const sendFile = async (
    input: string,
    request: FastifyRequest,
    reply: FastifyReply,
    preview: boolean,
  ) => {
    const info = await files.info(input);
    reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Type', info.mime)
      .header('Accept-Ranges', 'bytes');
    reply.header('Cache-Control', 'no-store');
    // Even a directly opened HTML/SVG file cannot become a same-origin control page.
    reply.header(
      'Content-Security-Policy',
      "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'",
    );
    if (!preview && (request.query as { download?: string })?.download === '1')
      reply.header(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(info.name)}`,
      );
    const range = request.headers.range as string | undefined;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2]))
        return reply.code(416).header('Content-Range', `bytes */${info.size}`).send();
      const start = match[1] ? Number(match[1]) : Math.max(0, info.size - Number(match[2]));
      const end = match[1]
        ? Math.min(match[2] ? Number(match[2]) : info.size - 1, info.size - 1)
        : info.size - 1;
      if (start > end || start >= info.size || start < 0)
        return reply.code(416).header('Content-Range', `bytes */${info.size}`).send();
      return reply
        .code(206)
        .header('Content-Range', `bytes ${start}-${end}/${info.size}`)
        .header('Content-Length', end - start + 1)
        .send(createReadStream(info.path, { start, end }));
    }
    return reply.header('Content-Length', info.size).send(createReadStream(info.path));
  };
  app.get('/api/files/raw', async (request, reply) =>
    sendFile(pathQuery.parse(request.query).path, request, reply, false),
  );
  app.get('/preview/*', async (request, reply) => {
    const relative = (request.params as { '*': string })['*'];
    return sendFile(path.join(config.root, relative), request, reply, true);
  });

  app.get('/api/sessions', async () => {
    const list = await index.list();
    const merged = new Map(list.map((session) => [session.id, session]));
    for (const [id, runtime] of runtimes)
      merged.set(id, { ...runtime.info, running: runtime.snapshot.isStreaming });
    return [...merged.values()].sort((a, b) => b.modified.localeCompare(a.modified));
  });
  app.post('/api/sessions', async (request) => {
    const body = z
      .object({ cwd: z.string(), name: z.string().trim().max(100).optional() })
      .parse(request.body);
    const cwd = await files.resolve(body.cwd);
    if (!(await stat(cwd)).isDirectory()) throw new HttpError(400, 'Choose a directory.');
    const id = randomUUID();
    const runtime = new PiRuntime(
      {
        id,
        cwd,
        name: body.name || 'New conversation',
        modified: new Date().toISOString(),
        running: false,
      },
      config,
    );
    registerRuntime(runtime);
    await runtime.ready;
    if (body.name) {
      await runtime.command('set_session_name', { name: body.name });
      runtime.info.name = body.name;
    }
    return runtime.info;
  });
  app.post('/api/sessions/:id/attach', async (request) => {
    const { id } = idParams.parse(request.params);
    let runtime = runtimes.get(id);
    if (!runtime || runtime.snapshot.exited) {
      const info = (await index.list()).find((session) => session.id === id) || runtime?.info;
      if (!info) throw new HttpError(404, 'Session not found.');
      await files.resolve(info.cwd);
      // Recheck after asynchronous discovery so concurrent browser attaches share one writer.
      runtime = runtimes.get(id);
      if (!runtime || runtime.snapshot.exited) {
        runtime = new PiRuntime(info, config);
        registerRuntime(runtime);
      }
    }
    await runtime.ready;
    // History travels over the subscribed stream, once, rather than again in this response.
    return { ok: true };
  });
  app.get('/api/sessions/:id/history', async (request, reply) => {
    const runtime = getRuntime(idParams.parse(request.params).id);
    await runtime.ready;
    const query = z
      .object({
        before: z.string().min(1).max(100).optional(),
        from: z.string().min(1).max(100).optional(),
      })
      .parse(request.query);
    const started = performance.now();
    const page = runtime.history.page(runtime.sequence, query);
    const built = performance.now();
    const body = JSON.stringify(page);
    reply.header(
      'Server-Timing',
      `history;dur=${(built - started).toFixed(2)}, serialize;dur=${(performance.now() - built).toFixed(2)}`,
    );
    return reply.type('application/json').send(body);
  });
  app.get('/api/sessions/:id/message', async (request) => {
    const runtime = getRuntime(idParams.parse(request.params).id);
    await runtime.ready;
    const { cursor } = z.object({ cursor: z.string().max(100) }).parse(request.query);
    return {
      epoch: runtime.history.epoch,
      message: runtime.history.message(runtime.history.offset(cursor), true),
    };
  });
  app.get('/api/sessions/:id/snapshot', async (request) => {
    const runtime = getRuntime(idParams.parse(request.params).id);
    await runtime.ready;
    return runtime.snapshot;
  });
  app.get('/api/sessions/:id/diagnostics', async (request) => {
    const runtime = getRuntime(idParams.parse(request.params).id);
    return { ...runtime.timings, messages: runtime.history.length };
  });
  app.get('/api/events', async (request, reply) => {
    const query = z.object({ ids: z.string().max(8000) }).parse(request.query);
    const ids = new Set(query.ids.split(',').map((id) => z.string().uuid().parse(id)));
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // EventSource must open before the client can attach. Without a body/header flush,
    // an unattached session waited for the first 15-second heartbeat.
    reply.raw.flushHeaders();
    reply.raw.write(': connected\n\n');
    const dirty = new Set<string>();
    const notices = new Map<string, unknown>();
    const lastSnapshots = new Map<string, unknown>();
    const send = (type: string, data: unknown) => {
      if (reply.raw.destroyed) return;
      const started = performance.now();
      const body = JSON.stringify(data);
      const event = data as { id: string; kind: string };
      if (event.kind === 'snapshot') {
        const runtime = runtimes.get(event.id);
        if (runtime) {
          runtime.timings.snapshotSerializeMs = performance.now() - started;
          runtime.timings.snapshotBytes = Buffer.byteLength(body);
        }
      }
      reply.raw.write(`event: ${type}\ndata: ${body}\n\n`);
    };
    const update = (event: { id: string; kind: string; data: unknown }) => {
      if (!ids.has(event.id) || reply.raw.destroyed) return;
      if (event.kind === 'snapshot' && lastSnapshots.get(event.id) === event.data) return;
      // A large initial history can exceed the buffer budget by itself. Coalesce later
      // deltas into a fresh snapshot after draining instead of reconnecting in a loop.
      if (dirty.has(event.id) || reply.raw.writableLength > 2 * 1024 * 1024) {
        dirty.add(event.id);
        if (event.kind === 'notice') notices.set(event.id, event.data);
        return;
      }
      if (event.kind === 'snapshot') lastSnapshots.set(event.id, event.data);
      send('update', event);
    };
    reply.raw.on('drain', () => {
      for (const id of dirty) {
        if (reply.raw.writableLength > 2 * 1024 * 1024) break;
        dirty.delete(id);
        const runtime = runtimes.get(id);
        if (runtime) update({ id, kind: 'snapshot', data: runtime.snapshot });
        if (notices.has(id)) {
          const data = notices.get(id);
          notices.delete(id);
          update({ id, kind: 'notice', data });
        }
      }
    });
    events.on('update', update);
    for (const id of ids) {
      const runtime = runtimes.get(id);
      if (runtime)
        void runtime.ready
          .catch(() => {})
          .then(() => update({ id, kind: 'snapshot', data: runtime.snapshot }));
    }
    const heartbeat = setInterval(() => {
      if (!reply.raw.destroyed && !reply.raw.writableLength) reply.raw.write(': heartbeat\n\n');
    }, 15_000);
    reply.raw.on('close', () => {
      clearInterval(heartbeat);
      events.off('update', update);
    });
  });
  app.post('/api/sessions/:id/prompt', async (request) => {
    const runtime = getRuntime(idParams.parse(request.params).id);
    const body = z
      .object({
        message: z.string().trim().min(1).max(200_000),
        behavior: z.enum(['steer', 'followUp']).default('followUp'),
      })
      .parse(request.body);
    return runtime.prompt(body.message, body.behavior);
  });
  app.post('/api/sessions/:id/stop', async (request) => {
    await getRuntime(idParams.parse(request.params).id).stop();
    return { ok: true };
  });
  app.post('/api/sessions/:id/release', async (request) => {
    const runtime = getRuntime(idParams.parse(request.params).id);
    await runtime.stop();
    runtime.close();
    return { ok: true };
  });
  app.patch('/api/sessions/:id/settings', async (request) => {
    const runtime = getRuntime(idParams.parse(request.params).id);
    const body = z
      .object({
        provider: z.string().optional(),
        modelId: z.string().optional(),
        thinkingLevel: z.string().optional(),
      })
      .parse(request.body);
    if (body.provider && body.modelId)
      await runtime.command('set_model', { provider: body.provider, modelId: body.modelId });
    if (body.thinkingLevel)
      await runtime.command('set_thinking_level', { level: body.thinkingLevel });
    await runtime.refresh();
    return { ok: true };
  });
  app.post('/api/sessions/:id/dialog', async (request) => {
    const body = z
      .object({
        id: z.string(),
        value: z.string().optional(),
        confirmed: z.boolean().optional(),
        cancelled: z.boolean().optional(),
      })
      .parse(request.body);
    const { id, ...response } = body;
    getRuntime(idParams.parse(request.params).id).respond(id, response);
    return { ok: true };
  });
  app.addHook('onClose', async () => {
    for (const runtime of runtimes.values()) runtime.close();
  });

  if (config.dev) {
    const { createServer } = await import('vite');
    const vite = await createServer({
      server: { middlewareMode: true, hmr: { server: app.server }, allowedHosts: true },
      appType: 'spa',
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/'))
        return reply.code(404).send({ error: 'API route not found.' });
      reply.hijack();
      vite.middlewares(request.raw, reply.raw, () => {
        reply.raw.statusCode = 404;
        reply.raw.end('Not found');
      });
    });
    app.addHook('onClose', () => vite.close());
  } else {
    await app.register(fastifyStatic, { root: path.resolve('dist/client'), wildcard: false });
    app.setNotFoundHandler((request, reply) =>
      request.url.startsWith('/api/')
        ? reply.code(404).send({ error: 'API route not found.' })
        : reply.sendFile('index.html'),
    );
  }
  return app;
}
