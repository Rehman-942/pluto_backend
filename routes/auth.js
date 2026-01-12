const express = require('express');
const bcrypt = require('bcryptjs');
const Joi = require('joi');
const User = require('../models/User');
const { generateTokens, refreshToken, logout, protect } = require('../middleware/auth');

const router = express.Router();

// Validation schemas
const registerSchema = Joi.object({
  username: Joi.string().alphanum().min(3).max(30).required(),
  email: Joi.string().email().required(),
  password: Joi.string().min(6).required(),
  firstName: Joi.string().max(50).required(),
  lastName: Joi.string().max(50).required(),
  role: Joi.string().valid('Consumer', 'Creator').default('Consumer')
});

const loginSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().required()
});

// @route   POST /api/auth/register
// @desc    Register a new user
// @access  Public
router.post('/register', async (req, res) => {
  try {
    // Validate input
    const { error, value } = registerSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        error: error.details[0].message
      });
    }

    const { username, email, password, firstName, lastName, role } = value;

    // Check if user already exists
    const existingUser = await User.findByEmailOrUsername(email);
    if (existingUser) {
      return res.status(400).json({
        success: false,
        error: existingUser.email === email.toLowerCase() 
          ? 'Email already registered' 
          : 'Username already taken'
      });
    }

    console.log('Creating user with data:', { username, email, firstName, lastName, role });

    // Create user
    const user = new User({
      username,
      email: email.toLowerCase(),
      password,
      firstName,
      lastName,
      role
    });

    console.log('User created, saving...');
    await user.save();
    console.log('User saved successfully with role:', user.role);

    // Generate tokens
    const tokens = generateTokens(user._id);

    // Remove password from response
    const userResponse = user.toJSON();
    delete userResponse.password;

    res.status(201).json({
      success: true,
      data: {
        user: userResponse,
        tokens
      },
      message: 'User registered successfully'
    });
  } catch (error) {
    console.error('Registration error:', error);
    
    if (error.code === 11000) {
      // Duplicate key error
      console.log('Duplicate key error details:', error);
      let field = 'field';
      let errorMessage = 'Already exists';
      
      if (error.keyPattern && Object.keys(error.keyPattern).length > 0) {
        field = Object.keys(error.keyPattern)[0];
        errorMessage = `${field} already exists`;
      } else if (error.message) {
        // Parse error message to determine field
        if (error.message.includes('email')) {
          errorMessage = 'Email already registered';
        } else if (error.message.includes('username')) {
          errorMessage = 'Username already taken';
        } else {
          errorMessage = 'User already exists';
        }
      }
      
      return res.status(400).json({
        success: false,
        error: errorMessage
      });
    }

    res.status(500).json({
      success: false,
      error: 'Registration failed'
    });
  }
});

// @route   POST /api/auth/login
// @desc    Login user
// @access  Public
router.post('/login', async (req, res) => {
  console.log('=== LOGIN ATTEMPT ===');
  console.log('Request body:', req.body);
  console.log('IP:', req.ip);
  console.log('User-Agent:', req.get('User-Agent'));
  
  try {
    // Validate input
    const { error, value } = loginSchema.validate(req.body);
    if (error) {
      console.log('❌ Validation error:', error.details[0].message);
      return res.status(400).json({
        success: false,
        error: error.details[0].message
      });
    }

    const { email, password } = value;
    console.log('✅ Input validated for email:', email);

    // Find user and include password for comparison
    const user = await User.findOne({ email: email.toLowerCase() }).select('+password');
    if (!user) {
      console.log('❌ User not found for email:', email);
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials'
      });
    }

    console.log('✅ User found:', user.email, 'ID:', user._id);

    // Check password
    const isPasswordCorrect = await user.comparePassword(password);
    if (!isPasswordCorrect) {
      console.log('❌ Invalid password for user:', user.email);
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials'
      });
    }

    console.log('✅ Password verified for user:', user.email);

    // Check if user is active
    if (!user.isActive) {
      console.log('❌ User account deactivated:', user.email);
      return res.status(401).json({
        success: false,
        error: 'Account is deactivated'
      });
    }

    console.log('✅ User account is active');

    // Update last login
    await user.updateLastLogin();
    console.log('✅ Last login updated');

    // Generate tokens
    const tokens = generateTokens(user._id);
    console.log('✅ Tokens generated');

    // Remove password from response
    const userResponse = user.toJSON();
    delete userResponse.password;

    console.log('✅ Login successful for user:', user.email);
    res.json({
      success: true,
      data: {
        user: userResponse,
        tokens
      },
      message: 'Login successful'
    });
  } catch (error) {
    console.error('❌ Login error:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({
      success: false,
      error: 'Login failed'
    });
  }
});

// @route   POST /api/auth/refresh
// @desc    Refresh access token
// @access  Public
router.post('/refresh', refreshToken);

// @route   POST /api/auth/logout
// @desc    Logout user
// @access  Private
router.post('/logout', protect, logout);

// @route   GET /api/auth/me
// @desc    Get current user
// @access  Private
router.get('/me', protect, async (req, res) => {
  try {
    // User is already available from protect middleware
    res.json({
      success: true,
      data: {
        user: req.user
      }
    });
  } catch (error) {
    console.error('Get current user error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get user data'
    });
  }
});

// @route   PUT /api/auth/change-password
// @desc    Change user password
// @access  Private
router.put('/change-password', protect, async (req, res) => {
  try {
    const changePasswordSchema = Joi.object({
      currentPassword: Joi.string().required(),
      newPassword: Joi.string().min(6).required()
    });

    const { error, value } = changePasswordSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        error: error.details[0].message
      });
    }

    const { currentPassword, newPassword } = value;

    // Get user with password
    const user = await User.findById(req.user._id).select('+password');
    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    // Verify current password
    const isCurrentPasswordCorrect = await user.comparePassword(currentPassword);
    if (!isCurrentPasswordCorrect) {
      return res.status(400).json({
        success: false,
        error: 'Current password is incorrect'
      });
    }

    // Update password
    user.password = newPassword;
    await user.save();

    res.json({
      success: true,
      message: 'Password changed successfully'
    });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to change password'
    });
  }
});

// @route   POST /api/auth/forgot-password
// @desc    Request password reset (placeholder)
// @access  Public
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        error: 'Email is required'
      });
    }

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      // Don't reveal if user exists
      return res.json({
        success: true,
        message: 'If an account with this email exists, a password reset link has been sent'
      });
    }

    // In a real application, you would generate a reset token and send email
    // For this demo, we'll just log it
    console.log(`Password reset requested for user: ${user.email}`);

    res.json({
      success: true,
      message: 'If an account with this email exists, a password reset link has been sent'
    });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to process password reset request'
    });
  }
});

// @route   GET /api/auth/stats
// @desc    Get authentication stats (for admin)
// @access  Private (Admin only)
router.get('/stats', protect, async (req, res) => {
  try {
    if (req.user.role !== 'Admin') {
      return res.status(403).json({
        success: false,
        error: 'Admin access required'
      });
    }

    // Get stats from database
    const totalUsers = await User.countDocuments();
    const activeUsers = await User.countDocuments({ isActive: true });
    const verifiedUsers = await User.countDocuments({ isVerified: true });
    const creatorUsers = await User.countDocuments({ role: 'Creator' });
    const consumerUsers = await User.countDocuments({ role: 'Consumer' });
    
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const recentLogins = await User.countDocuments({ 
      lastLoginAt: { $gte: thirtyDaysAgo } 
    });

    const stats = {
      totalUsers,
      activeUsers,
      verifiedUsers,
      creatorUsers,
      consumerUsers,
      recentLogins,
      generatedAt: new Date().toISOString()
    };

    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    console.error('Auth stats error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get authentication stats'
    });
  }
});

module.exports = router;
