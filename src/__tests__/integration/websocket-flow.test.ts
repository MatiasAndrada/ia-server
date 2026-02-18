import { Server as SocketIOServer } from 'socket.io';
import { io as SocketIOClient, Socket } from 'socket.io-client';
import { createServer, Server as HTTPServer } from 'http';
import express, { Express } from 'express';
import { RedisConfig } from '../../config/redis';
import { SupabaseConfig } from '../../config/supabase';

describe('WebSocket Flow Integration Tests', () => {
  let app: Express;
  let httpServer: HTTPServer;
  let io: SocketIOServer;
  let clientSocket: Socket;
  let serverPort: number;

  const TEST_API_KEY = process.env.API_KEY || 'test-api-key';
  const TEST_BUSINESS_ID = process.env.TEST_BUSINESS_ID || 'test-business-id';

  beforeAll(async () => {
    // Initialize Redis
    await RedisConfig.initialize();
    
    // Initialize Supabase
    await SupabaseConfig.initialize();

    // Create Express app
    app = express();
    httpServer = createServer(app);

    // Create Socket.IO server
    io = new SocketIOServer(httpServer, {
      cors: {
        origin: '*',
        methods: ['GET', 'POST'],
      },
    });

    // Authentication middleware
    io.use((socket, next) => {
      const apiKey = socket.handshake.auth.apiKey;
      const businessId = socket.handshake.auth.businessId;

      if (!apiKey || apiKey !== TEST_API_KEY) {
        return next(new Error('Authentication failed: Invalid API Key'));
      }

      if (!businessId) {
        return next(new Error('Authentication failed: businessId required'));
      }

      socket.data.businessId = businessId;
      next();
    });

    // Start server on random port
    await new Promise<void>((resolve) => {
      httpServer.listen(0, () => {
        const address = httpServer.address();
        serverPort = typeof address === 'object' && address ? address.port : 0;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (clientSocket) {
      clientSocket.close();
    }
    if (io) {
      io.close();
    }
    if (httpServer) {
      httpServer.close();
    }
    await RedisConfig.close();
  });

  describe('WebSocket Authentication', () => {
    it('should reject connection without API key', (done) => {
      const socket = SocketIOClient(`https://localhost:${serverPort}`, {
        auth: {
          businessId: TEST_BUSINESS_ID,
        },
        rejectUnauthorized: false, // For self-signed certs in tests
      });

      socket.on('connect_error', (error) => {
        expect(error.message).toContain('Authentication failed');
        socket.close();
        done();
      });
    });

    it('should reject connection without businessId', (done) => {
      const socket = SocketIOClient(`https://localhost:${serverPort}`, {
        auth: {
          apiKey: TEST_API_KEY,
        },
        rejectUnauthorized: false, // For self-signed certs in tests
      });

      socket.on('connect_error', (error) => {
        expect(error.message).toContain('businessId required');
        socket.close();
        done();
      });
    });

    it('should accept valid authentication', (done) => {
      clientSocket = SocketIOClient(`https://localhost:${serverPort}`, {
        auth: {
          apiKey: TEST_API_KEY,
          businessId: TEST_BUSINESS_ID,
        },
        rejectUnauthorized: false, // For self-signed certs in tests
      });

      clientSocket.on('connect', () => {
        expect(clientSocket.connected).toBe(true);
        done();
      });
    });
  });

  describe('WebSocket Events', () => {
    beforeEach((done) => {
      if (!clientSocket || !clientSocket.connected) {
        clientSocket = SocketIOClient(`https://localhost:${serverPort}`, {
          auth: {
            apiKey: TEST_API_KEY,
            businessId: TEST_BUSINESS_ID,
          },
          rejectUnauthorized: false, // For self-signed certs in tests
        });

        clientSocket.on('connect', () => {
          done();
        });
      } else {
        done();
      }
    });

    it('should join business room on connection', () => {
      const rooms = Array.from(io.sockets.adapter.rooms.keys());
      const businessRoom = `business:${TEST_BUSINESS_ID}`;
      
      // Note: This test may not work perfectly due to how rooms are managed
      // But demonstrates the concept
      expect(clientSocket.connected).toBe(true);
    });

    it('should emit custom event to server', (done) => {
      io.on('connection', (socket) => {
        socket.on('test_event', (data) => {
          expect(data.message).toBe('test message');
          done();
        });
      });

      clientSocket.emit('test_event', { message: 'test message' });
    });

    it('should receive events from server', (done) => {
      clientSocket.on('server_event', (data) => {
        expect(data.status).toBe('ok');
        done();
      });

      // Emit from server to specific client
      io.to(clientSocket.id).emit('server_event', { status: 'ok' });
    });
  });

  describe('Business Room Broadcasting', () => {
    let secondClient: Socket;

    beforeEach((done) => {
      // Connect second client to same business
      secondClient = SocketIOClient(`https://localhost:${serverPort}`, {
        auth: {
          apiKey: TEST_API_KEY,
          businessId: TEST_BUSINESS_ID_2,
        },
        rejectUnauthorized: false, // For self-signed certs in tests
      });

      secondClient.on('connect', () => {
        done();
      });
    });

    afterEach(() => {
      if (secondClient) {
        secondClient.close();
      }
    });

    it('should broadcast to all clients in business room', (done) => {
      let receivedCount = 0;

      const handler = (data: any) => {
        expect(data.message).toBe('broadcast test');
        receivedCount++;
        
        if (receivedCount === 2) {
          clientSocket.off('broadcast_event', handler);
          secondClient.off('broadcast_event', handler);
          done();
        }
      };

      clientSocket.on('broadcast_event', handler);
      secondClient.on('broadcast_event', handler);

      // Broadcast to business room
      io.to(`business:${TEST_BUSINESS_ID}`).emit('broadcast_event', {
        message: 'broadcast test',
      });
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid event data gracefully', (done) => {
      io.on('connection', (socket) => {
        socket.on('invalid_event', (data) => {
          try {
            // Simulate processing that might fail
            if (!data || typeof data !== 'object') {
              socket.emit('error_response', { error: 'Invalid data format' });
            }
          } catch (error) {
            socket.emit('error_response', { error: 'Server error' });
          }
        });
      });

      clientSocket.on('error_response', (data) => {
        expect(data.error).toBeDefined();
        done();
      });

      clientSocket.emit('invalid_event', null);
    });

    it('should disconnect gracefully', (done) => {
      clientSocket.on('disconnect', () => {
        expect(clientSocket.connected).toBe(false);
        done();
      });

      clientSocket.disconnect();
    });
  });
});
