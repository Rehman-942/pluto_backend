const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { redisClient } = require('../config/redis');

// JWT secret
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';
const JWT_EXPIRE = process.env.JWT_EXPIRE || '7d';
const JWT_REFRESH_EXPIRE = process.env.JWT_REFRESH_EXPIRE || '30d';

// Generate JWT tokens
const generateTokens = (userId) => {
  const accessToken = jwt.sign({ userId }, JWT_SECRET, { expiresIn: JWT_EXPIRE });
  const refreshToken = jwt.sign({ userId, type: 'refresh' }, JWT_SECRET, { expiresIn: JWT_REFRESH_EXPIRE });
  
  return { accessToken, refreshToken };
};

// Verify JWT token middleware
const protect = async (req, res, next) => {
  let token;

  // Get token from header
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return res.status(401).json({
      success: false,
      error: 'Access token is required'
    });
  }

  try {
    // Verify token
    const decoded = jwt.verify(token, JWT_SECRET);
    
    // Check if token is a refresh token (shouldn't be used for auth)
    if (decoded.type === 'refresh') {
      return res.status(401).json({
        success: false,
        error: 'Invalid token type'
      });
    }

    // Check cache first
    let user = await redisClient.getUser(decoded.userId);
    
    if (!user) {
      // If not in cache, get from database
      user = await User.findById(decoded.userId).select('-password');
      if (!user) {
        return res.status(401).json({
          success: false,
          error: 'User not found'
        });
      }
      
      // Cache user data
      await redisClient.setUser(decoded.userId, user, 3600); // Cache for 1 hour
    }

    // Check if user is active
    if (!user.isActive) {
      return res.status(401).json({
        success: false,
        error: 'User account is deactivated'
      });
    }

    req.user = user;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        error: 'Access token expired',
        code: 'TOKEN_EXPIRED'
      });
    } else if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        error: 'Invalid token'
      });
    } else {
      console.error('Auth middleware error:', error);
      return res.status(500).json({
        success: false,
        error: 'Authentication error'
      });
    }
  }
};

// Optional auth middleware (doesn't require token but adds user if present)
const optionalAuth = async (req, res, next) => {
  let token;

  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      
      if (decoded.type !== 'refresh') {
        let user = await redisClient.getUser(decoded.userId);
        
        if (!user) {
          user = await User.findById(decoded.userId).select('-password');
          if (user && user.isActive) {
            await redisClient.setUser(decoded.userId, user, 3600);
          }
        }
        
        if (user && user.isActive) {
          req.user = user;
        }
      }
    } catch (error) {
      // Silently fail for optional auth
      console.log('Optional auth failed:', error.message);
    }
  }

  next();
};

// Role-based authorization
const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required'
      });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        error: `Access denied. Required role: ${roles.join(' or ')}`
      });
    }

    next();
  };
};

// Check resource ownership
const checkOwnership = (resourceModel, resourceIdParam = 'id', ownerField = 'userId') => {
  return async (req, res, next) => {
    try {
      const resourceId = req.params[resourceIdParam];
      const resource = await resourceModel.findById(resourceId);

      if (!resource) {
        return res.status(404).json({
          success: false,
          error: 'Resource not found'
        });
      }

      // Admin can access everything
      if (req.user.role === 'Admin') {
        req.resource = resource;
        return next();
      }

      // Check ownership
      const ownerId = resource[ownerField];
      if (ownerId.toString() !== req.user._id.toString()) {
        return res.status(403).json({
          success: false,
          error: 'Access denied. You can only access your own resources.'
        });
      }

      req.resource = resource;
      next();
    } catch (error) {
      console.error('Ownership check error:', error);
      return res.status(500).json({
        success: false,
        error: 'Authorization error'
      });
    }
  };
};

// Rate limiting using Redis
const rateLimitByUser = (maxRequests = 100, windowMs = 15 * 60 * 1000) => {
  return async (req, res, next) => {
    try {
      const identifier = req.user ? req.user._id : req.ip;
      const { count, ttl } = await redisClient.incrementRateLimit(identifier, windowMs);

      // Set rate limit headers
      res.set({
        'X-RateLimit-Limit': maxRequests,
        'X-RateLimit-Remaining': Math.max(0, maxRequests - count),
        'X-RateLimit-Reset': new Date(Date.now() + ttl * 1000).toISOString()
      });

      if (count > maxRequests) {
        return res.status(429).json({
          success: false,
          error: 'Rate limit exceeded',
          retryAfter: ttl
        });
      }

      next();
    } catch (error) {
      console.error('Rate limiting error:', error);
      // Don't block request if rate limiting fails
      next();
    }
  };
};

// Refresh token endpoint
const refreshToken = async (req, res) => {
  const { refreshToken } = req.body;

  if (!refreshToken) {
    return res.status(400).json({
      success: false,
      error: 'Refresh token is required'
    });
  }

  try {
    const decoded = jwt.verify(refreshToken, JWT_SECRET);
    
    if (decoded.type !== 'refresh') {
      return res.status(400).json({
        success: false,
        error: 'Invalid refresh token'
      });
    }

    // Check if user exists and is active
    const user = await User.findById(decoded.userId).select('-password');
    if (!user || !user.isActive) {
      return res.status(401).json({
        success: false,
        error: 'User not found or inactive'
      });
    }

    // Generate new tokens
    const tokens = generateTokens(user._id);

    // Update cache
    await redisClient.setUser(user._id.toString(), user, 3600);

    res.json({
      success: true,
      data: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        user
      }
    });
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        error: 'Refresh token expired'
      });
    } else if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        error: 'Invalid refresh token'
      });
    } else {
      console.error('Refresh token error:', error);
      return res.status(500).json({
        success: false,
        error: 'Token refresh failed'
      });
    }
  }
};

// Logout (blacklist token)
const logout = async (req, res) => {
  try {
    // In a production system, you might want to blacklist the token
    // For now, we'll just clear the user cache
    await redisClient.invalidateUser(req.user._id.toString());

    res.json({
      success: true,
      message: 'Logged out successfully'
    });
  } catch (error) {
    console.error('Logout error:', error);
    return res.status(500).json({
      success: false,
      error: 'Logout failed'
    });
  }
};

// Alias for backward compatibility
const requireRole = authorize;
const authenticateToken = protect;

module.exports = {
  protect,
  authenticateToken,
  optionalAuth,
  authorize,
  requireRole,
  checkOwnership,
  rateLimitByUser,
  refreshToken,
  logout,
  generateTokens
};
