import * as fs from 'fs';
import * as path from 'path';
import * as QRCode from 'qrcode-terminal';
import { logger } from '../utils/logger';
import { BaileysSession, BaileysMessage } from '../types';
import { SupabaseService } from './supabase.service';
import { WhatsAppHandler } from './whatsapp-handler.service';
import { RedisConfig } from '../config/redis';

// Dynamic import for Baileys ES Module compatibility
let makeWASocket: any;
let DisconnectReason: any;
let useMultiFileAuthState: any;
let isJidBroadcast: any;
let isJidStatusBroadcast: any;
let fetchLatestWaWebVersion: any;
let Browsers: any;

let baileysLoaded = false;

async function loadBaileys() {
  if (baileysLoaded) return;
  
  try {
    const baileys = await import('baileys');
    makeWASocket = baileys.default;
    DisconnectReason = baileys.DisconnectReason;
    useMultiFileAuthState = baileys.useMultiFileAuthState;
    isJidBroadcast = baileys.isJidBroadcast;
    isJidStatusBroadcast = baileys.isJidStatusBroadcast;
    fetchLatestWaWebVersion = baileys.fetchLatestWaWebVersion;
    Browsers = baileys.Browsers;
    baileysLoaded = true;
    logger.info('Baileys ES Module loaded successfully');
  } catch (error) {
    logger.error('Failed to load Baileys module:', error);
    throw error;
  }
}

export class BaileysService {
  private static instance: BaileysService;
  private sessions: Map<string, any> = new Map();
  private sessionStates: Map<string, BaileysSession> = new Map();
  private reconnectAttempts: Map<string, number> = new Map();
  private whatsAppHandler: WhatsAppHandler;
  private readonly AUTH_DIR = path.join(process.cwd(), 'auth_sessions');
  private readonly MAX_RECONNECT_ATTEMPTS = 3;

  private constructor() {
    this.ensureAuthDir();
    this.whatsAppHandler = new WhatsAppHandler(this);
  }

  static getInstance(): BaileysService {
    if (!BaileysService.instance) {
      BaileysService.instance = new BaileysService();
    }
    return BaileysService.instance;
  }

  /**
   * Ensure auth directory exists
   */
  private ensureAuthDir(): void {
    if (!fs.existsSync(this.AUTH_DIR)) {
      fs.mkdirSync(this.AUTH_DIR, { recursive: true });
      logger.info('Created auth_sessions directory', { path: this.AUTH_DIR });
    }
  }

  /**
   * Get session path for a business
   */
  private getSessionPath(businessId: string): string {
    return path.join(this.AUTH_DIR, businessId);
  }

  /**
   * Check if session exists for a business
   */
  hasSession(businessId: string): boolean {
    return this.sessions.has(businessId);
  }

  /**
   * Check if session is connected
   */
  isSessionConnected(businessId: string): boolean {
    const state = this.sessionStates.get(businessId);
    return state?.isConnected || false;
  }

  /**
   * Get session state
   */
  getSessionState(businessId: string): BaileysSession | undefined {
    return this.sessionStates.get(businessId);
  }

  /**
   * Get all active sessions
   */
  getAllSessions(): BaileysSession[] {
    return Array.from(this.sessionStates.values());
  }

  /**
   * Store business metadata in session directory
   */
  private async storeBusinessMetadata(businessId: string): Promise<void> {
    try {
      const sessionPath = this.getSessionPath(businessId);
      const metaPath = path.join(sessionPath, 'business.meta.json');
      
      const metadata = {
        businessId,
        createdAt: new Date().toISOString(),
        version: '1.0.0'
      };
      
      fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2));
      logger.info('Business metadata stored', { businessId, metaPath });
    } catch (error) {
      logger.error('Failed to store business metadata', { businessId, error });
    }
  }

  /**
   * Retrieve business metadata from session directory
   */
  private async getBusinessMetadata(sessionPath: string): Promise<{ businessId: string; createdAt: string; version: string } | null> {
    try {
      const metaPath = path.join(sessionPath, 'business.meta.json');
      
      if (!fs.existsSync(metaPath)) {
        return null;
      }
      
      const data = fs.readFileSync(metaPath, 'utf-8');
      const metadata = JSON.parse(data);
      
      return metadata;
    } catch (error) {
      logger.error('Failed to read business metadata', { sessionPath, error });
      return null;
    }
  }

  /**
   * Get business ID from session directory (public method)
   */
  async getBusinessIdFromSession(sessionPath: string): Promise<string | null> {
    const metadata = await this.getBusinessMetadata(sessionPath);
    return metadata?.businessId || null;
  }

  /**
   * Store QR code in Redis and session state
   */
  private async storeQRCode(businessId: string, qrCode: string): Promise<void> {
    try {
      const redis = RedisConfig.getClient();
      const qrKey = `session:${businessId}:qr`;
      
      // Store QR with 5 minute expiration
      await redis.setEx(qrKey, 300, qrCode);
      
      // Update session state
      const state = this.sessionStates.get(businessId);
      if (state) {
        state.qrCode = qrCode;
        this.sessionStates.set(businessId, state);
      }
      
      logger.info('QR code stored in Redis', { businessId });
    } catch (error) {
      logger.error('Failed to store QR code in Redis', { businessId, error });
    }
  }

  /**
   * Update session status in Redis
   */
  private async updateSessionStatus(businessId: string, status: 'connected' | 'disconnected' | 'error', error?: any): Promise<void> {
    try {
      const redis = RedisConfig.getClient();
      const statusKey = `session:${businessId}:status`;
      
      const statusData = {
        businessId,
        status,
        timestamp: new Date().toISOString(),
        error: error || null,
      };
      
      await redis.setEx(statusKey, 3600, JSON.stringify(statusData)); // 1 hour expiration
      
      // Update local session state
      const state = this.sessionStates.get(businessId);
      if (state) {
        state.isConnected = status === 'connected';
        state.lastActivity = Date.now();
        this.sessionStates.set(businessId, state);
      }
      
      logger.info('Session status updated in Redis', { businessId, status });
    } catch (error) {
      logger.error('Failed to update session status in Redis', { businessId, error });
    }
  }

  /**
   * Store incoming message in Redis
   */
  private async storeIncomingMessage(message: BaileysMessage): Promise<void> {
    try {
      const redis = RedisConfig.getClient();
      const messagesKey = `messages:${message.businessId}`;
      
      const messageData = {
        ...message,
        timestamp: new Date().toISOString(),
        type: 'received',
      };
      
      // Add to list (LPUSH for newest first)
      await redis.lPush(messagesKey, JSON.stringify(messageData));
      
      // Keep only last 1000 messages
      await redis.lTrim(messagesKey, 0, 999);
      
      // Set expiration (7 days)
      await redis.expire(messagesKey, 7 * 24 * 60 * 60);
      
      logger.info('Message stored in Redis', { 
        businessId: message.businessId, 
        from: message.from,
        messageLength: message.message.length
      });
    } catch (error) {
      logger.error('Failed to store message in Redis', { 
        businessId: message.businessId, 
        error 
      });
    }
  }

  /**
   * Start a new WhatsApp session for a business
   */
  async startSession(businessId: string): Promise<void> {
    try {
      // Ensure Baileys module is loaded
      await loadBaileys();
      
      if (this.sessions.has(businessId)) {
        logger.warn('Session already exists, removing old session first', { businessId });
        await this.stopSession(businessId);
      }

      const sessionPath = this.getSessionPath(businessId);
      logger.info('Starting WhatsApp session', { businessId, sessionPath });

      // Load or create auth state
      const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
      logger.info('Auth state loaded', { businessId, hasCredentials: !!state.creds });

      // Fetch latest WA Web version to avoid protocol mismatches (e.g. 405 before QR)
      let waVersion: [number, number, number] | undefined;
      try {
        const latest = await fetchLatestWaWebVersion();
        waVersion = latest?.version;
        logger.info('Using WhatsApp Web version', {
          businessId,
          version: waVersion?.join('.'),
          isLatest: latest?.isLatest,
        });
      } catch (versionError) {
        logger.warn('Failed to fetch latest WhatsApp Web version, using Baileys default', {
          businessId,
          error: versionError instanceof Error ? versionError.message : versionError,
        });
      }

      // Create socket connection
      const sock = makeWASocket({
        auth: state,
        version: waVersion,
        browser: Browsers?.ubuntu('Chrome'),
        // printQRInTerminal deprecated en Baileys 7
        // Ahora manejamos el QR manualmente en connection.update
        logger: {
          level: 'silent',
          error: () => {},
          warn: () => {},
          info: () => {},
          debug: () => {},
          trace: () => {},
          child: () => ({ 
            level: 'silent', 
            error: () => {}, 
            warn: () => {}, 
            info: () => {}, 
            debug: () => {}, 
            trace: () => {},
            child: () => ({} as any),
          }),
        },
      });

      // Store socket
      this.sessions.set(businessId, sock);

      // Initialize session state
      this.sessionStates.set(businessId, {
        businessId,
        sessionPath,
        isConnected: false,
      });
      
      // Store business metadata in session directory
      await this.storeBusinessMetadata(businessId);
      
      logger.info('Socket created and stored', { businessId });

      // Handle credentials update
      sock.ev.on('creds.update', saveCreds);

      // Handle connection updates
      sock.ev.on('connection.update', async (update: any) => {
        await this.handleConnectionUpdate(businessId, update);
      });

      // Handle incoming messages
      sock.ev.on('messages.upsert', async (m: any) => {
        await this.handleIncomingMessages(businessId, m);
      });

      logger.info('WhatsApp socket created', { businessId });
    } catch (error) {
      logger.error('Error starting WhatsApp session', { error, businessId });
      await this.updateSessionStatus(businessId, 'error', error);
      throw error;
    }
  }

  /**
   * Handle connection updates
   */
  private async handleConnectionUpdate(businessId: string, update: any): Promise<void> {
    const { connection, lastDisconnect, qr } = update;

    // Emit QR code if generated
    if (qr) {
      logger.info('QR Code generated', { businessId });
      
      // Mostrar QR en terminal usando qrcode-terminal
      console.log('\n🎉 ¡QR CODE GENERADO! Escanea con WhatsApp:\n');
      QRCode.generate(qr, { small: true });
      console.log(`\n📱 Business ID: ${businessId}\n`);
      
      const state = this.sessionStates.get(businessId);
      if (state) {
        state.qrCode = qr;
        this.sessionStates.set(businessId, state);
      }
      
      await this.storeQRCode(businessId, qr);
    }

    // Handle connection status
    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as any)?.output?.statusCode as
        | number
        | undefined;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      logger.warn('Connection closed', { 
        businessId, 
        shouldReconnect,
        statusCode,
        errorMessage: lastDisconnect?.error?.message,
      });

      // Update state
      const state = this.sessionStates.get(businessId);
      if (state) {
        state.isConnected = false;
        this.sessionStates.set(businessId, state);
      }

      // Update Supabase status
      await SupabaseService.updateBusinessWhatsAppStatus(
        businessId
      ).catch(err => {
        logger.warn('Failed to update Supabase WhatsApp status on disconnect', { err, businessId });
      });

      await this.updateSessionStatus(businessId, 'disconnected');

      // Remove from sessions
      this.sessions.delete(businessId);

      // Reconnect if not logged out
      if (shouldReconnect) {
        const attempts = this.reconnectAttempts.get(businessId) || 0;
        
        if (attempts >= this.MAX_RECONNECT_ATTEMPTS) {
          logger.error('Max reconnection attempts reached', { businessId, attempts });
          this.reconnectAttempts.delete(businessId);
          this.sessionStates.delete(businessId);
          await this.updateSessionStatus(businessId, 'error', `Max reconnection attempts (${this.MAX_RECONNECT_ATTEMPTS}) reached`);
          return;
        }
        
        this.reconnectAttempts.set(businessId, attempts + 1);
        logger.info('Reconnecting in 3 seconds...', { businessId, attempt: attempts + 1 });
        
        setTimeout(() => {
          // Clean up before reconnecting
          this.sessions.delete(businessId);
          
          this.startSession(businessId).catch(async (err) => {
            logger.error('Reconnection failed', { err, businessId });
            await this.updateSessionStatus(businessId, 'error', 'Reconnection failed');
          });
        }, 3000);
      } else {
        // Logged out, remove session data from memory
        this.sessionStates.delete(businessId);
        await this.updateSessionStatus(businessId, 'error', 'Session logged out');

        // Delete session files from disk
        const sessionPath = this.getSessionPath(businessId);
        if (fs.existsSync(sessionPath)) {
          fs.rmSync(sessionPath, { recursive: true, force: true });
          logger.info('Session files deleted from disk after logout', { businessId, sessionPath });
        }
      }
    } else if (connection === 'open') {
      logger.info('WhatsApp session connected', { businessId });
      
      // Reset reconnection attempts on successful connection
      this.reconnectAttempts.delete(businessId);

      // Update state
      const state = this.sessionStates.get(businessId);
      if (state) {
        state.isConnected = true;
        state.lastActivity = Date.now();
        delete state.qrCode; // Clear QR once connected
        this.sessionStates.set(businessId, state);
      }

      // Update Supabase business status
      const sock = this.sessions.get(businessId);
      const phoneNumber = sock?.user?.id?.replace('@s.whatsapp.net', '') || undefined;
      
      await SupabaseService.updateBusinessWhatsAppStatus(
        businessId,
        businessId, // use businessId as sessionId
        phoneNumber
      ).catch(err => {
        logger.warn('Failed to update Supabase WhatsApp status', { err, businessId });
      });

      await this.updateSessionStatus(businessId, 'connected');
    }
  }

  /**
   * Handle incoming messages
   */
  private async handleIncomingMessages(businessId: string, messageUpdate: any): Promise<void> {
    try {
      const { messages, type } = messageUpdate;

      if (type !== 'notify') return;

      for (const msg of messages) {
        // Skip broadcast messages, status updates, and group chats
        if (
          !msg.message ||
          msg.key.remoteJid === 'status@broadcast' ||
          msg.key.remoteJid?.endsWith('@g.us') ||
          isJidBroadcast(msg.key.remoteJid!) ||
          isJidStatusBroadcast(msg.key.remoteJid!)
        ) {
          continue;
        }

        // Extract message content
        const messageContent =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          '';

        if (!messageContent) continue;

        const from = msg.key.remoteJid!;
        const fromMe = !!msg.key.fromMe;
        const timestamp = msg.messageTimestamp as number;

        logger.info('Message received', { 
          businessId, 
          from, 
          messageLength: messageContent.length 
        });

        // Create message object
        const baileysMessage: BaileysMessage = {
          from,
          message: messageContent,
          timestamp: timestamp * 1000, // Convert to milliseconds
          businessId,
          fromMe,
        };

        // Store in Redis
        await this.storeIncomingMessage(baileysMessage);
        
        // Process message with AI
        try {
          await this.whatsAppHandler.processMessage(baileysMessage);
        } catch (error) {
          logger.error('Error processing message with WhatsApp handler', { error, businessId, from });
        }
      }
    } catch (error) {
      logger.error('Error handling incoming messages', { error, businessId });
    }
  }

  /**
   * Get the WhatsApp JID for the connected account
   */
  getSelfJid(businessId: string): string | null {
    const sock = this.sessions.get(businessId);
    return sock?.user?.id || null;
  }

  /**
   * Send a message
   */
  async sendMessage(businessId: string, to: string, message: string): Promise<boolean> {
    try {
      // Ensure Baileys module is loaded
      await loadBaileys();
      
      const sock = this.sessions.get(businessId);
      
      if (!sock) {
        logger.error('Session not found', { businessId });
        return false;
      }

      if (!this.isSessionConnected(businessId)) {
        logger.error('Session not connected', { businessId });
        return false;
      }

      // Ensure number has @s.whatsapp.net
      const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;

      logger.info('🚀 Attempting to send message via Baileys', {
        businessId,
        to: jid,
        messagePreview: message.substring(0, 50),
        messageLength: message.length,
      });

      const result = await sock.sendMessage(jid, { text: message });

      logger.info('✅ Message sent successfully via Baileys', { 
        businessId, 
        to: jid, 
        messageLength: message.length,
        messageId: result?.key?.id,
        status: result?.status,
      });

      // Update last activity
      const state = this.sessionStates.get(businessId);
      if (state) {
        state.lastActivity = Date.now();
        this.sessionStates.set(businessId, state);
      }

      return true;
    } catch (error) {
      logger.error('Error sending message', { error, businessId, to });
      return false;
    }
  }

  /**
   * Stop a session
   */
  async stopSession(businessId: string): Promise<void> {
    try {
      const sock = this.sessions.get(businessId);
      
      if (sock) {
        await sock.logout();
        this.sessions.delete(businessId);
      }

      this.sessionStates.delete(businessId);

      logger.info('Session stopped', { businessId });
    } catch (error) {
      logger.error('Error stopping session', { error, businessId });
    }
  }

  /**
   * Restart all existing sessions from disk
   */
  async recoverSessions(): Promise<void> {
    try {
      logger.info('Recovering existing sessions...');

      if (!fs.existsSync(this.AUTH_DIR)) {
        logger.info('No auth directory found, skipping recovery');
        return;
      }

      const directories = fs.readdirSync(this.AUTH_DIR, { withFileTypes: true });
      const sessionDirs = directories.filter((dirent: fs.Dirent) => dirent.isDirectory());

      logger.info('Found session directories', { count: sessionDirs.length });

      for (const dirent of sessionDirs) {
        try {
          const sessionPath = path.join(this.AUTH_DIR, dirent.name);
          
          // Try to get businessId from metadata file
          const businessId = await this.getBusinessIdFromSession(sessionPath);
          
          if (!businessId) {
            // Fallback: use directory name as businessId (for backward compatibility)
            logger.warn('No business metadata found, using directory name as businessId', { dirName: dirent.name });
            const fallbackBusinessId = dirent.name;
            
            // Start session with fallback businessId
            await this.startSession(fallbackBusinessId);
            logger.info('Session recovery initiated (fallback)', { businessId: fallbackBusinessId });
          } else {
            // Start session with businessId from metadata
            await this.startSession(businessId);
            logger.info('Session recovery initiated', { businessId });
          }
        } catch (error) {
          logger.error('Failed to recover session', { error, dirName: dirent.name });
        }
      }
    } catch (error) {
      logger.error('Error recovering sessions', { error });
    }
  }

  /**
   * Delete session from disk
   */
  async deleteSession(businessId: string): Promise<void> {
    try {
      // Stop session first
      await this.stopSession(businessId);

      // Delete from disk
      const sessionPath = this.getSessionPath(businessId);
      if (fs.existsSync(sessionPath)) {
        fs.rmSync(sessionPath, { recursive: true, force: true });
        logger.info('Session deleted from disk', { businessId, sessionPath });
      }
    } catch (error) {
      logger.error('Error deleting session', { error, businessId });
    }
  }
}
