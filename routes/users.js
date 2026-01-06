const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const azureStorage = require('../utils/azureStorage');
const Joi = require('joi');
const User = require('../models/User');
const { protect, optionalAuth, checkOwnership } = require('../middleware/auth');
const { redisClient } = require('../config/redis');

const router = express.Router();

// Configure multer for avatar uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit for avatars
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'), false);
    }
  }
});

// Validation schemas
const updateProfileSchema = Joi.object({
  firstName: Joi.string().max(50),
  lastName: Joi.string().max(50),
  bio: Joi.string().max(500).allow(''),
  location: Joi.string().max(100).allow(''),
  website: Joi.string().uri().max(200).allow(''),
  socialLinks: Joi.object({
    instagram: Joi.string().max(100).allow(''),
    twitter: Joi.string().max(100).allow('')
  }),
  preferences: Joi.object({
    publicProfile: Joi.boolean(),
    emailNotifications: Joi.boolean(),
    pushNotifications: Joi.boolean()
  })
});

// Helper function to upload avatar to Azure Storage
const uploadAvatarToAzure = async (buffer) => {
  try {
    const result = await azureStorage.uploadAvatar(buffer);
    return result;
  } catch (error) {
    throw error;
  }
};

// @route   GET /api/users
// @desc    Get all users with search and filtering
// @access  Public
router.get('/', optionalAuth, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      search = '',
      role,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;

    // Create cache key
    const cacheKey = `users_${JSON.stringify({ page, limit, search, role, sortBy, sortOrder })}`;
    
    // Check cache first
    let cachedData = await redisClient.get('users_list', cacheKey);
    if (cachedData) {
      return res.json({
        success: true,
        data: cachedData,
        cached: true
      });
    }

    let query = { isActive: true };
    
    // Add role filter
    if (role && ['Creator', 'Consumer'].includes(role)) {
      query.role = role;
    }

    // Search functionality
    if (search.trim()) {
      const searchRegex = new RegExp(search.trim(), 'i');
      query.$or = [
        { username: searchRegex },
        { firstName: searchRegex },
        { lastName: searchRegex },
        { bio: searchRegex }
      ];
    }

    const options = {
      page: parseInt(page),
      limit: Math.min(parseInt(limit), 50),
      sort: { [sortBy]: sortOrder === 'desc' ? -1 : 1 }
    };

    const users = await User.find(query)
      .select('-password -email') // Hide sensitive fields
      .sort(options.sort)
      .limit(options.limit)
      .skip((options.page - 1) * options.limit)
      .lean();

    const total = await User.countDocuments(query);

    const result = {
      users,
      pagination: {
        page: options.page,
        limit: options.limit,
        total,
        pages: Math.ceil(total / options.limit),
        hasMore: options.page < Math.ceil(total / options.limit)
      }
    };

    // Cache for 5 minutes
    await redisClient.set('users_list', cacheKey, result, 300);

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch users'
    });
  }
});

// @route   GET /api/users/:id
// @desc    Get user profile
// @access  Public
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const { id } = req.params;

    // Check cache first
    let user = await redisClient.getUser(id);
    
    if (!user) {
      user = await User.findById(id)
        .select('-password')
        .lean();

      if (!user) {
        return res.status(404).json({
          success: false,
          error: 'User not found'
        });
      }

      // Cache for 1 hour
      await redisClient.setUser(id, user, 3600);
    }

    // Check if profile is public or if user is viewing own profile
    const isOwner = req.user && req.user._id.toString() === id;
    const isPublic = user.preferences?.publicProfile !== false;

    if (!isPublic && !isOwner) {
      return res.status(403).json({
        success: false,
        error: 'This profile is private'
      });
    }

    // Remove email from response unless it's the owner
    if (!isOwner && user.email) {
      delete user.email;
    }

    res.json({
      success: true,
      data: { user }
    });
  } catch (error) {
    console.error('Get user profile error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch user profile'
    });
  }
});

// @route   PUT /api/users/:id
// @desc    Update user profile
// @access  Private (Owner only)
router.put('/:id', protect, checkOwnership(User, 'id', '_id'), async (req, res) => {
  try {
    // Validate input
    const { error, value } = updateProfileSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        error: error.details[0].message
      });
    }

    const updateData = { ...value };

    // Update user
    const user = await User.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    ).select('-password');

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    // Update cache
    await redisClient.setUser(req.params.id, user.toObject(), 3600);

    res.json({
      success: true,
      data: { user },
      message: 'Profile updated successfully'
    });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update profile'
    });
  }
});

// @route   POST /api/users/:id/avatar
// @desc    Upload user avatar
// @access  Private (Owner only)
router.post('/:id/avatar', protect, checkOwnership(User, 'id', '_id'), upload.single('avatar'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'Avatar file is required'
      });
    }

    // Process image
    const processedBuffer = await sharp(req.file.buffer)
      .resize(300, 300, { fit: 'cover', position: 'center' })
      .jpeg({ quality: 85 })
      .toBuffer();

    // Upload to Azure Storage
    const uploadResult = await uploadAvatarToAzure(processedBuffer);

    // Update user
    const user = await User.findByIdAndUpdate(
      req.params.id,
      {
        avatar: {
          url: uploadResult.url,
          blobName: uploadResult.blobName
        }
      },
      { new: true, runValidators: true }
    ).select('-password');

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    // Delete old avatar if exists
    if (req.resource.avatar?.blobName && req.resource.avatar.blobName !== uploadResult.blobName) {
      try {
        await azureStorage.deleteBlob(req.resource.avatar.blobName);
      } catch (deleteError) {
        console.error('Failed to delete old avatar:', deleteError);
      }
    }

    // Update cache
    await redisClient.setUser(req.params.id, user.toObject(), 3600);

    res.json({
      success: true,
      data: { 
        avatar: user.avatar
      },
      message: 'Avatar updated successfully'
    });
  } catch (error) {
    console.error('Upload avatar error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to upload avatar'
    });
  }
});

// @route   DELETE /api/users/:id/avatar
// @desc    Delete user avatar
// @access  Private (Owner only)
router.delete('/:id/avatar', protect, checkOwnership(User, 'id', '_id'), async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    // Delete from Azure Storage if exists
    if (user.avatar?.blobName) {
      try {
        await azureStorage.deleteBlob(user.avatar.blobName);
      } catch (deleteError) {
        console.error('Failed to delete avatar from Azure Storage:', deleteError);
      }
    }

    // Remove avatar from user
    user.avatar = {
      url: null,
      blobName: null
    };

    await user.save();

    // Update cache
    await redisClient.setUser(req.params.id, user.toObject(), 3600);

    res.json({
      success: true,
      message: 'Avatar deleted successfully'
    });
  } catch (error) {
    console.error('Delete avatar error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete avatar'
    });
  }
});

// @route   GET /api/users/:id/stats
// @desc    Get user statistics
// @access  Public
router.get('/:id/stats', optionalAuth, async (req, res) => {
  try {
    const { id } = req.params;

    // Check cache first
    const cacheKey = `stats_${id}`;
    let stats = await redisClient.get('user_stats', cacheKey);

    if (!stats) {
      const user = await User.findById(id).select('stats role isActive');
      if (!user || !user.isActive) {
        return res.status(404).json({
          success: false,
          error: 'User not found'
        });
      }

      // Get additional stats from Photo collection
      const Photo = require('../models/Photo');
      const totalViews = await Photo.aggregate([
        { $match: { creatorId: user._id } },
        { $group: { _id: null, totalViews: { $sum: '$stats.viewsCount' } } }
      ]);

      const totalLikes = await Photo.aggregate([
        { $match: { creatorId: user._id } },
        { $group: { _id: null, totalLikes: { $sum: '$stats.likesCount' } } }
      ]);

      stats = {
        ...user.stats,
        totalViews: totalViews[0]?.totalViews || 0,
        totalLikes: totalLikes[0]?.totalLikes || 0,
        role: user.role
      };

      // Cache for 10 minutes
      await redisClient.set('user_stats', cacheKey, stats, 600);
    }

    res.json({
      success: true,
      data: { stats }
    });
  } catch (error) {
    console.error('Get user stats error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch user statistics'
    });
  }
});

// @route   GET /api/users/:id/photos
// @desc    Get user's photos
// @access  Public (redirects to photos route for consistency)
router.get('/:id/photos', (req, res) => {
  // Redirect to the photos route for better organization
  const { page, limit, visibility } = req.query;
  const queryParams = new URLSearchParams({ page, limit, visibility }).toString();
  res.redirect(`/api/photos/user/${req.params.id}?${queryParams}`);
});

// @route   POST /api/users/:id/follow
// @desc    Follow/unfollow user
// @access  Private
router.post('/:id/follow', protect, async (req, res) => {
  try {
    const targetUserId = req.params.id;
    const currentUserId = req.user._id.toString();

    if (targetUserId === currentUserId) {
      return res.status(400).json({
        success: false,
        error: 'You cannot follow yourself'
      });
    }

    const targetUser = await User.findById(targetUserId);
    if (!targetUser || !targetUser.isActive) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    // For this demo, we'll use a simple follow system
    // In production, you might want a separate Follow collection
    
    // This is a placeholder implementation
    // You would typically have a Follow model for this functionality
    
    res.json({
      success: true,
      message: 'Follow functionality would be implemented with a separate Follow model',
      data: {
        isFollowing: false, // Placeholder
        followersCount: targetUser.stats.followersCount
      }
    });
  } catch (error) {
    console.error('Follow user error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to follow/unfollow user'
    });
  }
});

// @route   GET /api/users/search/:query
// @desc    Search users
// @access  Public
router.get('/search/:query', optionalAuth, async (req, res) => {
  try {
    const { query } = req.params;
    const { page = 1, limit = 20 } = req.query;

    if (!query || query.length < 2) {
      return res.status(400).json({
        success: false,
        error: 'Search query must be at least 2 characters long'
      });
    }

    // Check cache first
    const cacheKey = `${query}_${page}_${limit}`;
    let cachedResults = await redisClient.getSearchResults(`users_${cacheKey}`);
    
    if (cachedResults) {
      return res.json({
        success: true,
        data: cachedResults,
        cached: true
      });
    }

    const options = {
      page: parseInt(page),
      limit: Math.min(parseInt(limit), 50)
    };

    const users = await User.searchUsers(query, options);
    const total = users.length; // Approximated for performance

    const result = {
      users,
      pagination: {
        page: options.page,
        limit: options.limit,
        total,
        hasMore: users.length === options.limit
      },
      searchQuery: query
    };

    // Cache for 15 minutes
    await redisClient.setSearchResults(`users_${cacheKey}`, result, 900);

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Search users error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to search users'
    });
  }
});

// @route   DELETE /api/users/:id
// @desc    Deactivate user account
// @access  Private (Owner only)
router.delete('/:id', protect, checkOwnership(User, 'id', '_id'), async (req, res) => {
  try {
    // Instead of hard delete, we'll deactivate the account
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { 
        isActive: false,
        // Optionally anonymize data
        email: `deleted_${Date.now()}@deleted.com`,
        username: `deleted_${Date.now()}`
      },
      { new: true }
    ).select('-password');

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    // Clear cache
    await redisClient.invalidateUser(req.params.id);

    res.json({
      success: true,
      message: 'Account deactivated successfully'
    });
  } catch (error) {
    console.error('Deactivate account error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to deactivate account'
    });
  }
});

module.exports = router;
