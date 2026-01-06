const redis = require('redis');

class RedisClient {
  constructor() {
    this.client = null;
    this.isConnected = false;
  }

  async connect() {
    try {
      this.client = redis.createClient({
        url: process.env.REDIS_URL || 'redis://localhost:6379',
        retry_strategy: (options) => {
          if (options.error && options.error.code === 'ECONNREFUSED') {
            console.error('Redis server connection refused');
            return new Error('Redis server connection refused');
          }
          if (options.total_retry_time > 1000 * 60 * 60) {
            console.error('Redis retry time exhausted');
            return new Error('Retry time exhausted');
          }
          if (options.attempt > 10) {
            console.error('Too many Redis connection attempts');
            return undefined;
          }
          return Math.min(options.attempt * 100, 3000);
        }
      });

      this.client.on('connect', () => {
        console.log('🔗 Redis connecting...');
      });

      this.client.on('ready', () => {
        console.log('✅ Redis connected and ready');
        this.isConnected = true;
      });

      this.client.on('error', (err) => {
        console.error('❌ Redis error:', err);
        this.isConnected = false;
      });

      this.client.on('end', () => {
        console.log('🔌 Redis connection ended');
        this.isConnected = false;
      });

      await this.client.connect();
    } catch (error) {
      console.error('❌ Redis connection failed:', error);
      this.isConnected = false;
    }
  }

  async disconnect() {
    if (this.client) {
      await this.client.quit();
      this.isConnected = false;
    }
  }

  // Cache key generators
  generateKey(namespace, key) {
    return `pluto:${namespace}:${key}`;
  }

  // User cache methods
  async setUser(userId, userData, ttl = 3600) {
    if (!this.isConnected) return false;
    try {
      const key = this.generateKey('user', userId);
      await this.client.setEx(key, ttl, JSON.stringify(userData));
      return true;
    } catch (error) {
      console.error('Redis setUser error:', error);
      return false;
    }
  }

  async getUser(userId) {
    if (!this.isConnected) return null;
    try {
      const key = this.generateKey('user', userId);
      const data = await this.client.get(key);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      console.error('Redis getUser error:', error);
      return null;
    }
  }

  // Photo cache methods
  async setPhoto(photoId, photoData, ttl = 1800) {
    if (!this.isConnected) return false;
    try {
      const key = this.generateKey('photo', photoId);
      await this.client.setEx(key, ttl, JSON.stringify(photoData));
      return true;
    } catch (error) {
      console.error('Redis setPhoto error:', error);
      return false;
    }
  }

  async getPhoto(photoId) {
    if (!this.isConnected) return null;
    try {
      const key = this.generateKey('photo', photoId);
      const data = await this.client.get(key);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      console.error('Redis getPhoto error:', error);
      return null;
    }
  }

  // Photos list cache methods
  async setPhotosList(cacheKey, photosData, ttl = 600) {
    if (!this.isConnected) return false;
    try {
      const key = this.generateKey('photos', cacheKey);
      await this.client.setEx(key, ttl, JSON.stringify(photosData));
      return true;
    } catch (error) {
      console.error('Redis setPhotosList error:', error);
      return false;
    }
  }

  async getPhotosList(cacheKey) {
    if (!this.isConnected) return null;
    try {
      const key = this.generateKey('photos', cacheKey);
      const data = await this.client.get(key);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      console.error('Redis getPhotosList error:', error);
      return null;
    }
  }

  // Comments cache methods
  async setComments(photoId, commentsData, ttl = 600) {
    if (!this.isConnected) return false;
    try {
      const key = this.generateKey('comments', photoId);
      await this.client.setEx(key, ttl, JSON.stringify(commentsData));
      return true;
    } catch (error) {
      console.error('Redis setComments error:', error);
      return false;
    }
  }

  async getComments(photoId) {
    if (!this.isConnected) return null;
    try {
      const key = this.generateKey('comments', photoId);
      const data = await this.client.get(key);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      console.error('Redis getComments error:', error);
      return null;
    }
  }

  // Session methods
  async setSession(sessionId, sessionData, ttl = 86400) {
    if (!this.isConnected) return false;
    try {
      const key = this.generateKey('session', sessionId);
      await this.client.setEx(key, ttl, JSON.stringify(sessionData));
      return true;
    } catch (error) {
      console.error('Redis setSession error:', error);
      return false;
    }
  }

  async getSession(sessionId) {
    if (!this.isConnected) return null;
    try {
      const key = this.generateKey('session', sessionId);
      const data = await this.client.get(key);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      console.error('Redis getSession error:', error);
      return null;
    }
  }

  async deleteSession(sessionId) {
    if (!this.isConnected) return false;
    try {
      const key = this.generateKey('session', sessionId);
      await this.client.del(key);
      return true;
    } catch (error) {
      console.error('Redis deleteSession error:', error);
      return false;
    }
  }

  // Rate limiting methods
  async incrementRateLimit(identifier, windowMs = 900000) {
    if (!this.isConnected) return { count: 0, ttl: 0 };
    try {
      const key = this.generateKey('rate_limit', identifier);
      const multi = this.client.multi();
      multi.incr(key);
      multi.expire(key, Math.ceil(windowMs / 1000));
      multi.ttl(key);
      
      const results = await multi.exec();
      const count = results[0];
      const ttl = results[2];
      
      return { count, ttl };
    } catch (error) {
      console.error('Redis incrementRateLimit error:', error);
      return { count: 0, ttl: 0 };
    }
  }

  // Search cache methods
  async setSearchResults(query, results, ttl = 900) {
    if (!this.isConnected) return false;
    try {
      const queryHash = require('crypto').createHash('md5').update(query).digest('hex');
      const key = this.generateKey('search', queryHash);
      await this.client.setEx(key, ttl, JSON.stringify(results));
      return true;
    } catch (error) {
      console.error('Redis setSearchResults error:', error);
      return false;
    }
  }

  async getSearchResults(query) {
    if (!this.isConnected) return null;
    try {
      const queryHash = require('crypto').createHash('md5').update(query).digest('hex');
      const key = this.generateKey('search', queryHash);
      const data = await this.client.get(key);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      console.error('Redis getSearchResults error:', error);
      return null;
    }
  }

  // Cache invalidation methods
  async invalidateUser(userId) {
    if (!this.isConnected) return false;
    try {
      const key = this.generateKey('user', userId);
      await this.client.del(key);
      return true;
    } catch (error) {
      console.error('Redis invalidateUser error:', error);
      return false;
    }
  }

  async invalidatePhoto(photoId) {
    if (!this.isConnected) return false;
    try {
      const photoKey = this.generateKey('photo', photoId);
      const commentsKey = this.generateKey('comments', photoId);
      await Promise.all([
        this.client.del(photoKey),
        this.client.del(commentsKey)
      ]);
      return true;
    } catch (error) {
      console.error('Redis invalidatePhoto error:', error);
      return false;
    }
  }

  async invalidatePhotosList(pattern = '*') {
    if (!this.isConnected) return false;
    try {
      const keys = await this.client.keys(this.generateKey('photos', pattern));
      if (keys.length > 0) {
        await this.client.del(keys);
      }
      return true;
    } catch (error) {
      console.error('Redis invalidatePhotosList error:', error);
      return false;
    }
  }

  // Generic cache methods
  async set(namespace, key, value, ttl = 3600) {
    if (!this.isConnected) return false;
    try {
      const cacheKey = this.generateKey(namespace, key);
      await this.client.setEx(cacheKey, ttl, JSON.stringify(value));
      return true;
    } catch (error) {
      console.error('Redis set error:', error);
      return false;
    }
  }

  async get(namespace, key) {
    if (!this.isConnected) return null;
    try {
      const cacheKey = this.generateKey(namespace, key);
      const data = await this.client.get(cacheKey);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      console.error('Redis get error:', error);
      return null;
    }
  }

  async del(namespace, key) {
    if (!this.isConnected) return false;
    try {
      const cacheKey = this.generateKey(namespace, key);
      await this.client.del(cacheKey);
      return true;
    } catch (error) {
      console.error('Redis del error:', error);
      return false;
    }
  }

  // Health check
  async ping() {
    if (!this.isConnected) return false;
    try {
      const result = await this.client.ping();
      return result === 'PONG';
    } catch (error) {
      console.error('Redis ping error:', error);
      return false;
    }
  }
}

// Create singleton instance
const redisClient = new RedisClient();

// Connect to Redis
const connectRedis = async () => {
  await redisClient.connect();
};

module.exports = {
  redisClient,
  connectRedis
};
