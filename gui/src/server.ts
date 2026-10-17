/**
 * Web GUI Server for Terminal Sessions
 * 
 * Provides a web interface to view and interact with terminal sessions
 */

import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import path from 'path';
import { RobustSessionClient } from '../../src/client/websocket-client';
import { AccessOptions, RequestGuard, accessFromEnv, tokenMatches } from '../../src/server/request-guard';

const GUI_PORT = parseInt(process.env.GUI_PORT || '3200');
const SESSION_SERVER_URL = process.env.SESSION_SERVER_URL || 'ws://localhost:3100';
const SESSION_SERVER_TOKEN = process.env.SESSION_SERVER_TOKEN;

export class WebGUIServer {
  private app: express.Application;
  private httpServer: any;
  private io: SocketIOServer;
  private sessionClient: RobustSessionClient;
  private authToken?: string;
  private guard: RequestGuard;

  constructor(port: number = GUI_PORT, host: string = 'localhost', authToken?: string, access: AccessOptions = accessFromEnv()) {
    this.authToken = authToken;
    this.app = express();
    this.httpServer = createServer(this.app);
    // Host/Origin check at every request and handshake (see src/server/request-guard.ts)
    this.guard = new RequestGuard(host, () => this.httpServer?.address()?.port ?? port, !!authToken, access, 'WebGUI');
    // No CORS headers: the only page meant to use this socket is our own, served same-origin.
    // allowRequest runs for both the polling and the websocket handshake.
    this.io = new SocketIOServer(this.httpServer, {
      allowRequest: (req, callback) => {
        const verdict = this.guard.check(req);
        callback(verdict.ok ? null : verdict.message, verdict.ok);
      }
    });

    // Connect to session server (with token if provided)
    // Prefer the token passed to constructor (from --token CLI arg), fall back to env var
    this.sessionClient = new RobustSessionClient(SESSION_SERVER_URL, authToken || SESSION_SERVER_TOKEN);

    this.setupGuard();
    this.setupStaticFiles();
    this.setupAuth();
    this.setupRoutes();
    this.setupSocketIO();

    this.httpServer.listen(port, host, () => {
      const displayHost = host === '0.0.0.0' ? '<all interfaces>' : host;
      console.log(`
╔═══════════════════════════════════════════╗
║   Terminal Sessions Web GUI               ║
║                                           ║
║   http://${host}:${port}
║   ${this.authToken ? '🔐 Token required: ?token=...' : '⚠️  No authentication'}
║                                           ║
║   View and interact with terminal         ║
║   sessions through your browser           ║
╚═══════════════════════════════════════════╝
      `);
    });
  }

  private validateToken(providedToken?: string): boolean {
    if (!this.authToken) return true; // No auth required
    return tokenMatches(providedToken, this.authToken);
  }

  /** Host/Origin check for every HTTP request, static files included, before the token. */
  private setupGuard(): void {
    this.app.use((req, res, next) => {
      const verdict = this.guard.check(req);
      if (!verdict.ok) {
        res.status(verdict.status).type('text/plain').send(verdict.message);
        return;
      }
      next();
    });
  }

  private setupAuth(): void {
    if (!this.authToken) return; // No auth required

    // HTTP authentication middleware
    this.app.use((req, res, next) => {
      const token = req.query.token as string || req.headers.authorization?.replace('Bearer ', '');
      
      if (!this.validateToken(token)) {
        res.status(401).json({ error: 'Unauthorized: invalid or missing token' });
        return;
      }
      next();
    });

    // Socket.IO authentication middleware
    this.io.use((socket, next) => {
      const token = socket.handshake.query.token as string || 
                    socket.handshake.auth.token as string;
      
      if (!this.validateToken(token)) {
        next(new Error('Unauthorized: invalid or missing token'));
        return;
      }
      next();
    });
  }

  private setupStaticFiles(): void {
    // Serve static files BEFORE auth middleware so JS/CSS can load
    // When ts-node: __dirname = .../terminal-sessions-mcp/gui/src
    // When compiled: __dirname = .../terminal-sessions-mcp/dist/gui/src
    const publicDir = __dirname.includes('/dist/')
      ? path.join(__dirname, '../../../gui/public')  // Compiled version
      : path.join(__dirname, '../public');           // ts-node version
    this.app.use(express.static(publicDir));

    // Main page (also before auth — the page itself is just HTML)
    this.app.get('/', (req, res) => {
      const indexPath = __dirname.includes('/dist/')
        ? path.join(__dirname, '../../../gui/public/index.html')
        : path.join(__dirname, '../public/index.html');
      res.sendFile(indexPath);
    });
  }

  private setupRoutes(): void {
    // API endpoints (auth middleware runs before these)
    this.app.get('/api/sessions', async (req, res) => {
      try {
        const sessions = await this.sessionClient.listSessions();
        res.json(sessions);
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    // Create new session
    this.app.use(express.json());
    this.app.post('/api/sessions', async (req, res) => {
      try {
        const { id, cwd, env } = req.body;
        if (!id) {
          return res.status(400).json({ error: 'Session ID required' });
        }
        const sessionId = await this.sessionClient.createSession({ id, cwd, env });
        res.json({ sessionId });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.get('/api/sessions/:id/output', async (req, res) => {
      try {
        const lines = parseInt(req.query.lines as string) || 100;
        const output = await this.sessionClient.getOutput(req.params.id, lines);
        res.json({ output });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

  }

  private setupSocketIO(): void {
    this.io.on('connection', (socket) => {
      console.log('[WebGUI] Client connected:', socket.id);

      // Handle session subscription
      socket.on('subscribe', async (sessionId: string) => {
        console.log('[WebGUI] Client subscribing to:', sessionId);
        
        // Join socket room for this session
        socket.join(`session:${sessionId}`);
        
        // Subscribe to session events from the WebSocket session server
        try {
          await this.sessionClient.request('session.subscribe', {
            sessionId,
            replay: 0  // Don't replay - we already loaded history via API
          });
        } catch (error) {
          console.error('[WebGUI] Failed to subscribe to session events:', error);
        }
      });

      // Handle command execution
      socket.on('exec', async (data: { sessionId: string; command: string }) => {
        try {
          const result = await this.sessionClient.exec(data.sessionId, data.command);
          socket.emit('exec-result', result);
        } catch (error: any) {
          socket.emit('error', { message: error.message });
        }
      });

      // Handle input (from keyboard or command box)
      socket.on('input', async (data: { sessionId: string; input: string }) => {
        try {
          // Don't append newline - xterm.js sends raw key data
          await this.sessionClient.sendInput(data.sessionId, data.input, false);
        } catch (error: any) {
          socket.emit('error', { message: error.message });
        }
      });

      // Handle signal
      socket.on('signal', async (data: { sessionId: string; signal: string }) => {
        try {
          await this.sessionClient.sendSignal(data.sessionId, data.signal);
          socket.emit('signal-sent', { sessionId: data.sessionId, signal: data.signal });
        } catch (error: any) {
          socket.emit('error', { message: error.message });
        }
      });

      // Handle screenshot request
      socket.on('screenshot', async (data: { sessionId: string; lines?: number }) => {
        try {
          const result = await this.sessionClient.takeScreenshot(data.sessionId, {
            lines: data.lines || 50
          });
          socket.emit('screenshot-result', result);
        } catch (error: any) {
          socket.emit('error', { message: error.message });
        }
      });

      // Handle session kill
      socket.on('kill', async (data: { sessionId: string; graceful?: boolean }) => {
        try {
          await this.sessionClient.killSession(data.sessionId, data.graceful !== false);
          socket.emit('kill-success', { sessionId: data.sessionId });
        } catch (error: any) {
          socket.emit('error', { message: error.message });
        }
      });

      // Handle terminal resize (important for mouse support in TUI apps)
      socket.on('resize', async (data: { sessionId: string; cols: number; rows: number }) => {
        try {
          await this.sessionClient.resizeSession(data.sessionId, data.cols, data.rows);
        } catch (error: any) {
          socket.emit('error', { message: error.message });
        }
      });

      socket.on('disconnect', () => {
        console.log('[WebGUI] Client disconnected:', socket.id);
      });
    });

    // Forward session events to connected clients
    this.sessionClient.on('event', (envelope: any) => {
      const event = envelope.event;
      const payload = envelope.payload;
      
      if (event === 'session:output') {
        this.io.to(`session:${envelope.sessionId}`).emit('output', payload);
      } else if (event === 'session:created') {
        this.io.emit('session:created', payload);
      } else if (event === 'session:exit') {
        this.io.emit('session:exit', payload);
      }
    });
  }

  async stop(): Promise<void> {
    this.sessionClient.close();
    this.io.close();
    this.httpServer.close();
  }
}

// Start server if run directly
if (require.main === module) {
  const server = new WebGUIServer();

  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await server.stop();
    process.exit(0);
  });
}

