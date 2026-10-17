/**
 * MCP Server for Terminal Sessions
 * 
 * Exposes session management tools to AI assistants
 */

import { RobustSessionClient } from '../client/websocket-client';
import { cleanTerminalOutput, cleanLogLines, CleanOptions } from '../utils/ansi-clean';

interface ServiceConfig {
  name: string;
  command: string;
  cwd?: string;
  readyPatterns?: string[];
  errorPatterns?: string[];
}

interface CommandResult {
  output: string;
  exitCode: number;
  duration: number;
}

/** Options for controlling output formatting */
interface OutputOptions {
  /** If true, return raw terminal output with ANSI codes intact */
  raw?: boolean;
}

interface LogMatch {
  lineNumber: number;
  line: string;
  context: string[];
}

export class ConnectomeTestingMCP {
  private client: RobustSessionClient | null = null;
  private apiUrl: string;
  private authToken?: string;
  private serviceMap = new Map<string, string>(); // name -> sessionId
  
  constructor(apiUrl: string = 'ws://localhost:3100', authToken?: string) {
    this.apiUrl = apiUrl;
    this.authToken = authToken;
  }
  
  private getClient(): RobustSessionClient {
    if (!this.client) {
      this.client = new RobustSessionClient(this.apiUrl, this.authToken);
    }
    return this.client;
  }
  
  private resetClient(): void {
    if (this.client) {
      this.client.close();
      this.client = null;
    }
  }
  
  // Note: withConnectionRetry is now less critical since RobustSessionClient
  // handles reconnection automatically, but we keep it for extra safety
  private async withConnectionRetry<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error: any) {
      // The RobustSessionClient should handle most reconnection scenarios,
      // but this provides an extra layer of safety for edge cases
      if (error.message?.includes('ECONNREFUSED') || 
          error.message?.includes('WebSocket') ||
          error.message?.includes('EPIPE') ||
          error.message?.includes('socket hang up') ||
          error.message?.includes('Connection lost')) {
        this.resetClient();
        // Try once more with a fresh connection
        return await operation();
      }
      throw error;
    }
  }
  
  /**
   * Start a service with intelligent startup detection
   * @tool
   */
  async launch(config: ServiceConfig & { raw?: boolean }): Promise<{
    status: 'ready' | 'error' | 'running';
    logs: string[];
    sessionId?: string;
  }> {
    try {
      const result = await this.getClient().startService(config);
      
      if (result.sessionId) {
        this.serviceMap.set(config.name, result.sessionId);
      }
      
      // Format response for readability, clean logs unless raw mode
      return {
        status: result.status,
        logs: cleanLogLines(result.logs, { raw: config.raw }),
        sessionId: result.sessionId
      };
    } catch (error: any) {
      // Reset client on connection errors
      if (error.message?.includes('ECONNREFUSED') || 
          error.message?.includes('WebSocket') ||
          error.message?.includes('EPIPE')) {
        this.resetClient();
      }
      return {
        status: 'error',
        logs: [`Failed to start service: ${error.message}`]
      };
    }
  }
  
  /**
   * Run a command in a specific session
   * @tool
   */
  async runCommand(params: {
    session: string; // Can be sessionId or service name
    command: string;
    cwd?: string; // Working directory (used when auto-creating session)
    timeout?: number; // Command timeout in ms (default: 30000)
    raw?: boolean; // If true, preserve raw ANSI codes
  }): Promise<CommandResult> {
    const sessionId = this.serviceMap.get(params.session) || params.session;

    // Auto-create session if it doesn't exist
    try {
      const sessions = await this.getClient().listSessions();
      const exists = sessions.some((s: any) => s.id === sessionId);
      if (!exists) {
        await this.createSession({ id: sessionId, cwd: params.cwd });
      }
    } catch {
      // If listing fails, try to create anyway — exec will give the real error
      try {
        await this.createSession({ id: sessionId, cwd: params.cwd });
      } catch {
        // Session might already exist, continue to exec
      }
    }

    const result = await this.getClient().exec(sessionId, params.command, params.timeout);

    // Clean output unless raw mode is requested
    return {
      ...result,
      output: cleanTerminalOutput(result.output, { raw: params.raw })
    };
  }
  
  /**
   * Get recent output from a session
   * @tool
   */
  async tailLogs(params: {
    session: string;
    lines?: number;
    raw?: boolean; // If true, preserve raw ANSI codes
  }): Promise<string[]> {
    const sessionId = this.serviceMap.get(params.session) || params.session;
    const logs = await this.getClient().getOutput(sessionId, params.lines || 50);
    
    // Clean logs unless raw mode is requested
    return cleanLogLines(logs, { raw: params.raw });
  }
  
  /**
   * Search logs with context
   * @tool
   */
  async searchLogs(params: {
    session: string;
    pattern: string;
    context?: number;
    raw?: boolean; // If true, preserve raw ANSI codes
  }): Promise<LogMatch[]> {
    const sessionId = this.serviceMap.get(params.session) || params.session;
    const results = await this.getClient().searchLogs(
      sessionId, 
      params.pattern, 
      params.context || 3
    );
    
    // Clean results unless raw mode is requested
    if (params.raw) {
      return results;
    }
    
    return results.map((match: LogMatch) => ({
      ...match,
      line: cleanTerminalOutput(match.line, { raw: false }),
      context: match.context ? cleanLogLines(match.context, { raw: false }) : []
    }));
  }
  
  /**
   * List all active sessions
   * @tool
   */
  async listSessions(): Promise<Array<{
    id: string;
    name?: string;
    isAlive: boolean;
    createdAt: Date;
    lastActivity: Date;
    logSize: number;
  }>> {
    const sessions = await this.withConnectionRetry(() =>
      this.getClient().listSessions()
    );

    // Enhance with service names. (Map the fields the server actually
    // returns — the old pid/startTime fields never existed server-side and
    // always came back undefined.)
    return sessions.map((session: any) => {
      const name = Array.from(this.serviceMap.entries())
        .find(([_, id]) => id === session.id)?.[0];

      return {
        id: session.id,
        name,
        isAlive: session.isAlive,
        createdAt: session.createdAt,
        lastActivity: session.lastActivity,
        logSize: session.logSize
      };
    });
  }
  
  /**
   * Kill a specific session
   * @tool
   */
  async killSession(params: {
    session: string;
    graceful?: boolean;
  }): Promise<{ success: boolean; message?: string }> {
    const sessionId = this.serviceMap.get(params.session) || params.session;
    
    try {
      await this.getClient().request('session.kill', { sessionId, graceful: params.graceful });
      
      // Remove from service map
      for (const [name, id] of Array.from(this.serviceMap.entries())) {
        if (id === sessionId) {
          this.serviceMap.delete(name);
          break;
        }
      }
      
      return { 
        success: true,
        message: params.graceful === false 
          ? 'Session forcefully terminated' 
          : 'Session terminated gracefully'
      };
    } catch (error) {
      return { success: false };
    }
  }
  
  /**
   * Create a new terminal session
   * @tool
   */
  async createSession(params: {
    id: string;
    cwd?: string;
    env?: Record<string, string>;
  }): Promise<{
    sessionId: string;
    info: any;
  }> {
    return await this.getClient().createSession(params);
  }
  
  /**
   * Send input to an interactive session
   * @tool
   */
  async sendInput(params: {
    session: string;
    input: string;
    appendNewline?: boolean;
    keys?: string[];
  }): Promise<{ success: boolean; error?: string }> {
    try {
      const sessionId = this.serviceMap.get(params.session) || params.session;
      await this.withConnectionRetry(() =>
        this.getClient().sendInput(sessionId, params.input, params.appendNewline, params.keys)
      );
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) };
    }
  }
  
  /**
   * Send a signal to a session (e.g., SIGINT for Ctrl+C)
   * @tool
   */
  async sendSignal(params: {
    session: string;
    signal?: string;
  }): Promise<{ success: boolean }> {
    try {
      const sessionId = this.serviceMap.get(params.session) || params.session;
      await this.withConnectionRetry(() =>
        this.getClient().sendSignal(sessionId, params.signal || 'SIGINT')
      );
      return { success: true };
    } catch (error) {
      return { success: false };
    }
  }
  
  /**
   * Get environment variables for a session
   * @tool
   */
  async getEnvironment(params: {
    session: string;
  }): Promise<Record<string, string>> {
    const sessionId = this.serviceMap.get(params.session) || params.session;
    return await this.getClient().getEnvironment(sessionId);
  }
  
  /**
   * Get current working directory for a session
   * @tool
   */
  async getCurrentDirectory(params: {
    session: string;
  }): Promise<string> {
    const sessionId = this.serviceMap.get(params.session) || params.session;
    return await this.getClient().getCurrentDirectory(sessionId);
  }
  
  /**
   * Kill all sessions
   * @tool
   */
  async killAll(params?: {
    graceful?: boolean;
  }): Promise<{ success: boolean; message?: string }> {
    try {
      await this.getClient().killAll(params?.graceful);
      this.serviceMap.clear();
      return { 
        success: true,
        message: params?.graceful === false 
          ? 'All sessions forcefully terminated' 
          : 'All sessions terminated gracefully'
      };
    } catch (error) {
      return { success: false };
    }
  }
  
  /**
   * Run a test scenario with assertions
   * @tool
   */
  async runTest(params: {
    name: string;
    setup: string[];
    test: string;
    cleanup?: string[];
    timeout?: number;
    raw?: boolean; // If true, preserve raw ANSI codes
  }): Promise<{
    success: boolean;
    output: string;
    duration: number;
  }> {
    const sessionId = `test-${params.name}-${Date.now()}`;
    const startTime = Date.now();
    const outputs: string[] = [];
    
    try {
      // Create test session
      await this.createSession({ id: sessionId });
      
      // Run setup commands (pass raw through)
      for (const cmd of params.setup) {
        const result = await this.runCommand({ session: sessionId, command: cmd, raw: params.raw });
        outputs.push(`$ ${cmd}\n${result.output}\n`);
        
        if (result.exitCode !== 0) {
          throw new Error(`Setup failed: ${cmd}`);
        }
      }
      
      // Run test (pass raw through)
      const testResult = await this.runCommand({ 
        session: sessionId, 
        command: params.test,
        raw: params.raw
      });
      outputs.push(`$ ${params.test}\n${testResult.output}\n`);
      
      // Run cleanup
      if (params.cleanup) {
        for (const cmd of params.cleanup) {
          await this.runCommand({ session: sessionId, command: cmd, raw: params.raw });
        }
      }
      
      // Clean up session
      await this.killSession({ session: sessionId });
      
      return {
        success: testResult.exitCode === 0,
        output: outputs.join('\n'),
        duration: Date.now() - startTime
      };
    } catch (error: any) {
      // Ensure cleanup
      await this.killSession({ session: sessionId }).catch(() => {});
      
      return {
        success: false,
        output: outputs.join('\n') + `\nError: ${error.message}`,
        duration: Date.now() - startTime
      };
    }
  }
  
  /**
   * Take a screenshot of the terminal session
   * @tool
   */
  async takeScreenshot(params: {
    session: string;
    lines?: number;
    outputPath?: string;
    width?: number;
    height?: number;
  }): Promise<{
    success: boolean;
    path?: string;
    base64?: string;
    error?: string;
  }> {
    try {
      const sessionId = this.serviceMap.get(params.session) || params.session;
      return await this.getClient().takeScreenshot(sessionId, params);
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }
  
  /**
   * Wait for a pattern to appear in logs
   * @tool
   */
  async waitForPattern(params: {
    session: string;
    pattern: string;
    timeout?: number;
  }): Promise<{
    found: boolean;
    match?: LogMatch;
    elapsed: number;
  }> {
    const sessionId = this.serviceMap.get(params.session) || params.session;
    const timeout = params.timeout || 10000;
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeout) {
      const matches = await this.searchLogs({
        session: sessionId,
        pattern: params.pattern,
        context: 3
      });
      
      if (matches.length > 0) {
        return {
          found: true,
          match: matches[0],
          elapsed: Date.now() - startTime
        };
      }
      
      // Wait a bit before checking again
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    return {
      found: false,
      elapsed: Date.now() - startTime
    };
  }
}

// Example usage for testing
if (require.main === module) {
  const demo = async () => {
    const mcp = new ConnectomeTestingMCP();
    
    // Start a service
    console.log('Starting test server...');
    const result = await mcp.launch({
      name: 'test-server',
      command: 'npx http-server -p 8080',
      readyPatterns: ['listening', 'available']
    });
    
    console.log('Service status:', result.status);
    console.log('Startup logs:', result.logs);
    
    // Search logs
    const matches = await mcp.searchLogs({
      session: 'test-server',
      pattern: 'listening'
    });
    
    console.log('Found matches:', matches);
    
    // List sessions
    const sessions = await mcp.listSessions();
    console.log('Active sessions:', sessions);
  }
  
  demo().catch(console.error);
}
