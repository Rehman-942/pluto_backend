const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const azureStorage = require('../utils/azureStorage');
const Joi = require('joi');
const User = require('../models/User');
const { protect, optionalAuth, checkOwnership } = require('../middleware/auth');

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

    const user = await User.findById(id)
      .select('-password')
      .lean();

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
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
// @desc    Get user statistics (calculated from actual data)
// @access  Public
router.get('/:id/stats', optionalAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const user = await User.findById(id).select('-password').lean();
    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    // Get user's videos to calculate stats
    const Video = require('../models/Video');
    const Comment = require('../models/Comment');
    
    // Find videos for this user (including null creatorId videos if no videos found)
    let videos = await Video.find({ creatorId: id }).lean();
    
    // If no videos found, check if there are videos with null creatorId (from old uploads)
    if (videos.length === 0) {
      const nullVideos = await Video.find({ creatorId: null }).lean();
      if (nullVideos.length > 0) {
        // Update null creatorId videos to current user
        await Video.updateMany({ creatorId: null }, { $set: { creatorId: id } });
        videos = await Video.find({ creatorId: id }).lean();
      }
    }

    // Calculate stats from actual arrays
    const totalViewsFromArray = videos.reduce((sum, video) => sum + (video.views?.length || 0), 0);
    const totalLikesFromArray = videos.reduce((sum, video) => sum + (video.likes?.length || 0), 0);

    // Get actual comment counts
    const videoIds = videos.map(v => v._id);
    const commentCounts = await Comment.aggregate([
      { $match: { videoId: { $in: videoIds } } },
      { $group: { _id: '$videoId', count: { $sum: 1 } } }
    ]);
    const actualTotalComments = commentCounts.reduce((sum, item) => sum + item.count, 0);

    console.log('=== STATS CALCULATION FROM ARRAYS ===');
    console.log('User ID:', id);
    console.log('Videos found:', videos.length);
    console.log('Total views (from views array):', totalViewsFromArray);
    console.log('Total likes (from likes array):', totalLikesFromArray);
    console.log('Total comments (from Comment collection):', actualTotalComments);

    // Calculate aggregated stats
    const stats = {
      videosCount: videos.length,
      totalViews: totalViewsFromArray,
      totalLikes: totalLikesFromArray,
      totalComments: actualTotalComments,
      totalWatchTime: videos.reduce((sum, video) => sum + (video.stats?.watchTime?.total || 0), 0),
      publicVideos: videos.filter(v => v.visibility === 'public').length,
      privateVideos: videos.filter(v => v.visibility === 'private').length,
      unlistedVideos: videos.filter(v => v.visibility === 'unlisted').length,
      averageViews: videos.length > 0 ? Math.round(totalViewsFromArray / videos.length) : 0,
      averageLikes: videos.length > 0 ? Math.round(totalLikesFromArray / videos.length) : 0,
      followersCount: user.stats?.followersCount || 0,
      followingCount: user.stats?.followingCount || 0
    };

    // Disable caching
    res.set({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });

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
