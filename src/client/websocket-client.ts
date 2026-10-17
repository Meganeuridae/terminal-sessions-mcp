import { EventEmitter } from 'events';

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

enum ConnectionState {
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  DISCONNECTED = 'disconnected',
  RECONNECTING = 'reconnecting'
}

export class RobustSessionClient extends EventEmitter {
  private ws: any | null = null;
  private url: string;
  private token?: string;
  private pending = new Map<string, PendingRequest>();
  private state: ConnectionState = ConnectionState.DISCONNECTED;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private reconnectDelay = 1000; // Start with 1 second
  private maxReconnectDelay = 5000; // Cap at 5 seconds
  private requestTimeout = 10000; // 10 second timeout for requests
  
  constructor(url: string = 'ws://localhost:3100', token?: string) {
    super();
    this.url = url;
    this.token = token;
    this.connect();
  }
  
  private connect(): void {
    if (this.state === ConnectionState.CONNECTING || this.state === ConnectionState.CONNECTED) {
      return;
    }
    
    this.state = ConnectionState.CONNECTING;
    const WebSocket = require('ws');
    
    try {
      // Add token as query parameter if provided
      const connectUrl = this.token 
        ? `${this.url}${this.url.includes('?') ? '&' : '?'}token=${encodeURIComponent(this.token)}`
        : this.url;
      this.ws = new WebSocket(connectUrl);
      this.setupEventHandlers();
    } catch (error) {
      this.handleConnectionError(error);
    }
  }
  
  private setupEventHandlers(): void {
    if (!this.ws) return;
    
    this.ws.on('open', () => {
      if (process.env.MCP_DEBUG) {
        console.error('[RobustClient] Connected to session server');
      }
      this.state = ConnectionState.CONNECTED;
      this.reconnectAttempts = 0;
      this.reconnectDelay = 1000; // Reset to 1 second on successful connection
      this.emit('connected');
    });
    
    this.ws.on('error', (err: Error) => {
      if (process.env.MCP_DEBUG) {
        console.error('[RobustClient] Connection error:', err.message);
      }
      this.handleConnectionError(err);
    });
    
    this.ws.on('close', () => {
      if (process.env.MCP_DEBUG) {
        console.error('[RobustClient] Connection closed');
      }
      this.handleDisconnection();
    });
    
    this.ws.on('message', (data: Buffer) => {
      try {
        const payload = JSON.parse(data.toString());
        if (process.env.MCP_DEBUG) {
          console.error('[RobustClient] Received message:', payload);
        }
        
        // Handle event messages (subscriptions)
        if (payload && payload.type === 'event') {
          this.emit('event', payload);
          this.emit(payload.event, payload);
          if (payload.sessionId) {
            this.emit(`${payload.event}:${payload.sessionId}`, payload);
          }
          return;
        }
        
        // Handle response messages (request/response)
        const pending = this.pending.get(payload.id);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pending.delete(payload.id);
          
          if (payload.error) {
            pending.reject(new Error(payload.error));
          } else {
            pending.resolve(payload.result);
          }
        }
      } catch (error) {
        console.error('[RobustClient] Error parsing message:', error);
      }
    });
  }
  
  private handleConnectionError(error: any): void {
    this.state = ConnectionState.DISCONNECTED;
    
    // Reject all pending requests
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Connection lost'));
    }
    this.pending.clear();
    
    // Clean up WebSocket
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    
    // Schedule reconnection
    this.scheduleReconnect();
  }
  
  private handleDisconnection(): void {
    this.handleConnectionError(new Error('WebSocket closed'));
  }
  
  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    
    // Never give up! Keep trying indefinitely
    this.state = ConnectionState.RECONNECTING;
    this.reconnectAttempts++;
    
    if (process.env.MCP_DEBUG) {
      console.error(`[RobustClient] Reconnecting in ${this.reconnectDelay}ms (attempt ${this.reconnectAttempts})`);
    }
    
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, this.reconnectDelay);
    
    // Exponential backoff but cap at maxReconnectDelay (5 seconds)
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }
  
  /**
   * How long to wait for a response before failing the request client-side.
   * Must always exceed how long the SERVER may legitimately take, plus a 5s
   * buffer, so the server-side outcome (e.g. a command's timeout result)
   * arrives as a proper response instead of a client-side "Request timeout".
   * Notably, exec without an explicit timeout used to get the generic 10s
   * request timeout while the server default was 30s — any 10-30s command
   * failed client-side and its (still running) result was dropped.
   */
  private computeRequestTimeout(method: string, params?: any): number {
    switch (method) {
      case 'session.exec': {
        const commandTimeout = typeof params?.timeout === 'number'
          ? Math.max(params.timeout, 0) // -1 = "return immediately" still needs a real wait window
          : 30000; // mirror the server's default command timeout
        return commandTimeout + 5000;
      }
      case 'service.start':
        return 20000; // server polls ready/error patterns for up to 15s
      case 'session.screenshot':
        return 30000; // puppeteer launch + navigation + render waits
      default:
        return this.requestTimeout;
    }
  }

  async request(method: string, params?: any): Promise<any> {
    // Wait for connection if not connected
    if (this.state !== ConnectionState.CONNECTED) {
      await this.waitForConnection();
    }

    return new Promise((resolve, reject) => {
      const id = Math.random().toString(36).substr(2, 9);
      const message = { id, method, params };

      if (process.env.MCP_DEBUG) {
        console.error('[RobustClient] Sending request:', message);
      }

      const effectiveTimeout = this.computeRequestTimeout(method, params);

      // Set up timeout
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, effectiveTimeout);
      
      // Store pending request
      this.pending.set(id, { resolve, reject, timeout });
      
      // Send message
      try {
        if (!this.ws || this.ws.readyState !== 1) { // 1 = OPEN
          throw new Error('WebSocket not connected');
        }
        this.ws.send(JSON.stringify(message));
      } catch (error) {
        // Clean up and reject
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  
  private waitForConnection(): Promise<void> {
    if (this.state === ConnectionState.CONNECTED) {
      return Promise.resolve();
    }
    
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.removeListener('connected', onConnect);
        reject(new Error('Connection timeout'));
      }, this.requestTimeout);
      
      const onConnect = () => {
        clearTimeout(timeout);
        resolve();
      };
      
      this.once('connected', onConnect);
      
      // Try to connect if not already trying
      if (this.state === ConnectionState.DISCONNECTED) {
        this.connect();
      }
    });
  }
  
  // API methods
  async createSession(params: any) {
    return this.request('session.create', params);
  }
  
  async exec(sessionId: string, command: string, timeout?: number) {
    return this.request('session.exec', { sessionId, command, timeout });
  }
  
  async getOutput(sessionId: string, lines?: number) {
    return this.request('session.output', { sessionId, lines });
  }
  
  async searchLogs(sessionId: string, pattern: string, contextLines?: number) {
    return this.request('session.search', { sessionId, pattern, contextLines });
  }
  
  async listSessions() {
    return this.request('session.list');
  }
  
  async startService(params: any) {
    return this.request('service.start', params);
  }
  
  async sendInput(sessionId: string, input: string, appendNewline?: boolean, keys?: string[]) {
    return this.request('session.input', { sessionId, input, appendNewline, keys });
  }
  
  async sendSignal(sessionId: string, signal: string = 'SIGINT') {
    return this.request('session.signal', { sessionId, signal });
  }
  
  async getEnvironment(sessionId: string) {
    return this.request('session.env', { sessionId });
  }
  
  async getCurrentDirectory(sessionId: string) {
    return this.request('session.pwd', { sessionId });
  }
  
  async killSession(sessionId: string, graceful?: boolean) {
    return this.request('session.kill', { sessionId, graceful });
  }
  
  async killAll(graceful?: boolean) {
    return this.request('session.killAll', { graceful });
  }
  
  async takeScreenshot(sessionId: string, options?: {
    lines?: number;
    outputPath?: string;
    width?: number;
    height?: number;
  }) {
    return this.request('session.screenshot', { sessionId, ...options });
  }
  
  async resizeSession(sessionId: string, cols: number, rows: number) {
    return this.request('session.resize', { sessionId, cols, rows });
  }
  
  close() {
    // Cancel reconnection
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    // Close WebSocket
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    
    // Reject pending requests
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Client closed'));
    }
    this.pending.clear();
    
    this.state = ConnectionState.DISCONNECTED;
  }
}

